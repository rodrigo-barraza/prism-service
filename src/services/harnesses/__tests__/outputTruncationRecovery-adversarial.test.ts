import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import {
  isOutputTruncated,
  calculateEscalatedMaxTokens,
  isAtOutputCeiling,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "#src/services/harnesses/lifecycle/OutputTruncationRecovery";

import {
  TOKEN_ESCALATION_MULTIPLIER,
} from "#src/constants/TokenBudgetDefaults";

import type { PassState } from "#src/services/harnesses/types";

// ═══════════════════════════════════════════════════════════════
// ADVERSARIAL TESTS — OutputTruncationRecovery
//
// Hand-crafted edge cases targeting escalation math overflow,
// ceiling clamping boundary conditions, truncation detection
// edge cases, and token limit exploitation.
// ═══════════════════════════════════════════════════════════════

describe("OutputTruncationRecovery adversarial — isOutputTruncated", () => {
  it("stopReason 'length' should be detected as truncated", () => {
    expect(isOutputTruncated({ stopReason: "length" } as PassState)).toBe(true);
  });

  it("stopReason 'max_tokens' should be detected as truncated", () => {
    expect(isOutputTruncated({ stopReason: "max_tokens" } as PassState)).toBe(true);
  });

  it("stopReason 'end_turn' should NOT be truncated", () => {
    expect(isOutputTruncated({ stopReason: "end_turn" } as PassState)).toBe(false);
  });

  it("stopReason 'stop' should NOT be truncated", () => {
    expect(isOutputTruncated({ stopReason: "stop" } as PassState)).toBe(false);
  });

  it("undefined stopReason should NOT be truncated", () => {
    expect(isOutputTruncated({} as PassState)).toBe(false);
  });

  it("null stopReason should NOT be truncated", () => {
    expect(isOutputTruncated({ stopReason: null } as unknown as PassState)).toBe(false);
  });

  it("case-sensitive: 'LENGTH' (uppercase) should NOT be truncated", () => {
    expect(isOutputTruncated({ stopReason: "LENGTH" } as PassState)).toBe(false);
  });

  it("case-sensitive: 'Max_Tokens' (mixed case) should NOT be truncated", () => {
    expect(isOutputTruncated({ stopReason: "Max_Tokens" } as PassState)).toBe(false);
  });

  it("stopReason with trailing whitespace should NOT be truncated", () => {
    expect(isOutputTruncated({ stopReason: "length " } as PassState)).toBe(false);
  });
});

describe("OutputTruncationRecovery adversarial — isAtOutputCeiling", () => {
  it("currentMaxTokens at ceiling should return true", () => {
    expect(isAtOutputCeiling(16384, 16384)).toBe(true);
  });

  it("currentMaxTokens above ceiling should return true", () => {
    expect(isAtOutputCeiling(20000, 16384)).toBe(true);
  });

  it("currentMaxTokens below ceiling should return false", () => {
    expect(isAtOutputCeiling(8192, 16384)).toBe(false);
  });

  it("undefined ceiling should always return false (unknown model limit)", () => {
    expect(isAtOutputCeiling(999_999, undefined)).toBe(false);
  });

  it("zero ceiling should return false (falsy check)", () => {
    expect(isAtOutputCeiling(100, 0)).toBe(false);
  });

  it("zero current with positive ceiling should return false", () => {
    expect(isAtOutputCeiling(0, 16384)).toBe(false);
  });
});

describe("OutputTruncationRecovery adversarial — calculateEscalatedMaxTokens", () => {
  it("recovery attempt 0 should return the original value (multiplier^0 = 1)", () => {
    const result = calculateEscalatedMaxTokens(16384, 0);
    expect(result).toBe(16384);
  });

  it("recovery attempt 1 should multiply by TOKEN_ESCALATION_MULTIPLIER once", () => {
    const result = calculateEscalatedMaxTokens(16384, 1);
    const expected = Math.ceil(16384 * TOKEN_ESCALATION_MULTIPLIER);
    expect(result).toBe(expected);
  });

  it("recovery attempt 2 should square the multiplier", () => {
    const result = calculateEscalatedMaxTokens(16384, 2);
    const expected = Math.ceil(16384 * Math.pow(TOKEN_ESCALATION_MULTIPLIER, 2));
    expect(result).toBe(expected);
  });

  it("ceiling should clamp escalated value when it exceeds the model max", () => {
    const ceiling = 20000;
    const result = calculateEscalatedMaxTokens(16384, 5, ceiling);
    expect(result).toBe(ceiling);
  });

  it("ceiling should NOT clamp when escalated value is below ceiling", () => {
    const ceiling = 100_000;
    const result = calculateEscalatedMaxTokens(16384, 1, ceiling);
    const expected = Math.ceil(16384 * TOKEN_ESCALATION_MULTIPLIER);
    expect(result).toBe(expected);
    expect(result).toBeLessThan(ceiling);
  });

  it("zero ceiling should NOT clamp (falsy check)", () => {
    const result = calculateEscalatedMaxTokens(16384, 1, 0);
    // 0 is falsy, so ceiling is treated as absent
    const expected = Math.ceil(16384 * TOKEN_ESCALATION_MULTIPLIER);
    expect(result).toBe(expected);
  });

  it("zero base maxTokens should produce 0 regardless of attempts", () => {
    expect(calculateEscalatedMaxTokens(0, 1)).toBe(0);
    expect(calculateEscalatedMaxTokens(0, 5)).toBe(0);
  });

  it("negative base maxTokens should still apply escalation (Math.ceil prevents negative ceil issues)", () => {
    const result = calculateEscalatedMaxTokens(-1000, 1);
    // -1000 * 1.5 = -1500, Math.ceil(-1500) = -1500
    expect(Number.isFinite(result)).toBe(true);
  });

  it("extremely large base with high attempt should not overflow to Infinity", () => {
    // JavaScript's Number.MAX_SAFE_INTEGER is ~9e15
    const result = calculateEscalatedMaxTokens(1_000_000_000, 10);
    // 1e9 * 1.5^10 = ~57.6e9, well within Number range
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it("very high attempt (100) should still produce a finite number", () => {
    const result = calculateEscalatedMaxTokens(16384, 100);
    // 1.5^100 ≈ 4e17, * 16384 ≈ 6.5e21 — still finite in JS
    expect(Number.isFinite(result)).toBe(true);
  });

  it("attempt count just below overflow threshold should still be finite", () => {
    // 1.5^700 ≈ 2.4e123, * 16384 ≈ 3.9e127 — still within 1.8e308
    const result = calculateEscalatedMaxTokens(16384, 700);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("attempt count that would cause overflow returns Infinity (documents behavior)", () => {
    // 1.5^2000 ≈ Infinity
    const result = calculateEscalatedMaxTokens(16384, 2000);
    // This documents that extremely high attempts produce Infinity
    // In practice MAX_OUTPUT_TRUNCATION_RECOVERIES is 3, so this is unreachable
    expect(result).toBe(Infinity);
  });

  it("ceiling exactly equal to escalated value should return ceiling", () => {
    const base = 16384;
    const escalated = Math.ceil(base * TOKEN_ESCALATION_MULTIPLIER);
    const result = calculateEscalatedMaxTokens(base, 1, escalated);
    expect(result).toBe(escalated);
  });

  it("ceiling of 1 should clamp any non-zero escalation to 1", () => {
    const result = calculateEscalatedMaxTokens(16384, 1, 1);
    expect(result).toBe(1);
  });
});

describe("OutputTruncationRecovery adversarial — escalation progression", () => {
  it("sequential recovery attempts should produce monotonically increasing values (without ceiling)", () => {
    let previousValue = 0;
    for (let attempt = 0; attempt <= MAX_OUTPUT_TRUNCATION_RECOVERIES; attempt++) {
      const value = calculateEscalatedMaxTokens(16384, attempt);
      expect(value).toBeGreaterThan(previousValue);
      previousValue = value;
    }
  });

  it("sequential recovery attempts with ceiling should eventually plateau", () => {
    const ceiling = 20000;
    const values = [];
    for (let attempt = 0; attempt <= 10; attempt++) {
      values.push(calculateEscalatedMaxTokens(16384, attempt, ceiling));
    }

    // Eventually all values should hit the ceiling
    const ceilingValues = values.filter((value) => value === ceiling);
    expect(ceilingValues.length).toBeGreaterThan(0);

    // Once ceiling is hit, all subsequent values should remain at ceiling
    const firstCeilingIndex = values.indexOf(ceiling);
    for (let index = firstCeilingIndex; index < values.length; index++) {
      expect(values[index]).toBe(ceiling);
    }
  });

  it("escalation with ceiling below base should return ceiling on attempt 0", () => {
    // Base is 16384 but ceiling is 1000 — already above ceiling
    const result = calculateEscalatedMaxTokens(16384, 0, 1000);
    // 16384 * 1.5^0 = 16384, which is > 1000, so clamped to 1000
    expect(result).toBe(1000);
  });
});

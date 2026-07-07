import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";

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
} from "#src/services/harnesses/lifecycle/OutputTruncationRecovery";

import {
  TOKEN_ESCALATION_MULTIPLIER,
} from "#src/constants/TokenBudgetDefaults";

import type { PassState } from "#src/services/harnesses/types";

// ═══════════════════════════════════════════════════════════════
// FUZZ / PROPERTY-BASED TESTS — OutputTruncationRecovery
//
// Verifies mathematical invariants of the escalation and clamping
// system hold across thousands of randomized input combinations.
// ═══════════════════════════════════════════════════════════════

// ── Custom Arbitraries ──────────────────────────────────────────

const arbitraryMaxTokens = fc.oneof(
  fc.integer({ min: 0, max: 100 }),
  fc.integer({ min: 1_000, max: 200_000 }),
  fc.integer({ min: 200_000, max: 1_000_000 }),
);

const arbitraryRecoveryAttempt = fc.integer({ min: 0, max: 10 });

const arbitraryCeiling = fc.option(
  fc.integer({ min: 1, max: 500_000 }),
  { nil: undefined },
);

const arbitraryStopReason = fc.oneof(
  fc.constant("length"),
  fc.constant("max_tokens"),
  fc.constant("end_turn"),
  fc.constant("stop"),
  fc.constant("tool_calls"),
  fc.constant("content_filter"),
  fc.constant("STOP"),
  fc.string({ minLength: 0, maxLength: 20 }),
  fc.constant(undefined),
  fc.constant(null),
);

// ═══════════════════════════════════════════════════════════════
// isOutputTruncated — Binary Classification Invariants
// ═══════════════════════════════════════════════════════════════

describe("OutputTruncationRecovery fuzz — isOutputTruncated invariants", () => {
  it("only 'length' and 'max_tokens' produce true (strict classification)", () => {
    fc.assert(
      fc.property(arbitraryStopReason, (stopReason) => {
        const pass = { stopReason } as unknown as PassState;
        const result = isOutputTruncated(pass);

        if (stopReason === "length" || stopReason === "max_tokens") {
          expect(result).toBe(true);
        } else {
          expect(result).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("result is always a boolean", () => {
    fc.assert(
      fc.property(arbitraryStopReason, (stopReason) => {
        const result = isOutputTruncated({ stopReason } as unknown as PassState);
        expect(typeof result).toBe("boolean");
      }),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// isAtOutputCeiling — Ceiling Comparison Invariants
// ═══════════════════════════════════════════════════════════════

describe("OutputTruncationRecovery fuzz — isAtOutputCeiling invariants", () => {
  it("result is always false when ceiling is undefined or 0 (falsy)", () => {
    fc.assert(
      fc.property(
        arbitraryMaxTokens,
        fc.constantFrom(undefined, 0),
        (currentMaxTokens, ceiling) => {
          expect(isAtOutputCeiling(currentMaxTokens, ceiling)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("result is true iff currentMaxTokens >= ceiling (when ceiling is truthy)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        (currentMaxTokens, ceiling) => {
          const result = isAtOutputCeiling(currentMaxTokens, ceiling);
          expect(result).toBe(currentMaxTokens >= ceiling);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// calculateEscalatedMaxTokens — Escalation Math Invariants
// ═══════════════════════════════════════════════════════════════

describe("OutputTruncationRecovery fuzz — calculateEscalatedMaxTokens invariants", () => {
  it("result is always >= base when base >= 0 and attempt >= 0 (monotonic escalation)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        arbitraryRecoveryAttempt,
        (base, attempt) => {
          const result = calculateEscalatedMaxTokens(base, attempt);
          expect(result).toBeGreaterThanOrEqual(base);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("result is always <= ceiling when ceiling is provided and truthy", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        arbitraryRecoveryAttempt,
        fc.integer({ min: 1, max: 500_000 }),
        (base, attempt, ceiling) => {
          const result = calculateEscalatedMaxTokens(base, attempt, ceiling);
          expect(result).toBeLessThanOrEqual(ceiling);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("result without ceiling always equals Math.ceil(base * multiplier^attempt)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 5 }),
        (base, attempt) => {
          const result = calculateEscalatedMaxTokens(base, attempt);
          const expected = Math.ceil(
            base * Math.pow(TOKEN_ESCALATION_MULTIPLIER, attempt),
          );
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("result is always a finite integer (Math.ceil guarantee)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 5 }),
        arbitraryCeiling,
        (base, attempt, ceiling) => {
          const result = calculateEscalatedMaxTokens(base, attempt, ceiling);
          expect(Number.isFinite(result)).toBe(true);
          expect(Number.isInteger(result)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("attempt 0 always returns the base value (multiplier^0 = 1)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (base) => {
          const result = calculateEscalatedMaxTokens(base, 0);
          expect(result).toBe(base);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("higher attempt always produces >= lower attempt (monotonic in attempt)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (base, attemptA, attemptB) => {
          const lower = Math.min(attemptA, attemptB);
          const higher = Math.max(attemptA, attemptB);

          const resultLow = calculateEscalatedMaxTokens(base, lower);
          const resultHigh = calculateEscalatedMaxTokens(base, higher);

          expect(resultHigh).toBeGreaterThanOrEqual(resultLow);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("zero base always produces 0 regardless of attempt and ceiling", () => {
    fc.assert(
      fc.property(
        arbitraryRecoveryAttempt,
        arbitraryCeiling,
        (attempt, ceiling) => {
          const result = calculateEscalatedMaxTokens(0, attempt, ceiling);
          expect(result).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Ceiling Interaction Properties
// ═══════════════════════════════════════════════════════════════

describe("OutputTruncationRecovery fuzz — ceiling interaction", () => {
  it("without ceiling, result is always >= result with any ceiling (ceiling only reduces)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 1, max: 500_000 }),
        (base, attempt, ceiling) => {
          const uncapped = calculateEscalatedMaxTokens(base, attempt);
          const capped = calculateEscalatedMaxTokens(base, attempt, ceiling);
          expect(uncapped).toBeGreaterThanOrEqual(capped);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("ceiling above uncapped result has no effect", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000 }),
        fc.integer({ min: 0, max: 3 }),
        (base, attempt) => {
          const uncapped = calculateEscalatedMaxTokens(base, attempt);
          const highCeiling = uncapped + 100_000;
          const capped = calculateEscalatedMaxTokens(base, attempt, highCeiling);
          expect(capped).toBe(uncapped);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("ceiling of 0 (falsy) behaves identically to undefined ceiling", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 5 }),
        (base, attempt) => {
          const withZero = calculateEscalatedMaxTokens(base, attempt, 0);
          const withUndefined = calculateEscalatedMaxTokens(base, attempt, undefined);
          expect(withZero).toBe(withUndefined);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// isAtOutputCeiling + calculateEscalatedMaxTokens Integration
// ═══════════════════════════════════════════════════════════════

describe("OutputTruncationRecovery fuzz — ceiling + escalation integration", () => {
  it("if isAtOutputCeiling returns true, escalation is pointless (already capped)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        fc.integer({ min: 1, max: 5 }),
        (currentMax, ceiling, attempt) => {
          if (isAtOutputCeiling(currentMax, ceiling)) {
            const escalated = calculateEscalatedMaxTokens(
              currentMax,
              attempt,
              ceiling,
            );
            expect(escalated).toBeLessThanOrEqual(ceiling);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

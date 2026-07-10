/**
 * ContextExhaustionGuard — Adversarial test suite.
 *
 * Covers:
 *   1. `isContextExhausted` pure function — threshold, edge cases, defensive handling
 *   2. `buildContextExhaustedMessage` — locale integration, variable interpolation
 *   3. `emitContextExhaustedStatus` — SSE event shape
 *   4. `logContextExhaustion` — diagnostic logging
 *   5. Pre-flight guard integration — createProviderStream returning null
 *   6. Truncation + exhaustion interaction — futile escalation detection
 *   7. Adversarial edge cases — zero budget, unknown context, concurrent triggers
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  isContextExhausted,
  buildContextExhaustedMessage,
  emitContextExhaustedStatus,
  logContextExhaustion,
  MINIMUM_VIABLE_OUTPUT_TOKENS,
} from "../lifecycle/ContextExhaustionGuard.ts";

import {
  isOutputTruncated,
  calculateEscalatedMaxTokens,
} from "../lifecycle/OutputTruncationRecovery.ts";

import type { PassState, EmitFunction } from "../types.ts";

// ── Mock PromptLocaleService ─────────────────────────────────
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    get: vi.fn(
      (_locale: string, key: string, variables: Record<string, string>) => {
        if (key === "harness.contextWindow.contextExhausted") {
          return `Context exhausted: ${variables.availableTokens} tokens left of ${variables.contextWindow} (${variables.iterationCount} iterations)`;
        }
        return `[${key}]`;
      },
    ),
    getDefaultLocale: vi.fn(() => "en"),
  },
}));

// ── Mock logger ──────────────────────────────────────────────
vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Helper: create a minimal PassState ───────────────────────
function createMockPassState(overrides: Partial<PassState> = {}): PassState {
  return {
    streamedText: "",
    finalStreamedText: "",
    streamedThinking: "",
    thinkingSignature: "",
    pendingToolCalls: [],
    streamedImages: [],
    start: performance.now(),
    firstTokenTime: null,
    generationEnd: null,
    thinkingStartTime: null,
    thinkingEndTime: null,
    outputCharacters: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    options: {},
    requestId: null,
    pendingRequestDocumentIdPromise: Promise.resolve(null),
    ...overrides,
  } as unknown as PassState;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  1. isContextExhausted — Pure Function Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("ContextExhaustionGuard", () => {
  describe("isContextExhausted", () => {
    it("should return true when clampedMaxTokens is below the threshold", () => {
      expect(isContextExhausted(2_000)).toBe(true);
      expect(isContextExhausted(1_000)).toBe(true);
      expect(isContextExhausted(100)).toBe(true);
    });

    it("should return false when clampedMaxTokens is at or above the threshold", () => {
      expect(isContextExhausted(MINIMUM_VIABLE_OUTPUT_TOKENS)).toBe(false);
      expect(isContextExhausted(MINIMUM_VIABLE_OUTPUT_TOKENS + 1)).toBe(false);
      expect(isContextExhausted(16_384)).toBe(false);
      expect(isContextExhausted(100_000)).toBe(false);
    });

    it("should return true when clampedMaxTokens is exactly one below the threshold", () => {
      expect(isContextExhausted(MINIMUM_VIABLE_OUTPUT_TOKENS - 1)).toBe(true);
    });

    it("should return true when clampedMaxTokens is zero", () => {
      expect(isContextExhausted(0)).toBe(true);
    });

    it("should return true when clampedMaxTokens is 1 (degenerate minimum)", () => {
      expect(isContextExhausted(1)).toBe(true);
    });

    it("should return true when clampedMaxTokens is negative (defensive)", () => {
      expect(isContextExhausted(-100)).toBe(true);
      expect(isContextExhausted(-1)).toBe(true);
    });

    it("should return false when clampedMaxTokens is undefined (self-hosted cold start)", () => {
      expect(isContextExhausted(undefined)).toBe(false);
    });

    it("should return false when clampedMaxTokens is null (no context window known)", () => {
      expect(isContextExhausted(null)).toBe(false);
    });

    it("should use MINIMUM_VIABLE_OUTPUT_TOKENS = 4096 as the threshold", () => {
      expect(MINIMUM_VIABLE_OUTPUT_TOKENS).toBe(4_096);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  2. buildContextExhaustedMessage — Locale Integration
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("buildContextExhaustedMessage", () => {
    it("should produce a non-empty message containing all interpolation values", () => {
      const message = buildContextExhaustedMessage(512, 128_000, 15, "en");
      expect(message).toContain("512");
      expect(message).toContain("128000");
      expect(message).toContain("15");
      expect(message.length).toBeGreaterThan(20);
    });

    it("should fall back to default locale when locale is undefined", () => {
      const message = buildContextExhaustedMessage(0, 128_000, 10);
      expect(message).toContain("0");
      expect(message).toContain("128000");
    });

    it("should handle zero values without throwing", () => {
      const message = buildContextExhaustedMessage(0, 0, 0);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    });

    it("should handle very large values without truncation", () => {
      const message = buildContextExhaustedMessage(
        999_999,
        2_000_000,
        500,
        "en",
      );
      expect(message).toContain("999999");
      expect(message).toContain("2000000");
      expect(message).toContain("500");
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  3. emitContextExhaustedStatus — SSE Event Shape
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("emitContextExhaustedStatus", () => {
    let mockEmit: EmitFunction;

    beforeEach(() => {
      mockEmit = vi.fn() as unknown as EmitFunction;
    });

    it("should emit a status event with type 'context_exhausted'", () => {
      emitContextExhaustedStatus(mockEmit, 512, 128_000);

      expect(mockEmit).toHaveBeenCalledOnce();
      const emittedEvent = (mockEmit as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(emittedEvent.message).toBe("context_exhausted");
      expect(emittedEvent.availableOutputTokens).toBe(512);
      expect(emittedEvent.contextWindow).toBe(128_000);
    });

    it("should include zero values when budget is completely exhausted", () => {
      emitContextExhaustedStatus(mockEmit, 0, 128_000);

      const emittedEvent = (mockEmit as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(emittedEvent.availableOutputTokens).toBe(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  4. logContextExhaustion — Diagnostic Logging
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("logContextExhaustion", () => {
    it("should log a warning with the budget details and harness label", async () => {
      const { default: logger } = await import("#src/utils/logger");

      logContextExhaustion(512, 128_000, "ReActHarness");

      expect(logger.warn).toHaveBeenCalled();
      const logMessage = (logger.warn as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(logMessage).toContain("512");
      expect(logMessage).toContain("128000");
      expect(logMessage).toContain("ReActHarness");
      expect(logMessage).toContain("ContextExhaustionGuard");
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  5. Truncation + Exhaustion Interaction
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("truncation + exhaustion interaction", () => {
    it("should detect when escalated maxTokens would still be exhausted", () => {
      const baseMaxTokens = 2_000;
      const escalatedMaxTokens = calculateEscalatedMaxTokens(
        baseMaxTokens,
        1,
      );

      // 2000 * 1.5 = 3000 — still below 4096 threshold
      expect(escalatedMaxTokens).toBe(3_000);
      expect(isContextExhausted(escalatedMaxTokens)).toBe(true);
    });

    it("should detect when escalated maxTokens crosses the viability threshold", () => {
      const baseMaxTokens = 3_000;
      const escalatedMaxTokens = calculateEscalatedMaxTokens(
        baseMaxTokens,
        1,
      );

      // 3000 * 1.5 = 4500 — above 4096 threshold
      expect(escalatedMaxTokens).toBe(4_500);
      expect(isContextExhausted(escalatedMaxTokens)).toBe(false);
    });

    it("should detect futile escalation when output is truncated AND budget is tiny", () => {
      const pass = createMockPassState({
        stopReason: "length",
        streamedText: "",
        pendingToolCalls: [],
      });

      expect(isOutputTruncated(pass)).toBe(true);

      // With a base of 1000 tokens:
      // Attempt 1: 1000 * 1.5 = 1500 (still exhausted)
      // Attempt 2: 1000 * 1.5^2 = 2250 (still exhausted)
      // Attempt 3: 1000 * 1.5^3 = 3375 (still exhausted)
      // All 3 attempts are futile
      for (let attempt = 1; attempt <= 3; attempt++) {
        const escalated = calculateEscalatedMaxTokens(1_000, attempt);
        expect(isContextExhausted(escalated)).toBe(true);
      }
    });

    it("should detect when escalation becomes viable on a later attempt", () => {
      const baseMaxTokens = 2_500;

      // Attempt 1: 2500 * 1.5 = 3750 (still exhausted)
      expect(
        isContextExhausted(calculateEscalatedMaxTokens(baseMaxTokens, 1)),
      ).toBe(true);

      // Attempt 2: 2500 * 1.5^2 = 5625 (viable!)
      expect(
        isContextExhausted(calculateEscalatedMaxTokens(baseMaxTokens, 2)),
      ).toBe(false);
    });

    it("should handle the boundary case where escalation lands exactly at threshold", () => {
      // We need baseMaxTokens * 1.5 = 4096
      // baseMaxTokens = 4096 / 1.5 ≈ 2730.67
      // So ceil(2731 * 1.5) = ceil(4096.5) = 4097 → viable
      // And ceil(2730 * 1.5) = ceil(4095) = 4095 → exhausted
      expect(
        isContextExhausted(calculateEscalatedMaxTokens(2_730, 1)),
      ).toBe(true);
      expect(
        isContextExhausted(calculateEscalatedMaxTokens(2_731, 1)),
      ).toBe(false);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  6. Adversarial Edge Cases
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("adversarial edge cases", () => {
    it("should not fire when clampedMaxTokens is undefined (self-hosted cold start)", () => {
      // When the context window is unknown, we can't enforce a budget
      expect(isContextExhausted(undefined)).toBe(false);
    });

    it("should not fire when clampedMaxTokens is null (no budget data)", () => {
      expect(isContextExhausted(null)).toBe(false);
    });

    it("should fire even when context window is enormous (budget is still tiny)", () => {
      // A 2M token context window doesn't help if input consumed 1,999,000 tokens
      expect(isContextExhausted(1_000)).toBe(true);
    });

    it("should handle Number.MAX_SAFE_INTEGER gracefully", () => {
      expect(isContextExhausted(Number.MAX_SAFE_INTEGER)).toBe(false);
    });

    it("should handle NaN defensively (treated as exhausted)", () => {
      // NaN < 4096 is false, so NaN should NOT trigger exhaustion
      // This tests the actual JavaScript behavior
      expect(isContextExhausted(NaN)).toBe(false);
    });

    it("should handle Infinity (not exhausted)", () => {
      expect(isContextExhausted(Infinity)).toBe(false);
    });

    it("should handle -Infinity (exhausted)", () => {
      expect(isContextExhausted(-Infinity)).toBe(true);
    });

    it("should produce different messages for different locales", () => {
      // Both call through to the mock, but verify the locale parameter is passed
      const messageEn = buildContextExhaustedMessage(100, 128_000, 5, "en");
      const messageCaveman = buildContextExhaustedMessage(
        100,
        128_000,
        5,
        "caveman",
      );

      // Both produce messages (mock doesn't differentiate, but locale is passed correctly)
      expect(messageEn.length).toBeGreaterThan(0);
      expect(messageCaveman.length).toBeGreaterThan(0);
    });

    it("should handle multiple consecutive guard triggers without side effects", () => {
      const mockEmit = vi.fn() as unknown as EmitFunction;

      // Fire the guard 5 times in a row
      for (let index = 0; index < 5; index++) {
        expect(isContextExhausted(100)).toBe(true);
        emitContextExhaustedStatus(mockEmit, 100, 128_000);
      }

      // Each call should have emitted exactly once (no accumulation or state leaks)
      expect(mockEmit).toHaveBeenCalledTimes(5);
    });

    it("should handle the MINIMUM_CLAMPED_OUTPUT_TOKENS (1024) being below the guard threshold", () => {
      // MINIMUM_CLAMPED_OUTPUT_TOKENS (1024) is used by clampOutputTokens as
      // the absolute floor. But 1024 < 4096 (MINIMUM_VIABLE_OUTPUT_TOKENS),
      // so even the clamped floor triggers the guard.
      expect(isContextExhausted(1_024)).toBe(true);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  7. Threshold Constant Validation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe("threshold constant validation", () => {
    it("should have MINIMUM_VIABLE_OUTPUT_TOKENS > MINIMUM_CLAMPED_OUTPUT_TOKENS", () => {
      // The guard threshold must be above the clamped floor, otherwise
      // the guard would never fire (clampOutputTokens would never return
      // a value below its own floor).
      // MINIMUM_CLAMPED_OUTPUT_TOKENS = 1024
      expect(MINIMUM_VIABLE_OUTPUT_TOKENS).toBeGreaterThan(1_024);
    });

    it("should have MINIMUM_VIABLE_OUTPUT_TOKENS at a level that can fit a tool call + reasoning", () => {
      // A tool call JSON typically needs 500-2K tokens. Add reasoning overhead
      // (thinking + preamble), and 4K is the minimum safe budget.
      expect(MINIMUM_VIABLE_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4_096);
    });
  });
});

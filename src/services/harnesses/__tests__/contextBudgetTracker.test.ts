/**
 * ContextBudgetTracker — Comprehensive Test Suite
 *
 * Validates the hybrid token budget tracking system that uses both
 * heuristic estimates (4 chars/token) and real provider-reported token
 * counts with calibration ratio for progressively better accuracy.
 */
import { describe, it, expect, vi } from "vitest";

import ContextBudgetTracker from "#src/services/harnesses/ContextBudgetTracker";
import type { ContextBudgetSnapshot } from "#src/services/harnesses/ContextBudgetTracker";
import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "#src/constants/TokenBudgetDefaults";
import { estimateTokens } from "#src/utils/CostCalculator";

// ── Test helpers ────────────────────────────────────────────

/** Create a mock emit function that captures emitted events. */
function createMockEmit() {
  const emittedEvents: Array<Record<string, unknown>> = [];
  const emit = vi.fn((event: { type: string; [key: string]: unknown }) => {
    emittedEvents.push(event);
  });
  return { emit, emittedEvents };
}

// ── Heuristic estimation tests ──────────────────────────────

describe("ContextBudgetTracker", () => {
  const CONTEXT_WINDOW = 128_000;

  describe("computeAndEmitEstimate (heuristic)", () => {
    it("should compute budget from heuristic estimates and emit with source 'estimated'", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const messageTokens = 10_000;
      const systemPrompt = "You are a helpful assistant.";
      const toolSchemas = [{ name: "readFile", description: "Read a file" }];
      const requestedMaxTokens = 16_384;

      const result = tracker.computeAndEmitEstimate(
        messageTokens,
        systemPrompt,
        toolSchemas,
        requestedMaxTokens,
      );

      expect(result.clampedMaxTokens).toBe(requestedMaxTokens);
      expect(emittedEvents).toHaveLength(1);

      const event = emittedEvents[0];
      expect(event.type).toBe("context_budget");
      expect(event.source).toBe("estimated");
      expect(event.contextWindow).toBe(CONTEXT_WINDOW);
      expect(event.messageTokens).toBe(messageTokens);
      expect(event.toolCount).toBe(1);
    });

    it("should clamp maxTokens when budget is tight", () => {
      const { emit } = createMockEmit();
      const smallWindow = 20_000;
      const tracker = new ContextBudgetTracker(emit, smallWindow);

      const messageTokens = 15_000;
      const systemPrompt = "System instructions that take up tokens.";
      const requestedMaxTokens = 16_384;

      const result = tracker.computeAndEmitEstimate(
        messageTokens,
        systemPrompt,
        [],
        requestedMaxTokens,
      );

      // Budget should be less than requested since input is already 15k + system
      expect(result.clampedMaxTokens).toBeLessThan(requestedMaxTokens);
      expect(result.clampedMaxTokens).toBeGreaterThanOrEqual(
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
      );
    });

    it("should return undefined maxTokens when requestedMaxTokens is undefined", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const result = tracker.computeAndEmitEstimate(5000, "", [], undefined);

      expect(result.clampedMaxTokens).toBeUndefined();
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].isClamped).toBe(false);
    });

    it("should include safety margin in budget calculation", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);
      const messageTokens = 50_000;

      tracker.computeAndEmitEstimate(messageTokens, "", [], 16_384);

      const event = emittedEvents[0];
      const expectedSafetyMargin =
        Math.ceil(messageTokens * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER) +
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS;
      expect(event.safetyMarginTokens).toBe(expectedSafetyMargin);
      expect(event.totalInputTokens).toBe(
        messageTokens + expectedSafetyMargin,
      );
    });

    it("should account for system prompt and tool schema tokens", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const systemPrompt = "A".repeat(4000);
      const toolSchemas = [
        {
          name: "readFile",
          description: "Read a file from disk",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        {
          name: "writeFile",
          description: "Write content to a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      ];

      tracker.computeAndEmitEstimate(10_000, systemPrompt, toolSchemas, 16_384);

      const event = emittedEvents[0];
      const expectedSystemTokens = estimateTokens(systemPrompt);
      const expectedToolTokens = estimateTokens(JSON.stringify(toolSchemas));

      expect(event.systemPromptTokens).toBe(expectedSystemTokens);
      expect(event.toolSchemaTokens).toBe(expectedToolTokens);
      expect(event.toolCount).toBe(2);
    });
  });

  // ── Real usage recording tests ──────────────────────────────

  describe("recordRealUsage", () => {
    it("should re-emit budget with source 'reported' after real usage arrives", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      // First: heuristic estimate
      tracker.computeAndEmitEstimate(10_000, "system prompt", [], 16_384);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].source).toBe("estimated");

      // Then: real usage from provider
      tracker.recordRealUsage({ inputTokens: 11_500 }, 10_000);
      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[1].source).toBe("reported");
      expect(emittedEvents[1].lastReportedInputTokens).toBe(11_500);
    });

    it("should compute calibration ratio from first real usage", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const estimatedMessageTokens = 10_000;
      const systemPrompt = "system prompt";
      const systemTokens = estimateTokens(systemPrompt);
      const fullEstimate = estimatedMessageTokens + systemTokens;

      tracker.computeAndEmitEstimate(
        estimatedMessageTokens,
        systemPrompt,
        [],
        16_384,
      );

      const realInput = 12_000;
      tracker.recordRealUsage({ inputTokens: realInput }, estimatedMessageTokens);

      const expectedRatio = realInput / fullEstimate;
      expect(tracker.getCalibrationRatio()).toBeCloseTo(expectedRatio, 3);
    });

    it("should not record usage with zero or missing input tokens", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);

      tracker.recordRealUsage(null, 10_000);
      expect(emittedEvents).toHaveLength(1); // Only the estimate

      tracker.recordRealUsage({ inputTokens: 0 }, 10_000);
      expect(emittedEvents).toHaveLength(1); // Still only the estimate

      tracker.recordRealUsage(undefined, 10_000);
      expect(emittedEvents).toHaveLength(1);
    });

    it("should include cache tokens in real input total", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);

      tracker.recordRealUsage(
        {
          inputTokens: 5_000,
          cacheReadInputTokens: 3_000,
          cacheCreationInputTokens: 2_000,
        },
        10_000,
      );

      // getTotalInputTokens sums: inputTokens + cacheRead + cacheCreation = 10000
      expect(emittedEvents[1].lastReportedInputTokens).toBe(10_000);
    });
  });

  // ── Calibration ratio tests ─────────────────────────────────

  describe("calibration ratio", () => {
    it("should apply calibration ratio to subsequent estimates", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      // Iteration 1: heuristic estimate
      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      expect(emittedEvents[0].messageTokens).toBe(10_000);

      // Real usage arrives: actual input is 15% higher than estimated
      tracker.recordRealUsage({ inputTokens: 11_500 }, 10_000);

      // Iteration 2: now the estimate should use the calibration ratio
      tracker.computeAndEmitEstimate(20_000, "", [], 16_384);

      const calibratedEvent = emittedEvents[2]; // 3rd event (est, real, est)
      // Source should be "reported" since calibration ratio is active
      expect(calibratedEvent.source).toBe("reported");
      // Message tokens should be calibrated (20_000 * ratio)
      const ratio = tracker.getCalibrationRatio()!;
      expect(calibratedEvent.messageTokens).toBe(Math.ceil(20_000 * ratio));
    });

    it("should return null calibration ratio before any real usage", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      expect(tracker.getCalibrationRatio()).toBeNull();
    });
  });

  // ── Multi-iteration accuracy tests ──────────────────────────

  describe("multi-iteration agentic loop", () => {
    it("should progressively improve accuracy over multiple iterations", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      // Iteration 1: pure heuristic
      tracker.computeAndEmitEstimate(10_000, "system", [], 16_384);
      expect(emittedEvents[0].source).toBe("estimated");

      // Iteration 1 result: real input is 12k (heuristic underestimated by 20%)
      tracker.recordRealUsage({ inputTokens: 12_000 }, 10_000);
      expect(emittedEvents[1].source).toBe("reported");

      // Iteration 2: uses calibrated estimate
      tracker.computeAndEmitEstimate(15_000, "system", [], 16_384);
      const iteration2Estimate = emittedEvents[2];
      expect(iteration2Estimate.source).toBe("reported");

      // Iteration 2 result: confirm calibration still updates
      tracker.recordRealUsage({ inputTokens: 18_500 }, 15_000);
      expect(emittedEvents[3].source).toBe("reported");
    });
  });

  // ── Snapshot serialization tests ────────────────────────────

  describe("getSnapshot", () => {
    it("should return null before any computation", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      expect(tracker.getSnapshot()).toBeNull();
    });

    it("should return a serializable snapshot after estimate", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "system", [], 16_384);

      const snapshot = tracker.getSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.contextWindow).toBe(CONTEXT_WINDOW);
      expect(snapshot!.source).toBe("estimated");
      expect(snapshot!.calibrationRatio).toBeUndefined();

      // Verify it's a plain serializable object (no class instances, no circular refs)
      const serialized = JSON.stringify(snapshot);
      const deserialized = JSON.parse(serialized) as ContextBudgetSnapshot;
      expect(deserialized.contextWindow).toBe(snapshot!.contextWindow);
      expect(deserialized.source).toBe(snapshot!.source);
    });

    it("should include calibration data after real usage", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      tracker.recordRealUsage({ inputTokens: 11_500 }, 10_000);

      const snapshot = tracker.getSnapshot();
      expect(snapshot!.source).toBe("reported");
      expect(snapshot!.lastReportedInputTokens).toBe(11_500);
      expect(snapshot!.calibrationRatio).toBeDefined();
      expect(snapshot!.calibrationRatio).toBeGreaterThan(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle zero message tokens", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(0, "", [], 16_384);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].messageTokens).toBe(0);
      // Even an empty prompt reserves the fixed headroom — the provider
      // still prepends chat template tokens the estimate cannot see.
      expect(emittedEvents[0].availableOutputTokens).toBe(
        CONTEXT_WINDOW - OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
      );
    });

    it("should handle empty system prompt and zero tools", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(50_000, "", [], 16_384);

      expect(emittedEvents[0].systemPromptTokens).toBe(0);
      expect(emittedEvents[0].toolSchemaTokens).toBe(0);
      expect(emittedEvents[0].toolCount).toBe(0);
    });

    it("should handle context window smaller than input", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tinyWindow = 5_000;
      const tracker = new ContextBudgetTracker(emit, tinyWindow);

      const result = tracker.computeAndEmitEstimate(10_000, "", [], 8_192);

      // Available should be 0 (clamped to non-negative)
      expect(emittedEvents[0].availableOutputTokens).toBe(0);
      // Should clamp to MINIMUM_CLAMPED_OUTPUT_TOKENS
      expect(result.clampedMaxTokens).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
      expect(emittedEvents[0].isClamped).toBe(true);
    });

    it("should handle updateContextWindow mid-session", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      expect(emittedEvents[0].contextWindow).toBe(CONTEXT_WINDOW);

      // Model context window discovered at runtime to be larger
      const updatedWindow = 200_000;
      tracker.updateContextWindow(updatedWindow);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      expect(emittedEvents[1].contextWindow).toBe(updatedWindow);
    });
  });

  // ── Safety margin preservation tests ────────────────────────

  describe("safety margin", () => {
    it("should apply safety margin to heuristic estimates", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const messageTokens = 50_000;
      tracker.computeAndEmitEstimate(messageTokens, "", [], 16_384);

      const expectedMargin =
        Math.ceil(messageTokens * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER) +
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS;
      expect(emittedEvents[0].safetyMarginTokens).toBe(expectedMargin);
    });

    it("should apply safety margin to reported token counts", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      tracker.recordRealUsage({ inputTokens: 12_000 }, 10_000);

      const reportedEvent = emittedEvents[1];
      const expectedMargin =
        Math.ceil(12_000 * OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER) +
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS;
      expect(reportedEvent.safetyMarginTokens).toBe(expectedMargin);
    });

    it("should include margin when computing available output tokens", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const messageTokens = 50_000;
      tracker.computeAndEmitEstimate(messageTokens, "", [], 16_384);

      const margin = emittedEvents[0].safetyMarginTokens as number;
      const totalInput = emittedEvents[0].totalInputTokens as number;
      const available = emittedEvents[0].availableOutputTokens as number;

      expect(totalInput).toBe(messageTokens + margin);
      expect(available).toBe(CONTEXT_WINDOW - totalInput);
    });
  });

  // ── Clamping behavior tests ─────────────────────────────────

  describe("output token clamping", () => {
    it("should not clamp when plenty of budget remains", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      const result = tracker.computeAndEmitEstimate(
        10_000,
        "",
        [],
        16_384,
      );

      expect(result.clampedMaxTokens).toBe(16_384);
      expect(emittedEvents[0].isClamped).toBe(false);
    });

    it("should clamp to available budget when overflowing", () => {
      const { emit, emittedEvents } = createMockEmit();
      const smallWindow = 30_000;
      const tracker = new ContextBudgetTracker(emit, smallWindow);

      const result = tracker.computeAndEmitEstimate(
        20_000,
        "A".repeat(2000),
        [],
        16_384,
      );

      expect(result.clampedMaxTokens).toBeLessThan(16_384);
      expect(emittedEvents[0].isClamped).toBe(true);
    });

    it("should enforce MINIMUM_CLAMPED_OUTPUT_TOKENS floor", () => {
      const { emit } = createMockEmit();
      const tinyWindow = 12_000;
      const tracker = new ContextBudgetTracker(emit, tinyWindow);

      const result = tracker.computeAndEmitEstimate(
        11_000,
        "A".repeat(2000),
        [],
        16_384,
      );

      expect(result.clampedMaxTokens).toBe(MINIMUM_CLAMPED_OUTPUT_TOKENS);
    });
  });

  // ── Emit function interaction tests ─────────────────────────

  describe("SSE emission", () => {
    it("should emit exactly one event per computeAndEmitEstimate call", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      tracker.computeAndEmitEstimate(20_000, "", [], 16_384);
      tracker.computeAndEmitEstimate(30_000, "", [], 16_384);

      expect(emit).toHaveBeenCalledTimes(3);
    });

    it("should emit exactly one event per recordRealUsage call", () => {
      const { emit } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      tracker.recordRealUsage({ inputTokens: 12_000 }, 10_000);

      // 1 for estimate + 1 for real usage
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it("should emit context_budget event type", () => {
      const { emit, emittedEvents } = createMockEmit();
      const tracker = new ContextBudgetTracker(emit, CONTEXT_WINDOW);

      tracker.computeAndEmitEstimate(10_000, "", [], 16_384);
      expect(emittedEvents[0].type).toBe("context_budget");

      tracker.recordRealUsage({ inputTokens: 12_000 }, 10_000);
      expect(emittedEvents[1].type).toBe("context_budget");
    });
  });
});

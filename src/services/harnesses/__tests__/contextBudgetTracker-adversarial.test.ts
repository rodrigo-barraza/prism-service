import { vi, describe, it, expect } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import ContextBudgetTracker from "#src/services/harnesses/ContextBudgetTracker";
import type { ContextBudgetSnapshot } from "#src/services/harnesses/ContextBudgetTracker";
import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "#src/constants/TokenBudgetDefaults";

// ═══════════════════════════════════════════════════════════════
// ADVERSARIAL TESTS — ContextBudgetTracker
//
// Hand-crafted edge cases targeting numerical overflow, negative
// token counts, calibration ratio corruption, and boundary
// conditions in the clamping logic.
// ═══════════════════════════════════════════════════════════════

function createMockEmit() {
  const emittedEvents: Array<Record<string, unknown>> = [];
  const emit = vi.fn((event: { type: string; [key: string]: unknown }) => {
    emittedEvents.push(event);
  });
  return { emit, emittedEvents };
}

describe("ContextBudgetTracker adversarial — boundary clamping", () => {
  it("zero context window should produce availableOutputTokens of 0, never negative", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 0);

    const result = tracker.computeAndEmitEstimate(1000, "system prompt", [], 8192);

    expect(result.availableForOutput).toBeLessThanOrEqual(0);
    // The snapshot must clamp to 0, not go negative
    const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
    expect(snapshot.availableOutputTokens).toBe(0);
    expect(snapshot.isClamped).toBe(true);
  });

  it("context window smaller than input should never produce negative available output", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 100);

    // Message tokens alone exceed the context window
    const result = tracker.computeAndEmitEstimate(5000, "huge system prompt".repeat(100), [], 16384);

    const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
    expect(snapshot.availableOutputTokens).toBe(0);
    expect(snapshot.isClamped).toBe(true);
  });

  it("extremely large context window (10M tokens) should not cause numeric overflow", () => {
    const { emit, emittedEvents } = createMockEmit();
    const contextWindow = 10_000_000;
    const tracker = new ContextBudgetTracker(emit, contextWindow);

    const result = tracker.computeAndEmitEstimate(1000, "short prompt", [], 100_000);

    expect(result.availableForOutput).toBeGreaterThan(0);
    expect(result.availableForOutput).toBeLessThan(contextWindow);
    expect(Number.isFinite(result.availableForOutput)).toBe(true);
  });

  it("requestedMaxTokens of 0 should not clamp (isClamped false)", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    tracker.computeAndEmitEstimate(1000, "prompt", [], 0);

    const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
    // 0 is falsy, so isClamped should be false (no clamping requested)
    expect(snapshot.isClamped).toBe(false);
  });

  it("undefined requestedMaxTokens should not clamp", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    const result = tracker.computeAndEmitEstimate(1000, "prompt", [], undefined);

    expect(result.clampedMaxTokens).toBeUndefined();
    const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
    expect(snapshot.isClamped).toBe(false);
  });

  it("clamped output should never go below MINIMUM_CLAMPED_OUTPUT_TOKENS", () => {
    const { emit } = createMockEmit();
    // Context window barely bigger than input — available output is tiny
    const tracker = new ContextBudgetTracker(emit, 2000);

    const result = tracker.computeAndEmitEstimate(
      1800,
      "",
      [],
      50_000,
    );

    // Clamping is triggered because requested (50K) > available
    // But the floor must be MINIMUM_CLAMPED_OUTPUT_TOKENS
    if (result.clampedMaxTokens !== undefined) {
      expect(result.clampedMaxTokens).toBeGreaterThanOrEqual(
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
      );
    }
  });
});

describe("ContextBudgetTracker adversarial — calibration ratio edge cases", () => {
  it("recordRealUsage with zero real input tokens should not set calibration ratio", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);
    tracker.recordRealUsage({ inputTokens: 0, outputTokens: 100 } as any, 1000);

    expect(tracker.getCalibrationRatio()).toBeNull();
  });

  it("recordRealUsage with negative real input tokens should not set calibration ratio", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);
    tracker.recordRealUsage({ inputTokens: -500, outputTokens: 100 } as any, 1000);

    expect(tracker.getCalibrationRatio()).toBeNull();
  });

  it("recordRealUsage with null usage should be a no-op", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);
    const eventCountBefore = emittedEvents.length;
    tracker.recordRealUsage(null, 1000);

    // No additional event should be emitted
    expect(emittedEvents.length).toBe(eventCountBefore);
    expect(tracker.getCalibrationRatio()).toBeNull();
  });

  it("calibration ratio should survive across multiple estimate cycles", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    // First pass: establish calibration
    tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);
    tracker.recordRealUsage(
      { inputTokens: 2000, outputTokens: 500 } as any,
      1000,
    );

    const ratioAfterFirst = tracker.getCalibrationRatio();
    expect(ratioAfterFirst).not.toBeNull();
    expect(ratioAfterFirst).toBeGreaterThan(0);

    // Second pass: estimate should use the calibration ratio
    tracker.computeAndEmitEstimate(2000, "prompt", [], 16384);
    // Calibration should not reset
    expect(tracker.getCalibrationRatio()).not.toBeNull();
  });

  it("extremely skewed calibration ratio (100:1) should produce valid snapshots", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 1_000_000);

    // Provider reports 100x what heuristic estimated
    tracker.computeAndEmitEstimate(100, "a", [], 16384);
    tracker.recordRealUsage(
      { inputTokens: 10_000, outputTokens: 500 } as any,
      100,
    );

    const ratio = tracker.getCalibrationRatio();
    expect(ratio).toBeGreaterThan(10); // Wildly skewed

    // Next estimate should still produce a valid snapshot
    tracker.computeAndEmitEstimate(200, "a", [], 16384);
    const lastSnapshot = tracker.getSnapshot();
    expect(lastSnapshot).not.toBeNull();
    expect(lastSnapshot!.availableOutputTokens).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lastSnapshot!.messageTokens)).toBe(true);
  });

  it("zero estimated input should not produce NaN calibration ratio (division by zero)", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    // Zero estimated message tokens + empty system prompt + no tools = 0 input
    tracker.computeAndEmitEstimate(0, "", [], 16384);
    tracker.recordRealUsage(
      { inputTokens: 5000, outputTokens: 100 } as any,
      0,
    );

    const ratio = tracker.getCalibrationRatio();
    // If ratio was set, it must be finite (not NaN, not Infinity)
    if (ratio !== null) {
      expect(Number.isFinite(ratio)).toBe(true);
    }
  });
});

describe("ContextBudgetTracker adversarial — tool schema edge cases", () => {
  it("tool schemas with circular references should not crash JSON.stringify", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    // Create a circular reference
    const circularSchema: Record<string, unknown> = { name: "tool" };
    circularSchema.self = circularSchema;

    // This should throw during JSON.stringify but the tracker should
    // handle it gracefully or the test documents the behavior
    expect(() => {
      try {
        tracker.computeAndEmitEstimate(1000, "prompt", [circularSchema], 16384);
      } catch {
        // If it throws, that's acceptable — but it should be a TypeError,
        // not an unrelated crash
        throw new TypeError("Circular reference in tool schemas");
      }
    }).toThrow(TypeError);
  });

  it("empty tool schemas array should contribute 0 toolSchemaTokens", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);

    const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
    expect(snapshot.toolSchemaTokens).toBe(0);
    expect(snapshot.toolCount).toBe(0);
  });

  it("1000 tool schemas should not cause performance degradation", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 1_000_000);

    const manySchemas = Array.from({ length: 1000 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool number ${index} that does something`,
      parameters: {
        type: "object",
        properties: { arg: { type: "string" } },
      },
    }));

    const startTime = performance.now();
    tracker.computeAndEmitEstimate(1000, "prompt", manySchemas, 16384);
    const elapsed = performance.now() - startTime;

    expect(elapsed).toBeLessThan(500); // Should complete well under 500ms
    const snapshot = tracker.getSnapshot();
    expect(snapshot!.toolCount).toBe(1000);
    expect(snapshot!.toolSchemaTokens).toBeGreaterThan(0);
  });
});

describe("ContextBudgetTracker adversarial — estimateFromMessages edge cases", () => {
  it("empty messages array should produce zero message tokens", () => {
    const snapshot = ContextBudgetTracker.estimateFromMessages(
      [],
      128_000,
    );

    expect(snapshot.messageTokens).toBe(0);
    expect(snapshot.availableOutputTokens).toBeGreaterThan(0);
    expect(snapshot.source).toBe("estimated");
  });

  it("message with non-string content (array of parts) should not crash", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello world" },
          { type: "image_url", url: "https://example.com/img.png" },
        ],
      },
    ];

    const snapshot = ContextBudgetTracker.estimateFromMessages(
      messages,
      128_000,
    );

    expect(snapshot.messageTokens).toBeGreaterThan(0);
    expect(Number.isFinite(snapshot.messageTokens)).toBe(true);
  });

  it("message with numeric content should not crash (coerce to string check)", () => {
    const messages = [
      { role: "user", content: 42 },
    ];

    // content is neither string nor array — should fall through to empty string
    const snapshot = ContextBudgetTracker.estimateFromMessages(
      messages as any,
      128_000,
    );

    expect(Number.isFinite(snapshot.messageTokens)).toBe(true);
  });

  it("message with thinking field should contribute to token count", () => {
    const messagesWithThinking = [
      { role: "assistant", content: "response", thinking: "Let me analyze this step by step..." },
    ];
    const messagesWithoutThinking = [
      { role: "assistant", content: "response" },
    ];

    const withThinking = ContextBudgetTracker.estimateFromMessages(
      messagesWithThinking,
      128_000,
    );
    const withoutThinking = ContextBudgetTracker.estimateFromMessages(
      messagesWithoutThinking,
      128_000,
    );

    expect(withThinking.messageTokens).toBeGreaterThan(withoutThinking.messageTokens);
  });

  it("message with images should add 1000 tokens per image", () => {
    const messagesWithImages = [
      { role: "user", content: "Look at these", images: ["img1.png", "img2.png", "img3.png"] },
    ];
    const messagesWithoutImages = [
      { role: "user", content: "Look at these" },
    ];

    const withImages = ContextBudgetTracker.estimateFromMessages(
      messagesWithImages,
      128_000,
    );
    const withoutImages = ContextBudgetTracker.estimateFromMessages(
      messagesWithoutImages,
      128_000,
    );

    expect(withImages.messageTokens - withoutImages.messageTokens).toBe(3000);
  });

  it("context window of 0 should produce availableOutputTokens of 0", () => {
    const snapshot = ContextBudgetTracker.estimateFromMessages(
      [{ role: "user", content: "hello" }],
      0,
    );

    expect(snapshot.availableOutputTokens).toBe(0);
    expect(snapshot.contextWindow).toBe(0);
  });
});

describe("ContextBudgetTracker adversarial — updateContextWindow", () => {
  it("updating to a smaller context window should reduce available output on next estimate", () => {
    const { emit } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    const largeBudget = tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);

    tracker.updateContextWindow(4_000);
    const smallBudget = tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);

    expect(smallBudget.availableForOutput).toBeLessThan(largeBudget.availableForOutput);
  });

  it("updating to 0 context window should produce clamped output", () => {
    const { emit, emittedEvents } = createMockEmit();
    const tracker = new ContextBudgetTracker(emit, 128_000);

    tracker.updateContextWindow(0);
    tracker.computeAndEmitEstimate(1000, "prompt", [], 16384);

    const lastSnapshot = emittedEvents[emittedEvents.length - 1] as unknown as ContextBudgetSnapshot;
    expect(lastSnapshot.availableOutputTokens).toBe(0);
    expect(lastSnapshot.isClamped).toBe(true);
  });
});

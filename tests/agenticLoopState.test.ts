/**
 * AgenticLoopState — tests for getCleanDisplayData, the function that
 * cleans display segments for DB persistence and session restore.
 *
 * Display segments control how thinking/text/tools are interleaved in
 * the chat UI. If cleaning drops valid segments or leaves empty ones,
 * restored sessions render incorrectly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/CostCalculator.ts", () => ({
  createUsageAccumulator: () => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  }),
}));

const { default: AgenticLoopState } = await import(
  "../src/services/AgenticLoopState.ts"
);

// ═══════════════════════════════════════════════════════════════
describe("AgenticLoopState.getCleanDisplayData", () => {
  it("should filter out empty text fragments", () => {
    const state = new AgenticLoopState();
    state.displayTextFragments = ["Hello", "  ", "World"];
    state.displaySegments = [
      { type: "text", fragmentIndex: 0 },
      { type: "text", fragmentIndex: 1 }, // empty after trim
      { type: "text", fragmentIndex: 2 },
    ];

    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();

    expect(cleanTextFragments).toEqual(["Hello", "World"]);
    expect(cleanSegments).toHaveLength(2);
  });

  it("should filter out empty thinking fragments", () => {
    const state = new AgenticLoopState();
    state.displayThinkingFragments = ["Reasoning...", "", "More reasoning"];
    state.displaySegments = [
      { type: "thinking", fragmentIndex: 0 },
      { type: "thinking", fragmentIndex: 1 }, // empty
      { type: "thinking", fragmentIndex: 2 },
    ];

    const { cleanSegments, cleanThinkingFragments } = state.getCleanDisplayData();

    expect(cleanThinkingFragments).toEqual(["Reasoning...", "More reasoning"]);
    expect(cleanSegments).toHaveLength(2);
  });

  it("should trim text and thinking fragments", () => {
    const state = new AgenticLoopState();
    state.displayTextFragments = ["  Hello World  "];
    state.displayThinkingFragments = ["  Thinking deeply  "];
    state.displaySegments = [
      { type: "thinking", fragmentIndex: 0 },
      { type: "text", fragmentIndex: 0 },
    ];

    const { cleanTextFragments, cleanThinkingFragments } = state.getCleanDisplayData();

    expect(cleanTextFragments).toEqual(["Hello World"]);
    expect(cleanThinkingFragments).toEqual(["Thinking deeply"]);
  });

  it("should pass through tools segments unchanged", () => {
    const state = new AgenticLoopState();
    state.displaySegments = [
      { type: "tools", toolIds: ["call-1", "call-2"] },
    ];

    const { cleanSegments } = state.getCleanDisplayData();

    expect(cleanSegments).toHaveLength(1);
    expect(cleanSegments[0]).toEqual({ type: "tools", toolIds: ["call-1", "call-2"] });
  });

  it("should re-index fragment indices after filtering", () => {
    const state = new AgenticLoopState();
    state.displayTextFragments = ["", "Valid text", "", "More text"];
    state.displaySegments = [
      { type: "text", fragmentIndex: 0 }, // empty — filtered
      { type: "text", fragmentIndex: 1 }, // kept → new index 0
      { type: "text", fragmentIndex: 2 }, // empty — filtered
      { type: "text", fragmentIndex: 3 }, // kept → new index 1
    ];

    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();

    expect(cleanTextFragments).toEqual(["Valid text", "More text"]);
    expect(cleanSegments).toHaveLength(2);
    expect(cleanSegments[0]).toEqual({ type: "text", fragmentIndex: 0 });
    expect(cleanSegments[1]).toEqual({ type: "text", fragmentIndex: 1 });
  });

  it("should handle interleaved thinking, text, and tools segments", () => {
    const state = new AgenticLoopState();
    state.displayThinkingFragments = ["Reasoning"];
    state.displayTextFragments = ["Answer"];
    state.displaySegments = [
      { type: "thinking", fragmentIndex: 0 },
      { type: "tools", toolIds: ["call-1"] },
      { type: "text", fragmentIndex: 0 },
    ];

    const { cleanSegments, cleanTextFragments, cleanThinkingFragments } =
      state.getCleanDisplayData();

    expect(cleanThinkingFragments).toEqual(["Reasoning"]);
    expect(cleanTextFragments).toEqual(["Answer"]);
    expect(cleanSegments).toHaveLength(3);
    expect(cleanSegments[0].type).toBe("thinking");
    expect(cleanSegments[1].type).toBe("tools");
    expect(cleanSegments[2].type).toBe("text");
  });

  it("should return empty arrays for state with no segments", () => {
    const state = new AgenticLoopState();

    const { cleanSegments, cleanTextFragments, cleanThinkingFragments } =
      state.getCleanDisplayData();

    expect(cleanSegments).toEqual([]);
    expect(cleanTextFragments).toEqual([]);
    expect(cleanThinkingFragments).toEqual([]);
  });

  it("should handle undefined fragment at an index gracefully", () => {
    const state = new AgenticLoopState();
    // Fragment arrays are shorter than segment references
    state.displayTextFragments = [];
    state.displaySegments = [
      { type: "text", fragmentIndex: 5 }, // out of bounds
    ];

    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();

    // Out-of-bounds fragment resolves to undefined → trim → empty → filtered out
    expect(cleanSegments).toHaveLength(0);
    expect(cleanTextFragments).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AgenticLoopState — constructor", () => {
  it("should initialize with default values", () => {
    const state = new AgenticLoopState();

    expect(state.iterations).toBe(0);
    expect(state.finalStreamedText).toBe("");
    expect(state.streamedThinking).toBe("");
    expect(state.streamedImages).toEqual([]);
    expect(state.streamedToolCalls).toEqual([]);
    expect(state.planModeActive).toBe(false);
    expect(state.originalMessageCount).toBe(0);
    expect(state.compactionPerformed).toBe(false);
  });

  it("should initialize with planModeActive when specified", () => {
    const state = new AgenticLoopState({ planModeActive: true });

    expect(state.planModeActive).toBe(true);
  });

  it("should initialize with originalMessageCount when specified", () => {
    const state = new AgenticLoopState({ originalMessageCount: 15 });

    expect(state.originalMessageCount).toBe(15);
  });
});

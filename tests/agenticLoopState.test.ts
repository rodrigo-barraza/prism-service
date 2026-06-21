/**
 * AgenticLoopState — tests for getCleanDisplayData, the function that
 * cleans display segments for DB persistence and session restore.
 *
 * Display segments control how thinking/text/tools are interleaved in
 * the chat UI. If cleaning drops valid segments or leaves empty ones,
 * restored sessions render incorrectly.
 */
import { describe, it, expect, vi } from "vitest";
import { TYPES } from "../src/constants";

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
      { type: TYPES.TEXT, fragmentIndex: 0 },
      { type: TYPES.TEXT, fragmentIndex: 1 }, // empty after trim
      { type: TYPES.TEXT, fragmentIndex: 2 },
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
      { type: TYPES.TEXT, fragmentIndex: 0 },
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
      { type: TYPES.TEXT, fragmentIndex: 0 }, // empty — filtered
      { type: TYPES.TEXT, fragmentIndex: 1 }, // kept → new index 0
      { type: TYPES.TEXT, fragmentIndex: 2 }, // empty — filtered
      { type: TYPES.TEXT, fragmentIndex: 3 }, // kept → new index 1
    ];

    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();

    expect(cleanTextFragments).toEqual(["Valid text", "More text"]);
    expect(cleanSegments).toHaveLength(2);
    expect(cleanSegments[0]).toEqual({ type: TYPES.TEXT, fragmentIndex: 0 });
    expect(cleanSegments[1]).toEqual({ type: TYPES.TEXT, fragmentIndex: 1 });
  });

  it("should handle interleaved thinking, text, and tools segments", () => {
    const state = new AgenticLoopState();
    state.displayThinkingFragments = ["Reasoning"];
    state.displayTextFragments = ["Answer"];
    state.displaySegments = [
      { type: "thinking", fragmentIndex: 0 },
      { type: "tools", toolIds: ["call-1"] },
      { type: TYPES.TEXT, fragmentIndex: 0 },
    ];

    const { cleanSegments, cleanTextFragments, cleanThinkingFragments } =
      state.getCleanDisplayData();

    expect(cleanThinkingFragments).toEqual(["Reasoning"]);
    expect(cleanTextFragments).toEqual(["Answer"]);
    expect(cleanSegments).toHaveLength(3);
    expect(cleanSegments[0].type).toBe("thinking");
    expect(cleanSegments[1].type).toBe("tools");
    expect(cleanSegments[2].type).toBe(TYPES.TEXT);
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
      { type: TYPES.TEXT, fragmentIndex: 5 }, // out of bounds
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

// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts + adversarial-harness-lifecycle.test.ts) ──

describe('AgenticLoopState adversarial', () => {
  it('should initialize with all zero/empty defaults', () => {
    const state = new AgenticLoopState();
    expect(state.iterations).toBe(0);
    expect(state.overallUsage.inputTokens).toBe(0);
    expect(state.overallUsage.outputTokens).toBe(0);
    expect(state.finalStreamedText).toBe('');
    expect(state.streamedToolCalls).toEqual([]);
    expect(state.planModeActive).toBe(false);
  });

  it('should handle negative originalMessageCount — slice indexing goes wrong', () => {
    const state = new AgenticLoopState({ originalMessageCount: -5 });
    expect(state.originalMessageCount).toBe(-5);
    // This is a potential bug: array.slice(-5) would take the LAST 5 elements
    // instead of nothing. If downstream code does messages.slice(originalMessageCount),
    // it would capture wrong messages.
  });

  it('should produce correct clean display data when fragments array is empty', () => {
    const state = new AgenticLoopState();
    // Push a segment that references fragmentIndex 0, but no fragments exist
    state.displaySegments.push({ type: TYPES.TEXT, fragmentIndex: 0 });
    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();
    // Should filter out the segment because the fragment is undefined → trimmed to falsy
    expect(cleanSegments.length).toBe(0);
    expect(cleanTextFragments.length).toBe(0);
  });

  it('should produce correct clean display data when fragment is whitespace-only', () => {
    const state = new AgenticLoopState();
    state.displaySegments.push({ type: TYPES.TEXT, fragmentIndex: 0 });
    state.displayTextFragments.push('   \n\t  ');
    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();
    // Whitespace-only should be trimmed to empty → filtered out
    expect(cleanSegments.length).toBe(0);
    expect(cleanTextFragments.length).toBe(0);
  });

  it('should pass through tool segments unchanged in getCleanDisplayData', () => {
    const state = new AgenticLoopState();
    state.displaySegments.push({ type: 'tools', toolIds: ['tc-1', 'tc-2'] });
    const { cleanSegments } = state.getCleanDisplayData();
    expect(cleanSegments.length).toBe(1);
    expect(cleanSegments[0].type).toBe('tools');
    expect((cleanSegments[0] as any).toolIds).toEqual(['tc-1', 'tc-2']);
  });

  it('should handle fragmentIndex out of bounds — does not throw', () => {
    const state = new AgenticLoopState();
    state.displaySegments.push({ type: 'thinking', fragmentIndex: 999 });
    state.displayThinkingFragments.push('only one fragment');
    const { cleanSegments } = state.getCleanDisplayData();
    // fragmentIndex 999 → undefined → filtered out
    expect(cleanSegments.length).toBe(0);
  });

  it('should handle concurrent mutation of toolErrorCounts map', () => {
    const state = new AgenticLoopState();
    // Simulate rapid concurrent error tracking
    for (let index = 0; index < 100; index++) {
      const toolName = `tool_${index % 5}`;
      const currentCount = state.toolErrorCounts.get(toolName) || 0;
      state.toolErrorCounts.set(toolName, currentCount + 1);
    }
    expect(state.toolErrorCounts.get('tool_0')).toBe(20);
    expect(state.toolErrorCounts.get('tool_4')).toBe(20);
  });
});

describe('AgenticLoopState concurrent operations — idempotency', () => {
  it('should handle rapid iteration increment — no race conditions in sync code', () => {
    const state = new AgenticLoopState();
    // Simulate 100 rapid iteration increments
    for (let index = 0; index < 100; index++) {
      state.iterations++;
    }
    expect(state.iterations).toBe(100);
  });

  it('should handle high-water mark updates from multiple parallel passes', () => {
    const state = new AgenticLoopState();
    // Simulate non-monotonic token count updates (as might happen with parallel passes)
    state.hwmOutputTokens = Math.max(state.hwmOutputTokens, 100);
    state.hwmOutputTokens = Math.max(state.hwmOutputTokens, 50); // lower — should not decrease
    state.hwmOutputTokens = Math.max(state.hwmOutputTokens, 200);
    state.hwmOutputTokens = Math.max(state.hwmOutputTokens, 150); // lower — should not decrease

    expect(state.hwmOutputTokens).toBe(200);
  });
});


import { describe, it, expect, beforeEach } from "vitest";
import SemanticStallDetector from "#src/services/harnesses/lifecycle/SemanticStallDetector";
import type { ToolCall } from "#src/services/harnesses/types";

// ═══════════════════════════════════════════════════════════════
// ADVERSARIAL TESTS — SemanticStallDetector
//
// Hand-crafted edge cases designed to break the hash-based stall
// detection: argument ordering attacks, hash collision scenarios,
// threshold boundary exploitation, and state corruption.
// ═══════════════════════════════════════════════════════════════

function createToolCall(
  name: string,
  args: Record<string, unknown> = {},
): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2, 8)}`,
    name,
    args,
  };
}

describe("SemanticStallDetector adversarial — argument ordering attacks", () => {
  let detector: SemanticStallDetector;

  beforeEach(() => {
    detector = new SemanticStallDetector();
  });

  it("identical args in different insertion order should produce the same hash (stable stringify)", () => {
    // Attack: The agent calls the same tool with {a: 1, b: 2} then {b: 2, a: 1}.
    // If hashing is insertion-order-dependent, this escapes exact repeat detection.
    const callOrderA = [createToolCall("write_file", { path: "/file.ts", content: "code" })];
    const callOrderB = [createToolCall("write_file", { content: "code", path: "/file.ts" })];

    detector.recordIteration(callOrderA);
    detector.recordIteration(callOrderB);
    const verdict = detector.recordIteration(callOrderA);

    expect(verdict.isStalled).toBe(true);
    expect(verdict.stallType).toBe("exact_repeat");
  });

  it("deeply nested args in different key order should still match", () => {
    const nestedA = [createToolCall("tool", {
      config: { nested: { deep: { value: 42, flag: true } } },
    })];
    const nestedB = [createToolCall("tool", {
      config: { nested: { deep: { flag: true, value: 42 } } },
    })];

    detector.recordIteration(nestedA);
    detector.recordIteration(nestedB);
    const verdict = detector.recordIteration(nestedA);

    expect(verdict.isStalled).toBe(true);
    expect(verdict.stallType).toBe("exact_repeat");
  });

  it("args with array values should be order-sensitive (different arrays = different hash)", () => {
    const callA = [createToolCall("tool", { items: [1, 2, 3] })];
    const callB = [createToolCall("tool", { items: [3, 2, 1] })];

    // Different array order = different args = no stall
    detector.recordIteration(callA);
    detector.recordIteration(callB);
    const verdict = detector.recordIteration(callA);

    // This should NOT be exact repeat — the alternation A-B-A is cyclical
    // (if threshold is reached), but not exact consecutive
    expect(verdict.stallType).not.toBe("exact_repeat");
  });
});

describe("SemanticStallDetector adversarial — threshold boundary exploitation", () => {
  it("exactly threshold-1 repeats should NOT trigger stall", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 3 });
    const toolCalls = [createToolCall("read_file", { path: "/app.ts" })];

    detector.recordIteration(toolCalls);
    const secondVerdict = detector.recordIteration(toolCalls);

    // 2 consecutive = threshold - 1, should not stall
    expect(secondVerdict.isStalled).toBe(false);
  });

  it("exactly at threshold should trigger stall", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 3 });
    const toolCalls = [createToolCall("read_file", { path: "/app.ts" })];

    detector.recordIteration(toolCalls);
    detector.recordIteration(toolCalls);
    const thirdVerdict = detector.recordIteration(toolCalls);

    expect(thirdVerdict.isStalled).toBe(true);
    expect(thirdVerdict.consecutiveRepeats).toBe(3);
  });

  it("single non-matching iteration in the middle resets the exact repeat counter", () => {
    // Disable cyclical detection (high threshold) — we're only testing exact repeat reset
    const detector = new SemanticStallDetector({
      exactRepeatThreshold: 3,
      cyclicalThreshold: 100,
    });
    const repeated = [createToolCall("read_file", { path: "/app.ts" })];
    const different = [createToolCall("write_file", { path: "/other.ts", content: "x" })];

    // 2 repeats, then different, then 2 repeats — never hits 3 consecutive
    detector.recordIteration(repeated);
    detector.recordIteration(repeated);
    detector.recordIteration(different);
    detector.recordIteration(repeated);
    const verdict = detector.recordIteration(repeated);

    expect(verdict.isStalled).toBe(false);
  });

  it("threshold of 1 should flag on the very first iteration as stalled on the second", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 1 });
    const toolCalls = [createToolCall("tool", {})];

    // With threshold 1, even a single iteration is "1 consecutive" — but
    // the detector needs at least 2 iterations total to compare
    const firstVerdict = detector.recordIteration(toolCalls);
    expect(firstVerdict.isStalled).toBe(false); // Can't stall on first

    const secondVerdict = detector.recordIteration(toolCalls);
    // Now we have 2 consecutive, which is >= threshold of 1
    expect(secondVerdict.isStalled).toBe(true);
  });
});

describe("SemanticStallDetector adversarial — cyclical pattern attacks", () => {
  it("A-B-A-B alternation should trigger cyclical stall at threshold", () => {
    const detector = new SemanticStallDetector({
      cyclicalThreshold: 3,
      rollingWindowSize: 6,
    });

    const stateA = [createToolCall("read_file", { path: "/a.ts" })];
    const stateB = [createToolCall("write_file", { path: "/b.ts", content: "x" })];

    detector.recordIteration(stateA);
    detector.recordIteration(stateB);
    detector.recordIteration(stateA);
    detector.recordIteration(stateB);
    const verdict = detector.recordIteration(stateA);

    // A appears 3 times in window of 5 — should trigger cyclical
    expect(verdict.isStalled).toBe(true);
    expect(verdict.stallType).toBe("cyclical");
  });

  it("A-B-C-A-B-C three-state rotation should trigger cyclical stall", () => {
    const detector = new SemanticStallDetector({
      cyclicalThreshold: 2,
      rollingWindowSize: 8,
    });

    const stateA = [createToolCall("tool_a", {})];
    const stateB = [createToolCall("tool_b", {})];
    const stateC = [createToolCall("tool_c", {})];

    detector.recordIteration(stateA);
    detector.recordIteration(stateB);
    detector.recordIteration(stateC);
    detector.recordIteration(stateA);
    detector.recordIteration(stateB);
    const verdict = detector.recordIteration(stateC);

    // C appears 2 times in window — equals cyclical threshold of 2
    expect(verdict.isStalled).toBe(true);
    expect(verdict.stallType).toBe("cyclical");
  });

  it("rolling window eviction should prevent false cyclical stalls", () => {
    const detector = new SemanticStallDetector({
      cyclicalThreshold: 3,
      rollingWindowSize: 4,
    });

    const stateA = [createToolCall("tool_a", {})];
    const stateB = [createToolCall("tool_b", {})];
    const stateC = [createToolCall("tool_c", {})];
    const stateD = [createToolCall("tool_d", {})];

    // Record A, then fill window with other states to push A out
    detector.recordIteration(stateA);
    detector.recordIteration(stateB);
    detector.recordIteration(stateC);
    detector.recordIteration(stateD);

    // A has been evicted from the rolling window (size 4)
    // Now recording A again — only 1 occurrence, not 2
    const verdict = detector.recordIteration(stateA);

    expect(verdict.isStalled).toBe(false);
  });
});

describe("SemanticStallDetector adversarial — text repeat edge cases", () => {
  it("identical whitespace-heavy text should still match (normalization)", () => {
    const detector = new SemanticStallDetector({ textRepeatThreshold: 2 });

    detector.recordIteration([], "  Hello World  ");
    const verdict = detector.recordIteration([], "hello world");

    // After trim().toLowerCase() normalization, these should match
    expect(verdict.isStalled).toBe(true);
    expect(verdict.stallType).toBe("text_repeat");
  });

  it("empty string text should not trigger text repeat", () => {
    const detector = new SemanticStallDetector({ textRepeatThreshold: 2 });

    // Empty strings produce empty hashes, which should be handled
    detector.recordIteration([], "");
    const verdict = detector.recordIteration([], "");

    // Empty text hash should be falsy, so hadToolCalls=false + no textHash
    // should not enter the text repeat check
    expect(verdict.stallType).not.toBe("text_repeat");
  });

  it("whitespace-only text should normalize to empty and not trigger", () => {
    const detector = new SemanticStallDetector({ textRepeatThreshold: 2 });

    detector.recordIteration([], "   \t\n  ");
    const verdict = detector.recordIteration([], "  \n\t  ");

    // After trim(), these are empty strings
    expect(verdict.stallType).not.toBe("text_repeat");
  });

  it("tool calls present should skip text repeat check even with matching text", () => {
    const detector = new SemanticStallDetector({ textRepeatThreshold: 2 });

    const toolCalls = [createToolCall("read_file", { path: "/app.ts" })];

    // Even though text matches, hadToolCalls is true — text check is skipped
    detector.recordIteration(toolCalls, "identical text");
    const verdict = detector.recordIteration(toolCalls, "identical text");

    // Should NOT be text_repeat — may be exact_repeat if threshold reached
    expect(verdict.stallType).not.toBe("text_repeat");
  });
});

describe("SemanticStallDetector adversarial — state management", () => {
  it("reset should clear all state and allow clean re-detection", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });
    const toolCalls = [createToolCall("tool", {})];

    detector.recordIteration(toolCalls);
    detector.reset();

    // After reset, the first iteration should never stall
    const verdict = detector.recordIteration(toolCalls);
    expect(verdict.isStalled).toBe(false);
    expect(detector.historyLength).toBe(1);
  });

  it("warning escalation tracking should only increment after warning is issued", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });
    const toolCalls = [createToolCall("tool", {})];

    detector.recordIteration(toolCalls);
    const stalledVerdict = detector.recordIteration(toolCalls);
    expect(stalledVerdict.isStalled).toBe(true);

    // Stall detected but no warning issued yet
    expect(detector.postWarningStalls).toBe(0);

    // Issue warning, then stall again
    detector.markWarningIssued();
    expect(detector.hasWarningBeenIssued).toBe(true);

    detector.recordIteration(toolCalls); // Still stalling
    expect(detector.postWarningStalls).toBe(1);

    detector.recordIteration(toolCalls); // Still stalling
    expect(detector.postWarningStalls).toBe(2);
  });

  it("reset should also reset warning escalation state", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });
    const toolCalls = [createToolCall("tool", {})];

    detector.recordIteration(toolCalls);
    detector.recordIteration(toolCalls);
    detector.markWarningIssued();
    detector.recordIteration(toolCalls);

    expect(detector.hasWarningBeenIssued).toBe(true);
    expect(detector.postWarningStalls).toBe(1);

    detector.reset();

    expect(detector.hasWarningBeenIssued).toBe(false);
    expect(detector.postWarningStalls).toBe(0);
    expect(detector.historyLength).toBe(0);
  });
});

describe("SemanticStallDetector adversarial — special character tool names", () => {
  it("unicode tool names should hash correctly and detect stalls", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });
    const toolCalls = [createToolCall("búsqueda_🔧", { query: "日本語" })];

    detector.recordIteration(toolCalls);
    const verdict = detector.recordIteration(toolCalls);

    expect(verdict.isStalled).toBe(true);
    expect(verdict.repeatedTools).toContain("búsqueda_🔧");
  });

  it("tool names with slashes and dots (MCP style) should hash correctly", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });
    const toolCalls = [createToolCall("mcp__github/file.read.v2", { repo: "test" })];

    detector.recordIteration(toolCalls);
    const verdict = detector.recordIteration(toolCalls);

    expect(verdict.isStalled).toBe(true);
  });

  it("empty tool name should not crash the hasher", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });
    const toolCalls = [createToolCall("", {})];

    detector.recordIteration(toolCalls);
    const verdict = detector.recordIteration(toolCalls);

    expect(verdict.isStalled).toBe(true);
  });
});

describe("SemanticStallDetector adversarial — multi-tool sets and ordering", () => {
  it("same tools in different call order should produce the same set hash (order-independent)", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });

    const setA = [
      createToolCall("read_file", { path: "/a.ts" }),
      createToolCall("write_file", { path: "/b.ts", content: "x" }),
    ];
    const setB = [
      createToolCall("write_file", { path: "/b.ts", content: "x" }),
      createToolCall("read_file", { path: "/a.ts" }),
    ];

    detector.recordIteration(setA);
    const verdict = detector.recordIteration(setB);

    // Same tools, same args, different order — should be treated as identical set
    expect(verdict.isStalled).toBe(true);
    expect(verdict.stallType).toBe("exact_repeat");
  });

  it("empty tool call arrays should be treated as text-only iterations", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 3 });

    // No tools, no text — these are empty iterations
    detector.recordIteration([]);
    detector.recordIteration([]);
    const verdict = detector.recordIteration([]);

    // Empty tool sets all share the sentinel hash, but hadToolCalls is false
    // so it goes through the text repeat path (but textHash is undefined)
    // The result depends on whether the code routes empty iterations correctly
    expect(verdict.stallType).not.toBe("exact_repeat");
  });

  it("tool args with null and undefined values should hash deterministically", () => {
    const detector = new SemanticStallDetector({ exactRepeatThreshold: 2 });

    const callA = [createToolCall("tool", { key: null, other: undefined })];
    const callB = [createToolCall("tool", { key: null, other: undefined })];

    detector.recordIteration(callA);
    const verdict = detector.recordIteration(callB);

    expect(verdict.isStalled).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import SemanticStallDetector from "../src/services/harnesses/lifecycle/SemanticStallDetector.ts";
import type { ToolCall } from "../src/services/harnesses/types.ts";

// ═══════════════════════════════════════════════════════════════
// SemanticStallDetector — Comprehensive Test Suite
//
// Tests cover:
//   1. Exact repeat detection
//   2. Cyclical pattern detection
//   3. Text-only repeat detection
//   4. True negatives (varied tool calls, different args)
//   5. Edge cases (empty, single iteration, reset)
//   6. Warning escalation tracking
// ═══════════════════════════════════════════════════════════════

/** Helper to create a mock ToolCall with the given name and args. */
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

describe("SemanticStallDetector", () => {
  let detector: SemanticStallDetector;

  beforeEach(() => {
    detector = new SemanticStallDetector();
  });

  // ── EXACT REPEAT DETECTION ─────────────────────────────────

  describe("detects exact repeat stalls", () => {
    it("flags when same tool+args repeat for 3 consecutive iterations", () => {
      const toolCalls = [createToolCall("read_file", { path: "/src/app.ts" })];

      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("exact_repeat");
      expect(verdict.consecutiveRepeats).toBe(3);
      expect(verdict.repeatedTools).toContain("read_file");
    });

    it("flags when multiple tools repeat identically", () => {
      const toolCalls = [
        createToolCall("read_file", { path: "/src/app.ts" }),
        createToolCall("write_file", { path: "/src/output.ts", content: "x" }),
      ];

      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("exact_repeat");
      expect(verdict.repeatedTools).toContain("read_file");
      expect(verdict.repeatedTools).toContain("write_file");
    });

    it("does not flag before reaching threshold", () => {
      const toolCalls = [createToolCall("read_file", { path: "/src/app.ts" })];

      detector.recordIteration(toolCalls);
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(false);
    });

    it("detects extended exact repeats with higher count", () => {
      const toolCalls = [createToolCall("search", { query: "find bug" })];

      for (let index = 0; index < 5; index++) {
        detector.recordIteration(toolCalls);
      }
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.consecutiveRepeats).toBe(6);
    });
  });

  // ── CYCLICAL PATTERN DETECTION ─────────────────────────────

  describe("detects cyclical stalls", () => {
    it("flags A→B→A→B alternating pattern", () => {
      const customDetector = new SemanticStallDetector({
        rollingWindowSize: 8,
        cyclicalThreshold: 4,
      });

      const toolCallsA = [createToolCall("read_file", { path: "/a.ts" })];
      const toolCallsB = [createToolCall("write_file", { path: "/a.ts", content: "fix" })];

      // A B A B A B A B → A appears 4 times, B appears 4 times in 8-item window
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsB);
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsB);
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsB);
      customDetector.recordIteration(toolCallsA);
      const verdict = customDetector.recordIteration(toolCallsB);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("cyclical");
    });

    it("flags A→B→C→A→B→C cyclical pattern", () => {
      const customDetector = new SemanticStallDetector({
        rollingWindowSize: 9,
        cyclicalThreshold: 3,
      });

      const toolCallsA = [createToolCall("read_file", { path: "/a.ts" })];
      const toolCallsB = [createToolCall("lint", { file: "/a.ts" })];
      const toolCallsC = [createToolCall("write_file", { path: "/a.ts", content: "v1" })];

      // A B C A B C A → 3 occurrences of A
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsB);
      customDetector.recordIteration(toolCallsC);
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsB);
      customDetector.recordIteration(toolCallsC);
      const verdict = customDetector.recordIteration(toolCallsA);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("cyclical");
    });
  });

  // ── TEXT-ONLY REPEAT DETECTION ─────────────────────────────

  describe("detects text-only stalls", () => {
    it("flags identical text output for 3 consecutive iterations", () => {
      const identicalText = "I apologize, but I cannot complete this task.";

      detector.recordIteration([], identicalText);
      detector.recordIteration([], identicalText);
      const verdict = detector.recordIteration([], identicalText);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("text_repeat");
      expect(verdict.consecutiveRepeats).toBe(3);
    });

    it("is case-insensitive for text comparison", () => {
      detector.recordIteration([], "Cannot complete this task.");
      detector.recordIteration([], "cannot complete this task.");
      const verdict = detector.recordIteration([], "CANNOT COMPLETE THIS TASK.");

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("text_repeat");
    });

    it("does not flag different text outputs", () => {
      detector.recordIteration([], "First response about topic A");
      detector.recordIteration([], "Second response about topic B");
      const verdict = detector.recordIteration([], "Third response about topic C");

      expect(verdict.isStalled).toBe(false);
    });

    it("does not flag text stall when tool calls are present", () => {
      // Text repeat check only applies to iterations without tool calls
      const toolCalls = [createToolCall("read_file", { path: "/x.ts" })];

      detector.recordIteration(toolCalls, "Same text here");
      detector.recordIteration(toolCalls, "Same text here");
      // This is a tool call iteration, not text-only, so text repeat won't trigger
      // (it will trigger exact_repeat instead for the tool calls)
      const verdict = detector.recordIteration(toolCalls, "Same text here");

      // Should detect as exact tool repeat, not text repeat
      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("exact_repeat");
    });
  });

  // ── TRUE NEGATIVES ─────────────────────────────────────────

  describe("does not flag legitimate patterns", () => {
    it("accepts same tool with different arguments", () => {
      detector.recordIteration([createToolCall("read_file", { path: "/a.ts" })]);
      detector.recordIteration([createToolCall("read_file", { path: "/b.ts" })]);
      const verdict = detector.recordIteration([
        createToolCall("read_file", { path: "/c.ts" }),
      ]);

      expect(verdict.isStalled).toBe(false);
    });

    it("accepts varied tool sequences", () => {
      detector.recordIteration([createToolCall("read_file", { path: "/a.ts" })]);
      detector.recordIteration([
        createToolCall("write_file", { path: "/a.ts", content: "updated" }),
      ]);
      detector.recordIteration([createToolCall("run_tests", { suite: "unit" })]);
      const verdict = detector.recordIteration([
        createToolCall("read_file", { path: "/b.ts" }),
      ]);

      expect(verdict.isStalled).toBe(false);
    });

    it("accepts progressive work on different files", () => {
      for (let index = 0; index < 6; index++) {
        const verdict = detector.recordIteration([
          createToolCall("read_file", { path: `/src/file${index}.ts` }),
          createToolCall("write_file", {
            path: `/src/file${index}.ts`,
            content: `// updated ${index}`,
          }),
        ]);

        expect(verdict.isStalled).toBe(false);
      }
    });

    it("accepts argument order independence", () => {
      // Same keys but inserted in different JS object order
      // stableStringify should normalize these to the same hash
      const toolCallsA = [
        createToolCall("write_file", { content: "hello", path: "/x.ts" }),
      ];
      const toolCallsB = [
        createToolCall("write_file", { path: "/x.ts", content: "hello" }),
      ];

      detector.recordIteration(toolCallsA);
      detector.recordIteration(toolCallsB);
      const verdict = detector.recordIteration(toolCallsA);

      // These SHOULD all hash identically (stable stringify sorts keys)
      // so this correctly detects as a stall
      expect(verdict.isStalled).toBe(true);
    });

    it("does not flag on first iteration", () => {
      const verdict = detector.recordIteration([
        createToolCall("read_file", { path: "/a.ts" }),
      ]);

      expect(verdict.isStalled).toBe(false);
    });

    it("does not flag with only 2 iterations", () => {
      const toolCalls = [createToolCall("read_file", { path: "/a.ts" })];

      detector.recordIteration(toolCalls);
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(false);
    });
  });

  // ── EDGE CASES ─────────────────────────────────────────────

  describe("handles edge cases", () => {
    it("handles iterations with no tool calls and no text gracefully", () => {
      detector.recordIteration([]);
      detector.recordIteration([]);
      const verdict = detector.recordIteration([]);

      // Empty iterations (no tools, no text) don't trigger any stall check
      expect(verdict.isStalled).toBe(false);
    });

    it("reset clears all state", () => {
      const toolCalls = [createToolCall("read_file", { path: "/a.ts" })];

      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      detector.reset();

      // After reset, two more iterations shouldn't trigger (need 3 total)
      detector.recordIteration(toolCalls);
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(false);
      expect(detector.historyLength).toBe(2);
    });

    it("respects rolling window size", () => {
      const customDetector = new SemanticStallDetector({
        rollingWindowSize: 3,
      });

      const toolCallsA = [createToolCall("tool_a", {})];
      const toolCallsB = [createToolCall("tool_b", {})];

      // Fill with A, A, then switch to B, B, B
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsA);
      customDetector.recordIteration(toolCallsB);
      customDetector.recordIteration(toolCallsB);
      const verdict = customDetector.recordIteration(toolCallsB);

      // Window should only see the last 3: B, B, B — which is a stall
      expect(verdict.isStalled).toBe(true);
      expect(customDetector.historyLength).toBe(3);
    });

    it("handles tools with complex nested arguments", () => {
      const complexArgs = {
        config: {
          database: { host: "localhost", port: 5432 },
          options: ["flag1", "flag2"],
        },
        nested: { deep: { value: true } },
      };

      const toolCalls = [createToolCall("configure", complexArgs)];

      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      const verdict = detector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(true);
    });
  });

  // ── WARNING ESCALATION ─────────────────────────────────────

  describe("warning escalation tracking", () => {
    it("tracks post-warning stall count", () => {
      const toolCalls = [createToolCall("read_file", { path: "/stuck.ts" })];

      // Trigger initial stall
      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);

      expect(detector.hasWarningBeenIssued).toBe(false);

      // Mark warning as issued
      detector.markWarningIssued();
      expect(detector.hasWarningBeenIssued).toBe(true);
      expect(detector.postWarningStalls).toBe(0);

      // Continue stalling — count should increment
      detector.recordIteration(toolCalls);
      expect(detector.postWarningStalls).toBe(1);

      detector.recordIteration(toolCalls);
      expect(detector.postWarningStalls).toBe(2);
    });

    it("resets warning state on reset()", () => {
      detector.markWarningIssued();
      expect(detector.hasWarningBeenIssued).toBe(true);

      detector.reset();

      expect(detector.hasWarningBeenIssued).toBe(false);
      expect(detector.postWarningStalls).toBe(0);
    });

    it("does not increment post-warning count on clean iterations", () => {
      const toolCalls = [createToolCall("read_file", { path: "/stuck.ts" })];

      // Trigger stall and mark warning
      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      detector.recordIteration(toolCalls);
      detector.markWarningIssued();

      // Now do a different tool call — no stall
      detector.recordIteration([createToolCall("write_file", { path: "/fix.ts", content: "ok" })]);

      // Post-warning stalls should be 0 because the last iteration wasn't stalled
      expect(detector.postWarningStalls).toBe(0);
    });
  });

  // ── CUSTOM THRESHOLDS ──────────────────────────────────────

  describe("respects custom thresholds", () => {
    it("uses custom exactRepeatThreshold", () => {
      const sensitiveDetector = new SemanticStallDetector({
        exactRepeatThreshold: 2,
      });

      const toolCalls = [createToolCall("read_file", { path: "/a.ts" })];

      sensitiveDetector.recordIteration(toolCalls);
      const verdict = sensitiveDetector.recordIteration(toolCalls);

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("exact_repeat");
    });

    it("uses custom textRepeatThreshold", () => {
      const strictDetector = new SemanticStallDetector({
        textRepeatThreshold: 2,
      });

      strictDetector.recordIteration([], "Same text");
      const verdict = strictDetector.recordIteration([], "Same text");

      expect(verdict.isStalled).toBe(true);
      expect(verdict.stallType).toBe("text_repeat");
    });
  });
});

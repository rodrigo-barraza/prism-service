import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import SemanticStallDetector from "#src/services/harnesses/lifecycle/SemanticStallDetector";
import type { ToolCall } from "#src/services/harnesses/types";

// ═══════════════════════════════════════════════════════════════
// FUZZ / PROPERTY-BASED TESTS — SemanticStallDetector
//
// Verifies behavioral invariants of the stall detection system
// hold across thousands of randomized tool call sequences,
// argument shapes, and configuration combinations.
// ═══════════════════════════════════════════════════════════════

// ── Custom Arbitraries ──────────────────────────────────────────

const arbitraryToolName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }),
  fc.constantFrom(
    "read_file",
    "write_file",
    "execute_shell",
    "search_web",
    "list_directory",
    "replace_in_file",
    "mcp__github/tool.read",
  ),
);

const arbitraryArguments: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 15 }),
  fc.oneof(
    fc.string({ maxLength: 100 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
  ),
  { minKeys: 0, maxKeys: 5 },
);

const arbitraryToolCall: fc.Arbitrary<ToolCall> = fc.record({
  id: fc.string({ minLength: 5, maxLength: 15 }).map(
    (suffix) => `call_${suffix}`,
  ),
  name: arbitraryToolName,
  args: arbitraryArguments,
});

const arbitraryToolCallSet = fc.array(arbitraryToolCall, {
  minLength: 0,
  maxLength: 5,
});

const arbitraryTextContent = fc.option(
  fc.string({ minLength: 0, maxLength: 500 }),
  { nil: undefined },
);

const arbitraryDetectorOptions = fc.record({
  exactRepeatThreshold: fc.integer({ min: 1, max: 10 }),
  cyclicalThreshold: fc.integer({ min: 2, max: 10 }),
  rollingWindowSize: fc.integer({ min: 2, max: 20 }),
  textRepeatThreshold: fc.integer({ min: 1, max: 10 }),
});

// ═══════════════════════════════════════════════════════════════
// Universal Invariants
// ═══════════════════════════════════════════════════════════════

describe("SemanticStallDetector fuzz — universal invariants", () => {
  it("recordIteration never throws for any combination of inputs", () => {
    fc.assert(
      fc.property(
        arbitraryDetectorOptions,
        fc.array(
          fc.tuple(arbitraryToolCallSet, arbitraryTextContent),
          { minLength: 1, maxLength: 15 },
        ),
        (options, iterations) => {
          const detector = new SemanticStallDetector(options);

          for (const [toolCalls, textContent] of iterations) {
            const verdict = detector.recordIteration(toolCalls, textContent);

            // Verdict must always be well-formed
            expect(verdict).toBeDefined();
            expect(typeof verdict.isStalled).toBe("boolean");
            expect(verdict.stallType).toMatch(
              /^(none|exact_repeat|cyclical|text_repeat)$/,
            );
            expect(typeof verdict.consecutiveRepeats).toBe("number");
            expect(verdict.consecutiveRepeats).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("first iteration is never stalled (need at least 2 for comparison)", () => {
    fc.assert(
      fc.property(
        arbitraryDetectorOptions,
        arbitraryToolCallSet,
        arbitraryTextContent,
        (options, toolCalls, textContent) => {
          const detector = new SemanticStallDetector(options);
          const verdict = detector.recordIteration(toolCalls, textContent);
          expect(verdict.isStalled).toBe(false);
          expect(verdict.stallType).toBe("none");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("historyLength never exceeds rollingWindowSize", () => {
    fc.assert(
      fc.property(
        arbitraryDetectorOptions,
        fc.array(
          fc.tuple(arbitraryToolCallSet, arbitraryTextContent),
          { minLength: 1, maxLength: 25 },
        ),
        (options, iterations) => {
          const detector = new SemanticStallDetector(options);

          for (const [toolCalls, textContent] of iterations) {
            detector.recordIteration(toolCalls, textContent);
          }

          expect(detector.historyLength).toBeLessThanOrEqual(
            options.rollingWindowSize,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reset always returns detector to clean state", () => {
    fc.assert(
      fc.property(
        arbitraryDetectorOptions,
        fc.array(
          fc.tuple(arbitraryToolCallSet, arbitraryTextContent),
          { minLength: 1, maxLength: 10 },
        ),
        (options, iterations) => {
          const detector = new SemanticStallDetector(options);

          for (const [toolCalls, textContent] of iterations) {
            detector.recordIteration(toolCalls, textContent);
          }

          detector.markWarningIssued();
          detector.reset();

          expect(detector.historyLength).toBe(0);
          expect(detector.hasWarningBeenIssued).toBe(false);
          expect(detector.postWarningStalls).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Determinism Properties
// ═══════════════════════════════════════════════════════════════

describe("SemanticStallDetector fuzz — determinism", () => {
  it("same input sequence always produces the same verdict sequence", () => {
    fc.assert(
      fc.property(
        arbitraryDetectorOptions,
        fc.array(
          fc.tuple(arbitraryToolCallSet, arbitraryTextContent),
          { minLength: 2, maxLength: 10 },
        ),
        (options, iterations) => {
          // First run
          const detectorA = new SemanticStallDetector(options);
          const verdictsA = iterations.map(([toolCalls, textContent]) =>
            detectorA.recordIteration(toolCalls, textContent),
          );

          // Second run with identical inputs
          const detectorB = new SemanticStallDetector(options);
          const verdictsB = iterations.map(([toolCalls, textContent]) =>
            detectorB.recordIteration(toolCalls, textContent),
          );

          for (let index = 0; index < verdictsA.length; index++) {
            expect(verdictsA[index].isStalled).toBe(verdictsB[index].isStalled);
            expect(verdictsA[index].stallType).toBe(verdictsB[index].stallType);
            expect(verdictsA[index].consecutiveRepeats).toBe(
              verdictsB[index].consecutiveRepeats,
            );
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Exact Repeat Threshold Property
// ═══════════════════════════════════════════════════════════════

describe("SemanticStallDetector fuzz — exact repeat guarantee", () => {
  it("N consecutive identical iterations always trigger at threshold", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        arbitraryToolCall,
        (threshold, toolCall) => {
          // Disable cyclical detection so it doesn't fire before exact repeat
          // Set rolling window >= threshold so iterations aren't evicted
          const detector = new SemanticStallDetector({
            exactRepeatThreshold: threshold,
            cyclicalThreshold: 100,
            rollingWindowSize: threshold + 2,
          });

          const toolCalls = [toolCall];
          let finalVerdict: ReturnType<typeof detector.recordIteration> = {
            isStalled: false,
            stallType: "none",
            consecutiveRepeats: 0,
          };

          // Record exactly `threshold` identical iterations
          for (let iteration = 0; iteration < threshold; iteration++) {
            finalVerdict = detector.recordIteration(toolCalls);
          }

          expect(finalVerdict.isStalled).toBe(true);
          expect(finalVerdict.stallType).toBe("exact_repeat");
          expect(finalVerdict.consecutiveRepeats).toBe(threshold);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("threshold-1 consecutive identical iterations never trigger exact repeat", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 8 }),
        arbitraryToolCall,
        (threshold, toolCall) => {
          const detector = new SemanticStallDetector({
            exactRepeatThreshold: threshold,
            // High cyclical threshold to avoid that detection path
            cyclicalThreshold: 100,
          });

          const toolCalls = [toolCall];
          let finalVerdict: ReturnType<typeof detector.recordIteration> = {
            isStalled: false,
            stallType: "none",
            consecutiveRepeats: 0,
          };

          // Record exactly `threshold - 1` identical iterations
          for (let iteration = 0; iteration < threshold - 1; iteration++) {
            finalVerdict = detector.recordIteration(toolCalls);
          }

          expect(finalVerdict.stallType).not.toBe("exact_repeat");
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Stable Hashing Property
// ═══════════════════════════════════════════════════════════════

describe("SemanticStallDetector fuzz — stable hashing", () => {
  it("tool call ID does not affect the fingerprint (only name + args matter)", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        arbitraryArguments,
        fc.string({ minLength: 5, maxLength: 20 }),
        fc.string({ minLength: 5, maxLength: 20 }),
        (toolName, args, idA, idB) => {
          const detector = new SemanticStallDetector({
            exactRepeatThreshold: 2,
          });

          const callA: ToolCall = { id: `id_${idA}`, name: toolName, args };
          const callB: ToolCall = { id: `id_${idB}`, name: toolName, args };

          detector.recordIteration([callA]);
          const verdict = detector.recordIteration([callB]);

          // Different IDs but same name + args → same fingerprint → stall
          expect(verdict.isStalled).toBe(true);
          expect(verdict.stallType).toBe("exact_repeat");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("different tool names with identical args produce different hashes", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        arbitraryToolName.filter((name) => name.length > 0),
        arbitraryArguments,
        (nameA, nameB, args) => {
          // Skip if names happen to be equal
          fc.pre(nameA !== nameB);

          const detector = new SemanticStallDetector({
            exactRepeatThreshold: 2,
          });

          detector.recordIteration([{ id: "a", name: nameA, args }]);
          const verdict = detector.recordIteration([
            { id: "b", name: nameB, args },
          ]);

          // Different names → different hash → no exact repeat
          expect(verdict.stallType).not.toBe("exact_repeat");
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Warning Escalation Property
// ═══════════════════════════════════════════════════════════════

describe("SemanticStallDetector fuzz — warning escalation", () => {
  it("postWarningStalls is always 0 before markWarningIssued is called", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryToolCallSet, { minLength: 1, maxLength: 10 }),
        (iterationSets) => {
          const detector = new SemanticStallDetector({
            exactRepeatThreshold: 1,
          });

          for (const toolCalls of iterationSets) {
            detector.recordIteration(toolCalls);
          }

          // Never called markWarningIssued → postWarningStalls must be 0
          expect(detector.postWarningStalls).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("postWarningStalls increments monotonically with each stalled iteration after warning", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        arbitraryToolCall,
        (stalledIterations, toolCall) => {
          const detector = new SemanticStallDetector({
            exactRepeatThreshold: 2,
          });

          const toolCalls = [toolCall];

          // Pre-warm and trigger stall
          detector.recordIteration(toolCalls);
          detector.recordIteration(toolCalls);

          detector.markWarningIssued();

          let previousCount = 0;
          for (let index = 0; index < stalledIterations; index++) {
            detector.recordIteration(toolCalls);
            expect(detector.postWarningStalls).toBeGreaterThanOrEqual(
              previousCount,
            );
            previousCount = detector.postWarningStalls;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

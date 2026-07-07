import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { buildToolRetryGuidance } from "#src/services/harnesses/lifecycle/ToolRetryInterceptor";
import type { ToolCall, ToolResult } from "#src/services/harnesses/types";
import type AgenticLoopState from "#src/services/AgenticLoopState";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

// ═══════════════════════════════════════════════════════════════
// FUZZ / PROPERTY-BASED TESTS — ToolRetryInterceptor
//
// Verifies behavioral invariants of the retry guidance builder
// across thousands of randomized tool call/result combinations,
// error states, and circuit breaker thresholds.
// ═══════════════════════════════════════════════════════════════

function createState(
  toolErrorCounts?: Map<string, number>,
): AgenticLoopState {
  return {
    toolErrorCounts: toolErrorCounts ?? new Map(),
  } as AgenticLoopState;
}

// ── Custom Arbitraries ──────────────────────────────────────────

const arbitraryToolName = fc.oneof(
  fc.constantFrom(
    "read_file",
    "write_file",
    "execute_shell",
    "search_web",
    "list_directory",
    "replace_in_file",
  ),
  fc.string({ minLength: 1, maxLength: 30 }),
);

const arbitraryToolCallId = fc.oneof(
  fc.string({ minLength: 3, maxLength: 15 }).map((suffix) => `tc-${suffix}`),
  fc.constant(null as string | null),
);

const arbitraryArguments = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.oneof(
    fc.string({ maxLength: 500 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  ),
  { minKeys: 0, maxKeys: 5 },
);

const arbitraryToolCall: fc.Arbitrary<ToolCall> = fc.record({
  id: arbitraryToolCallId,
  name: arbitraryToolName,
  args: arbitraryArguments,
});

const arbitraryErrorResult = fc.oneof(
  fc.record({
    error: fc.string({ minLength: 1, maxLength: 200 }),
  }),
  fc.record({
    error: fc.string({ minLength: 1, maxLength: 200 }),
    message: fc.string({ maxLength: 100 }),
  }),
);

const arbitrarySuccessResult = fc.oneof(
  fc.record({ content: fc.string({ maxLength: 500 }) }),
  fc.record({ success: fc.constant(true) }),
  fc.constant(null),
  fc.constant(undefined),
);

const arbitraryMaxConsecutiveErrors = fc.integer({ min: 0, max: 10 });

// ═══════════════════════════════════════════════════════════════
// Universal Invariants
// ═══════════════════════════════════════════════════════════════

describe("ToolRetryInterceptor fuzz — universal invariants", () => {
  it("never throws regardless of input shape", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryToolCall, { minLength: 0, maxLength: 5 }),
        fc.array(
          fc.record({
            id: arbitraryToolCallId,
            name: arbitraryToolName,
            result: fc.oneof(
              arbitraryErrorResult,
              arbitrarySuccessResult,
              fc.anything(),
            ),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        arbitraryMaxConsecutiveErrors,
        (toolCalls, results, maxErrors) => {
          // Must never throw
          const guidance = buildToolRetryGuidance(
            toolCalls,
            results as ToolResult[],
            createState(),
            maxErrors,
          );

          // Result is always null or a well-formed message
          if (guidance !== null) {
            expect(guidance.role).toBe("system");
            expect(typeof guidance.content).toBe("string");
            expect(guidance.content!.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("empty tool calls always returns null", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: arbitraryToolCallId,
            name: arbitraryToolName,
            result: arbitraryErrorResult,
          }),
          { minLength: 0, maxLength: 5 },
        ),
        arbitraryMaxConsecutiveErrors,
        (results, maxErrors) => {
          const guidance = buildToolRetryGuidance(
            [],
            results as ToolResult[],
            createState(),
            maxErrors,
          );
          expect(guidance).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("empty results always returns null", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryToolCall, { minLength: 1, maxLength: 5 }),
        arbitraryMaxConsecutiveErrors,
        (toolCalls, maxErrors) => {
          const guidance = buildToolRetryGuidance(
            toolCalls,
            [],
            createState(),
            maxErrors,
          );
          expect(guidance).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Error Detection Property
// ═══════════════════════════════════════════════════════════════

describe("ToolRetryInterceptor fuzz — error detection", () => {
  it("matching tool call with truthy error always produces guidance (below circuit breaker)", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        fc.string({ minLength: 3, maxLength: 15 }).map(
          (suffix) => `tc-${suffix}`,
        ),
        arbitraryArguments,
        fc.string({ minLength: 1, maxLength: 200 }),
        (toolName, toolCallId, args, errorText) => {
          const toolCalls: ToolCall[] = [
            { id: toolCallId, name: toolName, args },
          ];
          const results: ToolResult[] = [
            { id: toolCallId, name: toolName, result: { error: errorText } },
          ];

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(),
            10, // High circuit breaker
          );

          expect(guidance).not.toBeNull();
          expect(guidance!.role).toBe("system");
          expect(guidance!.content).toContain(toolName);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("all-success results never produce guidance", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(arbitraryToolName, arbitraryArguments),
          { minLength: 1, maxLength: 5 },
        ),
        (toolPairs) => {
          const toolCalls = toolPairs.map(([name, args], index) => ({
            id: `tc-${index}`,
            name,
            args,
          }));
          const results = toolPairs.map(([name], index) => ({
            id: `tc-${index}`,
            name,
            result: { content: "success data" },
          }));

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(),
            10,
          );

          expect(guidance).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Circuit Breaker Property
// ═══════════════════════════════════════════════════════════════

describe("ToolRetryInterceptor fuzz — circuit breaker", () => {
  it("tool at or above maxConsecutiveErrors always excluded from guidance", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 5 }),
        (toolName, errorText, maxErrors, overshoot) => {
          const toolCalls: ToolCall[] = [
            { id: "tc-1", name: toolName, args: {} },
          ];
          const results: ToolResult[] = [
            { id: "tc-1", name: toolName, result: { error: errorText } },
          ];

          // Set error count to maxErrors + overshoot (always at or above)
          const errorCounts = new Map([
            [toolName, maxErrors + overshoot],
          ]);

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(errorCounts),
            maxErrors,
          );

          expect(guidance).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("tool below maxConsecutiveErrors always included in guidance when it has an error", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.integer({ min: 2, max: 10 }),
        (toolName, errorText, maxErrors) => {
          const toolCalls: ToolCall[] = [
            { id: "tc-1", name: toolName, args: {} },
          ];
          const results: ToolResult[] = [
            { id: "tc-1", name: toolName, result: { error: errorText } },
          ];

          // Error count is one below the limit
          const errorCounts = new Map([
            [toolName, maxErrors - 1],
          ]);

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(errorCounts),
            maxErrors,
          );

          expect(guidance).not.toBeNull();
          expect(guidance!.content).toContain(toolName);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Result Matching Property
// ═══════════════════════════════════════════════════════════════

describe("ToolRetryInterceptor fuzz — result matching", () => {
  it("ID-based match succeeds when both IDs are identical strings", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        fc.string({ minLength: 3, maxLength: 15 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (toolName, sharedId, errorText) => {
          const toolCalls: ToolCall[] = [
            { id: sharedId, name: toolName, args: {} },
          ];
          const results: ToolResult[] = [
            { id: sharedId, name: toolName, result: { error: errorText } },
          ];

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(),
            10,
          );

          expect(guidance).not.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("name fallback match only triggers when result.id is falsy", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        fc.string({ minLength: 1, maxLength: 100 }),
        (toolName, errorText) => {
          const toolCalls: ToolCall[] = [
            { id: null, name: toolName, args: {} },
          ];

          // result.id is null (falsy) → name fallback should work
          const results: ToolResult[] = [
            { id: null, name: toolName, result: { error: errorText } },
          ];

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(),
            10,
          );

          expect(guidance).not.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Output Format Property
// ═══════════════════════════════════════════════════════════════

describe("ToolRetryInterceptor fuzz — output format", () => {
  it("guidance content length is proportional to number of failed tools", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (failureCount) => {
          const toolCalls: ToolCall[] = Array.from(
            { length: failureCount },
            (_, index) => ({
              id: `tc-${index}`,
              name: `tool_${index}`,
              args: { key: "value" },
            }),
          );
          const results: ToolResult[] = Array.from(
            { length: failureCount },
            (_, index) => ({
              id: `tc-${index}`,
              name: `tool_${index}`,
              result: { error: `Error ${index}` },
            }),
          );

          const guidance = buildToolRetryGuidance(
            toolCalls,
            results,
            createState(),
            10,
          );

          expect(guidance).not.toBeNull();
          // Each failed tool adds a block; more failures = longer content
          for (let index = 0; index < failureCount; index++) {
            expect(guidance!.content).toContain(`tool_${index}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

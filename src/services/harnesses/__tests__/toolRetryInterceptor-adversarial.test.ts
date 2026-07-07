import { describe, it, expect, vi, beforeEach } from "vitest";
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
// ADVERSARIAL TESTS — ToolRetryInterceptor
//
// Hand-crafted edge cases targeting result matching logic, error
// detection bypass, circuit breaker boundary conditions, argument
// formatting exploits, and ID mismatch scenarios.
// ═══════════════════════════════════════════════════════════════

function createState(
  toolErrorCounts?: Map<string, number>,
): AgenticLoopState {
  return {
    toolErrorCounts: toolErrorCounts ?? new Map(),
  } as AgenticLoopState;
}

const MAX_CONSECUTIVE_ERRORS = 3;

describe("ToolRetryInterceptor adversarial — result matching edge cases", () => {
  it("tool call with null ID should match result by name fallback", () => {
    const toolCalls: ToolCall[] = [
      { id: null, name: "read_file", args: { path: "/test.ts" } },
    ];
    const results: ToolResult[] = [
      { id: null, name: "read_file", result: { error: "File not found" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    expect(guidance!.content).toContain("read_file");
  });

  it("tool call with undefined ID should not match result by ID", () => {
    const toolCalls: ToolCall[] = [
      { id: null, name: "read_file", args: { path: "/test.ts" } },
    ];
    const results: ToolResult[] = [
      { id: "tc-999", name: "read_file", result: { error: "File not found" } },
    ];

    // result.id is "tc-999" but toolCall.id is null — ID match fails
    // Name fallback: result.id is truthy, so !result.id is false — name match skipped
    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    // The matching logic is: result.id === toolCall.id || (!result.id && result.name === toolCall.name)
    // Since result.id is "tc-999" (truthy), name fallback is skipped → no match
    expect(guidance).toBeNull();
  });

  it("multiple tool calls with same name but different IDs should match correctly", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "read_file", args: { path: "/a.ts" } },
      { id: "tc-2", name: "read_file", args: { path: "/b.ts" } },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "read_file", result: { content: "success" } },
      { id: "tc-2", name: "read_file", result: { error: "Permission denied" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    // Should only mention the failed call (/b.ts), not the successful one
    expect(guidance!.content).toContain("/b.ts");
  });

  it("tool call with no matching result should be silently skipped", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-orphan", name: "ghost_tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-different", name: "other_tool", result: { error: "bad" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });

  it("empty tool calls array should return null", () => {
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { error: "something" } },
    ];

    const guidance = buildToolRetryGuidance(
      [],
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });

  it("empty results array should return null", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: { path: "/test.ts" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      [],
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });
});

describe("ToolRetryInterceptor adversarial — error detection edge cases", () => {
  it("result with empty string error should NOT trigger guidance (falsy)", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { error: "" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    // !!("") is false, so hasError is false
    expect(guidance).toBeNull();
  });

  it("result with error: false should NOT trigger guidance", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { error: false } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });

  it("result with error: 0 should NOT trigger guidance (falsy)", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { error: 0 } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });

  it("result with null result payload should not crash", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: null },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    // null?.error is undefined, which is falsy → no error
    expect(guidance).toBeNull();
  });

  it("result with undefined result payload should not crash", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: undefined },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });

  it("result with only 'message' field (no 'error') should NOT trigger guidance", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { message: "Something went wrong" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    // Only checks resultPayload?.error, not .message alone
    expect(guidance).toBeNull();
  });

  it("result with success: false but no error field should NOT trigger guidance", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { success: false } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });
});

describe("ToolRetryInterceptor adversarial — circuit breaker boundary", () => {
  it("tool at exactly maxConsecutiveErrors should be skipped (circuit breaker)", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "flaky_tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "flaky_tool", result: { error: "timeout" } },
    ];

    const errorCounts = new Map([["flaky_tool", MAX_CONSECUTIVE_ERRORS]]);
    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(errorCounts),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).toBeNull();
  });

  it("tool at maxConsecutiveErrors-1 should still get retry guidance", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "flaky_tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "flaky_tool", result: { error: "timeout" } },
    ];

    const errorCounts = new Map([["flaky_tool", MAX_CONSECUTIVE_ERRORS - 1]]);
    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(errorCounts),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
  });

  it("mixed: one tool at circuit breaker, another still retriable", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "broken_tool", args: {} },
      { id: "tc-2", name: "flaky_tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "broken_tool", result: { error: "permanent failure" } },
      { id: "tc-2", name: "flaky_tool", result: { error: "timeout" } },
    ];

    const errorCounts = new Map([
      ["broken_tool", MAX_CONSECUTIVE_ERRORS],
      ["flaky_tool", 1],
    ]);

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(errorCounts),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    expect(guidance!.content).toContain("flaky_tool");
    expect(guidance!.content).not.toContain("broken_tool");
  });

  it("maxConsecutiveErrors of 0 should block ALL retries", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { error: "failure" } },
    ];

    // Error count is 0, maxConsecutiveErrors is 0: 0 >= 0 is true → skipped
    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      0,
    );

    expect(guidance).toBeNull();
  });
});

describe("ToolRetryInterceptor adversarial — argument formatting", () => {
  it("extremely long argument value should be truncated", () => {
    const longValue = "x".repeat(10_000);
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "write_file", args: { content: longValue } },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "write_file", result: { error: "disk full" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    // The full 10K value should NOT appear in the guidance
    expect(guidance!.content).not.toContain(longValue);
    // But a truncated version should
    expect(guidance!.content).toContain("…");
  });

  it("empty args object should produce '(no arguments)' label", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "list_files", args: {} },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "list_files", result: { error: "access denied" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    expect(guidance!.content).toContain("(no arguments)");
  });

  it("args with special characters should not break markdown formatting", () => {
    const toolCalls: ToolCall[] = [
      {
        id: "tc-1",
        name: "execute_shell",
        args: { command: "echo `$(whoami)` && rm -rf / --no-preserve-root" },
      },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "execute_shell", result: { error: "permission denied" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    // Should not crash or produce malformed output
    expect(typeof guidance!.content).toBe("string");
    expect(guidance!.content!.length).toBeGreaterThan(0);
  });

  it("guidance message should always have role 'system'", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "tool", args: { key: "value" } },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "tool", result: { error: "oops" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    expect(guidance!.role).toBe("system");
  });
});

describe("ToolRetryInterceptor adversarial — multiple failures in single batch", () => {
  it("all tool calls failing should produce guidance mentioning all of them", () => {
    const toolCalls: ToolCall[] = [
      { id: "tc-1", name: "read_file", args: { path: "/a.ts" } },
      { id: "tc-2", name: "write_file", args: { path: "/b.ts", content: "x" } },
      { id: "tc-3", name: "search_web", args: { query: "test" } },
    ];
    const results: ToolResult[] = [
      { id: "tc-1", name: "read_file", result: { error: "not found" } },
      { id: "tc-2", name: "write_file", result: { error: "disk full" } },
      { id: "tc-3", name: "search_web", result: { error: "rate limited" } },
    ];

    const guidance = buildToolRetryGuidance(
      toolCalls,
      results,
      createState(),
      MAX_CONSECUTIVE_ERRORS,
    );

    expect(guidance).not.toBeNull();
    expect(guidance!.content).toContain("read_file");
    expect(guidance!.content).toContain("write_file");
    expect(guidance!.content).toContain("search_web");
  });
});

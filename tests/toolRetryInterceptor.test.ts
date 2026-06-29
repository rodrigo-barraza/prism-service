import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildToolRetryGuidance } from "../src/services/harnesses/lifecycle/ToolRetryInterceptor.ts";
import type { ToolCall, ToolResult } from "../src/services/harnesses/types.ts";
import type AgenticLoopState from "../src/services/AgenticLoopState.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ToolRetryInterceptor — buildToolRetryGuidance", () => {
  function createState(toolErrorCounts?: Map<string, number>): AgenticLoopState {
    return {
      toolErrorCounts: toolErrorCounts ?? new Map(),
    } as AgenticLoopState;
  }

  const MAX_CONSECUTIVE_ERRORS = 3;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("no failures — should return null", () => {
    it("should return null when all results succeed", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "read_file", args: { path: "test.ts" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "read_file", result: { content: "file data" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).toBeNull();
    });

    it("should return null when tool calls have empty results array", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "read_file", args: { path: "test.ts" } },
      ];
      const results: ToolResult[] = [];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).toBeNull();
    });

    it("should return null when there are no tool calls", () => {
      const guidance = buildToolRetryGuidance([], [], createState(), MAX_CONSECUTIVE_ERRORS);
      expect(guidance).toBeNull();
    });
  });

  describe("single tool failure", () => {
    it("should generate retry guidance for a single failed tool call", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "write_file", args: { path: "/root/test.ts", content: "test" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "write_file", result: { error: "Permission denied: /root/test.ts" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).not.toBeNull();
      expect(guidance!.role).toBe("system");
      expect(guidance!.content).toContain("[TOOL RETRY GUIDANCE]");
      expect(guidance!.content).toContain("write_file");
      expect(guidance!.content).toContain("Permission denied");
      expect(guidance!.content).toContain("path");
      expect(guidance!.content).toContain("content");
    });

    it("should include the original arguments in the guidance", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "run_command", args: { command: "npm install", cwd: "/nonexistent" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "run_command", result: { error: "No such file or directory: /nonexistent" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).toContain("`command`: npm install");
      expect(guidance!.content).toContain("`cwd`: /nonexistent");
    });

    it("should include attempt count label on consecutive failures", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "search_files", args: { pattern: "test" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "search_files", result: { error: "Index not available" } },
      ];
      const state = createState(new Map([["search_files", 2]]));

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).toContain("(attempt 2)");
    });

    it("should not include attempt label on first failure", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "search_files", args: { pattern: "test" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "search_files", result: { error: "Index error" } },
      ];
      const state = createState(new Map([["search_files", 1]]));

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).not.toContain("(attempt");
    });
  });

  describe("circuit breaker — skip tools at max consecutive errors", () => {
    it("should skip tools that have hit the circuit breaker limit", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "broken_tool", args: { input: "test" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "broken_tool", result: { error: "Always fails" } },
      ];
      const state = createState(new Map([["broken_tool", 3]]));

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).toBeNull();
    });

    it("should still generate guidance for tools below the circuit breaker limit while skipping those at limit", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "at_limit_tool", args: {} },
        { id: "tc-2", name: "below_limit_tool", args: { key: "value" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "at_limit_tool", result: { error: "Failed again" } },
        { id: "tc-2", name: "below_limit_tool", result: { error: "Also failed" } },
      ];
      const state = createState(
        new Map([
          ["at_limit_tool", 3],
          ["below_limit_tool", 1],
        ]),
      );

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).not.toBeNull();
      expect(guidance!.content).not.toContain("at_limit_tool");
      expect(guidance!.content).toContain("below_limit_tool");
      expect(guidance!.content).toContain("1 tool call(s) failed");
    });
  });

  describe("multiple failures in a single batch", () => {
    it("should include guidance for all failed tools", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "read_file", args: { path: "missing.ts" } },
        { id: "tc-2", name: "write_file", args: { path: "/readonly/file.ts", content: "x" } },
        { id: "tc-3", name: "search_files", args: { pattern: "test" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "read_file", result: { error: "File not found: missing.ts" } },
        { id: "tc-2", name: "write_file", result: { error: "Permission denied" } },
        { id: "tc-3", name: "search_files", result: { content: "found results" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).not.toBeNull();
      expect(guidance!.content).toContain("2 tool call(s) failed");
      expect(guidance!.content).toContain("read_file");
      expect(guidance!.content).toContain("write_file");
      expect(guidance!.content).not.toContain("search_files");
    });
  });

  describe("result matching — ID-based and name-based fallback", () => {
    it("should match results by ID", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-abc", name: "write_file", args: { path: "test.ts" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-abc", name: "write_file", result: { error: "Disk full" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).not.toBeNull();
      expect(guidance!.content).toContain("Disk full");
    });

    it("should fall back to name-based matching when result has no ID", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "run_command", args: { command: "test" } },
      ];
      const results: ToolResult[] = [
        { id: undefined as any, name: "run_command", result: { error: "Command not found" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance).not.toBeNull();
      expect(guidance!.content).toContain("Command not found");
    });
  });

  describe("argument formatting", () => {
    it("should truncate argument values longer than 200 characters", () => {
      const longContent = "A".repeat(500);
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "write_file", args: { path: "test.ts", content: longContent } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "write_file", result: { error: "Syntax error" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).toContain("…");
      expect(guidance!.content).not.toContain("A".repeat(500));
    });

    it("should handle empty arguments", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "list_files", args: {} },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "list_files", result: { error: "Workspace not found" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).toContain("(no arguments)");
    });

    it("should stringify non-string argument values as JSON", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "create_subagents", args: { members: [{ name: "worker" }], count: 3 } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "create_subagents", result: { error: "Invalid topology" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).toContain("`members`: [{\"name\":\"worker\"}]");
      expect(guidance!.content).toContain("`count`: 3");
    });
  });

  describe("analysis prompt inclusion", () => {
    it("should include the structured analysis questions in guidance", () => {
      const toolCalls: ToolCall[] = [
        { id: "tc-1", name: "write_file", args: { path: "test.ts" } },
      ];
      const results: ToolResult[] = [
        { id: "tc-1", name: "write_file", result: { error: "Invalid path" } },
      ];
      const state = createState();

      const guidance = buildToolRetryGuidance(toolCalls, results, state, MAX_CONSECUTIVE_ERRORS);

      expect(guidance!.content).toContain("Which specific argument(s) caused the failure");
      expect(guidance!.content).toContain("What value(s) should be corrected");
      expect(guidance!.content).toContain("prerequisite step");
      expect(guidance!.content).toContain("different approach");
    });
  });
});

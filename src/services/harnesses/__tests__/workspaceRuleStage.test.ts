/**
 * WorkspaceRuleStage (prompt 19, Landing 3): which files a batch touched,
 * and when a glob-scoped workspace rule is (not) sent. The whole-loop
 * behaviour is in hookSemantics.test.ts; these pin the edges.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import AgenticLoopState from "#src/services/AgenticLoopState";
import type { WorkspaceInstructions, WorkspaceRule } from "#src/services/instructions/WorkspaceInstructions";
import type { AgenticContext, ConversationMessage, ToolCall, ToolResult } from "../types.ts";

const discovery = vi.hoisted(() => ({ result: null as unknown, calls: 0 }));

vi.mock("#src/services/instructions/turnInstructions", () => ({
  readTurnWorkspaceInstructions: vi.fn(async () => {
    discovery.calls += 1;
    return discovery.result;
  }),
}));
vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyWorkspaceRules, touchedFiles } from "../lifecycle/WorkspaceRuleStage.ts";

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, args } as ToolCall;
}

function ok(id: string): ToolResult {
  return { id, name: "tool", result: { success: true } } as ToolResult;
}

function failedResult(id: string): ToolResult {
  return { id, name: "tool", result: { error: "File not found" } } as ToolResult;
}

function rule(overrides: Partial<WorkspaceRule> = {}): WorkspaceRule {
  return {
    path: "/ws/.claude/rules/typescript.md",
    base: "/ws",
    globs: ["src/**/*.ts"],
    content: "RULE-TS: no default exports.",
    truncated: false,
    lastModified: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function instructions(overrides: Partial<WorkspaceInstructions> = {}): WorkspaceInstructions {
  return {
    root: "/ws",
    workingDirectory: "/ws",
    directories: ["/ws"],
    files: [],
    rules: [rule()],
    skipped: [],
    ...overrides,
  };
}

const context = { options: {}, agentConversationId: "conversation-1", workspaceRoot: "/ws" } as unknown as AgenticContext;

describe("touchedFiles", () => {
  it("collects every path a successful read or edit touched, resolved against the working directory", () => {
    const files = touchedFiles(
      [
        call("1", "read_file", { absolutePath: "/ws/src/a.ts" }),
        call("2", "read_files", { files: [{ absolutePath: "/ws/src/b.ts" }, { path: "src/c.ts" }] }),
        call("3", "move_file", { source: "src/d.ts", destination: "lib/d.ts" }),
        call("4", "replace_in_file", { path: "src/missing.ts" }),
        call("5", "execute_shell", { command: "cat src/e.ts" }),
        call("6", "search_file_contents", { pattern: "x", searchPath: "/ws/src" }),
      ],
      [ok("1"), ok("2"), ok("3"), failedResult("4"), ok("5"), ok("6")],
      "/ws",
    );

    expect(files).toEqual(["/ws/src/a.ts", "/ws/src/b.ts", "/ws/src/c.ts", "/ws/src/d.ts", "/ws/lib/d.ts"]);
  });

  it("puts a path into the repository a worktree stands in for where the call really went", () => {
    const files = touchedFiles(
      [call("1", "read_file", { absolutePath: "/ws/repo/src/a.ts" }), call("2", "read_file", { absolutePath: "/elsewhere/x.ts" })],
      [ok("1"), ok("2")],
      "/tmp/prism-worktrees/task",
      { repository: "/ws/repo", worktree: "/tmp/prism-worktrees/task" },
    );

    expect(files).toEqual(["/tmp/prism-worktrees/task/src/a.ts", "/elsewhere/x.ts"]);
  });
});

describe("applyWorkspaceRules", () => {
  let state: AgenticLoopState;
  let messages: ConversationMessage[];

  beforeEach(() => {
    discovery.calls = 0;
    discovery.result = null;
    state = new AgenticLoopState({ originalMessageCount: 1 });
    messages = [{ role: "user", content: "fix it" } as ConversationMessage];
  });

  const read = (file: string): [ToolCall[], ToolResult[]] => [
    [call("r", "read_file", { absolutePath: file })],
    [ok("r")],
  ];

  it("sends a rule again once its text changed", async () => {
    state.workspaceInstructions = instructions();
    await applyWorkspaceRules(messages, context, null, state, ...read("/ws/src/a.ts"));
    await applyWorkspaceRules(messages, context, null, state, ...read("/ws/src/b.ts"));
    expect(messages.filter((message) => String(message.content).startsWith("<workspace-rules>"))).toHaveLength(1);

    state.workspaceInstructions = instructions({ rules: [rule({ content: "RULE-TS v2: named exports only." })] });
    await applyWorkspaceRules(messages, context, null, state, ...read("/ws/src/c.ts"));

    const sent = messages.filter((message) => String(message.content).startsWith("<workspace-rules>"));
    expect(sent).toHaveLength(2);
    expect(String(sent[1]!.content)).toContain("RULE-TS v2: named exports only.");
  });

  it("a sub-agent's read of its parent's checkout path fires the rule of its worktree", async () => {
    state.workspaceInstructions = instructions({
      root: "/ws",
      workingDirectory: "/tmp/prism-worktrees/task",
      directories: ["/ws", "/tmp/prism-worktrees/task"],
      rules: [rule({ path: "/tmp/prism-worktrees/task/.claude/rules/typescript.md", base: "/tmp/prism-worktrees/task" })],
      worktree: { repository: "/ws/repo", worktree: "/tmp/prism-worktrees/task" },
    });

    await applyWorkspaceRules(messages, context, null, state, ...read("/ws/repo/src/a.ts"));

    expect(messages.some((message) => String(message.content).includes("RULE-TS"))).toBe(true);
  });

  it("reads the workspace once, lazily, on a turn re-driven after a restart", async () => {
    discovery.result = instructions();
    expect(state.workspaceInstructions).toBeUndefined();

    await applyWorkspaceRules(messages, context, null, state, ...read("/ws/src/a.ts"));
    await applyWorkspaceRules(messages, context, null, state, ...read("/ws/src/b.ts"));

    expect(discovery.calls).toBe(1);
    expect(messages.some((message) => String(message.content).includes("RULE-TS"))).toBe(true);
  });

  it("reads nothing for a batch without a file read or edit, or with workspace mode off", async () => {
    await applyWorkspaceRules(messages, context, null, state, [call("s", "execute_shell", { command: "ls" })], [ok("s")]);
    expect(discovery.calls).toBe(0);

    const off = { ...context, options: { workspaceEnabled: false } } as unknown as AgenticContext;
    await applyWorkspaceRules(messages, off, null, state, ...read("/ws/src/a.ts"));
    expect(discovery.calls).toBe(0);
    expect(state.workspaceInstructions).toBeNull();
    expect(messages).toHaveLength(1);
  });

  it("never throws: a failing hook leaves the batch alone", async () => {
    state.workspaceInstructions = instructions();
    const hooks = { run: vi.fn().mockRejectedValue(new Error("hook exploded")) } as never;

    await expect(
      applyWorkspaceRules(messages, context, hooks, state, ...read("/ws/src/a.ts")),
    ).resolves.toBeUndefined();
    expect(messages.some((message) => String(message.content).includes("RULE-TS"))).toBe(true);
  });
});

/**
 * An isolated sub-agent runs in a worktree or not at all.
 *
 * Before: when tools-service could not make the worktree, the orchestrator
 * logged "Running in workspace root" and ran the sub-agent there. For a
 * repository a workspace bridge serves, tools-service always failed (it ran
 * git on its own host), so every isolated sub-agent worked in the main
 * checkouts, beside the rest of the fleet. Now only "there is no repository"
 * shares the directory; any other failure refuses the spawn, and a created
 * worktree's `repoPath` (the tree the backend branched from) is the one the
 * sub-agent's later calls use.
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  createWorktree: vi.fn(),
}));

vi.mock("#src/services/AgenticLoopService", () => ({
  default: { runAgenticLoop: (...args: unknown[]) => mocks.runAgenticLoop(...args) },
}));
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace/app"),
    createWorktree: (...args: unknown[]) => mocks.createWorktree(...args),
    removeWorktree: vi.fn().mockResolvedValue({}),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("#src/services/orchestrator/WorktreeMergeBack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/services/orchestrator/WorktreeMergeBack")>()),
  settleSubAgentWorktree: vi.fn().mockResolvedValue(undefined),
}));

import OrchestratorService from "#src/services/OrchestratorService";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";

function spawn() {
  return OrchestratorService.spawnFromTool({
    description: "Fix the parser",
    prompt: "Fix it",
    files: ["/workspace/app/src/parser.ts"],
    awaitCompletion: true,
    orchestratorContext: {
      project: "p",
      username: "u",
      agent: "CODING",
      providerName: "google",
      resolvedModel: "gemini-3.6-flash",
      traceId: null,
      agentConversationId: "parent-session",
      conversationId: "parent-conv",
      recursionDepth: 0,
      maxRecursionDepth: 2,
      workspaceRoot: "/workspace",
    } as never,
  });
}

function systemPrompt(): string {
  const [{ messages }] = mocks.runAgenticLoop.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
  return messages.find((message) => message.role === "system")?.content ?? "";
}

describe("an isolated sub-agent's worktree", () => {
  beforeEach(async () => {
    mocks.runAgenticLoop.mockReset().mockResolvedValue({ messages: [{ role: "assistant", content: "done" }] });
    mocks.createWorktree.mockReset();
    await ToolOrchestratorService.refreshSchemas();
  });
  afterEach(() => OrchestratorService.clearAllActiveSubAgents());

  it("is not started when its worktree cannot be made (a bridge offline or too old)", async () => {
    mocks.createWorktree.mockResolvedValue({ error: "Agent RPC failed: Method not found: git.worktreeCreate" });

    const result = await spawn();

    expect(result).toEqual({ error: expect.stringContaining("Sub-agent not started") });
    expect((result as { error: string }).error).toContain("git.worktreeCreate");
    expect(mocks.runAgenticLoop).not.toHaveBeenCalled();
  });

  it("still runs in the shared directory when there is no repository to isolate", async () => {
    mocks.createWorktree.mockResolvedValue({ error: "Not a git repository: /workspace/app", reason: "not-a-repository" });

    const result = await spawn();

    expect("error" in result).toBe(false);
    expect(mocks.runAgenticLoop).toHaveBeenCalledTimes(1);
    expect(systemPrompt()).toContain("Your workspace is: /workspace\n");
  });

  it("works from the tree the backend branched from, not the path it was given", async () => {
    // The bridge branched from the parent's own worktree, as `files` suggested
    mocks.createWorktree.mockResolvedValue({
      worktreePath: "/workspace/app/.claude/worktrees/orchestrator_agent-1",
      branch: "orchestrator/agent-1",
      repoPath: "/workspace/app/.claude/worktrees/parent-task",
    });

    await spawn();

    expect(systemPrompt()).toContain(
      "Your workspace is: /workspace/app/.claude/worktrees/orchestrator_agent-1, your own checkout of /workspace/app/.claude/worktrees/parent-task.",
    );
  });
});

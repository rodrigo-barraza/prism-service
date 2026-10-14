/**
 * A bridge never merges a sub-agent's branch into a protected branch
 * (master, main: workspace-service GitWorktreeHandler) — the batch is what
 * moves those. The merge-back reads that refusal as work kept on its
 * branch, with the worktree left standing, never as merged.
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";

const helper = vi.hoisted(() => ({
  commitWorktree: vi.fn(),
  getWorktreeDiff: vi.fn(),
  mergeWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({ GitWorktreeHelper: helper }));

import { isMergeBackKept, settleSubAgentWorktree } from "#src/services/orchestrator/WorktreeMergeBack";
import type { SubAgentState } from "#src/types/orchestrator";

function isolatedSubAgent(): SubAgentState {
  return {
    agentId: "agent-1",
    description: "Fix the parser",
    isolated: true,
    worktreePath: "/workspace/app/.claude/worktrees/orchestrator_agent-1",
    branchName: "orchestrator/agent-1",
    repositoryPath: "/workspace/app",
    subAgentConversationId: "sub-conv",
  } as unknown as SubAgentState;
}

describe("merge-back into a protected branch", () => {
  beforeEach(() => {
    helper.commitWorktree.mockReset().mockResolvedValue({ branch: "orchestrator/agent-1", committed: true });
    helper.getWorktreeDiff.mockReset().mockResolvedValue({
      branch: "orchestrator/agent-1",
      base: "master",
      files: [{ path: "src/parser.ts", status: "modified" }],
      patch: "",
      stats: { filesChanged: 1, additions: 1, deletions: 1 },
    });
    helper.mergeWorktree.mockReset().mockResolvedValue({
      error: "Not merging 'orchestrator/agent-1' into master: sub-agent work never lands on a protected branch.",
      reason: "protected-branch",
      into: "master",
    });
    helper.removeWorktree.mockReset().mockResolvedValue({ removed: "x", branchDeleted: true });
  });

  it("keeps the work on its branch, and the worktree, as failed (not a conflict)", async () => {
    const subAgent = isolatedSubAgent();
    const report = await settleSubAgentWorktree(subAgent, { defer: false });

    expect(report?.status).toBe("failed");
    expect(isMergeBackKept(report ?? undefined)).toBe(true);
    expect(report?.error).toContain("protected branch");
    expect(report?.worktreePath).toBe("/workspace/app/.claude/worktrees/orchestrator_agent-1");
    expect(helper.removeWorktree).not.toHaveBeenCalled();
    expect(subAgent.isolated).toBe(true);
  });

  it("still calls a real clash a conflict", async () => {
    helper.mergeWorktree.mockResolvedValue({ error: "conflicts in a.ts", reason: "conflict", conflictingFiles: ["a.ts"] });
    const report = await settleSubAgentWorktree(isolatedSubAgent(), { defer: false });
    expect(report?.status).toBe("conflict");
    expect(report?.conflictingFiles).toEqual(["a.ts"]);
  });
});

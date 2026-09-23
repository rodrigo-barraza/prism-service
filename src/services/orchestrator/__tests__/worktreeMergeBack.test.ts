import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PROVIDERS } from "#src/constants";
import type {
  MergeBackReport,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "#src/types/orchestrator";

vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    mergeWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    log: vi.fn(),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({ generateText: mockGenerateText })),
  providers: {},
}));

import { GitWorktreeHelper } from "#src/services/orchestrator/GitWorktreeHelper";
import {
  mergeBackAllDeferred,
  mergeDeferredKeepingWorktree,
  settleCompetingWorktrees,
} from "#src/services/orchestrator/WorktreeMergeBack";
import { CriticLoopRouter } from "#src/services/orchestrator/routers/CriticLoopRouter";
import { MCTSRouter } from "#src/services/orchestrator/routers/MCTSRouter";
import { parseTournamentWinner } from "#src/services/orchestrator/routers/TournamentRouter";

const merge = GitWorktreeHelper.mergeWorktree as Mock;
const remove = GitWorktreeHelper.removeWorktree as Mock;

function deferred(agentId: string): MergeBackReport {
  return {
    status: "deferred",
    branch: `orchestrator/${agentId}`,
    repositoryPath: "/workspace",
    worktreePath: `/tmp/prism-worktrees/${agentId}`,
    branchDeleted: false,
  };
}

function result(agentId: string, text: string, mergeBack?: MergeBackReport): SubAgentResult {
  return {
    agent_id: agentId,
    description: agentId,
    status: "completed",
    summary: "Done",
    result: text,
    toolUses: 1,
    iterations: 1,
    durationMilliseconds: 10,
    diff: { additions: 1, deletions: 0, files: [`${agentId}.txt`] },
    ...(mergeBack && { mergeBack }),
  };
}

const context: OrchestratorContext = {
  project: "test-project",
  username: "test-user",
  agent: "CODING",
  providerName: PROVIDERS.GOOGLE,
  resolvedModel: "gemini-3.5-flash",
  traceId: "trace",
  agentConversationId: "session",
  conversationId: "conv",
  emit: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  merge.mockResolvedValue({ merged: "x", into: "main" });
  // A branch with work HEAD lacks is refused unless it was merged (safe delete).
  remove.mockImplementation(async (_repo: string, worktreePath: string, options?: { deleteBranch?: boolean }) =>
    options?.deleteBranch === false
      ? { removed: worktreePath, branchDeleted: false }
      : { removed: worktreePath, branchDeleted: true },
  );
});

describe("settling deferred worktrees", () => {
  it("competing: merges the winner, retires the loser keeping its branch when it holds work", async () => {
    remove.mockImplementation(async (_repo: string, worktreePath: string, options?: { deleteBranch?: boolean }) => {
      if (worktreePath.endsWith("loser") && options?.deleteBranch !== false) {
        return { error: "has commits that main does not contain", kept: true };
      }
      return { removed: worktreePath, branchDeleted: options?.deleteBranch !== false };
    });
    const winner = result("winner", "w", deferred("winner"));
    const loser = result("loser", "l", deferred("loser"));

    await settleCompetingWorktrees([loser, winner], "winner");

    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith("/workspace", "orchestrator/winner", expect.any(String));
    expect(winner.mergeBack).toMatchObject({ status: "merged", worktreePath: null, branchDeleted: true });
    expect(remove).toHaveBeenCalledWith("/workspace", "/tmp/prism-worktrees/loser", { deleteBranch: false });
    expect(loser.mergeBack).toMatchObject({ status: "not-selected", worktreePath: null, branchDeleted: false });
    for (const call of remove.mock.calls) expect(call[2]?.force).toBeUndefined();
  });

  it("competing with no winner: nothing merges, nothing is lost", async () => {
    const first = result("a", "a", deferred("a"));
    const second = result("b", "b", deferred("b"));

    await settleCompetingWorktrees([first, second], null);

    expect(merge).not.toHaveBeenCalled();
    expect(first.mergeBack?.status).toBe("not-selected");
    expect(second.mergeBack?.status).toBe("not-selected");
  });

  it("a continued agent's turns share one report: settled once, from its latest turn", async () => {
    const report = deferred("actor");
    const turnOne = result("actor", "v1", report);
    const turnTwo = result("actor", "v2", report);

    await mergeBackAllDeferred([turnOne, turnTwo]);

    expect(merge).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(turnOne.mergeBack).toBe(turnTwo.mergeBack);
    expect(turnTwo.mergeBack?.status).toBe("merged");
  });

  it("peer-to-peer turn merge keeps the worktree for the next turn", async () => {
    const turn = result("speaker", "said", deferred("speaker"));

    await mergeDeferredKeepingWorktree(turn);

    expect(merge).toHaveBeenCalledWith("/workspace", "orchestrator/speaker", expect.any(String));
    expect(remove).not.toHaveBeenCalled();
    expect(turn.mergeBack).toMatchObject({ status: "deferred", worktreePath: "/tmp/prism-worktrees/speaker" });
  });

  it("a refused merge keeps worktree and branch and names the files", async () => {
    merge.mockResolvedValueOnce({ error: "conflicts in a.txt", reason: "conflict", conflictingFiles: ["a.txt"] });
    const turn = result("speaker", "said", deferred("speaker"));

    await mergeBackAllDeferred([turn]);

    expect(remove).not.toHaveBeenCalled();
    expect(turn.mergeBack).toMatchObject({
      status: "conflict",
      worktreePath: "/tmp/prism-worktrees/speaker",
      conflictingFiles: ["a.txt"],
    });
  });
});

describe("tournament judge parsing", () => {
  const members = [result("a", "a"), { error: "boom" }, result("c", "c")];

  it.each([
    ["**Winner:** Sub-Agent #3", "c"],
    ["**Winner:** Sub-agent #1\n**Reason:** fine", "a"],
    ["Winner: Sub-Agent # 3", "c"],
  ])("%j → %s", (text, expected) => {
    expect(parseTournamentWinner(text, members)).toBe(expected);
  });

  it.each([["**Winner:** Sub-Agent #2"], ["**Winner:** Sub-Agent #9"], ["no verdict"]])(
    "%j names no completed candidate → null",
    (text) => {
      expect(parseTournamentWinner(text, members)).toBeNull();
    },
  );
});

describe("critic loop settles its actors' worktrees", () => {
  let spawn: Mock<(assignment: OrchestratorSpawnParams) => Promise<SubAgentResult | { error: string }>>;

  beforeEach(() => {
    spawn = vi.fn();
  });

  it("council: the single actor's work merges back when the loop ends", async () => {
    spawn
      .mockResolvedValueOnce(result("actor", "code", deferred("actor")))
      .mockResolvedValueOnce(result("critic", "PASS — looks right"));

    await new CriticLoopRouter().execute(
      "team",
      [
        { description: "Actor", prompt: "Write code" },
        { description: "Critic", prompt: "Review code" },
      ],
      context,
      spawn,
      vi.fn(),
      { maxRounds: 1 },
    );

    expect(spawn.mock.calls[0][0].preserveWorktree).toBe(true);
    expect(merge).toHaveBeenCalledWith("/workspace", "orchestrator/actor", expect.any(String));
  });

  it("jury: only the jury's pick merges; the other actor keeps its branch", async () => {
    remove.mockImplementation(async (_repo: string, worktreePath: string, options?: { deleteBranch?: boolean }) =>
      worktreePath.endsWith("actor-1") && options?.deleteBranch !== false
        ? { error: "has commits that main does not contain", kept: true }
        : { removed: worktreePath, branchDeleted: options?.deleteBranch !== false },
    );
    spawn
      .mockResolvedValueOnce(result("actor-1", "one", deferred("actor-1")))
      .mockResolvedValueOnce(result("actor-2", "two", deferred("actor-2")));
    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify({ bestActorIndex: 1, verdict: "PASS", feedback: "" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    const results = await new CriticLoopRouter().execute(
      "team",
      [
        { description: "Actor", prompt: "Write code" },
        { description: "Actor", prompt: "Write code" },
      ],
      context,
      spawn,
      vi.fn(),
      { actorCount: 2, maxRounds: 1 },
    );

    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith("/workspace", "orchestrator/actor-2", expect.any(String));
    const actorOne = results.find((r) => !("error" in r) && r.agent_id === "actor-1") as SubAgentResult;
    expect(actorOne.mergeBack).toMatchObject({ status: "not-selected", worktreePath: null, branchDeleted: false });
  });
});

describe("MCTS settles its nodes' worktrees", () => {
  it("defers every node and merges only the best-scoring one", async () => {
    let nodeCount = 0;
    const spawn = vi.fn(async () => {
      nodeCount += 1;
      return result(`node-${nodeCount}`, `attempt ${nodeCount}`, deferred(`node-${nodeCount}`));
    });
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({ scores: [0.2, 0.9], bestBranchIndex: 1, isComplete: true, feedback: "" }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await new MCTSRouter().execute(
      "team",
      [{ description: "Solve", prompt: "Solve it" }],
      context,
      spawn,
      vi.fn(),
      { branchFactor: 2, maxDepth: 1, searchIterations: 1 },
    );

    for (const call of spawn.mock.calls as unknown as [OrchestratorSpawnParams][]) {
      expect(call[0].preserveWorktree).toBe(true);
    }
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith("/workspace", "orchestrator/node-2", expect.any(String));
  });
});

/**
 * Sub-agent worktree merge-back, end to end through the REAL OrchestratorService,
 * GitWorktreeHelper and WorktreeMergeBack. Only tools-service's HTTP and the
 * agentic loop are mocked; the diff endpoint answers with the contract fixture
 * tools-service's own test produces from a real git repo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS } from "#src/constants";

const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

import OrchestratorService from "#src/services/OrchestratorService";
import { getProvider } from "#src/providers/index";
import type { OrchestratorContext, SubAgentResult } from "#src/types/orchestrator";

/**
 * The SAME bytes as tools-service/tests/fixtures/worktree-diff-contract.json,
 * whose test builds that response from a real repo and pins this same hash.
 */
const CONTRACT_FIXTURE = join(import.meta.dirname, "fixtures", "worktree-diff-contract.json");
const CONTRACT_FIXTURE_SHA256 =
  "8d3de76a47c14c60b26c8b4176a6c0262f7d1f0014f232f3a36a2ac74c10460d";
const contractDiff = JSON.parse(readFileSync(CONTRACT_FIXTURE, "utf8"));

const TOOLS = "http://localhost:5590";
const REPOSITORY = "/workspace/repo";

interface ToolsCall {
  path: string;
  body: Record<string, unknown>;
}

type ToolsReply = { status?: number; body: Record<string, unknown> };

/** tools-service stand-in: records every call, answers per endpoint. */
function installToolsService(overrides: Record<string, (body: Record<string, unknown>) => ToolsReply> = {}) {
  const calls: ToolsCall[] = [];
  let worktreeCount = 0;
  const defaults: Record<string, (body: Record<string, unknown>) => ToolsReply> = {
    "/agentic/git/worktree/create": () => {
      worktreeCount += 1;
      // What tools-service CREATED — prism must use this, not its own name.
      return {
        body: {
          worktreePath: `/tmp/prism-worktrees/wt-${worktreeCount}`,
          branch: worktreeCount === 1 ? "orchestrator/agent-contract" : `orchestrator/created-${worktreeCount}`,
          repoPath: REPOSITORY,
        },
      };
    },
    "/agentic/git/worktree/commit": () => ({ body: { branch: "x", committed: true, commit: "abc123" } }),
    "/agentic/git/worktree/diff": (body) => ({ body: { ...contractDiff, branch: body.branch } }),
    "/agentic/git/worktree/merge": (body) => ({ body: { merged: body.branch, into: "main", output: "Merge made by the 'ort' strategy." } }),
    "/agentic/git/worktree/remove": (body) => ({ body: { removed: body.worktreePath, branch: "x", branchDeleted: body.deleteBranch !== false } }),
  };
  const handlers = { ...defaults, ...overrides };
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (!href.startsWith(TOOLS)) throw new Error(`unexpected fetch ${href}`);
    const path = href.slice(TOOLS.length);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ path, body });
    const handler = handlers[path];
    const reply = handler ? handler(body) : { status: 404, body: { error: `no route ${path}` } };
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      statusText: String(status),
      json: async () => reply.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  const pathsCalled = () => calls.map((call) => call.path.replace("/agentic/git/worktree/", ""));
  return { calls, pathsCalled };
}

function context(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3-flash-preview",
    traceId: "trace-merge-back",
    agentConversationId: "session-merge-back",
    conversationId: "conv-merge-back",
    workspaceRoot: REPOSITORY,
    emit: vi.fn(),
    ...overrides,
  };
}

async function spawnOne(orchestratorContext = context()) {
  return (await OrchestratorService.spawnFromTool({
    description: "Write notes/hello.txt",
    prompt: "Create notes/hello.txt",
    files: [],
    orchestratorContext,
    awaitCompletion: true,
  })) as SubAgentResult;
}

beforeEach(() => {
  OrchestratorService.cleanupConversation("conv-merge-back");
  mockRunAgenticLoop.mockReset();
  mockRunAgenticLoop.mockResolvedValue({
    messages: [{ role: "assistant", content: "Created notes/hello.txt" }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sub-agent worktree merge-back (contract fixture, tools-service HTTP mocked)", () => {
  it("the fixture is the one tools-service pins (same bytes, same hash)", () => {
    const digest = createHash("sha256").update(readFileSync(CONTRACT_FIXTURE)).digest("hex");
    expect(digest).toBe(CONTRACT_FIXTURE_SHA256);
  });

  it("merges a changed file back with the branch tools-service created, and deletes it only afterwards", async () => {
    const tools = installToolsService();

    const result = await spawnOne();

    const diffCall = tools.calls.find((call) => call.path.endsWith("/diff"))!;
    const mergeCall = tools.calls.find((call) => call.path.endsWith("/merge"));
    const removeCall = tools.calls.find((call) => call.path.endsWith("/remove"));
    // The name tools-service returned — not a recomputed `orchestrator/<agentId>`.
    expect(diffCall.body.branch).toBe("orchestrator/agent-contract");
    expect(mergeCall?.body).toMatchObject({ path: REPOSITORY, branch: "orchestrator/agent-contract" });
    // Cleanup only after the merge, and never forced.
    expect(tools.pathsCalled()).toEqual(["create", "commit", "diff", "merge", "remove"]);
    expect(removeCall?.body.force).toBeUndefined();

    expect(result.diff).toEqual({
      additions: 2,
      deletions: 2,
      files: ["change.txt", "notes/hello.txt", "remove.txt"],
    });
    expect(result.mergeBack).toMatchObject({
      status: "merged",
      branch: "orchestrator/agent-contract",
      worktreePath: null,
      branchDeleted: true,
    });
  });

  it("commits through tools-service's git route (argv), never a shelled `git commit -m \"<description>\"`", async () => {
    const tools = installToolsService();

    await spawnOne();

    expect(tools.calls.some((call) => call.path === "/agentic/command/run")).toBe(false);
    const commitCall = tools.calls.find((call) => call.path.endsWith("/commit"))!;
    expect(commitCall.body).toMatchObject({
      path: REPOSITORY,
      worktreePath: "/tmp/prism-worktrees/wt-1",
    });
    expect(String(commitCall.body.message)).toContain("Write notes/hello.txt");
  });

  it("an empty diff merges nothing and cleans up", async () => {
    const tools = installToolsService({
      "/agentic/git/worktree/diff": (body) => ({
        body: { ...contractDiff, branch: body.branch, files: [], patch: "", stats: { filesChanged: 0, additions: 0, deletions: 0 } },
      }),
    });

    const result = await spawnOne();

    expect(tools.pathsCalled()).toEqual(["create", "commit", "diff", "remove"]);
    expect(result.diff).toBeUndefined();
    expect(result.mergeBack).toMatchObject({ status: "no-changes", worktreePath: null });
  });

  it("a merge conflict keeps worktree and branch, and reports path, branch and files to the parent", async () => {
    const tools = installToolsService({
      "/agentic/git/worktree/merge": (body) => ({
        status: 400,
        body: {
          error: `Merging '${body.branch}' into main conflicts in change.txt. The merge was aborted; main is unchanged.`,
          reason: "conflict",
          conflictingFiles: ["change.txt"],
        },
      }),
    });
    const orchestratorContext = context();

    const result = await spawnOne(orchestratorContext);

    expect(tools.pathsCalled()).toEqual(["create", "commit", "diff", "merge"]);
    expect(result.mergeBack).toMatchObject({
      status: "conflict",
      branch: "orchestrator/agent-contract",
      repositoryPath: REPOSITORY,
      worktreePath: "/tmp/prism-worktrees/wt-1",
      branchDeleted: false,
      conflictingFiles: ["change.txt"],
    });
    expect(orchestratorContext.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sub_agent_status",
        message: "merge_back",
        mergeBack: expect.objectContaining({
          status: "conflict",
          worktreePath: "/tmp/prism-worktrees/wt-1",
          conflictingFiles: ["change.txt"],
        }),
      }),
    );
  });

  it("the parent's completion notification names the kept branch, worktree and files", async () => {
    installToolsService({
      "/agentic/git/worktree/merge": () => ({
        status: 400,
        body: { error: "conflicts in change.txt", reason: "conflict", conflictingFiles: ["change.txt"] },
      }),
    });
    const result = await spawnOne();
    const send = vi
      .spyOn(OrchestratorService, "_sendParentCompletionNotification")
      .mockResolvedValue(undefined);

    await OrchestratorService._notifyParentOfRouterCompletion("team", "hierarchical", [result], context());

    const body = send.mock.calls[0][0].resultBody;
    expect(body).toContain("NOT merged");
    expect(body).toContain("orchestrator/agent-contract");
    expect(body).toContain("/tmp/prism-worktrees/wt-1");
    expect(body).toContain("change.txt");
    send.mockRestore();
  });

  it("a diff outside the contract (an older tools-service) neither merges nor removes", async () => {
    const tools = installToolsService({
      "/agentic/git/worktree/diff": () => ({
        body: { branch: "x", baseBranch: "main", hasChanges: true, additions: 2, deletions: 2, diff: "…" },
      }),
    });

    const result = await spawnOne();

    expect(tools.pathsCalled()).toEqual(["create", "commit", "diff"]);
    expect(result.mergeBack).toMatchObject({ status: "failed", worktreePath: "/tmp/prism-worktrees/wt-1" });
  });

  it("when tools-service refuses the removal (it would lose work) the report keeps pointing at the worktree", async () => {
    installToolsService({
      "/agentic/git/worktree/remove": () => ({
        status: 400,
        body: { error: "Branch 'orchestrator/agent-contract' has commits that main does not contain", kept: true },
      }),
    });

    const result = await spawnOne();

    expect(result.mergeBack).toMatchObject({
      status: "merged",
      worktreePath: "/tmp/prism-worktrees/wt-1",
      branchDeleted: false,
    });
    expect(result.mergeBack?.error).toMatch(/kept the worktree/);
  });

  it("stopping a sub-agent never forces its worktree away", async () => {
    const tools = installToolsService();
    let releaseLoop: () => void = () => {};
    mockRunAgenticLoop.mockImplementation(
      () => new Promise((resolve) => (releaseLoop = () => resolve({ messages: [] }))),
    );
    const orchestratorContext = context();
    const running = OrchestratorService.spawnFromTool({
      description: "long job",
      prompt: "work",
      files: [],
      orchestratorContext,
      awaitCompletion: false,
    }) as Promise<SubAgentResult>;
    const { agent_id: agentId } = await running;

    await OrchestratorService.stopAgent(agentId);
    releaseLoop();

    const removeCalls = tools.calls.filter((call) => call.path.endsWith("/remove"));
    expect(removeCalls.length).toBeGreaterThan(0);
    for (const call of removeCalls) expect(call.body.force).toBeUndefined();
  });
});

describe("tournament topology receives the real diff", () => {
  it("verifies candidates that changed files, merges only the judge's pick, keeps the loser's branch", async () => {
    const tools = installToolsService({
      "/agentic/git/worktree/remove": (body) =>
        // The loser has commits HEAD lacks: a safe delete is refused.
        body.worktreePath === "/tmp/prism-worktrees/wt-1" && body.deleteBranch !== false
          ? { status: 400, body: { error: "has commits that main does not contain", kept: true } }
          : { body: { removed: body.worktreePath, branchDeleted: body.deleteBranch !== false } },
    });
    mockRunAgenticLoop.mockImplementation(async (options: { messages?: { content?: unknown }[] }) => {
      const prompt = JSON.stringify(options.messages ?? []);
      return {
        messages: [
          {
            role: "assistant",
            content: prompt.includes("verification agent")
              ? '[{"command":"tsc --noEmit","pass":true,"output":""},{"command":"npm test","pass":true,"output":""}]'
              : "Implemented it.",
          },
        ],
      };
    });
    // The judge (setup.ts mocks the provider registry).
    const judge = vi.fn().mockResolvedValue({
      text: "**Winner:** Sub-Agent #2\n**Justification:** cleaner.\n\n**Selected Output:**\nImplemented it.",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    vi.mocked(getProvider).mockImplementation(
      () => ({ generateText: judge }) as unknown as ReturnType<typeof getProvider>,
    );

    const results = (await OrchestratorService.createTeam(
      {
        name: "bon",
        topology: "tournament",
        topologyConfig: { enableVerification: true },
        members: [
          { description: "Candidate A", prompt: "Implement it" },
          { description: "Candidate B", prompt: "Implement it" },
        ],
      },
      // Depth 1 = blocking dispatch, so the router's results come back here.
      context({ recursionDepth: 1, maxRecursionDepth: 3 }),
    )) as SubAgentResult[];

    const [candidateA, candidateB] = results;
    // The router saw the contract's numbers, so verification was not skipped
    // as "(no file changes)": a verifier ran for each candidate.
    expect(candidateA.diff).toMatchObject({ additions: 2, deletions: 2 });
    expect(mockRunAgenticLoop.mock.calls.filter((call) =>
      JSON.stringify(call[0].messages ?? []).includes("verification agent"),
    )).toHaveLength(2);

    expect(judge).toHaveBeenCalledOnce();
    // Only candidate B (judge's #2) merged.
    const merges = tools.calls.filter((call) => call.path.endsWith("/merge"));
    expect(merges.map((call) => call.body.branch)).toEqual([candidateB.mergeBack!.branch]);
    expect(candidateB.mergeBack).toMatchObject({ status: "merged", worktreePath: null });
    // Candidate A lost: worktree removed, branch (with its work) kept.
    expect(candidateA.mergeBack).toMatchObject({ status: "not-selected", worktreePath: null, branchDeleted: false });
    // Nothing is ever forced.
    for (const call of tools.calls.filter((c) => c.path.endsWith("/remove"))) {
      expect(call.body.force).toBeUndefined();
    }
  });
});

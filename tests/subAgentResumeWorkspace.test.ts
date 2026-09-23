/**
 * Prompt 17, Landing 2 — a resumed sub-agent is told where it now works.
 *
 * A sub-agent's isolated worktree is merged back and removed when its run
 * ends; a resume (e.g. of a `partial` result) runs in the parent's
 * workspace. Its operational context said "Your workspace is: null", and the
 * model — whose transcript names the removed worktree — read paths that no
 * longer exist (seen live: "File not found: /tmp/prism-worktrees/…").
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));
const OLD_WORKTREE = "/tmp/prism-worktrees/orchestrator_agent-old";
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn((root?: string) => root || "/workspace"),
    resolveRepositoryPath: vi.fn((root: string) => root),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/tmp/prism-worktrees/orchestrator_agent-old", branch: "orchestrator_agent-old" }),
    commitWorktree: vi.fn().mockResolvedValue({ committed: false }),
    getWorktreeDiff: vi.fn().mockResolvedValue({
      branch: "orchestrator_agent-old",
      base: "main",
      files: [],
      patch: "",
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
    }),
    mergeWorktree: vi.fn().mockResolvedValue({ merged: "orchestrator_agent-old", into: "main" }),
    removeWorktree: vi.fn().mockResolvedValue({ branchDeleted: true }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("#src/routes/ChatRoutes", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/routes/ChatRoutes")>();
  return { ...original, handleAgent: vi.fn().mockResolvedValue(undefined) };
});

import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import OrchestratorService from "#src/services/OrchestratorService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";

function toolContext(workspaceRoot: string) {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    agentConversationId: "parent-session",
    conversationId: "parent-conversation",
    workspaceRoot,
    _providerName: PROVIDERS.GOOGLE,
    _resolvedModel: "gemini-3-flash-preview",
    enabledTools: ["read_file"],
    _recursionDepth: 0,
    _maxRecursionDepth: 2,
    _autoApprove: true,
  };
}

function operationalContextOf(call: unknown[]): string {
  const { messages } = call[0] as { messages: Array<{ role: string; content: unknown }> };
  const contexts = messages.filter(
    (message) => typeof message.content === "string" && message.content.includes("<operational-context>"),
  );
  return String(contexts[contexts.length - 1]?.content ?? "");
}

describe("a resumed sub-agent whose worktree was merged back", () => {
  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(async (context: { messages: unknown[] }) => ({
      messages: [...context.messages, { role: "assistant", content: "done" }],
    }));
    OrchestratorService.clearAllActiveSubAgents();
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => ({ findOne: vi.fn().mockResolvedValue(null) }),
    } as never);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    OrchestratorService.clearAllActiveSubAgents();
  });

  it("is told its real workspace and that the old worktree is gone — not 'null'", async () => {
    // A configured, existing workspace root (the operational context only
    // names a workspace when one is set up).
    const [workspaceRoot] = ToolOrchestratorService.getWorkspaceRoots();
    expect(workspaceRoot).toBeTruthy();

    await ToolOrchestratorService.executeTool(
      "create_subagent",
      { description: "Read it", prompt: "Read the notes." },
      toolContext(workspaceRoot),
    );
    const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
    await vi.waitFor(() => expect(subAgent.status).toBe("complete"));
    expect(operationalContextOf(mockRunAgenticLoop.mock.calls[0])).toContain(`Your workspace is: ${OLD_WORKTREE}`);
    expect(subAgent.worktreePath).toBeNull(); // merged back and removed

    await ToolOrchestratorService.executeTool(
      "resume_subagent",
      { agent_id: subAgent.agentId, prompt: "Now the last note." },
      toolContext(workspaceRoot),
    );
    await vi.waitFor(() => expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2));
    const resumedContext = operationalContextOf(mockRunAgenticLoop.mock.calls[1]);
    expect(resumedContext).not.toContain("Your workspace is: null");
    expect(resumedContext).toContain(`Your workspace is: ${workspaceRoot}`);
    expect(resumedContext).toContain(`Your previous run's workspace (${OLD_WORKTREE}) no longer exists`);
  });
});

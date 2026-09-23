import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, SYSTEM_STATUSES } from "#src/constants";
import OrchestratorService from "#src/services/OrchestratorService";
import type { SubAgentState } from "#src/types/orchestrator";
import { GitWorktreeHelper } from "#src/services/orchestrator/GitWorktreeHelper";
import AgenticLoopService from "#src/services/AgenticLoopService";
import MongoWrapper from "#src/wrappers/MongoWrapper";

// Mock dependencies to avoid actual loop execution and worktree creation
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: vi.fn().mockResolvedValue({
      messages: [{ role: "assistant", content: "Resumed output" }],
    }),
  },
}));

vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    removeWorktree: vi.fn().mockResolvedValue({ branchDeleted: true }),
    commitWorktree: vi.fn().mockResolvedValue({ committed: false }),
    mergeWorktree: vi.fn().mockResolvedValue({ merged: "branch-agent-1", into: "main" }),
    getWorktreeDiff: vi.fn().mockResolvedValue({
      branch: "branch-agent-1",
      base: "main",
      files: [],
      patch: "",
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
    }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

describe("OrchestratorService Resume Agent", () => {
  let mockEmit: ReturnType<typeof vi.fn>;
  let context: any;

  beforeEach(() => {
    vi.clearAllMocks();
    OrchestratorService.clearAllActiveSubAgents();
    mockEmit = vi.fn();

    context = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-id-123",
      agentConversationId: "session-parent",
      conversationId: "conv-parent",
      maxRecursionDepth: 2,
      recursionDepth: 0,
      emit: mockEmit,
    };
  });

  afterEach(() => {
    OrchestratorService.clearAllActiveSubAgents();
  });

  // Helper to register a mock subagent in activeSubAgents
  function registerMockSubAgent(agentId: string, status: SubAgentState["status"]): SubAgentState {
    const subAgent: SubAgentState = {
      agentId,
      subAgentConversationId: `session-${agentId}`,
      parentAgentConversationId: "session-parent",
      description: `Mock Sub-Agent ${agentId}`,
      branchName: `branch-${agentId}`,
      worktreePath: `/workspace/worktree-${agentId}`,
      repositoryPath: "/workspace",
      isolated: true,
      status,
      output: "Initial output",
      toolCalls: [],
      diff: null,
      error: null,
      startedAt: Date.now() - 5000,
      durationMilliseconds: 5000,
      totalCost: 0.01,
      usage: { inputTokens: 100, outputTokens: 50 },
      abortController: null,
      messages: [],
      files: [],
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-id-123",
      maxIterations: 10,
      minContextLength: null,
      parentConversationId: "conv-parent",
    };

    OrchestratorService._getActiveSubAgents().set(agentId, subAgent);
    return subAgent;
  }

  it("should fail when resuming a nonexistent agent", async () => {
    const result = await OrchestratorService.resumeAgent("nonexistent", "do more", context);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not found");
  });

  it("should fail when resuming a running agent", async () => {
    registerMockSubAgent("agent-1", "running");
    const result = await OrchestratorService.resumeAgent("agent-1", "do more", context);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("currently running");
  });

  it("should fail when resuming an agent in failed state", async () => {
    registerMockSubAgent("agent-1", "failed");
    const result = await OrchestratorService.resumeAgent("agent-1", "do more", context);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("cannot be resumed");
  });

  it("should fail when resuming an agent in stopped state", async () => {
    registerMockSubAgent("agent-1", "stopped");
    const result = await OrchestratorService.resumeAgent("agent-1", "do more", context);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("cannot be resumed");
  });

  it("should successfully trigger background loop and return DETACHED_WORK at recursionDepth 0", async () => {
    const subAgent = registerMockSubAgent("agent-1", "complete");

    // Spy on _triggerParentAutoResponse to avoid database operations
    const autoResponseSpy = vi
      .spyOn(OrchestratorService, "_triggerParentAutoResponse")
      .mockResolvedValue();

    const result = await OrchestratorService.resumeAgent("agent-1", "do more", context);

    // The parent keeps working: the resume is detached work, not a turn end
    expect(result).toHaveProperty("_directive", "DETACHED_WORK");
    expect(result).toHaveProperty("agent");
    expect((result as any).agent.agent_id).toBe("agent-1");
    expect((result as any).agent.status).toBe("running");

    // Wait for the background loop to complete
    await vi.waitFor(() => {
      expect(subAgent.status).toBe("complete");
    });

    // Should emit statuses
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sub_agent_status",
        subAgentId: "agent-1",
        status: SYSTEM_STATUSES.RUNNING,
      }),
    );

    // Auto-response spy should have been called
    expect(autoResponseSpy).toHaveBeenCalledOnce();
    const [convId, proj, user, , msg] = autoResponseSpy.mock.calls[0];
    expect(convId).toBe("conv-parent");
    expect(proj).toBe("test-project");
    expect(user).toBe("test-user");
    expect(msg.role).toBe("user");
    expect(msg.content).toContain("[SUB-AGENT RESUMED COMPLETED]");

    autoResponseSpy.mockRestore();
  });

  it("merges a resumed agent's work back when it completes (resume does not defer)", async () => {
    // Resumed in the worktree a merge conflict kept: this retries the merge.
    const subAgent = registerMockSubAgent("agent-1", "complete");
    vi.mocked(GitWorktreeHelper.getWorktreeDiff).mockResolvedValueOnce({
      branch: "branch-agent-1",
      base: "main",
      files: [{ path: "notes/hello.txt", status: "added" }],
      patch: "+hello\n",
      stats: { filesChanged: 1, additions: 1, deletions: 0 },
    });
    const autoResponseSpy = vi
      .spyOn(OrchestratorService, "_triggerParentAutoResponse")
      .mockResolvedValue();

    await OrchestratorService.resumeAgent("agent-1", "resolve the conflict", context);
    await vi.waitFor(() => expect(subAgent.status).toBe("complete"));

    expect(GitWorktreeHelper.mergeWorktree).toHaveBeenCalledWith(
      "/workspace",
      "branch-agent-1",
      expect.any(String),
    );
    expect(GitWorktreeHelper.removeWorktree).toHaveBeenCalledWith(
      "/workspace",
      "/workspace/worktree-agent-1",
    );
    expect(subAgent.mergeBack).toMatchObject({ status: "merged", worktreePath: null });
    // Merged and gone: a further resume runs in the parent's workspace.
    expect(subAgent.isolated).toBe(false);
    expect(subAgent.worktreePath).toBeNull();
    autoResponseSpy.mockRestore();
  });

  // ── History (prompt 17, Landing 1) ─────────────────────────
  // A finished run releases `messages` (null) — the transcript lives in the
  // sub-agent's own agent_conversations document. A resume must continue
  // from it, not from an empty conversation.
  describe("resume restores the persisted history", () => {
    const persistedHistory = [
      { role: "user", content: "Look up A" },
      { role: "assistant", content: "A is 42." },
    ];
    let defaultCollection: ReturnType<typeof MongoWrapper.getCollection>;

    function servePersistedConversation(document: Record<string, unknown>) {
      vi.mocked(MongoWrapper.getCollection).mockReturnValue({
        findOne: vi.fn().mockImplementation(async (query: Record<string, unknown>) =>
          Object.entries(query).every(([key, value]) => document[key] === value) ? document : null,
        ),
        updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
        find: vi.fn().mockReturnValue({ toArray: async () => [] }),
      } as never);
    }

    beforeEach(() => {
      defaultCollection = MongoWrapper.getCollection("prism-test", "agent_conversations");
      vi.spyOn(OrchestratorService, "_triggerParentAutoResponse").mockResolvedValue();
    });

    afterEach(() => {
      vi.mocked(MongoWrapper.getCollection).mockReturnValue(defaultCollection);
    });

    it("puts the previous run's messages ahead of the new prompt in the resumed loop's input", async () => {
      const subAgent = registerMockSubAgent("agent-1", "complete");
      subAgent.messages = null; // released when its first run completed
      servePersistedConversation({
        id: "session-agent-1",
        project: "test-project",
        username: "test-user",
        isSubAgent: true,
        subAgentId: "agent-1",
        messages: persistedHistory,
      });

      await OrchestratorService.resumeAgent("agent-1", "Now look up B", context);
      await vi.waitFor(() => expect(AgenticLoopService.runAgenticLoop).toHaveBeenCalled());

      const [{ messages }] = vi.mocked(AgenticLoopService.runAgenticLoop).mock.calls[0] as [
        { messages: Array<{ role: string; content: string; _alreadyPersisted?: boolean }> },
      ];
      expect(messages.slice(0, 2).map((message) => message.content)).toEqual(["Look up A", "A is 42."]);
      expect(messages.slice(0, 2).every((message) => message._alreadyPersisted === true)).toBe(true);
      expect(messages[messages.length - 1]).toMatchObject({ role: "user", content: "Now look up B" });
      await vi.waitFor(() => expect(subAgent.status).toBe("complete"));
    });

    it("resumes an agent evicted from memory (TTL or restart) from its persisted conversation", async () => {
      servePersistedConversation({
        id: "session-agent-9",
        project: "test-project",
        username: "test-user",
        isSubAgent: true,
        subAgentId: "agent-9",
        subAgentDescription: "Evicted researcher",
        subAgentStatus: "complete",
        subAgentProviderName: PROVIDERS.GOOGLE,
        subAgentResolvedModel: "gemini-3-flash-preview",
        subAgentRecursionDepth: 1,
        parentConversationId: "conv-parent",
        parentAgentConversationId: "session-parent",
        agent: "CODING",
        messages: persistedHistory,
      });
      expect(OrchestratorService._getActiveSubAgents().has("agent-9")).toBe(false);

      const result = await OrchestratorService.resumeAgent("agent-9", "Now look up B", context);

      expect(result).not.toHaveProperty("error");
      await vi.waitFor(() => expect(AgenticLoopService.runAgenticLoop).toHaveBeenCalled());
      const [loopInput] = vi.mocked(AgenticLoopService.runAgenticLoop).mock.calls[0] as [
        { conversationId: string; messages: Array<{ content: string }> },
      ];
      expect(loopInput.conversationId).toBe("session-agent-9");
      expect(loopInput.messages.map((message) => message.content)).toContain("A is 42.");
    });

    it("does not resume another conversation's agent", async () => {
      servePersistedConversation({
        id: "session-agent-9",
        project: "test-project",
        username: "test-user",
        isSubAgent: true,
        subAgentId: "agent-9",
        subAgentStatus: "complete",
        parentConversationId: "some-other-conversation",
        messages: persistedHistory,
      });

      const result = await OrchestratorService.resumeAgent("agent-9", "Now look up B", context);

      expect((result as { error: string }).error).toContain("not found");
      expect(AgenticLoopService.runAgenticLoop).not.toHaveBeenCalled();
    });
  });

  it("should delegate to continueAgent and block when recursionDepth > 0", async () => {
    registerMockSubAgent("agent-1", "complete");
    context.recursionDepth = 1;

    // Spy on continueAgent
    const continueSpy = vi
      .spyOn(OrchestratorService, "continueAgent")
      .mockResolvedValue({
        agent_id: "agent-1",
        description: "description",
        status: "complete",
        summary: "done",
        result: "continueResult",
        toolUses: 2,
        iterations: 1,
        durationMilliseconds: 100,
        messages: [],
      });

    const result = await OrchestratorService.resumeAgent("agent-1", "do more", context);

    expect(continueSpy).toHaveBeenCalledOnce();
    expect(continueSpy).toHaveBeenCalledWith("agent-1", "do more", context);
    expect(result).toHaveProperty("result", "continueResult");

    continueSpy.mockRestore();
  });
});

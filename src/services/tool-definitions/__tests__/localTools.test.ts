import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock EmbeddingService ─────────────────────────────────────────────
const mockEmbed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
vi.mock("#src/services/EmbeddingService", () => ({
  default: {
    embed: (...args: any[]) => mockEmbed(...args),
  },
}));

// ── Mock MongoWrapper ─────────────────────────────────────────────────
vi.mock("#src/wrappers/MongoWrapper", () => {
  const localMockCollection = {
    find: () => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => [
            {
              id: "conv-1",
              title: "Test past conversation",
              compactionSummary: "Did some testing",
              summaryEmbedding: [0.1, 0.2, 0.3],
              createdAt: "2026-06-20",
              updatedAt: "2026-06-20",
              agent: "CODING",
            },
          ],
        }),
      }),
    }),
    countDocuments: async () => 2,
    findOne: async () => ({
      _key: "global",
      agents: { dynamicToolActivation: true },
    }),
  };

  return {
    default: {
      getDb: () => ({
        collection: () => localMockCollection,
      }),
      getCollection: () => localMockCollection,
    },
  };
});

// ── Mock AgenticLoopService ───────────────────────────────────────────
const mockSetPendingQuestion = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    _setPendingQuestion: (...args: any[]) => mockSetPendingQuestion(...args),
  },
}));

// ── Mock MCPClientService ─────────────────────────────────────────────
const mockListResources = vi.fn().mockResolvedValue({
  resources: [{ uri: "mcp://test-uri", name: "test-resource" }],
  count: 1,
});
const mockGetConnectedServers = vi.fn().mockReturnValue([{ name: "test-server" }]);
const mockReadResource = vi.fn().mockResolvedValue({ contents: [{ text: "content" }] });
const mockAuthenticateMcp = vi.fn().mockResolvedValue({ success: true });

vi.mock("#src/services/MCPClientService", () => ({
  default: {
    listResources: (...args: any[]) => mockListResources(...args),
    getConnectedServers: (...args: any[]) => mockGetConnectedServers(...args),
    readResource: (...args: any[]) => mockReadResource(...args),
    authenticate: (...args: any[]) => mockAuthenticateMcp(...args),
  },
}));

// ── Mock ConversationTimerService ─────────────────────────────────────
const mockCreateTimer = vi.fn().mockResolvedValue({
  id: "timer-123",
  mode: "one_shot",
  firesAt: "2026-06-20",
  prompt: "Wake up",
});
const mockListActiveTimers = vi.fn().mockResolvedValue([
  {
    id: "timer-123",
    mode: "one_shot",
    firesAt: "2026-06-20",
    prompt: "Wake up",
  },
]);
const mockCancelTimer = vi.fn().mockResolvedValue(true);

vi.mock("#src/services/ConversationTimerService", () => ({
  default: {
    createTimer: (...args: any[]) => mockCreateTimer(...args),
    listActiveTimers: (...args: any[]) => mockListActiveTimers(...args),
    cancelTimer: (...args: any[]) => mockCancelTimer(...args),
  },
}));

// ── Mock SkillService ─────────────────────────────────────────────────
const mockSkillCreate = vi.fn().mockResolvedValue({ success: true, name: "test_skill" });
const mockSkillPrepare = vi.fn().mockResolvedValue({
  name: "test_skill",
  skillId: "test_skill_id",
  prompt: "Do something with {{var}}",
  config: { model: PROVIDERS.GOOGLE },
});
const mockSkillList = vi.fn().mockResolvedValue([{ name: "test_skill" }]);
const mockSkillLoad = vi.fn().mockResolvedValue({ name: "test_skill", body: "Do it", resources: [] });
const mockSkillDelete = vi.fn().mockResolvedValue({ success: true });

vi.mock("#src/services/SkillService", () => ({
  default: {
    create: (...args: any[]) => mockSkillCreate(...args),
    prepare: (...args: any[]) => mockSkillPrepare(...args),
    list: (...args: any[]) => mockSkillList(...args),
    load: (...args: any[]) => mockSkillLoad(...args),
    delete: (...args: any[]) => mockSkillDelete(...args),
  },
  resolveSkillCaller: (known: Record<string, unknown>) => ({
    project: known.project || "any",
    username: known.username || "any",
    profileId: "default",
    agent: known.agent ?? null,
  }),
}));

// ── Mock ToolOrchestratorService ──────────────────────────────────────
const mockGetWorktreeState = vi.fn().mockReturnValue(null);
const mockGetWorkspaceRoot = vi.fn().mockReturnValue("/workspace");
const mockProxyPost = vi.fn().mockResolvedValue({ success: true, worktreePath: "/workspace/wt-1" });
const mockSetWorktree = vi.fn();
const mockClearWorktree = vi.fn();
const mockExecuteOrchestratorTool = vi.fn().mockResolvedValue({ success: true });
const mockGetClientToolSchemas = vi.fn().mockReturnValue([]);
const mockExecuteTool = vi.fn().mockResolvedValue({ matches: [{ name: "discoverable_tool" }], total: 1 });

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorktreeState: (...args: any[]) => mockGetWorktreeState(...args),
    getWorkspaceRoot: (...args: any[]) => mockGetWorkspaceRoot(...args),
    _proxyPost: (...args: any[]) => mockProxyPost(...args),
    _setWorktree: (...args: any[]) => mockSetWorktree(...args),
    _clearWorktree: (...args: any[]) => mockClearWorktree(...args),
    executeOrchestratorTool: (...args: any[]) => mockExecuteOrchestratorTool(...args),
    getClientToolSchemas: (...args: any[]) => mockGetClientToolSchemas(...args),
    executeTool: (...args: any[]) => mockExecuteTool(...args),
  },
}));

vi.mock("#src/types/GlobalToolOrchestratorRegistry", () => ({
  getGlobalToolOrchestratorService: () => {
    const mockService = {
      getClientToolSchemas: () => [{ name: "discoverable_tool" }],
      executeTool: (...args: any[]) => mockExecuteTool(...args),
    };
    return mockService;
  },
}));

import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import { PROVIDERS } from "#src/constants";

describe("Local Tools Unit Tests Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. InternalToolRegistry Check
  it("should have correct tool list registered", () => {
    expect(InternalToolRegistry.has("enter_plan_mode")).toBe(true);
    expect(InternalToolRegistry.has("exit_plan_mode")).toBe(true);
    expect(InternalToolRegistry.has("summarize_conversation")).toBe(true);
    expect(InternalToolRegistry.getNames().size).toBeGreaterThan(0);
    expect(InternalToolRegistry.getSchemas().length).toBeGreaterThan(0);
    expect(InternalToolRegistry.getClientSchemas().length).toBeGreaterThan(0);
  });

  // 2. Plan Mode Tools
  it("should enter and exit plan mode successfully", async () => {
    const enterResult = await InternalToolRegistry.execute("enter_plan_mode", {
      reason: "Creating test design plan",
    });
    expect(enterResult).toEqual(
      expect.objectContaining({
        acknowledged: true,
        mode: "plan",
        reason: "Creating test design plan",
      })
    );

    const exitResult = await InternalToolRegistry.execute("exit_plan_mode", {});
    expect(exitResult).toEqual(
      expect.objectContaining({
        acknowledged: true,
        mode: "execute",
      })
    );
  });

  // 3. AskUserQuestionTool
  it("should execute ask_user question tool", async () => {
    const mockEmit = vi.fn();
    mockSetPendingQuestion.mockImplementation((conversationId, pending) => {
      pending.resolve({ answers: [{ answer: "Blue" }] });
    });

    const result = await InternalToolRegistry.execute(
      "ask_user",
      { questions: [{ question: "What is your favorite color?" }] },
      { agentConversationId: "conv-123", _emit: mockEmit } as any
    );

    expect(result).toEqual({
      questionId: expect.stringMatching(/^q-/),
      questions: ["What is your favorite color?"],
      answers: [{ answer: "Blue" }],
    });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_question",
        blocking: true,
        questionId: (result as { questionId: string }).questionId,
        questions: expect.arrayContaining([
          expect.objectContaining({ question: "What is your favorite color?" }),
        ]),
      })
    );
  });

  // 3b. AskUserQuestionTool — non-blocking: returns at once, answer lands in the mailbox
  it("ask_user with blocking=false returns immediately and routes the answer through the turn mailbox", async () => {
    const { default: TurnInputMailbox } = await import("#src/services/TurnInputMailbox");
    const { AGENT_DIRECTIVES, TURN_INPUT } = await import("#src/constants");
    TurnInputMailbox._clearAll();
    TurnInputMailbox.open("conv-123");
    const mockEmit = vi.fn();
    let capturedResolve: ((value: unknown) => void) | null = null;
    mockSetPendingQuestion.mockImplementation((_conversationId, pending) => {
      capturedResolve = pending.resolve;
    });

    const result = (await InternalToolRegistry.execute(
      "ask_user",
      { blocking: false, questions: [{ question: "Tabs or spaces?" }] },
      { agentConversationId: "conv-123", conversationId: "conv-123", _emit: mockEmit } as any
    )) as Record<string, unknown>;

    expect(result._directive).toBe(AGENT_DIRECTIVES.DETACHED_WORK);
    expect(result.status).toBe("pending");
    expect(result.questionId).toMatch(/^q-/);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_question", blocking: false, questionId: result.questionId })
    );
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", message: TURN_INPUT.STATUS_QUESTION_PENDING, questionId: result.questionId })
    );
    expect(capturedResolve).not.toBeNull();
    expect(TurnInputMailbox.pendingCount("conv-123")).toBe(0);

    // The /agent/answer route resolves the entry later → mailbox
    capturedResolve!({ answers: [{ answer: "Spaces", annotations: "always" }] });
    const drained = TurnInputMailbox.drain("conv-123");
    expect(drained).toHaveLength(1);
    expect(drained[0].kind).toBe("question_answer");
    expect(drained[0].text).toContain("Tabs or spaces?");
    expect(drained[0].text).toContain("Spaces");
    expect(drained[0].text).toContain("always");
    expect(drained[0].meta).toEqual({ questionId: result.questionId });
    TurnInputMailbox._clearAll();
  });

  // 4. BriefTool
  it("should compile brief summaries and emit changes", async () => {
    const mockEmit = vi.fn();
    const result = await InternalToolRegistry.execute(
      "summarize_conversation",
      {
        summary: "We set up tests.",
        keyFiles: ["tests/localTools.test.ts"],
        openQuestions: ["Should we write more tests?"],
      },
      { _emit: mockEmit } as any
    );

    expect(result).toEqual(
      expect.objectContaining({
        acknowledged: true,
        brief: expect.objectContaining({
          summary: "We set up tests.",
          keyFiles: ["tests/localTools.test.ts"],
          openQuestions: ["Should we write more tests?"],
        }),
      })
    );
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brief_update",
      })
    );
  });

  // 5. TodoWriteTool
  it("should write todos and emit changes", async () => {
    const mockEmit = vi.fn();
    const result = await InternalToolRegistry.execute(
      "write_todo",
      {
        items: [
          { content: "Finish tools coverage", status: "in_progress", priority: "high" },
          { content: "Verify websocket tests", status: "pending", priority: "medium" },
        ],
      },
      { _emit: mockEmit } as any
    );

    expect(result).toEqual(
      expect.objectContaining({
        acknowledged: true,
        stats: expect.objectContaining({
          total: 2,
          in_progress: 1,
          pending: 1,
        }),
      })
    );
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "todo_update",
      })
    );
  });

  // 6. ToolActivationTools
  it("should enable and disable dynamic tools", async () => {
    const context: any = { agentConversationId: "conv-123" };

    const enableResult = await InternalToolRegistry.execute(
      "enable_tools",
      { tools: ["tool_a", "tool_b"] },
      context
    );
    expect(enableResult).toEqual(
      expect.objectContaining({
        success: true,
        activated: ["tool_a", "tool_b"],
      })
    );

    const disableResult = await InternalToolRegistry.execute(
      "disable_tools",
      { tools: ["tool_a"] },
      context
    );
    expect(disableResult).toEqual(
      expect.objectContaining({
        success: true,
        disabled: ["tool_a"],
      })
    );
  });

  // 7. ConversationSearchTool
  it("should search conversations semantically", async () => {
    const result = await InternalToolRegistry.execute(
      "search_conversations",
      { query: "WebSocket connections", limit: 5 },
      { project: "test-project", username: "test-user" }
    );

    expect(result).toEqual(
      expect.objectContaining({
        count: 1,
        conversations: expect.arrayContaining([
          expect.objectContaining({
            conversationId: "conv-1",
            title: "Test past conversation",
            score: 1.0,
            linkedMemoryCount: 2,
          }),
        ]),
      })
    );
  });

  // 8. McpTools
  it("should run mcp connection actions", async () => {
    const listResult = await InternalToolRegistry.execute("list_mcp_resources", {});
    expect(listResult).toEqual(
      expect.objectContaining({
        count: 1,
        servers: ["test-server"],
      })
    );

    const readResult = await InternalToolRegistry.execute("read_mcp_resource", {
      server_name: "test-server",
      uri: "mcp://test-uri",
    });
    expect(readResult).toEqual({ contents: [{ text: "content" }] });

    const authResult = await InternalToolRegistry.execute("authenticate_mcp_server", {
      server_name: "test-server",
      token: "secret-token",
    });
    expect(authResult).toEqual({ success: true });
  });

  // 9. ReminderTools
  it("should set, list, and cancel timers", async () => {
    const context = { agentConversationId: "conv-abc" };

    const setResult = await InternalToolRegistry.execute(
      "set_timer",
      { prompt: "Verify build status", durationSeconds: 60 },
      context
    );
    expect(setResult).toEqual(
      expect.objectContaining({
        success: true,
        timer: expect.objectContaining({
          id: "timer-123",
          prompt: "Wake up",
        }),
      })
    );

    const listResult = await InternalToolRegistry.execute("list_timers", {}, context);
    expect(listResult).toEqual(
      expect.objectContaining({
        success: true,
        timers: expect.arrayContaining([
          expect.objectContaining({
            id: "timer-123",
          }),
        ]),
      })
    );

    const cancelResult = await InternalToolRegistry.execute(
      "cancel_timer",
      { timerId: "timer-123" },
      context
    );
    expect(cancelResult).toEqual({
      success: true,
      message: "Successfully cancelled timer timer-123.",
    });
  });

  // 10. SkillTools
  it("should support skill CRUD operations", async () => {
    const skillContext = { project: "p1", username: "u1", agent: "CODING" };
    const caller = { project: "p1", username: "u1", profileId: "default", agent: "CODING" };

    const createResult = await InternalToolRegistry.execute(
      "create_skill",
      { name: "verify_lint", prompt: "Run npm run lint and fix files" },
      skillContext,
    );
    expect(createResult).toEqual({ success: true, name: "test_skill" });
    expect(mockSkillCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "verify_lint",
        body: "Run npm run lint and fix files",
        source: "agent",
      }),
      caller,
    );

    const listResult = await InternalToolRegistry.execute("list_skills", {}, skillContext);
    expect(listResult).toEqual([{ name: "test_skill" }]);
    expect(mockSkillList).toHaveBeenCalledWith(caller);

    const loadResult = await InternalToolRegistry.execute(
      "load_skill",
      { name: "test_skill" },
      skillContext,
    );
    expect(loadResult).toEqual({ name: "test_skill", body: "Do it", resources: [] });
    expect(mockSkillLoad).toHaveBeenCalledWith("test_skill", caller);

    const deleteResult = await InternalToolRegistry.execute(
      "delete_skill",
      { skillId: "verify_lint" },
      skillContext,
    );
    expect(deleteResult).toEqual({ success: true });
    expect(mockSkillDelete).toHaveBeenCalledWith("verify_lint", caller);

    const executeResult = await InternalToolRegistry.execute("execute_skill", {
      skillId: "verify_lint",
      variables: { project: "test-proj" },
    });
    expect(executeResult).toEqual({ success: true });
  });

  // 11. WorktreeTools
  it("should support entering and exiting worktrees", async () => {
    const context = { agentConversationId: "conv-worktree" };

    const enterResult = await InternalToolRegistry.execute(
      "enter_worktree",
      { reason: "test risk" },
      context
    );
    expect(enterResult).toEqual(
      expect.objectContaining({
        acknowledged: true,
        worktreePath: "/workspace/wt-1",
      })
    );

    mockGetWorktreeState.mockReturnValueOnce({
      originalRoot: "/workspace",
      worktreePath: "/workspace/wt-1",
      branchName: "wt-branch",
      repoPath: "/workspace",
    });

    const exitResult = await InternalToolRegistry.execute(
      "exit_worktree",
      { action: "merge", commitMessage: "completed worktree changes" },
      context
    );
    expect(exitResult).toEqual(
      expect.objectContaining({
        acknowledged: true,
        action: "merge",
      })
    );
  });

  it("enter_worktree stores the branch tools-service created, not the one it asked for", async () => {
    mockProxyPost.mockResolvedValueOnce({
      worktreePath: "/tmp/prism-worktrees/wt-9",
      branch: "worktree/as-created",
    });

    await InternalToolRegistry.execute("enter_worktree", {}, { agentConversationId: "conv-branch" });

    expect(mockSetWorktree).toHaveBeenCalledWith(
      "conv-branch",
      expect.objectContaining({ branchName: "worktree/as-created" }),
    );
  });

  it("exit_worktree merge commits the edits first, merges the stored branch, then removes without force", async () => {
    mockProxyPost.mockReset();
    mockProxyPost.mockResolvedValue({ ok: true });
    mockGetWorktreeState.mockReturnValueOnce({
      originalRoot: "/workspace",
      worktreePath: "/tmp/prism-worktrees/wt-1",
      branchName: "worktree/abc",
      repoPath: "/workspace",
    });

    const exitResult = await InternalToolRegistry.execute(
      "exit_worktree",
      { action: "merge" },
      { agentConversationId: "conv-merge" },
    );

    expect(exitResult).toMatchObject({ acknowledged: true, action: "merge" });
    const calls = mockProxyPost.mock.calls.map(([path, body]) => [path, body]);
    expect(calls.map(([path]) => path)).toEqual([
      "/agentic/git/worktree/commit",
      "/agentic/git/worktree/diff",
      "/agentic/git/worktree/merge",
      "/agentic/git/worktree/remove",
    ]);
    expect(calls[2][1]).toMatchObject({ branch: "worktree/abc" });
    expect(calls[3][1]).toMatchObject({ deleteBranch: true, force: false });
  });

  it("exit_worktree keeps the worktree when the merge is refused", async () => {
    mockProxyPost.mockReset();
    mockProxyPost.mockImplementation(async (path: string) =>
      path.endsWith("/merge") ? { error: "conflicts in a.ts" } : { ok: true },
    );
    mockGetWorktreeState.mockReturnValueOnce({
      originalRoot: "/workspace",
      worktreePath: "/tmp/prism-worktrees/wt-1",
      branchName: "worktree/abc",
      repoPath: "/workspace",
    });

    const exitResult = await InternalToolRegistry.execute(
      "exit_worktree",
      { action: "merge" },
      { agentConversationId: "conv-conflict" },
    );

    expect(exitResult).toHaveProperty("error");
    expect(mockProxyPost.mock.calls.map(([path]) => path)).not.toContain("/agentic/git/worktree/remove");
    expect(mockClearWorktree).not.toHaveBeenCalledWith("conv-conflict");
  });

  it("exit_worktree discard is the one removal that forces", async () => {
    mockProxyPost.mockReset();
    mockProxyPost.mockResolvedValue({ ok: true });
    mockGetWorktreeState.mockReturnValueOnce({
      originalRoot: "/workspace",
      worktreePath: "/tmp/prism-worktrees/wt-1",
      branchName: "worktree/abc",
      repoPath: "/workspace",
    });

    await InternalToolRegistry.execute("exit_worktree", { action: "discard" }, { agentConversationId: "conv-discard" });

    expect(mockProxyPost.mock.calls.map(([path]) => path)).toEqual(["/agentic/git/worktree/remove"]);
    expect(mockProxyPost.mock.calls[0][1]).toMatchObject({ force: true });
    mockProxyPost.mockReset();
    mockProxyPost.mockResolvedValue({ success: true, worktreePath: "/workspace/wt-1" });
  });

  // 12. DiscoverAndEnableTools
  it("should discover and auto-enable tools", async () => {
    const context = { agentConversationId: "conv-123", enabledTools: [] };

    const result = await InternalToolRegistry.execute(
      "discover_and_enable_tools",
      { query: "mcp" },
      context
    );

    expect(result).toEqual(
      expect.objectContaining({
        total: 1,
        query: "mcp",
      })
    );
  });
});

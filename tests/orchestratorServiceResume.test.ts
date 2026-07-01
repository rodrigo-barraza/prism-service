import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "../src/constants.ts";
import OrchestratorService from "../src/services/OrchestratorService.ts";
import type { SubAgentState } from "../src/types/orchestrator.ts";

// Mock dependencies to avoid actual loop execution and worktree creation
vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: vi.fn().mockResolvedValue({
      messages: [{ role: "assistant", content: "Resumed output" }],
    }),
  },
}));

vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    removeWorktree: vi.fn().mockResolvedValue({}),
    getWorktreeDiff: vi.fn().mockResolvedValue({
      hasChanges: false,
      additions: 0,
      deletions: 0,
      files: [],
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

  it("should successfully trigger background loop and return NON_BLOCKING_DISPATCH at recursionDepth 0", async () => {
    const subAgent = registerMockSubAgent("agent-1", "complete");

    // Spy on _triggerParentAutoResponse to avoid database operations
    const autoResponseSpy = vi
      .spyOn(OrchestratorService, "_triggerParentAutoResponse")
      .mockResolvedValue();

    const result = await OrchestratorService.resumeAgent("agent-1", "do more", context);

    // Should return non-blocking directive immediately
    expect(result).toHaveProperty("_directive", "NON_BLOCKING_DISPATCH");
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
        message: "spawned",
      }),
    );

    // Auto-response spy should have been called
    expect(autoResponseSpy).toHaveBeenCalledOnce();
    const [convId, proj, user, ctx, msg] = autoResponseSpy.mock.calls[0];
    expect(convId).toBe("conv-parent");
    expect(proj).toBe("test-project");
    expect(user).toBe("test-user");
    expect(msg.role).toBe("user");
    expect(msg.content).toContain("[SUB-AGENT RESUMED COMPLETED]");

    autoResponseSpy.mockRestore();
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

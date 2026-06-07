import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type {
  OrchestratorContext,
  SubAgentResult,
  OrchestratorSpawnParams,
} from "../src/types/orchestrator.ts";

// Mock GitWorktreeHelper
vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

// Mock SettingsService
vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      subAgentProvider: "google",
      subAgentModel: "gemini-3.5-flash",
      topology: "hierarchical",
    }),
  },
}));

import { HierarchicalRouter } from "../src/services/orchestrator/routers/HierarchicalRouter.ts";
import { SequentialRouter } from "../src/services/orchestrator/routers/SequentialRouter.ts";
import { PeerToPeerRouter } from "../src/services/orchestrator/routers/PeerToPeerRouter.ts";
import { GitWorktreeHelper } from "../src/services/orchestrator/GitWorktreeHelper.ts";

describe("Topology Routers Test Suite", () => {
  let orchestratorContext: OrchestratorContext;
  let spawnSubAgentMock: Mock<(assignment: OrchestratorSpawnParams) => Promise<SubAgentResult | { error: string }>>;

  beforeEach(() => {
    vi.clearAllMocks();

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: "google",
      resolvedModel: "gemini-3.5-flash",
      traceId: "trace-id-123",
      agentSessionId: "session-id-456",
      conversationId: "conv-id-789",
      emit: vi.fn(),
    };

    spawnSubAgentMock = vi.fn().mockImplementation(async (assignment: OrchestratorSpawnParams) => {
      return {
        agent_id: `agent-mock-${Math.random().toString(36).slice(2, 6)}`,
        status: "completed",
        result: `Completed task: ${assignment.description}`,
        summary: "Done",
        toolUses: 2,
        durationMs: 120,
        iterations: 1,
        messages: [],
      };
    });
  });

  describe("HierarchicalRouter", () => {
    it("should execute all members concurrently", async () => {
      const router = new HierarchicalRouter();
      const members = [
        { description: "Task A", prompt: "Prompt A" },
        { description: "Task B", prompt: "Prompt B" },
      ];

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);

      // Verify prompts were sent unmodified
      expect(spawnSubAgentMock.mock.calls[0][0].prompt).toBe("Prompt A");
      expect(spawnSubAgentMock.mock.calls[1][0].prompt).toBe("Prompt B");

      // Verify git merge was NOT called (Hierarchical doesn't merge sequentially)
      expect(GitWorktreeHelper.mergeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("SequentialRouter", () => {
    it("should execute members sequentially and propagate context", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Step A", prompt: "Do A" },
        { description: "Step B", prompt: "Do B" },
      ];

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);

      // First call prompt should be the base prompt
      expect(spawnSubAgentMock.mock.calls[0][0].prompt).toBe("Do A");

      // Second call prompt should contain context from first call
      const secondPrompt = spawnSubAgentMock.mock.calls[1][0].prompt;
      expect(secondPrompt).toContain("PREVIOUS STEP RESULT");
      expect(secondPrompt).toContain("Completed task: Step A");
      expect(secondPrompt).toContain("Do B");

      // Verify git merge was called to merge completed worktrees
      expect(GitWorktreeHelper.mergeWorktree).toHaveBeenCalledTimes(2);
    });

    it("should abort sequence early if a step fails", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Step A", prompt: "Do A" },
        { description: "Step B", prompt: "Do B" },
      ];

      // Make spawn fail on first call
      spawnSubAgentMock.mockResolvedValueOnce({
        status: "failed",
        error: "Compilation error",
      });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      // Result should only have the first step
      expect(results).toHaveLength(1);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(1);
      expect(GitWorktreeHelper.mergeWorktree).not.toHaveBeenCalled();
    });
  });

  describe("PeerToPeerRouter", () => {
    it("should execute turns in a round-robin fashion", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Code prompt" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      // Max turns for 2 members is 4 (Math.min(8, 2*2))
      expect(results).toHaveLength(4);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(4);

      // Turn 0: Dev
      expect(spawnSubAgentMock.mock.calls[0][0].agent).toBe("Dev");
      // Turn 1: QA
      expect(spawnSubAgentMock.mock.calls[1][0].agent).toBe("QA");
      // Turn 2: Dev
      expect(spawnSubAgentMock.mock.calls[2][0].agent).toBe("Dev");

      // Shared Discussion should propagate to subsequent prompts
      const secondTurnPrompt = spawnSubAgentMock.mock.calls[1][0].prompt;
      expect(secondTurnPrompt).toContain("SHARED DISCUSSION BOARD");
      expect(secondTurnPrompt).toContain("[Dev]: Completed task: Write Code");

      expect(GitWorktreeHelper.mergeWorktree).toHaveBeenCalledTimes(4);
    });

    it("should exit early when an agent replies with [DONE]", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Code prompt" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      // Make QA return [DONE] in turn 1
      spawnSubAgentMock.mockResolvedValueOnce({
        agent_id: "agent-dev",
        description: "Write Code",
        status: "completed",
        result: "Code written",
        summary: "Code written",
        toolUses: 0,
        iterations: 1,
        durationMs: 10,
        messages: [],
      });
      spawnSubAgentMock.mockResolvedValueOnce({
        agent_id: "agent-qa",
        description: "Verify Code",
        status: "completed",
        result: "Everything looks perfect. [DONE]",
        summary: "Everything looks perfect. [DONE]",
        toolUses: 0,
        iterations: 1,
        durationMs: 10,
        messages: [],
      });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      // Should stop after the QA turn (2 turns total)
      expect(results).toHaveLength(2);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
    });
  });
});

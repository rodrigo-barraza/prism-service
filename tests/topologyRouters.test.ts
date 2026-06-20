import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
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
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    getSection: vi.fn().mockResolvedValue({
      subAgentProvider: PROVIDERS.GOOGLE,
      subAgentModel: "gemini-3.5-flash",
      topology: "hierarchical",
    }),
  },
}));

// Mock getProvider
const mockGenerateText = vi.fn().mockResolvedValue({
  text: "Synthesized results summary.",
  usage: { inputTokens: 100, outputTokens: 50 },
});

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

import { HierarchicalRouter } from "../src/services/orchestrator/routers/HierarchicalRouter.ts";
import { HierarchicalAggregationRouter } from "../src/services/orchestrator/routers/HierarchicalAggregationRouter.ts";
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
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3.5-flash",
      traceId: "trace-id-123",
      agentConversationId: "session-id-456",
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
        diff: {
          additions: 1,
          deletions: 0,
          files: ["test.txt"],
        },
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

      // Second call prompt should contain accumulated context from prior steps
      const secondPrompt = spawnSubAgentMock.mock.calls[1][0].prompt;
      expect(secondPrompt).toContain("PREVIOUS STEPS RESULTS");
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
    });

    it("should abort sequence early if git merge fails", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Step A", prompt: "Do A" },
        { description: "Step B", prompt: "Do B" },
      ];

      // Make merge fail
      vi.mocked(GitWorktreeHelper.mergeWorktree).mockResolvedValueOnce({ error: "Merge conflict" });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      // Should have 2 results: Step A's success + the merge error abort
      expect(results).toHaveLength(2);
      expect("error" in results[1]).toBe(true);
      expect((results[1] as { error: string }).error).toContain("Failed to merge branch");
    });

    it("should skip git merge and complete successfully for research tasks (no diff)", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Step A", prompt: "Do A" },
        { description: "Step B", prompt: "Do B" },
      ];

      spawnSubAgentMock.mockImplementation(async (assignment) => {
        return {
          agent_id: "agent-mock-research",
          description: assignment.description || "",
          status: "completed",
          result: `Completed task: ${assignment.description}`,
          summary: "Done",
          toolUses: 0,
          durationMs: 50,
          iterations: 1,
          messages: [],
        };
      });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
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

    it("should scale max turns dynamically to cover all members when team size exceeds 8", async () => {
      const router = new PeerToPeerRouter();
      const members = Array.from({ length: 10 }, (_, index) => ({
        agent: `Agent-${index}`,
        description: `Task ${index}`,
        prompt: `Prompt ${index}`,
      }));

      const results = await router.execute("large-team", members, orchestratorContext, spawnSubAgentMock);

      // Math.max(10, Math.min(10, 10 * 2)) = 10 turns (capped at 10)
      expect(results).toHaveLength(10);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(10);

      // Check that every agent gets spawned at least once (10 calls map to indices 0 to 9)
      for (let index = 0; index < 10; index++) {
        expect(spawnSubAgentMock.mock.calls[index][0].agent).toBe(`Agent-${index}`);
      }
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

    it("should abort mesh early if git merge fails", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Code prompt" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      // Make merge fail
      vi.mocked(GitWorktreeHelper.mergeWorktree).mockResolvedValueOnce({ error: "Merge conflict" });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      // Should have 2 results: Dev's success + the merge error abort
      expect(results).toHaveLength(2);
      expect("error" in results[1]).toBe(true);
      expect((results[1] as { error: string }).error).toContain("Failed to merge branch");
    });

    it("should reject members with missing or empty prompts", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "" },
        { agent: "QA", description: "Verify Code", prompt: "QA prompt" },
      ];

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(1);
      expect("error" in results[0]).toBe(true);
      expect((results[0] as { error: string }).error).toContain("missing or empty prompts");
      expect(spawnSubAgentMock).not.toHaveBeenCalled();
    });

    it("should reject members with undefined prompts", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: undefined as unknown as string },
        { agent: "QA", description: "Verify Code", prompt: undefined as unknown as string },
      ];

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(1);
      expect("error" in results[0]).toBe(true);
      expect((results[0] as { error: string }).error).toContain("2 member(s) have missing or empty prompts");
      expect(spawnSubAgentMock).not.toHaveBeenCalled();
    });

    it("should abort mesh after consecutive stall responses", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Dev", description: "Write Code", prompt: "Build the feature" },
        { agent: "QA", description: "Verify Code", prompt: "Test the feature" },
      ];

      // Make every agent return a stall response
      spawnSubAgentMock.mockImplementation(async (assignment: OrchestratorSpawnParams) => ({
        agent_id: `agent-stall-${Math.random().toString(36).slice(2, 6)}`,
        description: assignment.description || "",
        status: "completed",
        result: "No actionable task was provided. Standing by for a new task definition.",
        summary: "Standing by",
        toolUses: 0,
        durationMs: 10,
        iterations: 1,
        messages: [],
      }));

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      // Should abort after 3 consecutive stalls (not run all 4 turns)
      expect(results).toHaveLength(3);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(3);
    });

    it("should use structured tool-call fallback in shared discussion when result is null", async () => {
      const router = new PeerToPeerRouter();
      const members = [
        { agent: "Researcher", description: "Research Agent", prompt: "Research topic X" },
        { agent: "Analyst", description: "Analysis Agent", prompt: "Analyze findings" },
      ];

      // First agent returns null result with tool metadata (simulates exhaustion without recovery text)
      spawnSubAgentMock.mockResolvedValueOnce({
        agent_id: "agent-researcher",
        description: "Research Agent",
        status: "completed",
        result: null,
        summary: 'Agent "Research Agent" completed',
        toolUses: 8,
        toolNames: { web_search: 5, read_file: 3 },
        iterations: 15,
        durationMs: 30000,
        messages: [],
      });

      // Second agent gets the discussion board — verify it got the structured fallback
      spawnSubAgentMock.mockImplementationOnce(async (assignment: OrchestratorSpawnParams) => {
        // The prompt should contain structured tool-call info, NOT the boilerplate summary
        expect(assignment.prompt).toContain("web_search (5×)");
        expect(assignment.prompt).toContain("read_file (3×)");
        expect(assignment.prompt).toContain("15 iterations");
        expect(assignment.prompt).not.toContain('Agent "Research Agent" completed');

        return {
          agent_id: "agent-analyst",
          description: "Analysis Agent",
          status: "completed",
          result: "Analysis complete. [DONE]",
          summary: "Done",
          toolUses: 0,
          iterations: 1,
          durationMs: 1000,
          messages: [],
        };
      });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(2);
    });
  });

  describe("SequentialRouter — Structured Fallback", () => {
    it("should use structured tool-call fallback in accumulated context when result is null", async () => {
      const router = new SequentialRouter();
      const members = [
        { description: "Step A", prompt: "Do A" },
        { description: "Step B", prompt: "Do B" },
      ];

      // First step returns null result with tool metadata
      spawnSubAgentMock.mockResolvedValueOnce({
        agent_id: "agent-step-a",
        description: "Step A",
        status: "completed",
        result: null,
        summary: 'Agent "Step A" completed',
        toolUses: 6,
        toolNames: { write_file: 4, execute_command: 2 },
        iterations: 10,
        durationMs: 20000,
        messages: [],
      });

      // Second step gets the accumulated context — verify it got the structured fallback
      spawnSubAgentMock.mockImplementationOnce(async (assignment: OrchestratorSpawnParams) => {
        expect(assignment.prompt).toContain("write_file (4×)");
        expect(assignment.prompt).toContain("execute_command (2×)");
        expect(assignment.prompt).toContain("10 iterations");
        expect(assignment.prompt).not.toContain('Agent "Step A" completed');

        return {
          agent_id: "agent-step-b",
          description: "Step B",
          status: "completed",
          result: "Step B done",
          summary: "Done",
          toolUses: 0,
          iterations: 1,
          durationMs: 1000,
          messages: [],
        };
      });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);
      expect(results).toHaveLength(2);
    });
  });

  describe("HierarchicalAggregationRouter", () => {
    it("should execute all members concurrently and run a synthesis pass", async () => {
      const router = new HierarchicalAggregationRouter();
      const members = [
        { description: "Task A", prompt: "Prompt A" },
        { description: "Task B", prompt: "Prompt B" },
      ];

      mockGenerateText.mockClear();

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(3);
      expect(spawnSubAgentMock).toHaveBeenCalledTimes(2);
      expect(mockGenerateText).toHaveBeenCalledTimes(1);

      const synthesisResult = results[2] as SubAgentResult;
      expect(synthesisResult.agent_id).toContain("synthesis-test-team");
      expect(synthesisResult.status).toBe("completed");
      expect(synthesisResult.result).toBe("Synthesized results summary.");
      expect(synthesisResult.summary).toContain("Aggregated 2 sub-agent results");
    });

    it("should skip synthesis pass if all sub-agents fail", async () => {
      const router = new HierarchicalAggregationRouter();
      const members = [
        { description: "Task A", prompt: "Prompt A" },
        { description: "Task B", prompt: "Prompt B" },
      ];

      mockGenerateText.mockClear();
      spawnSubAgentMock.mockResolvedValue({
        status: "failed",
        error: "Execution error",
      });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("should skip synthesis pass if only one sub-agent succeeds", async () => {
      const router = new HierarchicalAggregationRouter();
      const members = [
        { description: "Task A", prompt: "Prompt A" },
        { description: "Task B", prompt: "Prompt B" },
      ];

      mockGenerateText.mockClear();
      spawnSubAgentMock
        .mockResolvedValueOnce({
          agent_id: "agent-a",
          status: "completed",
          result: "Task A finished",
          summary: "Done A",
          toolUses: 1,
          durationMs: 50,
          iterations: 1,
          messages: [],
        })
        .mockResolvedValueOnce({
          status: "failed",
          error: "Task B failed",
        });

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("should handle synthesis generation failure gracefully and return raw results", async () => {
      const router = new HierarchicalAggregationRouter();
      const members = [
        { description: "Task A", prompt: "Prompt A" },
        { description: "Task B", prompt: "Prompt B" },
      ];

      mockGenerateText.mockClear();
      mockGenerateText.mockRejectedValueOnce(new Error("Inference error"));

      const results = await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(results).toHaveLength(2);
    });

    it("should use fallback summary when a successful sub-agent has a null/empty result", async () => {
      const router = new HierarchicalAggregationRouter();
      const members = [
        { description: "Task A", prompt: "Prompt A" },
        { description: "Task B", prompt: "Prompt B" },
      ];

      mockGenerateText.mockClear();
      spawnSubAgentMock
        .mockResolvedValueOnce({
          agent_id: "agent-a",
          status: "completed",
          result: null,
          summary: "Done A",
          toolUses: 5,
          toolNames: { write_file: 5 },
          iterations: 3,
          durationMs: 100,
          messages: [],
        })
        .mockResolvedValueOnce({
          agent_id: "agent-b",
          status: "completed",
          result: "Task B finished",
          summary: "Done B",
          toolUses: 1,
          durationMs: 50,
          iterations: 1,
          messages: [],
        });

      await router.execute("test-team", members, orchestratorContext, spawnSubAgentMock);

      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      const promptArg = mockGenerateText.mock.calls[0][0][0].content;
      expect(promptArg).toContain("Agent completed 3 iterations using write_file (5×) but did not produce a final summary.");
    });
  });
});

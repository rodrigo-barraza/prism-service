import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "../src/constants.ts";

// ── Mocks ─────────────────────────────────────────────────────

const mockRunAgenticLoop = vi.fn().mockImplementation(async (params: AgenticContext) => {
  const { emit } = params;
  if (emit) {
    emit({ type: "thinking", content: "Agent is thinking..." });
    emit({ type: "chunk", content: "Initial result content" });
    emit({
      type: "done",
      usage: { inputTokens: 5, outputTokens: 10 },
      estimatedCost: 0.001,
      tokensPerSec: 100,
    });
  }
  return {
    messages: [
      { role: "user", content: "Start task" },
      { role: "assistant", content: "Initial result content" },
    ],
  };
});

vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

// Mock GitWorktreeHelper
const mockCreateWorktree = vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-mock" });
const mockRemoveWorktree = vi.fn().mockResolvedValue({});
const mockMergeWorktree = vi.fn().mockResolvedValue({ success: true });
const mockGetWorktreeDiff = vi.fn().mockResolvedValue({
  hasChanges: true,
  additions: 10,
  deletions: 2,
  files: ["changed.txt"],
});
const mockToolsApiPost = vi.fn().mockResolvedValue({});

vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: () => "/workspace",
    resolveRepositoryPath: () => "/workspace/repo",
    createWorktree: (...args: unknown[]) => mockCreateWorktree(...args),
    removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
    mergeWorktree: (...args: unknown[]) => mockMergeWorktree(...args),
    getWorktreeDiff: (...args: unknown[]) => mockGetWorktreeDiff(...args),
    toolsApiPost: (...args: unknown[]) => mockToolsApiPost(...args),
    cleanupWorktrees: vi.fn().mockResolvedValue({}),
  },
}));

// Mock SettingsService
vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    getSection: vi.fn().mockResolvedValue({
      subagentProvider: PROVIDERS.GOOGLE,
      subagentModel: "gemini-3.5-flash",
      topology: "hierarchical",
    }),
  },
}));

import OrchestratorService from "../src/services/OrchestratorService.ts";
import { GitWorktreeHelper } from "../src/services/orchestrator/GitWorktreeHelper.ts";
import { SubAgentTelemetryEmitter } from "../src/services/orchestrator/SubAgentTelemetryEmitter.ts";
import { HierarchicalRouter } from "../src/services/orchestrator/routers/HierarchicalRouter.ts";
import { SequentialRouter } from "../src/services/orchestrator/routers/SequentialRouter.ts";
import { PeerToPeerRouter } from "../src/services/orchestrator/routers/PeerToPeerRouter.ts";
import { InstanceLoadBalancer } from "../src/services/orchestrator/InstanceLoadBalancer.ts";
import type { InstanceEntry } from "../src/types/ProviderTypes.ts";
import type { AgenticContext } from "../src/services/harnesses/types.ts";
import type { OrchestratorContext, SubAgentResult, SubAgentState } from "../src/types/orchestrator.ts";

describe("Sub-Agent Intensive Integration Tests", () => {
  async function waitForCondition(condition: () => boolean, timeoutMilliseconds = 10000): Promise<void> {
    const startTime = Date.now();
    while (!condition()) {
      if (Date.now() - startTime > timeoutMilliseconds) {
        throw new Error(`Timed out waiting for condition after ${timeoutMilliseconds}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  let orchestratorContext: OrchestratorContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAgenticLoop.mockClear();
    mockCreateWorktree.mockClear();
    mockRemoveWorktree.mockClear();
    mockMergeWorktree.mockClear();
    mockGetWorktreeDiff.mockClear();
    mockToolsApiPost.mockClear();

    // Reset the global orchestrator registry to guarantee test isolation
    OrchestratorService.cleanupSession("session-id-def");
    OrchestratorService.clearAllActiveSubAgents();
    InstanceLoadBalancer.getReservations().clear();

    // Default mock implementation
    mockRunAgenticLoop.mockImplementation(async (params: AgenticContext) => {
      const { emit } = params;
      if (emit) {
        emit({ type: "thinking", content: "Thinking..." });
        emit({ type: "chunk", content: "Final task output" });
        emit({
          type: "done",
          usage: { inputTokens: 5, outputTokens: 10 },
          estimatedCost: 0.001,
          tokensPerSec: 100,
        });
      }
      return {
        messages: [{ role: "assistant", content: "Final task output" }],
      };
    });

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-id-abc",
      agentConversationId: "session-id-def",
      conversationId: "conv-id-ghi",
      maxRecursionDepth: 2,
      emit: vi.fn(),
    };
  });

  // ── 1. Parallelism & Concurrency ────────────────────────────
  describe("Parallelism & Concurrency Limits", () => {
    it("should execute multiple team members in parallel and collect all results", async () => {
      let activeLoopCount = 0;
      let peakConcurrencyCount = 0;
      const concurrencyBarrierPromises: { resolve: () => void; reject: (error: Error) => void }[] = [];

      mockRunAgenticLoop.mockImplementation(async () => {
        activeLoopCount++;
        peakConcurrencyCount = Math.max(peakConcurrencyCount, activeLoopCount);

        if (activeLoopCount === 3) {
          for (const promiseRegistration of concurrencyBarrierPromises) {
            promiseRegistration.resolve();
          }
        } else {
          await new Promise<void>((resolveFunction, rejectFunction) => {
            const barrierTimeoutId = setTimeout(() => {
              rejectFunction(new Error("Barrier timeout: concurrent execution did not reach 3 agents."));
            }, 2000);

            concurrencyBarrierPromises.push({
              resolve: () => {
                clearTimeout(barrierTimeoutId);
                resolveFunction();
              },
              reject: (error) => {
                clearTimeout(barrierTimeoutId);
                rejectFunction(error);
              },
            });
          });
        }

        activeLoopCount--;
        return {
          messages: [{ role: "assistant", content: "Parallel output" }],
        };
      });

      const teamArgs = {
        name: "concurrency_test",
        topology: "hierarchical",
        members: [
          { description: "Task A", prompt: "Do A" },
          { description: "Task B", prompt: "Do B" },
          { description: "Task C", prompt: "Do C" },
        ],
      };

      const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      // Wait for non-blocking background sub-agent loops to complete
      await waitForCondition(() => mockRunAgenticLoop.mock.calls.length === 3 && activeLoopCount === 0);

      expect(results).toHaveLength(3);
      expect(peakConcurrencyCount).toBe(3); // Assert all 3 executed at the same time
      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(3);

      for (const result of results) {
        // Non-blocking spawns return status="running" immediately
        expect("status" in result && result.status).toBe("running");
      }
    });
  });

  // ── 2. Telemetry & SSE Event Emission ────────────────────────
  describe("Sub-Agent Telemetry & Event Emission", () => {
    it("should capture and properly route granular telemetry events to the parent", async () => {
      const parentEmitMock = vi.fn();
      const telemetry = new SubAgentTelemetryEmitter({
        subAgentId: "agent-123",
        subAgentDescription: "Test Telemetry",
        parentEmit: parentEmitMock,
        parentConversationId: "parent-session-456",
      });

      const emitFn = telemetry.createEmitFunction();

      // Emit Phase transition to thinking
      emitFn({ type: "thinking", content: "Thinking..." });
      expect(parentEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          subAgentId: "agent-123",
          message: "phase",
          phase: "thinking",
        })
      );

      // Emit output chunk
      emitFn({ type: "chunk", content: "Part 1 of output" });
      expect(parentEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          subAgentId: "agent-123",
          message: "phase",
          phase: "generating",
        })
      );

      // Emit tool execution
      emitFn({
        type: "tool_execution",
        status: "calling",
        tool: { id: "call-99", name: "read_file", args: { path: "test.js" } },
      });
      expect(parentEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_tool_execution",
          subAgentId: "agent-123",
          status: "calling",
          tool: expect.objectContaining({ name: "read_file" }),
        })
      );

      // Emit tool output
      emitFn({
        type: "tool_output",
        toolCallId: "call-99",
        name: "read_file",
        event: { type: "tool_output" },
        data: { text: "some code" },
      });
      expect(parentEmitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_tool_output",
          subAgentId: "agent-123",
          toolCallId: "call-99",
          name: "read_file",
          data: expect.objectContaining({ text: "some code" }),
        })
      );

      // Emit Done/complete
      emitFn({
        type: "done",
        usage: { inputTokens: 200, outputTokens: 300, totalTokens: 500 },
        estimatedCost: 0.0015,
        tokensPerSec: 60,
      });

      expect(telemetry.totalCost).toBe(0.0015);
      expect(telemetry.usage).toEqual({ inputTokens: 200, outputTokens: 300, totalTokens: 500 });
    });
  });

  // ── 3. Worktree Cleanup ─────────────────────────────────────
  describe("Worktree Cleanup Scenarios", () => {
    it("should remove worktree on successful completion", async () => {
      const result = await OrchestratorService.spawnFromTool({
        description: "Normal sub-agent",
        prompt: "Run success route",
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(result.error).toBeUndefined();
      expect(mockRemoveWorktree).toHaveBeenCalled();
    });

    it("should remove worktree on loop failure/throwing", async () => {
      mockRunAgenticLoop.mockRejectedValueOnce(new Error("Agentic loop fatal error"));

      const result = await OrchestratorService.spawnFromTool({
        description: "Failing sub-agent",
        prompt: "Throw error route",
        orchestratorContext,
      awaitCompletion: true,
      });

      expect("status" in result && result.status).toBe("failed");
      expect(mockRemoveWorktree).toHaveBeenCalled();
    });

    it("should remove worktree on stopAgent explicit call", async () => {
      // Setup a running sub-agent by delaying its execution
      let resolveLoop!: (value: unknown) => void;
      const loopPromise = new Promise((resolve) => {
        resolveLoop = resolve;
      });

      mockRunAgenticLoop.mockImplementationOnce(async () => {
        await loopPromise;
        return { messages: [] };
      });

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Running sub-agent to be stopped",
        prompt: "Infinite run",
        orchestratorContext,
      awaitCompletion: true,
      });

      // Allow setup to progress
      await waitForCondition(() => OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      }).length > 0);

      const activeList = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      expect(activeList.length).toBeGreaterThan(0);
      const subAgentId = activeList[0].agentId;

      // Invoke stop
      const stopResult = await OrchestratorService.stopAgent(subAgentId);
      expect("status" in stopResult && stopResult.status).toBe("stopped");

      // Verify GitWorktreeHelper.removeWorktree was invoked
      expect(mockRemoveWorktree).toHaveBeenCalled();

      // Resolve the loop to prevent dangling promises
      resolveLoop({ messages: [] });
      await spawnPromise;
    });
  });

  // ── 4. Follow-up / Message Routing ──────────────────────────
  describe("Follow-up / Message Routing", () => {
    it("should route follow-up message to the correct sub-agent and preserve context", async () => {
      const result = await OrchestratorService.spawnFromTool({
        description: "Original subagent",
        prompt: "Original prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      const agentId = (result as SubAgentResult).agent_id;
      expect(agentId).toBeDefined();

      // Clear loops mock
      mockRunAgenticLoop.mockClear();

      // Call sendMessage
      const followUpRes = await OrchestratorService.sendMessage(
        agentId,
        "Here is follow-up instructions",
        orchestratorContext
      );

      expect("status" in followUpRes && followUpRes.status).toBe("running");

      // Wait for loop to be run again with the follow-up
      await waitForCondition(() => mockRunAgenticLoop.mock.calls.length >= 1);

      // Verify loop was run again with the follow-up
      expect(mockRunAgenticLoop).toHaveBeenCalled();
      const callArgs = mockRunAgenticLoop.mock.calls[0][0];
      expect(callArgs.messages.some((message: { content?: string }) => message.content && message.content.includes("Here is follow-up instructions"))).toBe(true);
    });

    it("should queue follow-up messages if the sub-agent is currently running", async () => {
      let resolveLoop!: (value: unknown) => void;
      const loopPromise = new Promise((resolve) => {
        resolveLoop = resolve;
      });

      mockRunAgenticLoop.mockImplementationOnce(async () => {
        await loopPromise;
        return { messages: [] };
      });

      // Launch spawnFromTool without awaiting it to avoid blocking the test
      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Sub-agent that runs slowly",
        prompt: "Slow prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      // Give spawnFromTool a moment to register the agent and call _runSubAgentLoop
      await waitForCondition(() => OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      }).some((agent) => agent.description === "Sub-agent that runs slowly"));

      const activeList = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      const matchingAgent = activeList.find((a) => a.description === "Sub-agent that runs slowly");
      expect(matchingAgent).toBeDefined();
      const agentId = matchingAgent!.agentId;

      // Send a follow-up while it is still running
      const queueRes = await OrchestratorService.sendMessage(
        agentId,
        "Queue this follow-up",
        orchestratorContext
      );

      expect("status" in queueRes && queueRes.status).toBe("message_queued");

      // Resolve the original loop so that spawnPromise resolves
      resolveLoop({ messages: [] });
      await spawnPromise;
    });
  });

  // ── 5. Sequential Topology Robustness ──────────────────────
  describe("Sequential Router Robustness", () => {
    it("should abort sequential routing if any step fails", async () => {
      const sequentialRouter = new SequentialRouter();
      const members = [
        { description: "Step 1", prompt: "Prompt 1" },
        { description: "Step 2", prompt: "Prompt 2" },
      ];

      const spawnMock = vi.fn()
        .mockResolvedValueOnce({
          status: "failed",
          error: "First step failed",
        });

      const results = await sequentialRouter.execute(
        "seq_abort_team",
        members,
        orchestratorContext,
        spawnMock
      );

      expect(results).toHaveLength(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect("status" in results[0] && results[0].status).toBe("failed");
    });

    it("should abort sequential routing if worktree merge fails", async () => {
      const sequentialRouter = new SequentialRouter();
      const members = [
        { description: "Step 1", prompt: "Prompt 1" },
        { description: "Step 2", prompt: "Prompt 2" },
      ];

      // Simulate git merge conflict on step 1
      mockMergeWorktree.mockResolvedValueOnce({ error: "Git merge conflict details" });

      const spawnMock = vi.fn().mockImplementation(async (assignment) => {
        return {
          agent_id: "agent-1",
          description: assignment.description || "",
          status: "completed",
          result: "Step completed",
          summary: "Done",
          toolUses: 1,
          durationMilliseconds: 50,
          iterations: 1,
          messages: [],
          diff: {
            additions: 1,
            deletions: 0,
            files: ["test.txt"],
          },
        };
      });

      const results = await sequentialRouter.execute(
        "seq_merge_fail_team",
        members,
        orchestratorContext,
        spawnMock
      );

      expect(results).toHaveLength(2);
      expect("error" in results[1]).toBe(true);
      expect((results[1] as { error: string }).error).toContain("Failed to merge branch");
    });
  });

  // ── 6. Peer-To-Peer Router Robustness ───────────────────────
  describe("Peer-To-Peer Router Robustness", () => {
    it("should terminate early when [DONE] is returned by a member", async () => {
      const p2pRouter = new PeerToPeerRouter();
      const members = [
        { agent: "Writer", description: "Write poem", prompt: "Write poem" },
        { agent: "Critic", description: "Review poem", prompt: "Review poem" },
      ];

      const spawnMock = vi.fn()
        .mockResolvedValueOnce({
          agent_id: "writer-agent",
          status: "completed",
          result: "Here is the poem",
          summary: "Poem drafted",
          toolUses: 0,
          iterations: 1,
          messages: [],
        })
        .mockResolvedValueOnce({
          agent_id: "critic-agent",
          status: "completed",
          result: "Looks perfect. [DONE]",
          summary: "Done reviewing",
          toolUses: 0,
          iterations: 1,
          messages: [],
        });

      const results = await p2pRouter.execute(
        "p2p_done_team",
        members,
        orchestratorContext,
        spawnMock
      );

      // Verify execution stopped after the second call (due to [DONE] tag)
      expect(results).toHaveLength(2);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("should fail debate if merge conflict happens during round-robin transitions", async () => {
      const p2pRouter = new PeerToPeerRouter();
      const members = [
        { agent: "Arguer1", description: "Pro", prompt: "Pro arguments" },
        { agent: "Arguer2", description: "Con", prompt: "Con arguments" },
      ];

      // Simulate git merge conflict
      mockMergeWorktree.mockResolvedValueOnce({ error: "Git merge conflict details" });

      const spawnMock = vi.fn().mockImplementation(async (assignment) => {
        return {
          agent_id: "agent-arg",
          description: assignment.description || "",
          status: "completed",
          result: "Point made.",
          summary: "Done",
          toolUses: 1,
          durationMilliseconds: 50,
          iterations: 1,
          messages: [],
          diff: {
            additions: 1,
            deletions: 0,
            files: ["test.txt"],
          },
        };
      });

      const results = await p2pRouter.execute(
        "p2p_merge_fail_team",
        members,
        orchestratorContext,
        spawnMock
      );

      expect(results).toHaveLength(2);
      expect("error" in results[1]).toBe(true);
      expect((results[1] as { error: string }).error).toContain("Failed to merge branch");
    });
  });

  // ── 7. Team Deletion Scenarios ──────────────────────────────────
  describe("Team Deletion Scenarios", () => {
    it("should abort running team members, release reservations, clean up worktrees, and delete from active registry", async () => {
      let resolveFirstLoop: (value: unknown) => void = () => {};
      let resolveSecondLoop: (value: unknown) => void = () => {};

      const firstLoopPromise = new Promise((resolve) => {
        resolveFirstLoop = resolve;
      });
      const secondLoopPromise = new Promise((resolve) => {
        resolveSecondLoop = resolve;
      });

      let loopCount = 0;
      mockRunAgenticLoop.mockImplementation(async () => {
        loopCount++;
        if (loopCount === 1) {
          await firstLoopPromise;
        } else {
          await secondLoopPromise;
        }
        return { messages: [] };
      });

      const firstSpawnPromise = OrchestratorService.spawnFromTool({
        description: "Team member one",
        prompt: "Task one",
        orchestratorContext,
      awaitCompletion: true,
      });

      const secondSpawnPromise = OrchestratorService.spawnFromTool({
        description: "Team member two",
        prompt: "Task two",
        orchestratorContext,
      awaitCompletion: true,
      });

      // Give spawn calls a brief moment to run and register the sub-agents
      await waitForCondition(() => OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      }).length === 2);

      const activeSubAgentsList = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      expect(activeSubAgentsList).toHaveLength(2);

      const deleteResult = await OrchestratorService.deleteTeam("my-test-team", orchestratorContext);
      expect(deleteResult).toEqual({
        name: "my-test-team",
        deleted: true,
        subAgentsAborted: 2,
      });

      // Verify worktrees were cleaned up and active agents deleted from the registry
      expect(mockRemoveWorktree).toHaveBeenCalledTimes(2);
      const postDeleteList = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      expect(postDeleteList).toHaveLength(0);

      // Resolve loops to avoid dangling promises
      resolveFirstLoop({ messages: [] });
      resolveSecondLoop({ messages: [] });

      await firstSpawnPromise;
      await secondSpawnPromise;
    });
  });

  // ── 8. Conversation-level Abort Scenarios ───────────────────────
  describe("Conversation-level Abort Scenarios", () => {
    it("should abort running sub-agents for a specific conversation, clean up worktrees, but keep them in the registry as stopped", async () => {
      let resolveLoop: (value: unknown) => void = () => {};
      const loopPromise = new Promise((resolve) => {
        resolveLoop = resolve;
      });

      mockRunAgenticLoop.mockImplementationOnce(async () => {
        await loopPromise;
        return { messages: [] };
      });

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Conversation sub-agent",
        prompt: "Running tasks",
        orchestratorContext,
      awaitCompletion: true,
      });

      // Allow registration to proceed
      await waitForCondition(() => OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      }).length === 1);

      const activeListBeforeAbort = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      expect(activeListBeforeAbort).toHaveLength(1);
      expect(activeListBeforeAbort[0].status).toBe("running");

      await OrchestratorService.abortSubAgentsByConversation(orchestratorContext.conversationId!);

      expect(mockRemoveWorktree).toHaveBeenCalled();

      const activeListAfterAbort = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      expect(activeListAfterAbort).toHaveLength(1);
      expect(activeListAfterAbort[0].status).toBe("stopped");

      resolveLoop({ messages: [] });
      await spawnPromise;
    });
  });

  // ── 9. Concurrency Limits ───────────────────────────────────────
  describe("Maximum Concurrency Constraints", () => {
    it("should prevent spawning more than the maximum limit of concurrent sub-agents", async () => {
      const loopResolvers: Array<(value: unknown) => void> = [];

      mockRunAgenticLoop.mockImplementation(async () => {
        const loopPromise = new Promise((resolve) => {
          loopResolvers.push(resolve);
        });
        await loopPromise;
        return { messages: [] };
      });

      const spawnPromises = [];
      for (let index = 0; index < 10; index++) {
        spawnPromises.push(
          OrchestratorService.spawnFromTool({
            description: `Concurrent Agent ${index}`,
            prompt: `Task ${index}`,
            orchestratorContext,
      awaitCompletion: true,
          })
        );
      }

      // Allow all spawns to register and start running
      await waitForCondition(() => loopResolvers.length === 10);

      const activeList = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      expect(activeList).toHaveLength(10);
      for (const activeAgent of activeList) {
        expect(activeAgent.status).toBe("running");
      }

      // Try to spawn the 11th agent
      const overflowSpawnResult = await OrchestratorService.spawnFromTool({
        description: "Over the limit agent",
        prompt: "This should fail",
        orchestratorContext,
      awaitCompletion: true,
      });

      expect(overflowSpawnResult).toEqual({
        error: "Maximum concurrent sub-agents (10) reached. Wait for a sub-agent to complete or stop one.",
      });

      // Clean up: resolve all loops to finalize execution
      for (const resolver of loopResolvers) {
        resolver({ messages: [] });
      }

      await Promise.all(spawnPromises);
    });
  });

  // ── 10. Task Output Retrieval Scenarios ──────────────────────────
  describe("Task Output Retrieval Scenarios", () => {
    it("should return correct structures for non-existent, running, and completed sub-agents", async () => {
      // 1. Non-existent agent
      const nonExistentResult = OrchestratorService.getTaskOutput("invalid-agent-id");
      expect("error" in nonExistentResult && nonExistentResult.error).toContain("not found");

      // 2. Running agent
      let resolveLoop: (value: unknown) => void = () => {};
      const loopPromise = new Promise((resolve) => {
        resolveLoop = resolve;
      });

      mockRunAgenticLoop.mockImplementationOnce(async () => {
        await loopPromise;
        return {
          messages: [{ role: "assistant", content: "Some intermediate results" }],
        };
      });

      const spawnPromise = OrchestratorService.spawnFromTool({
        description: "Task output tester",
        prompt: "Output test prompt",
        orchestratorContext,
      awaitCompletion: true,
      });

      // Allow registration to proceed
      await waitForCondition(() => OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      }).length === 1);

      const activeList = OrchestratorService.listSubAgents({
        parentConversationId: orchestratorContext.conversationId!,
      });
      const agentId = activeList[0].agentId;

      const runningOutput = OrchestratorService.getTaskOutput(agentId);
      expect(runningOutput).toEqual(
        expect.objectContaining({
          agent_id: agentId,
          status: "running",
          description: "Task output tester",
        })
      );

      // 3. Completed agent
      resolveLoop({
        messages: [{ role: "assistant", content: "Final task completed successfully" }],
      });
      await spawnPromise;

      const completedOutput = OrchestratorService.getTaskOutput(agentId);
      expect(completedOutput).toEqual(
        expect.objectContaining({
          agent_id: agentId,
          status: "completed",
        })
      );
    });
  });

  // ── 11. Instance Load Balancer ───────────────────────────────────
  describe("Instance Load Balancer Constraints", () => {
    function createMockSubAgentState(overrides: Partial<SubAgentState>): SubAgentState {
      return {
        agentId: "mock-agent",
        subAgentConversationId: "mock-convo",
        parentAgentConversationId: "mock-parent-convo",
        description: "Mock sub-agent",
        branchName: null,
        worktreePath: null,
        repositoryPath: "/home/rodrigo/development",
        isolated: false,
        status: "idle",
        output: "",
        toolCalls: [],
        diff: null,
        error: null,
        startedAt: Date.now(),
        durationMilliseconds: 0,
        totalCost: null,
        usage: null,
        abortController: null,
        messages: null,
        files: [],
        project: "test-project",
        username: "test-user",
        agent: null,
        providerName: PROVIDERS.GOOGLE,
        resolvedModel: "gemini-3-flash-preview",
        traceId: null,
        maxIterations: 25,
        minContextLength: null,
        parentConversationId: "mock-parent-convo",
        ...overrides,
      };
    }

    beforeEach(() => {
      InstanceLoadBalancer.getReservations().clear();
    });

    it("should calculate correct active count combining reservations and active sub-agents", () => {
      const activeSubAgentsMap = new Map() as Map<string, SubAgentState>;
      activeSubAgentsMap.set("agent-one", createMockSubAgentState({
        providerName: "local-gpu-1",
        status: "running",
      }));
      activeSubAgentsMap.set("agent-two", createMockSubAgentState({
        providerName: "local-gpu-1",
        status: "complete",
      }));
      activeSubAgentsMap.set("agent-three", createMockSubAgentState({
        providerName: "local-gpu-2",
        status: "running",
      }));

      expect(InstanceLoadBalancer.getActiveOn("local-gpu-1", activeSubAgentsMap)).toBe(1);
      expect(InstanceLoadBalancer.getActiveOn("local-gpu-2", activeSubAgentsMap)).toBe(1);

      InstanceLoadBalancer.getReservations().set("local-gpu-1", 2);
      expect(InstanceLoadBalancer.getActiveOn("local-gpu-1", activeSubAgentsMap)).toBe(3);

      InstanceLoadBalancer.releaseReservation("local-gpu-1");
      expect(InstanceLoadBalancer.getActiveOn("local-gpu-1", activeSubAgentsMap)).toBe(2);
    });

    it("should prioritize orchestrator instance and perform capacity-based selection when slots are available", () => {
      const activeSubAgentsMap = new Map() as Map<string, SubAgentState>;
      const siblingInstances = [
        { id: "local-gpu-1", concurrency: 2 },
        { id: "local-gpu-2", concurrency: 2 },
      ] as unknown as InstanceEntry[];

      const modelOverrides = new Map<string, string>();

      const firstAssignment = InstanceLoadBalancer.selectAndReserveInstance(
        siblingInstances,
        "local-gpu-2",
        modelOverrides,
        "gemini-3.5-flash",
        activeSubAgentsMap
      );

      expect(firstAssignment).toEqual({
        provider: "local-gpu-2",
        model: "gemini-3.5-flash",
        slotsAvailable: 2,
      });

      expect(InstanceLoadBalancer.getReservations().get("local-gpu-2")).toBe(1);

      const secondAssignment = InstanceLoadBalancer.selectAndReserveInstance(
        siblingInstances,
        "local-gpu-1",
        modelOverrides,
        "gemini-3.5-flash",
        activeSubAgentsMap
      );

      expect(secondAssignment).toEqual({
        provider: "local-gpu-1",
        model: "gemini-3.5-flash",
        slotsAvailable: 2,
      });

      expect(InstanceLoadBalancer.getReservations().get("local-gpu-1")).toBe(1);
    });

    it("should fallback to least-loaded overflow instance when all instances are at capacity", () => {
      const activeSubAgentsMap = new Map() as Map<string, SubAgentState>;
      const siblingInstances = [
        { id: "local-gpu-1", concurrency: 1 },
        { id: "local-gpu-2", concurrency: 1 },
      ] as unknown as InstanceEntry[];

      const modelOverrides = new Map<string, string>();

      InstanceLoadBalancer.getReservations().set("local-gpu-1", 1);
      activeSubAgentsMap.set("agent-one", createMockSubAgentState({
        providerName: "local-gpu-2",
        status: "running",
      }));

      InstanceLoadBalancer.getReservations().set("local-gpu-1", 2);

      const assignment = InstanceLoadBalancer.selectAndReserveInstance(
        siblingInstances,
        "local-gpu-1",
        modelOverrides,
        "gemini-3.5-flash",
        activeSubAgentsMap
      );

      expect(assignment?.provider).toBe("local-gpu-2");
      expect(InstanceLoadBalancer.getReservations().get("local-gpu-2")).toBe(1);
    });

    it("should apply model overrides accurately when specified", () => {
      const activeSubAgentsMap = new Map() as Map<string, SubAgentState>;
      const siblingInstances = [
        { id: "local-gpu-1", concurrency: 2 },
      ] as unknown as InstanceEntry[];

      const modelOverrides = new Map<string, string>([
        ["local-gpu-1", "gemini-3.5-flash-quantized"],
      ]);

      const assignment = InstanceLoadBalancer.selectAndReserveInstance(
        siblingInstances,
        "local-gpu-1",
        modelOverrides,
        "gemini-3.5-flash",
        activeSubAgentsMap
      );

      expect(assignment).toEqual({
        provider: "local-gpu-1",
        model: "gemini-3.5-flash-quantized",
        slotsAvailable: 2,
      });
    });
  });
});

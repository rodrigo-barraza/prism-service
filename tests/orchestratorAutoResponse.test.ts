import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "../src/constants.ts";

// ── vi.mock blocks (must come before imports that use them) ────────────

const mockRunAgenticLoop = vi.fn().mockResolvedValue({
  messages: [{ role: "assistant", content: "Mock sub-agent output" }],
});

vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

vi.mock("../src/services/orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    toolsApiPost: vi.fn().mockResolvedValue({}),
    createWorktree: vi.fn().mockResolvedValue({ worktreePath: "/workspace/worktree-1" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    getWorktreeDiff: vi.fn().mockResolvedValue({
      hasChanges: false,
      additions: 0,
      deletions: 0,
      files: [],
    }),
    cleanupWorktrees: vi.fn().mockResolvedValue({}),
  },
}));

// ── Imports (after vi.mock) ───────────────────────────────────

import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import ConversationService from "../src/services/ConversationService.ts";
import OrchestratorService from "../src/services/OrchestratorService.ts";
import { GitWorktreeHelper } from "../src/services/orchestrator/GitWorktreeHelper.ts";
import type { OrchestratorContext, SubAgentResult } from "../src/types/orchestrator.ts";

// ── Helpers ───────────────────────────────────────────────────

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();

function cleanAllConversations() {
  for (const conversationId of [
    "session-id-456", "root-conv", "parent-conv-id",
  ]) {
    OrchestratorService.cleanupConversation(conversationId);
  }
  for (let index = 0; index < 15; index++) {
    OrchestratorService.cleanupConversation(`session-id-456-${index}`);
  }
}

async function waitForMockCalls(
  mock: ReturnType<typeof vi.fn>,
  expectedCalls: number,
  timeoutMs = 5000,
): Promise<void> {
  const startTime = Date.now();
  while (mock.mock.calls.length < expectedCalls) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(
        `Timed out waiting for mock to be called ${expectedCalls} times (got ${mock.mock.calls.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── Test Suite ────────────────────────────────────────────────

describe("Event-Driven Auto-Response", () => {
  let orchestratorContext: OrchestratorContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockResolvedValue({
      messages: [{ role: "assistant", content: "Mock sub-agent output" }],
    });

    mockFindOne.mockReset();
    mockUpdateOne.mockReset();
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });

    // Enable MongoWrapper mocks for auto-response (setup.ts defaults them to null)
    vi.mocked(MongoWrapper.getDb).mockReturnValue({} as any);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: (...args: unknown[]) => mockFindOne(...args),
      updateOne: (...args: unknown[]) => mockUpdateOne(...args),
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      insertOne: vi.fn().mockResolvedValue({ insertedId: "mock-id" }),
    } as any);

    vi.mocked(GitWorktreeHelper.createWorktree).mockResolvedValue({ worktreePath: "/workspace/worktree-1" });
    vi.mocked(GitWorktreeHelper.removeWorktree).mockResolvedValue({});
    vi.mocked(GitWorktreeHelper.getWorktreeDiff).mockResolvedValue({
      hasChanges: false,
      additions: 0,
      deletions: 0,
      files: [],
    });

    cleanAllConversations();

    orchestratorContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3-flash-preview",
      traceId: "trace-id-123",
      agentConversationId: "session-id-456",
      conversationId: "parent-conv-id",
      enabledTools: ["read_file", "write_file", "search_web"],
      maxRecursionDepth: 2,
      emit: vi.fn(),
    };
  });

  afterEach(() => {
    cleanAllConversations();
    vi.restoreAllMocks();
  });

  // ── _notifyParentOfRouterCompletion ──────────────────────────

  describe("_notifyParentOfRouterCompletion", () => {
    it("should build a completion message and trigger auto-response with ephemeral context", async () => {
      const routerResults: SubAgentResult[] = [
        {
          agent_id: "agent-1",
          description: "Research agent",
          status: "completed",
          summary: "Found 3 relevant papers",
          result: "Paper A, Paper B, Paper C",
          toolUses: 5,
          iterations: 2,
          durationMs: 12000,
          messages: [],
        },
        {
          agent_id: "agent-2",
          description: "Coding agent",
          status: "completed",
          summary: "Implemented feature",
          result: "Feature implemented successfully",
          toolUses: 10,
          iterations: 4,
          durationMs: 30000,
          messages: [],
        },
      ];

      // Parent is idle → auto-response will be attempted
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [
          { role: "user", content: "Build me a feature" },
          { role: "assistant", content: "I'll spawn sub-agents" },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      await OrchestratorService._notifyParentOfRouterCompletion(
        "research_team",
        "hierarchical",
        routerResults,
        orchestratorContext,
      );

      // Wait for auto-response agentic loop to be invoked
      await waitForMockCalls(mockRunAgenticLoop, 1);

      // Notification is NOT persisted to DB via $push — it's ephemeral
      const hasPushCall = mockUpdateOne.mock.calls.some(
        (call) => call[1] && call[1].$push?.messages,
      );
      expect(hasPushCall).toBe(false);

      // Verify auto-response received the completion message as ephemeral context
      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      const lastMessage = loopArgs.messages.at(-1);
      expect(lastMessage.role).toBe("user");
      expect(lastMessage.content).toContain("<task-notification>");
      expect(lastMessage.content).toContain("</task-notification>");
      expect(lastMessage.content).toContain("[SUB-AGENT TEAM COMPLETED]");
      expect(lastMessage.content).toContain("research_team");
      expect(lastMessage.content).toContain("hierarchical");
      expect(lastMessage.content).toContain("Research agent");
      expect(lastMessage.content).toContain("Paper A, Paper B, Paper C");
      expect(lastMessage.content).toContain("Coding agent");
      expect(lastMessage.content).toContain("Feature implemented successfully");
      expect(lastMessage._alreadyPersisted).toBe(true);
    });

    it("should include error details for failed sub-agents in ephemeral context", async () => {
      const routerResults: (SubAgentResult | { error: string })[] = [
        {
          agent_id: "agent-1",
          description: "Success agent",
          status: "completed",
          summary: "Done",
          result: "Output",
          toolUses: 1,
          iterations: 1,
          durationMs: 5000,
          messages: [],
        },
        { error: "Agent crashed: out of memory" },
      ];

      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [],
        settings: { provider: PROVIDERS.GOOGLE, model: "gemini-3-flash-preview" },
      });

      await OrchestratorService._notifyParentOfRouterCompletion(
        "mixed_team",
        "sequential",
        routerResults,
        orchestratorContext,
      );

      await waitForMockCalls(mockRunAgenticLoop, 1);

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      const lastMessage = loopArgs.messages.at(-1);
      expect(lastMessage.content).toContain("✅");
      expect(lastMessage.content).toContain("❌");
      expect(lastMessage.content).toContain("Agent crashed: out of memory");
    });

    it("should truncate very long sub-agent output to prevent context bloat", async () => {
      const longOutput = "A".repeat(5000);
      const routerResults: SubAgentResult[] = [
        {
          agent_id: "agent-verbose",
          description: "Verbose agent",
          status: "completed",
          summary: "Very long output",
          result: longOutput,
          toolUses: 1,
          iterations: 1,
          durationMs: 1000,
          messages: [],
        },
      ];

      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [],
        settings: { provider: PROVIDERS.GOOGLE, model: "gemini-3-flash-preview" },
      });

      await OrchestratorService._notifyParentOfRouterCompletion(
        "verbose_team",
        "hierarchical",
        routerResults,
        orchestratorContext,
      );

      await waitForMockCalls(mockRunAgenticLoop, 1);

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      const lastMessage = loopArgs.messages.at(-1);
      expect(lastMessage.content).toContain("(truncated)");
      expect(lastMessage.content.length).toBeLessThan(longOutput.length);
    });

    it("should not crash when auto-response fails", async () => {
      mockFindOne.mockResolvedValue(null);

      await expect(
        OrchestratorService._notifyParentOfRouterCompletion(
          "failing_team",
          "hierarchical",
          [{
            agent_id: "a1", description: "A", status: "completed",
            summary: "", result: "x", toolUses: 0, iterations: 0,
            durationMs: 0, messages: [],
          }],
          orchestratorContext,
        ),
      ).resolves.not.toThrow();
    });

    it("should skip notification when conversationId is missing", async () => {
      const incompleteContext = { ...orchestratorContext, conversationId: "" };

      await OrchestratorService._notifyParentOfRouterCompletion(
        "team", "hierarchical", [], incompleteContext,
      );

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    });
  });

  // ── _triggerParentAutoResponse ────────────────────────────────

  describe("_triggerParentAutoResponse", () => {
    const completionMessage = {
      role: "user" as const,
      content: "<task-notification>\n[SUB-AGENT TEAM COMPLETED] Team finished.\n</task-notification>",
      timestamp: new Date().toISOString(),
      _alreadyPersisted: true,
    };

    it("should trigger an agentic loop when the parent is idle", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [
          { role: "user", content: "Build me a feature" },
          { role: "assistant", content: "I spawned sub-agents" },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
        title: "Feature Request",
        traceId: "trace-abc",
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArgs.conversationId).toBe("parent-conv-id");
      expect(loopArgs.project).toBe("test-project");
      expect(loopArgs.username).toBe("test-user");
      expect(loopArgs.providerName).toBe(PROVIDERS.GOOGLE);
      expect(loopArgs.resolvedModel).toBe("gemini-3-flash-preview");
      expect(loopArgs.options.agenticLoopEnabled).toBe(true);
      expect(loopArgs.options.autoApprove).toBe(true);

      // Messages = conversation history + completion notification
      expect(loopArgs.messages).toHaveLength(3);
      expect(loopArgs.messages[0].content).toBe("Build me a feature");
      expect(loopArgs.messages[1].content).toBe("I spawned sub-agents");
      expect(loopArgs.messages[2].content).toContain("SUB-AGENT TEAM COMPLETED");
    });

    it("should include user messages sent while sub-agents were running", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [
          { role: "user", content: "Build me a feature" },
          { role: "assistant", content: "I spawned sub-agents" },
          { role: "user", content: "Also check error handling" },
          { role: "assistant", content: "Noted, I'll include that" },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArgs.messages).toHaveLength(5);
      expect(loopArgs.messages[2].content).toBe("Also check error handling");
      expect(loopArgs.messages[3].content).toBe("Noted, I'll include that");
      expect(loopArgs.messages[4].content).toContain("SUB-AGENT TEAM COMPLETED");
    });

    it("should always append ephemeral completion message to context since it is never in DB", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [
          { role: "user", content: "Build me a feature" },
          { role: "assistant", content: "I spawned sub-agents" },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      // 2 DB messages + 1 ephemeral completion
      expect(loopArgs.messages).toHaveLength(3);
      expect(loopArgs.messages.at(-1).content).toContain("SUB-AGENT TEAM COMPLETED");
      expect(loopArgs.messages.at(-1)._alreadyPersisted).toBe(true);
    });

    it("should wait for parent to finish generating before auto-response", async () => {
      // First findOne returns isGenerating: true (initial load)
      // Second findOne returns isGenerating: true (first poll)
      // Third findOne returns isGenerating: false (conversation became idle)
      vi.useFakeTimers();

      const idleConversation = {
        id: "parent-conv-id",
        isGenerating: false,
        messages: [],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-2.5-flash",
        },
      };

      mockFindOne
        .mockResolvedValueOnce({
          id: "parent-conv-id",
          isGenerating: true,
          messages: [],
          settings: {},
        })
        .mockResolvedValueOnce({
          id: "parent-conv-id",
          isGenerating: true,
          messages: [],
          settings: {},
        })
        .mockResolvedValueOnce(idleConversation);

      const autoResponsePromise = OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      // Advance through the polling delays
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await autoResponsePromise;

      // Auto-response should have eventually been called after conversation became idle
      expect(mockRunAgenticLoop).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should skip auto-response when conversation is not found", async () => {
      mockFindOne.mockResolvedValue(null);

      await OrchestratorService._triggerParentAutoResponse(
        "nonexistent-conv", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    });

    it("should skip auto-response when database is not connected", async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValueOnce(null as any);

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    });

    it("should set and clear isGenerating around the agentic loop", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      // setGenerating(true) before, setGenerating(false) after
      expect(vi.mocked(ConversationService.setGenerating)).toHaveBeenCalledTimes(2);

      const [, , , firstIsGenerating] =
        vi.mocked(ConversationService.setGenerating).mock.calls[0];
      expect(firstIsGenerating).toBe(true);

      const [, , , secondIsGenerating] =
        vi.mocked(ConversationService.setGenerating).mock.calls[1];
      expect(secondIsGenerating).toBe(false);
    });

    it("should clear isGenerating even when agentic loop fails", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      mockRunAgenticLoop.mockRejectedValueOnce(new Error("LLM rate limited"));

      await expect(
        OrchestratorService._triggerParentAutoResponse(
          "parent-conv-id", "test-project", "test-user",
          orchestratorContext, completionMessage,
        ),
      ).rejects.toThrow("LLM rate limited");

      // isGenerating cleared in finally block even on error
      const lastCall = vi.mocked(ConversationService.setGenerating).mock.calls.at(-1)!;
      expect(lastCall[3]).toBe(false);
    });

    it("should forward thinking parameters from orchestratorContext into auto-response options", async () => {
      const thinkingContext: OrchestratorContext = {
        ...orchestratorContext,
        thinkingEnabled: true,
        reasoningEffort: "high",
        thinkingBudget: 8192,
      };

      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [
          { role: "user", content: "Build me a feature" },
          { role: "assistant", content: "I spawned sub-agents" },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        thinkingContext, completionMessage,
      );

      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArgs.options.thinkingEnabled).toBe(true);
      expect(loopArgs.options.reasoningEffort).toBe("high");
      expect(loopArgs.options.thinkingBudget).toBe(8192);
    });

    it("should not include thinking parameters when orchestratorContext does not have them", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      const loopArgs = mockRunAgenticLoop.mock.calls[0][0];
      expect(loopArgs.options.thinkingEnabled).toBeUndefined();
      expect(loopArgs.options.reasoningEffort).toBeUndefined();
      expect(loopArgs.options.thinkingBudget).toBeUndefined();
    });
  });

  // ── End-to-End ────────────────────────────────────────────────

  describe("End-to-End: createTeam triggers auto-response on completion", () => {
    it("should dispatch router and trigger auto-response with ephemeral completion context", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: false,
        messages: [{ role: "user", content: "Create a research team" }],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      const teamArgs = {
        name: "research_team",
        members: [
          { description: "Agent A", prompt: "Research topic A" },
          { description: "Agent B", prompt: "Research topic B" },
        ],
      };

      // createTeam returns immediately with real agent IDs (non-blocking)
      const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect("agent_id" in result).toBe(true);
        if ("status" in result) {
          expect(result.status).toBe("running");
        }
      }

      // Wait for background chain: sub-agent loops (2) + parent auto-response (1) = 3
      await waitForMockCalls(mockRunAgenticLoop, 3);

      // Completion message should NOT be persisted to DB via $push
      const hasPushCall = mockUpdateOne.mock.calls.some(
        (call) => call[1] && call[1].$push?.messages,
      );
      expect(hasPushCall).toBe(false);

      // Verify auto-response agentic loop includes ephemeral completion context
      const autoResponseCall = mockRunAgenticLoop.mock.calls[2][0];
      expect(autoResponseCall.conversationId).toBe("parent-conv-id");
      expect(autoResponseCall.messages.at(-1).content).toContain("SUB-AGENT TEAM COMPLETED");
      expect(autoResponseCall.messages.at(-1)._alreadyPersisted).toBe(true);
    });
  });
});

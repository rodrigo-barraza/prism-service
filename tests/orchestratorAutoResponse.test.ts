import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, ORCHESTRATOR, NOTIFICATION_SOURCES } from "../src/constants.ts";

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

const mockHandleAgent = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/routes/ChatRoutes.ts", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    handleAgent: (...args: unknown[]) => mockHandleAgent(...args),
  };
});

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
  timeoutMilliseconds = 5000,
): Promise<void> {
  const startTime = Date.now();
  while (mock.mock.calls.length < expectedCalls) {
    if (Date.now() - startTime > timeoutMilliseconds) {
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

    mockHandleAgent.mockReset();
    mockHandleAgent.mockResolvedValue(undefined);

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
          durationMilliseconds: 12000,
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
          durationMilliseconds: 30000,
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

      await waitForMockCalls(mockHandleAgent, 1);

      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.conversationId).toBe("parent-conv-id");
      expect(agentParams.provider).toBe(PROVIDERS.GOOGLE);
      expect(agentParams.model).toBe("gemini-3-flash-preview");
      expect(agentParams.agenticLoopEnabled).toBe(true);
      expect(agentParams.autoApprove).toBe(true);
    });

    it("should include error details for failed sub-agents in ephemeral context", async () => {
      const routerResults: SubAgentResult[] = [
        {
          agent_id: "agent-ok",
          description: "OK agent",
          status: "completed",
          summary: "Success",
          result: "Done",
          toolUses: 1,
          iterations: 1,
          durationMilliseconds: 1000,
          messages: [],
        },
        {
          agent_id: "agent-fail",
          description: "Failed agent",
          status: "failed",
          summary: "Crashed",
          result: "",
          toolUses: 0,
          iterations: 0,
          durationMilliseconds: 500,
          messages: [],
        },
      ] as SubAgentResult[];

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

      // The notification triggers appendMessages which persists the completion
      // message, then calls handleAgent. Verify handleAgent was called.
      await waitForMockCalls(mockHandleAgent, 1);
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
    });

    it("should truncate very long sub-agent output to prevent context bloat", async () => {
      const longOutput = "A".repeat(ORCHESTRATOR.AGENT_OUTPUT_TRUNCATION_LIMIT + 1000);
      const routerResults: SubAgentResult[] = [
        {
          agent_id: "agent-verbose",
          description: "Verbose agent",
          status: "completed",
          summary: "Very long output",
          result: longOutput,
          toolUses: 1,
          iterations: 1,
          durationMilliseconds: 1000,
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

      // Verify the completion message was persisted with truncated output
      await waitForMockCalls(mockHandleAgent, 1);

      // appendMessages was called with the completion message
      const appendCall = vi.mocked(ConversationService.appendMessages).mock.calls[0];
      expect(appendCall).toBeDefined();
      const [, , , appendedMessages] = appendCall;
      const completionContent = (appendedMessages as any[])[0].content;
      expect(completionContent).toContain("(truncated)");
      expect(completionContent.length).toBeLessThan(longOutput.length);
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
            durationMilliseconds: 0, messages: [],
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

      expect(mockHandleAgent).not.toHaveBeenCalled();
    });
  });

  // ── Notification Format Contract (Regression) ────────────────
  // These tests enforce the <task-notification> XML envelope structure
  // that the client's parseTaskNotification() requires to render the
  // SubAgentNotificationComponent. Commits de7c8f5 and 7c56c2f silently
  // stripped this format, breaking the UI. These tests prevent recurrence.

  describe("task-notification XML format contract", () => {
    function createIdleParentConversation() {
      return {
        id: orchestratorContext.conversationId,
        isGenerating: false,
        messages: [
          { role: "user", content: "Build a feature" },
          { role: "assistant", content: "Spawning sub-agents" },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: orchestratorContext.resolvedModel,
          agent: orchestratorContext.agent,
        },
      };
    }

    const REQUIRED_XML_FIELDS = [
      "task-notification",
      "status",
      "summary",
      "tool_uses",
      "duration_ms",
      "result",
    ] as const;

    function createSubAgentResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
      return {
        agent_id: "agent-default",
        description: "Default agent",
        status: "completed",
        summary: "Default summary",
        result: "Default output text",
        toolUses: 1,
        iterations: 1,
        durationMilliseconds: 1000,
        messages: [],
        ...overrides,
      };
    }

    function extractPersistedNotification(): { content: string; message: Record<string, unknown> } {
      const appendCall = vi.mocked(ConversationService.appendMessages).mock.calls[0];
      expect(appendCall).toBeDefined();
      const [, , , appendedMessages] = appendCall;
      const message = (appendedMessages as any[])[0];
      return { content: message.content as string, message };
    }

    function extractXmlField(content: string, fieldName: string): string | null {
      const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
      const match = content.match(regex);
      return match ? match[1].trim() : null;
    }

    async function notifyAndExtract(
      teamName: string,
      topology: string,
      routerResults: SubAgentResult[],
    ): Promise<{ content: string; message: Record<string, unknown> }> {
      mockFindOne.mockResolvedValue(createIdleParentConversation());

      await OrchestratorService._notifyParentOfRouterCompletion(
        teamName,
        topology,
        routerResults,
        orchestratorContext,
      );

      await waitForMockCalls(mockHandleAgent, 1);
      return extractPersistedNotification();
    }

    describe("_notifyParentOfRouterCompletion", () => {
      it("should wrap completion message in <task-notification> XML envelope", async () => {
        const { content } = await notifyAndExtract(
          "Analysis_Team",
          "hierarchical",
          [createSubAgentResult({ agent_id: "agent-1", description: "Analysis agent" })],
        );

        expect(content).toContain("<task-notification>");
        expect(content).toContain("</task-notification>");
      });

      it("should include all required XML fields: status, summary, tool_uses, duration_ms, result", async () => {
        const { content } = await notifyAndExtract(
          "Worker_Team",
          "sequential",
          [createSubAgentResult({ toolUses: 12, durationMilliseconds: 45000 })],
        );

        for (const fieldName of REQUIRED_XML_FIELDS) {
          expect(
            content,
            `Missing required XML field: <${fieldName}>`,
          ).toMatch(new RegExp(`<${fieldName}>[\\s\\S]*?</${fieldName}>`));
        }
      });

      it("should aggregate tool_uses and duration_ms across all sub-agents", async () => {
        const fastAgentToolUses = 3;
        const fastAgentDurationMilliseconds = 10_000;
        const slowAgentToolUses = 15;
        const slowAgentDurationMilliseconds = 80_000;
        const expectedTotalToolUses = fastAgentToolUses + slowAgentToolUses;
        const expectedTotalDurationMilliseconds = fastAgentDurationMilliseconds + slowAgentDurationMilliseconds;

        const { content } = await notifyAndExtract(
          "Dual_Team",
          "hierarchical",
          [
            createSubAgentResult({
              agent_id: "agent-fast",
              description: "Fast agent",
              toolUses: fastAgentToolUses,
              durationMilliseconds: fastAgentDurationMilliseconds,
            }),
            createSubAgentResult({
              agent_id: "agent-slow",
              description: "Slow agent",
              toolUses: slowAgentToolUses,
              durationMilliseconds: slowAgentDurationMilliseconds,
            }),
          ],
        );

        expect(content).toContain(`<tool_uses>${expectedTotalToolUses}</tool_uses>`);
        expect(content).toContain(`<duration_ms>${expectedTotalDurationMilliseconds}</duration_ms>`);
      });

      it("should set status to 'failed' when any sub-agent fails", async () => {
        const { content } = await notifyAndExtract(
          "Mixed_Team",
          "hierarchical",
          [
            createSubAgentResult({ agent_id: "agent-ok", description: "Good agent" }),
            createSubAgentResult({
              agent_id: "agent-bad",
              description: "Bad agent",
              status: "failed",
              result: "",
              toolUses: 0,
              iterations: 0,
              durationMilliseconds: 1000,
            }),
          ],
        );

        expect(content).toContain("<status>failed</status>");
      });

      it("should set status to 'completed' when all sub-agents succeed", async () => {
        const { content } = await notifyAndExtract(
          "Solo_Team",
          "hierarchical",
          [createSubAgentResult({ status: "completed" })],
        );

        expect(content).toContain("<status>completed</status>");
      });

      it("should include team name and topology in the summary field", async () => {
        const teamName = "My_Research_Team";
        const topology = "sequential";

        const { content } = await notifyAndExtract(
          teamName,
          topology,
          [createSubAgentResult()],
        );

        const summaryText = extractXmlField(content, "summary");
        expect(summaryText).not.toBeNull();
        expect(summaryText).toContain(teamName);
        expect(summaryText).toContain(topology);
      });

      it("should include per-agent result bodies inside the <result> field", async () => {
        const researchOutput = "Paper A covers quantum computing advances.";
        const summaryOutput = "The research landscape shows rapid growth.";

        const { content } = await notifyAndExtract(
          "Research_Team",
          "hierarchical",
          [
            createSubAgentResult({
              agent_id: "agent-research",
              description: "Research Agent",
              result: researchOutput,
            }),
            createSubAgentResult({
              agent_id: "agent-summary",
              description: "Summary Agent",
              result: summaryOutput,
            }),
          ],
        );

        const resultText = extractXmlField(content, "result");
        expect(resultText).not.toBeNull();
        expect(resultText).toContain(researchOutput);
        expect(resultText).toContain(summaryOutput);
      });

      it("should set _notificationSource to NOTIFICATION_SOURCES.ORCHESTRATOR on the persisted message", async () => {
        const { message } = await notifyAndExtract(
          "Team",
          "hierarchical",
          [createSubAgentResult()],
        );

        expect(message._notificationSource).toBe(NOTIFICATION_SOURCES.ORCHESTRATOR);
        expect(message._alreadyPersisted).toBe(true);
        expect(message.role).toBe("user");
      });
    });
  });

  // ── _triggerParentAutoResponse ────────────────────────────────

  describe("_triggerParentAutoResponse", () => {
    const completionMessage = {
      role: "user" as const,
      content: "<task-notification>\n[SUB-AGENT TEAM COMPLETED] Team finished.\n</task-notification>",
      timestamp: new Date().toISOString(),
      _alreadyPersisted: true,
      _notificationSource: NOTIFICATION_SOURCES.ORCHESTRATOR,
      _notificationId: `orchestrator:team-completed:${new Date().toISOString()}`,
    };

    it("should persist completion message and call handleAgent", async () => {
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

      // Completion message was persisted via appendMessages
      expect(vi.mocked(ConversationService.appendMessages)).toHaveBeenCalledTimes(1);
      const [conversationId, project, username, messages] =
        vi.mocked(ConversationService.appendMessages).mock.calls[0];
      expect(conversationId).toBe("parent-conv-id");
      expect(project).toBe("test-project");
      expect(username).toBe("test-user");
      expect((messages as any[])[0].content).toContain("SUB-AGENT TEAM COMPLETED");

      // handleAgent was called with the correct params
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.conversationId).toBe("parent-conv-id");
      expect(agentParams.project).toBe("test-project");
      expect(agentParams.username).toBe("test-user");
      expect(agentParams.provider).toBe(PROVIDERS.GOOGLE);
      expect(agentParams.model).toBe("gemini-3-flash-preview");
      expect(agentParams.agent).toBe("CODING");
      expect(agentParams.agenticLoopEnabled).toBe(true);
      expect(agentParams.autoApprove).toBe(true);
      expect(agentParams.functionCallingEnabled).toBe(true);
    });

    it("should include conversation messages in params for handleAgent", async () => {
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

      const [agentParams] = mockHandleAgent.mock.calls[0];
      // Messages array from the reloaded conversation (including persisted completion)
      expect(agentParams.messages).toHaveLength(4);
    });

    it("should proactively clear isGenerating before triggering auto-response (prevents deadlock)", async () => {
      // Simulates the deferred-done scenario: the Finalizer kept isGenerating=true
      // (skipGeneratingClear: true) and the auto-response fires inside
      // awaitPendingDispatches. Without the proactive clear, this would deadlock.
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: true,
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

      // The isGenerating flag should have been cleared via updateOne
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { id: "parent-conv-id", project: "test-project", username: "test-user" },
        [
          { $set: { isGenerating: false } },
          {
            $set: {
              isActive: { $gt: [{ $ifNull: ["$pendingBackgroundTasks", 0] }, 0] },
            },
          },
        ],
      );

      // handleAgent should have been called — no deadlock
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.conversationId).toBe("parent-conv-id");
      expect(agentParams.agenticLoopEnabled).toBe(true);
    });

    it("should NOT call updateOne for isGenerating when conversation is already idle", async () => {
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

      // updateOne should NOT have been called to clear isGenerating
      // (it may be called by appendMessages mock, but not with the isGenerating payload)
      const isGeneratingClearCalls = mockUpdateOne.mock.calls.filter(
        (callArguments: unknown[]) => {
          const updatePayload = callArguments[1] as Record<string, unknown>;
          return updatePayload?.$set && (updatePayload.$set as Record<string, unknown>).isGenerating === false;
        },
      );
      expect(isGeneratingClearCalls).toHaveLength(0);

      // handleAgent should still proceed normally
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
    });

    it("should still proceed with auto-response even if isGenerating clear fails", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: true,
        messages: [],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      // Simulate updateOne failure for isGenerating clear
      mockUpdateOne.mockRejectedValueOnce(new Error("MongoDB connection lost"));

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      // Even though the clear failed, handleAgent should still fire
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
    });

    it("should skip auto-response when conversation is not found", async () => {
      mockFindOne.mockResolvedValue(null);

      await OrchestratorService._triggerParentAutoResponse(
        "nonexistent-conv", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      expect(mockHandleAgent).not.toHaveBeenCalled();
    });

    it("should skip auto-response when database is not connected", async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValueOnce(null as any);

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      expect(mockHandleAgent).not.toHaveBeenCalled();
    });

    it("should forward thinking parameters from orchestratorContext into auto-response params", async () => {
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

      expect(mockHandleAgent).toHaveBeenCalledTimes(1);

      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.thinkingEnabled).toBe(true);
      expect(agentParams.reasoningEffort).toBe("high");
      expect(agentParams.thinkingBudget).toBe(8192);
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

      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.thinkingEnabled).toBeUndefined();
      expect(agentParams.reasoningEffort).toBeUndefined();
      expect(agentParams.thinkingBudget).toBeUndefined();
    });

    it("should use parent SSE emit from orchestratorContext when available (primary path)", async () => {
      const parentSseEmit = vi.fn();
      const contextWithEmit = { ...orchestratorContext, emit: parentSseEmit };

      // Even register a WebSocket — it should NOT be used because SSE takes priority
      const WebSocketConnectionRegistry = (
        await import("../src/websocket/WebSocketConnectionRegistry.ts")
      ).default;
      const mockWebSocketEmit = vi.fn();
      const mockWebSocket = { readyState: 1, OPEN: 1, send: vi.fn() };
      WebSocketConnectionRegistry.register(
        "parent-conv-id",
        mockWebSocket as unknown as import("ws").WebSocket,
        mockWebSocketEmit,
      );

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
        contextWithEmit, completionMessage,
      );

      // handleAgent should receive the parent SSE emit
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      const emitArg = mockHandleAgent.mock.calls[0][1];
      expect(typeof emitArg).toBe("function");

      // Emit through and verify it reaches the parent SSE emit, NOT WebSocket
      emitArg({ type: "test_streaming_event", data: "live" });
      expect(parentSseEmit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "test_streaming_event", data: "live" }),
      );
      expect(mockWebSocketEmit).not.toHaveBeenCalled();

      WebSocketConnectionRegistry.clear();
    });

    it("should fall back to WebSocket emit when orchestratorContext has no emit function", async () => {
      const WebSocketConnectionRegistry = (
        await import("../src/websocket/WebSocketConnectionRegistry.ts")
      ).default;

      const mockWebSocketEmit = vi.fn();
      const mockWebSocket = { readyState: 1, OPEN: 1, send: vi.fn() };

      WebSocketConnectionRegistry.register(
        "parent-conv-id",
        mockWebSocket as unknown as import("ws").WebSocket,
        mockWebSocketEmit,
      );

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

      // Context without emit — forces WebSocket fallback
      const contextWithoutEmit = { ...orchestratorContext, emit: undefined };

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        contextWithoutEmit, completionMessage,
      );

      // handleAgent should receive the WebSocket emit as the second arg
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      const emitArg = mockHandleAgent.mock.calls[0][1];
      expect(typeof emitArg).toBe("function");

      // Emit through the registered function and verify it reaches the WebSocket
      emitArg({ type: "test_streaming_event", data: "live" });
      expect(mockWebSocketEmit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "test_streaming_event", data: "live" }),
      );

      WebSocketConnectionRegistry.clear();
    });

    it("should fall back to debug logger when no emit source is available", async () => {
      const WebSocketConnectionRegistry = (
        await import("../src/websocket/WebSocketConnectionRegistry.ts")
      ).default;

      WebSocketConnectionRegistry.clear();

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

      // Context without emit AND no WebSocket — forces debug fallback
      const contextWithoutEmit = { ...orchestratorContext, emit: undefined };

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        contextWithoutEmit, completionMessage,
      );

      // handleAgent still receives an emit function (the debug fallback)
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      const emitArg = mockHandleAgent.mock.calls[0][1];
      expect(typeof emitArg).toBe("function");

      // Calling the fallback should not throw
      expect(() => emitArg({ type: "debug_event" })).not.toThrow();
    });

    it("should emit task_notification SSE event before calling handleAgent", async () => {
      const parentSseEmit = vi.fn();
      const contextWithEmit = { ...orchestratorContext, emit: parentSseEmit };

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
        contextWithEmit, completionMessage,
      );

      // The task_notification SSE event should have been emitted
      // BEFORE handleAgent was called (it's the first emit call)
      const taskNotificationCalls = parentSseEmit.mock.calls.filter(
        (callArguments: unknown[]) => (callArguments[0] as Record<string, unknown>)?.type === "task_notification",
      );
      expect(taskNotificationCalls).toHaveLength(1);

      const notificationPayload = taskNotificationCalls[0][0];
      expect(notificationPayload).toEqual(
        expect.objectContaining({
          type: "task_notification",
          content: expect.stringContaining("<task-notification>"),
          timestamp: expect.any(String),
          _notificationSource: NOTIFICATION_SOURCES.ORCHESTRATOR,
          _notificationId: expect.stringContaining("orchestrator:"),
        }),
      );

      // task_notification should have been emitted before handleAgent was called
      // (parentSseEmit's first call should be the notification, handleAgent is called after)
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);

      // Verify the notification event was emitted before handleAgent by checking call order
      const notificationEmitOrder = parentSseEmit.mock.invocationCallOrder[0];
      const handleAgentCallOrder = mockHandleAgent.mock.invocationCallOrder[0];
      expect(notificationEmitOrder).toBeLessThan(handleAgentCallOrder);
    });
  });

  // ── End-to-End ────────────────────────────────────────────────

  describe("End-to-End: createTeam triggers auto-response on completion", () => {
    it("should dispatch router and trigger auto-response with ephemeral completion context", async () => {
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

      const teamResults = await OrchestratorService.createTeam(
        {
          name: "research_team",
          topology: "hierarchical",
          members: [
            { description: "Research", prompt: "Find papers", model: "gemini-3-flash-preview" },
            { description: "Implement", prompt: "Write code", model: "gemini-3-flash-preview" },
          ],
        },
        orchestratorContext,
      );

      // Team was dispatched and returned results
      expect(Array.isArray(teamResults)).toBe(true);

      // Wait for the background auto-response to be triggered
      await waitForMockCalls(mockHandleAgent, 1);

      // handleAgent was called with the right conversation
      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.conversationId).toBe("parent-conv-id");
      expect(agentParams.provider).toBe(PROVIDERS.GOOGLE);
      expect(agentParams.agenticLoopEnabled).toBe(true);
    });

    it("should clear isGenerating and trigger auto-response when Finalizer deferred the flag (non-blocking)", async () => {
      // This is the critical regression test for the deadlock that occurred
      // when the Finalizer used skipGeneratingClear: true. In that scenario:
      // 1. Finalizer keeps isGenerating=true (deferDoneEmission)
      // 2. awaitPendingDispatches blocks → router resolves
      // 3. _triggerParentAutoResponse fires while isGenerating is still true
      // 4. Without the fix, it would poll for 60s and give up → conversation stuck
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: true,
        messages: [
          { role: "user", content: "Spawn agents" },
          { role: "assistant", content: "Creating sub-agents..." },
        ],
        settings: {
          provider: PROVIDERS.GOOGLE,
          model: "gemini-3-flash-preview",
          agent: "CODING",
        },
      });

      const teamResults = await OrchestratorService.createTeam(
        {
          name: "deferred_team",
          topology: "hierarchical",
          members: [
            { description: "Agent A", prompt: "Do task A", model: "gemini-3-flash-preview" },
            { description: "Agent B", prompt: "Do task B", model: "gemini-3-flash-preview" },
          ],
        },
        orchestratorContext,
      );

      expect(Array.isArray(teamResults)).toBe(true);

      // Wait for the background auto-response
      await waitForMockCalls(mockHandleAgent, 1);

      // The isGenerating flag should have been proactively cleared
      const isGeneratingClearCalls = mockUpdateOne.mock.calls.filter(
        (callArguments: unknown[]) => {
          const updatePayload = callArguments[1];
          if (Array.isArray(updatePayload)) {
            return updatePayload.some(
              (stage: any) => stage?.$set && stage.$set.isGenerating === false
            );
          }
          if (updatePayload && typeof updatePayload === "object") {
            const payloadObject = updatePayload as Record<string, any>;
            return payloadObject.$set && payloadObject.$set.isGenerating === false;
          }
          return false;
        },
      );
      expect(isGeneratingClearCalls.length).toBeGreaterThanOrEqual(1);

      // handleAgent was called — no deadlock
      expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      const [agentParams] = mockHandleAgent.mock.calls[0];
      expect(agentParams.conversationId).toBe("parent-conv-id");
      expect(agentParams.agenticLoopEnabled).toBe(true);
    });
  });
});

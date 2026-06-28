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

    // Enable MongoWrapper mocks for auto-response (setup.ts defaults them to null)
    vi.mocked(MongoWrapper.getDb).mockReturnValue({} as any);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: (...args: unknown[]) => mockFindOne(...args),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
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
    it("should persist a completion message into the parent conversation", async () => {
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

      // Wait for the appendMessages call
      await waitForMockCalls(vi.mocked(ConversationService.appendMessages), 1);

      const [conversationId, project, username, messages] =
        vi.mocked(ConversationService.appendMessages).mock.calls[0];
      expect(conversationId).toBe("parent-conv-id");
      expect(project).toBe("test-project");
      expect(username).toBe("test-user");
      expect(messages).toHaveLength(1);

      const completionMessage = messages[0] as { role: string; name: string; content: string };
      expect(completionMessage.role).toBe("tool");
      expect(completionMessage.name).toBe("create_team");
      expect(completionMessage.content).toContain("[SUB-AGENT TEAM COMPLETED]");
      expect(completionMessage.content).toContain("research_team");
      expect(completionMessage.content).toContain("hierarchical");
      expect(completionMessage.content).toContain("Research agent");
      expect(completionMessage.content).toContain("Paper A, Paper B, Paper C");
      expect(completionMessage.content).toContain("Coding agent");
      expect(completionMessage.content).toContain("Feature implemented successfully");
    });

    it("should include error details for failed sub-agents", async () => {
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

      await waitForMockCalls(vi.mocked(ConversationService.appendMessages), 1);

      const completionMessage =
        vi.mocked(ConversationService.appendMessages).mock.calls[0][3][0] as { content: string };
      expect(completionMessage.content).toContain("✅");
      expect(completionMessage.content).toContain("❌");
      expect(completionMessage.content).toContain("Agent crashed: out of memory");
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

      await waitForMockCalls(vi.mocked(ConversationService.appendMessages), 1);

      const completionMessage =
        vi.mocked(ConversationService.appendMessages).mock.calls[0][3][0] as { content: string };
      expect(completionMessage.content).toContain("(truncated)");
      expect(completionMessage.content.length).toBeLessThan(longOutput.length);
    });

    it("should gracefully handle appendMessages failure without crashing", async () => {
      vi.mocked(ConversationService.appendMessages).mockRejectedValueOnce(
        new Error("MongoDB down"),
      );
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

      expect(vi.mocked(ConversationService.appendMessages)).not.toHaveBeenCalled();
    });
  });

  // ── _triggerParentAutoResponse ────────────────────────────────

  describe("_triggerParentAutoResponse", () => {
    const completionMessage = {
      role: "tool" as const,
      content: "[SUB-AGENT TEAM COMPLETED] Team finished.",
      name: "create_team",
      timestamp: new Date().toISOString(),
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

    it("should skip auto-response when parent is currently generating", async () => {
      mockFindOne.mockResolvedValue({
        id: "parent-conv-id",
        isGenerating: true,
        messages: [],
        settings: {},
      });

      await OrchestratorService._triggerParentAutoResponse(
        "parent-conv-id", "test-project", "test-user",
        orchestratorContext, completionMessage,
      );

      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
      expect(vi.mocked(ConversationService.setGenerating)).not.toHaveBeenCalled();
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
  });

  // ── End-to-End ────────────────────────────────────────────────

  describe("End-to-End: createTeam triggers auto-response on completion", () => {
    it("should dispatch router, persist completion, and trigger auto-response", async () => {
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

      // createTeam returns immediately (non-blocking)
      const results = await OrchestratorService.createTeam(teamArgs, orchestratorContext);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect("status" in result && result.status).toBe("running");
      }

      // Wait for background chain: sub-agent spawns (2) + parent auto-response (1) = 3
      await waitForMockCalls(mockRunAgenticLoop, 3);

      // Verify completion message was persisted
      expect(vi.mocked(ConversationService.appendMessages)).toHaveBeenCalled();
      const persistedMessage =
        vi.mocked(ConversationService.appendMessages).mock.calls[0][3][0] as { content: string };
      expect(persistedMessage.content).toContain("[SUB-AGENT TEAM COMPLETED]");

      // Verify auto-response agentic loop includes completion context
      const autoResponseCall = mockRunAgenticLoop.mock.calls[2][0];
      expect(autoResponseCall.conversationId).toBe("parent-conv-id");
      expect(autoResponseCall.messages.at(-1).content).toContain("SUB-AGENT TEAM COMPLETED");
    });
  });
});

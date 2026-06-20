import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import { APPROVAL_TIERS } from "../src/services/AutoApprovalEngine.ts";
import CriticGate from "../src/services/harnesses/lifecycle/CriticGate.ts";
import { checkAndWaitForApproval } from "../src/services/harnesses/lifecycle/ApprovalGate.ts";
import { manageContextPressure } from "../src/services/harnesses/lifecycle/ContextPressureManager.ts";
import { checkCostBudget } from "../src/services/harnesses/lifecycle/CostBudgetEnforcer.ts";
import { runExhaustionRecoveryPass } from "../src/services/harnesses/lifecycle/ExhaustionRecovery.ts";
import { createStandardHooks } from "../src/services/harnesses/lifecycle/HookInitializer.ts";
import {
  blockUnauthorizedToolCalls,
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "../src/services/harnesses/lifecycle/PlanModeController.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../src/services/harnesses/lifecycle/PostExecutionEmitter.ts";
import { buildToolRetryGuidance } from "../src/services/harnesses/lifecycle/ToolRetryInterceptor.ts";
import { injectToolDiscoveryNudge } from "../src/services/harnesses/lifecycle/ToolDiscoveryNudge.ts";
import {
  maybeInjectSystemReminder,
  cleanupReminderCache,
} from "../src/services/harnesses/lifecycle/SystemReminderInjector.ts";
import { extractReminderViaLLM } from "../src/services/harnesses/lifecycle/SystemReminderExtractor.ts";
import {
  createSandboxCheckpoint,
  restoreSandboxCheckpoint,
} from "../src/services/harnesses/lifecycle/SandboxExecutor.ts";
import {
  executeToolBatch,
  executeToolSingle,
} from "../src/services/harnesses/lifecycle/ToolExecutor.ts";
import { logKVCacheHitRate } from "../src/services/harnesses/lifecycle/KVCacheReporter.ts";
import { finalizePassTracker } from "../src/services/harnesses/lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "../src/services/harnesses/lifecycle/CodexPlanningDetector.ts";

import { execSync } from "node:child_process";
import logger from "../src/utils/logger.ts";
import RequestLogger from "../src/services/RequestLogger.ts";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import MicroCompactionService from "../src/services/compact/MicroCompactionService.ts";
import AutoCompactionTrigger from "../src/services/compact/AutoCompactionTrigger.ts";
import CompactionService from "../src/services/compact/CompactionService.ts";
import ConversationEmbeddingService from "../src/services/ConversationEmbeddingService.ts";
import MemoryExtractor from "../src/services/MemoryExtractor.ts";
import WorkflowMemoryService from "../src/services/WorkflowMemoryService.ts";
import ConversationGenerationTracker from "../src/services/ConversationGenerationTracker.ts";
import AgentHooks from "../src/services/AgentHooks.ts";
import AutoApprovalEngine from "../src/services/AutoApprovalEngine.ts";
import SystemPromptAssembler from "../src/services/system-prompt/index.ts";

// Mock child_process.execSync
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock logger to prevent output pollution
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock external services
vi.mock("../src/services/compact/MicroCompactionService.ts", () => ({
  default: {
    microcompactMessages: vi.fn(),
  },
}));

vi.mock("../src/services/compact/AutoCompactionTrigger.ts", () => ({
  default: {
    evaluate: vi.fn(),
  },
}));

vi.mock("../src/services/compact/CompactionService.ts", () => ({
  default: {
    compactConversation: vi.fn(),
  },
}));

vi.mock("../src/services/ConversationEmbeddingService.ts", () => ({
  default: {
    persistCompactionSummary: vi.fn().mockResolvedValue(undefined),
    createHook: vi.fn().mockReturnValue(vi.fn()),
  },
}));

vi.mock("../src/services/MemoryExtractor.ts", () => ({
  default: {
    createHook: vi.fn().mockReturnValue(vi.fn()),
  },
}));

vi.mock("../src/services/WorkflowMemoryService.ts", () => ({
  default: {
    createHook: vi.fn().mockReturnValue(vi.fn()),
  },
}));

vi.mock("../src/services/ConversationGenerationTracker.ts", () => ({
  default: {
    update: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    isStreamable: vi.fn().mockReturnValue(false),
    executeTool: vi.fn(),
    executeToolStreaming: vi.fn(),
    getToolEmoji: vi.fn().mockReturnValue("⚙️"),
    getWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
  },
}));

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio-ref-123" }),
  },
}));

vi.mock("../src/services/WebhookEventBus.ts", () => ({
  default: {
    emit: vi.fn(),
  },
}));

describe("Harness Lifecycle Modules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CriticGate", () => {
    const mockProvider = {
      generateTextStream: vi.fn().mockImplementation(async function* () {
        yield "APPROVE";
      }),
    };

    const mockAgenticContext = {
      project: "test-project",
      username: "test-user",
      agent: "CODING",
      providerName: PROVIDERS.GOOGLE,
      resolvedModel: "gemini-3.5-flash",
      traceId: "trace-id-123",
      agentConversationId: "session-id-456",
      conversationId: "conv-id-789",
      emit: vi.fn(),
      provider: mockProvider,
      options: {},
    };

    it("should approve tool immediately if it is below danger tier", async () => {
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "read_file",
        args: { path: "test.txt" },
        _approval: { tier: APPROVAL_TIERS.WRITE as any, tierLabel: "WRITE" },
      };

      const reviewResult = await criticGate.review(toolCall, mockAgenticContext as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("below_danger_tier");
    });

    it("should skip critic if skipCritic option is configured", async () => {
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "rm -rf /" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };
      const contextWithSkip = {
        ...mockAgenticContext,
        options: { skipCritic: true },
      };

      const reviewResult = await criticGate.review(toolCall, contextWithSkip as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("critic_skipped");
    });

    it("should trigger critic model call and return approved when model responds APPROVE", async () => {
      const criticGate = new CriticGate({ model: "critic-model" });
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "ls" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const reviewResult = await criticGate.review(toolCall, mockAgenticContext as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("critic_approved");
      expect(reviewResult.criticModel).toBe("critic-model");
      expect(mockProvider.generateTextStream).toHaveBeenCalled();
    });

    it("should deny tool call when critic model responds DENY", async () => {
      mockProvider.generateTextStream.mockImplementationOnce(async function* () {
        yield "DENY\nDangerous command detected.";
      });

      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "rm -rf /" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const reviewResult = await criticGate.review(toolCall, mockAgenticContext as any);
      expect(reviewResult.isApproved).toBe(false);
      expect(reviewResult.reason).toBe("Dangerous command detected.");
    });

    it("should fail-open when critic model call throws an error", async () => {
      mockProvider.generateTextStream.mockImplementationOnce(() => {
        throw new Error("Connection failed");
      });

      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "sudo reboot" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const reviewResult = await criticGate.review(toolCall, mockAgenticContext as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("critic_error_fallback");
    });
  });

  describe("ApprovalGate", () => {
    const mockAgenticContext = {
      conversationId: "conv-123",
      emit: vi.fn(),
      options: {},
    };

    const mockApprovalEngine = {
      checkBatch: vi.fn(),
    } as unknown as AutoApprovalEngine;

    it("should approve immediately if no tools need approval", async () => {
      vi.mocked(mockApprovalEngine.checkBatch).mockReturnValue({
        needsApproval: [],
        approved: [],
      } as any);

      const approvalResult = await checkAndWaitForApproval([], mockAgenticContext as any, mockApprovalEngine);
      expect(approvalResult.isApproved).toBe(true);
    });

    it("should approve immediately if autoApprove is configured", async () => {
      vi.mocked(mockApprovalEngine.checkBatch).mockReturnValue({
        needsApproval: [{ name: "danger_tool" }],
        approved: [],
      } as any);

      const contextWithAuto = {
        ...mockAgenticContext,
        options: { autoApprove: true },
      };

      const approvalResult = await checkAndWaitForApproval(
        [{ name: "danger_tool" }] as any,
        contextWithAuto as any,
        mockApprovalEngine,
      );
      expect(approvalResult.isApproved).toBe(true);
    });
  });

  describe("ContextPressureManager", () => {
    const mockAgenticContext = {
      modelDefinition: { maxInputTokens: 1000 },
      options: { maxTokens: 100 },
      project: "proj",
      username: "user",
      agentConversationId: "agent-conv",
      traceId: "trace",
      conversationId: "conv",
      emit: vi.fn(),
    };

    const mockAgenticLoopState = {
      originalMessageCount: 0,
      compactionPerformed: false,
      preCompactTokenCount: 0,
      postCompactTokenCount: 0,
    };

    it("should return messages unchanged when pressure is low", async () => {
      vi.mocked(AutoCompactionTrigger.evaluate).mockReturnValue({ shouldCompact: false } as any);

      const pressureResult = await manageContextPressure(
        [{ role: "user", content: "hello" }],
        mockAgenticContext as any,
        mockAgenticLoopState as any,
        "TestHarness",
      );

      expect(pressureResult.messages).toHaveLength(1);
      expect(mockAgenticLoopState.compactionPerformed).toBe(false);
    });

    it("should compact messages when trigger decides compaction is required", async () => {
      vi.mocked(AutoCompactionTrigger.evaluate).mockReturnValue({ shouldCompact: true } as any);
      vi.mocked(CompactionService.compactConversation).mockResolvedValue({
        compactedMessages: [{ role: "system", content: "Summary" }],
        summaryText: "distilled text",
        preCompactTokenCount: 500,
        postCompactTokenCount: 100,
      } as any);

      const pressureResult = await manageContextPressure(
        [{ role: "user", content: "long message" }],
        mockAgenticContext as any,
        mockAgenticLoopState as any,
        "TestHarness",
      );

      expect(pressureResult.messages).toHaveLength(1);
      expect(pressureResult.messages[0].content).toBe("Summary");
      expect(mockAgenticLoopState.compactionPerformed).toBe(true);
      expect(ConversationEmbeddingService.persistCompactionSummary).toHaveBeenCalledWith(
        "conv",
        "proj",
        "user",
        "distilled text",
      );
    });
  });

  describe("CostBudgetEnforcer", () => {
    const mockAgenticLoopState = {
      iterations: 5,
      overallUsage: { inputTokens: 1000, outputTokens: 500 },
    };

    it("should return false if no budget limit is configured", () => {
      const isExceeded = checkCostBudget(
        mockAgenticLoopState as any,
        "gemini-3.5-flash",
        undefined,
        vi.fn(),
      );
      expect(isExceeded).toBe(false);
    });

    it("should return true when estimated cost exceeds configured dollars limit", () => {
      // Configure extremely low budget
      const emitSpy = vi.fn();
      const isExceeded = checkCostBudget(
        mockAgenticLoopState as any,
        "gemini-3.5-flash",
        0.00001,
        emitSpy,
      );
      expect(isExceeded).toBe(true);
      expect(emitSpy).toHaveBeenCalled();
    });
  });

  describe("ExhaustionRecovery", () => {
    it("should push recovery prompt and trigger recovery stream call", async () => {
      const mockHarness = {
        enforceContextWindow: vi.fn().mockImplementation((msgs) => msgs),
        registerTrackerRequest: vi.fn(),
        createPassState: vi.fn().mockReturnValue({ usage: { inputTokens: 0, outputTokens: 0 } }),
        consumeStream: vi.fn().mockResolvedValue(undefined),
        logIteration: vi.fn(),
        emitGenerationProgress: vi.fn(),
      };

      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "recovery pass done";
        }),
      };

      const mockContext = {
        emit: vi.fn(),
        options: {},
        resolvedModel: "gemini-3.5-flash",
        provider: mockProvider,
        requestId: "req-1",
        agentConversationId: "aconv-1",
      };

      const currentMessages: any[] = [];
      await runExhaustionRecoveryPass(
        mockHarness as any,
        mockContext as any,
        { iterations: 10 } as any,
        currentMessages,
      );

      expect(currentMessages[0].role).toBe("system");
      expect(currentMessages[0].content).toContain("maximum number of tool-call iterations");
      expect(mockProvider.generateTextStream).toHaveBeenCalled();
    });
  });

  describe("HookInitializer", () => {
    it("should register standard hooks", () => {
      const { hooks, approvalEngine } = createStandardHooks({
        enableCriticGate: true,
        autoApprove: true,
      });

      expect(hooks).toBeInstanceOf(AgentHooks);
      expect(approvalEngine).toBeInstanceOf(AutoApprovalEngine);
    });
  });

  describe("PlanModeController", () => {
    it("should block non-exit_plan_mode tools during plan mode", () => {
      const pendingToolCalls = [
        { id: "call-1", name: "read_file", args: {} },
        { id: "call-2", name: "exit_plan_mode", args: {} },
      ];
      const currentMessages: any[] = [];
      const pass = { streamedText: "" };

      const result = blockUnauthorizedToolCalls(pendingToolCalls as any, currentMessages, pass as any, {} as any);
      expect(result.allBlocked).toBe(false);
      expect(pendingToolCalls).toHaveLength(1);
      expect(pendingToolCalls[0].name).toBe("exit_plan_mode");
    });

    it("should enter plan mode when enter_plan_mode is encountered", () => {
      const state = { planModeActive: false, planModeText: "" };
      const emitSpy = vi.fn();
      checkForPlanModeEntry([{ name: "enter_plan_mode" }] as any, [], state as any, emitSpy);
      expect(state.planModeActive).toBe(true);
      expect(emitSpy).toHaveBeenCalled();
    });
  });

  describe("PostExecutionEmitter", () => {
    it("should emit tasks updated event when task tools are called", () => {
      const emitSpy = vi.fn();
      emitPostExecutionStatus([{ name: "update_task" }] as any, emitSpy);
      expect(emitSpy).toHaveBeenCalledWith({
        type: "status",
        message: "tasks_updated",
      });
    });

    it("should track tool failures and increment counts", () => {
      const state = { toolErrorCounts: new Map() };
      const emitSpy = vi.fn();
      trackToolErrors(
        [{ name: "test_tool", id: "1" }] as any,
        [{ id: "1", result: { error: "Failed" } }] as any,
        state as any,
        3,
        emitSpy,
      );

      expect(state.toolErrorCounts.get("test_tool")).toBe(1);
    });
  });

  describe("ToolRetryInterceptor", () => {
    it("should generate retry guidance for failed tool calls", () => {
      const state = { toolErrorCounts: new Map([["test_tool", 1]]) };
      const toolCalls = [{ id: "1", name: "test_tool", args: { param: "val" } }];
      const results = [{ id: "1", result: { error: "Invalid path" } }];

      const guidance = buildToolRetryGuidance(toolCalls as any, results as any, state as any, 3);
      expect(guidance).not.toBeNull();
      expect(guidance?.role).toBe("system");
      expect(guidance?.content).toContain("test_tool");
      expect(guidance?.content).toContain("Invalid path");
    });
  });

  describe("ToolDiscoveryNudge", () => {
    it("should nudge lower-tier models to auto-enable tools", () => {
      const currentMessages: any[] = [];
      const context = {
        resolvedModel: "gemini-flash-1.5",
        agentConversationId: "aconv-123",
      };

      injectToolDiscoveryNudge(
        [{ name: "search_tools", id: "1" }] as any,
        [{ id: "1", result: { matches: [{ name: "npm_install", isEnabled: false }] } }] as any,
        currentMessages,
        context as any,
      );

      expect(currentMessages).toHaveLength(1);
      expect(currentMessages[0].content).toContain("automatically enabled");
    });
  });

  describe("SystemReminderInjector", () => {
    it("should inject system constraints reminder on trigger iteration interval", async () => {
      const currentMessages = [{ role: "system", content: "a".repeat(250) }];
      const state = { iterations: 8 };
      const context = {
        options: { reminderModel: "gemini-3.5-flash", reminderInterval: 8 },
        provider: {
          generateTextStream: vi.fn().mockImplementation(async function* () {
            yield "- rule one: this rule is very important and must be followed\n- rule two: always remember to test everything\n- rule three: make sure all code matches coding standards";
          }),
        },
        emit: vi.fn(),
        project: "test-project",
        username: "test-user",
        agent: "CODING",
        providerName: PROVIDERS.GOOGLE,
        traceId: "trace-id-123",
        agentConversationId: "session-id-456",
        conversationId: "conv-id-789",
        requestId: "req-id-789",
      };

      await maybeInjectSystemReminder(currentMessages as any, state as any, context as any);
      expect(currentMessages).toHaveLength(2);
      expect(currentMessages[1].content).toContain("SYSTEM REMINDER");
      cleanupReminderCache("session-id-456");
    });
  });

  describe("SandboxExecutor", () => {
    it("should create stash checkpoint when inside git repository", () => {
      vi.mocked(execSync).mockReturnValue("stash-sha-123");
      const emitSpy = vi.fn();
      const sha = createSandboxCheckpoint("/my-git-repo", emitSpy);
      expect(sha).toBe("stash-sha-123");
      expect(emitSpy).toHaveBeenCalled();
    });

    it("should restore stash checkpoint successfully", () => {
      vi.mocked(execSync).mockReturnValue("");
      const emitSpy = vi.fn();
      const success = restoreSandboxCheckpoint("/my-git-repo", "stash-sha-123", emitSpy);
      expect(success).toBe(true);
      expect(emitSpy).toHaveBeenCalled();
    });
  });

  describe("ToolExecutor", () => {
    it("should execute standard non-streaming tools", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue("executed-val");
      const hooks = { run: vi.fn() } as unknown as AgentHooks;
      const context = { emit: vi.fn(), options: {} };
      const tools = { finalTools: [] };

      const results = await executeToolBatch(
        [{ name: "read_file", id: "1", args: {} }],
        context as any,
        tools as any,
        hooks,
        { iterations: 1 } as any,
      );

      expect(results).toHaveLength(1);
      expect(results[0].result).toBe("executed-val");
      expect(ToolOrchestratorService.executeTool).toHaveBeenCalled();
    });
  });

  describe("KVCacheReporter", () => {
    it("should log hit rate diagnostics for active caching", () => {
      const loggerSpy = vi.spyOn(logger, "info");
      logKVCacheHitRate({ inputTokens: 200, cacheReadInputTokens: 800 } as any, 2, "TestHarness");
      expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining("KV cache:"));
    });
  });

  describe("TrackerFinalizer", () => {
    it("should finalize pass and register tokens count", () => {
      const pass = { usage: { inputTokens: 100, outputTokens: 50 } };
      const result = finalizePassTracker(pass as any, "req-1");
      expect(result.finalInputTokens).toBe(100);
      expect(ConversationGenerationTracker.complete).toHaveBeenCalledWith("req-1");
    });
  });

  describe("CodexPlanningDetector", () => {
    it("should detect codex model plan responses and inject action prompt", () => {
      const pass = { streamedText: "plan outline", streamedThinking: "" };
      const currentMessages: any[] = [];
      const context = { resolvedModel: "openai-codex-1" };

      const detection = handleCodexPlanningResponse(
        pass as any,
        currentMessages,
        context as any,
        { iterations: 1 } as any,
        [{ name: "run_code" }] as any,
        "TestHarness",
      );

      expect(detection.shouldContinueLoop).toBe(true);
      expect(currentMessages).toHaveLength(2);
      expect(currentMessages[1].content).toContain("Please proceed with the next step");
    });
  });
});

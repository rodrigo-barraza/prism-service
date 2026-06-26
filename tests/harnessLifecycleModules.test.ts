import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS, PROMPT_DELIMITERS } from "../src/constants.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import FileService from "../src/services/FileService.ts";
import { appendAndFinalize } from "../src/utils/ConversationUtilities.ts";
import { APPROVAL_TIERS } from "../src/services/AutoApprovalEngine.ts";
import CriticGate from "../src/services/harnesses/lifecycle/CriticGate.ts";
import { pendingApprovals } from "../src/services/ApprovalRegistry.ts";
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
import {
  finalizeTextGeneration,
  swapMessageContent,
  sanitizeMessagesForPersistence,
} from "../src/services/harnesses/lifecycle/Finalizer.ts";

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
    request: vi.fn(),
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

vi.mock("../src/utils/ConversationUtilities.ts", () => ({
  appendAndFinalize: vi.fn().mockResolvedValue(undefined),
  computeNewTurnMessages: vi.fn(),
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

    it("should approve tool immediately if toolCall approval info is undefined", async () => {
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "read_file",
        args: { path: "test.txt" },
        _approval: undefined,
      };

      const reviewResult = await criticGate.review(toolCall, mockAgenticContext as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("below_danger_tier");
    });

    it("should fallback when logging details are missing in context", async () => {
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: undefined,
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const mockProviderMinimal = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "APPROVE";
        }),
      };

      const contextMinimal = {
        provider: mockProviderMinimal,
        resolvedModel: "gemini-3.5-flash",
        options: {},
      };

      const reviewResult = await criticGate.review(toolCall, contextMinimal as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("critic_approved");
    });

    it("should fallback to default reason if DENY first line has no other lines", async () => {
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "rm -rf /" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const mockProviderDenyEmpty = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "DENY";
        }),
      };

      const contextMinimal = {
        provider: mockProviderDenyEmpty,
        resolvedModel: "gemini-3.5-flash",
        options: {},
      };

      const reviewResult = await criticGate.review(toolCall, contextMinimal as any);
      expect(reviewResult.isApproved).toBe(false);
      expect(reviewResult.reason).toBe("critic_denied");
    });

    it("should return critic_parse_fallback if critic response is ambiguous", async () => {
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "rm -rf /" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const mockProviderAmbiguous = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "MAYBE\nI am not sure about safety.";
        }),
      };

      const contextMinimal = {
        provider: mockProviderAmbiguous,
        resolvedModel: "gemini-3.5-flash",
        options: {},
      };

      const reviewResult = await criticGate.review(toolCall, contextMinimal as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("critic_parse_fallback");
    });

    it("should handle prompt without Tool heading when prompt is overridden", async () => {
      vi.spyOn(CriticGate.prototype as any, "buildReviewPrompt").mockReturnValueOnce("Some prompt text without any colon heading");
      const criticGate = new CriticGate();
      const toolCall = {
        id: "call-1",
        name: "execute_command",
        args: { command: "rm -rf /" },
        _approval: { tier: APPROVAL_TIERS.DANGER as any, tierLabel: "DANGER" },
      };

      const mockProviderApprove = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "APPROVE";
        }),
      };

      const contextMinimal = {
        provider: mockProviderApprove,
        resolvedModel: "gemini-3.5-flash",
        options: {},
      };

      const reviewResult = await criticGate.review(toolCall, contextMinimal as any);
      expect(reviewResult.isApproved).toBe(true);
      expect(reviewResult.reason).toBe("critic_approved");
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

    it("should emit approval_required events and wait for user approval resolution", async () => {
      vi.mocked(mockApprovalEngine.checkBatch).mockReturnValue({
        needsApproval: [{ name: "danger_tool", id: "1", _approval: { tier: APPROVAL_TIERS.DANGER, tierLabel: "DANGER" } }],
        approved: [],
      } as any);

      const promise = checkAndWaitForApproval(
        [{ name: "danger_tool", id: "1" }] as any,
        mockAgenticContext as any,
        mockApprovalEngine,
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conv-123")).toBe(true);
      });

      const pendingApproval = pendingApprovals.get("conv-123");
      expect(pendingApproval).toBeDefined();
      expect(pendingApproval?.type).toBe("tool");

      (pendingApproval as any)?.resolve({ isApproved: true, shouldApproveAll: false });

      const result = await promise;
      expect(result.isApproved).toBe(true);
      expect(result.shouldApproveAll).toBe(false);
      expect(mockAgenticContext.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "approval_required" })
      );
    });

    it("should handle timeout when user does not respond in time", async () => {
      vi.useFakeTimers();

      vi.mocked(mockApprovalEngine.checkBatch).mockReturnValue({
        needsApproval: [{ name: "danger_tool", id: "1", _approval: { tier: APPROVAL_TIERS.DANGER, tierLabel: "DANGER" } }],
        approved: [],
      } as any);

      const promise = checkAndWaitForApproval(
        [{ name: "danger_tool", id: "1" }] as any,
        mockAgenticContext as any,
        mockApprovalEngine,
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conv-123")).toBe(true);
      });

      vi.advanceTimersByTime(120_000);

      const result = await promise;
      expect(result.isApproved).toBe(false);
      expect(pendingApprovals.has("conv-123")).toBe(false);

      vi.useRealTimers();
    });

    it("should reject previous approval if superseded by a new approval request", async () => {
      vi.mocked(mockApprovalEngine.checkBatch).mockReturnValue({
        needsApproval: [{ name: "danger_tool", id: "1", _approval: { tier: APPROVAL_TIERS.DANGER, tierLabel: "DANGER" } }],
        approved: [],
      } as any);

      const promise1 = checkAndWaitForApproval(
        [{ name: "danger_tool", id: "1" }] as any,
        mockAgenticContext as any,
        mockApprovalEngine,
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conv-123")).toBe(true);
      });

      const promise2 = checkAndWaitForApproval(
        [{ name: "danger_tool", id: "1" }] as any,
        mockAgenticContext as any,
        mockApprovalEngine,
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conv-123")).toBe(true);
      });

      const result1 = await promise1;
      expect(result1.isApproved).toBe(false);

      (pendingApprovals.get("conv-123") as any)?.resolve({ isApproved: true, shouldApproveAll: false });
      const result2 = await promise2;
      expect(result2.isApproved).toBe(true);
    });

    it("should return shouldApproveAll=true when user selects approve all option", async () => {
      vi.mocked(mockApprovalEngine.checkBatch).mockReturnValue({
        needsApproval: [{ name: "danger_tool", id: "1", _approval: { tier: APPROVAL_TIERS.DANGER, tierLabel: "DANGER" } }],
        approved: [],
      } as any);

      const promise = checkAndWaitForApproval(
        [{ name: "danger_tool", id: "1" }] as any,
        mockAgenticContext as any,
        mockApprovalEngine,
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conv-123")).toBe(true);
      });

      (pendingApprovals.get("conv-123") as any)?.resolve({ isApproved: true, shouldApproveAll: true });

      const result = await promise;
      expect(result.isApproved).toBe(true);
      expect(result.shouldApproveAll).toBe(true);
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

    it("should handle error when persistCompactionSummary rejects", async () => {
      vi.mocked(AutoCompactionTrigger.evaluate).mockReturnValue({ shouldCompact: true } as any);
      vi.mocked(CompactionService.compactConversation).mockResolvedValue({
        compactedMessages: [{ role: "system", content: "Summary" }],
        summaryText: "distilled text",
        preCompactTokenCount: 500,
        postCompactTokenCount: 100,
      } as any);
      vi.mocked(ConversationEmbeddingService.persistCompactionSummary).mockRejectedValueOnce(new Error("Database write error"));

      const pressureResult = await manageContextPressure(
        [{ role: "user", content: "long message" }],
        mockAgenticContext as any,
        mockAgenticLoopState as any,
        "TestHarness",
      );

      expect(pressureResult.messages).toHaveLength(1);
      expect(ConversationEmbeddingService.persistCompactionSummary).toHaveBeenCalled();
    });

    it("should fallback to defaults when metadata fields are missing in context", async () => {
      vi.mocked(AutoCompactionTrigger.evaluate).mockReturnValue({ shouldCompact: true } as any);
      vi.mocked(CompactionService.compactConversation).mockResolvedValue({
        compactedMessages: [{ role: "system", content: "Summary" }],
        summaryText: "distilled text",
        preCompactTokenCount: 500,
        postCompactTokenCount: 100,
      } as any);

      const contextWithoutMetadata = {
        ...mockAgenticContext,
        project: undefined,
        username: undefined,
        traceId: undefined,
        agent: undefined,
      };

      const pressureResult = await manageContextPressure(
        [{ role: "user", content: "long message" }],
        contextWithoutMetadata as any,
        mockAgenticLoopState as any,
        "TestHarness",
      );

      expect(pressureResult.messages).toHaveLength(1);
      expect(CompactionService.compactConversation).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          project: "",
          username: "",
          traceId: null,
          agent: null,
        })
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

    it("should block all tools during plan mode and append warning message", () => {
      const pendingToolCalls = [
        { id: "call-1", name: "read_file", args: {} },
      ];
      const currentMessages: any[] = [];
      const pass = { streamedText: "distilled plan text", streamedThinking: "thinking content", thinkingSignature: "signature" };

      const result = blockUnauthorizedToolCalls(pendingToolCalls as any, currentMessages, pass as any, {} as any);
      expect(result.allBlocked).toBe(true);
      expect(pendingToolCalls).toHaveLength(0);
      expect(currentMessages).toHaveLength(2);
      expect(currentMessages[0].content).toBe("distilled plan text");
      expect(currentMessages[1].content).toContain("You are in PLANNING MODE");
    });

    it("should enter plan mode when enter_plan_mode is encountered", async () => {
      const state = { planModeActive: false, planModeText: "" };
      const emitSpy = vi.fn();
      await checkForPlanModeEntry([{ name: "enter_plan_mode" }] as any, [], state as any, emitSpy);
      expect(state.planModeActive).toBe(true);
      expect(emitSpy).toHaveBeenCalled();
    });

    it("should handle exit_plan_mode with autoApprove: true", async () => {
      const exitPlanToolCall = { id: "exit-call-id", name: "exit_plan_mode", args: {} };
      const pass = { streamedText: "A gorgeous layout design plan", streamedThinking: "", thinkingSignature: "" };
      const toolResults = [{ id: "exit-call-id", name: "exit_plan_mode", result: null }];
      const currentMessages = [{ role: "system", content: "instructions" }];
      const context = {
        options: { autoApprove: true },
        emit: vi.fn(),
        conversationId: "conversation-id-123",
        requestStart: performance.now(),
      };
      const state = {
        planModeActive: true,
        planModeText: "Active plan text value",
        overallUsage: { inputTokens: 10, outputTokens: 20 },
      };

      const result = await handleExitPlanMode(
        exitPlanToolCall as any,
        pass as any,
        toolResults as any,
        currentMessages as any,
        context as any,
        state as any
      );

      expect(result.shouldContinueLoop).toBe(true);
      expect(state.planModeActive).toBe(false);
      expect(state.planModeText).toBe("");
      expect(toolResults[0].result).not.toBeNull();
      expect((toolResults[0].result as any).isApproved).toBe(true);
    });

    it("should handle exit_plan_mode with manual approval true", async () => {
      const exitPlanToolCall = { id: "exit-call-id", name: "exit_plan_mode", args: {} };
      const pass = { streamedText: "Manual plan text", streamedThinking: "", thinkingSignature: "" };
      const toolResults = [{ id: "exit-call-id", name: "exit_plan_mode", result: null }];
      const currentMessages: any[] = [];
      const context = {
        options: { autoApprove: false },
        emit: vi.fn(),
        conversationId: "conversation-id-123",
        requestStart: performance.now(),
      };
      const state = {
        planModeActive: true,
        planModeText: "",
        overallUsage: { inputTokens: 10, outputTokens: 20 },
      };

      const promise = handleExitPlanMode(
        exitPlanToolCall as any,
        pass as any,
        toolResults as any,
        currentMessages as any,
        context as any,
        state as any
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conversation-id-123")).toBe(true);
      });

      const pendingApproval = pendingApprovals.get("conversation-id-123");
      (pendingApproval as any).resolve(true);

      const result = await promise;
      expect(result.shouldContinueLoop).toBe(true);
      expect(state.planModeActive).toBe(false);
    });

    it("should handle exit_plan_mode when manual approval is rejected", async () => {
      const exitPlanToolCall = { id: "exit-call-id", name: "exit_plan_mode", args: {} };
      const pass = { streamedText: "Manual plan text", streamedThinking: "", thinkingSignature: "" };
      const toolResults = [{ id: "exit-call-id", name: "exit_plan_mode", result: null }];
      const currentMessages: any[] = [];
      const emitSpy = vi.fn();
      const context = {
        options: { autoApprove: false },
        emit: emitSpy,
        conversationId: "conversation-id-123",
        requestStart: performance.now(),
      };
      const state = {
        planModeActive: true,
        planModeText: "",
        overallUsage: { inputTokens: 10, outputTokens: 20 },
      };

      const promise = handleExitPlanMode(
        exitPlanToolCall as any,
        pass as any,
        toolResults as any,
        currentMessages as any,
        context as any,
        state as any
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conversation-id-123")).toBe(true);
      });

      const pendingApproval = pendingApprovals.get("conversation-id-123");
      (pendingApproval as any).resolve(false);

      const result = await promise;
      expect(result.shouldContinueLoop).toBe(false);
      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ message: "Plan rejected — execution cancelled." }));
    });

    it("should cancel previous pending approval if a new one is requested", async () => {
      const exitPlanToolCall = { id: "exit-call-id", name: "exit_plan_mode", args: {} };
      const pass = { streamedText: "Manual plan text", streamedThinking: "", thinkingSignature: "" };
      const toolResults = [{ id: "exit-call-id", name: "exit_plan_mode", result: null }];
      const currentMessages: any[] = [];
      const context = {
        options: { autoApprove: false },
        emit: vi.fn(),
        conversationId: "conversation-id-123",
        requestStart: performance.now(),
      };
      const state = {
        planModeActive: true,
        planModeText: "",
        overallUsage: { inputTokens: 10, outputTokens: 20 },
      };

      const promise1 = handleExitPlanMode(
        exitPlanToolCall as any,
        pass as any,
        toolResults as any,
        currentMessages as any,
        context as any,
        state as any
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conversation-id-123")).toBe(true);
      });

      const promise2 = handleExitPlanMode(
        exitPlanToolCall as any,
        pass as any,
        toolResults as any,
        currentMessages as any,
        context as any,
        state as any
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conversation-id-123")).toBe(true);
      });

      const result1 = await promise1;
      expect(result1.shouldContinueLoop).toBe(false);

      const pendingApproval = pendingApprovals.get("conversation-id-123");
      (pendingApproval as any).resolve(true);

      const result2 = await promise2;
      expect(result2.shouldContinueLoop).toBe(true);
    });

    it("should reject manual approval on timeout", async () => {
      vi.useFakeTimers();
      const exitPlanToolCall = { id: "exit-call-id", name: "exit_plan_mode", args: {} };
      const pass = { streamedText: "Manual plan text", streamedThinking: "", thinkingSignature: "" };
      const toolResults = [{ id: "exit-call-id", name: "exit_plan_mode", result: null }];
      const currentMessages: any[] = [];
      const context = {
        options: { autoApprove: false },
        emit: vi.fn(),
        conversationId: "conversation-id-123",
        requestStart: performance.now(),
      };
      const state = {
        planModeActive: true,
        planModeText: "",
        overallUsage: { inputTokens: 10, outputTokens: 20 },
      };

      const promise = handleExitPlanMode(
        exitPlanToolCall as any,
        pass as any,
        toolResults as any,
        currentMessages as any,
        context as any,
        state as any
      );

      await vi.waitFor(() => {
        expect(pendingApprovals.has("conversation-id-123")).toBe(true);
      });

      vi.advanceTimersByTime(120_000);

      const result = await promise;
      expect(result.shouldContinueLoop).toBe(false);
      vi.useRealTimers();
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
      const stashReference = createSandboxCheckpoint("/my-git-repo", emitSpy);
      expect(stashReference).toBe("stash-sha-123");
      expect(emitSpy).toHaveBeenCalled();
    });

    it("should restore stash checkpoint successfully", () => {
      vi.mocked(execSync).mockReturnValue("");
      const emitSpy = vi.fn();
      const success = restoreSandboxCheckpoint("/my-git-repo", "stash-sha-123", emitSpy);
      expect(success).toBe(true);
      expect(emitSpy).toHaveBeenCalled();
    });

    it("should fail open and return null if workspaceRoot is undefined", () => {
      const result = createSandboxCheckpoint(undefined, vi.fn());
      expect(result).toBeNull();
    });

    it("should return false when restoring sandbox if workspaceRoot is undefined", () => {
      const result = restoreSandboxCheckpoint(undefined, "stash-reference-123", vi.fn());
      expect(result).toBe(false);
    });

    it("should fail open if isGitRepository returns false", () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("not a git repo");
      });
      const result = createSandboxCheckpoint("/non-git-directory", vi.fn());
      expect(result).toBeNull();
    });

    it("should fail open and return null if git stash create returns empty string", () => {
      vi.mocked(execSync)
        .mockReturnValueOnce("" as any)
        .mockReturnValueOnce("" as any)
        .mockReturnValueOnce("" as any);

      const result = createSandboxCheckpoint("/git-repo", vi.fn());
      expect(result).toBeNull();
    });

    it("should log warning and return null if git add fails", () => {
      vi.mocked(execSync)
        .mockReturnValueOnce("" as any)
        .mockImplementationOnce(() => {
          throw new Error("git add failed");
        });

      const result = createSandboxCheckpoint("/git-repo", vi.fn());
      expect(result).toBeNull();
    });

    it("should log error and return false if git checkout fails during restore", () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("git checkout failed");
      });
      const result = restoreSandboxCheckpoint("/git-repo", "stash-reference-123", vi.fn());
      expect(result).toBe(false);
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

    it("should execute streaming tools", async () => {
      vi.mocked(ToolOrchestratorService.isStreamable).mockReturnValueOnce(true);
      const executeToolStreamingMock = vi.fn().mockImplementation(async (name, args, onProgress, context) => {
        onProgress("chunk", "progress data", { progress: 50 });
        return "streaming-result";
      });
      vi.spyOn(ToolOrchestratorService, "executeToolStreaming").mockImplementation(executeToolStreamingMock as any);

      const hooks = { run: vi.fn() } as unknown as AgentHooks;
      const emitSpy = vi.fn();
      const context = { emit: emitSpy, options: {}, requestId: "request-id-123" };
      const tools = { finalTools: [] };

      const results = await executeToolBatch(
        [{ name: "write_file", id: "stream-id-1", args: { content: "content" } }],
        context as any,
        tools as any,
        hooks,
        { iterations: 2 } as any,
      );

      expect(results).toHaveLength(1);
      expect(results[0].result).toBe("streaming-result");
      expect(executeToolStreamingMock).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SERVER_SENT_EVENT_TYPES.TOOL_OUTPUT,
          toolCallId: "stream-id-1",
          event: "chunk",
          data: "progress data",
        })
      );
    });

    it("should execute a single tool call", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue("single-val");
      const hooks = { run: vi.fn() } as unknown as AgentHooks;
      const context = { emit: vi.fn(), options: {} };
      const tools = { finalTools: [] };

      const result = await executeToolSingle(
        { name: "read_file", id: "single-1", args: {} },
        context as any,
        tools as any,
        hooks,
        { iterations: 1 } as any,
      );

      expect(result.result).toBe("single-val");
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

    it("should fallback to promptTokens if inputTokens is 0", () => {
      const pass = { usage: { inputTokens: 0, promptTokens: 75, outputTokens: 0 } };
      const result = finalizePassTracker(pass as any, "req-2");
      expect(result.finalInputTokens).toBe(75);
      expect(ConversationGenerationTracker.complete).toHaveBeenCalledWith("req-2");
    });

    it("should handle 0 inputTokens and 0 promptTokens", () => {
      const pass = { usage: { inputTokens: 0, promptTokens: 0, outputTokens: 0 } };
      const result = finalizePassTracker(pass as any, "req-3");
      expect(result.finalInputTokens).toBe(0);
      expect(ConversationGenerationTracker.complete).toHaveBeenCalledWith("req-3");
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

    it("should return false if model is not Codex", () => {
      const pass = { streamedText: "plan outline", streamedThinking: "" };
      const currentMessages: any[] = [];
      const context = { resolvedModel: "gemini-3.5-flash" };

      const detection = handleCodexPlanningResponse(
        pass as any,
        currentMessages,
        context as any,
        { iterations: 1 } as any,
        [{ name: "run_code" }] as any,
        "TestHarness",
      );

      expect(detection.shouldContinueLoop).toBe(false);
      expect(currentMessages).toHaveLength(0);
    });

    it("should return false if no tools are available", () => {
      const pass = { streamedText: "plan outline", streamedThinking: "" };
      const currentMessages: any[] = [];
      const context = { resolvedModel: "openai-codex-1" };

      const detection = handleCodexPlanningResponse(
        pass as any,
        currentMessages,
        context as any,
        { iterations: 1 } as any,
        [],
        "TestHarness",
      );

      expect(detection.shouldContinueLoop).toBe(false);
      expect(currentMessages).toHaveLength(0);
    });

    it("should return false if already prompted with continuation request", () => {
      const pass = { streamedText: "plan outline", streamedThinking: "" };
      const currentMessages = [
        { role: "system", content: "If you have fully completed the user's request, please output..." }
      ];
      const context = { resolvedModel: "openai-codex-1" };

      const detection = handleCodexPlanningResponse(
        pass as any,
        currentMessages as any,
        context as any,
        { iterations: 1 } as any,
        [{ name: "run_code" }] as any,
        "TestHarness",
      );

      expect(detection.shouldContinueLoop).toBe(false);
    });
  });

  describe("ToolDiscoveryNudge", () => {
    it("should nudging higher-tier model by advising manual enable_tools call", () => {
      const currentMessages: any[] = [];
      const context = {
        resolvedModel: "gemini-3.5-pro",
        agentConversationId: "conversation-id-123",
      };

      injectToolDiscoveryNudge(
        [{ name: "search_tools", id: "search-id-1" }] as any,
        [{ id: "search-id-1", result: { matches: [{ name: "run_tests", isEnabled: false }] } }] as any,
        currentMessages,
        context as any,
      );

      expect(currentMessages).toHaveLength(1);
      expect(currentMessages[0].content).toContain("Call enable_tools with these tool names now");
    });

    it("should return immediately if search matches is not an array", () => {
      const currentMessages: any[] = [];
      const context = {
        resolvedModel: "gemini-3.5-pro",
        agentConversationId: "conversation-id-123",
      };

      injectToolDiscoveryNudge(
        [{ name: "search_tools", id: "search-id-1" }] as any,
        [{ id: "search-id-1", result: { matches: "not-an-array" } }] as any,
        currentMessages,
        context as any,
      );

      expect(currentMessages).toHaveLength(0);
    });

    it("should return immediately if no tools are disabled", () => {
      const currentMessages: any[] = [];
      const context = {
        resolvedModel: "gemini-3.5-pro",
        agentConversationId: "conversation-id-123",
      };

      injectToolDiscoveryNudge(
        [{ name: "search_tools", id: "search-id-1" }] as any,
        [{ id: "search-id-1", result: { matches: [{ name: "run_tests", isEnabled: true }] } }] as any,
        currentMessages,
        context as any,
      );

      expect(currentMessages).toHaveLength(0);
    });
  });

  describe("SystemReminderInjector", () => {
    it("should return immediately if reminderModel option is not configured", async () => {
      const currentMessages: any[] = [];
      const state = { iterations: 8 };
      const context = {
        options: { reminderModel: undefined },
        emit: vi.fn(),
      };

      await maybeInjectSystemReminder(currentMessages, state as any, context as any);
      expect(currentMessages).toHaveLength(0);
    });

    it("should return immediately if iteration is less than first trigger limit", async () => {
      const currentMessages: any[] = [];
      const state = { iterations: 3 };
      const context = {
        options: { reminderModel: "gemini-3.5-flash", reminderInterval: 8 },
        emit: vi.fn(),
      };

      await maybeInjectSystemReminder(currentMessages, state as any, context as any);
      expect(currentMessages).toHaveLength(0);
    });

    it("should return immediately if iteration is not modulo of interval", async () => {
      const currentMessages: any[] = [];
      const state = { iterations: 6 };
      const context = {
        options: { reminderModel: "gemini-3.5-flash", reminderInterval: 8 },
        emit: vi.fn(),
      };

      await maybeInjectSystemReminder(currentMessages, state as any, context as any);
      expect(currentMessages).toHaveLength(0);
    });

    it("should return immediately if system prompt message is missing or too short", async () => {
      const currentMessages = [{ role: "system", content: "Short" }];
      const state = { iterations: 8 };
      const context = {
        options: { reminderModel: "gemini-3.5-flash", reminderInterval: 8 },
        emit: vi.fn(),
        provider: {},
      };

      await maybeInjectSystemReminder(currentMessages as any, state as any, context as any);
      expect(currentMessages).toHaveLength(1);
    });

    it("should return immediately if extractReminderViaLLM returns null", async () => {
      const currentMessages = [{ role: "system", content: "A".repeat(300) }];
      const state = { iterations: 8 };
      const context = {
        options: { reminderModel: "gemini-3.5-flash", reminderInterval: 8 },
        emit: vi.fn(),
        provider: {
          generateTextStream: vi.fn().mockImplementation(async function* () {
            yield "- Short constraint";
          }),
        },
      };

      await maybeInjectSystemReminder(currentMessages as any, state as any, context as any);
      expect(currentMessages).toHaveLength(1);
    });

    it("should reuse cached reminders for subsequent injections", async () => {
      const currentMessages1 = [{ role: "system", content: "A".repeat(300) }];
      const state1 = { iterations: 8 };
      const generateTextStreamSpy = vi.fn().mockImplementation(async function* () {
        yield "- Cached rule one\n- Cached rule two\n- Cached rule three";
      });
      const context = {
        options: { reminderModel: "gemini-3.5-flash", reminderInterval: 8 },
        emit: vi.fn(),
        provider: {
          generateTextStream: generateTextStreamSpy,
        },
        agentConversationId: "cached-session-id",
      };

      await maybeInjectSystemReminder(currentMessages1 as any, state1 as any, context as any);
      expect(currentMessages1).toHaveLength(2);
      expect(generateTextStreamSpy).toHaveBeenCalledTimes(1);

      const currentMessages2 = [{ role: "system", content: "A".repeat(300) }];
      const state2 = { iterations: 16 };
      await maybeInjectSystemReminder(currentMessages2 as any, state2 as any, context as any);
      expect(currentMessages2).toHaveLength(2);
      expect(currentMessages2[1].content).toContain("- Cached rule one");
      expect(generateTextStreamSpy).toHaveBeenCalledTimes(1);
      cleanupReminderCache("cached-session-id");
    });
  });

  describe("SystemReminderExtractor", () => {
    it("should successfully extract behavioral constraints with valid bullet points", async () => {
      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "- Always verify your code\n- Never skip testing\n- Follow instructions strictly";
        }),
      };
      const logBackgroundLlmCallSpy = vi.spyOn(RequestLogger, "logBackgroundLlmCall").mockResolvedValue({} as any);

      const result = await extractReminderViaLLM(
        "A system prompt that needs to be distilled",
        mockProvider as any,
        "gemini-3.5-flash",
        undefined,
        {
          project: "test-project",
          username: "test-user",
          requestId: "request-id-123",
        }
      );

      expect(result).toBe("- Always verify your code\n- Never skip testing\n- Follow instructions strictly");
      expect(mockProvider.generateTextStream).toHaveBeenCalled();
      expect(logBackgroundLlmCallSpy).toHaveBeenCalled();
    });

    it("should return null if LLM output is too short", async () => {
      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "- Short";
        }),
      };

      const result = await extractReminderViaLLM(
        "System prompt content",
        mockProvider as any,
        "gemini-3.5-flash",
        undefined
      );

      expect(result).toBeNull();
    });

    it("should return null if LLM output does not have at least 3 bullet points", async () => {
      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "- Only one bullet point\n- And a second one, but no third";
        }),
      };

      const result = await extractReminderViaLLM(
        "System prompt content",
        mockProvider as any,
        "gemini-3.5-flash",
        undefined
      );

      expect(result).toBeNull();
    });

    it("should cap at 12 bullets and break if total characters exceed 1500", async () => {
      const bulletPoints: string[] = [];
      for (let index = 0; index < 20; index++) {
        bulletPoints.push(`- Constaining rule number ${index} which is extremely long and repetitive to push the limit`);
      }
      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield bulletPoints.join("\n");
        }),
      };

      const result = await extractReminderViaLLM(
        "System prompt content",
        mockProvider as any,
        "gemini-3.5-flash",
        undefined
      );

      expect(result).not.toBeNull();
      const resultingBullets = result!.split("\n");
      expect(resultingBullets.length).toBeLessThanOrEqual(12);
      expect(result!.length).toBeLessThanOrEqual(1500);
    });

    it("should fail silently and return null on LLM generator exception", async () => {
      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(() => {
          throw new Error("API Limit Exceeded");
        }),
      };

      const result = await extractReminderViaLLM(
        "System prompt content",
        mockProvider as any,
        "gemini-3.5-flash",
        undefined
      );

      expect(result).toBeNull();
    });

    it("should handle error in RequestLogger.logBackgroundLlmCall without crashing", async () => {
      const mockProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          yield "- First constraint rule line\n- Second constraint rule line\n- Third constraint rule line";
        }),
      };
      vi.spyOn(RequestLogger, "logBackgroundLlmCall").mockRejectedValue(new Error("Logger failed"));

      const result = await extractReminderViaLLM(
        "System prompt content",
        mockProvider as any,
        "gemini-3.5-flash",
        undefined,
        {
          project: "test-project",
          username: "test-user",
          requestId: "request-id-123",
        }
      );

      expect(result).toBe("- First constraint rule line\n- Second constraint rule line\n- Third constraint rule line");
    });
  });

  describe("Finalizer", () => {
    describe("swapMessageContent", () => {
      it("should return immediately if rawContent starts with SYSTEM_CONTEXT prefix", () => {
        const message = {
          role: "user",
          content: "Clean content text",
          rawContent: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT} Some context notes`,
        };
        swapMessageContent(message as any);
        expect(message.content).toBe("Clean content text");
      });

      it("should swap content and rawContent if rawContent is set", () => {
        const message = {
          role: "user",
          content: "Clean content text",
          rawContent: "Dirty raw content text",
        };
        swapMessageContent(message as any);
        expect(message.content).toBe("Dirty raw content text");
        expect(message.rawContent).toBe("Clean content text");
      });

      it("should parse clean content from SYSTEM_CONTEXT prefix with altSplit", () => {
        const message = {
          role: "user",
          content: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT} System context\n${PROMPT_DELIMITERS.USER_MESSAGE}\nExpected clean content`,
          rawContent: undefined,
        };
        swapMessageContent(message as any);
        expect(message.content).toBe("Expected clean content");
        expect(message.rawContent).toContain(PROMPT_DELIMITERS.SYSTEM_CONTEXT);
      });

      it("should parse clean content from local time prefix index split", () => {
        const message = {
          role: "user",
          content: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX} 2026-06-22]\n\nExpected clean content text value`,
          rawContent: undefined,
        };
        swapMessageContent(message as any);
        expect(message.content).toBe("Expected clean content text value");
        expect(message.rawContent).toContain(PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX);
      });
    });

    describe("finalizeTextGeneration", () => {
      it("should assemble WAV from audio chunks and upload file", async () => {
        const mockFileServiceUpload = vi.spyOn(FileService, "uploadFile").mockResolvedValue({ ref: "minio-audio-reference-url" } as any);
        const emitSpy = vi.fn();
        const context = {
          providerName: "google",
          resolvedModel: "gemini-3.5-flash",
          options: { agenticLoopEnabled: true },
          conversationId: "conversation-id-123",
          emit: emitSpy,
        };
        const payload = {
          text: "Response with speech",
          thinking: null,
          audioChunks: [Buffer.from("PCM audio bytes chunk one").toString("base64")],
          audioSampleRate: 16000,
          usage: { inputTokens: 5, outputTokens: 10 },
          totalSec: 1.5,
        };

        await finalizeTextGeneration(context as any, payload as any);

        expect(mockFileServiceUpload).toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: SERVER_SENT_EVENT_TYPES.DONE,
            audioRef: "minio-audio-reference-url",
          })
        );
      });

      it("should log chat generation if agenticLoopEnabled is false", async () => {
        const logChatGenerationSpy = vi.spyOn(RequestLogger, "logChatGeneration").mockImplementation(() => Promise.resolve());
        const context = {
          providerName: "openai",
          resolvedModel: "gpt-4o",
          options: { agenticLoopEnabled: false },
          conversationId: "conversation-id-123",
          emit: vi.fn(),
        };
        const payload = {
          text: "Regular chat text response",
          thinking: null,
          usage: { inputTokens: 20, outputTokens: 30 },
          totalSec: 0.8,
        };

        await finalizeTextGeneration(context as any, payload as any);

        expect(logChatGenerationSpy).toHaveBeenCalled();
      });

      it("should include telemetry metadata parentConversationId and parentAgentConversationId", async () => {
        const appendAndFinalizeSpy = vi.mocked(appendAndFinalize);
        const context = {
          providerName: "google",
          resolvedModel: "gemini-3.5-flash",
          options: { agenticLoopEnabled: true },
          conversationId: "conversation-id-123",
          parentConversationId: "parent-conversation-id-456",
          parentAgentConversationId: "parent-agent-conversation-id-789",
          emit: vi.fn(),
        };
        const payload = {
          text: "Response content",
          thinking: null,
        };

        await finalizeTextGeneration(context as any, payload as any);

        expect(appendAndFinalizeSpy).toHaveBeenCalledWith(
          "conversation-id-123",
          "",
          undefined,
          expect.any(Array),
          expect.objectContaining({
            parentConversationId: "parent-conversation-id-456",
            parentAgentConversationId: "parent-agent-conversation-id-789",
            isSubAgent: true,
          }),
          undefined
        );
      });
    });

    describe("sanitizeMessagesForPersistence", () => {
      it("should filter out identity prompts and compaction summaries", () => {
        const messages = [
          { role: "system", content: "Identity prompt text", _isIdentityPrompt: true },
          { role: "user", content: "compaction summary here", isCompactSummary: true },
          { role: "user", content: `${PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX} system context note` },
          { role: "user", content: "Normal user message content" },
        ];

        const result = sanitizeMessagesForPersistence(messages as any);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe("Normal user message content");
      });
    });
  });
});


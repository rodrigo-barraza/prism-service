/**
 * exhaustionRecoveryLoop.test.ts
 *
 * Integration-level test that constructs a real ReActHarness instance with
 * mocked dependencies and verifies the FULL loop behavior when all iterations
 * produce only tool calls. This tests the EXACT scenario from subagent
 * 48981e57: maxIterations hit with no text output → recovery pass must fire.
 *
 * KEY FINDING: The recovery pass DOES fire. The consumeStream mock is called
 * maxIterations + 1 times (the +1 is the recovery pass itself, which also
 * goes through consumeStream). The real production issue is likely that the
 * self-hosted model produced empty/garbage output on the recovery pass.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── Heavy mocks ──────────────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn() },
}));

vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));

vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    get: (_locale: string, key: string) => {
      if (key.includes("subAgent")) return "Sub-agent iteration limit reached. Summarize progress.";
      if (key.includes("exhaustionRecovery")) return "Maximum tool-call iterations reached. Summarize your progress.";
      return `[locale:${key}]`;
    },
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lifecycle/HookInitializer.ts", () => ({
  createStandardHooks: () => {
    const noopHooks = {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
      }),
    };
    return { hooks: noopHooks, approvalEngine: {} };
  },
}));

vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: vi.fn().mockImplementation(async (toolCalls: Array<{ name: string; id: string }>) =>
    toolCalls.map((toolCall) => ({
      name: toolCall.name,
      id: toolCall.id,
      result: { success: true, data: "Search result for query" },
      durationMilliseconds: 50,
    })),
  ),
  executeToolSingle: vi.fn(),
}));

vi.mock("../lifecycle/ApprovalGate.ts", () => ({
  checkAndWaitForApproval: vi.fn().mockResolvedValue({ isApproved: true, shouldApproveAll: false }),
}));

vi.mock("../lifecycle/PostExecutionEmitter.ts", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));

vi.mock("../lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lifecycle/OutputTruncationRecovery.ts", () => ({
  isOutputTruncated: vi.fn().mockReturnValue(false),
  injectContinuationContext: vi.fn(),
  injectErrorAsConversationMessage: vi.fn().mockImplementation(
    (messages: ConversationMessage[], errorText: string) => {
      messages.push({ role: "system", content: errorText });
    },
  ),
  buildExhaustedRecoveryMessage: vi.fn().mockReturnValue("exhausted-recovery"),
  buildProviderErrorMessage: vi.fn().mockReturnValue("provider-error"),
  MAX_OUTPUT_TRUNCATION_RECOVERIES: 3,
  isAtOutputCeiling: vi.fn().mockReturnValue(false),
}));

vi.mock("../lifecycle/ContextPressureManager.ts", () => ({
  manageContextPressure: vi.fn().mockImplementation(async (messages: unknown[]) => ({
    messages,
    compactionPerformed: false,
  })),
}));

vi.mock("../lifecycle/ContextExhaustionGuard.ts", () => ({
  isContextExhausted: vi.fn().mockReturnValue(false),
  logContextExhaustion: vi.fn(),
  emitContextExhaustedStatus: vi.fn(),
  buildContextExhaustedMessage: vi.fn().mockReturnValue("context-exhausted"),
}));

vi.mock("../lifecycle/KVCacheReporter.ts", () => ({
  logKVCacheHitRate: vi.fn(),
}));

vi.mock("../lifecycle/ToolDiscoveryNudge.ts", () => ({
  injectToolDiscoveryNudge: vi.fn(),
}));

vi.mock("../lifecycle/TrackerFinalizer.ts", () => ({
  finalizePassTracker: vi.fn(),
}));

vi.mock("../lifecycle/CodexPlanningDetector.ts", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));

vi.mock("../lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));

vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
}));

vi.mock("../lifecycle/SandboxExecutor.ts", () => ({
  createSandboxCheckpoint: vi.fn().mockReturnValue("mock-stash-ref"),
  restoreSandboxCheckpoint: vi.fn(),
}));

vi.mock("../lifecycle/PlanModeController.ts", () => ({
  blockUnauthorizedToolCalls: vi.fn(),
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({
  buildToolRetryGuidance: vi.fn().mockReturnValue(null),
}));

vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));

vi.mock("#src/services/ToolContext", () => ({
  default: {
    getStore: vi.fn().mockReturnValue(new Map()),
  },
}));

vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
}));

// ── Test suite ───────────────────────────────────────────────

describe("ReActHarness — Tool-Only Loop Until maxIterations Exhaustion", () => {
  let loopIterationCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    loopIterationCounter = 0;
  });

  /**
   * Build a real ReActHarness with a provider that always produces tool calls.
   * The consumeStream mock simulates a model that outputs a search_web tool
   * call on every loop iteration, never producing text.
   *
   * NOTE: The recovery pass (ExhaustionRecovery.ts) also calls consumeStream.
   * So the mock distinguishes between loop-iteration calls (which produce
   * tool calls) and the recovery call (which produces text summary output).
   */
  function buildToolOnlyHarness(maxIterations: number) {
    const mockProvider = {
      generateTextStream: vi.fn().mockImplementation(async function* () {
        yield "recovery summary text";
      }),
      generateTextStreamLive: undefined,
      discoverContextWindow: vi.fn(),
    };

    const context: AgenticContext = {
      project: "prism-chat",
      username: "test-user",
      agent: "OMNI",
      providerName: "vllm-2",
      resolvedModel: "google/gemma-4-12B-it-qat-w4a16-ct",
      modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as any,
      traceId: "test-trace",
      agentConversationId: "test-subagent-conv",
      conversationId: "test-conv",
      parentAgentConversationId: "test-parent-conv",
      provider: mockProvider as any,
      options: {
        maxIterations,
        autoApprove: true,
        agenticLoopEnabled: true,
        isSubAgent: true,
        maxTokens: 8192,
        tools: [{ name: "search_web", description: "Search the web" }],
      },
      messages: [
        { role: "user", content: "Search for software engineers in Vancouver" },
      ],
      emit: vi.fn(),
      signal: undefined as any,
      requestId: "req-test",
      requestStart: performance.now(),
      isNewConversation: true,
    } as any;

    const state = new AgenticLoopState({ originalMessageCount: 1 });

    const tools: ResolvedTools = {
      finalTools: [
        { name: "search_web", description: "Search the web", parameters: {} },
      ] as any,
      resolvedEnabledTools: ["search_web"],
    };

    const harness = new ReActHarness(context, state, tools);

    // Override createProviderStream to NOT return null (no exhaustion guard)
    (harness as any).createProviderStream = vi.fn().mockImplementation(
      async () => mockProvider.generateTextStream(),
    );

    // Override consumeStream: loop iterations produce tool calls,
    // the recovery pass (ExhaustionRecovery) produces text summary.
    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState, _allowedToolNames: Set<string>) => {
        loopIterationCounter++;

        if (loopIterationCounter <= maxIterations) {
          // Simulating loop iteration: model produces a tool call, no text
          pass.streamedText = "";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [
            {
              id: `call-${loopIterationCounter}`,
              name: "search_web",
              args: { query: `Vancouver engineer query ${loopIterationCounter}` },
            },
          ];
          state.streamedToolCalls.push({
            id: `call-${loopIterationCounter}`,
            name: "search_web",
            args: { query: `Vancouver engineer query ${loopIterationCounter}` },
          });
        } else {
          // Recovery pass: model produces text summary (no tools)
          pass.streamedText = "Based on my research, here are the engineers found...";
          pass.finalStreamedText = "Based on my research, here are the engineers found...";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [];
          // Recovery also updates state finalStreamedText
          state.finalStreamedText = pass.streamedText;
        }
        pass.usage = { inputTokens: 10000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );

    // Override enforceContextWindow to pass through
    (harness as any).enforceContextWindow = vi.fn().mockImplementation(
      (messages: ConversationMessage[]) => messages,
    );

    // Override finalize to track but not do real DB work
    (harness as any).finalize = vi.fn().mockResolvedValue(undefined);

    // Override logIteration to no-op
    (harness as any).logIteration = vi.fn();
    (harness as any).emitGenerationProgress = vi.fn();
    (harness as any).emitUsageUpdate = vi.fn();
    (harness as any).checkAndApplyToolSetChanges = vi.fn();

    return { harness, context, state, mockProvider };
  }

  it("should fire the exhaustion recovery pass when ALL iterations produce only tool calls", async () => {
    const maxIterations = 5;
    const { harness, state } = buildToolOnlyHarness(maxIterations);

    await harness.run();

    // The loop should have run maxIterations times + 1 recovery pass
    expect(loopIterationCounter).toBe(maxIterations + 1);
    expect(state.iterations).toBe(maxIterations);

    // streamedToolCalls should have entries from the loop iterations
    expect(state.streamedToolCalls.length).toBe(maxIterations);

    // CRITICAL: conversationOutcome MUST be "exhausted"
    expect(state.conversationOutcome).toBe("exhausted");
  });

  it("should NOT fire recovery when the model produces text on the last iteration", async () => {
    const maxIterations = 3;
    const { harness, state } = buildToolOnlyHarness(maxIterations);

    // Override: on the last iteration, produce text instead of a tool call
    let callCount = 0;
    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState) => {
        callCount++;
        if (callCount < maxIterations) {
          pass.streamedText = "";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [
            {
              id: `call-${callCount}`,
              name: "search_web",
              args: { query: `query ${callCount}` },
            },
          ];
          state.streamedToolCalls.push({
            id: `call-${callCount}`,
            name: "search_web",
            args: { query: `query ${callCount}` },
          });
        } else {
          // Final iteration: text response → clean break
          pass.streamedText = "Here are the engineers I found...";
          pass.finalStreamedText = "Here are the engineers I found...";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [];
        }
        pass.usage = { inputTokens: 5000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );

    await harness.run();

    // Should NOT be "exhausted" — it completed normally with text
    expect(state.conversationOutcome).toBe("completed");
  });

  it("should reproduce the exact subagent 48981e57 scenario: tool-only calls within maxIterations", async () => {
    const maxIterations = 15;
    const { harness, state } = buildToolOnlyHarness(maxIterations);

    const result = await harness.run();

    // Loop ran 15 iterations + 1 recovery pass
    expect(loopIterationCounter).toBe(maxIterations + 1);
    expect(state.iterations).toBe(maxIterations);
    expect(state.streamedToolCalls.length).toBe(maxIterations);

    // CRITICAL: the recovery pass MUST fire
    expect(state.conversationOutcome).toBe("exhausted");

    // The result messages should include assistant messages with tool calls
    const assistantMessagesWithToolCalls = result.messages.filter(
      (message) => message.role === "assistant" && message.toolCalls?.length,
    );
    expect(assistantMessagesWithToolCalls.length).toBe(maxIterations);
  });

  it("should produce recovery even with maxIterations=1 (single tool call, immediate exit)", async () => {
    const { harness, state } = buildToolOnlyHarness(1);
    await harness.run();

    expect(state.iterations).toBe(1);
    expect(state.streamedToolCalls.length).toBe(1);
    // Recovery pass should fire (1 tool call consumed 1 iteration, then recovery)
    expect(loopIterationCounter).toBe(2); // 1 loop + 1 recovery
    expect(state.conversationOutcome).toBe("exhausted");
  });

  it("should set outcome to 'completed' when the model produces text on iteration 1", async () => {
    const { harness, state } = buildToolOnlyHarness(10);

    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState) => {
        pass.streamedText = "I found 5 software engineers in Vancouver.";
        pass.finalStreamedText = "I found 5 software engineers in Vancouver.";
        pass.streamedThinking = "";
        pass.thinkingSignature = "";
        pass.pendingToolCalls = [];
        pass.usage = { inputTokens: 5000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );

    await harness.run();

    expect(state.iterations).toBe(1);
    expect(state.conversationOutcome).toBe("completed");
  });

  // ── The REAL failure: recovery pass produces empty output ──

  it("should still set outcome to 'exhausted' even when recovery pass provider returns empty", async () => {
    const maxIterations = 5;
    const { harness, state } = buildToolOnlyHarness(maxIterations);

    // Override: recovery pass consumeStream produces empty output
    let callCount = 0;
    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState) => {
        callCount++;
        if (callCount <= maxIterations) {
          pass.streamedText = "";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [
            {
              id: `call-${callCount}`,
              name: "search_web",
              args: { query: `query ${callCount}` },
            },
          ];
          state.streamedToolCalls.push({
            id: `call-${callCount}`,
            name: "search_web",
            args: { query: `query ${callCount}` },
          });
        } else {
          // Recovery pass: model returns EMPTY (the real bug scenario)
          pass.streamedText = "";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [];
        }
        pass.usage = { inputTokens: 10000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );

    await harness.run();

    // Even with empty recovery output, the outcome should still be "exhausted"
    expect(state.conversationOutcome).toBe("exhausted");
    // The recovery pass DID fire (6th call)
    expect(callCount).toBe(maxIterations + 1);
  });

  it("should handle the scenario where the recovery provider stream throws an error", async () => {
    const maxIterations = 3;
    const { harness, state, mockProvider } = buildToolOnlyHarness(maxIterations);

    // Make the recovery pass provider throw
    let callCount = 0;
    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState) => {
        callCount++;
        if (callCount <= maxIterations) {
          pass.streamedText = "";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [
            {
              id: `call-${callCount}`,
              name: "search_web",
              args: { query: `query ${callCount}` },
            },
          ];
          state.streamedToolCalls.push({
            id: `call-${callCount}`,
            name: "search_web",
            args: { query: `query ${callCount}` },
          });
        } else {
          // Recovery pass: provider crashes
          throw new Error("ECONNRESET: Connection reset by peer");
        }
        pass.usage = { inputTokens: 10000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );

    // The error should propagate to the catch block
    // which sets conversationOutcome = "error" and re-throws
    await expect(harness.run()).rejects.toThrow("ECONNRESET");
    expect(state.conversationOutcome).toBe("error");
  });

  it("should trigger exhaustion recovery when the last iteration produces only raw tool call markup (which gets cleaned to empty)", async () => {
    const maxIterations = 3;
    const { harness, state } = buildToolOnlyHarness(maxIterations);

    let callCount = 0;
    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState) => {
        callCount++;
        if (callCount < maxIterations) {
          // Loop iterations: normal tool calls
          pass.streamedText = "";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [
            {
              id: `call-${callCount}`,
              name: "search_web",
              args: { query: `query ${callCount}` },
            },
          ];
          state.streamedToolCalls.push({
            id: `call-${callCount}`,
            name: "search_web",
            args: { query: `query ${callCount}` },
          });
        } else if (callCount === maxIterations) {
          // Final iteration: model outputs raw tool call markup as text,
          // which has no structured tool calls and gets cleaned to empty
          pass.streamedText = "<|tool_call>call:search_web{}<tool_call|>";
          pass.finalStreamedText = "";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [];
        } else {
          // Recovery pass
          pass.streamedText = "Based on my research, here are the engineers found...";
          pass.finalStreamedText = "Based on my research, here are the engineers found...";
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.pendingToolCalls = [];
          state.finalStreamedText = pass.streamedText;
        }
        pass.usage = { inputTokens: 5000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );

    await harness.run();

    // The recovery pass should have fired (4th call)
    expect(callCount).toBe(maxIterations + 1);
    expect(state.conversationOutcome).toBe("exhausted");
  });
});


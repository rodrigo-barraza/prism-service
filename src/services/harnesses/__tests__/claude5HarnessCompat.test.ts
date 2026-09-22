/**
 * claude5HarnessCompat.test.ts — prompt 02 (Claude 5-generation compat),
 * run against a REAL ReActHarness with the dependency mocks of
 * turnInputAcceptance.test.ts:
 *
 *   1. Plan mode never ends a request on an assistant turn (no prefill —
 *      every Claude 4.6+ model rejects it), in the ReAct loop and in the
 *      branching strategies' planning phase.
 *   2. A refusal is not "empty output": no empty-retry ladder, the refusing
 *      pass's partial text is discarded, and the turn ends with a typed
 *      refusal event.
 *   3. Thinking blocks reach the stored assistant message verbatim and in
 *      order, through the real stream-chunk router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { runPlanningPhase } from "../strategies/branchingCommon.ts";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── Heavy mocks (mirrors turnInputAcceptance.test.ts) ─────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    register: vi.fn(),
    complete: vi.fn(),
    setEstimatedInputTokens: vi.fn(),
    update: vi.fn(),
    recordChunkTiming: vi.fn(),
  },
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
  // The harness layers user-configured hooks on top of the built-ins before
  // it starts. Stubbed to a no-op here so this suite stays about exhaustion
  // recovery and never reaches Mongo.
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

const executeToolBatchMock = vi.fn();
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
  executeToolSingle: vi.fn(),
}));

const adjustPendingBackgroundTasksMock = vi.fn().mockResolvedValue(undefined);
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: (...args: unknown[]) => adjustPendingBackgroundTasksMock(...args),
    appendMessages: vi.fn().mockResolvedValue(undefined),
  },
}));

const countRunningTasksMock = vi.fn().mockReturnValue(0);
vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: {
    countRunningTasks: (...args: unknown[]) => countRunningTasksMock(...args),
    hasActiveTask: vi.fn().mockReturnValue(false),
    listTasks: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("#src/services/OrchestratorService", () => ({
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined) },
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
    getToolLabel: vi.fn().mockReturnValue("tool"),
    getToolEmoji: vi.fn().mockReturnValue(""),
  },
}));

vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
}));


// ── Harness factory ──────────────────────────────────────────

/** What the model produces on one iteration, applied to the pass. */
type ScriptedPass = (pass: PassState, state: AgenticLoopState, iteration: number) => void;

const textPass = (text: string): ScriptedPass => (pass, state) => {
  pass.streamedText = text;
  pass.finalStreamedText = text;
  pass.pendingToolCalls = [];
  state.finalStreamedText = text;
};

interface HarnessOptions {
  /** Scripted passes (consumeStream mocked) … */
  script?: ScriptedPass[];
  /** … or raw provider chunks per iteration, routed by the REAL consumeStream. */
  chunks?: unknown[][];
  planModeActive?: boolean;
  maxIterations?: number;
}

function buildHarness({ script, chunks, planModeActive = false, maxIterations = 4 }: HarnessOptions) {
  const conversationId = "claude5-conv";
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const emit = vi.fn();
  const context: AgenticContext = {
    project: "prism-chat",
    username: "test-user",
    agent: "OMNI",
    providerName: "anthropic",
    resolvedModel: "claude-sonnet-5",
    modelDefinition: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 } as any,
    traceId: "test-trace",
    agentConversationId: conversationId,
    conversationId,
    provider: { generateTextStream: vi.fn(), discoverContextWindow: vi.fn() } as any,
    options: {
      maxIterations,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      temperature: 0.7,
      tools: [{ name: "search_web", description: "Search the web" }],
    },
    messages: [{ role: "user", content: "Do the task" }],
    emit,
    signal: undefined as any,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as any;

  const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive });
  const tools: ResolvedTools = {
    finalTools: [
      { name: "search_web", description: "Search the web", parameters: {} },
      { name: "exit_plan_mode", description: "Submit the plan", parameters: {} },
    ] as any,
    resolvedEnabledTools: ["search_web", "exit_plan_mode"],
  };
  const harness = new ReActHarness(context, state, tools);

  (harness as any).createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[]) => {
      iteration++;
      seenMessages.push(messages.map((message) => ({ ...message })));
      const iterationChunks = chunks?.[iteration - 1] ?? ["fallback final answer"];
      return (async function* () {
        for (const chunk of iterationChunks) yield chunk;
      })();
    },
  );
  if (script) {
    (harness as any).consumeStream = vi.fn().mockImplementation(
      async (_stream: unknown, pass: PassState) => {
        const scripted = script[iteration - 1] ?? textPass("fallback final answer");
        pass.streamedThinking = "";
        pass.thinkingSignature = "";
        scripted(pass, state, iteration);
        pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
      },
    );
  }
  (harness as any).enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  const finalizeSnapshots: Array<{ finalStreamedText: string; refusal: unknown }> = [];
  (harness as any).finalize = vi.fn().mockImplementation(async () => {
    finalizeSnapshots.push({
      finalStreamedText: state.finalStreamedText,
      refusal: (state as any).refusal,
    });
  });
  (harness as any).logIteration = vi.fn();
  (harness as any).emitGenerationProgress = vi.fn();
  (harness as any).maybeEmitProgress = vi.fn();
  (harness as any).emitUsageUpdate = vi.fn();
  (harness as any).checkAndApplyToolSetChanges = vi.fn();

  return { harness, context, state, emit, seenMessages, finalizeSnapshots, iterations: () => iteration };
}

const EMPTY_OUTPUT_NUDGE = "Your previous response was empty";

// ── Scenarios ────────────────────────────────────────────────

describe("Claude 5 compat — plan mode never prefills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
  });

  it("ReAct: a text answer in plan mode is followed by a continuation, not left as the last turn", async () => {
    const { harness, seenMessages } = buildHarness({
      planModeActive: true,
      maxIterations: 3,
      script: [textPass("Step 1: read the file. Step 2: patch it."), textPass("Plan: same as above.")],
    });

    await harness.run();

    expect(seenMessages.length).toBeGreaterThanOrEqual(2);
    const secondCall = seenMessages[1];
    const last = secondCall[secondCall.length - 1];
    expect(last.role).not.toBe("assistant");
    // The model's plan text is kept, right before the continuation.
    const previous = secondCall[secondCall.length - 2];
    expect(previous).toMatchObject({ role: "assistant", content: "Step 1: read the file. Step 2: patch it." });
    expect(String(last.content)).toContain("harness.planningMode.submitPlan");
  });

  it("branching strategies: the planning phase never ends a request on an assistant turn", async () => {
    const { harness, seenMessages } = buildHarness({
      script: [textPass("Plan A."), textPass("Plan A, restated."), textPass("Plan A, once more.")],
    });
    const currentMessages: ConversationMessage[] = [{ role: "user", content: "Do the task" }];

    await runPlanningPhase(harness, currentMessages, "Test");

    expect(seenMessages.length).toBeGreaterThanOrEqual(2);
    for (const messagesSeen of seenMessages.slice(1)) {
      expect(messagesSeen[messagesSeen.length - 1].role).not.toBe("assistant");
    }
  });
});

describe("Claude 5 compat — refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
  });

  const refusal = { category: "cyber", explanation: "Declined: could enable cyber harm." };

  it("a mid-stream refusal discards the partial text and ends the turn with a typed event", async () => {
    const { harness, emit, seenMessages, finalizeSnapshots } = buildHarness({
      script: [
        (pass, state) => {
          textPass("Sure, here is how to")(pass, state, 1);
          (pass as any).refusal = refusal;
        },
      ],
    });

    const { messages } = await harness.run();

    expect(seenMessages).toHaveLength(1);
    const events = emit.mock.calls.map((call) => call[0]);
    expect(events.find((event) => event.type === "refusal")).toMatchObject({ type: "refusal", category: "cyber" });
    expect(finalizeSnapshots).toHaveLength(1);
    expect(finalizeSnapshots[0].finalStreamedText).toBe("");
    expect(finalizeSnapshots[0].refusal).toMatchObject({ category: "cyber" });
    expect(messages.some((message) => String(message.content ?? "").includes("Sure, here is how to"))).toBe(false);
  });

  it("a refusal before any output never triggers the empty-output retry ladder", async () => {
    const { harness, emit, seenMessages, context } = buildHarness({
      script: [
        (pass, state) => {
          textPass("")(pass, state, 1);
          (pass as any).refusal = { category: null, explanation: null };
        },
      ],
    });

    const { messages } = await harness.run();

    expect(seenMessages).toHaveLength(1);
    expect(context.options.temperature).toBe(0.7);
    const allText = [...messages, ...seenMessages.flat()].map((message) => String(message.content ?? "")).join("\n");
    expect(allText).not.toContain(EMPTY_OUTPUT_NUDGE);
    expect(emit.mock.calls.map((call) => call[0]).some((event) => event.type === "refusal")).toBe(true);
  });
});

describe("Claude 5 compat — thinking blocks reach the stored message verbatim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    executeToolBatchMock.mockImplementation(async (toolCalls: Array<{ name: string; id: string }>) =>
      toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result: { ok: true }, durationMilliseconds: 5 })),
    );
  });

  it("two thinking blocks with distinct signatures, then tool_use", async () => {
    const blockA = { type: "thinking", thinking: "  First, search. ", signature: "sig-A" };
    const blockB = { type: "thinking", thinking: "", signature: "sig-B" };
    const { harness, seenMessages } = buildHarness({
      chunks: [
        [
          { type: "thinking", content: blockA.thinking },
          { type: "thinking_block", block: blockA },
          { type: "thinking_block", block: blockB },
          { type: "toolCallStart", id: "toolu_1", name: "search_web" },
          { type: "toolCall", id: "toolu_1", name: "search_web", args: { query: "x" } },
        ],
        ["Found it."],
      ],
    });

    await harness.run();

    expect(seenMessages).toHaveLength(2);
    const stored = seenMessages[1].find((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
    expect(stored).toBeDefined();
    expect(stored!.thinkingBlocks).toStrictEqual([blockA, blockB]);
  });
});

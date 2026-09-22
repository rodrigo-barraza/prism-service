/**
 * turnInputAcceptance.test.ts
 *
 * Acceptance scenarios for the TurnInputMailbox (mid-turn input), run against
 * a REAL ReActHarness with the same dependency mocks as
 * exhaustionRecoveryLoop.test.ts:
 *
 *   1. An update posted while a tool batch runs reaches the model on the very
 *      next iteration, tagged <user-update>, and is acknowledged on the stream.
 *   2. An update that lands while the model is writing its final text-only
 *      answer does not get lost: the answer is kept as a mid-history message,
 *      the update is applied, and the loop continues.
 *   3. A DETACHED_WORK directive keeps the parent working (unlike
 *      NON_BLOCKING_DISPATCH, which ends the turn); work still running when
 *      the turn ends bumps pendingBackgroundTasks by one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { AGENT_DIRECTIVES, TURN_INPUT } from "#src/constants";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── Heavy mocks (mirrors exhaustionRecoveryLoop.test.ts) ─────


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


// ── Harness factory ──────────────────────────────────────────

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

/**
 * Build a real ReActHarness whose model is scripted: `script[i]` is what the
 * model produces on iteration i+1. `onIteration` runs before the model
 * "responds" and receives the messages the model would see.
 */
function buildScriptedHarness(
  script: Turn[],
  onIteration?: (iteration: number, messagesSeen: ConversationMessage[]) => void,
) {
  const conversationId = "acceptance-conv";
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];

  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
    generateTextStreamLive: undefined,
    discoverContextWindow: vi.fn(),
  };

  const emit = vi.fn();
  const context: AgenticContext = {
    project: "prism-chat",
    username: "test-user",
    agent: "OMNI",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as any,
    traceId: "test-trace",
    agentConversationId: conversationId,
    conversationId,
    provider: mockProvider as any,
    options: {
      maxIterations: 6,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      tools: [{ name: "search_web", description: "Search the web" }],
    },
    messages: [{ role: "user", content: "Do the task" }],
    emit,
    signal: undefined as any,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as any;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [{ name: "search_web", description: "Search the web", parameters: {} }] as any,
    resolvedEnabledTools: ["search_web"],
  };
  const harness = new ReActHarness(context, state, tools);

  (harness as any).createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[]) => {
      iteration++;
      const snapshot = messages.map((message) => ({ ...message }));
      seenMessages.push(snapshot);
      onIteration?.(iteration, snapshot);
      return mockProvider.generateTextStream();
    },
  );
  (harness as any).consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
      const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
      pass.streamedThinking = "";
      pass.thinkingSignature = "";
      if (turn.kind === "tool") {
        pass.streamedText = "";
        pass.finalStreamedText = "";
        pass.pendingToolCalls = [{ id: `call-${iteration}`, name: turn.toolName, args: turn.args ?? {} }];
        state.streamedToolCalls.push({ id: `call-${iteration}`, name: turn.toolName, args: turn.args ?? {} });
      } else {
        pass.streamedText = turn.text;
        pass.finalStreamedText = turn.text;
        pass.pendingToolCalls = [];
        state.finalStreamedText = turn.text;
      }
      pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
    },
  );
  (harness as any).enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  (harness as any).finalize = vi.fn().mockResolvedValue(undefined);
  (harness as any).logIteration = vi.fn();
  (harness as any).emitGenerationProgress = vi.fn();
  (harness as any).emitUsageUpdate = vi.fn();
  (harness as any).checkAndApplyToolSetChanges = vi.fn();

  return { harness, context, state, emit, seenMessages, conversationId, iterations: () => iteration };
}

function toolResults(toolCalls: Array<{ name: string; id: string }>, result: unknown = { ok: true }) {
  return toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result, durationMilliseconds: 5 }));
}

// ── Scenarios ────────────────────────────────────────────────

describe("TurnInputMailbox acceptance — a running agent receives mid-turn input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    countRunningTasksMock.mockReturnValue(0);
    executeToolBatchMock.mockImplementation(async (toolCalls: Array<{ name: string; id: string }>) => toolResults(toolCalls));
  });

  it("1. an update posted during a tool batch reaches the model on the next iteration and is acknowledged", async () => {
    const { harness, state, emit, seenMessages, conversationId } = buildScriptedHarness([
      { kind: "tool", toolName: "search_web", args: { query: "one" } },
      { kind: "text", text: "Done, and I also handled the update." },
    ]);
    TurnInputMailbox.open(conversationId);

    // The user types while the tool batch is running.
    executeToolBatchMock.mockImplementationOnce(async (toolCalls: Array<{ name: string; id: string }>) => {
      const posted = TurnInputMailbox.post(conversationId, { kind: "user_update", text: "Also check the logs" });
      expect(posted.accepted).toBe(true);
      return toolResults(toolCalls);
    });

    const { messages } = await harness.run();

    expect(seenMessages).toHaveLength(2);
    const secondCallInput = seenMessages[1];
    const update = secondCallInput.find((message) => message._notificationSource === "user-update");
    expect(update, "the update must be in the second model call's input").toBeDefined();
    expect(update!.role).toBe("user");
    expect(update!.content).toContain("<user-update>");
    expect(update!.content).toContain("Also check the logs");
    expect(update!.rawContent).toBe("Also check the logs");
    // It follows the tool observation, before the next model call
    const toolIndex = secondCallInput.findIndex((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0);
    expect(secondCallInput.indexOf(update!)).toBeGreaterThan(toolIndex);

    expect(state.turnInputApplied).toBe(1);
    const events = emit.mock.calls.map((call) => call[0]);
    const applied = events.find((event) => event.type === TURN_INPUT.EVENT_TYPE);
    expect(applied).toMatchObject({ kind: "user_update", content: "Also check the logs", boundary: "after_tools", iteration: 1 });
    expect(events.find((event) => event.type === "status" && event.message === TURN_INPUT.STATUS_APPLIED)).toMatchObject({ inputId: applied.id });
    expect(messages.some((message) => message._notificationSource === "user-update")).toBe(true);
    expect(TurnInputMailbox.pendingCount(conversationId)).toBe(0);
  });

  it("2. an update that lands while the final text answer streams keeps the turn alive instead of being lost", async () => {
    const { harness, seenMessages, conversationId, iterations } = buildScriptedHarness(
      [
        { kind: "text", text: "Here is my final answer." },
        { kind: "text", text: "Adjusted per your update." },
      ],
      (iteration) => {
        // Arrives while iteration 1's answer is being produced
        if (iteration === 1) TurnInputMailbox.post(conversationId, { kind: "user_update", text: "Actually, use British spelling" });
      },
    );
    TurnInputMailbox.open(conversationId);

    const { messages } = await harness.run();

    expect(iterations()).toBe(2);
    const secondInput = seenMessages[1];
    const answerIndex = secondInput.findIndex((message) => message.role === "assistant" && message.content === "Here is my final answer.");
    const updateIndex = secondInput.findIndex((message) => message._notificationSource === "user-update");
    expect(answerIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBe(answerIndex + 1);
    expect(messages.filter((message) => message._notificationSource === "user-update")).toHaveLength(1);
  });

  it("3. DETACHED_WORK keeps the parent working; NON_BLOCKING_DISPATCH ends the turn", async () => {
    // Detached: the tool result carries DETACHED_WORK, the loop must continue
    const detached = buildScriptedHarness([
      { kind: "tool", toolName: "search_web" },
      { kind: "text", text: "kept working" },
    ]);
    TurnInputMailbox.open(detached.conversationId);
    executeToolBatchMock.mockImplementationOnce(async (toolCalls: Array<{ name: string; id: string }>) =>
      toolResults(toolCalls, { _directive: AGENT_DIRECTIVES.DETACHED_WORK, task: { taskId: "task-1" } }),
    );
    countRunningTasksMock.mockReturnValue(1); // still running when the turn ends
    await detached.harness.run();
    expect(detached.iterations()).toBe(2);
    expect(detached.state.detachedWorkDispatched).toBe(true);
    expect(adjustPendingBackgroundTasksMock).toHaveBeenCalledWith(
      detached.conversationId, "prism-chat", "test-user", 1, expect.anything(),
    );

    // Same script with NON_BLOCKING_DISPATCH: the turn ends after iteration 1
    adjustPendingBackgroundTasksMock.mockClear();
    const nonBlocking = buildScriptedHarness([
      { kind: "tool", toolName: "search_web" },
      { kind: "text", text: "never reached" },
    ]);
    executeToolBatchMock.mockImplementationOnce(async (toolCalls: Array<{ name: string; id: string }>) =>
      toolResults(toolCalls, { _directive: AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH }),
    );
    await nonBlocking.harness.run();
    expect(nonBlocking.iterations()).toBe(1);
    expect(adjustPendingBackgroundTasksMock).toHaveBeenCalledTimes(1);
  });

  it("3b. detached work that already completed does not bump the background counter", async () => {
    const { harness, conversationId, iterations } = buildScriptedHarness([
      { kind: "tool", toolName: "search_web" },
      { kind: "text", text: "done" },
    ]);
    TurnInputMailbox.open(conversationId);
    executeToolBatchMock.mockImplementationOnce(async (toolCalls: Array<{ name: string; id: string }>) => {
      // The completion arrives through the mailbox before the turn ends
      TurnInputMailbox.post(conversationId, { kind: "task_completion", text: "<task-notification>task-1 done</task-notification>", meta: { _notificationSource: "async-task" } });
      return toolResults(toolCalls, { _directive: AGENT_DIRECTIVES.DETACHED_WORK });
    });
    countRunningTasksMock.mockReturnValue(0);
    const { messages } = await harness.run();
    expect(iterations()).toBe(2);
    expect(messages.some((message) => message.content === "<task-notification>task-1 done</task-notification>")).toBe(true);
    expect(adjustPendingBackgroundTasksMock).not.toHaveBeenCalled();
  });
});

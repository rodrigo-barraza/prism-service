/**
 * hookSemantics.test.ts
 *
 * The configured-hook contract, exercised against a REAL ReActHarness with the
 * REAL ApprovalGate, ToolExecutor, AgentHooks kernel and ConfiguredHookRegistry.
 * Only the `http` handler is swapped for a recorder, so every payload a hook
 * would have been POSTed is captured in `hookState.recorded` and every decision
 * it returns comes from `hookState.decide`.
 *
 * The five red tests from docs/prompts/18-hooks-parity.md §3 (B9):
 *   1. PreToolUse runs BEFORE the approval gate — a deny emits no approval card.
 *   2. `permissionDecision: "ask"` becomes an approval request, not a deny.
 *   3. Notification does not fire for a batch that needs no approval.
 *   4. A Stop hook `block` forces another iteration, capped at 3.
 * (5, Graph-of-Thoughts, lives in hookSemanticsBranching.test.ts — its
 * strategy needs a different harness double.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { pendingApprovals } from "#src/services/ApprovalRegistry";
import { invalidateHookCache } from "#src/services/hooks/ConfiguredHookRegistry";
import type { ConfiguredHookDocument } from "#src/services/hooks/types";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

const hookState = vi.hoisted(() => ({
  configured: [] as unknown[],
  recorded: [] as Array<Record<string, unknown>>,
  decide: (_payload: Record<string, unknown>): Record<string, unknown> => ({}),
  executed: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

// ── The capturing HTTP handler ───────────────────────────────

vi.mock("#src/services/hooks/handlers/HttpHookHandler", () => ({
  default: vi.fn(async (_config: unknown, options: { payloadJson: string }) => {
    const payload = JSON.parse(options.payloadJson) as Record<string, unknown>;
    hookState.recorded.push(payload);
    return hookState.decide(payload);
  }),
}));
vi.mock("#src/services/hooks/handlers/PromptHookHandler", () => ({ default: vi.fn() }));
vi.mock("#src/services/hooks/handlers/McpToolHookHandler", () => ({ default: vi.fn() }));

// Built-ins without Mongo, the system-prompt assembler or the memory hooks:
// a real kernel, the real AutoApprovalEngine as the tier/policy decide hook,
// and the configured hooks registered by the real registry.
vi.mock("../lifecycle/HookInitializer.ts", async () => {
  const { default: AgentHooks } = await import("#src/services/AgentHooks");
  const { default: AutoApprovalEngine } = await import("#src/services/AutoApprovalEngine");
  const { registerConfiguredHooks } = await import("#src/services/hooks/ConfiguredHookRegistry");
  return {
    createStandardHooks: (options: { autoApprove?: boolean; policies?: [] } = {}) => {
      const hooks = new AgentHooks();
      const approvalEngine = new AutoApprovalEngine({
        fullAuto: options.autoApprove === true,
        policies: options.policies || [],
      });
      hooks.register("beforeToolCall", approvalEngine.createHook() as never, "AutoApprovalEngine", "decide");
      hooks.register(
        "beforePrompt",
        async (hookContext: unknown) => {
          const target = hookContext as Record<string, unknown>;
          target._assembledSystemPrompt = "You are a test agent.";
          target._injectedSkills = [];
        },
        "SystemPromptAssembler",
        "transform",
      );
      return { hooks, approvalEngine };
    },
    attachConfiguredHooks: async (hooks: never, scope: never) =>
      registerConfiguredHooks(hooks, hookState.configured as never, scope),
  };
});

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    isStreamable: () => false,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      hookState.executed.push({ name, args });
      return { success: true, content: `${name} ok` };
    }),
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("#src/services/ToolContext", () => ({
  default: { getStore: vi.fn().mockReturnValue(new Map()) },
}));

// ── Loop dependencies unrelated to hooks (as turnInputAcceptance.test.ts) ──

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    get: (_locale: string, key: string) => `[locale:${key}]`,
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
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined),
    appendMessages: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: {
    countRunningTasks: vi.fn().mockReturnValue(0),
    hasActiveTask: vi.fn().mockReturnValue(false),
    listTasks: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("#src/services/OrchestratorService", () => ({
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined) },
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
vi.mock("../lifecycle/KVCacheReporter.ts", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("../lifecycle/ToolDiscoveryNudge.ts", () => ({ injectToolDiscoveryNudge: vi.fn() }));
vi.mock("../lifecycle/TrackerFinalizer.ts", () => ({ finalizePassTracker: vi.fn() }));
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
vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

// ── Fixtures ─────────────────────────────────────────────────

function configuredHook(
  event: string,
  matcher = "",
  extra: Record<string, unknown> = {},
): ConfiguredHookDocument {
  const now = new Date().toISOString();
  return {
    id: `hook-${event}-${matcher || "all"}`,
    project: "prism-chat",
    username: "test-user",
    agent: null,
    name: `${event} recorder`,
    description: "",
    event,
    matcher,
    handler: { type: "http", url: "https://hooks.example.test/record" },
    enabled: true,
    timeoutMilliseconds: 5_000,
    createdAt: now,
    updatedAt: now,
    ...extra,
  } as ConfiguredHookDocument;
}

type Turn =
  | { kind: "tool"; calls: Array<{ name: string; args?: Record<string, unknown> }> }
  | { kind: "text"; text: string };

/**
 * A real ReActHarness whose model is scripted: `script[i]` is what the model
 * produces on iteration i+1. Approval cards are answered automatically (allow)
 * a tick after they are emitted, so a run that emits one still terminates.
 */
function buildHarness(script: Turn[], { autoApprove = false } = {}) {
  const conversationId = "hook-semantics-conv";
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const eventLog: string[] = [];

  const emit = vi.fn((event: Record<string, unknown>) => {
    eventLog.push(String(event.type));
    if (event.type === "approval_required") {
      setTimeout(() => {
        const entry = pendingApprovals.get(conversationId);
        if (entry && entry.type === "tool") entry.resolve({ isApproved: true });
      }, 0);
    }
  });

  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
  };

  const context: AgenticContext = {
    project: "prism-chat",
    username: "test-user",
    agent: null,
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as never,
    traceId: "test-trace",
    agentConversationId: conversationId,
    conversationId,
    provider: mockProvider as never,
    options: {
      maxIterations: 8,
      autoApprove,
      agenticLoopEnabled: true,
      maxTokens: 8192,
    },
    messages: [{ role: "user", content: "Do the task" }],
    emit,
    signal: undefined as never,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as never;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [
      { name: "read_file", description: "Read a file", parameters: {} },
      { name: "write_file", description: "Write a file", parameters: {} },
    ] as never,
    resolvedEnabledTools: ["read_file", "write_file"],
  };
  const harness = new ReActHarness(context, state, tools);

  (harness as never as Record<string, unknown>).createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[]) => {
      iteration++;
      eventLog.push(`model:${iteration}`);
      seenMessages.push(messages.map((message) => ({ ...message })));
      return mockProvider.generateTextStream();
    },
  );
  (harness as never as Record<string, unknown>).consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
      const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
      pass.streamedThinking = "";
      pass.thinkingSignature = "";
      if (turn.kind === "tool") {
        pass.streamedText = "";
        pass.finalStreamedText = "";
        pass.pendingToolCalls = turn.calls.map((call, index) => ({
          id: `call-${iteration}-${index + 1}`,
          name: call.name,
          args: { ...(call.args ?? {}) },
        }));
        for (const toolCall of pass.pendingToolCalls) {
          state.streamedToolCalls.push({ ...toolCall });
        }
      } else {
        pass.streamedText = turn.text;
        pass.finalStreamedText = turn.text;
        pass.pendingToolCalls = [];
        state.finalStreamedText = turn.text;
      }
      pass.usage = {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      } as never;
    },
  );
  const stubbed = harness as never as Record<string, unknown>;
  stubbed.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  stubbed.finalize = vi.fn().mockResolvedValue(undefined);
  stubbed.checkpointTurnProgress = vi.fn().mockResolvedValue(undefined);
  stubbed.logIteration = vi.fn();
  stubbed.emitGenerationProgress = vi.fn();
  stubbed.emitUsageUpdate = vi.fn();
  stubbed.checkAndApplyToolSetChanges = vi.fn();

  return { harness, emit, eventLog, seenMessages, iterations: () => iteration };
}

/** Inspect hooks are fire-and-forget — let them settle before asserting. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function recordedFor(event: string) {
  return hookState.recorded.filter((payload) => payload.hook_event_name === event);
}

function emittedOfType(emit: ReturnType<typeof vi.fn>, type: string) {
  return emit.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.type === type);
}

// ── Red tests ────────────────────────────────────────────────

describe("configured hooks — B9 semantics against a real ReActHarness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHookCache();
    TurnInputMailbox._clearAll();
    pendingApprovals.clear();
    hookState.configured = [];
    hookState.recorded = [];
    hookState.executed = [];
    hookState.decide = () => ({});
  });

  it("1. PreToolUse runs before the approval gate: a hook deny emits no approval card", async () => {
    hookState.configured = [configuredHook("PreToolUse", "write_file")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreToolUse"
        ? { permissionDecision: "deny", permissionDecisionReason: "writes are frozen" }
        : {};

    const { harness, emit, seenMessages } = buildHarness([
      { kind: "tool", calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    expect(recordedFor("PreToolUse")).toHaveLength(1);
    expect(
      emittedOfType(emit, "approval_required"),
      "a call a PreToolUse hook denied must never reach the human approval card",
    ).toHaveLength(0);
    expect(hookState.executed).toHaveLength(0);
    const toolMessage = seenMessages[1].find(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    const result = toolMessage!.toolCalls![0].result as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toContain("writes are frozen");
  });

  it("2. `permissionDecision: \"ask\"` produces an approval request instead of a deny", async () => {
    hookState.configured = [configuredHook("PreToolUse", "read_file")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreToolUse"
        ? { permissionDecision: "ask", permissionDecisionReason: "confirm reads outside src/" }
        : {};

    // read_file is AUTO tier: without the hook it would run unprompted.
    const { harness, emit } = buildHarness([
      { kind: "tool", calls: [{ name: "read_file", args: { path: "/etc/hosts" } }] },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    const cards = emittedOfType(emit, "approval_required");
    expect(cards, "a hook `ask` must surface as a per-call approval request").toHaveLength(1);
    expect((cards[0].toolCall as { id: string }).id).toBe("call-1-1");
    // The (auto-answered) approval lets the call run — `ask` is not a deny.
    expect(hookState.executed.map((call) => call.name)).toEqual(["read_file"]);
  });

  it("3. Notification does not fire for a batch that needs no approval", async () => {
    hookState.configured = [configuredHook("Notification")];

    const { harness } = buildHarness([
      { kind: "tool", calls: [{ name: "read_file", args: { path: "README.md" } }] },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    expect(
      recordedFor("Notification"),
      "an all-AUTO batch asks nobody anything, so there is nothing to notify about",
    ).toHaveLength(0);
    expect(hookState.executed.map((call) => call.name)).toEqual(["read_file"]);
  });

  it("3b. Notification fires once, after the gate decides approval is required", async () => {
    hookState.configured = [configuredHook("Notification"), configuredHook("PreToolUse")];

    const { harness } = buildHarness([
      {
        kind: "tool",
        calls: [
          { name: "read_file", args: { path: "README.md" } },
          { name: "write_file", args: { path: "b.txt", content: "y" } },
        ],
      },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    const notifications = recordedFor("Notification");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].notification_type).toBe("approval_required");
    expect(notifications[0].tool_names).toEqual(["write_file"]);
    // PreToolUse for both calls happened before the gate asked anyone.
    const order = hookState.recorded.map((payload) => payload.hook_event_name);
    expect(order.lastIndexOf("PreToolUse")).toBeLessThan(order.indexOf("Notification"));
  });

  it("4. a Stop hook `block` forces one more iteration with its reason, capped at 3", async () => {
    hookState.configured = [configuredHook("Stop")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "Stop"
        ? { decision: "block", reason: "The tests have not been run yet." }
        : {};

    const { harness, seenMessages, iterations } = buildHarness([
      { kind: "text", text: "All done." },
      { kind: "text", text: "Ran them, all done." },
      { kind: "text", text: "Really done." },
      { kind: "text", text: "Done for real." },
      { kind: "text", text: "never reached" },
    ]);
    await harness.run();
    await settle();

    // One natural stop + three forced continuations; the fourth block is capped.
    expect(iterations()).toBe(4);
    const stops = recordedFor("Stop");
    expect(stops).toHaveLength(4);
    expect(stops[0].stop_hook_active).toBe(false);
    expect(stops[1].stop_hook_active).toBe(true);
    expect(stops[0].last_assistant_message).toBe("All done.");

    // The block reason reaches the model on the forced iteration, after the
    // answer it interrupted.
    const secondInput = seenMessages[1];
    const answerIndex = secondInput.findIndex(
      (message) => message.role === "assistant" && message.content === "All done.",
    );
    const reasonIndex = secondInput.findIndex(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("The tests have not been run yet."),
    );
    expect(answerIndex).toBeGreaterThan(-1);
    expect(reasonIndex).toBe(answerIndex + 1);
  });
});

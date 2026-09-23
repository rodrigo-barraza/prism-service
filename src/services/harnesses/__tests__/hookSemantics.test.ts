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
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import { invalidateHookCache } from "#src/services/hooks/ConfiguredHookRegistry";
import HookSessionTracker, {
  _resetSessionsForTests,
} from "#src/services/hooks/HookSessionTracker";
import { deny } from "#src/services/PolicyEngine";
import { ProviderError } from "#src/utils/errors";
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
  /** How the automatic approver answers a card; "lapse" ends the turn's wait unanswered. */
  approve: true as boolean | "lapse",
  /** What the system-prompt assembler stub reports as loaded. */
  loadedInstructions: undefined as unknown,
  /** The conversation document the model-switch check reads. */
  conversationDocument: null as Record<string, unknown> | null,
  /** Called inside executeTool — lets a test act mid-batch. */
  duringTool: null as null | (() => void),
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

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection } = await import("../../../../tests/mongoMock.ts");
  // The approvals the gate records (PendingDecisionStore) live in a working
  // mock collection; every other collection only serves the conversation document.
  const pendingDecisions = createMockCollection();
  return {
    default: {
      getDb: () => ({
        collection: (name: string) =>
          name === "pending_decisions"
            ? pendingDecisions
            : {
                findOne: async () => hookState.conversationDocument,
                updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
              },
      }),
    },
  };
});

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
          if (hookState.loadedInstructions) {
            target._loadedInstructions = hookState.loadedInstructions;
          }
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
      hookState.executed.push({ name, args: { ...args } });
      hookState.duringTool?.();
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
  enforceCostBudget: vi.fn().mockResolvedValue(false),
  recordLoopSpend: vi.fn(),
}));
vi.mock("../lifecycle/PlanModeController.ts", () => ({
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
interface HarnessOptions {
  autoApprove?: boolean;
  policies?: unknown[];
  signal?: AbortSignal;
  conversationId?: string;
  history?: ConversationMessage[];
  pricing?: Record<string, number>;
  /** Throw this from the provider on the given iteration. */
  providerError?: { iteration: number; error: Error };
}

function buildHarness(
  script: Turn[],
  {
    autoApprove = false,
    policies,
    signal,
    conversationId = "hook-semantics-conv",
    history = [],
    pricing,
    providerError,
  }: HarnessOptions = {},
) {
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const eventLog: string[] = [];

  const emit = vi.fn((event: Record<string, unknown>) => {
    eventLog.push(String(event.type));
    if (event.type === "approval_required") {
      // One card per call: answer each by its toolCallId (per-call approvals).
      setTimeout(() => {
        if (hookState.approve === "lapse") {
          void ApprovalRegistry.cancel(conversationId);
          return;
        }
        void ApprovalRegistry.decide(conversationId, {
          toolCallId: event.toolCallId as string,
          decision: hookState.approve ? "allow" : "deny",
        });
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
    modelDefinition: {
      maxInputTokens: 128000,
      maxOutputTokens: 8192,
      ...(pricing && { pricing }),
    } as never,
    traceId: "test-trace",
    agentConversationId: conversationId,
    conversationId,
    provider: mockProvider as never,
    options: {
      maxIterations: 8,
      autoApprove,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      ...(policies && { policies }),
    },
    messages: [...history, { role: "user", content: "Do the task" }],
    emit,
    signal: (signal ?? undefined) as never,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as never;

  const state = new AgenticLoopState({ originalMessageCount: history.length + 1 });
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
      if (providerError && providerError.iteration === iteration) throw providerError.error;
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
    ApprovalRegistry._clearAll();
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

// ── The new events, each at its moment ───────────────────────

describe("configured hooks — the new events fire once, at the right moment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHookCache();
    TurnInputMailbox._clearAll();
    ApprovalRegistry._clearAll();
    _resetSessionsForTests();
    hookState.configured = [];
    hookState.recorded = [];
    hookState.executed = [];
    hookState.decide = () => ({});
    hookState.approve = true;
    hookState.loadedInstructions = undefined;
    hookState.conversationDocument = null;
    hookState.duringTool = null;
  });

  const ALL_OBSERVED = [
    "SessionStart",
    "TurnStart",
    "UserPromptSubmit",
    "InstructionsLoaded",
    "PreToolUse",
    "PermissionRequest",
    "Notification",
    "PostToolUse",
    "PostToolBatch",
    "Stop",
    "TurnEnd",
  ];

  it("fires the whole turn in order, PermissionRequest before the card and PostToolBatch before the next model call", async () => {
    hookState.configured = ALL_OBSERVED.map((event) => configuredHook(event));
    hookState.loadedInstructions = [
      { instructionType: "project_instructions", name: "PRISM.md", content: "Be terse." },
    ];
    const { harness, eventLog } = buildHarness([
      { kind: "tool", calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] },
      { kind: "text", text: "done" },
    ]);
    // Interleave hook deliveries with the harness's own events in one log.
    hookState.decide = (payload) => {
      eventLog.push(`hook:${payload.hook_event_name}`);
      return {};
    };

    await harness.run();
    await settle();

    const order = eventLog.filter((entry) => entry.startsWith("hook:") || entry.startsWith("model:") || entry === "approval_required");
    expect(order).toEqual([
      "hook:SessionStart",
      "hook:TurnStart",
      "hook:UserPromptSubmit",
      "hook:InstructionsLoaded",
      "model:1",
      "hook:PreToolUse",
      "hook:PermissionRequest",
      "hook:Notification",
      "approval_required",
      "hook:PostToolUse",
      "hook:PostToolBatch",
      "model:2",
      "hook:Stop",
      "hook:TurnEnd",
    ]);

    const [instructions] = recordedFor("InstructionsLoaded");
    expect(instructions).toMatchObject({
      instruction_type: "project_instructions",
      file_path: "PRISM.md",
      file_content: "Be terse.",
    });
    const [batch] = recordedFor("PostToolBatch");
    expect(batch.tool_calls).toEqual([
      expect.objectContaining({ tool_name: "write_file", tool_use_id: "call-1-1" }),
    ]);
    expect(recordedFor("TurnEnd")[0]).toMatchObject({ iterations: 2, response_text: "done" });
  });

  it("SessionStart fires per session, TurnStart per turn; SessionEnd when the session idles out", async () => {
    // A document written before this change: no `async`, event SessionStart.
    hookState.configured = [
      configuredHook("SessionStart"),
      configuredHook("TurnStart"),
      configuredHook("SessionEnd"),
    ];

    const first = buildHarness([{ kind: "text", text: "one" }], { conversationId: "session-conv" });
    await first.harness.run();
    const second = buildHarness([{ kind: "text", text: "two" }], {
      conversationId: "session-conv",
      history: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "one" },
      ],
    });
    await second.harness.run();
    await settle();

    expect(recordedFor("TurnStart")).toHaveLength(2);
    expect(recordedFor("SessionStart")).toHaveLength(1);
    expect(recordedFor("SessionStart")[0].source).toBe("startup");
    expect(recordedFor("SessionEnd")).toHaveLength(0);

    await HookSessionTracker.endSession("session-conv", "idle");
    await settle();
    expect(recordedFor("SessionEnd")).toHaveLength(1);
    expect(recordedFor("SessionEnd")[0]).toMatchObject({ reason: "idle", turns: 2 });

    // The next turn opens a new session — a resume, since it has history.
    const third = buildHarness([{ kind: "text", text: "three" }], {
      conversationId: "session-conv",
      history: [
        { role: "user", content: "earlier" },
        { role: "assistant", content: "one" },
      ],
    });
    await third.harness.run();
    await settle();
    expect(recordedFor("SessionStart").map((payload) => payload.source)).toEqual(["startup", "resume"]);
  });

  it("PermissionRequest can answer instead of the human: allow skips the card, deny refuses the call", async () => {
    hookState.configured = [configuredHook("PermissionRequest"), configuredHook("PermissionDenied")];
    hookState.decide = (payload) => {
      if (payload.hook_event_name !== "PermissionRequest") return {};
      const input = payload.tool_input as { path: string };
      return input.path === "ok.txt"
        ? { decision: "allow" }
        : { decision: "deny", message: "not that file" };
    };
    const { harness, emit, seenMessages } = buildHarness([
      {
        kind: "tool",
        calls: [
          { name: "write_file", args: { path: "ok.txt", content: "x" } },
          { name: "write_file", args: { path: "secret.txt", content: "y" } },
        ],
      },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    expect(emittedOfType(emit, "approval_required")).toHaveLength(0);
    expect(recordedFor("PermissionRequest")).toHaveLength(2);
    expect(recordedFor("PermissionRequest")[0]).toMatchObject({ permission_mode: "default", tier: "write" });
    expect(hookState.executed.map((call) => call.args.path)).toEqual(["ok.txt"]);
    const denied = recordedFor("PermissionDenied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ denied_by: "hook", reason: "not that file", tool_name: "write_file" });
    const toolMessage = seenMessages[1].find((message) => (message.toolCalls?.length ?? 0) > 0)!;
    const refused = toolMessage.toolCalls!.find((call) => (call.args as { path: string }).path === "secret.txt")!;
    expect((refused.result as { message: string }).message).toContain("not that file");
  });

  it("PermissionDenied names the layer: a deny rule, then the user", async () => {
    hookState.configured = [configuredHook("PermissionDenied")];
    const byRule = buildHarness(
      [
        { kind: "tool", calls: [{ name: "write_file", args: { path: "x", content: "" } }] },
        { kind: "text", text: "done" },
      ],
      { policies: [deny("write_file", { name: "no-writes" })] },
    );
    await byRule.harness.run();
    await settle();
    expect(recordedFor("PermissionDenied")).toEqual([
      expect.objectContaining({ denied_by: "rule", tool_name: "write_file" }),
    ]);

    hookState.recorded = [];
    hookState.approve = false;
    const byUser = buildHarness([
      { kind: "tool", calls: [{ name: "write_file", args: { path: "y", content: "" } }] },
      { kind: "text", text: "done" },
    ]);
    await byUser.harness.run();
    await settle();
    expect(recordedFor("PermissionDenied")).toEqual([
      expect.objectContaining({ denied_by: "user", reason: "user_rejected" }),
    ]);

    // Nobody answered: the card lapsed — not the user's "no".
    hookState.recorded = [];
    hookState.approve = "lapse";
    const lapsed = buildHarness([
      { kind: "tool", calls: [{ name: "write_file", args: { path: "z", content: "" } }] },
      { kind: "text", text: "done" },
    ]);
    await lapsed.harness.run();
    await settle();
    expect(recordedFor("PermissionDenied")).toEqual([
      expect.objectContaining({ denied_by: "turn_ended", reason: "turn_ended", tool_name: "write_file" }),
    ]);
  });

  it("a hook `allow` skips the mode's prompt but never a deny rule", async () => {
    hookState.configured = [configuredHook("PreToolUse")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreToolUse" ? { permissionDecision: "allow" } : {};
    const allowed = buildHarness([
      { kind: "tool", calls: [{ name: "write_file", args: { path: "a", content: "" } }] },
      { kind: "text", text: "done" },
    ]);
    await allowed.harness.run();
    expect(emittedOfType(allowed.emit, "approval_required")).toHaveLength(0);
    expect(hookState.executed).toHaveLength(1);

    hookState.executed = [];
    const ruled = buildHarness(
      [
        { kind: "tool", calls: [{ name: "write_file", args: { path: "a", content: "" } }] },
        { kind: "text", text: "done" },
      ],
      { policies: [deny("write_file")] },
    );
    await ruled.harness.run();
    expect(hookState.executed).toHaveLength(0);
  });

  it("PreToolUse updatedInput rewrites the call before the gate and the tool see it", async () => {
    hookState.configured = [configuredHook("PreToolUse", "write_file(path=*.tmp)")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreToolUse"
        ? { permissionDecision: "allow", updatedInput: { path: "sandbox/out.tmp", content: "x" } }
        : {};
    const { harness } = buildHarness([
      {
        kind: "tool",
        calls: [
          { name: "write_file", args: { path: "out.tmp", content: "x" } },
          { name: "read_file", args: { path: "README.md" } },
        ],
      },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    // The argument matcher selected only the .tmp write.
    expect(recordedFor("PreToolUse")).toHaveLength(1);
    expect(hookState.executed.find((call) => call.name === "write_file")!.args).toEqual({
      path: "sandbox/out.tmp",
      content: "x",
    });
  });

  it("additionalContext from PreToolUse, PostToolUse and PostToolBatch reaches the next model call as one message", async () => {
    hookState.configured = [
      configuredHook("PreToolUse"),
      configuredHook("PostToolUse"),
      configuredHook("PostToolBatch"),
    ];
    hookState.decide = (payload) => ({ additionalContext: `from ${String(payload.hook_event_name)}` });
    const { harness, seenMessages } = buildHarness([
      { kind: "tool", calls: [{ name: "read_file", args: { path: "a" } }] },
      { kind: "text", text: "done" },
    ]);
    await harness.run();

    const contextMessages = seenMessages[1].filter(
      (message) => typeof message.content === "string" && message.content.includes("<hook-context>"),
    );
    expect(contextMessages).toHaveLength(1);
    for (const source of ["from PreToolUse", "from PostToolUse", "from PostToolBatch"]) {
      expect(contextMessages[0].content).toContain(source);
    }
    // After the tool results it describes.
    const toolIndex = seenMessages[1].findIndex((message) => (message.toolCalls?.length ?? 0) > 0);
    expect(seenMessages[1].indexOf(contextMessages[0])).toBe(toolIndex + 1);
  });

  it("systemMessage is shown to the user", async () => {
    hookState.configured = [configuredHook("TurnStart")];
    hookState.decide = () => ({ systemMessage: "Heads up: prod credentials are loaded." });
    const { harness, emit } = buildHarness([{ kind: "text", text: "done" }]);
    await harness.run();
    await settle();
    expect(emittedOfType(emit, "status")).toContainEqual(
      expect.objectContaining({
        message: "hook_system_message",
        text: "Heads up: prod credentials are loaded.",
        hookEvent: "TurnStart",
      }),
    );
  });

  it("StopFailure fires with the classified error type when the provider fails", async () => {
    hookState.configured = [configuredHook("StopFailure"), configuredHook("Stop")];
    const { harness } = buildHarness([{ kind: "text", text: "never" }], {
      providerError: {
        iteration: 1,
        error: new ProviderError("anthropic", "Too many requests", 429),
      },
    });
    await expect(harness.run()).rejects.toThrow("Too many requests");
    await settle();
    expect(recordedFor("StopFailure")).toEqual([
      expect.objectContaining({ error_type: "rate_limit", error_message: "Too many requests" }),
    ]);
    expect(recordedFor("Stop")).toHaveLength(0);
  });

  it("Interrupt fires when the user stops, with the transcript", async () => {
    hookState.configured = [configuredHook("Interrupt")];
    const controller = new AbortController();
    hookState.duringTool = () => controller.abort();
    const { harness } = buildHarness(
      [
        { kind: "tool", calls: [{ name: "read_file", args: { path: "a" } }] },
        { kind: "text", text: "never" },
      ],
      { signal: controller.signal },
    );
    await harness.run();
    await settle();

    const interrupts = recordedFor("Interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].transcript).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", content: "Do the task" })]),
    );
  });

  it("PreModelSwitch / PostModelSwitch carry the estimated re-cache cost; a block refuses the turn", async () => {
    hookState.configured = [configuredHook("PreModelSwitch"), configuredHook("PostModelSwitch")];
    // The previous turn's system prompt stands in for this turn's, which is
    // not assembled yet when the switch is decided.
    hookState.conversationDocument = {
      settings: { model: "old-model", provider: "openai" },
      systemPrompt: "s".repeat(40_000),
    };
    const pricing = { inputPerMillion: 3, cacheWriteInputPerMillion: 3.75 };
    const history = [
      { role: "user", content: "x".repeat(4_000) },
      { role: "assistant", content: "ok" },
    ] as ConversationMessage[];

    const switched = buildHarness([{ kind: "text", text: "done" }], { history, pricing });
    await switched.harness.run();
    await settle();
    const [pre] = recordedFor("PreModelSwitch");
    expect(pre).toMatchObject({
      from_model: "old-model",
      from_provider: "openai",
      to_model: "test-model",
      cache_write_price_per_million: 3.75,
    });
    // ~1 000 tokens of history + ~10 000 of system prompt + the tool schemas.
    expect(pre.estimated_recache_tokens as number).toBeGreaterThan(10_500);
    expect(pre.estimated_recache_cost_usd as number).toBeCloseTo(
      ((pre.estimated_recache_tokens as number) / 1_000_000) * 3.75,
      5,
    );
    expect(recordedFor("PostModelSwitch")).toHaveLength(1);

    hookState.recorded = [];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreModelSwitch" ? { decision: "block", reason: "stay on old-model" } : {};
    const blocked = buildHarness([{ kind: "text", text: "never" }], { history, pricing });
    await blocked.harness.run();
    expect(blocked.iterations()).toBe(0);
    expect(recordedFor("PostModelSwitch")).toHaveLength(0);
  });

  it("no model-switch events when the model did not change", async () => {
    hookState.configured = [configuredHook("PreModelSwitch")];
    hookState.conversationDocument = { settings: { model: "test-model", provider: "test-provider" } };
    const { harness } = buildHarness([{ kind: "text", text: "done" }]);
    await harness.run();
    expect(recordedFor("PreModelSwitch")).toHaveLength(0);
  });
});

// ── Async hooks ──────────────────────────────────────────────

describe("configured hooks — async", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHookCache();
    TurnInputMailbox._clearAll();
    ApprovalRegistry._clearAll();
    _resetSessionsForTests();
    hookState.configured = [];
    hookState.recorded = [];
    hookState.executed = [];
    hookState.decide = () => ({});
    hookState.approve = true;
  });

  it("delivers an async hook's context at the next mailbox boundary", async () => {
    hookState.configured = [configuredHook("PostToolUse", "", { async: true })];
    hookState.decide = () => ({ additionalContext: "lint found 2 warnings in a.ts" });
    const { harness, emit, seenMessages } = buildHarness([
      { kind: "tool", calls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { kind: "text", text: "done" },
    ]);
    TurnInputMailbox.open("hook-semantics-conv");
    await harness.run();

    const delivered = seenMessages[1].find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("lint found 2 warnings"),
    );
    expect(delivered, "the async output must reach the model at the next boundary").toBeDefined();
    expect(emittedOfType(emit, "status")).toContainEqual(
      expect.objectContaining({ message: "hook_context_applied", _hookEvent: "PostToolUse" }),
    );
    // Never a user bubble.
    expect(emittedOfType(emit, "turn_input")).toHaveLength(0);
  });

  it("an async hook cannot block or rewrite the action that fired it", async () => {
    hookState.configured = [configuredHook("PreToolUse", "", { async: true })];
    hookState.decide = () => ({
      permissionDecision: "deny",
      permissionDecisionReason: "too late to matter",
      updatedInput: { path: "elsewhere" },
    });
    const { harness } = buildHarness([
      { kind: "tool", calls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { kind: "text", text: "done" },
    ]);
    await harness.run();
    await settle();

    expect(recordedFor("PreToolUse")).toHaveLength(1);
    expect(hookState.executed).toEqual([{ name: "read_file", args: { path: "a.ts" } }]);
  });
});

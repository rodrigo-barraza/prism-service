/**
 * toolBridgeGate.test.ts
 *
 * The byte-stable bridge and the plan-mode gate, against a REAL ReActHarness
 * with the REAL ApprovalGate, ToolExecutor, AgentHooks kernel and configured
 * hook registry (the scaffolding of hookSemantics.test.ts). Gemini runs in
 * bridge mode: a tool activated mid-turn is not declared — the model calls
 * it through the fixed `tool_call(name, args)` tool, and the harness turns
 * that into the named call BEFORE hooks, rules and approval see it:
 *
 *   - a DENY policy on the named tool still denies a bridged call;
 *   - a PreToolUse hook on the named tool still sees (and can block) it;
 *   - arguments its schema rejects never run — the model gets the error;
 *   - a name that is not activated never runs;
 *   - the transcript keeps what the model sent (`tool_call`).
 *
 * And plan mode: the request keeps every tool; a call that is not
 * read-only is blocked with an error result, a read runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import { invalidateHookCache } from "#src/services/hooks/ConfiguredHookRegistry";
import { _resetSessionsForTests } from "#src/services/hooks/HookSessionTracker";
import { deny } from "#src/services/PolicyEngine";
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

const GET_ELEMENT_SCHEMA = {
  name: "get_element",
  description: "Look up a chemical element.",
  parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
};
const CONVERT_UNITS_SCHEMA = {
  name: "convert_units",
  description: "Convert units.",
  parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
};


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
interface HarnessOptions {
  autoApprove?: boolean;
  policies?: unknown[];
  signal?: AbortSignal;
  conversationId?: string;
  history?: ConversationMessage[];
  pricing?: Record<string, number>;
  /** Throw this from the provider on the given iteration. */
  providerError?: { iteration: number; error: Error };
  /** Start the turn in plan mode. */
  planMode?: boolean;
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
    planMode = false,
  }: HarnessOptions = {},
) {
  let iteration = 0;
  const seenMessages: ConversationMessage[][] = [];
  const seenOptions: Array<Record<string, unknown>> = [];
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
    providerName: "google",
    resolvedModel: "gemini-3.6-flash",
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
      { name: "discover_and_enable_tools", description: "Find tools", parameters: { type: "object", properties: {} } },
      { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    ] as never,
    resolvedEnabledTools: ["discover_and_enable_tools", "read_file", "write_file"],
    discoverableTools: [GET_ELEMENT_SCHEMA, CONVERT_UNITS_SCHEMA] as never,
  };
  const harness = new ReActHarness(context, state, tools);
  // get_element was activated earlier in the turn (discover_and_enable_tools):
  // callable, reached through the bridge — not declared in the request.
  const harnessTools = (harness as never as { tools: ResolvedTools }).tools;
  harnessTools.finalTools = [...harnessTools.finalTools, GET_ELEMENT_SCHEMA as never];
  if (planMode) state.planModeActive = true;

  (harness as never as Record<string, unknown>).createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[], passOptions: Record<string, unknown>) => {
      iteration++;
      seenOptions.push(passOptions);
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

  return { harness, emit, eventLog, seenMessages, seenOptions, iterations: () => iteration };
}

/** Inspect hooks are fire-and-forget — let them settle before asserting. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function recordedFor(event: string) {
  return hookState.recorded.filter((payload) => payload.hook_event_name === event);
}

// ── Tests ────────────────────────────────────────────────────

const bridged = (name: string, args: Record<string, unknown>) => ({
  name: "tool_call",
  args: { name, args },
});

function assistantCallsIn(messages: ConversationMessage[]) {
  return messages
    .filter((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
    .flatMap((message) => message.toolCalls ?? []);
}

describe("the tool_call bridge — the named tool is what hooks, rules and approval see", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHookCache();
    TurnInputMailbox._clearAll();
    ApprovalRegistry._clearAll();
    hookState.configured = [];
    hookState.recorded = [];
    hookState.executed = [];
    hookState.decide = () => ({});
    hookState.approve = true;
    hookState.duringTool = null;
    _resetSessionsForTests();
  });

  it("declares the bridge once, first, and never the activated tool", async () => {
    const { harness, seenOptions } = buildHarness(
      [{ kind: "tool", calls: [bridged("get_element", { symbol: "Fe" })] }, { kind: "text", text: "done" }],
      { autoApprove: true },
    );
    await harness.run();
    const declared = (seenOptions[0].tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(declared[0]).toBe("tool_call");
    expect(declared).not.toContain("get_element");
    expect(seenOptions[1].tools).toBe(seenOptions[0].tools);
  });

  it("runs a valid bridged call as the tool it names, and replays what the model sent", async () => {
    const { harness, seenMessages } = buildHarness(
      [{ kind: "tool", calls: [bridged("get_element", { symbol: "Fe" })] }, { kind: "text", text: "done" }],
      { autoApprove: true },
    );
    await harness.run();
    expect(hookState.executed).toEqual([{ name: "get_element", args: { symbol: "Fe" } }]);
    const [call] = assistantCallsIn(seenMessages[1]);
    expect(call).toMatchObject({
      name: "tool_call",
      args: { name: "get_element", args: { symbol: "Fe" } },
      bridgedName: "get_element",
    });
    expect(JSON.stringify(call.result)).toContain("get_element ok");
  });

  it("a DENY policy on the named tool still denies the bridged call", async () => {
    const { harness, seenMessages } = buildHarness(
      [{ kind: "tool", calls: [bridged("get_element", { symbol: "Fe" })] }, { kind: "text", text: "done" }],
      { autoApprove: true, policies: [deny("get_element", { name: "no-elements" })] },
    );
    await harness.run();
    expect(hookState.executed).toHaveLength(0);
    const [call] = assistantCallsIn(seenMessages[1]);
    expect(call.name).toBe("tool_call");
    expect(JSON.stringify(call.result)).toMatch(/no-elements|denied|DENY/i);
  });

  it("a PreToolUse hook matching the named tool sees it — and its deny holds", async () => {
    hookState.configured = [configuredHook("PreToolUse", "get_element")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreToolUse"
        ? { permissionDecision: "deny", permissionDecisionReason: "no lookups today" }
        : {};
    const { harness } = buildHarness(
      [{ kind: "tool", calls: [bridged("get_element", { symbol: "Fe" })] }, { kind: "text", text: "done" }],
      { autoApprove: true },
    );
    await harness.run();
    await settle();
    const preToolUse = recordedFor("PreToolUse");
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].tool_name).toBe("get_element");
    expect(preToolUse[0].tool_input).toEqual({ symbol: "Fe" });
    expect(hookState.executed).toHaveLength(0);
  });

  it("arguments the named tool's schema rejects never run — the model gets the error", async () => {
    const { harness, seenMessages } = buildHarness(
      [{ kind: "tool", calls: [bridged("get_element", { element: "Fe" })] }, { kind: "text", text: "done" }],
      { autoApprove: true },
    );
    await harness.run();
    expect(hookState.executed).toHaveLength(0);
    const [call] = assistantCallsIn(seenMessages[1]);
    expect(JSON.stringify(call.result)).toContain("Invalid arguments for get_element");
    expect(JSON.stringify(call.result)).toContain("symbol");
  });

  it("a tool that is not activated is not reachable through the bridge", async () => {
    const { harness, seenMessages } = buildHarness(
      [{ kind: "tool", calls: [bridged("convert_units", { value: 1 })] }, { kind: "text", text: "done" }],
      { autoApprove: true },
    );
    await harness.run();
    expect(hookState.executed).toHaveLength(0);
    const [call] = assistantCallsIn(seenMessages[1]);
    expect(JSON.stringify(call.result)).toContain("is not an activated tool");
  });
});

describe("plan mode keeps every tool and gates the calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHookCache();
    TurnInputMailbox._clearAll();
    ApprovalRegistry._clearAll();
    hookState.configured = [];
    hookState.recorded = [];
    hookState.executed = [];
    hookState.decide = () => ({});
    hookState.approve = true;
    _resetSessionsForTests();
  });

  it("runs a read, blocks a write with an error result, and sends the same tools", async () => {
    const { harness, seenMessages, seenOptions } = buildHarness(
      [
        {
          kind: "tool",
          calls: [
            { name: "read_file", args: { path: "plan.md" } },
            { name: "write_file", args: { path: "plan.md" } },
          ],
        },
        { kind: "text", text: "Here is the plan." },
      ],
      { autoApprove: true, planMode: true },
    );
    await harness.run();
    expect(hookState.executed.map((call) => call.name)).toEqual(["read_file"]);
    const calls = assistantCallsIn(seenMessages[1]);
    const write = calls.find((call) => call.name === "write_file");
    expect(JSON.stringify(write?.result)).toContain("harness.planningMode.blockedNotReadOnly");
    expect(seenOptions[1].tools).toBe(seenOptions[0].tools);
    expect((seenOptions[0].tools as Array<{ name: string }>).map((tool) => tool.name)).toContain("write_file");
  });
});

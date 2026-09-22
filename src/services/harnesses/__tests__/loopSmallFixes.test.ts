/**
 * loopSmallFixes.test.ts
 *
 * Regression tests for docs/prompts/09-harness-small-fixes.md, Landing 1,
 * run against the REAL AgenticLoopService and a REAL ReActHarness whose model
 * is scripted (same dependency mocks as turnInputAcceptance.test.ts):
 *
 *   a. `maxCostDollars` stops the loop with a budget reason, and that reason
 *      is persisted on the conversation.
 *   c. Rejecting a plan (ReAct, Tree of Thoughts, Graph of Thoughts) still
 *      finalizes the turn: the prompt and the plan are persisted with a
 *      rejection note, isGenerating is cleared and `done` is emitted once.
 *   f. A scheduled run (autoApprove, no request-supplied policies) of a custom
 *      agent with a DENY rule gets POLICY_DENIED instead of executing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import { runTreeOfThoughts } from "../strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "../strategies/GraphOfThoughtsStrategy.ts";
import { SERVER_SENT_EVENT_TYPES, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── Heavy mocks (mirrors turnInputAcceptance.test.ts) ────────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    register: vi.fn(),
    complete: vi.fn(),
    setEstimatedInputTokens: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock("#src/services/PlanningModeService", () => ({
  default: {
    injectPlanningInstruction: vi.fn(),
    stripPlanningInstruction: vi.fn(),
    extractSteps: vi.fn().mockReturnValue([]),
  },
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

// Built-in hooks are no-ops, but the approval engine is the REAL one, built
// from exactly the options the harness passes — that is where a policy
// either reaches the loop or does not.
vi.mock("../lifecycle/HookInitializer.ts", async () => {
  const { default: AutoApprovalEngine } = await import("#src/services/AutoApprovalEngine");
  return {
    createStandardHooks: (hookOptions: { autoApprove?: boolean; policies?: unknown[] }) => ({
      hooks: {
        run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
          if (name === "beforePrompt") {
            hookContext._assembledSystemPrompt = "You are a test agent.";
            hookContext._injectedSkills = [];
          }
        }),
      },
      approvalEngine: new AutoApprovalEngine({
        fullAuto: hookOptions.autoApprove === true,
        policies: (hookOptions.policies || []) as never,
      }),
    }),
    attachConfiguredHooks: vi.fn().mockResolvedValue(0),
  };
});

const executeToolBatchMock = vi.fn();
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
  executeToolSingle: vi.fn(),
}));

const appendMessagesMock = vi.fn().mockResolvedValue(undefined);
const setGeneratingMock = vi.fn().mockResolvedValue(undefined);
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined),
    appendMessages: (...args: unknown[]) => appendMessagesMock(...args),
    setGenerating: (...args: unknown[]) => setGeneratingMock(...args),
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
  default: {
    awaitPendingDispatches: vi.fn().mockResolvedValue(undefined),
    cleanupConversation: vi.fn(),
  },
}));

vi.mock("../lifecycle/PostExecutionEmitter.ts", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));

vi.mock("../lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
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

vi.mock("../lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));

vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));

vi.mock("#src/services/ToolContext", () => ({
  default: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    getStore: vi.fn().mockReturnValue(new Map()),
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    cleanupInMemory: vi.fn(),
  },
}));

vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn().mockResolvedValue({}) },
}));

// AgenticLoopService collaborators: the tool set is the scripted one, and the
// harness registry hands out the scripted ReActHarness below.
const SCRIPT_TOOLS = ["search_web", "execute_shell", TOOL_NAMES.EXIT_PLAN_MODE];
vi.mock("#src/services/AgenticToolResolver", () => ({
  default: {
    resolve: vi.fn().mockImplementation(async () => ({
      finalTools: SCRIPT_TOOLS.map((name) => ({ name, description: name, parameters: {} })),
      resolvedEnabledTools: SCRIPT_TOOLS,
    })),
  },
}));

vi.mock("../lifecycle/PreflightToolDiscovery.ts", () => ({
  runPreflightToolDiscovery: vi.fn().mockResolvedValue({ enabledTools: [] }),
}));

const harnessClassRef: { current: unknown } = { current: null };
vi.mock("../HarnessRegistry.ts", () => ({
  default: {
    get: () => harnessClassRef.current,
    list: () => [],
  },
}));

// ── Scripted model ───────────────────────────────────────────

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown>; text?: string }
  | { kind: "text"; text: string };

/** Per-iteration token usage the scripted provider reports. */
let scriptedUsage = { inputTokens: 100, outputTokens: 10 };
let script: Turn[] = [];
let modelCalls = 0;

/** Make a harness instance answer from `script` instead of a provider. */
function scriptHarness(harness: ReActHarness) {
  const state = (harness as unknown as { state: AgenticLoopState }).state;
  const scripted = harness as unknown as Record<string, unknown>;
  scripted.createProviderStream = vi.fn().mockImplementation(async () => {
    modelCalls++;
    return (async function* () {
      yield "";
    })();
  });
  scripted.consumeStream = vi.fn().mockImplementation(async (_stream: unknown, pass: PassState) => {
    const turn = script[modelCalls - 1] ?? { kind: "text", text: "fallback final answer" };
    pass.streamedThinking = "";
    pass.thinkingSignature = "";
    if (turn.kind === "tool") {
      pass.streamedText = turn.text ?? "";
      pass.finalStreamedText = turn.text ?? "";
      const toolCall = { id: `call-${modelCalls}`, name: turn.toolName, args: turn.args ?? {} };
      pass.pendingToolCalls = [toolCall];
      state.streamedToolCalls.push({ ...toolCall });
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      state.finalStreamedText = turn.text;
    }
    pass.usage = { ...scriptedUsage, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
    state.overallUsage.inputTokens += scriptedUsage.inputTokens;
    state.overallUsage.outputTokens += scriptedUsage.outputTokens;
  });
  scripted.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  scripted.logIteration = vi.fn();
  scripted.emitGenerationProgress = vi.fn();
  scripted.emitUsageUpdate = vi.fn();
  scripted.checkAndApplyToolSetChanges = vi.fn();
}

class ScriptedReActHarness extends ReActHarness {
  constructor(...args: ConstructorParameters<typeof ReActHarness>) {
    super(...args);
    scriptHarness(this);
  }
}
harnessClassRef.current = ScriptedReActHarness;

function buildLoopContext(overrides: {
  options?: Record<string, unknown>;
  agent?: string;
  resolvedModel?: string;
} = {}) {
  const emit = vi.fn();
  const context = {
    project: "prism-chat",
    username: "test-user",
    agent: overrides.agent ?? "OMNI",
    providerName: "google",
    resolvedModel: overrides.resolvedModel ?? "test-model",
    modelDefinition: { maxInputTokens: 1_000_000, maxOutputTokens: 8192 },
    traceId: "test-trace",
    agentConversationId: "loop-fix-conv",
    conversationId: "loop-fix-conv",
    // Only a recovery/summary pass reaches the provider directly; every loop
    // iteration goes through the scripted createProviderStream.
    provider: {
      generateTextStream: vi.fn().mockImplementation(async function* () {
        yield "summary from an extra model call";
      }),
      discoverContextWindow: vi.fn(),
    },
    options: {
      maxIterations: 6,
      agenticLoopEnabled: true,
      functionCallingEnabled: true,
      maxTokens: 8192,
      harness: "standard",
      topology: "hierarchical",
      thoughtStructure: "chain_of_thought",
      enableCriticGate: false,
      ...overrides.options,
    },
    messages: [{ role: "user", content: "Do the task" }],
    emit,
    signal: undefined,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as unknown as AgenticContext;
  return { context, emit };
}

async function runLoop(context: AgenticContext) {
  const { default: AgenticLoopService } = await import("#src/services/AgenticLoopService");
  return AgenticLoopService.runAgenticLoop(context);
}

/** Decide the plan-approval prompt with `approved` as soon as it is pending. */
function answerPlanWhenAsked(conversationId: string, approved: boolean) {
  let isDeciding = false;
  const timer = setInterval(async () => {
    if (isDeciding) return;
    const pending = await ApprovalRegistry.getPending(conversationId);
    if (pending?.type === "plan" && !isDeciding) {
      isDeciding = true;
      clearInterval(timer);
      await ApprovalRegistry.decide(conversationId, { decision: approved ? "allow" : "deny" });
    }
  }, 1);
  return () => clearInterval(timer);
}

function persistedMeta() {
  expect(appendMessagesMock).toHaveBeenCalled();
  const call = appendMessagesMock.mock.calls.at(-1)!;
  return { messages: call[3] as ConversationMessage[], meta: call[4] as Record<string, unknown> };
}

function doneEvents(emit: ReturnType<typeof vi.fn>) {
  return emit.mock.calls.map((call) => call[0]).filter((event) => event?.type === SERVER_SENT_EVENT_TYPES.DONE);
}

beforeEach(() => {
  vi.clearAllMocks();
  TurnInputMailbox._clearAll();
  ApprovalRegistry._clearAll();
  script = [];
  modelCalls = 0;
  scriptedUsage = { inputTokens: 100, outputTokens: 10 };
  executeToolBatchMock.mockImplementation(async (toolCalls: Array<{ name: string; id: string }>) =>
    toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result: { ok: true }, durationMilliseconds: 5 })),
  );
});

// ── a. Cost cap ──────────────────────────────────────────────

describe("a. maxCostDollars reaches the loop and stops it with a persisted budget reason", () => {
  it("stops after the first costly iteration and persists conversationOutcome=budget_exhausted", async () => {
    // gemini-3.5-flash input is priced per 1M tokens — one iteration of 1M
    // input tokens costs far more than the $0.01 cap.
    scriptedUsage = { inputTokens: 1_000_000, outputTokens: 1_000 };
    script = [
      { kind: "tool", toolName: "search_web", args: { query: "one" } },
      { kind: "tool", toolName: "search_web", args: { query: "two" } },
      { kind: "tool", toolName: "search_web", args: { query: "three" } },
      { kind: "text", text: "done" },
    ];
    const { context, emit } = buildLoopContext({
      resolvedModel: "gemini-3.5-flash",
      options: { maxCostDollars: 0.01, autoApprove: true },
    });

    await runLoop(context);

    expect(modelCalls, "the loop must stop at the budget, not run the whole script").toBe(1);
    expect(executeToolBatchMock).not.toHaveBeenCalled();
    expect(
      (context.provider as unknown as { generateTextStream: ReturnType<typeof vi.fn> }).generateTextStream,
      "a spent budget must not buy a summary pass",
    ).not.toHaveBeenCalled();
    const events = emit.mock.calls.map((call) => call[0]);
    expect(events.some((event) => event?.message === "cost_limit_reached")).toBe(true);
    const { messages, meta } = persistedMeta();
    expect(meta.conversationOutcome).toBe("budget_exhausted");
    const finalAssistant = messages.filter((message) => message.role === "assistant").at(-1);
    expect(String(finalAssistant?.content)).toContain("Cost cap reached");
    expect(String(finalAssistant?.content)).not.toContain("Iteration limit");
  });
});

// ── c. Plan rejection finalizes the turn ─────────────────────

const PLAN_TEXT = "1. Read the config\n2. Change the port";

describe("c. rejecting a plan finalizes the turn", () => {
  let stopAnswering: () => void = () => {};
  afterEach(() => stopAnswering());

  function expectRejectedTurnFinalized(emit: ReturnType<typeof vi.fn>) {
    const { messages, meta } = persistedMeta();
    const userMessage = messages.find((message) => message.role === "user");
    expect(userMessage?.content).toBe("Do the task");
    const persistedText = JSON.stringify(messages);
    expect(persistedText, "the plan must be persisted").toContain("Read the config");
    expect(persistedText, "a rejection note must be persisted").toContain("rejected");
    expect(meta.conversationOutcome).toBe("plan_rejected");
    expect(setGeneratingMock).toHaveBeenCalledWith("loop-fix-conv", "prism-chat", "test-user", false, expect.anything());
    expect(doneEvents(emit)).toHaveLength(1);
  }

  it("ReAct (planFirst): the rejected plan is persisted, isGenerating cleared, done emitted once", async () => {
    script = [
      { kind: "tool", toolName: TOOL_NAMES.EXIT_PLAN_MODE, text: PLAN_TEXT },
      { kind: "text", text: "must never run" },
    ];
    const { context, emit } = buildLoopContext({ options: { planFirst: true, autoApprove: false } });
    stopAnswering = answerPlanWhenAsked("loop-fix-conv", false);

    await runLoop(context);

    expect(modelCalls).toBe(1);
    expectRejectedTurnFinalized(emit);
  });

  it("a plan given only as exit_plan_mode's summary argument is proposed and persisted", async () => {
    // Live run (gemini-3.5-flash-lite): the model streamed no text and put
    // the whole plan in args.summary — the proposal the user saw was empty.
    script = [
      { kind: "tool", toolName: TOOL_NAMES.EXIT_PLAN_MODE, text: "", args: { summary: PLAN_TEXT } },
      { kind: "text", text: "must never run" },
    ];
    const { context, emit } = buildLoopContext({ options: { planFirst: true, autoApprove: false } });
    stopAnswering = answerPlanWhenAsked("loop-fix-conv", false);

    await runLoop(context);

    const proposal = emit.mock.calls.map((call) => call[0]).find((event) => event?.type === "plan_proposal");
    expect(proposal?.plan).toBe(PLAN_TEXT);
    const { messages } = persistedMeta();
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(String(toolMessage?.content)).toContain("Read the config");
  });

  for (const [label, run] of [
    ["Tree of Thoughts", runTreeOfThoughts],
    ["Graph of Thoughts", runGraphOfThoughts],
  ] as const) {
    it(`${label}: the rejected plan is persisted, isGenerating cleared, done emitted once`, async () => {
      script = [
        { kind: "tool", toolName: TOOL_NAMES.EXIT_PLAN_MODE, text: PLAN_TEXT },
        { kind: "text", text: "must never run" },
      ];
      const { context, emit } = buildLoopContext({ options: { planFirst: true, autoApprove: false } });
      const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive: true });
      const tools: ResolvedTools = {
        finalTools: SCRIPT_TOOLS.map((name) => ({ name, description: name, parameters: {} })) as never,
        resolvedEnabledTools: SCRIPT_TOOLS,
      };
      const harness = new ScriptedReActHarness(context, state, tools);
      stopAnswering = answerPlanWhenAsked("loop-fix-conv", false);

      await run(harness as never);

      expect(modelCalls).toBe(1);
      expectRejectedTurnFinalized(emit);
    });
  }
});

// ── f. Policies on every entry point ─────────────────────────

describe("f. custom-agent DENY policies hold on scheduled/timer runs", () => {
  const CUSTOM_AGENT_ID = "LOOP_FIX_NO_SHELL";

  beforeEach(() => {
    AgentPersonaRegistry.registerCustom({
      agentId: CUSTOM_AGENT_ID,
      name: "No shell",
      policies: [{ tool: "execute_shell", decision: "DENY", name: "no-shell" }],
    });
  });

  it("a scheduled run (autoApprove, no request policies) denies the tool with POLICY_DENIED", async () => {
    script = [
      { kind: "tool", toolName: "execute_shell", args: { command: "rm -rf /tmp/x" } },
      { kind: "text", text: "ok" },
    ];
    // The exact option shape ScheduledTaskService.executeTask passes.
    const { context } = buildLoopContext({
      agent: CUSTOM_AGENT_ID,
      options: { planFirst: false, autoApprove: true },
    });

    const { messages } = await runLoop(context);

    const executedNames = executeToolBatchMock.mock.calls.flatMap((call) =>
      (call[0] as Array<{ name: string }>).map((toolCall) => toolCall.name),
    );
    expect(executedNames, "a DENY policy must stop the call before execution").not.toContain("execute_shell");
    const assistantWithShell = messages.find((message) =>
      message.toolCalls?.some((toolCall) => toolCall.name === "execute_shell"),
    );
    const shellResult = assistantWithShell?.toolCalls?.find((toolCall) => toolCall.name === "execute_shell")?.result as
      | { error?: string }
      | undefined;
    expect(shellResult?.error).toBe("POLICY_DENIED");
  });
});

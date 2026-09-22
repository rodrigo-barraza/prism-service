/**
 * askUserAnswerReachesTurn.test.ts
 *
 * An `ask_user` answer must reach the turn that asked. Driven end to end the
 * way the web client drives it: a REAL AgenticLoopService.runAgenticLoop →
 * REAL ReActHarness → REAL ToolExecutor → REAL ask_user tool, answered
 * through the REAL `/agent/answer` router over supertest. Only the model is
 * scripted (prototype spies), plus the persistence/telemetry edges.
 *
 * WHY THE IDS DIFFER. prism-client never sends `agentConversationId` in an
 * agent request, so ChatRoutes mints `agentConversationId =
 * crypto.randomUUID()` while `conversationId` is the id the client holds —
 * for a root turn the two are never equal (0 of the 50 newest root
 * conversations in production on 2026-09-22). The client answers with the
 * only id it has, `conversationId`. turnInputAcceptance.test.ts uses ONE id
 * for both, which is exactly how the question-registry / answer-route
 * mismatch hid from every test. Keep them different here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopService from "#src/services/AgenticLoopService";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import agentRouter from "#src/routes/AgentRoutes";
import type {
  AgenticContext,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── Edges mocked; the loop, executor, tool and route are real ─────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

// The answer route never reaches the /agent handler; keep its import graph out.
vi.mock("#src/routes/ChatRoutes", () => ({ handleAgent: vi.fn() }));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn(), cleanup: vi.fn() },
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

vi.mock("../lifecycle/HookInitializer.ts", () => ({
  createStandardHooks: () => {
    const hooks = {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
        return undefined;
      }),
    };
    return { hooks, approvalEngine: {} };
  },
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

vi.mock("#src/services/AgenticToolResolver", () => ({
  default: {
    resolve: vi.fn().mockResolvedValue({
      finalTools: [{ name: "ask_user", description: "Ask the user", parameters: {} }],
      resolvedEnabledTools: ["ask_user"],
    }),
  },
}));

vi.mock("../lifecycle/PreflightToolDiscovery.ts", () => ({
  runPreflightToolDiscovery: vi.fn().mockResolvedValue({ enabledTools: [] }),
}));

vi.mock("#src/services/ToolContext", () => ({
  default: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    getStore: vi.fn().mockReturnValue(new Map()),
    set: vi.fn(),
    get: vi.fn(),
    cleanupInMemory: vi.fn(),
  },
}));

// executeTool's internal-tool branch, verbatim: the executor's context is
// spread into the tool's context (ToolOrchestratorService.executeTool).
// The registry is imported lazily — its import graph reaches this module.
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    isStreamable: vi.fn().mockReturnValue(false),
    executeTool: async (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => {
      const { default: InternalToolRegistry } = await import(
        "#src/services/tool-definitions/InternalToolRegistry"
      );
      return InternalToolRegistry.execute(name, args, {
        ...context,
        agentConversationId: (context.agentConversationId as string) || undefined,
        project: (context.project as string) || undefined,
        username: (context.username as string) || undefined,
      });
    },
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
  default: {
    awaitPendingDispatches: vi.fn().mockResolvedValue(undefined),
    cleanupConversation: vi.fn(),
  },
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
  injectErrorAsConversationMessage: vi.fn(),
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
vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({ checkCostBudget: vi.fn().mockReturnValue(false) }));
vi.mock("../lifecycle/SandboxExecutor.ts", () => ({
  createSandboxCheckpoint: vi.fn().mockReturnValue("mock-stash-ref"),
  restoreSandboxCheckpoint: vi.fn(),
}));
vi.mock("../lifecycle/PlanModeController.ts", () => ({
  blockUnauthorizedToolCalls: vi.fn(),
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({ buildToolRetryGuidance: vi.fn().mockReturnValue(null) }));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/FileService", () => ({ default: { upsertFile: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

// ── Scripted model ───────────────────────────────────────────

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

interface ScriptedRun {
  /** What the model saw on each call, in order. */
  seen: ConversationMessage[][];
  events: Array<Record<string, unknown>>;
  done: Promise<{ messages: ConversationMessage[] }>;
}

let script: Turn[] = [];
let callIndex = 0;
let seen: ConversationMessage[][] = [];

function installScriptedModel() {
  const proto = ReActHarness.prototype as unknown as Record<string, unknown>;
  vi.spyOn(proto as any, "createProviderStream").mockImplementation(async function (
    this: unknown,
    messages: ConversationMessage[],
  ) {
    callIndex++;
    seen.push(messages.map((message) => ({ ...message })));
    return (async function* () {
      yield "";
    })();
  });
  vi.spyOn(proto as any, "consumeStream").mockImplementation(async function (
    this: { state: { streamedToolCalls: unknown[]; finalStreamedText: string } },
    _stream: unknown,
    pass: PassState,
  ) {
    const turn = script[callIndex - 1] ?? { kind: "text", text: "fallback final answer" };
    pass.streamedThinking = "";
    pass.thinkingSignature = "";
    if (turn.kind === "tool") {
      const call = { id: `call-${callIndex}`, name: turn.toolName, args: turn.args ?? {} };
      pass.streamedText = "";
      pass.finalStreamedText = "";
      pass.pendingToolCalls = [call];
      this.state.streamedToolCalls.push(call);
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      this.state.finalStreamedText = turn.text;
    }
    pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
  });
  vi.spyOn(proto as any, "enforceContextWindow").mockImplementation((messages: unknown) => messages);
  vi.spyOn(proto as any, "finalize").mockResolvedValue(undefined);
  vi.spyOn(proto as any, "logIteration").mockImplementation(() => undefined);
  vi.spyOn(proto as any, "emitGenerationProgress").mockImplementation(() => undefined);
  vi.spyOn(proto as any, "emitUsageUpdate").mockImplementation(() => undefined);
  vi.spyOn(proto as any, "checkAndApplyToolSetChanges").mockImplementation(() => undefined);
}

/** Start a turn the way ChatRoutes.handleAgent does. */
function startTurn(
  turns: Turn[],
  ids: { conversationId: string; agentConversationId: string; isSubAgent?: boolean },
): ScriptedRun {
  script = turns;
  const events: Array<Record<string, unknown>> = [];
  const context = {
    project: "prism-chat",
    username: "test-user",
    agent: "OMNI",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 },
    traceId: "test-trace",
    agentConversationId: ids.agentConversationId,
    conversationId: ids.conversationId,
    provider: { generateTextStream: vi.fn(), discoverContextWindow: vi.fn() },
    options: {
      harness: "standard",
      topology: "single",
      thoughtStructure: "chain",
      enableCriticGate: false,
      maxIterations: 6,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      ...(ids.isSubAgent ? { isSubAgent: true } : {}),
    },
    messages: [{ role: "user", content: "Ask me something first" }],
    emit: (event: Record<string, unknown>) => {
      events.push(event);
    },
    signal: undefined,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as unknown as AgenticContext;
  return { seen, events, done: AgenticLoopService.runAgenticLoop(context) };
}

/** Resolve once `predicate` holds — the loop runs on the microtask/IO queue. */
async function until(predicate: () => boolean, label: string, limitMilliseconds = 5_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > limitMilliseconds) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function questionEvents(run: ScriptedRun) {
  return run.events.filter((event) => event.type === "user_question");
}

function toolResultText(messages: ConversationMessage[]): string {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
}

const app = express();
app.use(express.json());
app.use("/agent", agentRouter);

// ── Scenarios ────────────────────────────────────────────────

describe("ask_user answers reach the running turn", () => {
  beforeEach(() => {
    TurnInputMailbox._clearAll();
    callIndex = 0;
    seen = [];
    installScriptedModel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a root turn started WITHOUT agentConversationId is answered by conversationId, and the loop finishes", async () => {
    // The ids ChatRoutes produces for a web-client request: the client's
    // conversationId and a server-minted agentConversationId. Deliberately
    // different — see the header.
    const conversationId = "client-conversation-1";
    const agentConversationId = "minted-3f1e9c2a-agent-id";
    const run = startTurn(
      [
        { kind: "tool", toolName: "ask_user", args: { questions: [{ question: "Red, green or blue?" }] } },
        { kind: "text", text: "Green it is — a lime." },
      ],
      { conversationId, agentConversationId },
    );
    await until(() => questionEvents(run).length === 1, "the user_question event");

    const response = await request(app)
      .post("/agent/answer")
      .send({ conversationId, answer: "green" });

    expect(response.status).toBe(200);
    const { messages } = await run.done;
    expect(callIndex).toBe(2);
    expect(toolResultText(run.seen[1])).toContain("green");
    expect(messages.some((message) => message.role === "assistant" && message.content === "Green it is — a lime.")).toBe(true);
  });
});

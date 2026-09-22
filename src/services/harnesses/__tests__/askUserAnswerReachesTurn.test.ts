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
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import { ASK_USER_BLOCKING_TIMEOUT_MILLISECONDS } from "#src/services/tool-definitions/AskUserQuestionTool";
import { pendingQuestions } from "#src/services/ApprovalRegistry";
import logger from "#src/utils/logger";
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
  // Every call cleared, nothing blocked — the gate's per-call verdict.
  checkAndWaitForApproval: vi.fn().mockImplementation(async (toolCalls: unknown[]) => ({
    executableToolCalls: toolCalls,
    blockedResults: [],
    deniedToolCalls: [],
    shouldApproveAll: false,
  })),
  orderResultsLikeCalls: (_toolCalls: unknown[], results: unknown[]) => results,
  approvalRecordFor: () => ({}),
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

type ToolCallScript = { toolName: string; args?: Record<string, unknown> };
type Turn =
  | ({ kind: "tool" } & ToolCallScript)
  /** Several calls in one batch — they run in parallel (Promise.all). */
  | { kind: "tools"; calls: ToolCallScript[] }
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
/** The text the loop ended on (finalize — which persists it — is stubbed). */
let finalText = "";
/** Awaited before model call `n` (1-based) produces its output. */
let beforeCall: ((n: number) => Promise<void>) | null = null;

function installScriptedModel() {
  const proto = ReActHarness.prototype as unknown as Record<string, unknown>;
  vi.spyOn(proto as any, "createProviderStream").mockImplementation((async function (
    this: unknown,
    messages: ConversationMessage[],
  ) {
    callIndex++;
    seen.push(messages.map((message) => ({ ...message })));
    if (beforeCall) await beforeCall(callIndex);
    return (async function* () {
      yield "";
    })();
  }) as any);
  vi.spyOn(proto as any, "consumeStream").mockImplementation((async function (
    this: { state: { streamedToolCalls: unknown[]; finalStreamedText: string } },
    _stream: unknown,
    pass: PassState,
  ) {
    const turn = script[callIndex - 1] ?? { kind: "text", text: "fallback final answer" };
    pass.streamedThinking = "";
    pass.thinkingSignature = "";
    if (turn.kind === "tool" || turn.kind === "tools") {
      const scripted = turn.kind === "tool" ? [turn] : turn.calls;
      const calls = scripted.map((call, index) => ({
        id: `call-${callIndex}-${index}`,
        name: call.toolName,
        args: call.args ?? {},
      }));
      pass.streamedText = "";
      pass.finalStreamedText = "";
      pass.pendingToolCalls = calls;
      this.state.streamedToolCalls.push(...calls);
    } else {
      pass.streamedText = turn.text;
      pass.finalStreamedText = turn.text;
      pass.pendingToolCalls = [];
      this.state.finalStreamedText = turn.text;
      finalText = turn.text;
    }
    pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
  }) as any);
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

/** The result the harness attached to one tool call id. */
function toolResultById(messages: ConversationMessage[], toolCallId: string): string {
  const toolCall = messages
    .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
    .find((candidate) => candidate.id === toolCallId);
  return JSON.stringify((toolCall as { result?: unknown } | undefined)?.result ?? null);
}

function userAnswerMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((message) => message._notificationSource === "user-answer");
}

/** The results the harness attached to the assistant's tool calls (the provider layer expands them). */
function toolResultText(messages: ConversationMessage[], toolName = "ask_user"): string {
  return messages
    .flatMap((message) => (message.role === "assistant" ? (message.toolCalls ?? []) : []))
    .filter((toolCall) => toolCall.name === toolName)
    .map((toolCall) => JSON.stringify((toolCall as { result?: unknown }).result ?? null))
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
    finalText = "";
    beforeCall = null;
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
    expect(response.body).toMatchObject({ ok: true, questionId: questionEvents(run)[0].questionId, blocking: true });
    await run.done;
    expect(callIndex).toBe(2);
    expect(toolResultText(run.seen[1])).toContain("green");
    expect(finalText).toBe("Green it is — a lime.");
  });

  it("the legacy agentConversationId still resolves (one release) and the fallback is logged", async () => {
    const conversationId = "client-conversation-legacy";
    const agentConversationId = "minted-legacy-agent-id";
    const run = startTurn(
      [
        { kind: "tool", toolName: "ask_user", args: { questions: [{ question: "Proceed?" }] } },
        { kind: "text", text: "Proceeding." },
      ],
      { conversationId, agentConversationId },
    );
    await until(() => questionEvents(run).length === 1, "the user_question event");

    const response = await request(app)
      .post("/agent/answer")
      .send({ conversationId: agentConversationId, answer: "yes" });

    expect(response.status).toBe(200);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("legacy agentConversationId"));
    await run.done;
    expect(toolResultText(run.seen[1])).toContain("yes");
  });

  it("non-blocking: the answer arrives once, as a <user-answer> mailbox entry, never again", async () => {
    const conversationId = "client-conversation-nb";
    const run = startTurn(
      [
        { kind: "tool", toolName: "ask_user", args: { blocking: false, questions: [{ question: "Tabs or spaces?" }] } },
        { kind: "text", text: "Working on the rest meanwhile." },
        { kind: "text", text: "Spaces, noted." },
      ],
      { conversationId, agentConversationId: "minted-nb-agent-id" },
    );
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    // The user clicks while the model is producing its second response.
    beforeCall = async (n) => {
      if (n !== 2) return;
      const questionId = questionEvents(run)[0].questionId;
      const first = await request(app).post("/agent/answer").send({ conversationId, questionId, answers: [{ answer: "spaces" }] });
      // A double click / retry of the same card must not deliver twice.
      const second = await request(app).post("/agent/answer").send({ conversationId, questionId, answers: [{ answer: "spaces" }] });
      answers.push(first, second);
    };

    await run.done;
    const questionId = questionEvents(run)[0].questionId;
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({ ok: true, questionId, blocking: false });
    expect(answers[1].status).toBe(404);
    expect(answers[1].body).toMatchObject({ reason: "unknown_question", questionId });

    // The text-only answer did not end the turn: the pending answer kept it alive.
    expect(callIndex).toBe(3);
    const delivered = userAnswerMessages(run.seen[2]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toContain("<user-answer>");
    expect(delivered[0].content).toContain("spaces");
    expect(delivered[0].questionId).toBe(questionId);
    expect(finalText).toBe("Spaces, noted.");

    // After the turn, the card is gone: the client's 404 fallback takes over.
    const late = await request(app).post("/agent/answer").send({ conversationId, questionId, answer: "spaces" });
    expect(late.status).toBe(404);
  });

  it("a sub-agent's question is answered with the sub-agent's own conversation id", async () => {
    const subAgentConversationId = "sub-agent-conversation-7";
    const run = startTurn(
      [
        { kind: "tool", toolName: "ask_user", args: { questions: [{ question: "Which file?" }] } },
        { kind: "text", text: "Editing src/app.ts." },
      ],
      // OrchestratorService runs a sub-agent with both ids = its own conversation id.
      { conversationId: subAgentConversationId, agentConversationId: subAgentConversationId, isSubAgent: true },
    );
    await until(() => questionEvents(run).length === 1, "the user_question event");

    const wrongLoop = await request(app).post("/agent/answer").send({ conversationId: "the-parents-conversation", answer: "x" });
    expect(wrongLoop.status).toBe(404);

    const response = await request(app)
      .post("/agent/answer")
      .send({ conversationId: subAgentConversationId, questionId: questionEvents(run)[0].questionId, answer: "src/app.ts" });
    expect(response.status).toBe(200);
    await run.done;
    expect(toolResultText(run.seen[1])).toContain("src/app.ts");
    expect(finalText).toBe("Editing src/app.ts.");
  });

  it("several open questions: questionId targets one; without it the OLDEST BLOCKING is answered and named; unknown ids 404", async () => {
    const conversationId = "client-conversation-many";
    const run = startTurn(
      [
        {
          kind: "tools",
          calls: [
            // Registered in this order: B (non-blocking, oldest), A, C.
            { toolName: "ask_user", args: { blocking: false, questions: [{ question: "B: theme?" }] } },
            { toolName: "ask_user", args: { questions: [{ question: "A: database?" }] } },
            { toolName: "ask_user", args: { questions: [{ question: "C: region?" }] } },
          ],
        },
        { kind: "text", text: "All set." },
      ],
      { conversationId, agentConversationId: "minted-many-agent-id" },
    );
    await until(() => questionEvents(run).length === 3, "three user_question events");
    await until(() => (pendingQuestions.get(conversationId)?.size ?? 0) === 3, "three registered questions");
    const byText = (prefix: string) =>
      questionEvents(run).find((event) => (event.questions as Array<{ question: string }>)[0].question.startsWith(prefix))!
        .questionId as string;
    const [idB, idA, idC] = [byText("B:"), byText("A:"), byText("C:")];
    expect(AgenticLoopService.listPendingQuestions(conversationId).map((question) => question.questionId)).toEqual([idB, idA, idC]);

    const unknown = await request(app).post("/agent/answer").send({ conversationId, questionId: "q-does-not-exist", answer: "?" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ reason: "unknown_question", questionId: "q-does-not-exist" });

    // No questionId: B is older but non-blocking — the oldest BLOCKING (A) is answered.
    const untargeted = await request(app).post("/agent/answer").send({ conversationId, answer: "postgres" });
    expect(untargeted.status).toBe(200);
    expect(untargeted.body).toMatchObject({ questionId: idA, blocking: true });

    const targetedB = await request(app).post("/agent/answer").send({ conversationId, questionId: idB, answer: "dark" });
    expect(targetedB.body).toMatchObject({ questionId: idB, blocking: false });
    const targetedC = await request(app).post("/agent/answer").send({ conversationId, questionId: idC, answer: "eu-west" });
    expect(targetedC.body).toMatchObject({ questionId: idC, blocking: true });

    await run.done;
    expect(toolResultById(run.seen[1], "call-1-1")).toContain("postgres");
    expect(toolResultById(run.seen[1], "call-1-2")).toContain("eu-west");
    const delivered = userAnswerMessages(run.seen[1]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toContain("dark");
    expect(pendingQuestions.has(conversationId)).toBe(false);
  });
});

describe("ask_user registry edges", () => {
  afterEach(() => {
    vi.useRealTimers();
    pendingQuestions.clear();
    TurnInputMailbox._clearAll();
  });

  it("an unanswered blocking question times out exactly as configured, and leaves the registry", async () => {
    // Only the timeout timers are faked — setImmediate stays real for `until`.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled: Record<string, unknown> | null = null;
    const pending = InternalToolRegistry.execute(
      "ask_user",
      { questions: [{ question: "Still there?" }] },
      { conversationId: "conv-timeout", agentConversationId: "agent-timeout" },
    ).then((result) => {
      settled = result as Record<string, unknown>;
    });
    await until(() => AgenticLoopService.listPendingQuestions("conv-timeout").length === 1, "registration");

    await vi.advanceTimersByTimeAsync(ASK_USER_BLOCKING_TIMEOUT_MILLISECONDS - 1);
    expect(settled).toBeNull();
    expect(AgenticLoopService.listPendingQuestions("conv-timeout")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toMatchObject({ answers: null, timedOut: true });
    expect(ASK_USER_BLOCKING_TIMEOUT_MILLISECONDS).toBe(300_000);
    // A late answer is not swallowed by a dead wait — it 404s, so the client re-sends it as a message.
    expect(AgenticLoopService.resolveUserQuestion("conv-timeout", [{ answer: "yes" }])).toEqual({
      resolved: false,
      reason: "no_pending_question",
    });
  });

  it("a non-blocking answer whose turn has closed is refused (404), not reported as delivered", async () => {
    // Registered, but no mailbox is open for the loop (the turn ended between).
    await InternalToolRegistry.execute(
      "ask_user",
      { blocking: false, questions: [{ question: "Colour?" }] },
      { conversationId: "conv-closed", agentConversationId: "agent-closed" },
    );
    const response = await request(app).post("/agent/answer").send({ conversationId: "conv-closed", answer: "red" });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ reason: "no_active_turn" });
  });

  it("/agent/answer without any id is a 400", async () => {
    const response = await request(app).post("/agent/answer").send({ answer: "x" });
    expect(response.status).toBe(400);
  });
});

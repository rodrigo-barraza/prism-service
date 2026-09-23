/**
 * persistPendingDecisions.test.ts — prompt 13, Landing 1.
 *
 * A decision the loop is waiting on — a tool call's approval, a blocking
 * `ask_user` question — lives in MongoDB (`pending_decisions`), not only in
 * the process that asked:
 *
 *   - RESTART. A REAL ReActHarness reaches its REAL ApprovalGate; the
 *     "restart" throws away every module (vi.resetModules) and rebuilds the
 *     route over the SAME mock Mongo store. The approval POSTed to the new
 *     process is accepted and recorded — not 404'd as a stranger.
 *   - NO TIMEOUT. Past the old two-minute approval / five-minute question
 *     timeouts the call is still pending and the conversation is parked
 *     `awaiting_user` — nothing was denied on the user's behalf.
 *   - EXACTLY ONCE. Two POSTs of one decision (or one answer) are accepted
 *     once; the second is a 409, never a second delivery and never a 404
 *     (which would make the client re-send an answer as a message).
 *
 * Mocks mirror perCallApprovals.test.ts; the gate, the approval engine, the
 * registries and the routes are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import AgenticLoopService from "#src/services/AgenticLoopService";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import agentRouter from "#src/routes/AgentRoutes";
import { createMockCollection } from "../../../../tests/mongoMock.ts";
import type {
  AgenticContext,
  ResolvedTools,
  ConversationMessage,
  PassState,
} from "../types.ts";

// ── One Mongo store that outlives the "process" ──────────────────────

const mongo = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof import("../../../../tests/mongoMock.ts").createMockCollection>>(),
}));

function mockCollection(name: string) {
  if (!mongo.collections.has(name)) mongo.collections.set(name, createMockCollection());
  return mongo.collections.get(name)!;
}

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection: create } = await import("../../../../tests/mongoMock.ts");
  const collection = (name: string) => {
    if (!mongo.collections.has(name)) mongo.collections.set(name, create());
    return mongo.collections.get(name)!;
  };
  return {
    default: {
      getDb: () => ({ collection }),
      getCollection: (_database: string, name: string) => collection(name),
    },
  };
});

function pendingDecisionDocuments(): Array<Record<string, any>> {
  return [...mockCollection("pending_decisions")._docs.values()];
}

// ── Heavy mocks (as perCallApprovals.test.ts) ────────────────────────

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  PROVIDER_SGLANG: [],
  getModelRoleChainFromEnvironment: () => [],
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

// The decision routes never reach the /agent handler; keep its import graph out.
vi.mock("#src/routes/ChatRoutes", () => ({ handleAgent: vi.fn() }));

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn(), get: vi.fn() },
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), cleanup: vi.fn(), setEstimatedInputTokens: vi.fn() },
}));

vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));

vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    getAvailableLocales: () => ["en"],
    get: (_locale: string, key: string, variables?: Record<string, string>) =>
      `[locale:${key}]${variables ? ` ${JSON.stringify(variables)}` : ""}`,
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
  createStandardHooks: () => ({
    hooks: {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
      }),
    },
    // The REAL engine: write_file is tier WRITE, so every call needs a human.
    approvalEngine: new AutoApprovalEngine({ fullAuto: false }),
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

const executeToolBatchMock = vi.fn();
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
  executeToolSingle: vi.fn(),
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
vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({ checkCostBudget: vi.fn().mockReturnValue(false), enforceCostBudget: vi.fn().mockResolvedValue(false), recordLoopSpend: vi.fn() }));
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
vi.mock("#src/services/ToolContext", () => ({
  default: { getStore: vi.fn().mockReturnValue(new Map()), cleanupInMemory: vi.fn() },
}));
vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    // The approval preview reads the current file; the scratch files are new.
    executeTool: vi.fn().mockResolvedValue({ error: "File not found" }),
    isStreamable: vi.fn().mockReturnValue(false),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
  NEEDS_YOU_WEBHOOK_EVENTS: {},
}));

// ── Harness factory ──────────────────────────────────────────────────

const WRITE_FILE_SCHEMA = {
  name: "write_file",
  description: "Write a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

interface ScriptedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type Turn = { kind: "tools"; calls: ScriptedCall[] } | { kind: "text"; text: string };

const PROJECT = "prism-test";
const USERNAME = "test-user";

function buildScriptedHarness(conversationId: string, script: Turn[]) {
  let iteration = 0;
  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
    generateTextStreamLive: undefined,
    discoverContextWindow: vi.fn(),
  };
  const emit = vi.fn();
  const context: AgenticContext = {
    project: PROJECT,
    username: USERNAME,
    agent: "CODING",
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as any,
    traceId: "test-trace",
    agentConversationId: `agent-${conversationId}`,
    conversationId,
    provider: mockProvider as any,
    options: {
      maxIterations: 4,
      autoApprove: false,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      tools: [WRITE_FILE_SCHEMA],
    },
    messages: [{ role: "user", content: "Write a file" }],
    emit,
    signal: undefined as any,
    requestId: "req-test",
    requestStart: performance.now(),
    isNewConversation: true,
  } as any;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [WRITE_FILE_SCHEMA] as any,
    resolvedEnabledTools: ["write_file"],
  };
  const harness = new ReActHarness(context, state, tools);

  (harness as any).createProviderStream = vi.fn().mockImplementation(async () => {
    iteration++;
    return mockProvider.generateTextStream();
  });
  (harness as any).consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
      const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
      pass.streamedThinking = "";
      pass.thinkingSignature = "";
      if (turn.kind === "tools") {
        pass.streamedText = "";
        pass.finalStreamedText = "";
        pass.pendingToolCalls = turn.calls.map((call) => ({ ...call, args: { ...call.args } }));
        for (const call of turn.calls) state.streamedToolCalls.push({ ...call, args: { ...call.args } });
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

  return { harness, emit };
}

const ONE_WRITE: ScriptedCall[] = [
  { id: "call-1", name: "write_file", args: { path: "one.txt", content: "one\n" } },
];

function approvalEvents(emit: ReturnType<typeof vi.fn>) {
  return emit.mock.calls.map((call) => call[0]).filter((event) => event?.type === "approval_required");
}

function decidedEvents(emit: ReturnType<typeof vi.fn>) {
  return emit.mock.calls.map((call) => call[0]).filter((event) => event?.type === "approval_decided");
}

/** The conversation document the turn persists into (a stub, as markGenerating leaves it). */
function seedConversation(conversationId: string) {
  mockCollection("agent_conversations")._docs.set(conversationId, {
    id: conversationId,
    project: PROJECT,
    username: USERNAME,
    isGenerating: true,
    isActive: true,
    messages: [],
  });
}

function conversationDocument(conversationId: string): Record<string, any> | undefined {
  return mockCollection("agent_conversations")._docs.get(conversationId);
}

function buildApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use("/agent", router);
  return supertest(app);
}

/** Let fire-and-forget persistence finish (a few macrotask turns). */
async function flush() {
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mongo.collections.clear();
  TurnInputMailbox._clearAll();
  executeToolBatchMock.mockImplementation(async (toolCalls: ScriptedCall[]) =>
    toolCalls.map((toolCall) => ({
      name: toolCall.name,
      id: toolCall.id,
      result: { success: true, wrote: toolCall.args.path },
      durationMilliseconds: 5,
    })),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

// ── No timeout ───────────────────────────────────────────────────────

describe("a wait has no timeout: the turn parks awaiting the user", () => {
  it("an approval is still pending long past the old two-minute timeout, and the conversation is awaiting_user", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const conversationId = "parked-approval";
    seedConversation(conversationId);
    const { harness, emit } = buildScriptedHarness(conversationId, [
      { kind: "tools", calls: ONE_WRITE },
      { kind: "text", text: "done" },
    ]);

    let finished = false;
    const running = harness.run().then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(approvalEvents(emit)).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await flush();

    expect(finished).toBe(false);
    expect(executeToolBatchMock).not.toHaveBeenCalled();
    expect(decidedEvents(emit), "nothing was decided on the user's behalf").toEqual([]);
    const pending = await AgenticLoopService.getPendingApproval(conversationId);
    expect(pending).toMatchObject({ isPending: true, toolCalls: [expect.objectContaining({ id: "call-1" })] });
    expect(conversationDocument(conversationId)).toMatchObject({ runState: "awaiting_user" });
    expect(typeof conversationDocument(conversationId)?.awaitingUserSince).toBe("string");

    // The user comes back an hour later: the turn picks up where it parked.
    vi.useRealTimers();
    const approved = await buildApp(agentRouter)
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "allow" });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ delivered: true });
    await running;
    expect(executeToolBatchMock).toHaveBeenCalledTimes(1);
    await flush();
    expect(conversationDocument(conversationId)?.runState).toBeUndefined();
  });

  it("a blocking question is still open long past the old five-minute timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const conversationId = "parked-question";
    let result: Record<string, unknown> | null = null;
    const pending = InternalToolRegistry.execute(
      "ask_user",
      { questions: [{ question: "Still there?" }] },
      { conversationId, agentConversationId: `agent-${conversationId}`, project: PROJECT, username: USERNAME },
    ).then((value) => {
      result = value as Record<string, unknown>;
    });
    await vi.waitFor(async () =>
      expect(await AgenticLoopService.listPendingQuestions(conversationId)).toHaveLength(1),
    );

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await flush();
    expect(result).toBeNull();
    expect(await AgenticLoopService.listPendingQuestions(conversationId)).toHaveLength(1);

    vi.useRealTimers();
    const answered = await buildApp(agentRouter)
      .post("/agent/answer")
      .send({ conversationId, answer: "yes" });
    expect(answered.status).toBe(200);
    await pending;
    expect(result).toMatchObject({ answers: [{ answer: "yes" }] });
  });
});

// ── Exactly once ─────────────────────────────────────────────────────

describe("a decision is accepted once", () => {
  it("two concurrent approvals of one call: one 200, one 409, one decided event, one execution", async () => {
    const conversationId = "double-approve";
    seedConversation(conversationId);
    const { harness, emit } = buildScriptedHarness(conversationId, [
      { kind: "tools", calls: ONE_WRITE },
      { kind: "text", text: "done" },
    ]);
    const running = harness.run();
    await vi.waitFor(() => expect(approvalEvents(emit)).toHaveLength(1));

    const http = buildApp(agentRouter);
    const body = { conversationId, toolCallId: "call-1", decision: "allow" };
    const responses = await Promise.all([
      http.post("/agent/approve").send(body),
      http.post("/agent/approve").send(body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    await running;
    expect(decidedEvents(emit)).toHaveLength(1);
    expect(executeToolBatchMock).toHaveBeenCalledTimes(1);
  });

  it("a second answer to one question is a 409 — not a 404 the client would re-send as a message", async () => {
    const conversationId = "double-answer";
    const pending = InternalToolRegistry.execute(
      "ask_user",
      { questions: [{ question: "Colour?" }] },
      { conversationId, agentConversationId: `agent-${conversationId}`, project: PROJECT, username: USERNAME },
    );
    await vi.waitFor(async () =>
      expect(await AgenticLoopService.listPendingQuestions(conversationId)).toHaveLength(1),
    );
    const [{ questionId }] = await AgenticLoopService.listPendingQuestions(conversationId);

    const http = buildApp(agentRouter);
    const first = await http.post("/agent/answer").send({ conversationId, questionId, answer: "red" });
    expect(first.status).toBe(200);
    await expect(pending).resolves.toMatchObject({ answers: [{ answer: "red" }] });

    const second = await http.post("/agent/answer").send({ conversationId, questionId, answer: "blue" });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body).toMatchObject({ reason: "already_answered", questionId });
  });
});

// ── Restart ──────────────────────────────────────────────────────────
// LAST in the file, on purpose: vi.resetModules() leaves this file's static
// imports on the old module graph while the tools' dynamic imports reach
// the new one — a split no real process has. Nothing may run after it.

describe("a pending approval survives a restart", () => {
  it("is persisted when the gate parks, and an approval POSTed to the NEW process is recorded", async () => {
    const conversationId = "durable-approval";
    seedConversation(conversationId);
    const { harness, emit } = buildScriptedHarness(conversationId, [
      { kind: "tools", calls: ONE_WRITE },
      { kind: "text", text: "done" },
    ]);

    void harness.run();
    await vi.waitFor(() => expect(approvalEvents(emit)).toHaveLength(1));
    await flush();

    // Persisted: what is being asked, of which loop, still undecided.
    const [parked] = pendingDecisionDocuments();
    expect(parked).toMatchObject({
      loopKey: conversationId,
      kind: "tool",
      itemId: "call-1",
      name: "write_file",
      args: { path: "one.txt", content: "one\n" },
      status: "pending",
      batchId: approvalEvents(emit)[0].batchId,
    });

    // ── The process dies. Every module (and its in-memory map) is gone;
    //    the Mongo store is not.
    vi.resetModules();
    const { default: restartedRouter } = await import("#src/routes/AgentRoutes");
    const { default: RestartedLoopService } = await import("#src/services/AgenticLoopService");
    const restarted = buildApp(restartedRouter);

    // Still visible as pending to a reloading client.
    const before = await RestartedLoopService.getPendingApproval(conversationId);
    expect(before).toMatchObject({ isPending: true, toolCalls: [expect.objectContaining({ id: "call-1" })] });

    const approved = await restarted
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "allow" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Nothing in this process was waiting on it: stored for the re-driven turn (Landing 2).
    expect(approved.body).toMatchObject({ ok: true, decision: "allow", delivered: false });

    const [decided] = pendingDecisionDocuments();
    expect(decided).toMatchObject({
      itemId: "call-1",
      status: "decided",
      decision: { decision: "allow", scope: "call", source: "user" },
    });
    expect(typeof decided.decidedAt).toBe("string");

    const after = await RestartedLoopService.getPendingApproval(conversationId);
    expect(after.isPending).toBe(false);

    // And it is a decision, not a vote: the same call cannot be decided again.
    const again = await restarted
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "deny" });
    expect(again.status).toBe(409);
    expect(pendingDecisionDocuments()[0].decision.decision).toBe("allow");
  });

  it("a blocking question survives too: the answer POSTed after the restart is stored", async () => {
    const conversationId = "durable-question";
    let settled = false;
    void InternalToolRegistry.execute(
      "ask_user",
      { questions: [{ question: "Which port?" }] },
      { conversationId, agentConversationId: `agent-${conversationId}`, project: PROJECT, username: USERNAME },
    ).then(() => {
      settled = true;
    });
    await vi.waitFor(async () =>
      expect(await AgenticLoopService.listPendingQuestions(conversationId)).toHaveLength(1),
    );
    await flush();
    const [parked] = pendingDecisionDocuments();
    expect(parked).toMatchObject({ loopKey: conversationId, kind: "question", status: "pending", blocking: true });

    vi.resetModules();
    const { default: restartedRouter } = await import("#src/routes/AgentRoutes");
    const answered = await buildApp(restartedRouter)
      .post("/agent/answer")
      .send({ conversationId, questionId: parked.itemId, answer: "5173" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({ ok: true, questionId: parked.itemId, delivered: false });
    expect(pendingDecisionDocuments()[0]).toMatchObject({
      status: "answered",
      answers: [{ answer: "5173" }],
    });
    // The old process's wait is not what took it.
    expect(settled).toBe(false);
  });
});

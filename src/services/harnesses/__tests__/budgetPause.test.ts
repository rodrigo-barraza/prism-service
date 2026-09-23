/**
 * budgetPause.test.ts — prompt 13, Landing 3.
 *
 * Reaching the cost cap PAUSES a turn instead of ending it:
 *
 *   - PAUSE. The pass that crossed the cap does not run its tools; the turn
 *     parks on its user (a `budget` decision in PendingDecisionStore, the
 *     conversation `awaiting_user`) and says what it spent against the cap
 *     (`status: budget_reached`). A pass that crossed without tools pauses
 *     before the next model call instead.
 *   - RESUME. Raising the cap (PATCH /conversations/:id/budget, or the goal's
 *     budget through PATCH /conversations/:id/goal when the goal's budget is
 *     what binds) resumes it — the same decision, the same mechanism as an
 *     approval. A cap no higher than the spend is refused; stopping ends the
 *     turn with the budget note as before.
 *   - SUB-AGENTS. The whole delegation tree shares one budget: a sub-agent's
 *     spend counts toward the root's cap and pauses the tree under the ROOT
 *     conversation.
 *   - RESTART. A paused turn survives a restart (it is re-driven, its spend
 *     and cap carried) and a cap raised while the server was down is applied
 *     when it is.
 *   - Callers that cannot answer a card (autoApprove, unattended — the
 *     Discord bot, scheduled runs) still stop at the cap unless they ask to
 *     pause (`onBudgetReached`).
 *
 * The harness is the one resumeParkedTurns.test.ts uses: each "process" is a
 * fresh module graph over ONE mock Mongo store; the loop, the gate, the
 * registries, the stores and the resume service are real, the model is
 * scripted at the provider. Pricing is pinned: 100 input tokens = $1.00.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { createMockCollection } from "../../../../tests/mongoMock.ts";

// ── State that outlives a "process" ───────────────────────────────────

interface ScriptedPass {
  text?: string;
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** Input tokens the pass reports — 100 = $1.00. */
  inputTokens?: number;
}

const shared = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof import("../../../../tests/mongoMock.ts").createMockCollection>>(),
  process: 0,
  passes: new Map<string, ScriptedPass[]>(),
  modelCalls: [] as Array<{ conversationId: string; process: number }>,
  executions: [] as Array<{ process: number; name: string; args: Record<string, unknown> }>,
  events: [] as Array<{ process: number; conversationId: string; event: Record<string, unknown> }>,
}));

function mockCollection(name: string) {
  if (!shared.collections.has(name)) shared.collections.set(name, createMockCollection());
  return shared.collections.get(name)!;
}

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection: create } = await import("../../../../tests/mongoMock.ts");
  const collection = (name: string) => {
    if (!shared.collections.has(name)) shared.collections.set(name, create());
    return shared.collections.get(name)!;
  };
  return {
    default: {
      getDb: () => ({ collection }),
      getCollection: (_database: string, name: string) => collection(name),
    },
  };
});

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

// 100 input tokens = $1.00, output free: every pass's cost is its inputTokens / 100.
vi.mock("#src/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/config")>();
  return {
    ...original,
    getPricing: () => ({ "test-model": { inputPerMillion: 10_000, outputPerMillion: 0 } }),
  };
});

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

vi.mock("#src/services/conversation/ConversationService", async () => {
  const conversationService = await import("./fixtures/resumeConversationServiceMock.ts");
  return { default: conversationService.createConversationServiceMock(shared) };
});
vi.mock("#src/services/ConversationService", async () => {
  const conversationService = await import("./fixtures/resumeConversationServiceMock.ts");
  return { default: conversationService.createConversationServiceMock(shared) };
});

// Finalize persists the turn (and how it ended) the way the Finalizer does, minus telemetry.
vi.mock("../lifecycle/Finalizer.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lifecycle/Finalizer.ts")>();
  return {
    ...original,
    finalizeTextGeneration: async (
      context: Record<string, any>,
      result: { text: string; conversationOutcome?: string | null },
      newTurnMessages: Array<Record<string, unknown>>,
    ) => {
      const { default: ConversationService } = await import("#src/services/ConversationService");
      await ConversationService.appendMessages(
        context.conversationId,
        context.project,
        context.username,
        [
          ...original.sanitizeMessagesForPersistence(newTurnMessages as never),
          { role: "assistant", content: result.text, conversationOutcome: result.conversationOutcome ?? null },
        ] as never,
        null,
        { collection: "agent_conversations" },
      );
      context.emit({ type: "done", text: result.text });
      return null;
    },
  };
});

/** A scripted provider for one loop: its passes, in order, keyed by `key`. */
function scriptedProvider(key: string, process: number) {
  return {
    generateTextStream: () => {
      shared.modelCalls.push({ conversationId: key, process });
      const pass = shared.passes.get(key)?.shift() ?? { text: "fallback final answer" };
      return (async function* () {
        if (pass.text) yield pass.text;
        for (const call of pass.calls ?? []) yield { type: "toolCall", ...call };
        yield { type: "usage", usage: { inputTokens: pass.inputTokens ?? 100, outputTokens: 10 } };
      })();
    },
  };
}

function loopOptions(params: Record<string, any>) {
  return {
    harness: "standard",
    topology: "single",
    thoughtStructure: "chain_of_thought",
    enableCriticGate: false,
    maxIterations: 8,
    autoApprove: params.autoApprove === true,
    ...(params.unattended != null && { unattended: params.unattended }),
    // As the real prepareGenerationContext forwards them from the request.
    ...(typeof params.maxCostDollars === "number" && params.maxCostDollars > 0 && {
      maxCostDollars: params.maxCostDollars,
    }),
    ...(params.onBudgetReached != null && { onBudgetReached: params.onBudgetReached }),
    agenticLoopEnabled: true,
    maxTokens: 8_192,
    ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
  };
}

// ── The /agent handler: the loop's context, from its params ───────────

vi.mock("#src/routes/ChatRoutes", () => ({
  handleAgent: async (
    params: Record<string, any>,
    emit: (event: Record<string, unknown>) => void,
    { signal }: { signal?: AbortSignal } = {},
  ) => {
    const { default: AgenticLoopService } = await import("#src/services/AgenticLoopService");
    const { messages, _resume, ...request } = params;
    const process = shared.process;
    const conversationId = params.conversationId as string;
    return AgenticLoopService.runAgenticLoop({
      project: params.project,
      username: params.username,
      agent: params.agent,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDefinition: { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
      provider: scriptedProvider(conversationId, process),
      options: loopOptions(params),
      messages,
      agentConversationId: params.agentConversationId ?? `agent-${conversationId}`,
      conversationId,
      isNewConversation: false,
      conversationMeta: params.conversationMeta ?? null,
      emit: (event: Record<string, unknown>) => {
        shared.events.push({ process, conversationId, event });
        emit(event);
      },
      signal,
      requestId: `request-${process}-${Math.random().toString(36).slice(2, 8)}`,
      requestStart: performance.now(),
      request,
      resume: _resume ?? null,
    } as never);
  },
}));

// ── Tools: a read (AUTO tier), and a sub-agent spawn on the shared budget ──

const SUB_AGENT_ID = "helper-sub-agent";

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: () => [],
    getMCPToolSchemas: () => [],
    isStreamable: () => false,
    getToolLabel: (name: string) => name,
    getToolEmoji: () => "🔧",
    executeTool: async (name: string, args: Record<string, unknown>, context: Record<string, any>) => {
      shared.executions.push({ process: shared.process, name, args });
      if (name === "spawn_helper") {
        // A sub-agent loop, handed the parent's budget the way OrchestratorService does.
        const { default: AgenticLoopService } = await import("#src/services/AgenticLoopService");
        const process = shared.process;
        const outcome = await AgenticLoopService.runAgenticLoop({
          project: context.project,
          username: context.username,
          agent: "CODING",
          providerName: "test-provider",
          resolvedModel: "test-model",
          modelDefinition: { maxInputTokens: 128_000, maxOutputTokens: 8_192 },
          provider: scriptedProvider(SUB_AGENT_ID, process),
          options: {
            ...loopOptions({ autoApprove: true }),
            isSubAgent: true,
            ...(typeof context._maxCostDollars === "number" && { maxCostDollars: context._maxCostDollars }),
            ...(context._sharedCostBudget ? { _sharedCostBudget: context._sharedCostBudget } : {}),
          },
          messages: [{ role: "user", content: "Help with it" }],
          agentConversationId: SUB_AGENT_ID,
          conversationId: SUB_AGENT_ID,
          parentAgentConversationId: context.agentConversationId,
          isNewConversation: true,
          emit: (event: Record<string, unknown>) => {
            shared.events.push({ process, conversationId: SUB_AGENT_ID, event });
          },
          requestId: `sub-${process}`,
          requestStart: performance.now(),
        } as never);
        return { success: true, messages: (outcome as { messages?: unknown[] })?.messages?.length ?? 0 };
      }
      return { success: true, tool: name, path: args.path };
    },
  },
}));

const TOOL_SCHEMAS = ["read_file", "spawn_helper"].map((name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: { path: { type: "string" } } },
}));

vi.mock("#src/services/AgenticToolResolver", () => ({
  default: {
    resolve: async () => ({ finalTools: TOOL_SCHEMAS, resolvedEnabledTools: TOOL_SCHEMAS.map((t) => t.name) }),
    detectNativeThinking: () => false,
  },
}));

vi.mock("../lifecycle/HookInitializer.ts", async () => {
  const { default: AutoApprovalEngine } = await import("#src/services/AutoApprovalEngine");
  return {
    createStandardHooks: ({ autoApprove, permissionMode }: { autoApprove: boolean; permissionMode?: never }) => ({
      hooks: {
        run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
          if (name === "beforePrompt") {
            hookContext._assembledSystemPrompt = "You are a test agent.";
            hookContext._injectedSkills = [];
          }
          return undefined;
        }),
      },
      approvalEngine: new AutoApprovalEngine({ fullAuto: autoApprove, permissionMode }),
    }),
    attachConfiguredHooks: vi.fn().mockResolvedValue(0),
  };
});

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
vi.mock("#src/services/MediaResolutionService", () => ({
  resolveMessageMediaReferences: async (messages: unknown[]) => messages,
}));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: (messages: unknown[]) => messages,
}));
vi.mock("#src/utils/DirectViewerBroadcast", () => ({
  withDirectViewerBroadcast: (_conversationId: string, emit: unknown) => emit,
}));
vi.mock("#src/services/conversation/workspaceSnapshots", () => ({
  snapshotBeforeToolBatch: vi.fn().mockResolvedValue(null),
  snapshotAfterToolBatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn(), get: vi.fn() },
}));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue(null),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
  NEEDS_YOU_WEBHOOK_EVENTS: {},
}));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    getAvailableLocales: () => ["en"],
    get: (_locale: string, key: string, variables?: Record<string, string>) =>
      `[locale:${key}]${variables ? ` ${JSON.stringify(variables)}` : ""}`,
  },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn(), stripPlanningInstruction: vi.fn(), extractSteps: () => [] },
}));
vi.mock("../lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("../lifecycle/ContextPressureManager.ts", () => ({
  manageContextPressure: async (messages: unknown[]) => ({ messages, compactionPerformed: false }),
}));
vi.mock("../lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/OrchestratorService", () => ({
  default: {
    cleanupConversation: vi.fn(),
    markUndeliveredDispatchesAsCounted: vi.fn().mockReturnValue(0),
    isSubAgentConversation: vi.fn().mockReturnValue(false),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────

const PROJECT = "prism-test";
const USERNAME = "test-user";

/** A fresh process: a new module graph over the same store. */
async function bootProcess() {
  vi.resetModules();
  shared.process++;
  const { default: TurnResumeService } = await import("#src/services/TurnResumeService");
  const { default: conversationsRouter } = await import("#src/routes/ConversationsRoutes");
  const { handleAgent } = await import("#src/routes/ChatRoutes");
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as unknown as Record<string, unknown>).project = request.headers["x-project"];
    (request as unknown as Record<string, unknown>).username = request.headers["x-username"];
    next();
  });
  app.use("/conversations", conversationsRouter);
  return { TurnResumeService, http: supertest(app), handleAgent };
}

/** What a restarting process does at boot (src/index.ts). */
async function restart() {
  const next = await bootProcess();
  const plan = await next.TurnResumeService.prepare();
  await next.TurnResumeService.start(plan);
  return { ...next, plan };
}

function seedConversation(conversationId: string, extra: Record<string, unknown> = {}) {
  mockCollection("agent_conversations")._docs.set(conversationId, {
    id: conversationId,
    project: PROJECT,
    username: USERNAME,
    agent: "CODING",
    messages: [],
    ...extra,
  });
}

function conversation(conversationId: string): Record<string, any> {
  return mockCollection("agent_conversations")._docs.get(conversationId)!;
}

function turnRun(conversationId: string): Record<string, any> | undefined {
  return [...mockCollection("turn_runs")._docs.values()].find((run) => run.id === conversationId);
}

function budgetRecords(loopKey: string): Array<Record<string, any>> {
  return [...mockCollection("pending_decisions")._docs.values()].filter(
    (record) => record.loopKey === loopKey && record.kind === "budget",
  );
}

interface TurnRequest {
  maxCostDollars?: number;
  onBudgetReached?: "pause" | "stop";
  autoApprove?: boolean;
  unattended?: boolean;
  signal?: AbortSignal;
}

function startTurn(
  handleAgent: (
    params: Record<string, unknown>,
    emit: (event: unknown) => void,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>,
  conversationId: string,
  prompt: string,
  { signal, ...request }: TurnRequest = {},
) {
  void handleAgent(
    {
      provider: "test-provider",
      model: "test-model",
      agent: "CODING",
      project: PROJECT,
      username: USERNAME,
      conversationId,
      ...request,
      messages: [{ role: "user", content: prompt }],
    },
    () => {},
    { signal },
  );
}

function statusesOf(process: number, conversationId: string, message: string) {
  return shared.events
    .filter(
      (entry) =>
        entry.process === process &&
        entry.conversationId === conversationId &&
        entry.event.type === "status" &&
        entry.event.message === message,
    )
    .map((entry) => entry.event);
}

function eventsOf(process: number, conversationId: string, type: string) {
  return shared.events
    .filter((entry) => entry.process === process && entry.conversationId === conversationId)
    .map((entry) => entry.event)
    .filter((event) => event.type === type);
}

async function until(predicate: () => boolean, label: string, limitMilliseconds = 5_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > limitMilliseconds) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Let a paused turn prove it stays paused: a few event-loop turns with nothing new. */
async function settle() {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 1));
}

function executionsOf(process: number, name: string, path?: string) {
  return shared.executions.filter(
    (execution) =>
      execution.process === process && execution.name === name && (path === undefined || execution.args.path === path),
  );
}

function modelCallsOf(process: number, conversationId: string) {
  return shared.modelCalls.filter((call) => call.process === process && call.conversationId === conversationId);
}

function finalMessage(conversationId: string): Record<string, any> | undefined {
  const messages = conversation(conversationId).messages as Array<Record<string, any>>;
  const last = messages.at(-1);
  return last?.role === "assistant" && !last.toolCalls ? last : undefined;
}

function patchBudget(
  http: supertest.Agent | ReturnType<typeof supertest>,
  conversationId: string,
  body: Record<string, unknown>,
) {
  return http
    .patch(`/conversations/${conversationId}/budget`)
    .set({ "x-project": PROJECT, "x-username": USERNAME })
    .send(body);
}

/** Three reads, then an answer — $1.00 a pass. */
function scriptReads(conversationId: string) {
  shared.passes.set(conversationId, [
    { text: "Reading a.", calls: [{ id: "call-1", name: "read_file", args: { path: "a.txt" } }] },
    { text: "Reading b.", calls: [{ id: "call-2", name: "read_file", args: { path: "b.txt" } }] },
    { text: "Done." },
  ]);
}

beforeEach(() => {
  shared.process = 0;
  shared.collections.clear();
  shared.passes.clear();
  shared.modelCalls.length = 0;
  shared.executions.length = 0;
  shared.events.length = 0;
});

// ── Pause, don't kill ─────────────────────────────────────────────────

describe("reaching the cost cap pauses the turn", () => {
  it("the pass that crossed the cap runs no tool; the turn parks on its user and says what it spent against the cap", async () => {
    const conversationId = "paused-at-cap";
    seedConversation(conversationId);
    scriptReads(conversationId);

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a and b", { maxCostDollars: 1.5 });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");
    await settle();

    const [reached] = statusesOf(1, conversationId, "budget_reached");
    expect(reached).toMatchObject({ spentDollars: 2, maxCostDollars: 1.5, limitedBy: "turn", iteration: 2 });
    expect(typeof reached.pauseId).toBe("string");
    // Paused, not ended: no stop, no `done`, the second read never ran.
    expect(statusesOf(1, conversationId, "cost_limit_reached")).toHaveLength(0);
    expect(eventsOf(1, conversationId, "done")).toHaveLength(0);
    expect(executionsOf(1, "read_file", "a.txt")).toHaveLength(1);
    expect(executionsOf(1, "read_file", "b.txt")).toHaveLength(0);
    expect(modelCallsOf(1, conversationId)).toHaveLength(2);
    // Parked like an approval: a durable decision, and the conversation awaits its user.
    expect(conversation(conversationId).runState).toBe("awaiting_user");
    expect(budgetRecords(conversationId)).toEqual([
      expect.objectContaining({ status: "pending", itemId: reached.pauseId, spentDollars: 2, maxCostDollars: 1.5 }),
    ]);
  });

  it("raising the cap resumes it: a cap no higher than the spend is refused, a higher one runs the paused tools and finishes the turn", async () => {
    const conversationId = "raise-resumes";
    seedConversation(conversationId);
    scriptReads(conversationId);

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a and b", { maxCostDollars: 1.5 });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");

    const tooLow = await patchBudget(first.http, conversationId, { maxCostDollars: 2 });
    expect(tooLow.status, JSON.stringify(tooLow.body)).toBe(422);
    expect(tooLow.body).toMatchObject({ spentDollars: 2, limitedBy: "turn" });
    const invalid = await patchBudget(first.http, conversationId, { maxCostDollars: "lots" });
    expect(invalid.status).toBe(400);
    await settle();
    expect(executionsOf(1, "read_file", "b.txt"), "still paused after a refused raise").toHaveLength(0);

    const raised = await patchBudget(first.http, conversationId, { maxCostDollars: 5 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body).toMatchObject({ status: "raised", maxCostDollars: 5, spentDollars: 2, delivered: true });

    await until(() => finalMessage(conversationId)?.content === "Done.", "the final answer persisted");
    expect(executionsOf(1, "read_file", "b.txt")).toHaveLength(1);
    expect(modelCallsOf(1, conversationId)).toHaveLength(3);
    expect(finalMessage(conversationId)?.conversationOutcome).not.toBe("budget_exhausted");
    expect(statusesOf(1, conversationId, "budget_resolved")).toEqual([
      expect.objectContaining({ action: "raise", maxCostDollars: 5, source: "user" }),
    ]);
    expect(conversation(conversationId).runState).toBeUndefined();
    expect(budgetRecords(conversationId)).toEqual([expect.objectContaining({ status: "decided" })]);

    // The pause is spent: a second raise finds nothing waiting.
    const again = await patchBudget(first.http, conversationId, { maxCostDollars: 9 });
    expect(again.status).toBe(404);
  });

  it("stopping a paused turn ends it with the budget note, as a stop at the cap did before", async () => {
    const conversationId = "stopped-while-paused";
    seedConversation(conversationId);
    scriptReads(conversationId);
    const stop = new AbortController();

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a and b", { maxCostDollars: 1.5, signal: stop.signal });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");
    stop.abort();

    await until(() => budgetRecords(conversationId)[0]?.status === "cancelled", "the pause lapsed");
    await until(() => conversation(conversationId).runState === undefined, "the conversation un-parked");
    expect(executionsOf(1, "read_file", "b.txt")).toHaveLength(0);
    expect(modelCallsOf(1, conversationId)).toHaveLength(2);
  });

  it("a pass that crossed the cap without calling a tool pauses before the next model call", async () => {
    const conversationId = "paused-before-model-call";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { text: "Reading a.", calls: [{ id: "call-1", name: "read_file", args: { path: "a.txt" } }] },
      // Empty output: the loop would retry — that retry is the next spend.
      { text: "" },
      { text: "Done." },
    ]);

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a", { maxCostDollars: 1.5 });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");
    await settle();
    expect(modelCallsOf(1, conversationId), "no model call past the cap").toHaveLength(2);
    expect(statusesOf(1, conversationId, "budget_reached")[0]).toMatchObject({ spentDollars: 2, maxCostDollars: 1.5 });

    const raised = await patchBudget(first.http, conversationId, { maxCostDollars: 4 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    await until(() => finalMessage(conversationId)?.content === "Done.", "the final answer persisted");
    expect(modelCallsOf(1, conversationId)).toHaveLength(3);
  });
});

// ── Who is asked ──────────────────────────────────────────────────────

describe("callers that cannot answer a card stop at the cap unless they ask to pause", () => {
  it("autoApprove (the Discord bot) stops at the cap as before: no pause, the budget note persisted", async () => {
    const conversationId = "auto-approve-stops";
    seedConversation(conversationId);
    scriptReads(conversationId);

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a and b", { maxCostDollars: 1.5, autoApprove: true });
    await until(() => !!finalMessage(conversationId), "the turn ended");
    expect(statusesOf(1, conversationId, "budget_reached")).toHaveLength(0);
    expect(statusesOf(1, conversationId, "cost_limit_reached")).toHaveLength(1);
    expect(finalMessage(conversationId)?.conversationOutcome).toBe("budget_exhausted");
    expect(String(finalMessage(conversationId)?.content)).toContain("Cost cap reached");
    expect(budgetRecords(conversationId)).toHaveLength(0);
  });

  it("an unattended run stops too; onBudgetReached: \"pause\" makes either one pause", async () => {
    const unattended = "unattended-stops";
    seedConversation(unattended);
    scriptReads(unattended);
    const first = await bootProcess();
    startTurn(first.handleAgent, unattended, "Read a and b", { maxCostDollars: 1.5, unattended: true });
    await until(() => !!finalMessage(unattended), "the unattended turn ended");
    expect(finalMessage(unattended)?.conversationOutcome).toBe("budget_exhausted");

    const optedIn = "opted-in-pauses";
    seedConversation(optedIn);
    scriptReads(optedIn);
    startTurn(first.handleAgent, optedIn, "Read a and b", {
      maxCostDollars: 1.5,
      autoApprove: true,
      onBudgetReached: "pause",
    });
    await until(() => statusesOf(1, optedIn, "budget_reached").length === 1, "the opted-in pause");
    expect(finalMessage(optedIn)).toBeUndefined();
  });
});

// ── Sub-agents ────────────────────────────────────────────────────────

describe("sub-agents count toward the root's budget", () => {
  it("a sub-agent crossing the root's cap pauses the tree under the ROOT conversation; raising it resumes both", async () => {
    const conversationId = "root-with-helper";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { text: "Delegating.", calls: [{ id: "call-1", name: "spawn_helper", args: {} }] },
      { text: "All done." },
    ]);
    shared.passes.set(SUB_AGENT_ID, [
      { calls: [{ id: "sub-call-1", name: "read_file", args: { path: "x.txt" } }] },
      { calls: [{ id: "sub-call-2", name: "read_file", args: { path: "y.txt" } }] },
      { text: "Helper finished." },
    ]);

    const first = await bootProcess();
    // The root spends $1, the helper $1 + $1: the tree reaches $3 against a $2.5 cap.
    startTurn(first.handleAgent, conversationId, "Delegate it", {
      maxCostDollars: 2.5,
      autoApprove: true,
      onBudgetReached: "pause",
    });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the tree's pause, on the root");
    await settle();

    expect(statusesOf(1, conversationId, "budget_reached")[0]).toMatchObject({ spentDollars: 3, maxCostDollars: 2.5 });
    expect(executionsOf(1, "read_file", "x.txt")).toHaveLength(1);
    expect(executionsOf(1, "read_file", "y.txt"), "the helper's crossing pass runs nothing").toHaveLength(0);
    expect(budgetRecords(conversationId)).toHaveLength(1);
    expect(budgetRecords(SUB_AGENT_ID)).toHaveLength(0);

    const raised = await patchBudget(first.http, conversationId, { maxCostDollars: 10 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    await until(() => finalMessage(conversationId)?.content === "All done.", "the root finished");
    expect(executionsOf(1, "read_file", "y.txt")).toHaveLength(1);
    expect(modelCallsOf(1, SUB_AGENT_ID)).toHaveLength(3);
  });
});

// ── The goal's budget ─────────────────────────────────────────────────

describe("a conversation goal's dollar budget is a cap too", () => {
  it("pauses at the goal's remaining budget; the goal's budget — not the turn's — is what a raise must lift", async () => {
    const conversationId = "goal-budget";
    const now = new Date().toISOString();
    seedConversation(conversationId, {
      goal: {
        objective: "Read everything",
        budget: { maxCostDollars: 2.5 },
        progress: { summary: "Not started", percent: 0, updatedAt: now },
        blockedOn: null,
        status: "active",
        spentDollars: 1,
        turnsUsed: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
    scriptReads(conversationId);

    const first = await bootProcess();
    // No turn cap: the goal has $1.5 left, and the turn reaches $2.
    startTurn(first.handleAgent, conversationId, "Keep reading");
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the goal's pause");
    expect(statusesOf(1, conversationId, "budget_reached")[0]).toMatchObject({
      spentDollars: 2,
      maxCostDollars: 1.5,
      limitedBy: "goal",
      goalMaxCostDollars: 2.5,
    });

    const turnRaise = await patchBudget(first.http, conversationId, { maxCostDollars: 10 });
    expect(turnRaise.status).toBe(422);
    expect(turnRaise.body).toMatchObject({ limitedBy: "goal" });

    const goalRaise = await first.http
      .patch(`/conversations/${conversationId}/goal`)
      .set({ "x-project": PROJECT, "x-username": USERNAME })
      .send({ budget: { maxCostDollars: 10 } });
    expect(goalRaise.status, JSON.stringify(goalRaise.body)).toBe(200);
    expect(goalRaise.body.budgetPause).toMatchObject({ status: "raised", delivered: true });
    await until(() => finalMessage(conversationId)?.content === "Done.", "the final answer persisted");
  });
});

// ── Restart ───────────────────────────────────────────────────────────

describe("a paused turn survives a restart", () => {
  it("is re-driven, paused again on the same decision with its spend carried — no model call — and completes once the cap is raised", async () => {
    const conversationId = "paused-then-restart";
    seedConversation(conversationId);
    scriptReads(conversationId);

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a and b", { maxCostDollars: 1.5 });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");
    const [firstPause] = statusesOf(1, conversationId, "budget_reached");

    const second = await restart();
    expect(second.plan.resumable.map(({ run }) => run.id)).toEqual([conversationId]);
    await until(() => statusesOf(2, conversationId, "budget_reached").length === 1, "the pause again");
    expect(statusesOf(2, conversationId, "budget_reached")[0]).toMatchObject({
      pauseId: firstPause.pauseId,
      spentDollars: 2,
      maxCostDollars: 1.5,
    });
    expect(modelCallsOf(2, conversationId), "the crossing pass is replayed, not bought again").toHaveLength(0);
    expect(executionsOf(2, "read_file")).toHaveLength(0);
    expect(budgetRecords(conversationId)).toHaveLength(1);

    const raised = await patchBudget(second.http, conversationId, { maxCostDollars: 5 });
    expect(raised.body).toMatchObject({ status: "raised", delivered: true });
    await until(() => finalMessage(conversationId)?.content === "Done.", "the final answer persisted");
    expect(executionsOf(2, "read_file", "b.txt")).toHaveLength(1);
    expect(executionsOf(2, "read_file", "a.txt"), "the finished read is not run again").toHaveLength(0);
    expect(modelCallsOf(2, conversationId)).toHaveLength(1);
  });

  it("a cap raised while the server was down is applied when the turn is re-driven — no pause, no card", async () => {
    const conversationId = "raised-while-down";
    seedConversation(conversationId);
    scriptReads(conversationId);
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a and b", { maxCostDollars: 1.5 });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");

    // Down: the next process is up but has not re-driven anything yet.
    const second = await bootProcess();
    const raised = await patchBudget(second.http, conversationId, { maxCostDollars: 5 });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(raised.body).toMatchObject({ delivered: false });

    await second.TurnResumeService.start(await second.TurnResumeService.prepare());
    await until(() => finalMessage(conversationId)?.content === "Done.", "the final answer persisted");
    expect(statusesOf(2, conversationId, "budget_reached")).toHaveLength(0);
    expect(executionsOf(2, "read_file", "b.txt")).toHaveLength(1);
  });

  it("a pause before a model call (no tool batch in flight) is re-driven too", async () => {
    const conversationId = "paused-before-call-restart";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { text: "Reading a.", calls: [{ id: "call-1", name: "read_file", args: { path: "a.txt" } }] },
      { text: "" },
      { text: "Done." },
    ]);
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Read a", { maxCostDollars: 1.5 });
    await until(() => statusesOf(1, conversationId, "budget_reached").length === 1, "the budget pause");

    const second = await restart();
    expect(second.plan.resumable.map(({ run }) => run.id)).toEqual([conversationId]);
    await until(() => statusesOf(2, conversationId, "budget_reached").length === 1, "the pause again");
    expect(modelCallsOf(2, conversationId)).toHaveLength(0);

    await patchBudget(second.http, conversationId, { maxCostDollars: 4 });
    await until(() => finalMessage(conversationId)?.content === "Done.", "the final answer persisted");
    expect(modelCallsOf(2, conversationId)).toHaveLength(1);
    expect(executionsOf(2, "read_file"), "the read before the pause is not run again").toHaveLength(0);
  });
});

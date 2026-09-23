/**
 * resumeParkedTurns.test.ts — prompt 13, Landing 2.
 *
 * A turn a restart interrupted is RE-DRIVEN, not just salvaged:
 *
 *   - PARKED. A turn waiting on an approval when the process died is run
 *     again by the next process (TurnResumeService). Its interrupted pass is
 *     replayed — the model is not asked again — the card is the same card,
 *     and once the user approves, the turn completes and its final answer
 *     is persisted.
 *   - IN FLIGHT. A call that was running when the process died is not run
 *     again on its own when it can have side effects: the user is asked
 *     ("the server restarted while X was running — run it again?"). A
 *     read-only call simply runs again; a call that had finished keeps its
 *     result.
 *   - MAILBOX. Input posted to the running turn before the crash reaches
 *     the re-driven turn exactly once.
 *   - ASYNC TASKS. A task running at the crash is reported UNCERTAIN to its
 *     parent — once — and never run again.
 *
 * Each "process" is a fresh module graph (vi.resetModules) over ONE mock
 * Mongo store that outlives it; the previous process's promises are left
 * hanging, as a killed process leaves them. The loop, the approval gate
 * (with the real approval engine), the executor, the registries, the
 * stores and the resume service are real. The model is scripted at the
 * provider, so a replayed pass goes through the real stream path. The
 * /agent handler is a stand-in that builds the loop's context from its
 * params the way ChatRoutes.handleAgent does (request and resume included).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";
import { createMockCollection } from "../../../../tests/mongoMock.ts";

// ── State that outlives a "process" ───────────────────────────────────

interface ScriptedPass {
  text?: string;
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

const shared = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof import("../../../../tests/mongoMock.ts").createMockCollection>>(),
  /** The "process" currently running (1, 2, …). */
  process: 0,
  /** Scripted model passes per conversation, consumed in order. */
  passes: new Map<string, ScriptedPass[]>(),
  /** What the model was asked, per call. */
  modelCalls: [] as Array<{ conversationId: string; process: number; messages: Array<Record<string, unknown>> }>,
  /** Every tool execution, by process. */
  executions: [] as Array<{ process: number; name: string; args: Record<string, unknown> }>,
  /** Tools (`name`, or `name:path`) that never return in the process that started them (the crash cuts them off). */
  hangingTools: new Set<string>(),
  /** Events each process's turns emitted. */
  events: [] as Array<{ process: number; conversationId: string; event: Record<string, unknown> }>,
  /** Every call of the /agent handler stand-in. */
  handled: [] as Array<{ process: number; params: Record<string, unknown> }>,
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

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

// ── The conversation store, as far as a turn uses it ──────────────────

vi.mock("#src/services/conversation/ConversationService", async () => {
  const conversationService = await import("./fixtures/resumeConversationServiceMock.ts");
  return { default: conversationService.createConversationServiceMock(shared) };
});
vi.mock("#src/services/ConversationService", async () => {
  const conversationService = await import("./fixtures/resumeConversationServiceMock.ts");
  return { default: conversationService.createConversationServiceMock(shared) };
});

// Finalize persists the turn the way the Finalizer does, minus telemetry.
vi.mock("../lifecycle/Finalizer.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lifecycle/Finalizer.ts")>();
  return {
    ...original,
    finalizeTextGeneration: async (
      context: Record<string, any>,
      result: { text: string },
      newTurnMessages: Array<Record<string, unknown>>,
    ) => {
      const { default: ConversationService } = await import("#src/services/ConversationService");
      await ConversationService.appendMessages(
        context.conversationId,
        context.project,
        context.username,
        [
          ...original.sanitizeMessagesForPersistence(newTurnMessages as never),
          { role: "assistant", content: result.text },
        ] as never,
        null,
        { collection: "agent_conversations" },
      );
      context.emit({ type: "done", text: result.text });
      return null;
    },
  };
});

// ── The /agent handler: the loop's context, from its params ───────────

vi.mock("#src/routes/ChatRoutes", () => ({
  handleAgent: async (
    params: Record<string, any>,
    emit: (event: Record<string, unknown>) => void,
    { signal }: { signal?: AbortSignal } = {},
  ) => {
    shared.handled.push({ process: shared.process, params });
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
      provider: {
        generateTextStream: (
          sentMessages: Array<Record<string, unknown>>,
          _model: string,
          options: Record<string, unknown>,
        ) => {
          const key = String(options.promptCacheKey).replace(/^agent-/, "");
          shared.modelCalls.push({ conversationId: key, process, messages: sentMessages.map((m) => ({ ...m })) });
          const pass = shared.passes.get(key)?.shift() ?? { text: "fallback final answer" };
          return (async function* () {
            if (pass.text) yield pass.text;
            for (const call of pass.calls ?? []) yield { type: "toolCall", ...call };
            yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
          })();
        },
      },
      options: {
        harness: "standard",
        topology: "single",
        thoughtStructure: "chain_of_thought",
        enableCriticGate: false,
        maxIterations: 6,
        autoApprove: params.autoApprove === true,
        // As the real prepareGenerationContext forwards them.
        ...(params.permissionMode != null && { permissionMode: params.permissionMode }),
        ...(params.unattended != null && { unattended: params.unattended }),
        agenticLoopEnabled: true,
        maxTokens: 8_192,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      },
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

// ── Tools: a write, a read, a slow write; the approval engine is real ──

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: () => [],
    getMCPToolSchemas: () => [],
    isStreamable: () => false,
    getToolLabel: (name: string) => name,
    getToolEmoji: () => "🔧",
    executeTool: async (name: string, args: Record<string, unknown>, context: Record<string, unknown>) => {
      if (name === "ask_user") {
        const { default: InternalToolRegistry } = await import(
          "#src/services/tool-definitions/InternalToolRegistry"
        );
        return InternalToolRegistry.execute(name, args, context as never);
      }
      shared.executions.push({ process: shared.process, name, args });
      const key = shared.hangingTools.has(`${name}:${args.path}`) ? `${name}:${args.path}` : name;
      if (shared.hangingTools.has(key)) {
        shared.hangingTools.delete(key); // hangs in this process only
        return new Promise(() => {});
      }
      return { success: true, tool: name, path: args.path };
    },
  },
}));

const TOOL_SCHEMAS = ["write_file", "read_file", "ask_user"].map((name) => ({
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
    createStandardHooks: ({ autoApprove }: { autoApprove: boolean }) => ({
      hooks: {
        run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
          if (name === "beforePrompt") {
            hookContext._assembledSystemPrompt = "You are a test agent.";
            hookContext._injectedSkills = [];
          }
          return undefined;
        }),
      },
      approvalEngine: new AutoApprovalEngine({ fullAuto: autoApprove }),
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
  const { default: agentRouter } = await import("#src/routes/AgentRoutes");
  const { handleAgent } = await import("#src/routes/ChatRoutes");
  const { default: TurnInputMailbox } = await import("#src/services/TurnInputMailbox");
  const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
  const app = express();
  app.use(express.json());
  app.use("/agent", agentRouter);
  return { TurnResumeService, http: supertest(app), handleAgent, TurnInputMailbox, AsyncTaskRegistry };
}

/** What a restarting process does at boot (src/index.ts). */
async function restart() {
  const next = await bootProcess();
  const plan = await next.TurnResumeService.prepare();
  await next.TurnResumeService.start(plan);
  return { ...next, plan };
}

function seedConversation(conversationId: string) {
  mockCollection("agent_conversations")._docs.set(conversationId, {
    id: conversationId,
    project: PROJECT,
    username: USERNAME,
    agent: "CODING",
    messages: [],
  });
}

function conversation(conversationId: string): Record<string, any> {
  return mockCollection("agent_conversations")._docs.get(conversationId)!;
}

function turnRun(conversationId: string): Record<string, any> | undefined {
  return [...mockCollection("turn_runs")._docs.values()].find((run) => run.id === conversationId);
}

function startTurn(
  handleAgent: (params: Record<string, unknown>, emit: (event: unknown) => void) => Promise<unknown>,
  conversationId: string,
  prompt: string,
  { autoApprove = false, unattended = false }: { autoApprove?: boolean; unattended?: boolean } = {},
) {
  void handleAgent(
    {
      provider: "test-provider",
      model: "test-model",
      agent: "CODING",
      project: PROJECT,
      username: USERNAME,
      conversationId,
      autoApprove,
      ...(unattended && { unattended }),
      messages: [{ role: "user", content: prompt }],
    },
    () => {},
  );
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

/** Executions of a tool by the turn (the approval card's diff preview also reads files: not counted). */
function executionsOf(process: number, name: string) {
  return shared.executions.filter(
    (execution) =>
      execution.process === process && execution.name === name && !("absolutePath" in execution.args),
  );
}

function modelCallsOf(process: number, conversationId: string) {
  return shared.modelCalls.filter((call) => call.process === process && call.conversationId === conversationId);
}

function finalAnswer(conversationId: string): string | undefined {
  const messages = conversation(conversationId).messages as Array<Record<string, unknown>>;
  const last = messages.at(-1);
  return last?.role === "assistant" && !last.toolCalls ? String(last.content) : undefined;
}

beforeEach(() => {
  shared.process = 0;
  shared.collections.clear();
  shared.passes.clear();
  shared.modelCalls.length = 0;
  shared.executions.length = 0;
  shared.hangingTools.clear();
  shared.events.length = 0;
  shared.handled.length = 0;
});

// ── Parked on an approval ─────────────────────────────────────────────

describe("a turn parked on an approval is re-driven after a restart", () => {
  it("replays its pass (no second model call), re-shows the same card, and completes once approved — the final answer persisted", async () => {
    const conversationId = "parked-approval";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { text: "I'll write it.", calls: [{ id: "call-1", name: "write_file", args: { path: "one.txt" } }] },
      { text: "Done: wrote one.txt." },
    ]);

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write one.txt");
    await until(() => eventsOf(1, conversationId, "approval_required").length === 1, "the first card");
    await until(() => !!turnRun(conversationId)?.pass, "the pass on record");
    const [firstCard] = eventsOf(1, conversationId, "approval_required");

    // ── The process dies. The next one re-drives the turn. ──
    const second = await restart();
    expect(second.plan.resumable.map(({ run }) => run.id)).toEqual([conversationId]);
    await until(() => eventsOf(2, conversationId, "approval_required").length === 1, "the card again");

    const [card] = eventsOf(2, conversationId, "approval_required");
    expect(card).toMatchObject({ toolCallId: "call-1", batchId: firstCard.batchId });
    expect(modelCallsOf(2, conversationId), "the interrupted pass is replayed, not asked again").toHaveLength(0);
    expect(executionsOf(2, "write_file")).toHaveLength(0);
    // The turn so far is in the transcript already: a reloading client sees the prompt.
    expect(conversation(conversationId).messages.map((m: Record<string, unknown>) => m.content)).toContain(
      "Write one.txt",
    );

    const approved = await second.http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "allow" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ delivered: true });

    await until(() => finalAnswer(conversationId) === "Done: wrote one.txt.", "the final answer persisted");
    expect(executionsOf(2, "write_file")).toHaveLength(1);
    expect(modelCallsOf(2, conversationId)).toHaveLength(1);
    const persisted = conversation(conversationId).messages as Array<Record<string, any>>;
    // One user prompt, one tool round with its result, one answer — nothing twice.
    expect(persisted.filter((message) => message.role === "user")).toHaveLength(1);
    expect(persisted.filter((message) => message.toolCalls?.some((call: any) => call.id === "call-1"))).toHaveLength(1);
    expect(persisted.filter((message) => message.role === "tool")).toHaveLength(1);
    await until(() => !turnRun(conversationId), "the run record dropped");
    expect(conversation(conversationId).turnCheckpoint).toBeUndefined();
  });

  it("an approval given while the server was down is applied when the turn is re-driven — no card, no wait", async () => {
    const conversationId = "approved-while-down";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { calls: [{ id: "call-1", name: "write_file", args: { path: "two.txt" } }] },
      { text: "Wrote two.txt." },
    ]);
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write two.txt");
    await until(() => eventsOf(1, conversationId, "approval_required").length === 1, "the card");
    await until(() => !!turnRun(conversationId)?.pass, "the pass on record");

    // Down: the next process is up but has not re-driven anything yet.
    const second = await bootProcess();
    const approved = await second.http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-1", decision: "allow" });
    expect(approved.body).toMatchObject({ delivered: false });

    await second.TurnResumeService.start(await second.TurnResumeService.prepare());
    await until(() => finalAnswer(conversationId) === "Wrote two.txt.", "the final answer persisted");
    expect(eventsOf(2, conversationId, "approval_required")).toHaveLength(0);
    expect(executionsOf(2, "write_file")).toHaveLength(1);
  });
});

// ── Calls in flight at the crash ──────────────────────────────────────

describe("calls running when the process died", () => {
  it("a write is not run again without a decision; a read-only call re-runs; once the user says yes, the write runs once", async () => {
    const conversationId = "in-flight";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      {
        calls: [
          { id: "call-w", name: "write_file", args: { path: "w.txt" } },
          { id: "call-r", name: "read_file", args: { path: "r.txt" } },
        ],
      },
      { text: "Both done." },
    ]);
    shared.hangingTools.add("write_file");
    shared.hangingTools.add("read_file");

    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write w, read r", { autoApprove: true });
    await until(
      () => Object.values(turnRun(conversationId)?.pass?.calls ?? {}).filter((call: any) => call.status === "running").length === 2,
      "both calls running",
    );

    const second = await restart();
    await until(() => eventsOf(2, conversationId, "approval_required").length === 1, "the retry card");
    const [card] = eventsOf(2, conversationId, "approval_required");
    expect(card).toMatchObject({
      toolCallId: "call-w#retry",
      requestedBy: "restart",
      toolCall: expect.objectContaining({ name: "write_file" }),
    });
    expect(String(card.reason)).toContain("harness.resume.retryReason");
    // Even with auto-approve on: "run it again?" is not the mode's to answer.
    // The batch waits for it — the read-only call re-runs with the batch.
    expect(executionsOf(2, "write_file"), "the write waits for the user").toHaveLength(0);
    expect(executionsOf(2, "read_file")).toHaveLength(0);

    const approved = await second.http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-w#retry", decision: "allow" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await until(() => finalAnswer(conversationId) === "Both done.", "the final answer");
    expect(executionsOf(2, "write_file")).toHaveLength(1);
    expect(executionsOf(2, "read_file")).toHaveLength(1);
  });

  it("declining the retry leaves the call un-run, and the model is told it may have partly happened", async () => {
    const conversationId = "in-flight-declined";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { calls: [{ id: "call-w", name: "write_file", args: { path: "w.txt" } }] },
      { text: "Understood." },
    ]);
    shared.hangingTools.add("write_file");
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write w", { autoApprove: true });
    await until(() => turnRun(conversationId)?.pass?.calls?.["0"]?.status === "running", "the call running");

    const second = await restart();
    await until(() => eventsOf(2, conversationId, "approval_required").length === 1, "the retry card");
    await second.http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "call-w#retry", decision: "deny" });
    await until(() => finalAnswer(conversationId) === "Understood.", "the final answer");
    expect(executionsOf(2, "write_file")).toHaveLength(0);
    const sentToModel = JSON.stringify(modelCallsOf(2, conversationId)[0].messages);
    expect(sentToModel).toContain("INTERRUPTED_BY_RESTART");
    expect(sentToModel).toContain("harness.resume.notRerun");
  });

  it("where nobody can answer (an unattended run), 'run it again?' is not asked: the write is not run, and the model is told it may have partly happened", async () => {
    const conversationId = "in-flight-unattended";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { calls: [{ id: "call-w", name: "write_file", args: { path: "w.txt" } }] },
      { text: "Reported." },
    ]);
    shared.hangingTools.add("write_file");
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write w", { autoApprove: true, unattended: true });
    await until(() => turnRun(conversationId)?.pass?.calls?.["0"]?.status === "running", "the call running");

    await restart();
    // The re-driven turn is still unattended (its recorded request says so),
    // so it never parks on a card nobody would click.
    await until(() => finalAnswer(conversationId) === "Reported.", "the final answer");
    expect(eventsOf(2, conversationId, "approval_required")).toHaveLength(0);
    expect(executionsOf(2, "write_file")).toHaveLength(0);
    const sentToModel = JSON.stringify(modelCallsOf(2, conversationId)[0].messages);
    expect(sentToModel).toContain("INTERRUPTED_BY_RESTART");
    expect(sentToModel).toContain("harness.resume.notRerun");
  });

  it("a call that finished before the crash keeps its result: not asked about, not run again", async () => {
    const conversationId = "finished-before";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      {
        calls: [
          { id: "call-a", name: "write_file", args: { path: "a.txt" } },
          { id: "call-b", name: "write_file", args: { path: "b.txt" } },
        ],
      },
      { text: "Wrote both." },
    ]);
    shared.hangingTools.add("write_file:b.txt");
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write a and b", { autoApprove: true });
    await until(() => {
      const calls = turnRun(conversationId)?.pass?.calls ?? {};
      return calls["0"]?.status === "finished" && calls["1"]?.status === "running";
    }, "a finished, b cut off");

    const second = await restart();
    await until(() => eventsOf(2, conversationId, "approval_required").length === 1, "the retry card for b");
    expect(eventsOf(2, conversationId, "approval_required")[0]).toMatchObject({ toolCallId: "call-b#retry" });
    await second.http.post("/agent/approve").send({ conversationId, toolCallId: "call-b#retry", decision: "allow" });
    await until(() => finalAnswer(conversationId) === "Wrote both.", "the final answer");

    const reruns = executionsOf(2, "write_file").map((execution) => execution.args.path);
    expect(reruns, "a kept its result; only b ran again").toEqual(["b.txt"]);
    const sentToModel = JSON.stringify(modelCallsOf(2, conversationId)[0].messages);
    expect(sentToModel).toContain('"path":"a.txt"');
  });
});

// ── Mailbox ───────────────────────────────────────────────────────────

describe("mid-turn input posted before the crash", () => {
  it("reaches the re-driven turn exactly once", async () => {
    const conversationId = "mailbox";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { calls: [{ id: "call-1", name: "write_file", args: { path: "m.txt" } }] },
      { text: "Done, and noted." },
    ]);
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write m.txt");
    await until(() => eventsOf(1, conversationId, "approval_required").length === 1, "the card");
    const posted = first.TurnInputMailbox.post(conversationId, {
      kind: "user_update",
      text: "Also mention the date.",
    });
    expect(posted.accepted).toBe(true);
    await until(() => mockCollection("turn_inputs")._docs.size === 1, "the input kept durably");

    const second = await restart();
    await until(() => eventsOf(2, conversationId, "approval_required").length === 1, "the card again");
    await second.http.post("/agent/approve").send({ conversationId, toolCallId: "call-1", decision: "allow" });
    await until(() => finalAnswer(conversationId) === "Done, and noted.", "the final answer");

    const [nextCall] = modelCallsOf(2, conversationId);
    const updatesSeen = nextCall.messages.filter((message) => String(message.content).includes("Also mention the date."));
    expect(updatesSeen, "delivered to the model once").toHaveLength(1);
    const persisted = (conversation(conversationId).messages as Array<Record<string, any>>).filter((message) =>
      String(message.content).includes("Also mention the date."),
    );
    expect(persisted, "persisted once").toHaveLength(1);
    expect(persisted[0]._turnInput?.id).toBe(posted.id);
    await until(() => mockCollection("turn_inputs")._docs.size === 0, "the input forgotten");

    // Another restart delivers nothing again.
    await restart();
    const again = (conversation(conversationId).messages as Array<Record<string, any>>).filter((message) =>
      String(message.content).includes("Also mention the date."),
    );
    expect(again).toHaveLength(1);
  });

  it("input of a turn that is not re-driven lands in its transcript, once", async () => {
    const conversationId = "mailbox-salvaged";
    seedConversation(conversationId);
    const first = await bootProcess();
    // A turn mid-model-call: nothing to re-drive. Its box accepted an update.
    first.TurnInputMailbox.open(conversationId, {
      project: PROJECT,
      username: USERNAME,
      agent: "CODING",
      conversationCollection: "agent_conversations",
    });
    first.TurnInputMailbox.post(conversationId, { kind: "user_update", text: "Stop after step one." });
    await until(() => mockCollection("turn_inputs")._docs.size === 1, "the input kept");

    await restart();
    await restart();
    const persisted = (conversation(conversationId).messages as Array<Record<string, any>>).filter((message) =>
      String(message.content).includes("Stop after step one."),
    );
    expect(persisted).toHaveLength(1);
    expect(mockCollection("turn_inputs")._docs.size).toBe(0);
  });
});

// ── Async tasks ───────────────────────────────────────────────────────

describe("an async task running at the crash", () => {
  it("is reported UNCERTAIN to its parent once, and never run again", async () => {
    const conversationId = "async-task";
    seedConversation(conversationId);
    const first = await bootProcess();
    let executorRuns = 0;
    const dispatched = first.AsyncTaskRegistry.dispatch(
      "execute_command",
      { command: "make deploy" },
      { conversationId, agentConversationId: `agent-${conversationId}`, project: PROJECT, username: USERNAME },
      () => {
        executorRuns++;
        return new Promise(() => {}); // still running when the process dies
      },
    );
    const taskId = (dispatched as { taskId: string }).taskId;
    await until(() => mockCollection("detached_work")._docs.size === 1, "the task on record");

    const second = await restart();
    const notices = (conversation(conversationId).messages as Array<Record<string, any>>).filter((message) =>
      String(message.content).includes(taskId),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain("uncertain");
    expect(notices[0].content).toContain("harness.resume.interruptedTaskSummary");
    expect(executorRuns, "not run again").toBe(1);
    // The tools still know it — as uncertain, not as a running task to wait on.
    expect(second.AsyncTaskRegistry.getTask(taskId)?.status).toBe("uncertain");
    expect(second.AsyncTaskRegistry.countRunningTasks(`agent-${conversationId}`)).toBe(0);

    await restart();
    const after = (conversation(conversationId).messages as Array<Record<string, any>>).filter((message) =>
      String(message.content).includes(taskId),
    );
    expect(after, "reported once, however many restarts").toHaveLength(1);
  });
});

// ── A crash loop is not re-driven forever ─────────────────────────────

describe("a turn re-driven too often", () => {
  it("is salvaged instead, and its card lapses", async () => {
    const conversationId = "crash-loop";
    seedConversation(conversationId);
    shared.passes.set(conversationId, [
      { calls: [{ id: "call-1", name: "write_file", args: { path: "x.txt" } }] },
    ]);
    const first = await bootProcess();
    startTurn(first.handleAgent, conversationId, "Write x.txt");
    await until(() => !!turnRun(conversationId)?.pass, "the pass on record");
    await until(() => eventsOf(1, conversationId, "approval_required").length === 1, "the card");
    turnRun(conversationId)!.attempts = 2;

    const second = await restart();
    expect(second.plan.resumable).toEqual([]);
    expect(turnRun(conversationId)).toBeUndefined();
    const [record] = [...mockCollection("pending_decisions")._docs.values()];
    expect(record).toMatchObject({ itemId: "call-1", status: "decided", decision: { source: "turn_ended" } });
    expect(conversation(conversationId).runState).toBeUndefined();
  });
});

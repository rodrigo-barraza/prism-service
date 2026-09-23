/**
 * endTurnAfterTools.test.ts — Persona.endTurnAfterTools through a REAL
 * ReActHarness with the real stream router, finalizer and SSE aggregation
 * (the scaffolding of harnessEventContract.test.ts).
 *
 * LUPOS's persona names react_to_discord_message. When a response carries
 * the reply AND only fire-and-forget calls, the calls run and the turn ends
 * with that reply: one model call, the reply as the chunk stream and as the
 * `/agent` JSON's finalText, one `done`, and the reply persisted once as the
 * turn's final assistant message. Anything else — no text, another tool in
 * the batch, input waiting, a Stop hook that blocks, another agent — and the
 * loop goes on as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "#src/services/harnesses/ReActHarness";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { buildJsonResponseFromEvents } from "#src/utils/SseUtilities";
import { endsTurnWithReply } from "#src/services/harnesses/lifecycle/EndTurnAfterTools";
import type { AgenticContext, ConversationMessage, ResolvedTools } from "#src/services/harnesses/types";
import type { SseEvent } from "#src/types/SseTypes";

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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn(), provider: vi.fn() },
}));

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection } = await import("../../../../tests/mongoMock.ts");
  const collections = new Map<string, unknown>();
  const collection = (name: string) => {
    if (!collections.has(name)) collections.set(name, createMockCollection());
    return collections.get(name);
  };
  return { default: { getDb: () => ({ collection }), getCollection: (_database: string, name: string) => collection(name) } };
});

vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({ default: { injectPlanningInstruction: vi.fn() } }));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    getAvailableLocales: () => ["en"],
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

/** What a Stop hook answers (undefined = let the turn end). */
const stopHook = vi.hoisted(() => ({ verdict: undefined as undefined | Record<string, unknown> }));
vi.mock("#src/services/harnesses/lifecycle/HookInitializer", () => ({
  createStandardHooks: () => ({
    hooks: {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
        if (name === "stop") {
          const verdict = stopHook.verdict;
          stopHook.verdict = undefined;
          return verdict;
        }
        return undefined;
      }),
    },
    approvalEngine: new AutoApprovalEngine({ fullAuto: true }),
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

const appended = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>> }));
vi.mock("#src/utils/ConversationUtilities", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendAndFinalize: vi.fn(async (_id: string, _project: string, _user: string, messages: Array<Record<string, unknown>>) => {
    appended.messages.push(...messages);
  }),
}));

const executeToolBatchMock = vi.fn();
vi.mock("#src/services/harnesses/lifecycle/ToolExecutor", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
  executeToolSingle: vi.fn(),
}));
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: { adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined), appendMessages: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: { countRunningTasks: vi.fn().mockReturnValue(0), hasActiveTask: vi.fn().mockReturnValue(false), listTasks: vi.fn().mockReturnValue([]) },
}));
vi.mock("#src/services/OrchestratorService", () => ({
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined), markUndeliveredDispatchesAsCounted: vi.fn().mockReturnValue(0) },
}));
vi.mock("#src/services/harnesses/lifecycle/ValidationInterceptor", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/harnesses/lifecycle/KVCacheReporter", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("#src/services/harnesses/lifecycle/ToolDiscoveryNudge", () => ({ injectToolDiscoveryNudge: vi.fn() }));
vi.mock("#src/services/harnesses/lifecycle/SystemReminderInjector", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));
vi.mock("#src/services/FileService", () => ({
  default: { upsertFile: vi.fn().mockResolvedValue(undefined), uploadFile: vi.fn() },
}));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({ ok: true }),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue("🔧"),
    getToolLabel: vi.fn().mockImplementation((name: string) => `Running ${name}`),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

const schema = (name: string) => ({
  name,
  description: `${name} (test)`,
  parameters: { type: "object", properties: { messageId: { type: "string" }, emoji: { type: "string" } } },
});
const REACT = schema("react_to_discord_message");
const SEARCH = schema("search_discord_messages");

const reactCall = (id = "call-react") => ({
  type: "toolCall",
  id,
  name: "react_to_discord_message",
  args: { messageId: "123456789012345678", emoji: "🐺" },
});
const usage = (inputTokens: number) => ({ type: "usage", usage: { inputTokens, outputTokens: 12 } });

function buildHarness(passes: unknown[][], { agent = "LUPOS", conversationId = "conv-end-turn" } = {}) {
  const events: SseEvent[] = [];
  const seenInputs: ConversationMessage[][] = [];
  const context: AgenticContext = {
    project: "lupos",
    username: "lupos",
    agent,
    providerName: "google",
    resolvedModel: "gemini-3.6-flash",
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as never,
    traceId: "trace-end-turn",
    agentConversationId: `agent-${conversationId}`,
    conversationId,
    provider: { generateTextStream: vi.fn(), discoverContextWindow: vi.fn() } as never,
    options: { maxIterations: 5, autoApprove: true, agenticLoopEnabled: true, maxTokens: 8192, tools: [REACT, SEARCH] },
    messages: [{ role: "user", content: "lupos you absolute menace" }],
    emit: (event: unknown) => events.push(structuredClone(event) as SseEvent),
    signal: undefined as never,
    requestId: "req-end-turn",
    requestStart: performance.now(),
    isNewConversation: true,
  } as never;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = { finalTools: [REACT, SEARCH] as never, resolvedEnabledTools: [REACT.name, SEARCH.name] };
  const harness = new ReActHarness(context, state, tools);
  let pass = 0;
  (harness as unknown as { createProviderStream: unknown }).createProviderStream = vi
    .fn()
    .mockImplementation(async (messages: ConversationMessage[]) => {
      seenInputs.push(messages.map((message) => ({ ...message })));
      const chunks = passes[pass++] ?? ["(unexpected extra pass)", usage(1)];
      return (async function* () {
        yield* chunks;
      })();
    });
  return {
    harness,
    state,
    events,
    seenInputs,
    conversationId,
    modelCalls: () => pass,
    json: () => buildJsonResponseFromEvents(events, {} as never).response!,
    chunkText: () => events.filter((event) => event.type === "chunk").map((event) => event.content).join(""),
  };
}

const executedNames = () =>
  executeToolBatchMock.mock.calls.flatMap((call) => (call[0] as Array<{ name: string }>).map((toolCall) => toolCall.name));
const finalAssistant = () => [...appended.messages].reverse().find((message) => message.role === "assistant");

describe("endTurnAfterTools — a reaction sent with the reply ends the turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    appended.messages = [];
    stopHook.verdict = undefined;
    executeToolBatchMock.mockImplementation(async (toolCalls: Array<{ id: string; name: string }>) =>
      toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result: { ok: true }, durationMilliseconds: 3 })),
    );
  });

  it.each([
    ["text, then the reaction", ["get bent, ", "pup", reactCall(), usage(900)]],
    ["the reaction, then text (Gemini's part order)", [reactCall(), "get bent, pup", usage(900)]],
  ])("%s ⇒ one model call, the reaction runs, the reply is the answer everywhere", async (_label, pass) => {
    const run = buildHarness([pass]);

    const { messages } = await run.harness.run();

    expect(run.modelCalls()).toBe(1);
    expect(run.state.iterations).toBe(1);
    expect(executedNames()).toEqual(["react_to_discord_message"]);
    // Streaming callers: the chunk stream is the reply, and one `done` closes it.
    expect(run.chunkText()).toBe("get bent, pup");
    expect(run.events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(run.events.find((event) => event.type === "done")).toMatchObject({
      usage: expect.objectContaining({ inputTokens: 900 }),
    });
    // `?stream=false` callers (lupos-bot's JSON path) read finalText.
    expect(run.json()).toMatchObject({ finalText: "get bent, pup", text: "get bent, pup" });
    expect(run.json().toolCalls).toEqual([
      { name: "react_to_discord_message", args: { messageId: "123456789012345678", emoji: "🐺" } },
    ]);
    // Persisted once, as the turn's final assistant message, after the call.
    const assistants = appended.messages.filter((message) => message.role === "assistant");
    expect(assistants.map((message) => message.content)).toEqual(["", "get bent, pup"]);
    expect(finalAssistant()).toMatchObject({ content: "get bent, pup" });
    expect(run.state.conversationOutcome).toBe("completed");
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "get bent, pup" });
  });

  it("a reaction with no text ⇒ the loop goes on and the next pass answers", async () => {
    const run = buildHarness([[reactCall(), usage(900)], ["fine. here.", usage(950)]]);

    await run.harness.run();

    expect(run.modelCalls()).toBe(2);
    expect(executedNames()).toEqual(["react_to_discord_message"]);
    expect(run.json().finalText).toBe("fine. here.");
    expect(finalAssistant()).toMatchObject({ content: "fine. here." });
  });

  it("a reaction beside another tool ⇒ the loop goes on, the other result is read", async () => {
    const run = buildHarness([
      [
        "hold on, ",
        reactCall(),
        { type: "toolCall", id: "call-search", name: "search_discord_messages", args: { messageId: "1" } },
        usage(900),
      ],
      ["he said it twice, actually.", usage(950)],
    ]);

    await run.harness.run();

    expect(run.modelCalls()).toBe(2);
    expect(executedNames().sort()).toEqual(["react_to_discord_message", "search_discord_messages"]);
    expect(run.json().finalText).toBe("he said it twice, actually.");
    // The first pass's text stays where the model wrote it.
    expect(appended.messages.find((message) => message.role === "assistant")).toMatchObject({ content: "hold on, " });
  });

  it("input that arrives while the reaction runs ⇒ the turn stays open to answer it", async () => {
    const run = buildHarness([["get bent", reactCall(), usage(900)], ["and you too, rex", usage(950)]]);
    TurnInputMailbox.open(run.conversationId);
    executeToolBatchMock.mockImplementationOnce(async (toolCalls: Array<{ id: string; name: string }>) => {
      TurnInputMailbox.post(run.conversationId, { kind: "user_update", text: "rex agrees btw" });
      return toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result: { ok: true } }));
    });

    await run.harness.run();

    expect(run.modelCalls()).toBe(2);
    // The first reply stays in the history the second call sees.
    expect(run.seenInputs[1].some((message) => message.role === "assistant" && message.content === "get bent")).toBe(true);
  });

  it("a Stop hook that blocks ⇒ the reply goes back as the model's words and the turn continues", async () => {
    stopHook.verdict = { permissionDecision: "deny", reason: "cite a source" };
    const run = buildHarness([["get bent", reactCall(), usage(900)], ["source: trust me", usage(950)]]);

    await run.harness.run();

    expect(run.modelCalls()).toBe(2);
    const second = run.seenInputs[1];
    const replyIndex = second.findIndex((message) => message.role === "assistant" && message.content === "get bent");
    expect(replyIndex).toBeGreaterThan(-1);
    expect(String(second[replyIndex + 1]?.content)).toContain("cite a source");
  });

  it("an agent that names no fire-and-forget tools ⇒ unchanged: the loop reads the reaction's result", async () => {
    const run = buildHarness([["get bent", reactCall(), usage(900)], ["(second pass)", usage(950)]], { agent: "CODING" });

    await run.harness.run();

    expect(run.modelCalls()).toBe(2);
  });
});

describe("endsTurnWithReply — the predicate", () => {
  const fireAndForget = new Set(["react_to_discord_message"]);
  const calls = (...names: string[]) => names.map((name) => ({ name }));

  it("needs reply text, at least one call, every call listed and nothing rejected", () => {
    expect(endsTurnWithReply({ calls: calls("react_to_discord_message"), rejectedCount: 0, replyText: "hi", fireAndForget })).toBe(true);
    expect(endsTurnWithReply({ calls: calls("react_to_discord_message", "react_to_discord_message"), rejectedCount: 0, replyText: "hi", fireAndForget })).toBe(true);
    expect(endsTurnWithReply({ calls: calls("react_to_discord_message"), rejectedCount: 0, replyText: "  \n", fireAndForget })).toBe(false);
    expect(endsTurnWithReply({ calls: calls(), rejectedCount: 0, replyText: "hi", fireAndForget })).toBe(false);
    expect(endsTurnWithReply({ calls: calls("react_to_discord_message", "generate_image"), rejectedCount: 0, replyText: "hi", fireAndForget })).toBe(false);
    // A `tool_call` bridge call that could not be unwrapped is not fire-and-forget.
    expect(endsTurnWithReply({ calls: calls("react_to_discord_message"), rejectedCount: 1, replyText: "hi", fireAndForget })).toBe(false);
    expect(endsTurnWithReply({ calls: calls("react_to_discord_message"), rejectedCount: 0, replyText: "hi", fireAndForget: new Set() })).toBe(false);
  });
});

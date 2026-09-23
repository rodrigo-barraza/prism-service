/**
 * prefixStableRequests.test.ts
 *
 * The prefix invariant, through a REAL ReActHarness and each provider
 * adapter's REAL serialization (only the SDK / fetch is scripted):
 *
 *   request N+1 sends the same system prompt and the same tool block as
 *   request N, and its history starts with request N's history, byte for
 *   byte — the only exceptions are the requests the harness declares as
 *   compaction boundaries.
 *
 * "Byte for byte" is checked on what reaches the provider, flattened to the
 * unit the provider caches: content blocks for Anthropic (a message that
 * grows by a block after its last one is still a prefix), parts for Gemini,
 * input items for the Responses API, messages for Chat Completions.
 *
 * Scenarios (each once per adapter):
 *   - discovery enables a tool mid-loop, and the model calls it;
 *   - plan mode is entered, used for a read, and exited;
 *   - a tool returns a screenshot, then the loop goes on;
 *   - micro-compaction evicts old tool results under context pressure;
 *   - a per-turn system reminder is injected;
 *   - the history carries an empty assistant message, and one pass is empty;
 *   - the iteration limit forces the tool-free exhaustion pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY = "test-google-key";
  process.env.MOONSHOT_API_KEY = "test-moonshot-key";
  process.env.ANTHROPIC_FILES_API_ENABLED = "false";
});

import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import RequestLogger from "#src/services/RequestLogger";
import PromptCacheTelemetry from "#src/services/PromptCacheTelemetry";
import {
  _resetProviderDiagnosticsSupport,
  canonicalJson,
} from "#src/utils/PromptPrefixHashes";
import {
  registerToolCapabilities,
  resetToolCapabilities,
} from "#src/services/permissions/ToolCapabilities";
import SettingsService from "#src/services/SettingsService";
import anthropicProvider from "#src/providers/anthropic";
import openaiProvider from "#src/providers/openai";
import googleProvider from "#src/providers/google";
import moonshotProvider from "#src/providers/moonshot";
import { createVllmProvider } from "#src/providers/vllm";
import type { AgenticContext, ResolvedTools, ConversationMessage } from "../types.ts";

// ── Scripted provider SDKs ───────────────────────────────────

const captured = vi.hoisted(() => ({
  anthropic: [] as Array<Record<string, unknown>>,
  anthropicOptions: [] as Array<Record<string, unknown> | undefined>,
  openai: [] as Array<Record<string, unknown>>,
  google: [] as Array<Record<string, unknown>>,
  vllm: [] as Array<Record<string, unknown>>,
  moonshot: [] as Array<Record<string, unknown>>,
  scripts: {
    anthropic: [] as Array<() => AsyncGenerator<Record<string, unknown>>>,
    openai: [] as Array<() => AsyncGenerator<Record<string, unknown>>>,
    google: [] as Array<() => AsyncGenerator<Record<string, unknown>>>,
    vllm: [] as Array<() => Response>,
    moonshot: [] as Array<() => Response>,
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: (payload: Record<string, unknown>, requestOptions?: Record<string, unknown>) => {
        captured.anthropic.push(structuredClone(payload));
        captured.anthropicOptions.push(
          requestOptions ? { headers: requestOptions.headers } : undefined,
        );
        const next = captured.scripts.anthropic.shift();
        if (!next) throw new Error("anthropic script exhausted");
        const stream = next() as AsyncGenerator<Record<string, unknown>> & {
          abort: () => void;
          response: { headers: { get: () => null } };
          finalMessage: () => Promise<never>;
        };
        stream.abort = () => {};
        stream.response = { headers: { get: () => null } };
        stream.finalMessage = async () => {
          throw new Error("final message unavailable in test");
        };
        return stream;
      },
      create: vi.fn(),
    };
  },
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (payload: Record<string, unknown>) => {
        captured.openai.push(structuredClone(payload));
        const next = captured.scripts.openai.shift();
        if (!next) throw new Error("openai script exhausted");
        return {
          withResponse: async () => ({
            data: next(),
            response: { headers: { get: () => null } },
          }),
        };
      },
    };
    chat = { completions: { create: vi.fn() } };
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: async (request: Record<string, unknown>) => {
        captured.google.push(structuredClone(request));
        const next = captured.scripts.google.shift();
        if (!next) throw new Error("google script exhausted");
        return next();
      },
      generateContent: vi.fn(),
    };
  },
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
  MediaResolution: { LOW: "LOW", HIGH: "HIGH" },
  ServiceTier: { AUTO: "AUTO", STANDARD: "STANDARD" },
  FunctionCallingConfigMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE", VALIDATED: "VALIDATED" },
}));

vi.mock("#src/utils/ContextLengthDiscovery", () => ({
  discoverContextLength: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("#src/services/MediaResolutionService", () => ({
  resolveMessageMediaReferences: vi.fn(async (messages: unknown[]) => messages),
}));

// ── Harness dependencies ─────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn(), provider: vi.fn() },
}));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({}),
    getCached: vi.fn().mockReturnValue({}),
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
    approvalEngine: {},
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

const executedToolNames = vi.hoisted(() => [] as string[]);
const executeToolBatchMock = vi.hoisted(() => ({ fn: null as null | ((calls: Array<{ name: string; id: string; args: Record<string, unknown> }>, context: { agentConversationId?: string }) => unknown) }));
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (calls: Array<{ name: string; id: string; args: Record<string, unknown> }>, context: { agentConversationId?: string }) =>
    executeToolBatchMock.fn!(calls, context),
  executeToolSingle: vi.fn(),
}));
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: { adjustPendingBackgroundTasks: vi.fn().mockResolvedValue(undefined), appendMessages: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: {
    countRunningTasks: vi.fn().mockReturnValue(0),
    hasActiveTask: vi.fn().mockReturnValue(false),
    listTasks: vi.fn().mockReturnValue([]),
    markRunningAsCounted: vi.fn(),
  },
}));
vi.mock("#src/services/OrchestratorService", () => ({
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined), markUndeliveredDispatchesAsCounted: vi.fn().mockReturnValue(0) },
}));
vi.mock("../lifecycle/ApprovalGate.ts", () => ({
  checkAndWaitForApproval: vi.fn().mockImplementation(async (toolCalls: unknown[]) => ({
    executableToolCalls: toolCalls,
    blockedResults: [],
    deniedToolCalls: [],
    shouldApproveAll: false,
  })),
  orderResultsLikeCalls: (toolCalls: Array<{ id: string }>, results: Array<{ id: string }>) =>
    toolCalls.map((call) => results.find((result) => result.id === call.id)).filter(Boolean),
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
// Summarization never runs here: micro-compaction is the layer under test.
vi.mock("#src/services/compact/AutoCompactionTrigger", () => ({
  default: {
    evaluate: vi.fn().mockReturnValue({ shouldCompact: false, threshold: Number.MAX_SAFE_INTEGER }),
  },
}));
vi.mock("#src/services/compact/ToolResultOffloadService", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/services/compact/ToolResultOffloadService")>();
  return {
    ...original,
    default: {
      offloadToolResult: vi.fn((toolCall: { id?: string; name?: string }) =>
        `${original.OFFLOAD_STUB_HEADER}\noffload_id: off_${toolCall.id ?? toolCall.name}`,
      ),
    },
  };
});
vi.mock("#src/services/ConversationEmbeddingService", () => ({
  default: { persistCompactionSummary: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../lifecycle/KVCacheReporter.ts", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("../lifecycle/ToolDiscoveryNudge.ts", () => ({ injectToolDiscoveryNudge: vi.fn() }));
vi.mock("../lifecycle/CodexPlanningDetector.ts", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));
vi.mock("../lifecycle/SystemReminderExtractor.ts", () => ({
  extractReminderViaLLM: vi.fn().mockResolvedValue("Stay on task and cite the tool results."),
}));
vi.mock("../lifecycle/CostBudgetEnforcer.ts", () => ({ checkCostBudget: vi.fn().mockReturnValue(false), enforceCostBudget: vi.fn().mockResolvedValue(false), recordLoopSpend: vi.fn() }));
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({ buildToolRetryGuidance: vi.fn().mockReturnValue(null) }));

const toolContextStores = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock("#src/services/ToolContext", () => {
  const getStore = (conversationId: string) => {
    let store = toolContextStores.get(conversationId);
    if (!store) {
      store = new Map();
      toolContextStores.set(conversationId, store);
    }
    return store;
  };
  return {
    default: {
      getStore,
      get: (conversationId: string, key: string) => getStore(conversationId).get(key),
      set: (conversationId: string, key: string, value: unknown) => getStore(conversationId).set(key, value),
      delete: (conversationId: string, key: string) => getStore(conversationId).delete(key),
    },
  };
});

// ── The tool catalog ─────────────────────────────────────────

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const CATALOG = vi.hoisted(() => ({ tools: [] as Array<{ name: string; description: string; parameters: Record<string, unknown> }> }));
CATALOG.tools = [
  { name: "discover_and_enable_tools", description: "Search the tool catalog and enable matches.", parameters: objectSchema({ query: { type: "string", description: "Search keywords" } }) },
  { name: "enter_plan_mode", description: "Enter plan mode.", parameters: objectSchema({}) },
  { name: "exit_plan_mode", description: "Submit the plan.", parameters: objectSchema({ summary: { type: "string", description: "The plan" } }) },
  { name: "get_element", description: "Look up a chemical element in the periodic table.", parameters: objectSchema({ symbol: { type: "string", description: "Element symbol" } }, ["symbol"]) },
  { name: "convert_units", description: "Convert a value between units.", parameters: objectSchema({ value: { type: "number", description: "Value" }, from: { type: "string", description: "From unit" }, to: { type: "string", description: "To unit" } }, ["value", "from", "to"]) },
  { name: "search_web", description: "Search the web.", parameters: objectSchema({ query: { type: "string", description: "Query" } }, ["query"]) },
  { name: "take_screenshot", description: "Screenshot the browser.", parameters: objectSchema({}) },
  { name: "write_file", description: "Write a file.", parameters: objectSchema({ path: { type: "string", description: "Path" }, content: { type: "string", description: "Content" } }, ["path", "content"]) },
];
const schemaOf = (name: string) => {
  const schema = CATALOG.tools.find((tool) => tool.name === name);
  if (!schema) throw new Error(`no catalog schema ${name}`);
  return schema;
};

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn(() => CATALOG.tools),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getClientToolSchemas: vi.fn(() => CATALOG.tools),
    getToolLabel: vi.fn((name: string) => name),
    getToolEmoji: vi.fn().mockReturnValue(""),
    isStreamable: vi.fn().mockReturnValue(false),
    getWorkspaceRoot: vi.fn().mockReturnValue(null),
    getWorktreeState: vi.fn().mockReturnValue(null),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));
vi.mock("#src/services/FileService", () => ({ default: { upsertFile: vi.fn().mockResolvedValue(undefined) } }));

// ── Tool results ─────────────────────────────────────────────

const LARGE_RESULT_TEXT = "Result line with some searchable detail. ".repeat(260); // ~10.6K chars

function enableForConversation(conversationId: string, toolName: string) {
  const store = toolContextStores.get(conversationId) ?? new Map<string, unknown>();
  toolContextStores.set(conversationId, store);
  const current = (store.get("dynamicEnabledTools") as string[] | undefined) ?? [];
  store.set("dynamicEnabledTools", [...new Set([...current, toolName])]);
  store.set("toolSetDirty", true);
}

function runToolForTest(
  call: { name: string; id: string; args: Record<string, unknown> },
  conversationId: string,
): unknown {
  switch (call.name) {
    case "discover_and_enable_tools":
      enableForConversation(conversationId, "get_element");
      return { auto_enabled: ["get_element"], matches: [{ name: "get_element", isEnabled: true }] };
    case "get_element":
      return { symbol: call.args.symbol, name: "Iron", density: 7.874 };
    case "convert_units":
      return { value: 491.6 };
    case "take_screenshot":
      return { screenshotRef: `https://img.test/${call.id}.png` };
    case "search_web":
      return { query: call.args.query, results: `${call.id}: ${LARGE_RESULT_TEXT}` };
    case "enter_plan_mode":
      return { status: "entered" };
    case "exit_plan_mode":
      return { status: "submitted" };
    default:
      return { ok: true };
  }
}

// ── Script: provider-neutral model turns ─────────────────────

interface ScriptCall {
  name: string;
  args: Record<string, unknown>;
  /** Call a tool activated mid-loop — through the bridge where the adapter needs one. */
  discovered?: boolean;
}
type ScriptTurn =
  | { calls: ScriptCall[]; text?: string; thinking?: string }
  | { text: string; thinking?: string }
  | { empty: true };

/**
 * Input tokens each scripted response reports: the size of the request it
 * answers, capped per provider (a server that clears old tool results itself
 * reports the cleared size). No cap = no report, so the harness estimates.
 */
const reportedInputTokens = vi.hoisted(() => ({ capByProvider: {} as Record<string, number> }));
function inputTokensFor(provider: string): number {
  const cap = reportedInputTokens.capByProvider[provider];
  if (!cap) return 0;
  const sent = captured[provider as "anthropic" | "openai" | "google" | "vllm" | "moonshot"];
  const lastRequest = sent[sent.length - 1];
  return Math.min(cap, Math.ceil(JSON.stringify(lastRequest ?? {}).length / 4));
}

interface AdapterCase {
  id: string;
  provider: string;
  model: string;
  /** Tools activated mid-loop are reached through `tool_call` on this adapter. */
  bridged: boolean;
}

const ADAPTERS: AdapterCase[] = [
  { id: "anthropic (tool_addition)", provider: "anthropic", model: "claude-opus-5-5", bridged: false },
  { id: "anthropic (tool_reference)", provider: "anthropic", model: "claude-sonnet-5", bridged: false },
  { id: "openai (additional_tools)", provider: "openai", model: "gpt-6-astra", bridged: false },
  { id: "moonshot (system tools)", provider: "moonshot", model: "kimi-k3", bridged: false },
  { id: "google (bridge)", provider: "google", model: "gemini-3.6-flash", bridged: true },
  { id: "vllm (bridge)", provider: "vllm", model: "qwen-test", bridged: true },
];

function effectiveCalls(turn: { calls: ScriptCall[] }, adapter: AdapterCase): Array<{ name: string; args: Record<string, unknown> }> {
  return turn.calls.map((call) =>
    call.discovered && adapter.bridged
      ? { name: "tool_call", args: { name: call.name, args: call.args } }
      : { name: call.name, args: call.args },
  );
}

function anthropicTurn(turn: ScriptTurn, adapter: AdapterCase, turnIndex: number) {
  return async function* () {
    yield {
      type: "message_start",
      message: { id: `msg_${turnIndex}`, usage: { input_tokens: inputTokensFor("anthropic"), output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    };
    let blockIndex = 0;
    if ("empty" in turn) {
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } };
      return;
    }
    if (turn.thinking) {
      yield { type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "", signature: "" } };
      yield { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: turn.thinking } };
      yield { type: "content_block_delta", index: blockIndex, delta: { type: "signature_delta", signature: `sig_${turnIndex}` } };
      yield { type: "content_block_stop", index: blockIndex };
      blockIndex++;
    }
    if (turn.text) {
      yield { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: turn.text } };
      yield { type: "content_block_stop", index: blockIndex };
      blockIndex++;
    }
    const calls = "calls" in turn ? effectiveCalls(turn, adapter) : [];
    for (const [callIndex, call] of calls.entries()) {
      const id = `toolu_${turnIndex}_${callIndex}`;
      yield { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name: call.name, input: {} } };
      yield { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } };
      yield { type: "content_block_stop", index: blockIndex };
      blockIndex++;
    }
    yield { type: "message_delta", delta: { stop_reason: calls.length > 0 ? "tool_use" : "end_turn" }, usage: { output_tokens: 7 } };
  };
}

function openaiTurn(turn: ScriptTurn, adapter: AdapterCase, turnIndex: number) {
  return async function* () {
    const id = `resp_${turnIndex}`;
    yield { type: "response.created", response: { id } };
    if (!("empty" in turn)) {
      if (turn.text) yield { type: "response.output_text.delta", delta: turn.text };
      const calls = "calls" in turn ? effectiveCalls(turn, adapter) : [];
      for (const [callIndex, call] of calls.entries()) {
        const itemId = `fc_${turnIndex}_${callIndex}`;
        yield { type: "response.output_item.added", item: { type: "function_call", id: itemId, name: call.name, call_id: `call_${turnIndex}_${callIndex}` } };
        yield { type: "response.function_call_arguments.done", item_id: itemId, name: call.name, arguments: JSON.stringify(call.args) };
      }
    }
    yield { type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: inputTokensFor("openai"), output_tokens: 7, input_tokens_details: { cached_tokens: 0 } } } };
  };
}

function googleTurn(turn: ScriptTurn, adapter: AdapterCase, turnIndex: number) {
  return async function* () {
    const parts: Array<Record<string, unknown>> = [];
    if (!("empty" in turn)) {
      if (turn.text) parts.push({ text: turn.text });
      const calls = "calls" in turn ? effectiveCalls(turn, adapter) : [];
      for (const call of calls) parts.push({ functionCall: { name: call.name, args: call.args } });
    }
    yield {
      responseId: `g_${turnIndex}`,
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: inputTokensFor("google"), candidatesTokenCount: 7 },
    };
  };
}

function chatCompletionsTurn(turn: ScriptTurn, adapter: AdapterCase, turnIndex: number) {
  return () => {
    const events: Array<Record<string, unknown>> = [];
    const id = `cmpl_${turnIndex}`;
    if ("empty" in turn) {
      events.push({ id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else {
      if (turn.text) events.push({ id, choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] });
      const calls = "calls" in turn ? effectiveCalls(turn, adapter) : [];
      if (calls.length > 0) {
        events.push({
          id,
          choices: [{
            index: 0,
            delta: {
              tool_calls: calls.map((call, callIndex) => ({
                index: callIndex,
                id: `call_${turnIndex}_${callIndex}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
            finish_reason: "tool_calls",
          }],
        });
      } else {
        events.push({ id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
    }
    events.push({ id, choices: [], usage: { prompt_tokens: inputTokensFor(adapter.provider), completion_tokens: 7 } });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

function queueScript(adapter: AdapterCase, script: ScriptTurn[]) {
  script.forEach((turn, turnIndex) => {
    switch (adapter.provider) {
      case "anthropic":
        captured.scripts.anthropic.push(anthropicTurn(turn, adapter, turnIndex));
        break;
      case "openai":
        captured.scripts.openai.push(openaiTurn(turn, adapter, turnIndex));
        break;
      case "google":
        captured.scripts.google.push(googleTurn(turn, adapter, turnIndex));
        break;
      case "vllm":
        captured.scripts.vllm.push(chatCompletionsTurn(turn, adapter, turnIndex));
        break;
      case "moonshot":
        captured.scripts.moonshot.push(chatCompletionsTurn(turn, adapter, turnIndex));
        break;
    }
  });
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
function installFetch() {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://img.test/")) {
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    }
    const key = url.includes("vllm.test") ? "vllm" : url.includes("moonshot") ? "moonshot" : null;
    if (!key) throw new Error(`unexpected fetch ${url}`);
    captured[key].push(JSON.parse(String(init?.body ?? "{}")));
    const next = captured.scripts[key].shift();
    if (!next) throw new Error(`${key} script exhausted`);
    return next();
  });
}

// ── What reached the provider, flattened to its cache unit ───

interface SentRequest {
  system: string;
  tools: string;
  items: string[];
}

function asBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function flattenAnthropic(payload: Record<string, unknown>): SentRequest {
  const messages = (payload.messages as Array<Record<string, unknown>>) ?? [];
  return {
    system: canonicalJson(asBlocks(payload.system)),
    tools: canonicalJson(payload.tools ?? null),
    items: messages.flatMap((message) => {
      const { content, ...messageFields } = message;
      return asBlocks(content).map((block) => canonicalJson({ ...messageFields, block }));
    }),
  };
}

function splitLeadingSystem(list: Array<Record<string, unknown>>, roleKey = "role") {
  let count = 0;
  while (count < list.length && ["system", "developer"].includes(String(list[count]?.[roleKey])) && list[count]?.type !== "additional_tools") count++;
  return { leading: list.slice(0, count), rest: list.slice(count) };
}

function flattenOpenAI(payload: Record<string, unknown>): SentRequest {
  const { leading, rest } = splitLeadingSystem((payload.input as Array<Record<string, unknown>>) ?? []);
  return {
    system: canonicalJson([payload.instructions ?? null, leading]),
    tools: canonicalJson(payload.tools ?? null),
    items: rest.map((item) => canonicalJson(item)),
  };
}

function flattenGoogle(request: Record<string, unknown>): SentRequest {
  const config = (request.config as Record<string, unknown>) ?? {};
  const contents = (request.contents as Array<{ role: string; parts: unknown[] }>) ?? [];
  return {
    system: canonicalJson(config.systemInstruction ?? null),
    tools: canonicalJson(config.tools ?? null),
    items: contents.flatMap((content) => content.parts.map((part) => canonicalJson({ role: content.role, part }))),
  };
}

function flattenChat(payload: Record<string, unknown>): SentRequest {
  const { leading, rest } = splitLeadingSystem((payload.messages as Array<Record<string, unknown>>) ?? []);
  return {
    system: canonicalJson(leading),
    tools: canonicalJson(payload.tools ?? null),
    items: rest.map((message) => canonicalJson(message)),
  };
}

function sentRequests(adapter: AdapterCase): SentRequest[] {
  switch (adapter.provider) {
    case "anthropic":
      return captured.anthropic.map(flattenAnthropic);
    case "openai":
      return captured.openai.map(flattenOpenAI);
    case "google":
      return captured.google.map(flattenGoogle);
    case "vllm":
      return captured.vllm.map(flattenChat);
    case "moonshot":
      return captured.moonshot.map(flattenChat);
    default:
      throw new Error(adapter.provider);
  }
}

/** The logged `agent:iteration` rows, in iteration order. */
async function loggedRows() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const completePending = RequestLogger.completePending as unknown as ReturnType<typeof vi.fn>;
  return completePending.mock.calls.map((call) => call[1] as Record<string, any>);
}

/**
 * The invariant. `declaredBoundaries` holds request indices (0-based) the
 * harness declared as compaction boundaries — the one place a request may
 * rewrite what the previous one sent.
 */
function expectPrefixStable(requests: SentRequest[], declaredBoundaries: ReadonlySet<number> = new Set()) {
  for (let index = 1; index < requests.length; index++) {
    if (declaredBoundaries.has(index)) continue;
    const previous = requests[index - 1];
    const next = requests[index];
    expect(next.system, `request ${index + 1} changed the system prompt`).toBe(previous.system);
    expect(next.tools, `request ${index + 1} changed the tool block`).toBe(previous.tools);
    const firstRewritten = previous.items.findIndex((item, itemIndex) => next.items[itemIndex] !== item);
    expect(
      firstRewritten,
      `request ${index + 1} rewrote history item ${firstRewritten}:\n  was: ${previous.items[firstRewritten]}\n  now: ${next.items[firstRewritten]}`,
    ).toBe(-1);
  }
}

async function declaredBoundaryIndices(): Promise<Set<number>> {
  const rows = await loggedRows();
  const indices = new Set<number>();
  rows.forEach((row, index) => {
    if (row.cacheTelemetry?.declaredBoundary) indices.add(index);
  });
  return indices;
}

// ── Mechanism probes on the raw payloads ────────────────────

function rawRequests(adapter: AdapterCase): Array<Record<string, unknown>> {
  return captured[adapter.provider as "anthropic" | "openai" | "google" | "vllm" | "moonshot"];
}

/** Every value in a payload, flattened — for "does this block appear anywhere". */
function allValues(value: unknown, into: unknown[] = []): unknown[] {
  into.push(value);
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) allValues(entry, into);
  }
  return into;
}
const findObjects = (payload: unknown, predicate: (entry: Record<string, unknown>) => boolean) =>
  allValues(payload).filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry) && predicate(entry as Record<string, unknown>),
  );

/** How the discovered tool reached the model — asserted per adapter. */
function expectActivationDelivered(adapter: AdapterCase, payload: Record<string, unknown>) {
  const payloadText = JSON.stringify(payload);
  switch (adapter.id) {
    case "anthropic (tool_addition)": {
      const tools = payload.tools as Array<Record<string, unknown>>;
      expect(tools.find((tool) => tool.name === "get_element")?.defer_loading).toBe(true);
      const systemMessages = (payload.messages as Array<Record<string, unknown>>).filter((message) => message.role === "system");
      expect(findObjects(systemMessages, (entry) => entry.type === "tool_addition").map((entry) => (entry.tool as { name: string }).name)).toEqual(["get_element"]);
      break;
    }
    case "anthropic (tool_reference)": {
      const tools = payload.tools as Array<Record<string, unknown>>;
      expect(tools.find((tool) => tool.name === "get_element")?.defer_loading).toBe(true);
      const toolResults = findObjects(payload.messages, (entry) => entry.type === "tool_result");
      const referencing = toolResults.filter((result) => Array.isArray(result.content) && (result.content as Array<{ type: string }>).every((block) => block.type === "tool_reference"));
      expect(referencing).toHaveLength(1);
      expect(referencing[0].content).toEqual([{ type: "tool_reference", tool_name: "get_element" }]);
      break;
    }
    case "openai (additional_tools)":
      expect(findObjects(payload.input, (entry) => entry.type === "additional_tools").flatMap((entry) => (entry.tools as Array<{ name: string }>).map((tool) => tool.name))).toEqual(["get_element"]);
      break;
    case "moonshot (system tools)": {
      const toolMessages = (payload.messages as Array<Record<string, unknown>>).filter((message) => message.role === "system" && Array.isArray(message.tools));
      expect(toolMessages).toHaveLength(1);
      expect("content" in toolMessages[0]).toBe(false);
      expect((toolMessages[0].tools as Array<{ function: { name: string } }>)[0].function.name).toBe("get_element");
      break;
    }
    default:
      // The bridge: a fixed tool_call declaration, and the schema in the update text.
      expect(payloadText).toContain('"tool_call"');
      expect(payloadText).toContain("Call these through `tool_call`");
  }
}

function expectToolChoiceNone(adapter: AdapterCase, payload: Record<string, unknown>) {
  switch (adapter.provider) {
    case "anthropic":
      expect(payload.tool_choice).toEqual({ type: "none" });
      break;
    case "google":
      expect((payload.config as Record<string, unknown>).toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
      break;
    default:
      expect(payload.tool_choice).toBe("none");
  }
}

// ── Loop factory ─────────────────────────────────────────────

function providerFor(adapter: AdapterCase) {
  switch (adapter.provider) {
    case "anthropic":
      return anthropicProvider;
    case "openai":
      return openaiProvider;
    case "google":
      return googleProvider;
    case "moonshot":
      return moonshotProvider;
    case "vllm":
      return createVllmProvider("http://vllm.test", "vllm");
    default:
      throw new Error(adapter.provider);
  }
}

interface LoopSetup {
  toolNames: string[];
  discoverable?: string[];
  messages?: ConversationMessage[];
  options?: Record<string, unknown>;
  maxInputTokens?: number;
}

function buildLoop(adapter: AdapterCase, conversationId: string, setup: LoopSetup) {
  const context: AgenticContext = {
    project: "prism-test",
    username: "test-user",
    agent: "OMNI",
    providerName: adapter.provider,
    resolvedModel: adapter.model,
    modelDefinition: { maxInputTokens: setup.maxInputTokens ?? 128000, maxOutputTokens: 8192 } as any,
    traceId: "trace-prefix-stable",
    agentConversationId: conversationId,
    conversationId,
    provider: providerFor(adapter) as any,
    options: {
      maxIterations: 12,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 4096,
      locale: "en",
      ...setup.options,
    },
    messages: setup.messages ?? [{ role: "user", content: "Look up iron with the periodic table tool." }],
    emit: vi.fn(),
    signal: undefined as any,
    requestId: `req-${conversationId}`,
    requestStart: performance.now(),
    isNewConversation: true,
  } as any;
  const state = new AgenticLoopState({
    originalMessageCount: (setup.messages ?? [1]).length,
    planModeActive: setup.options?.planFirst === true,
  } as any);
  const tools: ResolvedTools = {
    finalTools: setup.toolNames.map(schemaOf) as any,
    resolvedEnabledTools: setup.toolNames,
    ...(setup.discoverable && { discoverableTools: setup.discoverable.map(schemaOf) as any }),
  } as ResolvedTools;
  const harness = new ReActHarness(context, state, tools);
  (harness as any).finalize = vi.fn().mockResolvedValue(undefined);
  return { harness, state, context };
}

// ── Scenarios ────────────────────────────────────────────────

interface Scenario {
  name: string;
  setup: LoopSetup;
  script: ScriptTurn[];
  reportedInputTokens?: Record<string, number>;
  /** Proof the scenario really happened (a vacuous run would pass the invariant). */
  verify: (adapter: AdapterCase, requests: SentRequest[], state: AgenticLoopState) => void | Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "discovery enables a tool mid-loop",
    setup: {
      toolNames: ["discover_and_enable_tools", "search_web"],
      discoverable: ["get_element", "convert_units"],
    },
    script: [
      { calls: [{ name: "discover_and_enable_tools", args: { query: "periodic table" } }] },
      { calls: [{ name: "get_element", args: { symbol: "Fe" }, discovered: true }] },
      { text: "Iron is 7.874 g/cm3." },
    ],
    verify: (adapter, requests) => {
      expect(executedToolNames).toEqual(["discover_and_enable_tools", "get_element"]);
      expect(requests).toHaveLength(3);
      expectActivationDelivered(adapter, rawRequests(adapter)[1]);
    },
  },
  {
    name: "plan mode entered, used for a read, and exited",
    setup: { toolNames: ["enter_plan_mode", "exit_plan_mode", "get_element", "write_file"] },
    script: [
      { calls: [{ name: "enter_plan_mode", args: {} }] },
      { calls: [{ name: "get_element", args: { symbol: "Fe" } }] },
      { text: "1. Write the density to a file.", calls: [{ name: "exit_plan_mode", args: { summary: "1. Write the density to a file." } }] },
      { text: "Done planning; the plan was approved." },
    ],
    verify: (_adapter, requests, state) => {
      expect(executedToolNames).toEqual(["enter_plan_mode", "get_element", "exit_plan_mode"]);
      expect(state.planModeActive).toBe(false);
      expect(requests).toHaveLength(4);
      expect(requests[1].items.some((item) => item.includes("harness.planningMode.planModeOn"))).toBe(true);
      expect(requests[3].items.some((item) => item.includes("harness.planningMode.planModeOff"))).toBe(true);
    },
  },
  {
    name: "a tool returns a screenshot, then the loop goes on",
    setup: { toolNames: ["take_screenshot", "get_element"] },
    script: [
      { calls: [{ name: "take_screenshot", args: {} }] },
      { calls: [{ name: "get_element", args: { symbol: "Fe" } }] },
      { text: "The page shows iron." },
    ],
    verify: (_adapter, requests) => {
      expect(executedToolNames).toEqual(["take_screenshot", "get_element"]);
      const screenshotItems = (request: SentRequest) =>
        request.items.filter((item) => item.includes("img.test") || item.includes("iVBORw0KGgo") || item.includes("inlineData")).length;
      expect(screenshotItems(requests[1]), "the screenshot reaches the next request").toBeGreaterThan(0);
      expect(screenshotItems(requests[2]), "…and stays in the one after").toBeGreaterThan(0);
    },
  },
  {
    name: "micro-compaction under context pressure",
    setup: {
      toolNames: ["search_web"],
      maxInputTokens: 30000,
    },
    // Anthropic clears old tool results server-side, so its reported input
    // stays at the cleared size; the others report nothing and the harness
    // measures the growing history itself.
    reportedInputTokens: { anthropic: 9000 },
    script: [
      ...Array.from({ length: 10 }, (_, index) => ({ calls: [{ name: "search_web", args: { query: `query ${index}` } }] }) as ScriptTurn),
      { text: "Summary of the searches." },
    ],
    verify: async (adapter, requests) => {
      expect(requests).toHaveLength(11);
      const boundaries = await declaredBoundaryIndices();
      if (adapter.provider === "anthropic") {
        // Anthropic clears old tool results server-side — the client never stubs.
        expect(boundaries.size).toBe(0);
        const lastPayload = captured.anthropic[captured.anthropic.length - 1];
        expect(lastPayload.context_management).toBeDefined();
      } else {
        // Evicted at a deliberate boundary (then stable), never per iteration.
        expect(boundaries.size).toBeGreaterThanOrEqual(1);
        expect(boundaries.size).toBeLessThanOrEqual(2);
      }
    },
  },
  {
    name: "a per-turn system reminder is injected",
    setup: {
      toolNames: ["get_element"],
      options: { reminderModel: "reminder-model", reminderInterval: 2 },
      messages: [
        { role: "system", content: `<system-context>${"Always answer with sources. ".repeat(12)}</system-context>` },
        { role: "user", content: "Look up seven elements." },
      ],
    },
    script: [
      ...["Fe", "Cu", "Ag", "Au", "Pt", "Pb", "Zn"].map((symbol) => ({ calls: [{ name: "get_element", args: { symbol } }] }) as ScriptTurn),
      { text: "Seven elements looked up." },
    ],
    verify: (adapter, requests) => {
      expect(requests).toHaveLength(8);
      expect(requests[5].items.some((item) => item.includes("harness.systemReminder"))).toBe(true);
      if (adapter.id === "anthropic (tool_addition)") {
        // Turn-scoped: stays in the transcript, renders for one turn only.
        const reminders = findObjects(rawRequests(adapter)[7].messages, (entry) => entry.role === "system" && JSON.stringify(entry).includes("harness.systemReminder"));
        expect(reminders.length).toBeGreaterThan(0);
        expect(reminders.every((message) => message.clear_at === "next_user_message")).toBe(true);
      }
    },
  },
  {
    name: "an empty assistant message in history, and an empty pass",
    setup: {
      toolNames: ["get_element"],
      messages: [
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "" },
        { role: "user", content: "Look up iron." },
      ],
    },
    script: [
      { calls: [{ name: "get_element", args: { symbol: "Fe" } }] },
      { empty: true },
      { text: "Iron is 7.874 g/cm3." },
    ],
    verify: (_adapter, requests) => {
      expect(executedToolNames).toEqual(["get_element"]);
      expect(requests).toHaveLength(3);
    },
  },
  {
    name: "the iteration limit forces the exhaustion pass",
    setup: { toolNames: ["get_element", "convert_units"], options: { maxIterations: 2 } },
    script: [
      { calls: [{ name: "get_element", args: { symbol: "Fe" } }] },
      { calls: [{ name: "convert_units", args: { value: 7.874, from: "g/cm3", to: "lb/ft3" } }] },
      { text: "Iron: 7.874 g/cm3, 491.6 lb/ft3." },
    ],
    verify: (adapter, requests) => {
      expect(executedToolNames).toEqual(["get_element", "convert_units"]);
      expect(requests).toHaveLength(3);
      expectToolChoiceNone(adapter, rawRequests(adapter)[2]);
    },
  },
];

describe("prefix-stable requests — scripted loops through every adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    PromptCacheTelemetry._clear();
    _resetProviderDiagnosticsSupport();
    resetToolCapabilities();
    registerToolCapabilities(
      [
        { name: "get_element", capabilities: ["network"] },
        { name: "convert_units", capabilities: [] },
        { name: "search_web", capabilities: ["network"] },
        { name: "take_screenshot", capabilities: ["network"] },
        { name: "discover_and_enable_tools", capabilities: [] },
        { name: "enter_plan_mode", capabilities: [] },
        { name: "exit_plan_mode", capabilities: [] },
      ],
      "test",
    );
    for (const key of ["anthropic", "anthropicOptions", "openai", "google", "vllm", "moonshot"] as const) {
      captured[key].length = 0;
    }
    for (const key of Object.keys(captured.scripts) as Array<keyof typeof captured.scripts>) {
      captured.scripts[key].length = 0;
    }
    toolContextStores.clear();
    executedToolNames.length = 0;
    executeToolBatchMock.fn = async (calls, context) =>
      calls.map((call) => {
        executedToolNames.push(call.name);
        return {
          name: call.name,
          id: call.id,
          result: runToolForTest(call, context.agentConversationId ?? ""),
          durationMilliseconds: 3,
        };
      });
    installFetch();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      for (const adapter of ADAPTERS) {
        it(adapter.id, async () => {
          reportedInputTokens.capByProvider = scenario.reportedInputTokens ?? {};
          queueScript(adapter, scenario.script);
          const conversationId = `conv-${adapter.provider}-${scenario.name.replace(/\W+/g, "-")}`;
          const { harness, state } = buildLoop(adapter, conversationId, scenario.setup);
          await harness.run();
          const requests = sentRequests(adapter);
          expectPrefixStable(requests, await declaredBoundaryIndices());
          await scenario.verify(adapter, requests, state);
        });
      }
    });
  }
});

describe("Claude preserved thinking — binding mismatches are errors, and none happen", () => {
  const adapter = ADAPTERS[0]; // claude-opus-5-5: preserved thinking, tool_addition

  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    PromptCacheTelemetry._clear();
    _resetProviderDiagnosticsSupport();
    captured.anthropic.length = 0;
    captured.anthropicOptions.length = 0;
    captured.scripts.anthropic.length = 0;
    toolContextStores.clear();
    executedToolNames.length = 0;
    reportedInputTokens.capByProvider = {};
    executeToolBatchMock.fn = async (calls, context) =>
      calls.map((call) => {
        executedToolNames.push(call.name);
        return { name: call.name, id: call.id, result: runToolForTest(call, context.agentConversationId ?? ""), durationMilliseconds: 3 };
      });
    // Tests and CI run with mismatches as errors; production keeps drop_block.
    (SettingsService.getCached as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      anthropic: { thinkingBlockBinding: "error" },
    });
  });

  afterEach(() => {
    (SettingsService.getCached as unknown as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it("replays every thinking block verbatim, in order, across a mid-loop tool activation", async () => {
    queueScript(adapter, [
      { thinking: "I need a periodic-table tool first.", calls: [{ name: "discover_and_enable_tools", args: { query: "periodic table" } }] },
      { thinking: "get_element is loaded now; look up iron.", calls: [{ name: "get_element", args: { symbol: "Fe" }, discovered: true }] },
      { thinking: "I have the density.", text: "Iron is 7.874 g/cm3." },
    ]);
    const { harness } = buildLoop(adapter, "conv-binding-error", {
      toolNames: ["discover_and_enable_tools", "search_web"],
      discoverable: ["get_element", "convert_units"],
    });
    await harness.run();

    expect(executedToolNames).toEqual(["discover_and_enable_tools", "get_element"]);
    const payloads = captured.anthropic;
    expect(payloads).toHaveLength(3);

    // Every request opts into enforcement with "error" (and the beta header).
    for (const [index, payload] of payloads.entries()) {
      expect((payload.thinking as { block_binding?: unknown }).block_binding).toEqual({ prefix_mismatch_behavior: "error" });
      const headers = (captured.anthropicOptions[index]?.headers ?? {}) as Record<string, string>;
      expect(headers["anthropic-beta"]).toContain("thinking-binding-controls-2026-08-01");
    }

    // The prefix every block was produced under is intact on every request.
    expectPrefixStable(payloads.map(flattenAnthropic), new Set());
    expect(payloads[1].tools).toEqual(payloads[0].tools);
    expect(payloads[2].tools).toEqual(payloads[0].tools);

    const messagesOf = (index: number) => payloads[index].messages as Array<{ role: string; content: unknown; clear_at?: string }>;
    const blocksOf = (message: { content: unknown }) =>
      (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content) as Array<Record<string, unknown>>;

    // Request 2: question → assistant(thinking, tool_use) → tool result → tool_addition.
    const second = messagesOf(1);
    expect(second.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
    expect(blocksOf(second[1])[0]).toEqual({ type: "thinking", thinking: "I need a periodic-table tool first.", signature: "sig_0" });
    expect(blocksOf(second[1])[1]).toMatchObject({ type: "tool_use", name: "discover_and_enable_tools" });
    expect(blocksOf(second[3]).map((block) => block.type)).toEqual(["text", "tool_addition"]);

    // Request 3: the activation stays where it was sent (checked byte for
    // byte above), and the second turn's thinking follows it, verbatim.
    const third = messagesOf(2);
    expect(third.map((message) => message.role)).toEqual(["user", "assistant", "user", "system", "assistant", "user"]);
    expect(blocksOf(third[4])[0]).toEqual({ type: "thinking", thinking: "get_element is loaded now; look up iron.", signature: "sig_1" });
    expect(blocksOf(third[4])[1]).toMatchObject({ type: "tool_use", name: "get_element", input: { symbol: "Fe" } });
  });
});

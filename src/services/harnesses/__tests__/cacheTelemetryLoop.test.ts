/**
 * cacheTelemetryLoop.test.ts
 *
 * Prompt-cache telemetry through a REAL ReActHarness and each provider
 * adapter's REAL serialization (only the SDK / fetch is scripted):
 *
 *   iteration 1 → the model calls a tool
 *   iteration 2 → the model answers
 *
 * Every `agent:iteration` row must carry the hashes of what the adapter
 * sent (`prefixHashes`), and — because the harness only appended between
 * the two requests — iteration 2's `firstDivergenceIndex` must equal
 * iteration 1's message count, with system and tool hashes unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY = "test-google-key";
  process.env.ANTHROPIC_FILES_API_ENABLED = "false";
});

import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import RequestLogger from "#src/services/RequestLogger";
import anthropicProvider from "#src/providers/anthropic";
import openaiProvider from "#src/providers/openai";
import googleProvider from "#src/providers/google";
import { createVllmProvider } from "#src/providers/vllm";
import type { AgenticContext, ResolvedTools } from "../types.ts";

// ── Scripted provider SDKs ───────────────────────────────────

const anthropicStreamCalls: Array<Record<string, unknown>> = [];
const anthropicScript: Array<() => AsyncGenerator<Record<string, unknown>>> = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: (payload: Record<string, unknown>) => {
        anthropicStreamCalls.push(structuredClone(payload));
        const next = anthropicScript.shift();
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

const openaiResponsesCalls: Array<Record<string, unknown>> = [];
const openaiScript: Array<() => AsyncGenerator<Record<string, unknown>>> = [];
vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (payload: Record<string, unknown>) => {
        openaiResponsesCalls.push(structuredClone(payload));
        const next = openaiScript.shift();
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

const googleStreamCalls: Array<Record<string, unknown>> = [];
const googleScript: Array<() => AsyncGenerator<Record<string, unknown>>> = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: async (request: Record<string, unknown>) => {
        googleStreamCalls.push(structuredClone(request));
        const next = googleScript.shift();
        if (!next) throw new Error("google script exhausted");
        return next();
      },
      generateContent: vi.fn(),
    };
  },
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
  MediaResolution: { LOW: "LOW", HIGH: "HIGH" },
  ServiceTier: { AUTO: "AUTO", STANDARD: "STANDARD" },
}));

vi.mock("#src/utils/ContextLengthDiscovery", () => ({
  discoverContextLength: vi.fn().mockResolvedValue(undefined),
}));

// Text-only messages: media resolution is a pass-through.
vi.mock("#src/services/MediaResolutionService", () => ({
  resolveMessageMediaReferences: vi.fn(async (messages: unknown[]) => messages),
}));

// ── Harness dependencies (as turnInputAcceptance.test.ts, minus the
//    provider-stream / logging overrides — those run for real here) ──

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn(), provider: vi.fn() },
}));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: { getDefaultLocale: () => "en", get: (_locale: string, key: string) => `[locale:${key}]` },
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
const executeToolBatchMock = vi.fn();
vi.mock("../lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: (...args: unknown[]) => executeToolBatchMock(...args),
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
  default: { awaitPendingDispatches: vi.fn().mockResolvedValue(undefined) },
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
vi.mock("../lifecycle/ContextPressureManager.ts", () => ({
  manageContextPressure: vi.fn().mockImplementation(async (messages: unknown[]) => ({ messages, compactionPerformed: false })),
}));
vi.mock("../lifecycle/KVCacheReporter.ts", () => ({ logKVCacheHitRate: vi.fn() }));
vi.mock("../lifecycle/ToolDiscoveryNudge.ts", () => ({ injectToolDiscoveryNudge: vi.fn() }));
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
vi.mock("../lifecycle/ToolRetryInterceptor.ts", () => ({ buildToolRetryGuidance: vi.fn().mockReturnValue(null) }));
vi.mock("#src/services/ToolContext", () => ({ default: { getStore: vi.fn().mockReturnValue(new Map()) } }));
vi.mock("#src/services/FileService", () => ({ default: { upsertFile: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
    getToolLabel: vi.fn((name: string) => name),
    getToolEmoji: vi.fn().mockReturnValue(""),
    isStreamable: vi.fn().mockReturnValue(false),
    getWorkspaceRoot: vi.fn().mockReturnValue(null),
    getWorktreeState: vi.fn().mockReturnValue(null),
  },
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

// ── Scripts: iteration 1 calls search_web, iteration 2 answers ──

const TOOL_ARGUMENTS = '{"query":"cache"}';

function anthropicToolCallTurn(messageId: string) {
  return async function* () {
    yield { type: "message_start", message: { id: messageId, usage: { input_tokens: 90, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "search_web", input: {} } };
    yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: TOOL_ARGUMENTS } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } };
  };
}
function anthropicTextTurn(messageId: string) {
  return async function* () {
    yield { type: "message_start", message: { id: messageId, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } } };
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All done." } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } };
  };
}

function openaiToolCallTurn(responseId: string) {
  return async function* () {
    yield { type: "response.created", response: { id: responseId } };
    yield { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", name: "search_web", call_id: "call_1" } };
    yield { type: "response.function_call_arguments.done", item_id: "fc_1", name: "search_web", arguments: TOOL_ARGUMENTS };
    yield { type: "response.completed", response: { id: responseId, status: "completed", output: [], usage: { input_tokens: 90, output_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } };
  };
}
function openaiTextTurn(responseId: string) {
  return async function* () {
    yield { type: "response.created", response: { id: responseId } };
    yield { type: "response.output_text.delta", delta: "All done." };
    yield { type: "response.completed", response: { id: responseId, status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 4, input_tokens_details: { cached_tokens: 90 } } } };
  };
}

function googleToolCallTurn(responseId: string) {
  return async function* () {
    yield {
      responseId,
      candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "search_web", args: { query: "cache" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12 },
    };
  };
}
function googleTextTurn(responseId: string) {
  return async function* () {
    yield {
      responseId,
      candidates: [{ content: { role: "model", parts: [{ text: "All done." }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 4, cachedContentTokenCount: 90 },
    };
  };
}

function sseResponse(events: Array<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function vllmToolCallTurn() {
  return sseResponse([
    { id: "cmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_web", arguments: TOOL_ARGUMENTS } }] }, finish_reason: "tool_calls" }] },
    { id: "cmpl-1", choices: [], usage: { prompt_tokens: 90, completion_tokens: 12 } },
  ]);
}
function vllmTextTurn() {
  return sseResponse([
    { id: "cmpl-2", choices: [{ index: 0, delta: { content: "All done." }, finish_reason: "stop" }] },
    { id: "cmpl-2", choices: [], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 90 } } },
  ]);
}

// ── Loop factory ─────────────────────────────────────────────

function buildLoop(providerName: string, model: string, provider: unknown, conversationId: string) {
  const context: AgenticContext = {
    project: "prism-test",
    username: "test-user",
    agent: "OMNI",
    providerName,
    resolvedModel: model,
    modelDefinition: { maxInputTokens: 128000, maxOutputTokens: 8192 } as any,
    traceId: "trace-cache-telemetry",
    agentConversationId: conversationId,
    conversationId,
    provider: provider as any,
    options: { maxIterations: 4, autoApprove: true, agenticLoopEnabled: true, maxTokens: 4096 },
    messages: [{ role: "user", content: "Find what the cache telemetry says." }],
    emit: vi.fn(),
    signal: undefined as any,
    requestId: `req-${conversationId}`,
    requestStart: performance.now(),
    isNewConversation: true,
  } as any;
  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [
      {
        name: "search_web",
        description: "Search the web",
        parameters: { type: "object", properties: { query: { type: "string", description: "Query" } }, required: ["query"] },
      },
    ] as any,
    resolvedEnabledTools: ["search_web"],
  };
  const harness = new ReActHarness(context, state, tools);
  // Turn persistence is not under test; the rows are written before it.
  (harness as any).finalize = vi.fn().mockResolvedValue(undefined);
  return harness;
}

/** The LogParams each iteration's row was completed with. */
async function loggedIterationRows() {
  const completePending = RequestLogger.completePending as unknown as ReturnType<typeof vi.fn>;
  // logIteration writes fire-and-forget; let the promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return completePending.mock.calls.map((call) => call[1] as Record<string, any>);
}

function expectAppendOnlyTelemetry(rows: Array<Record<string, any>>) {
  expect(rows).toHaveLength(2);
  const [first, second] = rows;

  expect(first.prefixHashes, "iteration 1 row carries the hashes of what was sent").toBeDefined();
  expect(first.prefixHashes.system).toMatch(/^[0-9a-f]{64}$/);
  expect(first.prefixHashes.tools).toMatch(/^[0-9a-f]{64}$/);
  expect(first.prefixHashes.messages.length).toBeGreaterThan(0);
  expect(first.firstDivergenceIndex).toBeNull();
  expect(first.cacheTelemetry.prefixChange).toBe("no_previous_request");

  const previousCount = first.prefixHashes.messages.length;
  expect(second.prefixHashes.messages.length).toBeGreaterThan(previousCount);
  expect(second.prefixHashes.messages.slice(0, previousCount)).toEqual(first.prefixHashes.messages);
  expect(second.prefixHashes.system).toBe(first.prefixHashes.system);
  expect(second.prefixHashes.tools).toBe(first.prefixHashes.tools);
  expect(second.firstDivergenceIndex, "append-only history diverges exactly at the previous message count").toBe(previousCount);
  expect(second.cacheTelemetry.prefixChange).toBe("append_only");
  expect(second.cacheTelemetry.comparedRequestId).toBe(first.requestId);
}

// ── Scenarios ────────────────────────────────────────────────

describe("cache telemetry — a two-iteration loop through each provider adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TurnInputMailbox._clearAll();
    anthropicStreamCalls.length = 0;
    openaiResponsesCalls.length = 0;
    googleStreamCalls.length = 0;
    executeToolBatchMock.mockImplementation(async (toolCalls: Array<{ name: string; id: string }>) =>
      toolCalls.map((toolCall) => ({ name: toolCall.name, id: toolCall.id, result: { hits: 3 }, durationMilliseconds: 5 })),
    );
  });

  it("Anthropic: rows carry hashes and the append-only divergence index", async () => {
    anthropicScript.push(anthropicToolCallTurn("msg_1"), anthropicTextTurn("msg_2"));
    await buildLoop("anthropic", "claude-sonnet-5", anthropicProvider, "conv-anthropic").run();
    expect(anthropicStreamCalls).toHaveLength(2);
    expectAppendOnlyTelemetry(await loggedIterationRows());
  });

  it("OpenAI (Responses): rows carry hashes and the append-only divergence index", async () => {
    openaiScript.push(openaiToolCallTurn("resp_1"), openaiTextTurn("resp_2"));
    await buildLoop("openai", "gpt-6-astra", openaiProvider, "conv-openai").run();
    expect(openaiResponsesCalls).toHaveLength(2);
    expectAppendOnlyTelemetry(await loggedIterationRows());
  });

  it("Google: rows carry hashes and the append-only divergence index", async () => {
    googleScript.push(googleToolCallTurn("g-1"), googleTextTurn("g-2"));
    await buildLoop("google", "gemini-3.6-flash", googleProvider, "conv-google").run();
    expect(googleStreamCalls).toHaveLength(2);
    expectAppendOnlyTelemetry(await loggedIterationRows());
  });

  it("vLLM (OpenAI-compatible): rows carry hashes and the append-only divergence index", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(vllmToolCallTurn()).mockResolvedValueOnce(vllmTextTurn());
    const vllm = createVllmProvider("http://vllm.test", "vllm");
    await buildLoop("vllm", "qwen-test", vllm, "conv-vllm").run();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
    expectAppendOnlyTelemetry(await loggedIterationRows());
  });
});

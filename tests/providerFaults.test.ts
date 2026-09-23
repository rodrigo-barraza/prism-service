/**
 * Fault injection for the provider adapters, at the HTTP layer.
 *
 * Every adapter streams from a real local server (ProviderFaultServer) that
 * speaks its wire format and injects one fault. The adapter runs inside the
 * same composition the harness uses — streamWithRetries around the provider
 * call, the chunk-idle watchdog around that, one abort signal per pass — so
 * each case checks what a turn would actually get. AgentChaos (arXiv
 * 2608.06790) measured that HTTP-level faults cost up to 50 points of pass@1
 * and that robustness depends on the implementation, hence one row per
 * adapter family.
 *
 * The behaviour each fault must produce is documented in
 * docs/provider-faults.md: retry, fail cleanly, or surface. In every case
 * there is no crash and no silently wrong answer — a partial tool call never
 * comes out executable, and a cut-off stream never ends like a finished one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.ts";
import openaiProvider from "#src/providers/openai";
import anthropicProvider from "#src/providers/anthropic";
import googleProvider from "#src/providers/google";
import { createVllmProvider } from "#src/providers/vllm";
import { createOllamaProvider } from "#src/providers/ollama";
import {
  isTerminalQuotaError,
  isTransientProviderError,
  streamWithRetries,
  withIdleTimeout,
} from "#src/utils/ProviderStreamResilience";
import { toErrorEvent } from "#src/protocol/errors";
import { ProviderError } from "#src/utils/errors";
import { ProviderFaultServer, type FaultReply } from "./fixtures/providerFaultServer.ts";
import {
  ANTHROPIC_WIRE,
  GEMINI_WIRE,
  OLLAMA_WIRE,
  OPENAI_CHAT_WIRE,
  OPENAI_RESPONSES_WIRE,
  type ProviderWire,
  type ReplyPlan,
} from "./fixtures/providerFaultWires.ts";

const server = new ProviderFaultServer();

const TOOL = {
  name: "evaluate_expression",
  description: "Evaluate an arithmetic expression.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
};
const MESSAGES = [{ role: "user", content: "What is 2+2? Use the tool." }];

const WELL_FORMED: ReplyPlan = {
  text: "Checking.",
  tool: {
    callId: "call_fault_1",
    name: TOOL.name,
    argumentChunks: ['{"expression":', '"2+2"}'],
  },
  usage: { inputTokens: 120, outputTokens: 30 },
};
const MALFORMED_ARGUMENTS: ReplyPlan = {
  ...WELL_FORMED,
  // The closing brace never comes: the JSON cannot be parsed.
  tool: { ...WELL_FORMED.tool, argumentChunks: ['{"expression":', '"2+2"'] },
};
const WITHOUT_USAGE: ReplyPlan = { ...WELL_FORMED, usage: null };

/** Test-sized knobs for the harness composition (the harness: 3 retries, 1 s base, 300 s idle). */
const MAX_RETRIES = 2;
const BASE_DELAY_MILLISECONDS = 20;
/**
 * The watchdog wraps the retries, so a retry's wait counts as silence; the
 * default stays well above every wait these cases script. The idle case
 * uses the short one.
 */
const IDLE_TIMEOUT_MILLISECONDS = 20_000;
const STALL_TIMEOUT_MILLISECONDS = 600;
const RETRY_AFTER_SECONDS = 0.3;

interface AdapterCase {
  name: string;
  wire: ProviderWire;
  stream(signal: AbortSignal): AsyncIterable<unknown>;
}

// Created in beforeAll, once the server's address is known.
let ADAPTERS: AdapterCase[] = [];

type Chunk = Record<string, unknown> | string;

interface PassOutcome {
  chunks: Chunk[];
  error: unknown;
  text: string;
  toolCalls: Array<Record<string, unknown>>;
  usage: Record<string, number> | null;
  elapsedMilliseconds: number;
}

/**
 * One provider pass the way the harness runs it (createProviderStream +
 * routeStreamChunks): retries around the call, the idle watchdog around the
 * retries, and a per-pass abort the watchdog fires on a stall.
 */
async function runPass(
  adapter: AdapterCase,
  idleTimeoutMilliseconds = IDLE_TIMEOUT_MILLISECONDS,
): Promise<PassOutcome> {
  const passAbort = new AbortController();
  const chunks: Chunk[] = [];
  let error: unknown = null;
  const startedAt = Date.now();
  const stream = withIdleTimeout(
    streamWithRetries(() => adapter.stream(passAbort.signal), {
      maxRetries: MAX_RETRIES,
      baseDelayMilliseconds: BASE_DELAY_MILLISECONDS,
      label: adapter.name,
    }),
    idleTimeoutMilliseconds,
    adapter.name,
    () => passAbort.abort(),
  );
  try {
    for await (const chunk of stream) chunks.push(chunk as Chunk);
  } catch (caught) {
    error = caught;
  }
  const objects = chunks.filter(
    (chunk): chunk is Record<string, unknown> => typeof chunk === "object" && chunk !== null,
  );
  const usageChunks = objects.filter((chunk) => chunk.type === "usage");
  return {
    chunks,
    error,
    text: chunks.filter((chunk): chunk is string => typeof chunk === "string").join(""),
    toolCalls: objects.filter((chunk) => chunk.type === "toolCall"),
    usage: (usageChunks.at(-1)?.usage as Record<string, number> | undefined) ?? null,
    elapsedMilliseconds: Date.now() - startedAt,
  };
}

function streamReply(wire: ProviderWire, frames: string[], ending: "end" | "destroy" | "hang"): FaultReply {
  return { kind: "stream", frames, ending, contentType: wire.contentType };
}

function completeReply(wire: ProviderWire, plan: ReplyPlan = WELL_FORMED): FaultReply {
  return streamReply(wire, wire.reply(plan).frames, "end");
}

/** A 429 in the provider's own error shape, telling the client when to come back. */
function rateLimitReply(adapter: AdapterCase): FaultReply {
  const headers = { "retry-after": String(RETRY_AFTER_SECONDS) };
  if (adapter.wire === GEMINI_WIRE) {
    // Gemini says when in the body (google.rpc.RetryInfo); the SDK drops headers.
    return {
      kind: "json",
      status: 429,
      headers,
      body: {
        error: {
          code: 429,
          message: "Resource has been exhausted (e.g. check quota).",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: `${RETRY_AFTER_SECONDS}s`,
            },
          ],
        },
      },
    };
  }
  if (adapter.wire === ANTHROPIC_WIRE) {
    return {
      kind: "json",
      status: 429,
      headers,
      body: { type: "error", error: { type: "rate_limit_error", message: "Rate limited." } },
    };
  }
  return {
    kind: "json",
    status: 429,
    headers,
    body: { error: { message: "Rate limit reached.", type: "requests", code: "rate_limit_exceeded" } },
  };
}

function serverErrorReply(status: number): FaultReply {
  return {
    kind: "json",
    status,
    body: { error: { message: `Upstream failure ${status}.`, type: "server_error", code: status } },
  };
}

function expectNoExecutableToolCall(outcome: PassOutcome): void {
  for (const call of outcome.toolCalls) {
    expect(call.argsParseError, `an executable tool call escaped: ${JSON.stringify(call)}`).toBe(true);
  }
}

function expectCompleteCall(outcome: PassOutcome): void {
  expect(outcome.toolCalls).toHaveLength(1);
  expect(outcome.toolCalls[0]).toMatchObject({ name: TOOL.name, args: { expression: "2+2" } });
  expect(outcome.toolCalls[0].argsParseError).toBeUndefined();
}

beforeAll(async () => {
  const baseUrl = await server.start();
  // The SDK clients are created on first use and read their base URL then.
  vi.stubEnv("OPENAI_BASE_URL", `${baseUrl}/v1`);
  vi.stubEnv("ANTHROPIC_BASE_URL", baseUrl);
  vi.stubEnv("GOOGLE_GEMINI_BASE_URL", baseUrl);
  server.route("GET", "/v1/models", {
    kind: "json",
    status: 200,
    body: { object: "list", data: [{ id: "fault-model", object: "model", max_model_len: 32_768 }] },
  });
  server.route("GET", "/api/ps", { kind: "json", status: 200, body: { models: [] } });
  server.route("POST", "/api/show", {
    kind: "json",
    status: 200,
    body: { model_info: { "general.architecture": "llama", "llama.context_length": 32_768 } },
  });
  const vllm = createVllmProvider(baseUrl, "vllm-fault");
  const ollama = createOllamaProvider(baseUrl, "ollama-fault");
  ADAPTERS = [
    {
      name: "openai",
      wire: OPENAI_RESPONSES_WIRE,
      stream: (signal) =>
        openaiProvider.generateTextStream(MESSAGES as never, "gpt-5.4-mini", {
          tools: [TOOL],
          signal,
        } as never) as AsyncIterable<unknown>,
    },
    {
      name: "anthropic",
      wire: ANTHROPIC_WIRE,
      stream: (signal) =>
        anthropicProvider.generateTextStream(MESSAGES as never, "claude-sonnet-5", {
          tools: [TOOL],
          maxTokens: 1024,
          signal,
        } as never) as AsyncIterable<unknown>,
    },
    {
      name: "google",
      wire: GEMINI_WIRE,
      stream: (signal) =>
        googleProvider.generateTextStream(MESSAGES as never, "gemini-3.5-flash", {
          tools: [TOOL],
          signal,
        } as never) as AsyncIterable<unknown>,
    },
    {
      name: "vllm",
      wire: OPENAI_CHAT_WIRE,
      stream: (signal) =>
        vllm.generateTextStream!(MESSAGES as never, "fault-model", {
          tools: [TOOL],
          signal,
        } as never) as AsyncIterable<unknown>,
    },
    {
      name: "ollama",
      wire: OLLAMA_WIRE,
      stream: (signal) =>
        ollama.generateTextStream!(MESSAGES as never, "fault-model", {
          tools: [TOOL],
          signal,
        } as never) as AsyncIterable<unknown>,
    },
  ];
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

const adapterNames = ["openai", "anthropic", "google", "vllm", "ollama"] as const;
const adapterNamed = (name: string) => ADAPTERS.find((adapter) => adapter.name === name)!;

describe.each(adapterNames)("%s adapter under HTTP faults", (name) => {
  it("control: a well-formed reply streams its text, one complete call and the usage", async () => {
    const adapter = adapterNamed(name);
    server.enqueue(completeReply(adapter.wire));
    const outcome = await runPass(adapter);
    expect(outcome.error).toBeNull();
    expect(outcome.text).toContain("Checking.");
    expectCompleteCall(outcome);
    expect(outcome.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    expect(server.scriptedRequests).toHaveLength(1);
  });

  it("truncated mid-tool-call, connection dropped: fails cleanly, the partial call never executes", async () => {
    const adapter = adapterNamed(name);
    const { truncatedMidToolCall } = adapter.wire.reply(WELL_FORMED);
    server.enqueue(streamReply(adapter.wire, truncatedMidToolCall, "destroy"));
    server.setFallback(completeReply(adapter.wire));
    const outcome = await runPass(adapter);
    expect(outcome.error, "the pass must fail").not.toBeNull();
    expect(isTransientProviderError(outcome.error)).toBe(true);
    expect(toErrorEvent(outcome.error).retryable).toBe(true);
    expectNoExecutableToolCall(outcome);
    // Output already reached the consumer: the stream is not replayed.
    expect(server.scriptedRequests).toHaveLength(1);
  });

  it("truncated mid-tool-call, body ended early: fails cleanly instead of ending like a finished reply", async () => {
    const adapter = adapterNamed(name);
    const { truncatedMidToolCall } = adapter.wire.reply(WELL_FORMED);
    server.enqueue(streamReply(adapter.wire, truncatedMidToolCall, "end"));
    server.setFallback(completeReply(adapter.wire));
    const outcome = await runPass(adapter);
    expect(outcome.error, "a cut-off stream must not look finished").not.toBeNull();
    expect(isTransientProviderError(outcome.error)).toBe(true);
    expect(String((outcome.error as Error).message)).toMatch(/ended before the response (?:completed|finished)/i);
    expectNoExecutableToolCall(outcome);
    expect(server.scriptedRequests).toHaveLength(1);
  });

  it("truncated before any output: retried, and the retry's reply is delivered whole", async () => {
    const adapter = adapterNamed(name);
    server.enqueue(streamReply(adapter.wire, [], "end"));
    server.setFallback(completeReply(adapter.wire));
    const outcome = await runPass(adapter);
    expect(outcome.error).toBeNull();
    expectCompleteCall(outcome);
    expect(server.scriptedRequests).toHaveLength(2);
  });

  it("missing usage: the reply is delivered whole and no token count is invented", async () => {
    const adapter = adapterNamed(name);
    server.enqueue(completeReply(adapter.wire, WITHOUT_USAGE));
    const outcome = await runPass(adapter);
    expect(outcome.error).toBeNull();
    expect(outcome.text).toContain("Checking.");
    expectCompleteCall(outcome);
    expect(outcome.usage?.inputTokens ?? 0).toBe(0);
    expect(outcome.usage?.outputTokens ?? 0).toBe(0);
  });

  it("429 with retry-after: retried once, no sooner than the provider asked", async () => {
    const adapter = adapterNamed(name);
    server.enqueue(rateLimitReply(adapter), completeReply(adapter.wire));
    const outcome = await runPass(adapter);
    expect(outcome.error).toBeNull();
    expectCompleteCall(outcome);
    const [first, second] = server.scriptedRequests;
    expect(server.scriptedRequests).toHaveLength(2);
    // The backoff alone would wait ~BASE_DELAY_MILLISECONDS.
    expect(second.receivedAt - first.receivedAt).toBeGreaterThanOrEqual(RETRY_AFTER_SECONDS * 1000 - 20);
  });

  it("503 once: retried with backoff, and the retry's reply is delivered whole", async () => {
    const adapter = adapterNamed(name);
    server.enqueue(serverErrorReply(503), completeReply(adapter.wire));
    const outcome = await runPass(adapter);
    expect(outcome.error).toBeNull();
    expectCompleteCall(outcome);
    expect(server.scriptedRequests).toHaveLength(2);
  });

  it("persistent 500: one retry layer, bounded, then fails cleanly with the status", async () => {
    const adapter = adapterNamed(name);
    server.setFallback(serverErrorReply(500));
    const outcome = await runPass(adapter);
    expect(outcome.error).not.toBeNull();
    expect(server.scriptedRequests).toHaveLength(1 + MAX_RETRIES);
    const event = toErrorEvent(outcome.error);
    expect(event.retryable).toBe(true);
    expect(event.status).toBe(500);
    expect(outcome.toolCalls).toHaveLength(0);
  });

  it("idle stream: the watchdog fails the pass and the request is aborted", async () => {
    const adapter = adapterNamed(name);
    const { frames } = adapter.wire.reply(WELL_FORMED);
    // The text arrives, then nothing: the socket stays open.
    server.enqueue(streamReply(adapter.wire, frames.slice(0, 1), "hang"));
    const outcome = await runPass(adapter, STALL_TIMEOUT_MILLISECONDS);
    expect(outcome.error).toBeInstanceOf(ProviderError);
    expect((outcome.error as ProviderError).statusCode).toBe(504);
    expect(String((outcome.error as Error).message)).toMatch(/stalled/i);
    expect(outcome.elapsedMilliseconds).toBeLessThan(STALL_TIMEOUT_MILLISECONDS + 1_500);
    const [request] = server.scriptedRequests;
    // The provider stops generating: the connection is closed, not leaked.
    expect(await server.waitForClose(request, 2_000)).toBe(true);
    expectNoExecutableToolCall(outcome);
  });

  it("malformed tool-argument JSON: surfaced to the model, never executed with invented arguments", async () => {
    const adapter = adapterNamed(name);
    server.enqueue(completeReply(adapter.wire, MALFORMED_ARGUMENTS));
    const outcome = await runPass(adapter);
    expectNoExecutableToolCall(outcome);
    if (adapter.wire === GEMINI_WIRE) {
      // Gemini's arguments are JSON inside the event: a broken event is a
      // protocol error, and the pass fails cleanly.
      expect(outcome.error).not.toBeNull();
      expect(outcome.toolCalls).toHaveLength(0);
      return;
    }
    expect(outcome.error).toBeNull();
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]).toMatchObject({ name: TOOL.name, argsParseError: true });
    expect(String(outcome.toolCalls[0].rawArgs)).toContain('"2+2"');
  });
});

describe("OpenAI 429s: slow_down is a rate limit, a spend cap is not", () => {
  it("429 slow_down: retried, then the reply is delivered", async () => {
    const adapter = adapterNamed("openai");
    server.enqueue(
      {
        kind: "json",
        status: 429,
        body: { error: { message: "Please slow down.", type: "requests", code: "slow_down" } },
      },
      completeReply(adapter.wire),
    );
    const outcome = await runPass(adapter);
    expect(outcome.error).toBeNull();
    expectCompleteCall(outcome);
    expect(server.scriptedRequests).toHaveLength(2);
  });

  it("spend-cap 429: surfaced at once — one request, terminal, not retryable", async () => {
    const adapter = adapterNamed("openai");
    server.setFallback({
      kind: "json",
      status: 429,
      body: {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      },
    });
    const outcome = await runPass(adapter);
    expect(outcome.error).not.toBeNull();
    expect(server.scriptedRequests).toHaveLength(1);
    expect(isTerminalQuotaError(outcome.error)).toBe(true);
    const event = toErrorEvent(outcome.error);
    expect(event.code).toBe("rate_limited");
    expect(event.retryable).toBe(false);
  });
});

/**
 * The same faults seen by the harness itself: createProviderStream builds
 * the composition the adapter cases above reproduce, and consumeStream is
 * where a pass's outcome is decided and logged.
 */
describe("the harness under the same faults", () => {
  async function harnessFor(
    provider: { generateTextStream: (...args: never[]) => AsyncIterable<unknown> },
    options: Record<string, unknown> = {},
  ) {
    const { default: BaseAgenticHarness } = await import("#src/services/harnesses/BaseAgenticHarness");
    const { default: AgenticLoopState } = await import("#src/services/AgenticLoopState");
    const context = {
      emit: () => {},
      signal: null,
      provider,
      providerName: "fault-provider",
      resolvedModel: "fault-model",
      modelDefinition: null,
      options,
      project: "test",
      username: "tester",
      agentConversationId: "fault-session",
      conversationId: "fault-conversation",
      requestId: "fault-request",
    };
    const state = new AgenticLoopState();
    const harness = new BaseAgenticHarness(context as never, state, {
      finalTools: [],
      resolvedEnabledTools: [],
    } as never);
    return { harness, state };
  }

  it("a stalled pass aborts the provider request it was reading", async () => {
    let providerSignal: AbortSignal | undefined;
    const { harness } = await harnessFor(
      {
        async *generateTextStream(_messages: unknown, _model: unknown, options: { signal: AbortSignal }) {
          providerSignal = options.signal;
          yield "partial";
          // A provider that stalls: nothing more until the request is aborted.
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
        },
      } as never,
      { streamIdleTimeoutMilliseconds: 100 },
    );
    const pass = harness.createPassState({});
    const stream = await harness.createProviderStream([{ role: "user", content: "hi" }], {});
    await expect(harness.consumeStream(stream!, pass, new Set())).rejects.toThrow(/stalled/);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("the turn's stop still reaches the provider through the pass's signal", async () => {
    const turn = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const { harness } = await harnessFor({
      async *generateTextStream(_messages: unknown, _model: unknown, options: { signal: AbortSignal }) {
        providerSignal = options.signal;
        yield "partial";
      },
    } as never);
    (harness as unknown as { context: { signal: AbortSignal } }).context.signal = turn.signal;
    const stream = await harness.createProviderStream([{ role: "user", content: "hi" }], {});
    for await (const _chunk of stream!) break;
    expect(providerSignal?.aborted).toBe(false);
    turn.abort();
    expect(providerSignal?.aborted).toBe(true);
  });

  it("missing usage: the pass records an estimate, marked usageEstimated on its request row", async () => {
    const RequestLogger = (await import("#src/services/RequestLogger")).default as unknown as {
      completePending: ReturnType<typeof vi.fn>;
    };
    RequestLogger.completePending.mockClear();
    const { harness, state } = await harnessFor({
      async *generateTextStream() {
        yield "An answer of forty characters, roughly.";
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    } as never);
    const messages = [{ role: "user", content: "A question the prompt estimate can count." }];
    const pass = harness.createPassState({});
    const stream = await harness.createProviderStream(messages as never, {});
    await harness.consumeStream(stream!, pass, new Set());
    expect(pass.usageEstimated).toBe(true);
    expect(pass.usage.outputTokens).toBe(10);
    expect(pass.usage.inputTokens).toBeGreaterThan(0);
    expect(state.overallUsage.outputTokens).toBe(10);
    harness.logIteration(pass, messages as never);
    await Promise.all(state.pendingRequestLogWrites);
    const [, row] = RequestLogger.completePending.mock.calls.at(-1)!;
    expect(row).toMatchObject({ usageEstimated: true, usage: { outputTokens: 10 } });
  });

  it("reported usage is kept as reported, unmarked", async () => {
    const { harness } = await harnessFor({
      async *generateTextStream() {
        yield "Counted.";
        yield { type: "usage", usage: { inputTokens: 321, outputTokens: 7 } };
      },
    } as never);
    const pass = harness.createPassState({});
    const stream = await harness.createProviderStream([{ role: "user", content: "hi" }], {});
    await harness.consumeStream(stream!, pass, new Set());
    expect(pass.usageEstimated).toBeUndefined();
    expect(pass.usage).toMatchObject({ inputTokens: 321, outputTokens: 7 });
  });
});

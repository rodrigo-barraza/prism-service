/**
 * Provider cache diagnostics — request shape and response fixtures.
 *
 * - Anthropic (beta cache-diagnosis-2026-04-07): `diagnostics.previous_message_id`
 *   on every telemetry request (null on the first), the beta header joined
 *   with any other beta, and `message.diagnostics.cache_miss_reason` read back.
 * - OpenAI Responses (GPT-5.6+): `prompt_cache_options.comparison_response_id`
 *   when there is a previous response, and `prompt_cache_diagnostics` read
 *   from the terminal response.
 * - A request the provider rejects for the diagnostics field is sent again
 *   without it, and that model is not asked again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ANTHROPIC_FILES_API_ENABLED = "false";
});

import anthropicProvider, { ANTHROPIC_CACHE_DIAGNOSIS_BETA } from "#src/providers/anthropic";
import openaiProvider from "#src/providers/openai";
import { _resetProviderDiagnosticsSupport } from "#src/utils/PromptPrefixHashes";

type Script = () => AsyncGenerator<Record<string, unknown>>;

const anthropicCalls: Array<{ payload: Record<string, any>; requestOptions: Record<string, any> }> = [];
const anthropicScript: Script[] = [];
/** finalMessage() results, one per stream call (undefined → it throws). */
const anthropicFinalMessages: unknown[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: (payload: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
        anthropicCalls.push({ payload: structuredClone(payload), requestOptions: { ...requestOptions } });
        const next = anthropicScript.shift();
        if (!next) throw new Error("anthropic script exhausted");
        const stream = next() as any;
        stream.abort = () => {};
        stream.response = { headers: { get: () => null } };
        const finalMessage = anthropicFinalMessages.shift();
        stream.finalMessage = async () => {
          if (finalMessage === undefined) throw new Error("no final message in test");
          return finalMessage;
        };
        return stream;
      },
    };
  },
}));

const openaiCalls: Array<Record<string, any>> = [];
const openaiScript: Array<Script | Error> = [];
vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (payload: Record<string, unknown>) => {
        openaiCalls.push(structuredClone(payload));
        const next = openaiScript.shift();
        return {
          withResponse: async () => {
            if (!next) throw new Error("openai script exhausted");
            if (next instanceof Error) throw next;
            return { data: next(), response: { headers: { get: () => null } } };
          },
        };
      },
    };
  },
}));

function anthropicTurn(messageId: string, diagnostics?: unknown): Script {
  return async function* () {
    yield {
      type: "message_start",
      message: {
        id: messageId,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ...(diagnostics !== undefined && { diagnostics }),
      },
    };
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
  };
}

function anthropicRejection(message: string): Script {
  // oxlint-disable-next-line require-yield -- throws on the first pull, like a provider rejecting the request
  return async function* () {
    throw Object.assign(new Error(message), { status: 400 });
  };
}

function openaiTurn(responseId: string, promptCacheDiagnostics?: unknown): Script {
  return async function* () {
    yield { type: "response.created", response: { id: responseId } };
    yield { type: "response.output_text.delta", delta: "ok" };
    yield {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [],
        usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
        ...(promptCacheDiagnostics !== undefined && { prompt_cache_diagnostics: promptCacheDiagnostics }),
      },
    };
  };
}

async function drain(stream: AsyncIterable<unknown>) {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
const telemetryOf = (chunks: any[]) => chunks.filter((chunk) => chunk?.type === "requestTelemetry");

const messages = [{ role: "user", content: "hello" }];

describe("Anthropic cache diagnosis (beta)", () => {
  beforeEach(() => {
    anthropicCalls.length = 0;
    anthropicScript.length = 0;
    anthropicFinalMessages.length = 0;
    _resetProviderDiagnosticsSupport();
  });

  it("opts in on the first request (previous_message_id: null) and sends the beta header", async () => {
    anthropicScript.push(anthropicTurn("msg_1", null));
    const chunks = await drain(
      anthropicProvider.generateTextStream(messages as any, "claude-sonnet-5", { cacheTelemetry: { previousResponseId: null } }),
    );
    const { payload, requestOptions } = anthropicCalls[0];
    expect(payload.diagnostics).toEqual({ previous_message_id: null });
    expect(requestOptions.headers["anthropic-beta"]).toBe(ANTHROPIC_CACHE_DIAGNOSIS_BETA);
    const [telemetry] = telemetryOf(chunks);
    expect(telemetry.providerResponseId).toBe("msg_1");
    expect(telemetry.prefixHashes.messages).toHaveLength(1);
    expect(telemetry.cacheDiagnostics).toBeUndefined();
  });

  it("compares against the previous message and reads the miss reason back", async () => {
    anthropicScript.push(
      anthropicTurn("msg_2", { cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 4096 } }),
    );
    const chunks = await drain(
      anthropicProvider.generateTextStream(messages as any, "claude-sonnet-5", { cacheTelemetry: { previousResponseId: "msg_1" } }),
    );
    expect(anthropicCalls[0].payload.diagnostics).toEqual({ previous_message_id: "msg_1" });
    expect(telemetryOf(chunks)[0].cacheDiagnostics).toMatchObject({
      source: "anthropic",
      status: "cache_miss",
      reason: "tools_changed",
      missedTokens: 4096,
      comparedResponseId: "msg_1",
    });
  });

  it("a pause_turn continuation reports last, compared against the paused message", async () => {
    const pausedContent = [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } }];
    anthropicScript.push(
      async function* () {
        yield { type: "message_start", message: { id: "msg_paused", usage: { input_tokens: 10, output_tokens: 0 } } };
        yield { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 1 } };
      },
      anthropicTurn("msg_continued"),
    );
    anthropicFinalMessages.push({ id: "msg_paused", content: pausedContent, usage: { input_tokens: 10, output_tokens: 1 } });
    const chunks = await drain(
      anthropicProvider.generateTextStream(messages as any, "claude-sonnet-5", { cacheTelemetry: { previousResponseId: "msg_0" } }),
    );
    expect(anthropicCalls).toHaveLength(2);
    expect(anthropicCalls[1].payload.diagnostics).toEqual({ previous_message_id: "msg_paused" });
    const telemetry = telemetryOf(chunks);
    expect(telemetry.map((chunk) => chunk.providerResponseId)).toEqual(["msg_paused", "msg_continued"]);
    // The continuation re-sent the paused assistant content: one more message.
    expect(telemetry[1].prefixHashes.messages.slice(0, 1)).toEqual(telemetry[0].prefixHashes.messages);
    expect(telemetry[1].prefixHashes.messages).toHaveLength(2);
  });

  it("without cacheTelemetry: no diagnostics field, no beta header, no telemetry chunk", async () => {
    anthropicScript.push(anthropicTurn("msg_3"));
    const chunks = await drain(anthropicProvider.generateTextStream(messages as any, "claude-sonnet-5", {}));
    expect(anthropicCalls[0].payload.diagnostics).toBeUndefined();
    expect(anthropicCalls[0].requestOptions.headers).toBeUndefined();
    expect(telemetryOf(chunks)).toHaveLength(0);
  });

  it("a request rejected for the diagnostics field is resent without it, and the model is not asked again", async () => {
    anthropicScript.push(
      anthropicRejection('400 {"type":"error","error":{"type":"invalid_request_error","message":"diagnostics: Extra inputs are not permitted"}}'),
      anthropicTurn("msg_4"),
      anthropicTurn("msg_5"),
    );
    const chunks = await drain(
      anthropicProvider.generateTextStream(messages as any, "claude-haiku-4-5", { cacheTelemetry: { previousResponseId: "msg_0" } }),
    );
    expect(anthropicCalls).toHaveLength(2);
    expect(anthropicCalls[1].payload.diagnostics).toBeUndefined();
    expect(anthropicCalls[1].requestOptions.headers).toBeUndefined();
    expect(chunks).toContain("ok");
    expect(telemetryOf(chunks)[0].prefixHashes).not.toBeNull();

    await drain(
      anthropicProvider.generateTextStream(messages as any, "claude-haiku-4-5", { cacheTelemetry: { previousResponseId: "msg_4" } }),
    );
    expect(anthropicCalls[2].payload.diagnostics).toBeUndefined();
  });
});

describe("OpenAI prompt cache diagnostics (Responses API)", () => {
  beforeEach(() => {
    openaiCalls.length = 0;
    openaiScript.length = 0;
    _resetProviderDiagnosticsSupport();
  });

  it("sends comparison_response_id and reads prompt_cache_diagnostics from response.completed", async () => {
    openaiScript.push(
      openaiTurn("resp_2", { type: "cache_miss", reason: "input_changed", comparison_reusable_tokens: 0, cache_missed_tokens: 2048 }),
    );
    const chunks = await drain(
      openaiProvider.generateTextStream(messages as any, "gpt-6-astra", { cacheTelemetry: { previousResponseId: "resp_1" } }),
    );
    expect(openaiCalls[0].prompt_cache_options).toEqual({ comparison_response_id: "resp_1" });
    const [telemetry] = telemetryOf(chunks);
    expect(telemetry.providerResponseId).toBe("resp_2");
    expect(telemetry.cacheDiagnostics).toMatchObject({
      source: "openai",
      status: "cache_miss",
      reason: "input_changed",
      missedTokens: 2048,
      comparedResponseId: "resp_1",
    });
  });

  it("no previous response, or a model before GPT-5.6: no prompt_cache_options", async () => {
    openaiScript.push(openaiTurn("resp_a"), openaiTurn("resp_b"));
    await drain(openaiProvider.generateTextStream(messages as any, "gpt-6-astra", { cacheTelemetry: { previousResponseId: null } }));
    await drain(openaiProvider.generateTextStream(messages as any, "gpt-5.5", { cacheTelemetry: { previousResponseId: "resp_a" } }));
    expect(openaiCalls[0].prompt_cache_options).toBeUndefined();
    expect(openaiCalls[1].prompt_cache_options).toBeUndefined();
  });

  it("a request rejected for prompt_cache_options is resent without it, and the model is not asked again", async () => {
    openaiScript.push(
      Object.assign(new Error("400 Unknown parameter: 'prompt_cache_options'."), { status: 400 }),
      openaiTurn("resp_3"),
      openaiTurn("resp_4"),
    );
    const chunks = await drain(
      openaiProvider.generateTextStream(messages as any, "gpt-5.6-luna", { cacheTelemetry: { previousResponseId: "resp_2" } }),
    );
    expect(openaiCalls).toHaveLength(2);
    expect(openaiCalls[1].prompt_cache_options).toBeUndefined();
    expect(chunks).toContain("ok");
    expect(telemetryOf(chunks)[0].cacheDiagnostics).toBeUndefined();

    await drain(
      openaiProvider.generateTextStream(messages as any, "gpt-5.6-luna", { cacheTelemetry: { previousResponseId: "resp_3" } }),
    );
    expect(openaiCalls[2].prompt_cache_options).toBeUndefined();
  });
});

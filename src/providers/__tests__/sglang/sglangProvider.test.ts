/**
 * The SGLang provider against a stubbed server that answers the way SGLang
 * v0.5.20 does: the stream opens with {role, content: ""}, carries explicit
 * nulls, reports reasoning in reasoning_content, sends finish_reason in its
 * own chunk and usage in a choices: [] chunk, and reports a failure found
 * after the 200 as an in-stream {"error": …} event.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSglangProvider } from "#src/providers/sglang";
import { ProviderError } from "#src/utils/errors";
import {
  isTransientProviderError,
  parseContextOverflowError,
} from "#src/utils/ProviderStreamResilience";
import type { ProviderOptions } from "#src/types/ProviderTypes";

const BASE_URL = "http://sglang-box:30000";

type Route = (init?: RequestInit) => Response | Promise<Response>;

function stubServer(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const route = routes[url.slice(BASE_URL.length)];
    if (!route) return new Response("Not Found", { status: 404 });
    return route(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(events: unknown[]): Response {
  const body =
    events
      .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "3f1c2b0e9d8a4c7b6e5f4a3b2c1d0e9f",
    object: "chat.completion.chunk",
    created: 1_790_000_000,
    model: "Qwen/Qwen3.6-27B",
    choices: [
      {
        index: 0,
        delta: { role: null, content: null, reasoning_content: null, tool_calls: null, ...delta },
        logprobs: null,
        finish_reason: finishReason,
        matched_stop: null,
      },
    ],
    usage: null,
  };
}

const modelsList = {
  object: "list",
  data: [
    {
      id: "Qwen/Qwen3.6-27B",
      object: "model",
      created: 1_790_000_000,
      owned_by: "sglang",
      root: "Qwen/Qwen3.6-27B",
      parent: null,
      max_model_len: 131072,
    },
  ],
};

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const item of stream) chunks.push(item);
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SGLang provider — streaming", () => {
  it("turns SGLang's stream into thinking, text, a tool call and usage", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/v1/chat/completions": () =>
        sse([
          chunk({ role: "assistant", content: "" }),
          chunk({ reasoning_content: "Paris weather needs a lookup." }),
          chunk({ content: "Checking." }),
          chunk({
            tool_calls: [
              {
                id: "call_0a1b2c3d4e5f60718293a4b5",
                index: 0,
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          }),
          chunk({
            tool_calls: [{ id: null, index: 0, type: null, function: { name: null, arguments: '{"city": ' } }],
          }),
          chunk({
            tool_calls: [{ id: null, index: 0, type: null, function: { name: null, arguments: '"Paris"}' } }],
          }),
          chunk({}, "tool_calls"),
          {
            id: "3f1c2b0e9d8a4c7b6e5f4a3b2c1d0e9f",
            object: "chat.completion.chunk",
            choices: [],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 30,
              total_tokens: 150,
              prompt_tokens_details: { cached_tokens: 64 },
              reasoning_tokens: 12,
            },
          },
        ]),
    });

    const provider = createSglangProvider(BASE_URL, "sglang");
    const options: ProviderOptions = { thinkingEnabled: true };
    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "Weather in Paris?" }], "Qwen/Qwen3.6-27B", options),
    );

    expect(chunks).toEqual([
      { type: "thinking", content: "Paris weather needs a lookup." },
      "Checking.",
      { type: "toolCallStart", id: "call_0a1b2c3d4e5f60718293a4b5", name: "get_weather" },
      { type: "toolCallDelta", characters: 9 },
      { type: "toolCallDelta", characters: 8 },
      {
        type: "toolCall",
        id: "call_0a1b2c3d4e5f60718293a4b5",
        name: "get_weather",
        args: { city: "Paris" },
      },
      {
        type: "usage",
        usage: {
          inputTokens: 56,
          outputTokens: 30,
          cacheReadInputTokens: 64,
          reasoningOutputTokens: 12,
        },
      },
    ]);
    // The window came from /v1/models before the request went out
    expect(options._loadedContextLength).toBe(131072);
  });

  it("sends the API key on every call that needs one", async () => {
    const fetchMock = stubServer({
      "/v1/models": () => json(modelsList),
      "/v1/chat/completions": () => sse([chunk({ content: "hi" }, "stop")]),
    });

    const provider = createSglangProvider(BASE_URL, "sglang-2", { apiKey: "sk-local" });
    await collect(provider.generateTextStream([{ role: "user", content: "hi" }], "keyed-model", {}));

    const calledUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calledUrls).toEqual([`${BASE_URL}/v1/models`, `${BASE_URL}/v1/chat/completions`]);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer sk-local");
    }
  });

  it("surfaces an in-stream error as a 400 the harness will not replay", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/v1/chat/completions": () =>
        sse([
          chunk({ role: "assistant", content: "" }),
          {
            error: {
              message:
                "Input length (40000 tokens) exceeds the maximum allowed length (32762 tokens). Use a shorter input or enable --allow-auto-truncate.",
              type: "BAD_REQUEST",
              code: 400,
            },
          },
        ]),
    });

    const provider = createSglangProvider(BASE_URL, "sglang");
    const error = await collect(
      provider.generateTextStream([{ role: "user", content: "x" }], "stream-error-model", {}),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).statusCode).toBe(400);
    expect((error as ProviderError).message).toContain("exceeds the maximum allowed length");
    expect(isTransientProviderError(error)).toBe(false);
    expect(parseContextOverflowError(error)).toEqual({
      contextWindow: 32762,
      requestedOutputTokens: null,
      inputTokens: 40000,
    });
  });

  it("keeps the HTTP status and message of a rejected request", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/v1/chat/completions": () =>
        json(
          {
            object: "error",
            message:
              "Requested token count exceeds the model's maximum context length of 32768 tokens. You requested a total of 34000 tokens: 30000 tokens from the input messages and 4000 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.",
            type: "BadRequestError",
            param: null,
            code: 400,
          },
          400,
        ),
    });

    const provider = createSglangProvider(BASE_URL, "sglang");
    const error = await collect(
      provider.generateTextStream([{ role: "user", content: "x" }], "rejected-model", { maxTokens: 4000 }),
    ).catch((caught: unknown) => caught);

    expect((error as ProviderError).statusCode).toBe(400);
    expect(isTransientProviderError(error)).toBe(false);
    expect(parseContextOverflowError(error)).toEqual({
      contextWindow: 32768,
      requestedOutputTokens: 4000,
      inputTokens: 30000,
    });
  });

  it("treats a server that is still warming up as transient", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/v1/chat/completions": () => new Response("", { status: 503 }),
    });
    const provider = createSglangProvider(BASE_URL, "sglang");
    const error = await collect(
      provider.generateTextStream([{ role: "user", content: "x" }], "warming-model", {}),
    ).catch((caught: unknown) => caught);
    expect((error as ProviderError).statusCode).toBe(503);
    expect(isTransientProviderError(error)).toBe(true);
  });
});

describe("SGLang provider — non-streaming", () => {
  it("reads reasoning_content, content, tool calls and top-level reasoning tokens", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/v1/chat/completions": () =>
        json({
          id: "a1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Let me look that up.",
                reasoning_content: "Needs the tool.",
                tool_calls: [
                  {
                    id: "call_1",
                    index: 0,
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city": "Oslo"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
              matched_stop: null,
            },
          ],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 20,
            total_tokens: 70,
            prompt_tokens_details: null,
            reasoning_tokens: 5,
          },
        }),
    });

    const provider = createSglangProvider(BASE_URL, "sglang");
    const result = await provider.generateText(
      [{ role: "user", content: "Weather in Oslo?" }],
      "non-stream-model",
      { thinkingEnabled: true },
    );
    expect(result.text).toBe("Let me look that up.");
    expect(result.thinking).toBe("Needs the tool.");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", args: { city: "Oslo" } },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      reasoningOutputTokens: 5,
    });
  });
});

describe("SGLang provider — model listing", () => {
  it("merges /v1/models with /model_info", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/model_info": () =>
        json({
          model_path: "Qwen/Qwen3.6-27B",
          is_generation: true,
          tool_call_parser: "qwen25",
          reasoning_parser: "qwen3",
          has_image_understanding: true,
          has_audio_understanding: false,
        }),
    });
    const provider = createSglangProvider(BASE_URL, "sglang");
    const { models } = await provider.listModels!();
    expect(models).toEqual([
      {
        key: "Qwen/Qwen3.6-27B",
        display_name: "Qwen/Qwen3.6-27B",
        type: "llm",
        max_model_len: 131072,
        sglangCapabilities: {
          toolCallParser: "qwen25",
          reasoningParser: "qwen3",
          imageUnderstanding: true,
          audioUnderstanding: false,
        },
      },
    ]);
  });

  it("falls back to the get_ routes of a pre-v0.5.6 server and its launch arguments", async () => {
    const fetchMock = stubServer({
      "/v1/models": () => json(modelsList),
      "/get_model_info": () => json({ model_path: "Qwen/Qwen3.6-27B", is_generation: true }),
      "/get_server_info": () =>
        json({ tool_call_parser: "hermes", reasoning_parser: null, api_key: "secret" }),
    });
    const provider = createSglangProvider(BASE_URL, "sglang");
    const { models } = await provider.listModels!();
    expect(models[0]).toMatchObject({
      sglangCapabilities: { toolCallParser: "hermes", reasoningParser: null },
    });
    expect(JSON.stringify(models)).not.toContain("secret");
    expect(fetchMock.mock.calls.map(([url]) => String(url).slice(BASE_URL.length))).toEqual([
      "/v1/models",
      "/model_info",
      "/get_model_info",
      "/server_info",
      "/get_server_info",
    ]);
  });

  it("still lists the model when the info endpoints are unreachable", async () => {
    stubServer({
      "/v1/models": () => json(modelsList),
      "/model_info": () => {
        throw new TypeError("fetch failed");
      },
    });
    const provider = createSglangProvider(BASE_URL, "sglang");
    const { models } = await provider.listModels!();
    expect(models).toEqual([
      { key: "Qwen/Qwen3.6-27B", display_name: "Qwen/Qwen3.6-27B", type: "llm", max_model_len: 131072 },
    ]);
  });

  it("fails with the status when /v1/models refuses (e.g. a missing API key)", async () => {
    stubServer({
      "/v1/models": () => json({ error: "Unauthorized" }, 401),
      "/model_info": () => json({ error: "Unauthorized" }, 401),
    });
    const provider = createSglangProvider(BASE_URL, "sglang");
    const error = await provider.listModels!().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).statusCode).toBe(401);
  });
});

describe("SGLang provider — health", () => {
  it("uses /ready when the server has it", async () => {
    const fetchMock = stubServer({ "/ready": () => new Response("", { status: 200 }) });
    const provider = createSglangProvider(BASE_URL, "sglang");
    expect(await provider.checkHealth!()).toEqual({ ok: true, status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to /health on a server without /ready", async () => {
    stubServer({ "/health": () => new Response("", { status: 200 }) });
    const provider = createSglangProvider(BASE_URL, "sglang");
    expect(await provider.checkHealth!()).toEqual({ ok: true, status: "ok" });
  });

  it("reports a warming-up server as starting and a dead one as unreachable", async () => {
    stubServer({ "/ready": () => new Response("", { status: 503 }) });
    expect(await createSglangProvider(BASE_URL, "sglang").checkHealth!()).toEqual({
      ok: false,
      status: "starting",
    });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(await createSglangProvider(BASE_URL, "sglang").checkHealth!()).toMatchObject({
      ok: false,
      status: "unreachable",
    });
  });
});

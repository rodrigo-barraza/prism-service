/**
 * Kimi K3 on Moonshot's Anthropic-compatible endpoint: the Anthropic adapter
 * builds the request, moonshot-anthropic.ts adapts it (top-level
 * cache_control only, effort low|high|max, no sampling, no betas, the
 * session key hashed into metadata.user_id) and sends it through a client
 * pointed at api.moonshot.ai/anthropic with Bearer auth.
 */
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import {
  KIMI_ANTHROPIC_BASE_URL,
  adaptKimiPayload,
  createKimiAnthropicClient,
  kimiEffort,
  setKimiAnthropicClient,
} from "#src/providers/moonshot-anthropic";
import moonshotProvider, { buildMoonshotPayload } from "#src/providers/moonshot";
import type { ChatMessage, StreamChunk } from "#src/types/provider";
import type { ProviderOptions } from "#src/types/ProviderTypes";

interface Call {
  body: Record<string, unknown>;
  options: { headers?: Record<string, string> } | undefined;
}

const FINAL_MESSAGE = {
  id: "msg_kimi_1",
  type: "message",
  role: "assistant",
  model: "kimi-k3",
  content: [
    { type: "thinking", thinking: "The user says hi.", signature: "kimi-signature-1" },
    { type: "text", text: "Hello!" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 40,
  },
};

const STREAM_EVENTS = [
  {
    type: "message_start",
    message: { ...FINAL_MESSAGE, content: [], usage: { ...FINAL_MESSAGE.usage, output_tokens: 0 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user says hi." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "kimi-signature-1" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello!" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

function fakeKimiClient() {
  const create: Call[] = [];
  const stream: Call[] = [];
  const client = {
    messages: {
      create(body: Record<string, unknown>, options?: Call["options"]) {
        create.push({ body, options });
        return {
          withResponse: async () => ({ data: FINAL_MESSAGE, response: new Response(null) }),
        };
      },
      stream(body: Record<string, unknown>, options?: Call["options"]) {
        stream.push({ body, options });
        return {
          response: undefined,
          abort() {},
          finalMessage: async () => FINAL_MESSAGE,
          async *[Symbol.asyncIterator]() {
            for (const event of STREAM_EVENTS) yield event;
          },
        };
      },
    },
  };
  setKimiAnthropicClient(client as unknown as Anthropic);
  return { create, stream };
}

const conversation: ChatMessage[] = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "hi" },
];

const tools = [
  {
    name: "get_weather",
    description: "Weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
];

/** Every cache_control marker anywhere under `value`, with its path. */
function cacheControlPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => cacheControlPaths(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    key === "cache_control" ? [`${path}.${key}`] : cacheControlPaths(child, `${path}.${key}`),
  );
}

afterEach(() => setKimiAnthropicClient(null));

describe("Kimi K3 — Anthropic-compatible request shape", () => {
  it("sends a non-streamed turn through the Kimi client with one top-level cache_control and no sampling", async () => {
    const { create } = fakeKimiClient();
    const result = await moonshotProvider.generateText(conversation, "kimi-k3", {
      temperature: 0.2,
      topP: 0.5,
      reasoningEffort: "medium",
      promptCacheKey: "conversation-42",
      tools,
    });

    expect(result.text).toBe("Hello!");
    expect(create).toHaveLength(1);
    const { body, options } = create[0];
    expect(body.model).toBe("kimi-k3");
    expect(cacheControlPaths(body)).toEqual(["$.cache_control"]);
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    for (const field of ["temperature", "top_p", "top_k", "thinking", "service_tier"]) {
      expect(body).not.toHaveProperty(field);
    }
    expect((body.output_config as { effort?: string }).effort).toBe("high");
    expect((body.metadata as { user_id?: string }).user_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(body.metadata)).not.toContain("conversation-42");
    expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["get_weather"]);
    expect(options?.headers ?? {}).not.toHaveProperty("anthropic-beta");
  });

  it("streams through the Kimi client, keeping the signed thinking block whole", async () => {
    const { stream } = fakeKimiClient();
    const chunks: StreamChunk[] = [];
    // The harness passes the GPT-6 / Claude efforts through as strings.
    const options = { reasoningEffort: "xhigh", tools } as unknown as ProviderOptions;
    for await (const chunk of moonshotProvider.generateTextStream(conversation, "kimi-k3", options)) {
      chunks.push(chunk as StreamChunk);
    }

    expect(stream).toHaveLength(1);
    const { body } = stream[0];
    expect(cacheControlPaths(body)).toEqual(["$.cache_control"]);
    expect((body.output_config as { effort?: string }).effort).toBe("max");
    expect(body).not.toHaveProperty("temperature");

    const text = chunks.filter((chunk) => typeof chunk === "string").join("");
    expect(text).toBe("Hello!");
    const signed = JSON.stringify(chunks);
    expect(signed).toContain("kimi-signature-1");
  });

  it("replays a signed thinking block unchanged on the next request", async () => {
    const { create } = fakeKimiClient();
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Hello!",
        thinkingBlocks: [{ type: "thinking", thinking: "The user says hi.", signature: "kimi-signature-1" }],
      } as ChatMessage,
      { role: "user", content: "and again" },
    ];
    await moonshotProvider.generateText(history, "kimi-k3", {});
    const messages = create[0].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistant = messages.find((message) => message.role === "assistant");
    expect(assistant?.content[0]).toEqual({
      type: "thinking",
      thinking: "The user says hi.",
      signature: "kimi-signature-1",
    });
  });
});

describe("adaptKimiPayload", () => {
  it("moves caching to the top level with the configured TTL and strips nested markers", () => {
    const adapted = adaptKimiPayload(
      {
        model: "kimi-k3",
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
          },
        ],
        tools: [
          { name: "a", input_schema: { type: "object" }, cache_control: { type: "ephemeral" }, eager_input_streaming: true },
          { type: "web_search_20260209", name: "web_search" },
        ],
        tool_choice: { type: "tool", name: "a" },
        temperature: 0.3,
        thinking: { type: "adaptive" },
      },
      { cacheTtl: "1h" },
    );
    expect(cacheControlPaths(adapted)).toEqual(["$.cache_control"]);
    expect(adapted.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(adapted.tools).toEqual([{ name: "a", input_schema: { type: "object" } }]);
    expect(adapted.tool_choice).toEqual({ type: "any" });
    expect(adapted).not.toHaveProperty("temperature");
    expect(adapted).not.toHaveProperty("thinking");
    expect(adapted).not.toHaveProperty("metadata");
  });

  it("maps every effort onto low | high | max", () => {
    expect(["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(kimiEffort)).toEqual([
      "low",
      "low",
      "low",
      "high",
      "high",
      "max",
      "max",
    ]);
    expect(kimiEffort(undefined)).toBeUndefined();
  });

  it("builds its client against the Kimi base URL with Bearer auth", () => {
    const client = createKimiAnthropicClient("sk-kimi-test");
    expect(client.baseURL).toBe(KIMI_ANTHROPIC_BASE_URL);
    expect(client.authToken).toBe("sk-kimi-test");
    expect(client.apiKey).toBeNull();
  });
});

describe("Kimi on the OpenAI-compatible fallback path (MOONSHOT_TRANSPORT=openai)", () => {
  it("sends no sampling parameters for K3", () => {
    const payload = buildMoonshotPayload(conversation, "kimi-k3", { temperature: 0.2, topP: 0.4 }, false);
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("top_p");
  });

  it("keeps the 0.6 default for K2.6", () => {
    expect(buildMoonshotPayload(conversation, "kimi-k2.6", {}, false).temperature).toBe(0.6);
  });
});

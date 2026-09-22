/**
 * Ollama tool calling through /api/chat `tools` / `tool_calls`.
 *
 * The provider used to drop `options.tools` and the tool history on the
 * floor, so a model labelled "Tool Calling" could never call one. These
 * tests pin the wire format both ways: the request carries the tool
 * definitions and the previous round's calls and results in Ollama's shape,
 * and the calls Ollama returns come back out as the `toolCall` chunks every
 * other provider emits.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import "./setup.ts";
import { createOllamaProvider } from "#src/providers/ollama";
import { normalizeOllamaModel } from "#src/services/local-provider/normalizers";
import type { ChatMessage } from "#src/types/provider";
import type { ToolSchema } from "#src/services/harnesses/types";

vi.mock("#src/utils/ContextLengthDiscovery", () => ({
  discoverContextLength: vi.fn().mockResolvedValue(undefined),
}));

const BASE_URL = "http://localhost:11434";

const WEATHER_TOOL: ToolSchema = {
  name: "get_weather",
  description: "Current weather for a city",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
};

/** A conversation one tool round deep, as the harness hands it over. */
const HISTORY: ChatMessage[] = [
  { role: "user", content: "Weather in Paris and Rome?" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call_prev_1", name: "get_weather", args: { city: "Paris" } },
    ],
  },
  {
    role: "tool",
    name: "get_weather",
    tool_call_id: "call_prev_1",
    content: '{"tempC":18}',
  },
];

function ndjson(lines: unknown[]) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(line) + "\n"));
      }
      controller.close();
    },
  });
}

type FetchCall = { url: string; body: any };

describe("Ollama provider tool calling", () => {
  let fetchCalls: FetchCall[];
  let chatResponses: Array<() => unknown>;

  beforeEach(() => {
    fetchCalls = [];
    chatResponses = [];
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url, body });
      if (url.endsWith("/api/ps")) {
        return { ok: true, json: async () => ({ models: [] }) } as Response;
      }
      if (url.endsWith("/api/chat")) {
        const next = chatResponses.shift();
        if (!next) throw new Error("unexpected /api/chat call");
        return next() as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  const chatBodies = () =>
    fetchCalls.filter((call) => call.url.endsWith("/api/chat")).map((call) => call.body);

  it("streams: sends tools + tool history, emits the returned calls as toolCall chunks", async () => {
    chatResponses.push(() => ({
      ok: true,
      body: ndjson([
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "get_weather", arguments: { city: "Rome" } } },
              {
                id: "call_srv_2",
                function: { name: "get_weather", arguments: { city: "Milan" } },
              },
            ],
          },
          done: false,
        },
        { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 40, eval_count: 12 },
      ]),
    }));

    const provider = createOllamaProvider(BASE_URL);
    const chunks: any[] = [];
    for await (const chunk of provider.generateTextStream(HISTORY, "qwen3:8b", {
      tools: [WEATHER_TOOL],
    })) {
      chunks.push(chunk);
    }

    const [body] = chatBodies();
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Current weather for a city",
          parameters: WEATHER_TOOL.parameters,
        },
      },
    ]);
    // Previous round: Ollama wants arguments as an object, and the tool
    // result names the tool it answers.
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_prev_1",
          function: { name: "get_weather", arguments: { city: "Paris" } },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: '{"tempC":18}',
      tool_name: "get_weather",
      tool_call_id: "call_prev_1",
    });

    const toolCalls = chunks.filter((chunk) => chunk?.type === "toolCall");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      type: "toolCall",
      name: "get_weather",
      args: { city: "Rome" },
    });
    // Ollama may omit an id; every call still gets a unique one so its
    // result can be matched back to it.
    expect(typeof toolCalls[0].id).toBe("string");
    expect(toolCalls[0].id.length).toBeGreaterThan(0);
    expect(toolCalls[1]).toEqual({
      type: "toolCall",
      id: "call_srv_2",
      name: "get_weather",
      args: { city: "Milan" },
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "usage", usage: expect.objectContaining({ inputTokens: 40, outputTokens: 12 }) }),
    );
  });

  it("non-streaming: returns the calls on result.toolCalls", async () => {
    chatResponses.push(() => ({
      ok: true,
      json: async () => ({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "get_weather", arguments: { city: "Oslo" } } },
          ],
        },
        prompt_eval_count: 30,
        eval_count: 8,
      }),
    }));

    const provider = createOllamaProvider(BASE_URL);
    const result = await provider.generateText(
      [{ role: "user", content: "Weather in Oslo?" }],
      "qwen3:8b",
      { tools: [WEATHER_TOOL] },
    );

    expect(chatBodies()[0].tools).toHaveLength(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      name: "get_weather",
      args: { city: "Oslo" },
    });
    expect(typeof result.toolCalls![0].id).toBe("string");
  });

  it("sends no tools key when the request has no tools", async () => {
    chatResponses.push(() => ({
      ok: true,
      json: async () => ({ message: { role: "assistant", content: "hi" } }),
    }));

    const provider = createOllamaProvider(BASE_URL);
    await provider.generateText([{ role: "user", content: "hi" }], "qwen3:8b");

    expect(chatBodies()[0]).not.toHaveProperty("tools");
  });

  it("retries without tools when the model's template has none", async () => {
    // Ollama answers 400 "<model> does not support tools" — the model runs
    // tool-less, exactly as every Ollama turn did before tools were wired.
    chatResponses.push(() => ({
      ok: false,
      status: 400,
      text: async () =>
        '{"error":"registry.ollama.ai/library/gemma3:4b does not support tools"}',
    }));
    chatResponses.push(() => ({
      ok: true,
      json: async () => ({ message: { role: "assistant", content: "It is sunny." } }),
    }));

    const provider = createOllamaProvider(BASE_URL);
    const result = await provider.generateText(
      [{ role: "user", content: "Weather?" }],
      "gemma3:4b",
      { tools: [WEATHER_TOOL] },
    );

    const bodies = chatBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools).toHaveLength(1);
    expect(bodies[1]).not.toHaveProperty("tools");
    expect(result.text).toBe("It is sunny.");
  });
});

describe("Ollama capability detection", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: "gemma3:4b", model: "gemma3:4b", digest: "d1", size: 1 },
              { name: "granite4:micro", model: "granite4:micro", digest: "d2", size: 1 },
            ],
          }),
        } as Response;
      }
      if (url.endsWith("/api/ps")) {
        return { ok: true, json: async () => ({ models: [] }) } as Response;
      }
      if (url.endsWith("/api/show")) {
        const { model } = JSON.parse(String(init?.body));
        const capabilities =
          model === "gemma3:4b" ? ["completion", "vision"] : ["completion", "tools"];
        return { ok: true, json: async () => ({ capabilities }) } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  it("labels Tool Calling from what Ollama reports, not from the model name", async () => {
    const provider = createOllamaProvider(BASE_URL);
    const { models } = await provider.listModels!();
    const entries = models.map((raw) => normalizeOllamaModel(raw as never));

    const gemma = entries.find((entry) => entry.name === "gemma3:4b")!;
    const granite = entries.find((entry) => entry.name === "granite4:micro")!;
    // "gemma" matches the name patterns, but its template has no tools.
    expect(gemma.tools ?? []).not.toContain("Tool Calling");
    // "granite" matches no pattern, but Ollama says it takes tools.
    expect(granite.tools).toContain("Tool Calling");
  });
});

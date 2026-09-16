/**
 * OpenAI Responses API — provider-native state on the wire.
 *
 * Mocks the SDK client and asserts, for both the streaming and the
 * non-streaming path:
 *   - every request carries `include: ["reasoning.encrypted_content"]`
 *   - `previousResponseId` maps to `previous_response_id`
 *   - `response.id`, message `phase`, reasoning `encrypted_content` and
 *     reasoning items no function call claimed are all captured
 *   - gpt-6-astra never receives sampling parameters, even for "none"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());

vi.mock("openai", () => {
  class OpenAIMock {
    responses = { create: createMock };
    constructor(_options: unknown) {}
  }
  return { default: OpenAIMock, toFile: vi.fn() };
});

vi.mock("#config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, OPENAI_API_KEY: "test-key" };
});

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
    provider: vi.fn(),
  },
}));

import openaiProvider from "#src/providers/openai";

const REASONING_MODEL = "gpt-5.6-sol";

function nonStreamResponse(output: unknown[], id = "resp_123") {
  return {
    withResponse: async () => ({
      data: {
        id,
        output,
        output_text: "Hello.",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      response: { headers: new Headers() },
    }),
  };
}

function streamResponse(events: unknown[]) {
  async function* iterate() {
    for (const event of events) yield event;
  }
  return {
    withResponse: async () => ({
      data: iterate(),
      response: { headers: new Headers() },
    }),
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

beforeEach(() => {
  createMock.mockReset();
});

describe("Responses request payload", () => {
  it("non-stream: asks for encrypted reasoning and forwards previous_response_id", async () => {
    createMock.mockReturnValue(nonStreamResponse([]));
    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      REASONING_MODEL,
      { previousResponseId: "resp_prev" },
    );
    expect(createMock).toHaveBeenCalledTimes(1);
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    expect(payload.previous_response_id).toBe("resp_prev");
    expect(payload.stream).toBeUndefined();
  });

  it("stream: asks for encrypted reasoning; no previous_response_id unless given", async () => {
    createMock.mockReturnValue(streamResponse([]));
    await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        REASONING_MODEL,
        {},
      ),
    );
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.stream).toBe(true);
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    expect("previous_response_id" in payload).toBe(false);
  });

  it("keeps store opt-in: absent by default, false only when asked", async () => {
    createMock.mockReturnValue(nonStreamResponse([]));
    await openaiProvider.generateText([{ role: "user", content: "hi" }], REASONING_MODEL, {});
    expect("store" in (createMock.mock.calls[0][0] as object)).toBe(false);

    createMock.mockReturnValue(nonStreamResponse([]));
    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      REASONING_MODEL,
      { store: false },
    );
    expect((createMock.mock.calls[1][0] as { store?: boolean }).store).toBe(false);
  });

  it("gpt-6-astra: 'none' sends neither reasoning.effort nor sampling parameters", async () => {
    createMock.mockReturnValue(nonStreamResponse([]));
    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-6-astra",
      { reasoningEffort: "none", temperature: 0.2, topP: 0.9 },
    );
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.model).toBe("gpt-6-astra");
    expect(payload.reasoning).toBeUndefined();
    expect("temperature" in payload).toBe(false);
    expect("top_p" in payload).toBe(false);
  });

  it("gpt-6-astra: forwards xhigh and max", async () => {
    for (const level of ["xhigh", "max"] as const) {
      createMock.mockReturnValue(nonStreamResponse([]));
      await openaiProvider.generateText(
        [{ role: "user", content: "hi" }],
        "gpt-6-astra",
        { reasoningEffort: level as "high" },
      );
    }
    const efforts = createMock.mock.calls.map(
      (call) => (call[0] as { reasoning?: { effort?: string } }).reasoning?.effort,
    );
    expect(efforts).toEqual(["xhigh", "max"]);
  });
});

describe("Responses non-stream capture", () => {
  it("captures response.id, phase, paired encrypted reasoning and unpaired reasoning items", async () => {
    createMock.mockReturnValue(
      nonStreamResponse(
        [
          {
            type: "reasoning",
            id: "rs_paired",
            summary: [{ type: "summary_text", text: "Need a tool." }],
            encrypted_content: "enc-paired",
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "search",
            arguments: "{\"q\":\"x\"}",
          },
          {
            type: "reasoning",
            id: "rs_tail",
            summary: [],
            encrypted_content: "enc-tail",
          },
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "Hello." }],
          },
        ],
        "resp_abc",
      ),
    );

    const result = (await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      REASONING_MODEL,
      {},
    )) as Record<string, unknown>;

    expect(result.providerResponseId).toBe("resp_abc");
    expect(result.phase).toBe("final_answer");
    const toolCalls = result.toolCalls as Array<{
      id: string;
      responsesItemId: string;
      reasoningItem?: { id: string; encrypted_content?: string };
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("call_1");
    expect(toolCalls[0].responsesItemId).toBe("fc_1");
    expect(toolCalls[0].reasoningItem?.id).toBe("rs_paired");
    expect(toolCalls[0].reasoningItem?.encrypted_content).toBe("enc-paired");
    expect(result.reasoningItems).toEqual([
      { id: "rs_tail", summary: [], encrypted_content: "enc-tail" },
    ]);
  });

  it("leaves phase/reasoningItems absent when the model emits neither", async () => {
    createMock.mockReturnValue(
      nonStreamResponse([
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello." }],
        },
      ]),
    );
    const result = (await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      REASONING_MODEL,
      {},
    )) as Record<string, unknown>;
    expect(result.providerResponseId).toBe("resp_123");
    expect("phase" in result).toBe(false);
    expect("reasoningItems" in result).toBe(false);
  });
});

describe("Responses stream capture", () => {
  it("captures response.id, phase, encrypted reasoning on the tool call, and unpaired reasoning at completion", async () => {
    createMock.mockReturnValue(
      streamResponse([
        { type: "response.created", response: { id: "resp_stream" } },
        {
          type: "response.output_item.added",
          item: { type: "reasoning", id: "rs_1", summary: [] },
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          delta: "Need a tool.",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Need a tool." }],
            encrypted_content: "enc-1",
          },
        },
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "search" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: "{\"q\":\"x\"}",
        },
        {
          type: "response.output_item.added",
          item: { type: "reasoning", id: "rs_2", summary: [] },
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_2",
          delta: "Now answer.",
        },
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_1", role: "assistant", phase: "final_answer", content: [] },
        },
        { type: "response.output_text.delta", delta: "Hello." },
        {
          type: "response.completed",
          response: {
            id: "resp_stream",
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 5 },
            output: [
              { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Need a tool." }], encrypted_content: "enc-1" },
              { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: "{}" },
              { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "enc-2" },
              { type: "message", id: "msg_1", role: "assistant", phase: "final_answer", content: [] },
            ],
          },
        },
      ]),
    );

    const chunks = (await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        REASONING_MODEL,
        {},
      ),
    )) as Array<Record<string, unknown>>;

    const toolCall = chunks.find((chunk) => chunk.type === "toolCall") as {
      id: string;
      responsesItemId: string;
      reasoningItem?: { id: string; summary: unknown[]; encrypted_content?: string };
    };
    expect(toolCall.id).toBe("call_1");
    expect(toolCall.responsesItemId).toBe("fc_1");
    expect(toolCall.reasoningItem?.id).toBe("rs_1");
    expect(toolCall.reasoningItem?.encrypted_content).toBe("enc-1");
    expect(toolCall.reasoningItem?.summary).toEqual([
      { type: "summary_text", text: "Need a tool." },
    ]);

    const providerStates = chunks.filter((chunk) => chunk.type === "providerState");
    expect(providerStates[0]).toEqual({ type: "providerState", providerResponseId: "resp_stream" });
    expect(providerStates.some((chunk) => chunk.phase === "final_answer")).toBe(true);

    const finalState = providerStates[providerStates.length - 1] as {
      providerResponseId?: string;
      phase?: string;
      reasoningItems?: Array<{ id: string; summary: unknown[]; encrypted_content?: string }>;
    };
    expect(finalState.providerResponseId).toBe("resp_stream");
    expect(finalState.phase).toBe("final_answer");
    // rs_2 was never paired: its encrypted_content came from the completed
    // response and its summary from the streamed deltas.
    expect(finalState.reasoningItems).toEqual([
      {
        id: "rs_2",
        summary: [{ type: "summary_text", text: "Now answer." }],
        encrypted_content: "enc-2",
      },
    ]);
    expect(chunks).toContain("Hello.");
  });

  it("emits a bare providerState at completion when nothing native was produced", async () => {
    createMock.mockReturnValue(
      streamResponse([
        { type: "response.output_text.delta", delta: "Hi" },
        {
          type: "response.completed",
          response: { id: "resp_plain", status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
        },
      ]),
    );
    const chunks = (await collect(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], REASONING_MODEL, {}),
    )) as Array<Record<string, unknown>>;
    const states = chunks.filter((chunk) => chunk.type === "providerState");
    expect(states).toEqual([{ type: "providerState", providerResponseId: "resp_plain" }]);
  });
});

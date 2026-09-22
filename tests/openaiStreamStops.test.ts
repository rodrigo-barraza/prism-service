/**
 * OpenAI streaming: how a response ends, and what the request may carry.
 *
 * - A Responses stream that ends in `response.incomplete` (the output token
 *   cap, or a content filter) carries the same usage and output as
 *   `response.completed`. Only `completed` was read, so an incomplete turn
 *   reported zero usage, dropped its reasoning items and never told the
 *   harness it was truncated.
 * - The Chat Completions stream forwarded the global reasoning-effort
 *   setting verbatim; a level the model does not declare is a hard 400.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import "./setup.ts";
import openaiProvider from "#src/providers/openai";

const mockResponsesCreate = vi.fn();
const mockChatCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (...args: unknown[]) => mockResponsesCreate(...args),
    };
    chat = {
      completions: {
        create: (...args: unknown[]) => mockChatCreate(...args),
      },
    };
  },
  toFile: async () => ({}),
}));

function streamOf(events: unknown[]) {
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
  return {
    withResponse: async () => ({
      data: iterable,
      response: { headers: { get: () => null } },
    }),
  };
}

async function collect(stream: AsyncIterable<unknown>) {
  const chunks: any[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function incompleteResponseEvents(reason: string) {
  return [
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.added",
      item: { type: "reasoning", id: "rs_1", summary: [] },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      delta: "Planning the answer",
    },
    {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_1", phase: "final_answer" },
    },
    { type: "response.output_text.delta", delta: "The first half" },
    {
      type: "response.incomplete",
      response: {
        id: "resp_1",
        status: "incomplete",
        incomplete_details: { reason },
        usage: {
          input_tokens: 500,
          output_tokens: 64,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 40 },
        },
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Planning the answer" }],
            encrypted_content: "enc-rs-1",
          },
          {
            type: "message",
            id: "msg_1",
            phase: "final_answer",
            content: [{ type: "output_text", text: "The first half" }],
          },
        ],
      },
    },
  ];
}

describe("OpenAI Responses stream ending in response.incomplete", () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
  });

  it("keeps usage and reasoning items, and reports a length stop", async () => {
    mockResponsesCreate.mockReturnValue(
      streamOf(incompleteResponseEvents("max_output_tokens")),
    );

    const chunks = await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "long answer please" }],
        "gpt-5.5",
        { maxTokens: 64 },
      ),
    );

    expect(chunks).toContain("The first half");
    expect(chunks).toContainEqual({
      type: "usage",
      usage: {
        inputTokens: 400,
        outputTokens: 64,
        cacheReadInputTokens: 100,
        reasoningOutputTokens: 40,
      },
    });
    const reasoningState = chunks.find(
      (chunk) => chunk?.type === "providerState" && chunk.reasoningItems,
    );
    expect(reasoningState?.reasoningItems).toEqual([
      {
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Planning the answer" }],
        encrypted_content: "enc-rs-1",
      },
    ]);
    expect(chunks).toContainEqual({ type: "stopReason", stopReason: "length" });
  });

  it("reports a content-filter stop as such, not as truncation", async () => {
    mockResponsesCreate.mockReturnValue(
      streamOf(incompleteResponseEvents("content_filter")),
    );

    const chunks = await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "something filtered" }],
        "gpt-5.5",
      ),
    );

    const stops = chunks.filter((chunk) => chunk?.type === "stopReason");
    // "length" would send the harness into truncation recovery, which
    // re-asks for a continuation the filter will stop again.
    expect(stops).toEqual([
      { type: "stopReason", stopReason: "content_filter" },
    ]);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "usage",
        usage: expect.objectContaining({ outputTokens: 64 }),
      }),
    );
  });
});

describe("OpenAI Chat Completions stream reasoning effort", () => {
  beforeEach(() => {
    mockChatCreate.mockReset();
    mockChatCreate.mockReturnValue(
      streamOf([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      ]),
    );
  });

  it("drops an effort level the model does not declare", async () => {
    // gpt-5-mini is a Chat Completions reasoning model declaring
    // low/medium/high; "xhigh" (valid on gpt-5.4+) and "max" (Anthropic's)
    // are the global setting following the user onto it.
    for (const level of ["xhigh", "max", "none"]) {
      mockChatCreate.mockClear();
      await collect(
        openaiProvider.generateTextStream(
          [{ role: "user", content: "hi" }],
          "gpt-5-mini",
          { reasoningEffort: level },
        ),
      );
      const payload = mockChatCreate.mock.calls[0][0];
      expect(payload.reasoning_effort, level).toBeUndefined();
    }
  });

  it("still forwards a level the model declares", async () => {
    await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "gpt-5-mini",
        { reasoningEffort: "high" },
      ),
    );
    expect(mockChatCreate.mock.calls[0][0].reasoning_effort).toBe("high");
  });
});

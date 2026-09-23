/**
 * PROTOTYPE — Gemini over the Interactions API (GEMINI_TRANSPORT=interactions).
 * Which requests it takes (a new conversation, or one that continues its
 * chain) and which it hands back to generateContent; the events it turns
 * into Prism's stream chunks; the chain it continues next time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  _clearInteractionChains,
  planInteractionRequest,
  streamOverInteractions,
} from "#src/providers/google-interactions";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function interactionsClient(eventsPerCall: Array<Array<Record<string, unknown>>>) {
  const create = vi.fn().mockImplementation(async () => {
    const events = eventsPerCall.shift() ?? [];
    return (async function* () {
      for (const event of events) yield event;
    })();
  });
  return { client: { interactions: { create } } as never, create };
}

async function collect(stream: AsyncIterable<unknown> | null) {
  const chunks: unknown[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  return chunks;
}

const callTurn = (interactionId: string, callId: string) => [
  { event_type: "interaction.created", interaction: { id: interactionId, status: "created" } },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.delta", index: 0, delta: { type: "thought", text: "Check stock." } },
  { event_type: "step.stop", index: 0 },
  {
    event_type: "step.start",
    index: 1,
    step: { type: "function_call", id: callId, name: "get_stock", arguments: { widget: 7 } },
  },
  { event_type: "step.stop", index: 1 },
  {
    event_type: "interaction.completed",
    interaction: {
      id: interactionId,
      status: "requires_action",
      usage: { total_input_tokens: 22418, total_cached_tokens: 16345, total_output_tokens: 14, total_thought_tokens: 6 },
    },
  },
];

beforeEach(() => _clearInteractionChains());

describe("planInteractionRequest", () => {
  it("takes a conversation with no model turn as user_input steps", () => {
    expect(planInteractionRequest("conv", [{ role: "user", content: "hi" }])).toEqual({
      previousInteractionId: null,
      steps: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }],
    });
  });

  it("hands a history it has no chain for back to generateContent", () => {
    expect(
      planInteractionRequest("conv", [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ]),
    ).toBeNull();
  });
});

describe("streamOverInteractions", () => {
  it("maps events to chunks, then continues the chain with only the function result", async () => {
    const { client, create } = interactionsClient([
      callTurn("int_1", "call_7"),
      [
        { event_type: "interaction.created", interaction: { id: "int_2" } },
        { event_type: "step.start", index: 0, step: { type: "model_output" } },
        { event_type: "step.delta", index: 0, delta: { type: "text", text: "Stock is 77." } },
        { event_type: "step.stop", index: 0 },
        {
          event_type: "interaction.completed",
          interaction: { id: "int_2", usage: { total_input_tokens: 22450, total_cached_tokens: 20408, total_output_tokens: 5 } },
        },
      ],
    ]);
    const options = { promptCacheKey: "conv-1" };
    const settings = {
      systemInstruction: "You are a stock agent.",
      tools: [{ name: "get_stock", parameters: { type: "object", properties: { widget: { type: "integer" } } } }],
      thinkingLevel: "low",
    };
    const history: Array<Record<string, unknown>> = [{ role: "user", content: "stock of 7?" }];

    const first = await collect(streamOverInteractions(client, history as never, "gemini-3.8-flash", options, settings));
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "gemini-3.8-flash",
      stream: true,
      system_instruction: "You are a stock agent.",
      input: [{ type: "user_input", content: [{ type: "text", text: "stock of 7?" }] }],
      tools: [{ type: "function", name: "get_stock" }],
      generation_config: { thinking_level: "low" },
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty("previous_interaction_id");
    expect(first).toEqual([
      { type: "thinking", content: "Check stock." },
      { type: "toolCallStart", id: "call_7", name: "get_stock" },
      { type: "toolCall", id: "call_7", name: "get_stock", args: { widget: 7 } },
      {
        type: "usage",
        usage: { inputTokens: 6073, outputTokens: 20, cacheReadInputTokens: 16345, reasoningOutputTokens: 6 },
      },
    ]);

    // The harness replays the model's turn and appends the tool result.
    history.push({ role: "assistant", content: "", toolCalls: [{ id: "call_7", name: "get_stock", args: { widget: 7 } }] });
    history.push({ role: "tool", tool_call_id: "call_7", name: "get_stock", content: "stock=77" });
    const second = await collect(streamOverInteractions(client, history as never, "gemini-3.8-flash", options, settings));
    expect(create.mock.calls[1][0]).toMatchObject({
      previous_interaction_id: "int_1",
      input: [
        { type: "function_result", call_id: "call_7", name: "get_stock", result: [{ type: "text", text: "stock=77" }] },
      ],
      // Interaction-scoped settings are re-sent every time.
      system_instruction: "You are a stock agent.",
      tools: [{ type: "function", name: "get_stock" }],
    });
    expect(second).toContain("Stock is 77.");
  });

  it("reads streamed arguments in the shape the API sends live (arguments_delta)", async () => {
    const { client } = interactionsClient([
      [
        { event_type: "interaction.created", interaction: { id: "int_1" } },
        {
          event_type: "step.start",
          index: 1,
          step: { id: "call_9", type: "function_call", name: "get_stock", arguments: {} },
        },
        { event_type: "step.delta", index: 1, delta: { type: "arguments_delta", arguments: "{\"widget\":7}" } },
        { event_type: "step.stop", index: 1 },
        { event_type: "interaction.completed", interaction: { id: "int_1", usage: {} } },
      ],
    ]);
    const chunks = await collect(
      streamOverInteractions(client, [{ role: "user", content: "7?" }] as never, "gemini-3.8-flash", {}, {}),
    );
    expect(chunks).toContainEqual({ type: "toolCall", id: "call_9", name: "get_stock", args: { widget: 7 } });
  });

  it("returns null (generateContent) when the history was rewritten", async () => {
    const { client } = interactionsClient([callTurn("int_1", "call_7")]);
    await collect(
      streamOverInteractions(client, [{ role: "user", content: "stock of 7?" }] as never, "gemini-3.8-flash", { promptCacheKey: "conv-2" }, {}),
    );
    expect(
      streamOverInteractions(
        client,
        [
          { role: "user", content: "a different first message" },
          { role: "assistant", content: "" },
          { role: "user", content: "next" },
        ] as never,
        "gemini-3.8-flash",
        { promptCacheKey: "conv-2" },
        {},
      ),
    ).toBeNull();
  });
});

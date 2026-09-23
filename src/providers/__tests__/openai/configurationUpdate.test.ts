/**
 * GPT-6 per-turn effort: a change of effort mid-conversation is a
 * `configuration_update` input item, never a change of the request-level
 * `reasoning.effort` (which is part of the cached prefix).
 *
 *   - planResponsesEffort: where each update goes, from the effort every
 *     assistant message recorded (`responsesEffort`)
 *   - request shape (mocked SDK): the item is in the input, the top-level
 *     effort is the conversation's first, sampling follows the effort in
 *     effect, and the response records its effort for the next replay
 *   - prefix stability: across an effort change, each request's input is a
 *     prefix of the next one's
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

import openaiProvider, {
  planResponsesEffort,
  prepareResponsesInput,
  withConfigurationUpdates,
  type OpenAIMessage,
} from "#src/providers/openai";

const MODEL = "gpt-6-luna";

function streamResponse(id: string, text: string) {
  const events = [
    { type: "response.created", response: { id } },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  async function* iterate() {
    for (const event of events) yield event;
  }
  return {
    withResponse: async () => ({ data: iterate(), response: { headers: new Headers() } }),
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function inputOf(stream: AsyncIterable<unknown>) {
  return collect(stream).then((chunks) => ({
    chunks,
    payload: createMock.mock.calls.at(-1)![0] as Record<string, unknown> & {
      input: Array<Record<string, unknown>>;
      reasoning?: { effort?: string };
    },
  }));
}

const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

beforeEach(() => {
  createMock.mockReset();
});

describe("planResponsesEffort", () => {
  it("first request of a conversation: the effort goes top-level, no update", () => {
    const plan = planResponsesEffort(MODEL, [{ role: "user", content: "hi" }], "low");
    expect(plan).toEqual({ requestEffort: "low", effectiveEffort: "low", updates: new Map() });
  });

  it("a changed effort keeps the first one top-level and inserts an update before the new user message", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "one" },
      { role: "assistant", content: "a1", responsesEffort: "low" },
      { role: "user", content: "two" },
    ];
    const plan = planResponsesEffort(MODEL, messages, "high");
    expect(plan.requestEffort).toBe("low");
    expect(plan.effectiveEffort).toBe("high");
    expect([...plan.updates]).toEqual([[3, "high"]]);
  });

  it("a replay puts every earlier update back where it was first sent", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a1", responsesEffort: "low" },
      { role: "system", content: "<system-context>memories</system-context>" },
      { role: "user", content: "two" },
      { role: "assistant", content: "a2", responsesEffort: "high" },
      { role: "user", content: "three" },
    ];
    const plan = planResponsesEffort(MODEL, messages, "high");
    expect(plan.requestEffort).toBe("low");
    // Before "two" (after the injected context), and nothing new for "three".
    expect([...plan.updates]).toEqual([[3, "high"]]);
  });

  it("a change mid-turn (no new user message) goes at the end of the input", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: "",
        responsesEffort: "low",
        toolCalls: [{ id: "call_1", name: "read", args: {} }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const plan = planResponsesEffort(MODEL, messages, "medium");
    expect([...plan.updates]).toEqual([[3, "medium"]]);
  });

  it("a replay of a mid-turn change puts it right before the message it produced", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "one" },
      {
        role: "assistant",
        content: "",
        responsesEffort: "low",
        toolCalls: [{ id: "call_1", name: "read", args: {} }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "assistant", content: "done", responsesEffort: "medium" },
      { role: "user", content: "two" },
    ];
    const plan = planResponsesEffort(MODEL, messages, "medium");
    expect([...plan.updates]).toEqual([[3, "medium"]]);
  });

  it("never emits two adjacent updates (a 400), however often the effort changes", () => {
    // A change at every turn and mid-turn, then another for this request.
    const messages: OpenAIMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a1", responsesEffort: "low" },
      { role: "user", content: "two" },
      {
        role: "assistant",
        content: "",
        responsesEffort: "high",
        toolCalls: [{ id: "call_1", name: "read", args: {} }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      { role: "assistant", content: "a2", responsesEffort: "medium" },
    ];
    const plan = planResponsesEffort(MODEL, messages, "xhigh");
    expect([...plan.updates.values()]).toEqual(["high", "medium", "xhigh"]);
    const items = withConfigurationUpdates(messages, plan.updates, prepareResponsesInput);
    for (let index = 1; index < items.length; index++) {
      const adjacent =
        (items[index] as { type?: string }).type === "configuration_update" &&
        (items[index - 1] as { type?: string }).type === "configuration_update";
      expect(adjacent).toBe(false);
    }
  });

  it("ignores recorded efforts the model does not accept, and models without the feature", () => {
    const history: OpenAIMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a1", responsesEffort: "none" },
      { role: "user", content: "two" },
    ];
    // gpt-6-astra has no "none": the recorded effort is another model's.
    expect(planResponsesEffort("gpt-6-astra", history, "high")).toEqual({
      requestEffort: "high",
      effectiveEffort: "high",
      updates: new Map(),
    });
    // gpt-5.6-sol has no configuration_update: the effort goes top-level.
    expect(planResponsesEffort("gpt-5.6-sol", history, "high").updates.size).toBe(0);
    expect(planResponsesEffort("gpt-5.6-sol", history, "high").requestEffort).toBe("high");
  });
});

describe("configuration_update on the wire (gpt-6-luna)", () => {
  it("sends the update item and keeps the top-level effort", async () => {
    createMock.mockReturnValue(streamResponse("resp_2", "391"));
    const { payload } = await inputOf(
      openaiProvider.generateTextStream(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "a1", responsesEffort: "low" },
          { role: "user", content: "two" },
        ],
        MODEL,
        { reasoningEffort: "high" },
      ),
    );
    expect(payload.reasoning?.effort).toBe("low");
    expect(payload.input).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "a1" },
      update("high"),
      { role: "user", content: "two" },
    ]);
  });

  it("records the effort in effect on the response, for the next replay", async () => {
    createMock.mockReturnValue(streamResponse("resp_1", "hi"));
    const { chunks } = await inputOf(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], MODEL, {
        reasoningEffort: "medium",
      }),
    );
    const providerState = chunks.find(
      (chunk) =>
        typeof chunk === "object" &&
        (chunk as { type?: string }).type === "providerState" &&
        (chunk as { providerResponseId?: string }).providerResponseId === "resp_1" &&
        "responsesEffort" in (chunk as object),
    );
    expect(providerState).toMatchObject({ responsesEffort: "medium" });
  });

  it("does not record an effort on models without configuration_update", async () => {
    createMock.mockReturnValue(streamResponse("resp_1", "hi"));
    const { chunks } = await inputOf(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], "gpt-5.6-sol", {
        reasoningEffort: "medium",
      }),
    );
    expect(
      chunks.some((chunk) => typeof chunk === "object" && chunk !== null && "responsesEffort" in chunk),
    ).toBe(false);
  });

  it("thinking switched off is effort none on Sol/Luna, and no effort on Astra", async () => {
    createMock.mockReturnValue(streamResponse("resp_1", "hi"));
    const luna = await inputOf(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], MODEL, {
        thinkingEnabled: false,
        temperature: 0.3,
      }),
    );
    expect(luna.payload.reasoning?.effort).toBe("none");
    expect(luna.payload.temperature).toBe(0.3);

    createMock.mockReturnValue(streamResponse("resp_2", "hi"));
    const astra = await inputOf(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], "gpt-6-astra", {
        thinkingEnabled: false,
        temperature: 0.3,
      }),
    );
    expect(astra.payload.reasoning?.effort).toBeUndefined();
    expect(astra.payload.temperature).toBeUndefined();
  });

  it("gates sampling on the effort in effect, not the top-level one", async () => {
    // Top-level none + update high: temperature is a 400 (measured live).
    createMock.mockReturnValue(streamResponse("resp_2", "ok"));
    const history: OpenAIMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a1", responsesEffort: "none" },
      { role: "user", content: "two" },
    ];
    const toHigh = await inputOf(
      openaiProvider.generateTextStream(history, MODEL, {
        reasoningEffort: "high",
        temperature: 0.4,
      }),
    );
    expect(toHigh.payload.reasoning?.effort).toBe("none");
    expect(toHigh.payload.temperature).toBeUndefined();

    // Top-level high + update none: temperature is accepted.
    createMock.mockReturnValue(streamResponse("resp_3", "ok"));
    const toNone = await inputOf(
      openaiProvider.generateTextStream(
        [
          { role: "user", content: "one" },
          { role: "assistant", content: "a1", responsesEffort: "high" },
          { role: "user", content: "two" },
        ],
        MODEL,
        { reasoningEffort: "none", temperature: 0.4 },
      ),
    );
    expect(toNone.payload.reasoning?.effort).toBe("high");
    expect(toNone.payload.temperature).toBe(0.4);
  });

  it("keeps each request's input a prefix of the next across an effort change", async () => {
    // Turn 1 at low, turn 2 at high, turn 3 still at high.
    const history: OpenAIMessage[] = [{ role: "user", content: "one" }];
    const inputs: Array<Array<Record<string, unknown>>> = [];
    const efforts = ["low", "high", "high"];
    for (const [turn, effort] of efforts.entries()) {
      createMock.mockReturnValue(streamResponse(`resp_${turn}`, `a${turn}`));
      const { payload, chunks } = await inputOf(
        openaiProvider.generateTextStream([...history], MODEL, {
          reasoningEffort: effort as "low" | "high",
        }),
      );
      expect(payload.reasoning?.effort).toBe("low");
      inputs.push(payload.input);
      const recorded = chunks.find(
        (chunk) => typeof chunk === "object" && (chunk as { responsesEffort?: string }).responsesEffort,
      ) as { responsesEffort: string };
      history.push({ role: "assistant", content: `a${turn}`, responsesEffort: recorded.responsesEffort });
      history.push({ role: "user", content: `turn ${turn + 2}` });
    }
    for (let turn = 1; turn < inputs.length; turn++) {
      expect(inputs[turn].slice(0, inputs[turn - 1].length)).toEqual(inputs[turn - 1]);
    }
    expect(inputs[2].filter((item) => item.type === "configuration_update")).toEqual([
      update("high"),
    ]);
  });
});

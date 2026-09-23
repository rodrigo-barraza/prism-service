/**
 * GPT-6 async tool calling — Prism's detached dispatch (`run_async_task`)
 * as a native async call.
 *
 *   - the tool goes out with `"async": true` on models with the flag, never
 *     with programmatic tool calling, never on other models
 *   - the model's call comes back flagged `nativeAsync`
 *   - replay: the call stays pending (its immediate acknowledgement is not
 *     its output), and the completion delivered later becomes that call's
 *     `function_call_output` where it arrived; other models see the history
 *     unchanged
 *   - over the Responses WebSocket the later output goes out with
 *     `previous_response_id` and the new items only
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  markNativeAsyncTools,
  prepareResponsesInput,
  replayNativeAsyncCalls,
  resetResponsesSocketAvailability,
  type OpenAIMessage,
} from "#src/providers/openai";
import {
  setResponsesSocketFactory,
  type ResponsesSocket,
} from "#src/providers/openai-responses-socket";
import type OpenAI from "openai";

const MODEL = "gpt-6-luna";

const RUN_ASYNC_TASK = {
  name: "run_async_task",
  description: "Dispatch a tool to run in the background.",
  parameters: {
    type: "object",
    properties: { toolName: { type: "string" }, toolArguments: { type: "object" } },
    required: ["toolName", "toolArguments"],
  },
};
const READ_FILE = {
  name: "read_file",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** Every Responses stream ends with its terminal event. */
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);
const completedEvent = { type: "response.completed", response: { id: "resp_test", status: "completed", output: [] } };

function httpStream(events: unknown[]) {
  const ended = events.some((event) => TERMINAL_EVENTS.has((event as { type?: string }).type ?? ""));
  return {
    withResponse: async () => ({
      data: (async function* () {
        for (const event of events) yield event;
        if (!ended) yield completedEvent;
      })(),
      response: { headers: new Headers() },
    }),
  };
}

async function collect(stream: AsyncIterable<unknown>) {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A conversation where run_async_task was called natively and acknowledged. */
function dispatchedHistory(): OpenAIMessage[] {
  return [
    { role: "user", content: "Price WIDGET in the background; meanwhile a fun fact." },
    {
      role: "assistant",
      content: "Fun fact: widgets are placeholders. The price is on its way.",
      toolCalls: [
        {
          id: "call_async_1",
          name: "run_async_task",
          args: { toolName: "lookup_price", toolArguments: { sku: "WIDGET" } },
          responsesItemId: "fc_async_1",
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_async_1",
      content: JSON.stringify({
        _directive: "DETACHED_WORK",
        nativeAsyncCallId: "call_async_1",
        task: { taskId: "task-1", toolName: "lookup_price", status: "running" },
      }),
    },
  ];
}

const completion: OpenAIMessage = {
  role: "user",
  content: "<task-notification><result>{\"price\":12}</result></task-notification>",
  asyncCallId: "call_async_1",
};

beforeEach(() => {
  createMock.mockReset();
  resetResponsesSocketAvailability();
});

describe("run_async_task is declared async", () => {
  it("on a GPT-6 model — and only run_async_task", async () => {
    createMock.mockReturnValue(httpStream([]));
    await collect(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], MODEL, {
        tools: [RUN_ASYNC_TASK, READ_FILE],
      }),
    );
    const tools = createMock.mock.calls[0][0].tools as Array<Record<string, unknown>>;
    expect(tools.find((tool) => tool.name === "run_async_task")).toMatchObject({ async: true });
    expect(tools.find((tool) => tool.name === "read_file")).not.toHaveProperty("async");
  });

  it("never on a model without async tools", async () => {
    createMock.mockReturnValue(httpStream([]));
    await collect(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], "gpt-5.6-sol", {
        tools: [RUN_ASYNC_TASK],
      }),
    );
    const tools = createMock.mock.calls[0][0].tools as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty("async");
  });

  it("never alongside programmatic tool calling", () => {
    const tools = [
      { type: "programmatic_tool_calling" },
      { type: "function", name: "run_async_task", parameters: {}, strict: false },
    ] as unknown as OpenAI.Responses.Tool[];
    markNativeAsyncTools(tools, MODEL);
    expect(tools[1]).not.toHaveProperty("async");
  });
});

describe("the model's async call", () => {
  it("comes back flagged nativeAsync", async () => {
    createMock.mockReturnValue(
      httpStream([
        { type: "response.created", response: { id: "resp_1" } },
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_1", call_id: "call_async_1", name: "run_async_task", async: true },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: "{\"toolName\":\"lookup_price\",\"toolArguments\":{}}",
        },
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "fc_2", call_id: "call_sync", name: "read_file" },
        },
        { type: "response.function_call_arguments.done", item_id: "fc_2", arguments: "{\"path\":\"a\"}" },
        { type: "response.completed", response: { id: "resp_1", output: [], usage: {} } },
      ]),
    );
    const chunks = await collect(
      openaiProvider.generateTextStream([{ role: "user", content: "hi" }], MODEL, {
        tools: [RUN_ASYNC_TASK, READ_FILE],
      }),
    );
    const toolCalls = chunks.filter((chunk) => (chunk as { type?: string })?.type === "toolCall");
    expect(toolCalls[0]).toMatchObject({ id: "call_async_1", nativeAsync: true });
    expect(toolCalls[1]).not.toHaveProperty("nativeAsync");
  });
});

describe("replay of a native async call", () => {
  it("keeps the call pending until its result arrives, then returns it on the call id", () => {
    const pending = prepareResponsesInput(
      replayNativeAsyncCalls([...dispatchedHistory(), { role: "user", content: "and?" }], MODEL),
    );
    expect(pending.some((item) => (item as { type?: string }).type === "function_call")).toBe(true);
    expect(pending.some((item) => (item as { type?: string }).type === "function_call_output")).toBe(
      false,
    );

    const delivered = prepareResponsesInput(
      replayNativeAsyncCalls([...dispatchedHistory(), completion], MODEL),
    );
    expect(delivered.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_async_1",
      output: completion.content,
    });
    // Everything before the delivery is the same prefix as while pending.
    expect(delivered.slice(0, -1)).toEqual(pending.slice(0, -1));
  });

  it("leaves the history unchanged on a model without async tools", () => {
    const history = [...dispatchedHistory(), completion];
    expect(replayNativeAsyncCalls(history, "gpt-5.6-sol")).toBe(history);
    const items = prepareResponsesInput(history);
    expect(items.filter((item) => (item as { type?: string }).type === "function_call_output")).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ role: "user", content: completion.content });
  });

  it("only answers a call that is actually pending", () => {
    const stray: OpenAIMessage = { ...completion, asyncCallId: "call_other" };
    const replayed = replayNativeAsyncCalls([...dispatchedHistory(), stray], MODEL);
    expect(replayed.at(-1)).toEqual(stray);
  });
});

describe("the later output over the Responses WebSocket", () => {
  type Listener = (...args: never[]) => void;
  class FakeSocket implements ResponsesSocket {
    sent: Array<Record<string, unknown>> = [];
    private listeners = new Map<string, Set<Listener>>();
    private responses = 0;
    send(event: object): void {
      this.sent.push(event as Record<string, unknown>);
      if ((event as { type: string }).type !== "response.create") return;
      const id = `resp_${++this.responses}`;
      setTimeout(() => {
        for (const serverEvent of [
          { type: "response.created", response: { id } },
          { type: "response.completed", response: { id, output: [], usage: {} } },
        ]) {
          for (const listener of [...(this.listeners.get("event") ?? [])]) {
            (listener as (value: unknown) => void)(serverEvent);
          }
        }
      }, 0);
    }
    on(name: string, listener: Listener): this {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(listener);
      return this;
    }
    off(name: string, listener: Listener): this {
      this.listeners.get(name)?.delete(listener);
      return this;
    }
    close(): void {}
  }

  let socket: FakeSocket;
  beforeEach(() => {
    socket = new FakeSocket();
    setResponsesSocketFactory(() => socket);
  });
  afterEach(() => setResponsesSocketFactory(null));

  it("sends the function_call_output with previous_response_id", async () => {
    const options = { turnInputKey: "conv-async", tools: [RUN_ASYNC_TASK] } as never;
    // Turn 1: the model dispatches (its output is replayed next time).
    await collect(openaiProvider.generateTextStream(dispatchedHistory().slice(0, 1), MODEL, options));
    // The completion arrives: the call's output, on the same conversation.
    await collect(
      openaiProvider.generateTextStream([...dispatchedHistory(), completion], MODEL, options),
    );
    const creates = socket.sent.filter((event) => event.type === "response.create");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toMatchObject({
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_async_1", output: completion.content }],
    });
    expect((creates[1].tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "run_async_task",
      async: true,
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});

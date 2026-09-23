/**
 * GPT-6 native steering over the Responses WebSocket — request shapes
 * against a scripted fake socket (no network).
 *
 *   - a user_update posted to the TurnInputMailbox while a GPT-6 turn
 *     streams over the socket goes out as `response.steer` against the
 *     running response
 *   - accepted → the continuation carries it: the stream yields
 *     `turnInputApplied`, the mailbox never drains it, usage sums both
 *     responses and "steered" is not a truncation
 *   - pending (tool results needed) → the mailbox gets it back and the
 *     connection holding the queued steer is dropped
 *   - failed → the mailbox gets it back, the connection stays
 *   - an accepted steer that never resolves falls back after the settle time
 *   - continuation: the next request that extends the last exchange is sent
 *     as previous_response_id + new items; a rewritten history is sent whole
 *   - a socket that cannot connect falls back to the HTTP stream
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

import openaiProvider, { resetResponsesSocketAvailability } from "#src/providers/openai";
import {
  continuationTail,
  openResponsesSocketStream,
  setResponsesSocketFactory,
  type ResponsesSocket,
} from "#src/providers/openai-responses-socket";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import NativeSteerRegistry from "#src/services/NativeSteerRegistry";
import { SYSTEM_MESSAGE_TAGS, wrapSystemMessage } from "#src/utils/SystemMessageTags";

type Event = Record<string, unknown> & { type: string };
type Listener = (...args: never[]) => void;
type Server = (event: Event, socket: FakeSocket) => void;

/** A Responses WebSocket whose server side the test scripts. */
class FakeSocket implements ResponsesSocket {
  sent: Event[] = [];
  closed = false;
  private listeners = new Map<string, Set<Listener>>();
  private server: Server;
  constructor(server: Server) {
    this.server = server;
  }
  send(event: object): void {
    this.sent.push(event as Event);
    // The server answers asynchronously, like a network would.
    setTimeout(() => this.server(event as Event, this), 0);
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
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire("close", 1000, "OK");
  }
  fire(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
  emitEvents(events: Event[]): void {
    for (const event of events) this.fire("event", event);
  }
}

const created = (id: string, previous?: string): Event => ({
  type: "response.created",
  response: { id, status: "in_progress", previous_response_id: previous ?? null },
});
const delta = (text: string): Event => ({ type: "response.output_text.delta", delta: text });
const completed = (
  id: string,
  output: unknown[] = [],
  usage = { input_tokens: 10, output_tokens: 5 },
): Event => ({
  type: "response.completed",
  response: { id, status: "completed", output, usage },
});
const functionCall = (callId: string, name: string, args = "{}") => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: args,
});

const sockets: FakeSocket[] = [];
function useServer(server: (event: Event, socket: FakeSocket) => void) {
  setResponsesSocketFactory(() => {
    const socket = new FakeSocket(server);
    sockets.push(socket);
    return socket;
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const KEY = "conv-steer";
const MODEL = "gpt-6-luna";

beforeEach(() => {
  createMock.mockReset();
  sockets.length = 0;
  TurnInputMailbox._clearAll();
  NativeSteerRegistry._clearAll();
  resetResponsesSocketAvailability();
});

afterEach(() => {
  setResponsesSocketFactory(null);
});

/** Drive a GPT-6 stream; `during` runs once the first text delta arrived. */
async function streamWithInput(
  during: () => void | Promise<void>,
  options: Record<string, unknown> = {},
) {
  TurnInputMailbox.open(KEY);
  const chunks: unknown[] = [];
  let fired = false;
  for await (const chunk of openaiProvider.generateTextStream(
    [{ role: "user", content: "Write a plan." }],
    MODEL,
    { turnInputKey: KEY, reasoningEffort: "low", ...options } as never,
  )) {
    chunks.push(chunk);
    if (!fired && typeof chunk === "string" && chunk.length > 0) {
      fired = true;
      await during();
    }
  }
  return chunks;
}

describe("native steering — accepted", () => {
  it("sends response.steer against the running response and yields turnInputApplied before the continuation", async () => {
    useServer((event, socket) => {
      if (event.type === "response.create") {
        socket.emitEvents([created("resp_1"), delta("Plan: ")]);
      } else if (event.type === "response.steer") {
        socket.emitEvents([
          {
            type: "response.steer.accepted",
            steer: { id: "steer_1", previous_response_id: "resp_1" },
          },
          delta("1. Scope"),
          completed("resp_1", [], { input_tokens: 20, output_tokens: 8 }),
          created("resp_2", "resp_1"),
          delta(" 2. Risks: PURPLE"),
          completed("resp_2", [], { input_tokens: 40, output_tokens: 12 }),
        ]);
      }
    });

    let inputId = "";
    const chunks = await streamWithInput(() => {
      const posted = TurnInputMailbox.post(KEY, {
        kind: "user_update",
        text: "Also add a Risks section that mentions PURPLE.",
      });
      inputId = posted.id!;
    });

    // HTTP was never used.
    expect(createMock).not.toHaveBeenCalled();
    const socket = sockets[0];
    const create = socket.sent.find((event) => event.type === "response.create")!;
    expect(create).toMatchObject({ model: MODEL, reasoning: { effort: "low" } });
    expect(create).not.toHaveProperty("stream");
    const steer = socket.sent.find((event) => event.type === "response.steer");
    expect(steer).toEqual({
      type: "response.steer",
      previous_response_id: "resp_1",
      // The wrapper a drain would inject: one form of the update everywhere.
      input: wrapSystemMessage(
        SYSTEM_MESSAGE_TAGS.USER_UPDATE,
        "Also add a Risks section that mentions PURPLE.",
      ),
    });

    // The applied marker comes before the continuation's text.
    const appliedIndex = chunks.findIndex(
      (chunk) => (chunk as { type?: string })?.type === "turnInputApplied",
    );
    expect(chunks[appliedIndex]).toEqual({ type: "turnInputApplied", inputIds: [inputId] });
    expect(chunks.indexOf(" 2. Risks: PURPLE")).toBeGreaterThan(appliedIndex);
    expect(chunks.indexOf("1. Scope")).toBeLessThan(appliedIndex);

    // Held for the harness: never drained, taken by id.
    expect(TurnInputMailbox.drain(KEY)).toEqual([]);
    expect(TurnInputMailbox.pendingCount(KEY)).toBe(0);
    expect(TurnInputMailbox.take(KEY, [inputId]).map((entry) => entry.id)).toEqual([inputId]);

    // Usage of both responses; the last response id; no truncation.
    const usage = chunks.find((chunk) => (chunk as { type?: string })?.type === "usage") as {
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(usage.usage).toMatchObject({ inputTokens: 60, outputTokens: 20 });
    const lastState = chunks
      .filter(
        (chunk) =>
          (chunk as { type?: string })?.type === "providerState" &&
          (chunk as { providerResponseId?: string }).providerResponseId,
      )
      .at(-1) as { providerResponseId: string };
    expect(lastState.providerResponseId).toBe("resp_2");
    expect(chunks.some((chunk) => (chunk as { type?: string })?.type === "stopReason")).toBe(false);
    // The sender is gone once the stream ends.
    expect(NativeSteerRegistry.get(KEY)).toBeUndefined();
  });

  it("treats a response interrupted by the steer (incomplete: steered) as no truncation", async () => {
    useServer((event, socket) => {
      if (event.type === "response.create") {
        socket.emitEvents([created("resp_1"), delta("Plan")]);
      } else if (event.type === "response.steer") {
        socket.emitEvents([
          { type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } },
          {
            type: "response.incomplete",
            response: {
              id: "resp_1",
              status: "incomplete",
              incomplete_details: { reason: "steered" },
              output: [],
              usage: { input_tokens: 5, output_tokens: 1 },
            },
          },
          created("resp_2", "resp_1"),
          delta(" steered"),
          completed("resp_2"),
        ]);
      }
    });
    const chunks = await streamWithInput(() => {
      TurnInputMailbox.post(KEY, { kind: "user_update", text: "shorter" });
    });
    expect(chunks).toContain(" steered");
    expect(chunks.some((chunk) => (chunk as { type?: string })?.type === "stopReason")).toBe(false);
    expect(chunks.some((chunk) => (chunk as { type?: string })?.type === "turnInputApplied")).toBe(true);
  });
});

describe("native steering — fallback to the mailbox", () => {
  it("pending (tool results needed): released to the mailbox and the connection is dropped", async () => {
    useServer((event, socket) => {
      if (event.type === "response.create") {
        socket.emitEvents([created("resp_1"), delta("Checking")]);
      } else if (event.type === "response.steer") {
        socket.emitEvents([
          { type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } },
          completed("resp_1", [functionCall("call_1", "get_status")]),
          {
            type: "response.steer.pending",
            steer: { id: "steer_1", previous_response_id: "resp_1" },
            reason: "waiting_for_required_input",
            required_input: [{ type: "function_call_output", call_id: "call_1", name: "get_status" }],
          },
        ]);
      }
    });
    const chunks = await streamWithInput(() => {
      TurnInputMailbox.post(KEY, { kind: "user_update", text: "mention PURPLE" });
    });
    expect(chunks.some((chunk) => (chunk as { type?: string })?.type === "turnInputApplied")).toBe(false);
    await tick();
    const drained = TurnInputMailbox.drain(KEY);
    expect(drained.map((entry) => entry.text)).toEqual(["mention PURPLE"]);
    // The queued steer must not also be prepended to the next request.
    expect(sockets[0].closed).toBe(true);
  });

  it("failed: released to the mailbox, the connection stays", async () => {
    useServer((event, socket) => {
      if (event.type === "response.create") {
        socket.emitEvents([created("resp_1"), delta("Hi")]);
      } else if (event.type === "response.steer") {
        socket.emitEvents([
          {
            type: "response.steer.failed",
            steer: { input: event.input, previous_response_id: "resp_1" },
            error: { code: "steering_not_supported", message: "no" },
          },
          completed("resp_1"),
        ]);
      }
    });
    await streamWithInput(() => {
      TurnInputMailbox.post(KEY, { kind: "user_update", text: "change of plan" });
    });
    await tick();
    expect(TurnInputMailbox.drain(KEY).map((entry) => entry.text)).toEqual(["change of plan"]);
    expect(sockets[0].closed).toBe(false);
  });

  it("an accepted steer that never resolves falls back after the settle time", async () => {
    useServer((event, socket) => {
      if (event.type === "response.create") {
        socket.emitEvents([created("resp_1"), delta("Hi")]);
      } else if (event.type === "response.steer") {
        socket.emitEvents([
          { type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "resp_1" } },
          completed("resp_1"),
        ]);
      }
    });
    // Short settle time via the socket module directly.
    TurnInputMailbox.open(KEY);
    const events = await openResponsesSocketStream(
      KEY,
      { model: MODEL, input: [{ role: "user", content: "hi" }] },
      { steering: true, client: () => ({}) as never, settleMilliseconds: 20 },
    );
    const seen: string[] = [];
    let posted = false;
    for await (const event of events!) {
      seen.push(event.type);
      if (!posted && event.type === "response.output_text.delta") {
        posted = true;
        TurnInputMailbox.post(KEY, { kind: "user_update", text: "late" });
      }
    }
    expect(seen.at(-1)).toBe("response.completed");
    await tick();
    expect(TurnInputMailbox.drain(KEY).map((entry) => entry.text)).toEqual(["late"]);
    expect(sockets[0].closed).toBe(true);
  });

  it("images and non-update inputs never go native", async () => {
    const steer = vi.fn();
    NativeSteerRegistry.register(KEY, { steer });
    TurnInputMailbox.open(KEY);
    TurnInputMailbox.post(KEY, { kind: "user_update", text: "look", images: ["data:image/png;base64,AA"] });
    TurnInputMailbox.post(KEY, { kind: "task_completion", text: "<task-notification/>" });
    expect(steer).not.toHaveBeenCalled();
    expect(TurnInputMailbox.drain(KEY)).toHaveLength(2);
  });
});

describe("Responses WebSocket continuation", () => {
  const first = [{ role: "user", content: "one" }];

  it("sends previous_response_id + only the new items when the input extends the last exchange", async () => {
    let responses = 0;
    useServer((event, socket) => {
      if (event.type !== "response.create") return;
      responses++;
      const id = `resp_${responses}`;
      socket.emitEvents([created(id), delta("ok"), completed(id)]);
    });
    const run = async (input: unknown[]) => {
      const events = await openResponsesSocketStream(
        KEY,
        { model: MODEL, input },
        { steering: false, client: () => ({}) as never },
      );
      for await (const _event of events!) {
        /* drain */
      }
    };
    await run(first);
    const second = [
      ...first,
      { role: "assistant", content: "ok" },
      { type: "function_call_output", call_id: "call_async", output: "{\"price\":12}" },
      { role: "user", content: "two" },
    ];
    await run(second);
    const creates = sockets[0].sent.filter((event) => event.type === "response.create");
    expect(creates).toHaveLength(2);
    expect(creates[1]).toMatchObject({
      previous_response_id: "resp_1",
      input: [
        { type: "function_call_output", call_id: "call_async", output: "{\"price\":12}" },
        { role: "user", content: "two" },
      ],
    });
    // A history the harness rewrote is sent whole.
    await run([{ role: "user", content: "rewritten" }, { role: "assistant", content: "x" }, { role: "user", content: "three" }]);
    const third = sockets[0].sent.filter((event) => event.type === "response.create")[2];
    expect(third).not.toHaveProperty("previous_response_id");
    expect((third.input as unknown[]).length).toBe(3);
  });

  it("resends the whole input when the chain is gone (previous_response_not_found)", async () => {
    let responses = 0;
    useServer((event, socket) => {
      if (event.type !== "response.create") return;
      if (event.previous_response_id) {
        socket.emitEvents([
          {
            type: "error",
            status: 400,
            error: { type: "invalid_request_error", code: "previous_response_not_found", message: "gone" },
          },
        ]);
        return;
      }
      responses++;
      socket.emitEvents([created(`resp_${responses}`), completed(`resp_${responses}`)]);
    });
    const run = async (input: unknown[]) => {
      const events = await openResponsesSocketStream(
        KEY,
        { model: MODEL, input },
        { steering: false, client: () => ({}) as never },
      );
      for await (const _event of events!) {
        /* drain */
      }
    };
    await run(first);
    await run([...first, { role: "assistant", content: "ok" }, { role: "user", content: "two" }]);
    const creates = sockets[0].sent.filter((event) => event.type === "response.create");
    expect(creates).toHaveLength(3);
    expect(creates[1]).toHaveProperty("previous_response_id", "resp_1");
    expect(creates[2]).not.toHaveProperty("previous_response_id");
    expect((creates[2].input as unknown[]).length).toBe(3);
  });

  it("continuationTail: only output items may sit between the old input and the new items", () => {
    const previous = { input: [{ role: "user", content: "one" }], responseId: "resp_1" };
    expect(
      continuationTail(previous, [
        { role: "user", content: "one" },
        { type: "reasoning", id: "rs_1", summary: [] },
        functionCall("call_1", "read"),
        { type: "function_call_output", call_id: "call_1", output: "x" },
      ]),
    ).toEqual([{ type: "function_call_output", call_id: "call_1", output: "x" }]);
    // A user message right after the old input (e.g. a steer recorded
    // before the output) means the server's chain is not this history.
    expect(
      continuationTail(previous, [
        { role: "user", content: "one" },
        { role: "user", content: "<user-update>x</user-update>" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "two" },
      ]),
    ).toBeNull();
  });
});

describe("transport selection", () => {
  it("falls back to the HTTP stream when the socket cannot connect", async () => {
    setResponsesSocketFactory(() => {
      const socket = new FakeSocket(() => {});
      setTimeout(() => socket.fire("error", new Error("ECONNREFUSED")), 0);
      sockets.push(socket);
      return socket;
    });
    createMock.mockReturnValue({
      withResponse: async () => ({
        data: (async function* () {
          yield { type: "response.created", response: { id: "resp_http" } };
          yield { type: "response.output_text.delta", delta: "over http" };
          yield completed("resp_http");
        })(),
        response: { headers: new Headers() },
      }),
    });
    const chunks: unknown[] = [];
    for await (const chunk of openaiProvider.generateTextStream(
      [{ role: "user", content: "hi" }],
      MODEL,
      { turnInputKey: KEY } as never,
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toContain("over http");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("uses HTTP for models that cannot steer, and without a turn input key", async () => {
    useServer(() => {});
    createMock.mockReturnValue({
      withResponse: async () => ({
        data: (async function* () {
          yield completed("resp_http");
        })(),
        response: { headers: new Headers() },
      }),
    });
    for await (const _chunk of openaiProvider.generateTextStream(
      [{ role: "user", content: "hi" }],
      "gpt-5.6-sol",
      { turnInputKey: KEY } as never,
    )) {
      /* drain */
    }
    for await (const _chunk of openaiProvider.generateTextStream(
      [{ role: "user", content: "hi" }],
      MODEL,
      {},
    )) {
      /* drain */
    }
    expect(sockets).toHaveLength(0);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("uses HTTP when OPENAI_RESPONSES_TRANSPORT=http", async () => {
    useServer(() => {});
    vi.stubEnv("OPENAI_RESPONSES_TRANSPORT", "http");
    createMock.mockReturnValue({
      withResponse: async () => ({
        data: (async function* () {
          yield completed("resp_http");
        })(),
        response: { headers: new Headers() },
      }),
    });
    for await (const _chunk of openaiProvider.generateTextStream(
      [{ role: "user", content: "hi" }],
      MODEL,
      { turnInputKey: KEY } as never,
    )) {
      /* drain */
    }
    vi.unstubAllEnvs();
    expect(sockets).toHaveLength(0);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

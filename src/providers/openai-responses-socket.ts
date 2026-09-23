import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import logger from "#src/utils/logger";
import { ProviderError } from "#src/utils/errors";
import NativeSteerRegistry, {
  type NativeSteerOutcome,
  type NativeSteerSender,
} from "#src/services/NativeSteerRegistry";

/**
 * OpenAI Responses over WebSocket (`wss://…/v1/responses`) — the transport
 * for GPT-6 turns that can be steered natively.
 *
 * One connection per loop key, reused across the iterations and turns of a
 * conversation (connections live up to 60 minutes; this module rotates at
 * 50 and closes after 10 idle). Requests on a connection are strictly
 * sequential, like the harness; a second concurrent request for the same
 * key is refused (the caller streams over HTTP instead).
 *
 * Continuation: a request whose input extends the previous exchange on the
 * same connection — the previous input, then the model's own output, then
 * new items — is sent as `previous_response_id` plus the new items only
 * (the connection-local cache makes that the fast path; the server's copy
 * of the output is authoritative). Anything else — a history the harness
 * rewrote, a new connection, an exchange a steer changed — is sent whole.
 * A `previous_response_not_found` resends it whole.
 *
 * Steering (https://developers.openai.com/api/docs/guides/steering): while a
 * response runs, a NativeSteerSender is registered for the loop key. An
 * offered update is sent as `response.steer` against the running response;
 *   accepted → the server continues with a new response (its
 *              `previous_response_id` is the steered one) → `applied`, and the
 *              stream yields a `prism.turn_input_applied` event right before
 *              the continuation's `response.created`;
 *   pending  → the steer waits for tool results the harness sends as a
 *              whole new request → `fallback`, and the connection is dropped
 *              so the queued steer cannot also be prepended server-side;
 *   failed   → `fallback`.
 * An accepted steer still open when the response ends gets STEER_SETTLE_MS
 * for its continuation or `pending`; then it falls back and the connection
 * is dropped. The stream ends only when every offered steer is resolved.
 *
 * Measured live on gpt-6-luna (2026-09-22): steer accepted in ~10 ms; the
 * original response finished normally and the continuation's
 * `response.created` (previous_response_id = the steered response) followed
 * ~130 ms later; with a function call outstanding, `response.steer.pending`
 * came ~40 ms after `response.completed`.
 */

type ServerEvent = { type: string; [key: string]: unknown };

/**
 * The subset of the SDK's ResponsesWS this module uses (a test double
 * implements it): `event` (every server event), `error`, `close`.
 */
export interface ResponsesSocket {
  send(event: object): void;
  on(event: "event" | "error" | "close", listener: (...args: never[]) => void): unknown;
  off(event: "event" | "error" | "close", listener: (...args: never[]) => void): unknown;
  close(props?: { code: number; reason: string }): void;
}

export type ResponsesSocketFactory = () => ResponsesSocket;

/** Synthetic event: offered inputs the continuation now starting carries. */
export const TURN_INPUT_APPLIED_EVENT = "prism.turn_input_applied";

export const STEER_SETTLE_MILLISECONDS = 5_000;
const CONNECTION_MAX_AGE_MILLISECONDS = 50 * 60_000;
const CONNECTION_IDLE_MILLISECONDS = 10 * 60_000;
const OPEN_TIMEOUT_MILLISECONDS = 30_000;

interface Exchange {
  /** The full input of the request (before any continuation trimming). */
  input: unknown[];
  responseId: string;
}

interface Session {
  key: string;
  socket: ResponsesSocket;
  openedAt: number;
  busy: boolean;
  /** Closed, broken, or holding server state we must not build on. */
  dead: boolean;
  lastExchange: Exchange | null;
  idleTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

let socketFactory: ResponsesSocketFactory | null = null;

/** Tests: replace the socket the sessions open. `null` restores the SDK socket. */
export function setResponsesSocketFactory(factory: ResponsesSocketFactory | null): void {
  socketFactory = factory;
  closeAllResponsesSockets();
}

export function closeAllResponsesSockets(): void {
  for (const session of sessions.values()) retire(session);
  sessions.clear();
}

function retire(session: Session): void {
  session.dead = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  try {
    session.socket.close({ code: 1000, reason: "OK" });
  } catch {
    /* already closed */
  }
}

function acquire(key: string, client: () => OpenAI): Session | null {
  const existing = sessions.get(key);
  if (existing && !existing.dead) {
    if (existing.busy) return null;
    if (Date.now() - existing.openedAt < CONNECTION_MAX_AGE_MILLISECONDS) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.busy = true;
      return existing;
    }
  }
  if (existing) retire(existing);
  let socket: ResponsesSocket;
  try {
    socket = socketFactory
      ? socketFactory()
      : (new ResponsesWS(client(), { handshakeTimeout: 10_000 }) as unknown as ResponsesSocket);
  } catch (error) {
    throw transportFailure(`WebSocket could not be created: ${(error as Error)?.message ?? error}`, error);
  }
  const session: Session = {
    key,
    socket,
    openedAt: Date.now(),
    busy: true,
    dead: false,
    lastExchange: null,
  };
  // A socket that dies between requests must not be reused.
  socket.on("close", () => {
    session.dead = true;
    if (sessions.get(key) === session) sessions.delete(key);
  });
  socket.on("error", () => {
    /* surfaced per request; an unbound error would be an unhandled rejection */
  });
  sessions.set(key, session);
  return session;
}

function release(session: Session): void {
  session.busy = false;
  if (session.dead) {
    retire(session);
    return;
  }
  session.idleTimer = setTimeout(() => retire(session), CONNECTION_IDLE_MILLISECONDS);
  session.idleTimer.unref?.();
}

/** Items the model produced (replayed by the harness) — never new input. */
function isOutputItem(item: unknown): boolean {
  const record = item as { type?: string; role?: string };
  if (record?.type === "reasoning" || record?.type === "function_call") return true;
  if (record?.type === "custom_tool_call") return true;
  return record?.role === "assistant" && (!record.type || record.type === "message");
}

/**
 * The new items of `input` when it continues `previous`: the previous input
 * verbatim, then only output items, then the rest. Null when it does not.
 */
export function continuationTail(previous: Exchange, input: unknown[]): unknown[] | null {
  if (input.length <= previous.input.length) return null;
  for (let index = 0; index < previous.input.length; index++) {
    if (JSON.stringify(input[index]) !== JSON.stringify(previous.input[index])) return null;
  }
  let index = previous.input.length;
  if (!isOutputItem(input[index])) return null;
  while (index < input.length && isOutputItem(input[index])) index++;
  const tail = input.slice(index);
  return tail.length > 0 ? tail : null;
}

const TRANSPORT_FAILURE = Symbol("responsesSocketTransportFailure");

/** The socket itself failed (connect, drop, silence) — not the API refusing the request. */
function transportFailure(message: string, cause?: unknown): ProviderError {
  const error = new ProviderError("openai", message, 503, (cause as Error) ?? null);
  (error as unknown as Record<symbol, boolean>)[TRANSPORT_FAILURE] = true;
  return error;
}

export function isResponsesSocketTransportFailure(error: unknown): boolean {
  return !!(error && typeof error === "object" && (error as Record<symbol, unknown>)[TRANSPORT_FAILURE]);
}

interface SteerRecord {
  inputId: string;
  state: "sent" | "accepted";
  steerId?: string;
  resolve: (outcome: NativeSteerOutcome) => void;
}

export interface ResponsesSocketStreamOptions {
  signal?: AbortSignal;
  /** Register a steer sender under the key while the response runs. */
  steering: boolean;
  /** The SDK client (lazily — tests never build one). */
  client: () => OpenAI;
  /** How long an accepted steer may stay unresolved after the response ends. */
  settleMilliseconds?: number;
}

/**
 * Send one Responses request over the loop key's socket and stream its
 * events — the same events the HTTP stream yields, plus
 * `prism.turn_input_applied`. Resolves once the first event arrived, so a
 * rejection of the request surfaces here (like `responses.create`). Returns
 * null when the key's connection is busy.
 */
export async function openResponsesSocketStream(
  key: string,
  body: Record<string, unknown> & { input: unknown[] },
  options: ResponsesSocketStreamOptions,
): Promise<AsyncGenerator<ServerEvent> | null> {
  const settleMilliseconds = options.settleMilliseconds ?? STEER_SETTLE_MILLISECONDS;
  const acquired = acquire(key, options.client);
  if (!acquired) return null;
  const session: Session = acquired;

  const queue: ServerEvent[] = [];
  let wake: (() => void) | null = null;
  let failure: unknown = null;
  let finished = false;
  let started = false;
  let startWaiter: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  let currentResponseId: string | null = null;
  let firstResponseId: string | null = null;
  let steered = false;
  let settleTimer: NodeJS.Timeout | undefined;
  let terminalSeen = false;
  const steers: SteerRecord[] = [];
  let chainedFrom: string | null = null;

  const notify = () => {
    const waiter = wake;
    wake = null;
    waiter?.();
  };
  const push = (event: ServerEvent) => {
    queue.push(event);
    notify();
  };
  const settleSteers = (outcome: NativeSteerOutcome, filter?: (steer: SteerRecord) => boolean) => {
    for (let index = steers.length - 1; index >= 0; index--) {
      const steer = steers[index];
      if (filter && !filter(steer)) continue;
      steers.splice(index, 1);
      steer.resolve(outcome);
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    if (settleTimer) clearTimeout(settleTimer);
    NativeSteerRegistry.unregister(key, sender);
    settleSteers("fallback");
    notify();
  };
  const fail = (error: unknown) => {
    if (finished) return;
    failure = error;
    session.dead = true;
    if (startWaiter && !started) startWaiter.reject(error);
    finish();
  };
  const maybeFinish = () => {
    if (!terminalSeen) return;
    if (steers.length === 0) {
      finish();
      return;
    }
    if (!settleTimer) {
      settleTimer = setTimeout(() => {
        logger.warn(
          `[OpenAI/WS] ${steers.length} steer(s) unresolved ${settleMilliseconds} ms after the response ended — falling back to the mailbox`,
        );
        // The server may still hold them: never build on this connection again.
        session.dead = true;
        finish();
      }, settleMilliseconds);
      settleTimer.unref?.();
    }
  };

  const sender: NativeSteerSender = {
    steer(input) {
      if (finished || !currentResponseId || session.dead) return Promise.resolve("fallback");
      return new Promise<NativeSteerOutcome>((resolve) => {
        steers.push({ inputId: input.id, state: "sent", resolve });
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = undefined;
        }
        session.socket.send({
          type: "response.steer",
          previous_response_id: currentResponseId,
          input: input.text,
        });
        logger.info(`[OpenAI/WS] steer ${input.id} sent against ${currentResponseId}`);
      });
    },
  };

  const steerById = (event: ServerEvent): SteerRecord | undefined => {
    const steerId = (event.steer as { id?: string } | undefined)?.id;
    return (
      (steerId ? steers.find((steer) => steer.steerId === steerId) : undefined) ??
      steers.find((steer) => steer.state === "sent")
    );
  };

  const onEvent = (event: ServerEvent) => {
    if (finished) return;
    switch (event.type) {
      case "response.steer.accepted": {
        const steer = steers.find((candidate) => candidate.state === "sent");
        if (steer) {
          steer.state = "accepted";
          steer.steerId = (event.steer as { id?: string } | undefined)?.id;
        }
        return;
      }
      case "response.steer.pending": {
        // Waiting for tool results: the harness replays them in a new
        // request, so this steer goes through the mailbox — and the
        // connection holding it queued is dropped after this request.
        const steer = steerById(event);
        if (steer) settleSteers("fallback", (candidate) => candidate === steer);
        session.dead = true;
        maybeFinish();
        return;
      }
      case "response.steer.failed": {
        const steer = steerById(event);
        if (steer) settleSteers("fallback", (candidate) => candidate === steer);
        logger.warn(
          `[OpenAI/WS] steer failed: ${JSON.stringify((event as { error?: unknown }).error ?? {})}`,
        );
        maybeFinish();
        return;
      }
      case "response.created": {
        const response = event.response as { id?: string; previous_response_id?: string } | undefined;
        const responseId = response?.id ?? null;
        if (!firstResponseId) {
          firstResponseId = responseId;
          currentResponseId = responseId;
          started = true;
          startWaiter?.resolve();
        } else if (responseId && responseId !== currentResponseId) {
          // An automatic continuation: every accepted steer rides it.
          const applied = steers.filter((steer) => steer.state === "accepted");
          if (applied.length > 0) {
            steered = true;
            push({
              type: TURN_INPUT_APPLIED_EVENT,
              inputIds: applied.map((steer) => steer.inputId),
              responseId,
            });
            settleSteers("applied", (steer) => applied.includes(steer));
          }
          currentResponseId = responseId;
          terminalSeen = false;
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = undefined;
          }
        }
        push(event);
        return;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        push(event);
        const reason = (event.response as { incomplete_details?: { reason?: string } } | undefined)
          ?.incomplete_details?.reason;
        // A steered response is followed by its continuation.
        if (event.type === "response.incomplete" && reason === "steered") return;
        if (event.type === "response.failed") {
          const detail = ((event.response as { error?: { code?: string; message?: string } } | undefined)
            ?.error ?? {}) as { code?: string; message?: string };
          fail(
            new ProviderError(
              "openai",
              `Response failed: ${detail.message ?? detail.code ?? "unknown error"}`,
              500,
              { type: "api_error", error: detail },
            ),
          );
          return;
        }
        terminalSeen = true;
        maybeFinish();
        return;
      }
      case "error": {
        const detail = (event.error ?? {}) as { code?: string; message?: string; type?: string };
        const status = typeof event.status === "number" ? event.status : 500;
        fail(
          new ProviderError(
            "openai",
            `${status} ${detail.message ?? detail.code ?? "WebSocket error"}`,
            status,
            event,
          ),
        );
        return;
      }
      default:
        push(event);
    }
  };
  const onError = (error: Error & { error?: unknown }) => {
    // API error events arrive through onEvent too; this is the socket itself.
    if (error?.error) return;
    fail(transportFailure(`WebSocket error: ${error?.message ?? "unknown"}`, error));
  };
  const onClose = (code: number, reason: string) => {
    fail(transportFailure(`WebSocket closed (${code} ${reason})`));
  };
  const onAbort = () => {
    // Nothing cancels a running response on the socket: drop the connection.
    session.dead = true;
    finish();
  };

  session.socket.on("event", onEvent);
  session.socket.on("error", onError);
  session.socket.on("close", onClose);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const detach = () => {
    session.socket.off("event", onEvent);
    session.socket.off("error", onError);
    session.socket.off("close", onClose);
    options.signal?.removeEventListener("abort", onAbort);
  };

  const send = (withContinuation: boolean) => {
    const tail =
      withContinuation && session.lastExchange
        ? continuationTail(session.lastExchange, body.input)
        : null;
    chainedFrom = tail ? session.lastExchange!.responseId : null;
    logger.info(
      tail
        ? `[OpenAI/WS] ${key}: continuing ${chainedFrom} with ${tail.length} new of ${body.input.length} item(s)`
        : `[OpenAI/WS] ${key}: full input, ${body.input.length} item(s)`,
    );
    const { stream: _stream, background: _background, ...rest } = body as Record<string, unknown>;
    session.socket.send({
      type: "response.create",
      ...rest,
      ...(tail ? { previous_response_id: chainedFrom, input: tail } : {}),
    });
  };

  /** Resolves on the first `response.created`; rejects on an error first. */
  const waitForStart = () =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(transportFailure("WebSocket response did not start")),
        OPEN_TIMEOUT_MILLISECONDS,
      );
      timer.unref?.();
      startWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });

  try {
    send(true);
    try {
      await waitForStart();
    } catch (error) {
      const code = ((error as ProviderError)?.originalError as { error?: { code?: string } } | null)
        ?.error?.code;
      if (!chainedFrom || code !== "previous_response_not_found") throw error;
      // The connection lost the chain (the service evicts it after an
      // error): send the whole input once more. Nothing has started, so
      // there is no other state to reset.
      logger.warn(`[OpenAI/WS] ${chainedFrom} not found — resending the full input`);
      failure = null;
      finished = false;
      session.dead = false;
      session.lastExchange = null;
      send(false);
      await waitForStart();
    }
  } catch (error) {
    detach();
    session.dead = true;
    release(session);
    throw error;
  }

  if (options.steering) NativeSteerRegistry.register(key, sender);

  async function* iterate(): AsyncGenerator<ServerEvent> {
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      finish();
      detach();
      // Continue from here next time — unless a steer changed what the
      // server holds, the request failed, or it was cut short.
      session.lastExchange =
        !failure && !steered && !session.dead && currentResponseId && terminalSeen
          ? { input: body.input, responseId: currentResponseId }
          : null;
      release(session);
    }
  }

  return iterate();
}

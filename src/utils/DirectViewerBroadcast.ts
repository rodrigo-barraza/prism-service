import WebSocketConnectionRegistry from "#src/websocket/WebSocketConnectionRegistry";
import { observeTurnEvent } from "#src/services/TurnAttentionObserver";
import type { WebSocket } from "ws";
import type { SseEvent } from "#src/types/SseTypes";

/**
 * Direct-viewer broadcast + live-turn replay.
 *
 * A "direct viewer" is any WebSocket client subscribed to a conversation it
 * is not driving — the /admin/chat viewer, a second browser tab, another
 * device of the same user. Two pieces make a viewed conversation stream:
 *
 *   1. `withDirectViewerBroadcast` mirrors every generation event to the
 *      conversation's registered WebSocket subscribers.
 *   2. `LiveTurnBuffer` keeps the ACTIVE turn's events in memory so a viewer
 *      that subscribes mid-turn is replayed everything it missed (the turn's
 *      user prompt and messages are only persisted at finalize, so without
 *      replay a mid-turn joiner sees nothing until the next live event).
 *      Every event is stamped with a per-conversation monotonic `seq`, so a
 *      viewer that reconnects sends the last seq it saw (`afterSeq`) and is
 *      replayed only what it missed — never a duplicate of what it rendered.
 *
 * The same wrap is where the "needs you" features see a turn: every event
 * is handed to observeTurnEvent (attention counts, webhooks, push), which
 * relies on this exactly-once delivery.
 *
 * IMPORTANT — wrap-exactly-once invariant: the request layers
 * (handleSseRequest / handleJsonRequest / the WebSocket chat handler) wrap
 * with the REQUEST's conversationId, or with the `serverConversationId`
 * /agent mints for a new conversation. When neither exists (a new /chat
 * conversation, a workflow node calling handleAgent directly),
 * handleConversation / handleAgent wrap with the resolved id instead.
 * Exactly one of the two wraps is ever active for a given request —
 * wrapping both layers would double-deliver.
 */

// ─── Live turn buffer ─────────────────────────────────────────

/**
 * Hard cap per turn — past it the OLDEST events are dropped so a late
 * joiner still receives the newest tail (and a `droppedCount` telling it
 * earlier output was truncated).
 */
const MAX_BUFFERED_EVENTS_PER_TURN = 5000;
/** Never buffer single events with heavy inline payloads (raw base64). */
const MAX_BUFFERED_EVENT_BYTES = 100_000;
/** Sweep buffers untouched for this long (crashed turns that never emitted done). */
const BUFFER_TTL_MILLISECONDS = 2 * 60 * 60 * 1000;
const BUFFER_SWEEP_INTERVAL_MILLISECONDS = 10 * 60 * 1000;

interface TurnBuffer {
  /** Retained events live at `events[head..]`; below `head` is already dropped. */
  events: SseEvent[];
  /** Index of the oldest retained event — advanced instead of `shift()`ing. */
  head: number;
  lastTouchedAt: number;
  /** True once the turn has exceeded the cap and lost its oldest events. */
  overflowed: boolean;
  /** How many events this turn dropped off the front of the buffer. */
  droppedCount: number;
  /** `seq` of the most recently dropped event (0 when nothing dropped). */
  lastDroppedSeq: number;
}

/**
 * Per-conversation sequence counter. Held BESIDE the turn buffer, never
 * inside it: the buffer resets every turn, but a viewer's cursor from the
 * previous turn must still compare "older than" everything in the next
 * turn, so the counter only ever moves forward for a conversation.
 */
interface SequenceCounter {
  lastSeq: number;
  lastTouchedAt: number;
}

const turnBuffersByConversation = new Map<string, TurnBuffer>();
const sequenceCountersByConversation = new Map<string, SequenceCounter>();

const bufferSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [conversationId, buffer] of turnBuffersByConversation) {
    if (now - buffer.lastTouchedAt > BUFFER_TTL_MILLISECONDS) {
      turnBuffersByConversation.delete(conversationId);
    }
  }
  for (const [conversationId, counter] of sequenceCountersByConversation) {
    if (now - counter.lastTouchedAt > BUFFER_TTL_MILLISECONDS) {
      sequenceCountersByConversation.delete(conversationId);
    }
  }
}, BUFFER_SWEEP_INTERVAL_MILLISECONDS);
// Never keep the process alive just for buffer sweeping
bufferSweepTimer.unref?.();

/**
 * Strip heavy inline base64 from events that carry a MinIO reference —
 * viewers resolve media through the ref, same rule as the live broadcast.
 */
function toLightweightEvent(event: SseEvent): SseEvent {
  if (
    (event.type === "image" || event.type === "audio") &&
    event.minioRef &&
    event.data
  ) {
    const { data: _stripped, ...lightweightEvent } = event;
    return lightweightEvent as SseEvent;
  }
  return event;
}

function newTurnBuffer(): TurnBuffer {
  return {
    events: [],
    head: 0,
    lastTouchedAt: Date.now(),
    overflowed: false,
    droppedCount: 0,
    lastDroppedSeq: 0,
  };
}

/**
 * A fresh counter starts at the wall clock rather than 0. It is still a
 * plain monotonic counter (+1 per event), but a cursor a client kept from
 * before a process restart — or from before the TTL sweep retired an idle
 * counter — then still sorts below every seq the conversation emits next,
 * instead of silently making the client drop live events as "already seen".
 */
function nextSequence(conversationId: string): number {
  let counter = sequenceCountersByConversation.get(conversationId);
  if (!counter) {
    counter = { lastSeq: Date.now(), lastTouchedAt: 0 };
    sequenceCountersByConversation.set(conversationId, counter);
  }
  counter.lastSeq += 1;
  counter.lastTouchedAt = Date.now();
  return counter.lastSeq;
}

export const LiveTurnBuffer = {
  /**
   * Stamp `seq` on an event IN PLACE (so the driving stream, the buffer and
   * every viewer fan-out see one and the same numbered object). An event
   * that already carries a `seq` (a re-broadcast) keeps it; the counter is
   * only pulled forward past it so later stamps stay monotonic.
   */
  stamp<TEvent extends { seq?: number }>(
    conversationId: string,
    event: TEvent,
  ): TEvent {
    if (typeof event.seq === "number") {
      const counter = sequenceCountersByConversation.get(conversationId);
      if (counter) {
        counter.lastSeq = Math.max(counter.lastSeq, event.seq);
        counter.lastTouchedAt = Date.now();
      } else {
        sequenceCountersByConversation.set(conversationId, {
          lastSeq: event.seq,
          lastTouchedAt: Date.now(),
        });
      }
      return event;
    }
    event.seq = nextSequence(conversationId);
    return event;
  },

  /** The highest `seq` stamped for the conversation so far (0 when none). */
  lastSeq(conversationId: string): number {
    return sequenceCountersByConversation.get(conversationId)?.lastSeq ?? 0;
  },

  /**
   * Record one generation event for the conversation's active turn.
   * `user_message` starts a fresh turn; `done`/`error` end it (the
   * persisted document becomes canonical moments later, so replaying a
   * finished turn would only duplicate what the snapshot already shows).
   * Every event is stamped with a `seq` (if it has none yet) — including
   * the ones that end the turn or are too heavy to buffer, so a viewer's
   * cursor keeps advancing in step with the driving stream.
   */
  record(conversationId: string, event: SseEvent): void {
    LiveTurnBuffer.stamp(conversationId, event);

    if (event.type === "done" || event.type === "error") {
      turnBuffersByConversation.delete(conversationId);
      return;
    }

    let buffer = turnBuffersByConversation.get(conversationId);
    if (event.type === "user_message" || !buffer) {
      buffer = newTurnBuffer();
      turnBuffersByConversation.set(conversationId, buffer);
    }
    buffer.lastTouchedAt = Date.now();

    const lightweightEvent = toLightweightEvent(event);
    if (
      typeof lightweightEvent.data === "string" &&
      lightweightEvent.data.length > MAX_BUFFERED_EVENT_BYTES
    ) {
      return;
    }
    buffer.events.push(lightweightEvent);

    if (buffer.events.length - buffer.head > MAX_BUFFERED_EVENTS_PER_TURN) {
      // Drop the oldest by advancing the head — O(1) per event. The
      // dead prefix is compacted away once per cap's worth of drops, so
      // the slice cost is amortised to O(1) as well and the array never
      // holds more than two caps of entries.
      const dropped = buffer.events[buffer.head];
      buffer.head += 1;
      buffer.overflowed = true;
      buffer.droppedCount += 1;
      buffer.lastDroppedSeq = dropped.seq ?? buffer.lastDroppedSeq;
      if (buffer.head >= MAX_BUFFERED_EVENTS_PER_TURN) {
        buffer.events = buffer.events.slice(buffer.head);
        buffer.head = 0;
      }
    }
  },

  /**
   * Events of the conversation's active turn, in emit order — empty when
   * no turn is running. With `afterSeq`, only events stamped AFTER that
   * cursor: a viewer re-subscribing after a reconnect gets what it
   * missed and nothing it already rendered. A cursor from a previous
   * turn sorts below the whole current turn, so it yields all of it.
   */
  replay(conversationId: string, afterSeq?: number): SseEvent[] {
    const buffer = turnBuffersByConversation.get(conversationId);
    if (!buffer) return [];
    const retained = buffer.events.slice(buffer.head);
    if (afterSeq === undefined) return retained;
    return retained.filter(
      (event) => typeof event.seq === "number" && event.seq > afterSeq,
    );
  },

  /**
   * How many of the active turn's events a subscriber at `afterSeq` can
   * no longer be replayed because the buffer overflowed. Without a cursor
   * it is the turn's whole drop count; a cursor already past the dropped
   * range lost nothing; in between, the count of sequence numbers between
   * the cursor and the last dropped event (an upper bound — heavy events
   * that were never buffered also consume a seq).
   */
  droppedCount(conversationId: string, afterSeq?: number): number {
    const buffer = turnBuffersByConversation.get(conversationId);
    if (!buffer || !buffer.overflowed) return 0;
    if (afterSeq === undefined) return buffer.droppedCount;
    if (afterSeq >= buffer.lastDroppedSeq) return 0;
    return Math.min(buffer.droppedCount, buffer.lastDroppedSeq - afterSeq);
  },

  /** Drop a conversation's buffered turn (its sequence counter lives on). */
  clear(conversationId: string): void {
    turnBuffersByConversation.delete(conversationId);
  },

  /** Clear all buffers and sequence counters (tests / shutdown). */
  clearAll(): void {
    turnBuffersByConversation.clear();
    sequenceCountersByConversation.clear();
  },
};

// ─── Broadcast ────────────────────────────────────────────────

/**
 * Mirror a generation event to any WebSocket clients subscribed directly to
 * this conversation (admin viewer, second tab). Counterpart of
 * SubAgentTelemetryEmitter.broadcastToDirectViewers, which does the same for
 * sub-agent conversations. Best-effort — direct-viewer delivery must never
 * break the primary stream.
 */
export function broadcastEventToDirectViewers(
  conversationId: string,
  event: SseEvent,
  options: { excludeWebsocket?: WebSocket } = {},
): void {
  try {
    const broadcast = WebSocketConnectionRegistry.getEmitFunction(
      conversationId,
      options,
    );
    if (!broadcast) return;
    broadcast(
      toLightweightEvent(event) as unknown as {
        type: string;
        [key: string]: unknown;
      },
    );
  } catch {
    // Never let viewer fan-out break the generating request
  }
}

/**
 * Wrap a primary emit so every event is also recorded for mid-turn replay
 * and mirrored to direct WebSocket viewers of the conversation. No-op
 * wrapper when there is no conversationId.
 *
 * Generic over the emit's event shape — callers variously type events as
 * SseEvent or Record-based EmitFunction payloads; both are runtime-
 * compatible `{ type: string, ... }` objects.
 *
 * `excludeWebsocket` skips the driving socket for WebSocket-driven chats —
 * it already receives every event through the primary emit.
 */
export function withDirectViewerBroadcast<TEvent extends object>(
  conversationId: string | undefined,
  emit: (event: TEvent) => void,
  options: { excludeWebsocket?: WebSocket } = {},
): (event: TEvent) => void {
  if (!conversationId) return emit;
  return (event: TEvent) => {
    // Stamp BEFORE the primary emit so the driving stream, the replay
    // buffer and every viewer carry the same seq for this event — that
    // is what lets a client dedupe a replayed prefix against live events.
    try {
      LiveTurnBuffer.stamp(conversationId, event as unknown as SseEvent);
    } catch {
      // Sequencing is best-effort — never break the primary stream
    }
    emit(event);
    try {
      LiveTurnBuffer.record(conversationId, event as unknown as SseEvent);
    } catch {
      // Replay is best-effort — never break the primary stream
    }
    broadcastEventToDirectViewers(
      conversationId,
      event as unknown as SseEvent,
      options,
    );
    observeTurnEvent(
      conversationId,
      event as unknown as { type?: unknown; [key: string]: unknown },
    );
  };
}

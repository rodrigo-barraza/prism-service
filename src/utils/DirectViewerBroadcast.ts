import WebSocketConnectionRegistry from "#src/websocket/WebSocketConnectionRegistry";
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
 *
 * IMPORTANT — wrap-exactly-once invariant: the request layers
 * (handleSseRequest / handleJsonRequest / the WebSocket chat handler) wrap
 * with the REQUEST's conversationId, which only exists when the caller sent
 * one. When the id is minted server-side (new conversations, API callers
 * like lupos that never send an id), handleConversation / handleAgent wrap
 * with the resolved id instead. Exactly one of the two wraps is ever active
 * for a given request — wrapping both layers would double-deliver.
 */

// ─── Live turn buffer ─────────────────────────────────────────

/** Hard cap per turn — a runaway turn stops buffering instead of growing. */
const MAX_BUFFERED_EVENTS_PER_TURN = 5000;
/** Never buffer single events with heavy inline payloads (raw base64). */
const MAX_BUFFERED_EVENT_BYTES = 100_000;
/** Sweep buffers untouched for this long (crashed turns that never emitted done). */
const BUFFER_TTL_MILLISECONDS = 2 * 60 * 60 * 1000;
const BUFFER_SWEEP_INTERVAL_MILLISECONDS = 10 * 60 * 1000;

interface TurnBuffer {
  events: SseEvent[];
  lastTouchedAt: number;
  overflowed: boolean;
}

const turnBuffersByConversation = new Map<string, TurnBuffer>();

const bufferSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [conversationId, buffer] of turnBuffersByConversation) {
    if (now - buffer.lastTouchedAt > BUFFER_TTL_MILLISECONDS) {
      turnBuffersByConversation.delete(conversationId);
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

export const LiveTurnBuffer = {
  /**
   * Record one generation event for the conversation's active turn.
   * `user_message` starts a fresh turn; `done`/`error` end it (the
   * persisted document becomes canonical moments later, so replaying a
   * finished turn would only duplicate what the snapshot already shows).
   */
  record(conversationId: string, event: SseEvent): void {
    if (event.type === "done" || event.type === "error") {
      turnBuffersByConversation.delete(conversationId);
      return;
    }

    let buffer = turnBuffersByConversation.get(conversationId);
    if (event.type === "user_message" || !buffer) {
      buffer = { events: [], lastTouchedAt: Date.now(), overflowed: false };
      turnBuffersByConversation.set(conversationId, buffer);
    }
    buffer.lastTouchedAt = Date.now();

    if (buffer.overflowed) return;
    if (buffer.events.length >= MAX_BUFFERED_EVENTS_PER_TURN) {
      // Replaying a truncated turn would render corrupt partial text, so
      // an overflowed buffer is abandoned entirely — late joiners fall
      // back to live-only events plus the finalize snapshot.
      buffer.overflowed = true;
      buffer.events = [];
      return;
    }

    const lightweightEvent = toLightweightEvent(event);
    if (
      typeof lightweightEvent.data === "string" &&
      lightweightEvent.data.length > MAX_BUFFERED_EVENT_BYTES
    ) {
      return;
    }
    buffer.events.push(lightweightEvent);
  },

  /**
   * Events of the conversation's active turn, in emit order — empty when
   * no turn is running (or the turn's buffer overflowed).
   */
  replay(conversationId: string): SseEvent[] {
    const buffer = turnBuffersByConversation.get(conversationId);
    if (!buffer || buffer.overflowed) return [];
    return [...buffer.events];
  },

  /** Drop a conversation's buffered turn. */
  clear(conversationId: string): void {
    turnBuffersByConversation.delete(conversationId);
  },

  /** Clear all buffers (tests / shutdown). */
  clearAll(): void {
    turnBuffersByConversation.clear();
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
  };
}

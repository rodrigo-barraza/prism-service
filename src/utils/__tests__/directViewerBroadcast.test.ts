/**
 * DirectViewerBroadcast — the machinery that makes a conversation viewable
 * live by clients that are not driving it (/admin/chat, second tabs).
 *
 * Two guarantees under test:
 *   1. withDirectViewerBroadcast mirrors every event to registered
 *      WebSocket viewers of the conversation.
 *   2. LiveTurnBuffer replays the active turn's events to a viewer that
 *      subscribes mid-turn (messages persist only at finalize, so without
 *      replay a mid-turn joiner sees nothing until the next live event).
 *   3. Every event carries a per-conversation monotonic `seq`, shared by
 *      the driving stream, the buffer and the viewer fan-out, so a
 *      re-subscribing viewer replays from its cursor and never duplicates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  withDirectViewerBroadcast,
  broadcastEventToDirectViewers,
  LiveTurnBuffer,
} = await import("#src/utils/DirectViewerBroadcast");
const WebSocketConnectionRegistry = (
  await import("#src/websocket/WebSocketConnectionRegistry")
).default;

import type { SseEvent } from "#src/types/SseTypes";

function createMockWebSocket() {
  return { readyState: 1, OPEN: 1, send: vi.fn() };
}

function registerViewer(conversationId: string) {
  const viewerEmit = vi.fn();
  WebSocketConnectionRegistry.register(
    conversationId,
    createMockWebSocket() as unknown as import("ws").WebSocket,
    viewerEmit,
  );
  return viewerEmit;
}

beforeEach(() => {
  WebSocketConnectionRegistry.clear();
  LiveTurnBuffer.clearAll();
});

// ═══════════════════════════════════════════════════════════════
describe("LiveTurnBuffer", () => {
  it("replays the active turn's events in emit order", () => {
    LiveTurnBuffer.record("conv-1", { type: "user_message", content: "hi" });
    LiveTurnBuffer.record("conv-1", { type: "thinking", content: "hmm" });
    LiveTurnBuffer.record("conv-1", { type: "chunk", content: "Hello" });

    expect(LiveTurnBuffer.replay("conv-1").map((event) => event.type)).toEqual([
      "user_message",
      "thinking",
      "chunk",
    ]);
  });

  it("returns nothing for a conversation with no active turn", () => {
    expect(LiveTurnBuffer.replay("conv-unknown")).toEqual([]);
  });

  it("starts a fresh turn on user_message", () => {
    LiveTurnBuffer.record("conv-2", { type: "chunk", content: "old turn" });
    LiveTurnBuffer.record("conv-2", { type: "user_message", content: "next" });
    LiveTurnBuffer.record("conv-2", { type: "chunk", content: "new turn" });

    const replayed = LiveTurnBuffer.replay("conv-2");
    expect(replayed.map((event) => event.content)).toEqual([
      "next",
      "new turn",
    ]);
  });

  it("clears the buffer when the turn finishes (done) or fails (error)", () => {
    LiveTurnBuffer.record("conv-3", { type: "chunk", content: "text" });
    LiveTurnBuffer.record("conv-3", { type: "done" });
    expect(LiveTurnBuffer.replay("conv-3")).toEqual([]);

    LiveTurnBuffer.record("conv-3", { type: "chunk", content: "text" });
    LiveTurnBuffer.record("conv-3", { type: "error", message: "boom" });
    expect(LiveTurnBuffer.replay("conv-3")).toEqual([]);
  });

  it("keeps the newest 5000 events when a turn overflows and counts the dropped ones", () => {
    for (let index = 0; index < 5003; index++) {
      LiveTurnBuffer.record("conv-4", { type: "chunk", content: String(index) });
    }
    const replayed = LiveTurnBuffer.replay("conv-4");
    expect(replayed).toHaveLength(5000);
    expect(replayed[0].content).toBe("3");
    expect(replayed[4999].content).toBe("5002");
    expect(LiveTurnBuffer.droppedCount("conv-4")).toBe(3);

    // A cursor already past the dropped range lost nothing
    const cursorPastDrops = replayed[10].seq!;
    expect(LiveTurnBuffer.droppedCount("conv-4", cursorPastDrops)).toBe(0);
    expect(LiveTurnBuffer.replay("conv-4", cursorPastDrops)).toHaveLength(
      5000 - 11,
    );

    // The next turn starts clean
    LiveTurnBuffer.record("conv-4", { type: "user_message", content: "next" });
    expect(LiveTurnBuffer.replay("conv-4")).toHaveLength(1);
    expect(LiveTurnBuffer.droppedCount("conv-4")).toBe(0);
  });

  it("keeps replay in order across compaction of the dropped prefix", () => {
    // 2.5 caps of events forces the head-index compaction more than once
    for (let index = 0; index < 12_500; index++) {
      LiveTurnBuffer.record("conv-4b", { type: "chunk", content: String(index) });
    }
    const replayed = LiveTurnBuffer.replay("conv-4b");
    expect(replayed).toHaveLength(5000);
    expect(replayed.map((event) => Number(event.content))).toEqual(
      Array.from({ length: 5000 }, (_unused, offset) => 7500 + offset),
    );
    expect(LiveTurnBuffer.droppedCount("conv-4b")).toBe(7500);
    // seq strictly increasing over the retained tail
    for (let index = 1; index < replayed.length; index++) {
      expect(replayed[index].seq!).toBeGreaterThan(replayed[index - 1].seq!);
    }
  });

  it("stores media events without heavy inline base64 when a minioRef exists", () => {
    LiveTurnBuffer.record("conv-5", {
      type: "image",
      data: "hugebase64",
      minioRef: "minio://images/1.png",
    });
    expect(LiveTurnBuffer.replay("conv-5")).toEqual([
      { type: "image", minioRef: "minio://images/1.png", seq: expect.any(Number) },
    ]);
  });

  it("skips events with heavy inline payloads and no ref instead of buffering them", () => {
    LiveTurnBuffer.record("conv-6", {
      type: "audio",
      data: "x".repeat(200_000),
    });
    LiveTurnBuffer.record("conv-6", { type: "chunk", content: "kept" });
    expect(LiveTurnBuffer.replay("conv-6").map((event) => event.type)).toEqual([
      "chunk",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("LiveTurnBuffer sequence ids", () => {
  it("stamps a strictly increasing seq on every recorded event", () => {
    const events: SseEvent[] = [
      { type: "user_message", content: "hi" },
      { type: "thinking", content: "hmm" },
      { type: "chunk", content: "Hello" },
    ];
    for (const event of events) LiveTurnBuffer.record("seq-1", event);

    expect(events.every((event) => typeof event.seq === "number")).toBe(true);
    expect(events[1].seq!).toBe(events[0].seq! + 1);
    expect(events[2].seq!).toBe(events[1].seq! + 1);
    expect(LiveTurnBuffer.lastSeq("seq-1")).toBe(events[2].seq);
  });

  it("keeps seq monotonic across turns — a new turn never restarts the counter", () => {
    const firstTurnChunk: SseEvent = { type: "chunk", content: "a" };
    LiveTurnBuffer.record("seq-2", { type: "user_message", content: "one" });
    LiveTurnBuffer.record("seq-2", firstTurnChunk);
    const doneEvent: SseEvent = { type: "done" };
    LiveTurnBuffer.record("seq-2", doneEvent);
    expect(doneEvent.seq!).toBeGreaterThan(firstTurnChunk.seq!);

    const secondTurnPrompt: SseEvent = { type: "user_message", content: "two" };
    LiveTurnBuffer.record("seq-2", secondTurnPrompt);
    expect(secondTurnPrompt.seq!).toBeGreaterThan(doneEvent.seq!);
    expect(LiveTurnBuffer.lastSeq("seq-2")).toBe(secondTurnPrompt.seq);
  });

  it("reports lastSeq 0 for a conversation that never emitted", () => {
    expect(LiveTurnBuffer.lastSeq("seq-never")).toBe(0);
    expect(LiveTurnBuffer.replay("seq-never", 123)).toEqual([]);
    expect(LiveTurnBuffer.droppedCount("seq-never", 123)).toBe(0);
  });

  it("replays only events newer than the cursor", () => {
    const events: SseEvent[] = [
      { type: "user_message", content: "prompt" },
      { type: "chunk", content: "one" },
      { type: "chunk", content: "two" },
      { type: "chunk", content: "three" },
    ];
    for (const event of events) LiveTurnBuffer.record("seq-3", event);

    expect(
      LiveTurnBuffer.replay("seq-3", events[1].seq).map((event) => event.content),
    ).toEqual(["two", "three"]);
    expect(LiveTurnBuffer.replay("seq-3", events[3].seq)).toEqual([]);
    // No cursor → the whole turn, as before
    expect(LiveTurnBuffer.replay("seq-3")).toHaveLength(4);
  });

  it("replays the whole current turn for a stale cursor from the previous turn", () => {
    LiveTurnBuffer.record("seq-4", { type: "user_message", content: "old" });
    const lastOfPreviousTurn: SseEvent = { type: "chunk", content: "old text" };
    LiveTurnBuffer.record("seq-4", lastOfPreviousTurn);
    LiveTurnBuffer.record("seq-4", { type: "done" });
    const staleCursor = lastOfPreviousTurn.seq!;

    LiveTurnBuffer.record("seq-4", { type: "user_message", content: "new" });
    LiveTurnBuffer.record("seq-4", { type: "chunk", content: "new text" });

    expect(
      LiveTurnBuffer.replay("seq-4", staleCursor).map((event) => event.content),
    ).toEqual(["new", "new text"]);
  });

  it("keeps a seq an event already carries and pulls the counter past it", () => {
    const rebroadcast: SseEvent = { type: "chunk", content: "x", seq: 9_999_999_999_999 };
    LiveTurnBuffer.record("seq-5", rebroadcast);
    expect(rebroadcast.seq).toBe(9_999_999_999_999);

    const next: SseEvent = { type: "chunk", content: "y" };
    LiveTurnBuffer.record("seq-5", next);
    expect(next.seq!).toBeGreaterThan(9_999_999_999_999);
  });

  it("stamps events that are too heavy to buffer, so the cursor still advances", () => {
    const heavy: SseEvent = { type: "audio", data: "x".repeat(200_000) };
    LiveTurnBuffer.record("seq-6", heavy);
    expect(typeof heavy.seq).toBe("number");
    expect(LiveTurnBuffer.replay("seq-6")).toEqual([]);
    expect(LiveTurnBuffer.lastSeq("seq-6")).toBe(heavy.seq);
  });

  it("keeps seq on the lightweight copy stored for media with a minioRef", () => {
    const image: SseEvent = {
      type: "image",
      data: "hugebase64",
      minioRef: "minio://images/1.png",
    };
    LiveTurnBuffer.record("seq-7", image);
    expect(LiveTurnBuffer.replay("seq-7")).toEqual([
      { type: "image", minioRef: "minio://images/1.png", seq: image.seq },
    ]);
  });

  it("reports the truncation a cursor inside the dropped range still suffers", () => {
    const events: SseEvent[] = [];
    for (let index = 0; index < 5010; index++) {
      const event: SseEvent = { type: "chunk", content: String(index) };
      LiveTurnBuffer.record("seq-8", event);
      events.push(event);
    }
    // 10 dropped (0..9). A cursor at event 4 still lost events 5..9.
    expect(LiveTurnBuffer.droppedCount("seq-8", events[4].seq)).toBe(5);
    // Cursor at the last dropped event lost nothing more.
    expect(LiveTurnBuffer.droppedCount("seq-8", events[9].seq)).toBe(0);
    // Cursor before the turn (previous turn) → everything dropped applies.
    expect(LiveTurnBuffer.droppedCount("seq-8", events[0].seq! - 100)).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("withDirectViewerBroadcast", () => {
  it("returns the primary emit unchanged when there is no conversationId", () => {
    const primaryEmit = vi.fn();
    expect(withDirectViewerBroadcast(undefined, primaryEmit)).toBe(primaryEmit);
  });

  it("delivers each event to the primary emit AND registered direct viewers", () => {
    const viewerEmit = registerViewer("conv-live-1");
    const primaryEmit = vi.fn();
    const emit = withDirectViewerBroadcast("conv-live-1", primaryEmit);

    const chunkEvent = { type: "chunk", content: "hello" } as SseEvent;
    emit(chunkEvent);

    expect(primaryEmit).toHaveBeenCalledWith(chunkEvent);
    expect(viewerEmit).toHaveBeenCalledWith(chunkEvent);
  });

  it("records every emitted event for mid-turn replay", () => {
    const emit = withDirectViewerBroadcast("conv-live-2", vi.fn());
    emit({ type: "user_message", content: "prompt" } as SseEvent);
    emit({ type: "chunk", content: "answer " } as SseEvent);

    expect(
      LiveTurnBuffer.replay("conv-live-2").map((event) => event.type),
    ).toEqual(["user_message", "chunk"]);
  });

  it("excludes the driving WebSocket from the viewer fan-out", () => {
    const drivingWebsocket =
      createMockWebSocket() as unknown as import("ws").WebSocket;
    const drivingEmit = vi.fn();
    WebSocketConnectionRegistry.register(
      "conv-live-3",
      drivingWebsocket,
      drivingEmit,
    );
    const viewerEmit = registerViewer("conv-live-3");

    const primaryEmit = vi.fn();
    const emit = withDirectViewerBroadcast("conv-live-3", primaryEmit, {
      excludeWebsocket: drivingWebsocket,
    });
    emit({ type: "chunk", content: "x" } as SseEvent);

    expect(primaryEmit).toHaveBeenCalledTimes(1);
    expect(viewerEmit).toHaveBeenCalledTimes(1);
    expect(drivingEmit).not.toHaveBeenCalled();
  });

  it("never lets a failing viewer break the primary stream", () => {
    const explodingViewer = vi.fn(() => {
      throw new Error("viewer socket died");
    });
    WebSocketConnectionRegistry.register(
      "conv-live-4",
      createMockWebSocket() as unknown as import("ws").WebSocket,
      explodingViewer,
    );

    const primaryEmit = vi.fn();
    const emit = withDirectViewerBroadcast("conv-live-4", primaryEmit);

    expect(() => emit({ type: "chunk", content: "x" } as SseEvent)).not.toThrow();
    expect(primaryEmit).toHaveBeenCalled();
  });

  it("strips heavy base64 image data for viewers when a minioRef exists", () => {
    const viewerEmit = registerViewer("conv-live-5");
    const emit = withDirectViewerBroadcast("conv-live-5", vi.fn());
    emit({
      type: "image",
      data: "hugebase64",
      minioRef: "minio://images/1.png",
    } as SseEvent);

    expect(viewerEmit).toHaveBeenCalledWith({
      type: "image",
      minioRef: "minio://images/1.png",
      seq: expect.any(Number),
    });
  });

  it("stamps seq before the driving emit — stream, buffer and viewers share one number", () => {
    const viewerEmit = registerViewer("conv-live-6");
    const seenByPrimary: number[] = [];
    const primaryEmit = vi.fn((event: SseEvent) => {
      seenByPrimary.push(event.seq!);
    });
    const emit = withDirectViewerBroadcast("conv-live-6", primaryEmit);

    const prompt = { type: "user_message", content: "p" } as SseEvent;
    const chunk = { type: "chunk", content: "c" } as SseEvent;
    emit(prompt);
    emit(chunk);

    // The primary emit saw the seq at call time (not stamped afterwards)
    expect(seenByPrimary).toEqual([prompt.seq, chunk.seq]);
    expect(chunk.seq).toBe(prompt.seq! + 1);
    // The viewer received the very same stamped objects
    expect(viewerEmit.mock.calls.map(([event]) => event)).toEqual([prompt, chunk]);
    // And the buffer replays them with the same seq
    expect(LiveTurnBuffer.replay("conv-live-6").map((event) => event.seq)).toEqual([
      prompt.seq,
      chunk.seq,
    ]);
    expect(LiveTurnBuffer.lastSeq("conv-live-6")).toBe(chunk.seq);
  });

  it("stamps done/error too, so a client cursor after the turn sorts below the next turn", () => {
    const emit = withDirectViewerBroadcast("conv-live-7", vi.fn());
    const chunk = { type: "chunk", content: "c" } as SseEvent;
    const done = { type: "done" } as SseEvent;
    emit(chunk);
    emit(done);
    expect(done.seq).toBe(chunk.seq! + 1);
    expect(LiveTurnBuffer.replay("conv-live-7")).toEqual([]);
  });

  it("lets a second viewer joining mid-turn with afterSeq receive no duplicates", () => {
    const emit = withDirectViewerBroadcast("conv-live-8", vi.fn());

    // A viewer is on from the start and renders the first three events
    const firstViewer = registerViewer("conv-live-8");
    emit({ type: "user_message", content: "prompt" } as SseEvent);
    emit({ type: "chunk", content: "one" } as SseEvent);
    emit({ type: "chunk", content: "two" } as SseEvent);
    const firstViewerCursor = (
      firstViewer.mock.calls.at(-1)![0] as SseEvent
    ).seq!;

    // It disconnects and re-subscribes mid-turn with its cursor, just as
    // the WebSocket handler does: replay after the cursor, then live.
    WebSocketConnectionRegistry.clear();
    const secondViewer = registerViewer("conv-live-8");
    const replayed = LiveTurnBuffer.replay("conv-live-8", firstViewerCursor);
    for (const event of replayed) secondViewer(event);
    emit({ type: "chunk", content: "three" } as SseEvent);
    emit({ type: "chunk", content: "four" } as SseEvent);

    expect(replayed).toEqual([]);
    const received = secondViewer.mock.calls.map(([event]) => event as SseEvent);
    expect(received.map((event) => event.content)).toEqual(["three", "four"]);
    // Every seq the second viewer saw is newer than its cursor — nothing to drop
    expect(received.every((event) => event.seq! > firstViewerCursor)).toBe(true);
    // And, had the rejoin happened later, the replay fills exactly the gap
    expect(
      LiveTurnBuffer.replay("conv-live-8", firstViewerCursor).map(
        (event) => event.content,
      ),
    ).toEqual(["three", "four"]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("broadcastEventToDirectViewers", () => {
  it("is a no-op when the conversation has no registered viewers", () => {
    expect(() =>
      broadcastEventToDirectViewers("conv-none", {
        type: "chunk",
        content: "x",
      } as SseEvent),
    ).not.toThrow();
  });
});

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

  it("abandons replay entirely when a turn overflows the event cap", () => {
    for (let index = 0; index < 5001; index++) {
      LiveTurnBuffer.record("conv-4", { type: "chunk", content: "x" });
    }
    expect(LiveTurnBuffer.replay("conv-4")).toEqual([]);

    // Still recovers on the next turn
    LiveTurnBuffer.record("conv-4", { type: "user_message", content: "next" });
    expect(LiveTurnBuffer.replay("conv-4")).toHaveLength(1);
  });

  it("stores media events without heavy inline base64 when a minioRef exists", () => {
    LiveTurnBuffer.record("conv-5", {
      type: "image",
      data: "hugebase64",
      minioRef: "minio://images/1.png",
    });
    expect(LiveTurnBuffer.replay("conv-5")).toEqual([
      { type: "image", minioRef: "minio://images/1.png" },
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
    });
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

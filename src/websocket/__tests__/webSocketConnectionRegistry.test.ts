import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import WebSocketConnectionRegistry from "#src/websocket/WebSocketConnectionRegistry";

// ── Mock WebSocket ──────────────────────────────────────────────

function createMockWebSocket(readyState: number = 1): {
  readyState: number;
  OPEN: number;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
  };
}


// ── Test Suite ──────────────────────────────────────────────────

describe("WebSocketConnectionRegistry", () => {
  beforeEach(() => {
    WebSocketConnectionRegistry.clear();
  });

  afterEach(() => {
    WebSocketConnectionRegistry.clear();
  });

  describe("register / getEmitFunction", () => {
    it("should register a connection and return an emit function", () => {
      const websocket = createMockWebSocket();
      const emitFunction = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", websocket as unknown as import("ws").WebSocket, emitFunction,
      );

      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction("conversation-1");
      expect(registeredEmit).not.toBeNull();

      registeredEmit!({ type: "test_event", data: "hello" });
      expect(emitFunction).toHaveBeenCalledWith({ type: "test_event", data: "hello" });
    });

    it("should return null when no connections are registered", () => {
      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction("nonexistent");
      expect(registeredEmit).toBeNull();
    });

    it("should skip the excluded WebSocket but still broadcast to other viewers", () => {
      const drivingWebsocket = createMockWebSocket();
      const viewerWebsocket = createMockWebSocket();
      const drivingEmit = vi.fn();
      const viewerEmit = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", drivingWebsocket as unknown as import("ws").WebSocket, drivingEmit,
      );
      WebSocketConnectionRegistry.register(
        "conversation-1", viewerWebsocket as unknown as import("ws").WebSocket, viewerEmit,
      );

      const broadcast = WebSocketConnectionRegistry.getEmitFunction("conversation-1", {
        excludeWebsocket: drivingWebsocket as unknown as import("ws").WebSocket,
      });
      expect(broadcast).not.toBeNull();

      broadcast!({ type: "chunk", content: "hello" });
      expect(viewerEmit).toHaveBeenCalledWith({ type: "chunk", content: "hello" });
      expect(drivingEmit).not.toHaveBeenCalled();
    });

    it("should return null when the only registered connection is the excluded one", () => {
      const drivingWebsocket = createMockWebSocket();
      const drivingEmit = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", drivingWebsocket as unknown as import("ws").WebSocket, drivingEmit,
      );

      const broadcast = WebSocketConnectionRegistry.getEmitFunction("conversation-1", {
        excludeWebsocket: drivingWebsocket as unknown as import("ws").WebSocket,
      });
      expect(broadcast).toBeNull();
    });

    it("should support multiple connections per conversation (multi-tab broadcast)", () => {
      const websocketA = createMockWebSocket();
      const websocketB = createMockWebSocket();
      const emitA = vi.fn();
      const emitB = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", websocketA as unknown as import("ws").WebSocket, emitA,
      );
      WebSocketConnectionRegistry.register(
        "conversation-1", websocketB as unknown as import("ws").WebSocket, emitB,
      );

      const broadcastEmit = WebSocketConnectionRegistry.getEmitFunction("conversation-1");
      expect(broadcastEmit).not.toBeNull();

      broadcastEmit!({ type: "broadcast_event" });
      expect(emitA).toHaveBeenCalledWith({ type: "broadcast_event" });
      expect(emitB).toHaveBeenCalledWith({ type: "broadcast_event" });
    });

    it("should not create duplicate registrations for the same WebSocket", () => {
      const websocket = createMockWebSocket();
      const emitFirst = vi.fn();
      const emitUpdated = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", websocket as unknown as import("ws").WebSocket, emitFirst,
      );
      WebSocketConnectionRegistry.register(
        "conversation-1", websocket as unknown as import("ws").WebSocket, emitUpdated,
      );

      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction("conversation-1");
      registeredEmit!({ type: "test" });

      // Should use the updated emit, not the first one
      expect(emitFirst).not.toHaveBeenCalled();
      expect(emitUpdated).toHaveBeenCalledWith({ type: "test" });
    });
  });

  describe("deregisterByWebSocket", () => {
    it("should remove connections for a specific WebSocket", () => {
      const websocket = createMockWebSocket();
      const emitFunction = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", websocket as unknown as import("ws").WebSocket, emitFunction,
      );
      expect(WebSocketConnectionRegistry.getEmitFunction("conversation-1")).not.toBeNull();

      WebSocketConnectionRegistry.deregisterByWebSocket(
        websocket as unknown as import("ws").WebSocket,
      );
      expect(WebSocketConnectionRegistry.getEmitFunction("conversation-1")).toBeNull();
    });

    it("should only remove the matching WebSocket in multi-connection scenarios", () => {
      const websocketA = createMockWebSocket();
      const websocketB = createMockWebSocket();
      const emitA = vi.fn();
      const emitB = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", websocketA as unknown as import("ws").WebSocket, emitA,
      );
      WebSocketConnectionRegistry.register(
        "conversation-1", websocketB as unknown as import("ws").WebSocket, emitB,
      );

      WebSocketConnectionRegistry.deregisterByWebSocket(
        websocketA as unknown as import("ws").WebSocket,
      );

      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction("conversation-1");
      expect(registeredEmit).not.toBeNull();

      registeredEmit!({ type: "after_deregister" });
      expect(emitA).not.toHaveBeenCalled();
      expect(emitB).toHaveBeenCalledWith({ type: "after_deregister" });
    });
  });

  describe("deregister", () => {
    it("should remove all connections for a conversation", () => {
      const websocketA = createMockWebSocket();
      const websocketB = createMockWebSocket();

      WebSocketConnectionRegistry.register(
        "conversation-1", websocketA as unknown as import("ws").WebSocket, vi.fn(),
      );
      WebSocketConnectionRegistry.register(
        "conversation-1", websocketB as unknown as import("ws").WebSocket, vi.fn(),
      );

      WebSocketConnectionRegistry.deregister("conversation-1");
      expect(WebSocketConnectionRegistry.getEmitFunction("conversation-1")).toBeNull();
    });
  });

  describe("stale connection pruning", () => {
    it("should prune closed WebSockets during getEmitFunction lookup", () => {
      const openWebSocket = createMockWebSocket(1);
      const closedWebSocket = createMockWebSocket(3); // CLOSED state
      const emitOpen = vi.fn();
      const emitClosed = vi.fn();

      WebSocketConnectionRegistry.register(
        "conversation-1", openWebSocket as unknown as import("ws").WebSocket, emitOpen,
      );
      WebSocketConnectionRegistry.register(
        "conversation-1", closedWebSocket as unknown as import("ws").WebSocket, emitClosed,
      );

      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction("conversation-1");
      expect(registeredEmit).not.toBeNull();

      registeredEmit!({ type: "prune_test" });
      expect(emitOpen).toHaveBeenCalledWith({ type: "prune_test" });
      expect(emitClosed).not.toHaveBeenCalled();
    });

    it("should return null when all connections are closed", () => {
      const closedWebSocket = createMockWebSocket(3);

      WebSocketConnectionRegistry.register(
        "conversation-1", closedWebSocket as unknown as import("ws").WebSocket, vi.fn(),
      );

      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction("conversation-1");
      expect(registeredEmit).toBeNull();
    });
  });

  describe("hasActiveConnection", () => {
    it("should return true when an open connection exists", () => {
      const websocket = createMockWebSocket(1);
      WebSocketConnectionRegistry.register(
        "conversation-1", websocket as unknown as import("ws").WebSocket, vi.fn(),
      );

      expect(WebSocketConnectionRegistry.hasActiveConnection("conversation-1")).toBe(true);
    });

    it("should return false when no connections exist", () => {
      expect(WebSocketConnectionRegistry.hasActiveConnection("nonexistent")).toBe(false);
    });

    it("should return false when all connections are closed", () => {
      const closedWebSocket = createMockWebSocket(3);
      WebSocketConnectionRegistry.register(
        "conversation-1", closedWebSocket as unknown as import("ws").WebSocket, vi.fn(),
      );

      expect(WebSocketConnectionRegistry.hasActiveConnection("conversation-1")).toBe(false);
    });
  });

  describe("size and clear", () => {
    it("should track the number of registered conversations", () => {
      expect(WebSocketConnectionRegistry.size).toBe(0);

      WebSocketConnectionRegistry.register(
        "conv-1", createMockWebSocket() as unknown as import("ws").WebSocket, vi.fn(),
      );
      expect(WebSocketConnectionRegistry.size).toBe(1);

      WebSocketConnectionRegistry.register(
        "conv-2", createMockWebSocket() as unknown as import("ws").WebSocket, vi.fn(),
      );
      expect(WebSocketConnectionRegistry.size).toBe(2);
    });

    it("should clear all registrations", () => {
      WebSocketConnectionRegistry.register(
        "conv-1", createMockWebSocket() as unknown as import("ws").WebSocket, vi.fn(),
      );
      WebSocketConnectionRegistry.register(
        "conv-2", createMockWebSocket() as unknown as import("ws").WebSocket, vi.fn(),
      );

      WebSocketConnectionRegistry.clear();
      expect(WebSocketConnectionRegistry.size).toBe(0);
      expect(WebSocketConnectionRegistry.getEmitFunction("conv-1")).toBeNull();
    });
  });
});

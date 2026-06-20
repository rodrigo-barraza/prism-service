import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock ChatRoutes & AudioRoutes ─────────────────────────────────────
const mockHandleConversation = vi.fn();
vi.mock("../src/routes/ChatRoutes.ts", () => ({
  handleConversation: (...args: any[]) => mockHandleConversation(...args),
}));

const mockHandleVoice = vi.fn();
vi.mock("../src/routes/AudioRoutes.ts", () => ({
  handleVoice: (...args: any[]) => mockHandleVoice(...args),
}));

// ── Mock GoogleGenAI ──────────────────────────────────────────────────
const mockLiveSession = {
  sendToolResponse: vi.fn(),
  close: vi.fn(),
};
const mockConnect = vi.fn().mockResolvedValue(mockLiveSession);
vi.mock("@google/genai", () => {
  class MockGoogleGenAI {
    live = {
      connect: (...args: any[]) => mockConnect(...args),
    };
  }
  return {
    GoogleGenAI: MockGoogleGenAI,
    Modality: { AUDIO: "AUDIO" },
    StartSensitivity: { START_SENSITIVITY_HIGH: "START_SENSITIVITY_HIGH" },
    EndSensitivity: { END_SENSITIVITY_LOW: "END_SENSITIVITY_LOW" },
  };
});

// ── Mock settings and dependencies ────────────────────────────────────
vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    setGenerating: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio://uploaded-audio.wav" }),
  },
}));

import { setupWebSocket } from "../src/websocket/index.ts";

// ── Helper Mock Classes ───────────────────────────────────────────────
class MockWebSocket {
  send = vi.fn();
  close = vi.fn();
  readyState = 1; // OPEN
  OPEN = 1;
  listeners: Record<string, Function[]> = {};

  on(event: string, callback: Function) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  emit(event: string, ...args: any[]) {
    const list = this.listeners[event] || [];
    for (const callback of list) {
      callback(...args);
    }
  }
}

describe("WebSocket Handler Suite", () => {
  let mockWss: any;

  beforeEach(() => {
    vi.clearAllMocks();

    const wssListeners: Record<string, Function[]> = {};
    mockWss = {
      on: vi.fn().mockImplementation((event, callback) => {
        if (!wssListeners[event]) wssListeners[event] = [];
        wssListeners[event].push(callback);
      }),
      emitConnection: (websocketInstance: any, requestInstance: any) => {
        const list = wssListeners["connection"] || [];
        for (const callback of list) {
          callback(websocketInstance, requestInstance);
        }
      },
    };
  });

  it("should register connection event listener on setup", () => {
    setupWebSocket(mockWss);
    expect(mockWss.on).toHaveBeenCalledWith("connection", expect.any(Function));
  });

  it("should reject connection to unknown path", () => {
    setupWebSocket(mockWss);
    const mockSocket = new MockWebSocket();
    const mockRequest = {
      url: "/ws/unknown-path",
      headers: { host: "localhost" },
      socket: { remoteAddress: "127.0.0.1" },
    };

    mockWss.emitConnection(mockSocket, mockRequest);

    expect(mockSocket.send).toHaveBeenCalledWith(
      expect.stringContaining("Unknown WebSocket path")
    );
    expect(mockSocket.close).toHaveBeenCalled();
  });

  // ── Chat WebSocket Tests ──────────────────────────────────────────
  describe("/ws/chat path", () => {
    it("should handle chat stream and forward messages to ChatRoutes", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/chat?project=my-proj",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      // Simulate client message
      const clientMessage = { message: "Test chat input" };
      mockHandleConversation.mockImplementation(async (payload, emitCallback) => {
        emitCallback({ type: "chunk", content: "Response chunk" });
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify(clientMessage)));

      expect(mockHandleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Test chat input",
          project: "my-proj",
        }),
        expect.any(Function)
      );

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "chunk", content: "Response chunk" })
      );
    });

    it("should send error on malformed JSON", () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/chat",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", "invalid-json");

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "error", message: "Invalid JSON" })
      );
    });
  });

  // ── Voice WebSocket Tests ─────────────────────────────────────────
  describe("/ws/text-to-audio path", () => {
    it("should route voice streaming requests", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/text-to-audio",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      const clientMessage = { text: "Convert to voice", voiceName: "Puck" };
      mockHandleVoice.mockImplementation(async (payload, sendBinary, sendJson) => {
        sendBinary(Buffer.from("fake-audio-bytes"));
        sendJson({ type: "done" });
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify(clientMessage)));

      expect(mockHandleVoice).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Convert to voice",
          voiceName: "Puck",
        }),
        expect.any(Function),
        expect.any(Function)
      );

      expect(mockSocket.send).toHaveBeenCalledWith(Buffer.from("fake-audio-bytes"));
      expect(mockSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "done" }));
    });
  });

  // ── Live API WebSocket Tests ──────────────────────────────────────
  describe("/ws/live path", () => {
    it("should initialize Google Live session on setup message", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      // Simulate client setup message
      const setupMessage = {
        type: "setup",
        model: "gemini-2.0-flash-live",
        config: { voiceName: "Puck" },
      };

      let callbacks: any;
      mockConnect.mockImplementation((params) => {
        callbacks = params.callbacks;
        // Trigger onopen callback asynchronously
        setTimeout(() => callbacks.onopen(), 5);
        return Promise.resolve(mockLiveSession);
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify(setupMessage)));

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-2.0-flash-live",
          config: expect.objectContaining({
            speechConfig: expect.objectContaining({
              voiceConfig: expect.objectContaining({
                prebuiltVoiceConfig: { voiceName: "Puck" },
              }),
            }),
          }),
        })
      );

      // Wait for onopen trigger
      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "setupComplete" })
        );
      });
    });
  });
});

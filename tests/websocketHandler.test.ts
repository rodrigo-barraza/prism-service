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
  sendRealtimeInput: vi.fn(),
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
    Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
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

const mockUploadFile = vi.fn().mockResolvedValue({ ref: "minio://uploaded-audio.wav" });
vi.mock("../src/services/FileService.ts", () => ({
  default: {
    uploadFile: (...args: any[]) => mockUploadFile(...args),
  },
}));

const mockGetToolSchemas = vi.fn().mockReturnValue([]);
const mockExecuteTool = vi.fn().mockResolvedValue({});
vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    getToolSchemas: (...args: any[]) => mockGetToolSchemas(...args),
    executeTool: (...args: any[]) => mockExecuteTool(...args),
  },
}));

const mockGetSection = vi.fn().mockResolvedValue({ topology: "some-topology" });
vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getSection: (...args: any[]) => mockGetSection(...args),
  },
}));

const mockConvertToolsToGoogle = vi.fn().mockImplementation((tools) => {
  return tools.map((t: any) => ({ functionDeclarations: [t] }));
});
vi.mock("../src/providers/google.ts", () => ({
  convertToolsToGoogle: (...args: any[]) => mockConvertToolsToGoogle(...args),
}));

const mockLogChatGeneration = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logChatGeneration: (...args: any[]) => mockLogChatGeneration(...args),
  },
}));

const mockCalculateLiveCost = vi.fn().mockReturnValue(0.05);
vi.mock("../src/utils/CostCalculator.ts", () => ({
  calculateLiveCost: (...args: any[]) => mockCalculateLiveCost(...args),
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {},
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
    mockConnect.mockImplementation((params) => {
      setTimeout(() => params.callbacks.onopen?.(), 5);
      return Promise.resolve(mockLiveSession);
    });

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

    it("should handle invalid JSON gracefully", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/text-to-audio",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", "invalid-json");

      expect(mockSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "error", message: "Invalid JSON" })
      );
    });

    it("should handle voice message exceptions gracefully", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/text-to-audio",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      const clientMessage = { text: "Convert to voice", voiceName: "Puck" };
      mockHandleVoice.mockRejectedValue(new Error("Voice route failed"));

      mockSocket.emit("message", Buffer.from(JSON.stringify(clientMessage)));

      await vi.waitFor(() => {
        expect(mockHandleVoice).toHaveBeenCalled();
      });
    });

    it("should handle close event on websocket for voice path", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/text-to-audio",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);
      mockSocket.emit("close");
      expect(mockSocket.close).not.toHaveBeenCalled();
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

      mockSocket.emit("message", Buffer.from(JSON.stringify(setupMessage)));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "setupComplete" })
        );
      });

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
    });

    it("should establish Gemini Live session with correct config", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      const setupMessage = {
        type: "setup",
        model: "gemini-2.0-flash-live",
        config: {
          voiceName: "Kore",
          systemInstruction: "You are Antigravity.",
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 1024 },
          responseModalities: ["AUDIO", "TEXT"]
        },
      };

      mockSocket.emit("message", Buffer.from(JSON.stringify(setupMessage)));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "setupComplete" })
        );
      });

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-2.0-flash-live",
          config: expect.objectContaining({
            temperature: 0.7,
            thinkingConfig: { thinkingBudget: 1024 },
            responseModalities: ["AUDIO", "TEXT"],
            systemInstruction: expect.stringContaining("You are Antigravity."),
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Kore" },
              },
            },
          }),
        })
      );
    });

    it("should resolve tool schemas for enabled tools", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      const setupMessage = {
        type: "setup",
        config: {
          enabledTools: ["get_weather", "Web Search"],
        },
      };

      mockGetToolSchemas.mockReturnValue([
        { name: "get_weather", description: "Get weather details", parameters: {} }
      ]);

      mockSocket.emit("message", Buffer.from(JSON.stringify(setupMessage)));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "setupComplete" })
        );
      });

      expect(mockGetToolSchemas).toHaveBeenCalled();
      expect(mockConvertToolsToGoogle).toHaveBeenCalledWith([
        { name: "get_weather", description: "Get weather details", parameters: {} }
      ]);
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            tools: expect.arrayContaining([
              { googleSearch: {} },
              { functionDeclarations: [ { name: "get_weather", description: "Get weather details", parameters: {} } ] }
            ]),
          }),
        })
      );
    });

    it("should handle Gemini session connection failure gracefully", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      const setupMessage = {
        type: "setup",
      };

      mockConnect.mockRejectedValue(new Error("Connection refused"));

      mockSocket.emit("message", Buffer.from(JSON.stringify(setupMessage)));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("Failed to connect: Connection refused")
        );
      });
    });

    it("should forward client audio chunks to Gemini session", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify({
        type: "audio",
        data: "fake-audio-chunk",
        mimeType: "audio/pcm;rate=16000",
      })));

      expect(mockLiveSession.sendRealtimeInput).toHaveBeenCalledWith({
        audio: {
          data: "fake-audio-chunk",
          mimeType: "audio/pcm;rate=16000",
        },
      });
    });

    it("should forward audioStreamEnd signal to Gemini session", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "audioStreamEnd" })));

      await vi.waitFor(() => {
        expect(mockLiveSession.sendRealtimeInput).toHaveBeenCalledWith({
          audioStreamEnd: true,
        });
      });
    });

    it("should handle text messages during live session by bracketting with activity start/end", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "hello" })));

      await vi.waitFor(() => {
        expect(mockLiveSession.sendRealtimeInput).toHaveBeenNthCalledWith(1, { activityStart: {} });
        expect(mockLiveSession.sendRealtimeInput).toHaveBeenNthCalledWith(2, { text: "hello" });
        expect(mockLiveSession.sendRealtimeInput).toHaveBeenNthCalledWith(3, { activityEnd: {} });
      });
    });

    it("should handle exceptions when sending text message to live session", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockLiveSession.sendRealtimeInput.mockImplementationOnce(() => {
        throw new Error("Send failed");
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "hello" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("Failed to send text: Send failed")
        );
      });
    });

    it("should build and upload accumulated user audio on first model turn part", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;

      mockSocket.emit("message", Buffer.from(JSON.stringify({
        type: "audio",
        data: Buffer.from("fake-user-pcm").toString("base64"),
      })));

      onMessageCallback({
        serverContent: {
          modelTurn: {
            parts: [{ text: "response-part" }],
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("userAudioReady")
        );
      });
    });

    it("should extract function calls from model turn parts", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onMessageCallback({
        serverContent: {
          modelTurn: {
            parts: [{
              functionCall: {
                name: "get_weather",
                args: { city: "SF" },
              },
            }],
          },
        },
      });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("toolCall")
        );
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("get_weather")
        );
      });
    });

    it("should execute tools and send results back to Gemini session", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;
      mockExecuteTool.mockResolvedValue({ temperature: "68F" });

      onMessageCallback({
        toolCall: {
          functionCalls: [{
            id: "call-123",
            name: "get_weather",
            args: { city: "SF" },
          }],
        },
      });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("calling")
        );
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("done")
        );
        expect(mockExecuteTool).toHaveBeenCalledWith(
          "get_weather",
          { city: "SF" },
          expect.any(Object)
        );
        expect(mockLiveSession.sendToolResponse).toHaveBeenCalledWith({
          functionResponses: [{
            id: "call-123",
            name: "get_weather",
            response: { temperature: "68F" },
          }],
        });
      });
    });

    it("should handle tool execution errors without crashing", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;
      mockExecuteTool.mockRejectedValue(new Error("Execution failed"));

      onMessageCallback({
        toolCall: {
          functionCalls: [{
            id: "call-456",
            name: "get_weather",
            args: { city: "SF" },
          }],
        },
      });

      await vi.waitFor(() => {
        expect(mockExecuteTool).toHaveBeenCalled();
      });
    });

    it("should emit tool error status if execution returns error object", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;
      mockExecuteTool.mockResolvedValue({ error: "API rate limit exceeded" });

      onMessageCallback({
        toolCall: {
          functionCalls: [{
            id: "call-789",
            name: "get_weather",
            args: { city: "SF" },
          }],
        },
      });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("error")
        );
      });
    });

    it("should finalize turn on turnComplete, upload audio and log telemetry", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live?project=my-project&username=rbarraza",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({
        type: "setup",
        conversationId: "conv-123",
      })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onMessageCallback({
        serverContent: {
          modelTurn: {
            parts: [
              { thought: true, text: "I should check weather." },
              { text: "Here is the weather." },
              { inlineData: { data: Buffer.from("fake-pcm-response").toString("base64"), mimeType: "audio/pcm;rate=24000" } }
            ]
          },
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 25,
          }
        }
      });

      onMessageCallback({
        serverContent: {
          turnComplete: true,
        }
      });

      await vi.waitFor(() => {
        expect(mockUploadFile).toHaveBeenCalled();

        expect(mockLogChatGeneration).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: "conv-123",
            text: "Here is the weather.",
            thinking: "I should check weather.",
            project: "my-project",
            username: "rbarraza",
          })
        );

        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("turnComplete")
        );
      });
    });

    it("should finalize turn on interrupted", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onMessageCallback({
        serverContent: {
          interrupted: true,
        }
      });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("interrupted")
        );
      });
    });

    it("should capture and emit transcriptions to the client", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;

      onMessageCallback({
        serverContent: {
          inputTranscription: { text: "user transcribed text" },
          outputTranscription: { text: "model transcribed text" },
        }
      });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "inputTranscription", text: "user transcribed text" })
        );
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "outputTranscription", text: "model transcribed text" })
        );
      });
    });

    it("should handle client-initiated session close", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "close" })));

      await vi.waitFor(() => {
        expect(mockLiveSession.close).toHaveBeenCalled();
      });
    });

    it("should reply with error when message sent without active session", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "text", text: "hello" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "error", message: "No active session. Send a 'setup' message first." })
        );
      });
    });

    it("should handle WebSocket disconnect during active session", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockSocket.emit("close");

      await vi.waitFor(() => {
        expect(mockLiveSession.close).toHaveBeenCalled();
      });
    });

    it("should handle Gemini session onclose callback", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onCloseCallback = mockConnect.mock.calls[0][0].callbacks.onclose;
      onCloseCallback();

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "sessionClosed" })
        );
      });
    });

    it("should handle Gemini session onerror callback", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onErrorCallback = mockConnect.mock.calls[0][0].callbacks.onerror;
      onErrorCallback({ error: { message: "Internal live error" } });

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "error", message: "Internal live error" })
        );
      });
    });

    it("should handle client sending tool responses", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      mockSocket.emit("message", Buffer.from(JSON.stringify({
        type: "toolResponse",
        responses: [{ id: "call-1", response: { ok: true } }]
      })));

      await vi.waitFor(() => {
        expect(mockLiveSession.sendToolResponse).toHaveBeenCalledWith({
          functionResponses: [{ id: "call-1", response: { ok: true } }]
        });
      });
    });

    it("should estimate output tokens from audio duration when outputTokens is 0", async () => {
      setupWebSocket(mockWss);
      const mockSocket = new MockWebSocket();
      const mockRequest = {
        url: "/ws/live",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      };

      mockWss.emitConnection(mockSocket, mockRequest);

      mockSocket.emit("message", Buffer.from(JSON.stringify({ type: "setup" })));

      await vi.waitFor(() => {
        expect(mockSocket.send).toHaveBeenCalledWith(
          expect.stringContaining("setupComplete")
        );
      });

      const onMessageCallback = mockConnect.mock.calls[0][0].callbacks.onmessage;
      const pcmChunk = Buffer.alloc(48000).toString("base64");

      onMessageCallback({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { data: pcmChunk, mimeType: "audio/pcm;rate=24000" } }
            ]
          }
        }
      });

      onMessageCallback({
        serverContent: {
          turnComplete: true,
        }
      });

      await vi.waitFor(() => {
        expect(mockLogChatGeneration).toHaveBeenCalledWith(
          expect.objectContaining({
            usage: expect.objectContaining({
              outputTokens: 32,
            })
          })
        );
      });
    });
  });
});

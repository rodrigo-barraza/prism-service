import "./setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import request from "supertest";
import { app } from "./setup.ts";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import { setupWebSocket } from "../src/websocket/index.ts";
import { PROVIDERS } from "../src/constants.ts";

// Mock @google/genai to prevent real network calls and mock Live API session connection
let mockLiveSessionCallbacks: any = null;
const mockLiveSessionInstance = {
  sendToolResponse: vi.fn(),
  sendRealtimeInput: vi.fn(),
  close: vi.fn(),
};

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    GoogleGenAI: class GoogleGenAI {
      live = {
        connect: async ({ callbacks }: any) => {
          mockLiveSessionCallbacks = callbacks;
          // Eagerly invoke onopen so the connection setup completes
          if (callbacks && typeof callbacks.onopen === "function") {
            setTimeout(() => callbacks.onopen(), 0);
          }
          return mockLiveSessionInstance;
        },
      };
    },
  };
});

describe("Telemetry Context Propagation — Integration Tests", () => {
  let executeToolSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    executeToolSpy = vi.spyOn(ToolOrchestratorService, "executeTool")
      .mockResolvedValue({ success: true, temperature: 72 });
  });

  afterEach(() => {
    executeToolSpy.mockRestore();
  });

  it("should propagate full context headers to executeTool in chat function calling loop", async () => {
    const { MOCK_GENERATE_TEXT_STREAM } = await import("./setup.ts");
    
    // Configure the mock text stream to yield a toolCall chunk followed by usage
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield {
        type: "toolCall",
        id: "call-123",
        name: "get_weather",
        args: { location: "Seattle" },
      };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    });

    await request(app)
      .post("/chat")
      .set("Authorization", "Bearer test-secret")
      .set("x-project", "my-project")
      .set("x-username", "test-user")
      .set("x-agent", "OMNI")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        agent: "OMNI",
        functionCallingEnabled: true,
        messages: [{ role: "user", content: "What is the weather?" }],
      })
      .expect(200);

    expect(executeToolSpy).toHaveBeenCalled();
    const lastCallContext = executeToolSpy.mock.calls[0][2];
    expect(lastCallContext).toBeDefined();
    expect(lastCallContext.project).toBe("my-project");
    expect(lastCallContext.username).toBe("test-user");
    expect(lastCallContext.agent).toBe("OMNI");
    expect(lastCallContext.requestId).toBeDefined();
    expect(lastCallContext.conversationId).toBeDefined();
    expect(lastCallContext.iteration).toBe(1);
    expect(lastCallContext._providerName).toBe(PROVIDERS.GOOGLE);
    expect(lastCallContext._resolvedModel).toBe("gemini-3.5-flash");
  });

  it("should propagate full context headers to executeTool in WebSocket Live API tool connection", async () => {
    let connectionHandler: any = null;
    const mockWss = {
      on: vi.fn().mockImplementation((event, callback) => {
        if (event === "connection") {
          connectionHandler = callback;
        }
      }),
    };

    // Initialize the WebSocket router
    setupWebSocket(mockWss as any);
    expect(connectionHandler).toBeDefined();

    const mockWs = {
      readyState: 1, // OPEN
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };

    const mockReq = {
      url: "/ws/live",
      headers: {
        host: "localhost",
        "x-project": "my-project",
        "x-username": "test-user",
        "x-agent": "my-agent",
        "x-forwarded-for": "127.0.0.1",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    };

    // Trigger the client connection
    connectionHandler(mockWs, mockReq);

    // Retrieve the registered message handler
    const messageCall = mockWs.on.mock.calls.find((call: any) => call[0] === "message");
    expect(messageCall).toBeDefined();
    const messageHandler = messageCall![1];

    // Trigger setup message
    await messageHandler(
      JSON.stringify({
        type: "setup",
        model: "gemini-2.0-flash-live-001",
        conversationId: "live-conv-789",
        config: {
          enabledTools: ["get_weather"],
        },
      })
    );

    // Give asynchronous connection hooks time to resolve onopen
    await vi.waitFor(() => {
      expect(mockLiveSessionCallbacks).not.toBeNull();
    });

    // Simulate incoming tool call from Google Live API
    await mockLiveSessionCallbacks.onmessage({
      toolCall: {
        functionCalls: [
          {
            id: "live-call-456",
            name: "get_weather",
            args: { location: "Portland" },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(executeToolSpy).toHaveBeenCalled();
    });
    const lastCallContext = executeToolSpy.mock.calls[0][2];
    expect(lastCallContext).toBeDefined();
    expect(lastCallContext.project).toBe("my-project");
    expect(lastCallContext.username).toBe("test-user");
    expect(lastCallContext.agent).toBe("my-agent");
    expect(lastCallContext.conversationId).toBe("live-conv-789");
    expect(lastCallContext.clientIp).toBe("127.0.0.1");
    expect(lastCallContext._providerName).toBe(PROVIDERS.GOOGLE);
    expect(lastCallContext._resolvedModel).toBe("gemini-2.0-flash-live-001");
  });
});

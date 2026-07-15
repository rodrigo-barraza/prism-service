/**
 * SseUtilities — tests for buildJsonResponseFromEvents, the non-streaming
 * response builder used by every ?stream=false request.
 *
 * Every non-streaming chat/agent call goes through this function to
 * convert collected SSE events into a flat JSON response. Bugs here
 * break all non-streaming API consumers.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/config", () => ({
  PRISM_SERVICE_PORT: 0,
  OPENAI_API_KEY: "fake",
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_CLOUD_GEMINI_API_KEY: "fake",
  ELEVENLABS_API_KEY: "fake",
  INWORLD_BASIC: "fake",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_URI: "mongodb://test:test@localhost:27017",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    createClient: vi.fn(),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("#src/services/ConversationService", () => ({
  default: {
    appendMessages: vi.fn(),
    setGenerating: vi.fn(),
    getConversationStats: vi.fn(),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { log: vi.fn(), logChatGeneration: vi.fn(), logBackgroundLlmCall: vi.fn() },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    get: vi.fn().mockResolvedValue({}),
    getSection: vi.fn().mockResolvedValue({}),
    getMemoryModelConfig: vi.fn().mockResolvedValue({ provider: PROVIDERS.GOOGLE, model: "test" }),
    invalidateCache: vi.fn(),
    getDefaults: vi.fn(),
  },
}));

import { PROVIDERS, MODALITY_TYPES, MODEL_TYPES } from "#src/constants";


vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn(),
  listProviders: () => [],
}));

const { buildJsonResponseFromEvents, withDirectViewerBroadcast } = await import(
  "#src/utils/SseUtilities"
);
const WebSocketConnectionRegistry = (
  await import("#src/websocket/WebSocketConnectionRegistry")
).default;

import type { SseEvent } from "#src/types/SseTypes";
import type { ChatRequest } from "#src/types/schemas";

function callBuildJsonResponse(events: SseEvent[], requestBody: Partial<ChatRequest>) {
  return buildJsonResponseFromEvents(events, {
    provider: PROVIDERS.OPENAI,
    messages: [],
    ...requestBody,
  } as ChatRequest);
}

// ── Types ──────────────────────────────────────────────────────
type TestEvent = SseEvent;

// ═══════════════════════════════════════════════════════════════
describe("buildJsonResponseFromEvents", () => {
  it("should assemble text from chunk events", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Hello " },
      { type: "chunk", content: "world!" },
      {
        type: "done",
        provider: PROVIDERS.OPENAI,
        model: "gpt-5.5",
        usage: { inputTokens: 10, outputTokens: 5 },
        estimatedCost: 0.001,
      },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.OPENAI,
      model: "gpt-5.5",
    });

    expect(result.error).toBeUndefined();
    expect(result.response!.text).toBe("Hello world!");
    expect(result.response!.provider).toBe(PROVIDERS.OPENAI);
    expect(result.response!.model).toBe("gpt-5.5");
    expect(result.response!.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.response!.estimatedCost).toBe(0.001);
  });

  it("should return null text when no chunk events exist", () => {
    const events: TestEvent[] = [
      { type: "done", provider: PROVIDERS.GOOGLE, model: "gemini-3.5-flash" },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.text).toBeNull();
  });

  it("should assemble thinking from thinking events", () => {
    const events: TestEvent[] = [
      { type: "thinking", content: "Let me " },
      { type: "thinking", content: "reason..." },
      { type: "chunk", content: "Answer here" },
      { type: "done", provider: PROVIDERS.ANTHROPIC, model: "claude-opus-4" },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.ANTHROPIC,
    });

    expect(result.response!.thinking).toBe("Let me reason...");
    expect(result.response!.text).toBe("Answer here");
  });

  it("should return null thinking when no thinking events exist", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Simple answer" },
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.thinking).toBeNull();
  });

  it("should collect images from image events", () => {
    const events: TestEvent[] = [
      {
        type: MODALITY_TYPES.IMAGE,
        data: "base64data",
        mimeType: "image/png",
        minioRef: "minio://images/1.png",
      },
      { type: "done", provider: PROVIDERS.OPENAI },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.OPENAI,
    });

    expect(result.response!.images).toHaveLength(1);
    expect(result.response!.images![0]).toEqual({
      data: "base64data",
      mimeType: "image/png",
      minioRef: "minio://images/1.png",
    });
  });

  it("should omit images when no image events exist", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Text only" },
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.images).toBeUndefined();
  });

  it("should collect tool calls from tool_execution events with calling status", () => {
    const events: TestEvent[] = [
      {
        type: "tool_execution",
        status: "calling",
        tool: { name: "read_file", args: { path: "/etc/hosts" } },
      },
      {
        type: "tool_execution",
        status: "done",
        tool: { name: "read_file", args: {}, result: "contents" },
      },
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    // Only "calling" status should be included
    expect(result.response!.toolCalls).toHaveLength(1);
    expect(result.response!.toolCalls![0].name).toBe("read_file");
  });

  it("should return error for events containing an error event", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Partial..." },
      { type: "error", message: "Rate limit exceeded" },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.OPENAI,
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("Rate limit exceeded");
  });

  it("should use 'Unknown error' when error event has no message", () => {
    const events: TestEvent[] = [{ type: "error" }];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.OPENAI,
    });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("Unknown error");
  });

  it("should fall back to request body for provider/model when done event lacks them", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Answer" },
      { type: "done" },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-4-sonnet",
    });

    expect(result.response!.provider).toBe(PROVIDERS.ANTHROPIC);
    expect(result.response!.model).toBe("claude-4-sonnet");
  });

  it("should include traceId from done event when present", () => {
    const events: TestEvent[] = [
      { type: "done", provider: PROVIDERS.GOOGLE, traceId: "trace-abc-123" },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.traceId).toBe("trace-abc-123");
  });

  it("should not include traceId when absent", () => {
    const events: TestEvent[] = [
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response).not.toHaveProperty("traceId");
  });

  it("should include conversationId from done event when present", () => {
    const events: TestEvent[] = [
      {
        type: "done",
        provider: PROVIDERS.GOOGLE,
        conversationId: "conv-xyz",
      },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.conversationId).toBe("conv-xyz");
  });

  it("should handle estimatedCost of 0 (not null)", () => {
    const events: TestEvent[] = [
      { type: "done", provider: "local", estimatedCost: 0 },
    ];

    const result = callBuildJsonResponse(events, {
      provider: "local",
    });

    expect(result.response!.estimatedCost).toBe(0);
  });

  it("should handle null estimatedCost", () => {
    const events: TestEvent[] = [
      { type: "done", provider: "local" },
    ];

    const result = callBuildJsonResponse(events, {
      provider: "local",
    });

    expect(result.response!.estimatedCost).toBeNull();
  });

  it("should collect toolResults from done/error tool_execution events", () => {
    const events: TestEvent[] = [
      {
        type: "tool_execution",
        status: "calling",
        tool: { name: "generate_audio", args: { prompt: "chirp" } },
      },
      {
        type: "tool_execution",
        status: "done",
        tool: {
          name: "generate_audio",
          args: { prompt: "chirp" },
          result: { audioRef: "audio-ref-123" },
        },
      },
      {
        type: "tool_execution",
        status: "error",
        tool: {
          name: "generate_audio",
          args: { prompt: "chirp" },
          result: "Something went wrong",
        },
      },
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.toolResults).toHaveLength(2);
    expect(result.response!.toolResults![0]).toEqual({
      name: "generate_audio",
      args: { prompt: "chirp" },
      result: { audioRef: "audio-ref-123" },
      status: "done",
    });
    expect(result.response!.toolResults![1]).toEqual({
      name: "generate_audio",
      args: { prompt: "chirp" },
      result: "Something went wrong",
      status: "error",
    });
  });

  it("should collect audio events and extract audioRef from done event", () => {
    const events: TestEvent[] = [
      {
        type: MODEL_TYPES.AUDIO,
        data: "audioBase64",
        mimeType: "audio/wav",
        minioRef: "minio://audio/1.wav",
      },
      {
        type: "done",
        provider: PROVIDERS.GOOGLE,
        audioRef: "audio-ref-789",
      },
    ];

    const result = callBuildJsonResponse(events, {
      provider: PROVIDERS.GOOGLE,
    });

    expect(result.response!.audio).toHaveLength(1);
    expect(result.response!.audio![0]).toEqual({
      data: "audioBase64",
      mimeType: "audio/wav",
      minioRef: "minio://audio/1.wav",
    });
    expect(result.response!.audioRef).toBe("audio-ref-789");
  });
});

// ═══════════════════════════════════════════════════════════════
// withDirectViewerBroadcast — mirrors generation events to WebSocket
// clients subscribed directly to the conversation (admin viewer,
// second tab). Regression: /admin/chat showed no live content for
// main-agent conversations because tokens only ever reached the
// initiating client's SSE response.
// ═══════════════════════════════════════════════════════════════

describe("withDirectViewerBroadcast", () => {
  function createMockWebSocket() {
    return { readyState: 1, OPEN: 1, send: vi.fn() };
  }

  it("returns the primary emit unchanged when there is no conversationId", () => {
    const primaryEmit = vi.fn();
    expect(withDirectViewerBroadcast(undefined, primaryEmit)).toBe(primaryEmit);
  });

  it("delivers each event to the primary emit AND registered direct viewers", () => {
    WebSocketConnectionRegistry.clear();
    const viewerEmit = vi.fn();
    WebSocketConnectionRegistry.register(
      "conv-live-1",
      createMockWebSocket() as unknown as import("ws").WebSocket,
      viewerEmit,
    );

    const primaryEmit = vi.fn();
    const emit = withDirectViewerBroadcast("conv-live-1", primaryEmit);

    const chunkEvent = { type: "chunk", content: "hello" } as unknown as TestEvent;
    emit(chunkEvent);

    expect(primaryEmit).toHaveBeenCalledWith(chunkEvent);
    expect(viewerEmit).toHaveBeenCalledWith(chunkEvent);
    WebSocketConnectionRegistry.clear();
  });

  it("still emits to the primary consumer when no viewers are registered", () => {
    WebSocketConnectionRegistry.clear();
    const primaryEmit = vi.fn();
    const emit = withDirectViewerBroadcast("conv-live-2", primaryEmit);

    const event = { type: "thinking", content: "…" } as unknown as TestEvent;
    emit(event);

    expect(primaryEmit).toHaveBeenCalledWith(event);
  });

  it("strips heavy base64 image data for viewers when a minioRef exists", () => {
    WebSocketConnectionRegistry.clear();
    const viewerEmit = vi.fn();
    WebSocketConnectionRegistry.register(
      "conv-live-3",
      createMockWebSocket() as unknown as import("ws").WebSocket,
      viewerEmit,
    );

    const primaryEmit = vi.fn();
    const emit = withDirectViewerBroadcast("conv-live-3", primaryEmit);
    emit({
      type: "image",
      data: "hugebase64",
      minioRef: "minio://images/1.png",
    } as unknown as TestEvent);

    expect(viewerEmit).toHaveBeenCalledWith({
      type: "image",
      minioRef: "minio://images/1.png",
    });
    WebSocketConnectionRegistry.clear();
  });

  it("never lets a failing viewer break the primary stream", () => {
    WebSocketConnectionRegistry.clear();
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

    expect(() =>
      emit({ type: "chunk", content: "x" } as unknown as TestEvent),
    ).not.toThrow();
    expect(primaryEmit).toHaveBeenCalled();
    WebSocketConnectionRegistry.clear();
  });
});

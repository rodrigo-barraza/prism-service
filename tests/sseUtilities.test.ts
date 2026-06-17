/**
 * SseUtilities — tests for buildJsonResponseFromEvents, the non-streaming
 * response builder used by every ?stream=false request.
 *
 * Every non-streaming chat/agent call goes through this function to
 * convert collected SSE events into a flat JSON response. Bugs here
 * break all non-streaming API consumers.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.ts", () => ({
  PRISM_SERVICE_PORT: 0,
  GATEWAY_SECRET: "test",
  OPENAI_API_KEY: "fake",
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_API_KEY: "fake",
  ELEVENLABS_API_KEY: "fake",
  INWORLD_BASIC: "fake",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:9999",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_URI: "mongodb://test:test@localhost:27017",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    createClient: vi.fn(),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    appendMessages: vi.fn(),
    setGenerating: vi.fn(),
    getSessionStats: vi.fn(),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: { log: vi.fn(), logChatGeneration: vi.fn(), logBackgroundLlmCall: vi.fn() },
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    get: vi.fn().mockResolvedValue({}),
    getSection: vi.fn().mockResolvedValue({}),
    getMemoryModelConfig: vi.fn().mockResolvedValue({ provider: PROVIDERS.GOOGLE, model: "test" }),
    invalidateCache: vi.fn(),
    getDefaults: vi.fn(),
  },
}));

import { PROVIDERS } from "../src/constants.ts";


vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn(),
  listProviders: () => [],
}));

const { buildJsonResponseFromEvents } = await import(
  "../src/utils/SseUtilities.ts"
);

import type { SseEvent } from "../src/types/SseTypes.ts";

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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.OPENAI,
      model: "gpt-5.5",
    } as any);

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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

    expect(result.response!.text).toBeNull();
  });

  it("should assemble thinking from thinking events", () => {
    const events: TestEvent[] = [
      { type: "thinking", content: "Let me " },
      { type: "thinking", content: "reason..." },
      { type: "chunk", content: "Answer here" },
      { type: "done", provider: PROVIDERS.ANTHROPIC, model: "claude-opus-4" },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.ANTHROPIC,
    } as any);

    expect(result.response!.thinking).toBe("Let me reason...");
    expect(result.response!.text).toBe("Answer here");
  });

  it("should return null thinking when no thinking events exist", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Simple answer" },
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

    expect(result.response!.thinking).toBeNull();
  });

  it("should collect images from image events", () => {
    const events: TestEvent[] = [
      {
        type: "image",
        data: "base64data",
        mimeType: "image/png",
        minioRef: "minio://images/1.png",
      },
      { type: "done", provider: PROVIDERS.OPENAI },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.OPENAI,
    } as any);

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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

    // Only "calling" status should be included
    expect(result.response!.toolCalls).toHaveLength(1);
    expect(result.response!.toolCalls![0].name).toBe("read_file");
  });

  it("should return error for events containing an error event", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Partial..." },
      { type: "error", message: "Rate limit exceeded" },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.OPENAI,
    } as any);

    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("Rate limit exceeded");
  });

  it("should use 'Unknown error' when error event has no message", () => {
    const events: TestEvent[] = [{ type: "error" }];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.OPENAI,
    } as any);

    expect(result.error).toBeDefined();
    expect(result.error!.message).toBe("Unknown error");
  });

  it("should fall back to request body for provider/model when done event lacks them", () => {
    const events: TestEvent[] = [
      { type: "chunk", content: "Answer" },
      { type: "done" },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-4-sonnet",
    } as any);

    expect(result.response!.provider).toBe(PROVIDERS.ANTHROPIC);
    expect(result.response!.model).toBe("claude-4-sonnet");
  });

  it("should include traceId from done event when present", () => {
    const events: TestEvent[] = [
      { type: "done", provider: PROVIDERS.GOOGLE, traceId: "trace-abc-123" },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

    expect(result.response!.traceId).toBe("trace-abc-123");
  });

  it("should not include traceId when absent", () => {
    const events: TestEvent[] = [
      { type: "done", provider: PROVIDERS.GOOGLE },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

    expect(result.response!.conversationId).toBe("conv-xyz");
  });

  it("should handle estimatedCost of 0 (not null)", () => {
    const events: TestEvent[] = [
      { type: "done", provider: "local", estimatedCost: 0 },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: "local",
    } as any);

    expect(result.response!.estimatedCost).toBe(0);
  });

  it("should handle null estimatedCost", () => {
    const events: TestEvent[] = [
      { type: "done", provider: "local" },
    ];

    const result = buildJsonResponseFromEvents(events as any, {
      provider: "local",
    } as any);

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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

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
        type: "audio",
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

    const result = buildJsonResponseFromEvents(events as any, {
      provider: PROVIDERS.GOOGLE,
    } as any);

    expect(result.response!.audio).toHaveLength(1);
    expect(result.response!.audio![0]).toEqual({
      data: "audioBase64",
      mimeType: "audio/wav",
      minioRef: "minio://audio/1.wav",
    });
    expect(result.response!.audioRef).toBe("audio-ref-789");
  });
});

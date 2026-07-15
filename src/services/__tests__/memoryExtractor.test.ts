import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import MemoryExtractor from "#src/services/MemoryExtractor";
import MemoryService from "#src/services/MemoryService";
import SettingsService from "#src/services/SettingsService";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";

const mockGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/services/MemoryService", async (importOriginal) => {
  const actualModule = await importOriginal<typeof import("../MemoryService.ts")>();
  return {
    default: {
      store: vi.fn().mockResolvedValue({ id: "mem-uuid-1" }),
    },
    CODING_MEMORY_TYPES: actualModule.CODING_MEMORY_TYPES,
  };
});

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      extractionProvider: PROVIDERS.GOOGLE,
      extractionModel: "gemini-3-flash-preview",
      embeddingModel: "gemini-embedding-2-preview"
    }),
  },
}));

vi.mock("#src/services/MemoryConsolidationService", () => ({
  default: {
    checkAndRun: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn(),
  },
}));

describe("MemoryExtractor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should skip extraction if message count is below threshold", async () => {
    const results = await MemoryExtractor.extractAndStore({
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "hey" },
        { role: "assistant", content: "hello" }
      ]
    });

    expect(results).toEqual([]);
    expect(SettingsService.getSection).not.toHaveBeenCalled();
  });

  it("should skip extraction if toolCalls contains save_memory", async () => {
    const results = await MemoryExtractor.extractAndStore({
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" }
      ],
      toolCalls: [{ id: "call1", name: "save_memory", args: {} }]
    });

    expect(results).toEqual([]);
    expect(SettingsService.getSection).not.toHaveBeenCalled();
  });

  it("should skip extraction if provider or model is not configured", async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValueOnce({
      extractionProvider: "",
      extractionModel: ""
    });

    const results = await MemoryExtractor.extractAndStore({
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" }
      ]
    });

    expect(results).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("should extract memories, store them, and emit SSE updates on success", async () => {
    const extractedData = [
      {
        type: "user",
        title: "Senior Developer",
        content: "User is a senior developer working in TypeScript"
      }
    ];

    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(extractedData),
      usage: { inputTokens: 50, outputTokens: 20 }
    });

    const emitSpy = vi.fn();

    const results = await MemoryExtractor.extractAndStore({
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" }
      ],
      emit: emitSpy
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "user",
      id: "mem-uuid-1",
      title: "Senior Developer"
    });

    expect(MemoryService.store).toHaveBeenCalledTimes(1);
    expect(MemoryService.store).toHaveBeenCalledWith(expect.objectContaining({
      type: "user",
      title: "Senior Developer",
      content: "User is a senior developer working in TypeScript"
    }));

    // Expecting 2 SSE calls: 1 for extraction usage, 1 for embedding usage
    expect(emitSpy).toHaveBeenCalledTimes(2);
    (expect(emitSpy) as any).toHaveBeenNestedObject({
      type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE
    });
  });

  it("should correctly handle wrapped memories inside object responses", async () => {
    const extractedData = {
      memories: [
        {
          type: "project",
          title: "Blue-green deployment",
          content: "Use blue-green deployments for production"
        }
      ]
    };

    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(extractedData),
      usage: { inputTokens: 50, outputTokens: 20 }
    });

    const results = await MemoryExtractor.extractAndStore({
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Blue-green deployment");
  });

  it("should extract a single object memory response wrapping in array", async () => {
    const extractedData = {
      type: "reference",
      title: "Grafana Link",
      content: "http://grafana.dev"
    };

    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify(extractedData),
      usage: { inputTokens: 50, outputTokens: 20 }
    });

    const results = await MemoryExtractor.extractAndStore({
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" }
      ]
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Grafana Link");
  });

  it("should create afterResponse hook and execute fire-and-forget extractAndStore and consolidation trigger", async () => {
    const hook = MemoryExtractor.createHook();
    expect(hook).toBeTypeOf("function");

    const emitSpy = vi.fn();
    const contextMock: any = {
      project: "test-proj",
      username: "rodrigo",
      messages: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "msg4" }
      ],
      emit: emitSpy,
      agent: "CODING"
    };

    mockGenerateText.mockResolvedValueOnce({
      text: JSON.stringify([{ type: "user", title: "Dev", content: "Likes oklch" }])
    });

    // Execute hook
    await hook(contextMock, {});

    // Hook is fire-and-forget, but because we await inside the test environment hook resolved,
    // let's wait for microtasks to flush
    await vi.waitFor(() => {
      expect(MemoryService.store).toHaveBeenCalled();
    });

    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.MEMORIES_UPDATED
    }));

    expect(MemoryConsolidationService.checkAndRun).toHaveBeenCalled();
  });
});

// Helper expectation for checking nested object structure in mock calls
expect.extend({
  toHaveBeenNestedObject(received: any, expectedPartial: any) {
    const passed = received.mock.calls.some((call: any) =>
      call.some((arg: any) =>
        arg && typeof arg === "object" && Object.keys(expectedPartial).every(key => arg[key] === expectedPartial[key])
      )
    );
    return {
      pass: passed,
      message: () => `expected mock function to have been called with nested object matching ${JSON.stringify(expectedPartial)}`
    };
  }
});

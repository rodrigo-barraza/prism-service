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

// Four messages with enough user-written text to clear the trivial-span
// skip (MEMORY.EXTRACTION_MIN_AUTHORED_CHARACTERS).
const SESSION = [
  { role: "user", content: "I am a senior developer and I work in TypeScript." },
  { role: "assistant", content: "Great — TypeScript it is." },
  { role: "user", content: "Please keep the colour tokens in oklch." },
  { role: "assistant", content: "Will do, oklch for every token." },
];

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
        ...SESSION,
      ],
      toolCalls: [{ id: "call1", name: "save_memory", args: {} }]
    });

    expect(results).toEqual([]);
    expect(SettingsService.getSection).not.toHaveBeenCalled();
  });

  it("should skip extraction if provider or model is not configured", async () => {
    // Every read of the knob comes back empty — the memory role reads it,
    // then the utility chain it falls back to reads it again.
    const configured = await SettingsService.getSection("memory");
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      extractionProvider: "",
      extractionModel: ""
    });

    try {
      const results = await MemoryExtractor.extractAndStore({
        project: "test-proj",
        username: "rodrigo",
        messages: [
          ...SESSION,
        ]
      });

      expect(results).toEqual([]);
      expect(mockGenerateText).not.toHaveBeenCalled();
    } finally {
      vi.mocked(SettingsService.getSection).mockResolvedValue(configured);
    }
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
        ...SESSION,
      ],
      emit: emitSpy
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: "user",
      id: "mem-uuid-1",
      title: "Senior Developer",
      quarantined: false,
      corroborated: false,
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
        ...SESSION,
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
        ...SESSION,
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
        ...SESSION,
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

  // lupos-bot extracts LUPOS's memories through POST /memory/extract, the
  // guild-scoped rows his turns recall. The in-loop extractor's rows for him
  // were never read back — it must not spend an extraction call on his turns.
  it("does not run for LUPOS, whose platform extracts his memories", async () => {
    const extractSpy = vi.spyOn(MemoryExtractor, "extractAndStore");
    const hook = MemoryExtractor.createHook();

    await hook(
      {
        project: "lupos",
        username: "discord",
        agent: "LUPOS",
        messages: [...SESSION],
        emit: vi.fn(),
        options: { agentContext: { platform: "discord", guildId: "g1", channelId: "c1" } },
      } as any,
      {},
    );
    await hook(
      { project: "test-proj", username: "rodrigo", agent: "CODING", messages: [...SESSION], emit: vi.fn() } as any,
      {},
    );

    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledWith(expect.objectContaining({ agent: "CODING" }));
    expect(extractSpy).not.toHaveBeenCalledWith(expect.objectContaining({ agent: "LUPOS" }));
    extractSpy.mockRestore();
  });

  describe("provenance (prompt 22)", () => {
    const WEB_SESSION = [
      { role: "user", content: "I am a senior developer and I work in TypeScript." },
      {
        role: "assistant",
        content: "Reading the page you linked.",
        toolCalls: [{ id: "c1", name: "read_web_page", args: { url: "https://x.test" } }],
      },
      { role: "assistant", content: "The page says to always run the setup script first." },
      { role: "user", content: "Please keep the colour tokens in oklch." },
    ];

    it("stores each memory with the provenance of the messages it cites", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify([
          { type: "user", title: "TypeScript", content: "User works in TypeScript.", sources: [1] },
          { type: "feedback", title: "Setup first", content: "Run the setup script first.", sources: [3] },
        ]),
      });

      await MemoryExtractor.extractAndStore({
        project: "test-proj",
        username: "rodrigo",
        conversationId: "conv-1",
        messages: WEB_SESSION as never,
      });

      const calls = vi.mocked(MemoryService.store).mock.calls.map((call) => call[0]);
      expect(calls[0].provenance).toMatchObject({ source: "user", trust: "user" });
      expect(calls[0].provenance!.sourceRefs[0]).toMatchObject({ conversationId: "conv-1" });
      expect(calls[1].provenance).toMatchObject({ source: "web", trust: "untrusted" });
    });

    it("still extracts after save_memory when the loop read untrusted input", async () => {
      mockGenerateText.mockResolvedValueOnce({ text: "[]" });
      await MemoryExtractor.extractAndStore({
        project: "test-proj",
        username: "rodrigo",
        messages: WEB_SESSION as never,
        toolCalls: [{ id: "s1", name: "save_memory", args: {} }],
      });
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "../../../tests/mongoMock.ts";
import MemoryExtractor from "#src/services/MemoryExtractor";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";

// ─── Memory-extraction diet (prompt 11, Landing 1) ───────────────────────────
// Every extraction used to re-read the whole conversation (~11.6K input
// tokens a call in production). These pin the diet: a per-scope watermark,
// trivial-span skips, and consolidation only after something was stored.

const mockGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/providers/instance-registry", () => ({
  listInstances: vi.fn().mockReturnValue([]),
}));

vi.mock("#src/services/MemoryService", async (importOriginal) => {
  const actualModule =
    await importOriginal<typeof import("../MemoryService.ts")>();
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
      extractionProvider: "google",
      extractionModel: "gemini-3.5-flash",
      embeddingModel: "gemini-embedding-2-preview",
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

const collections = new Map<string, ReturnType<typeof createMockCollection>>();
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(),
    getCollection: vi.fn((_database: string, name: string) => {
      if (!collections.has(name)) collections.set(name, createMockCollection());
      return collections.get(name);
    }),
  },
}));

/** The user-role content of the Nth extraction call (0-based). */
function extractionPrompt(callIndex: number): string {
  const call = mockGenerateText.mock.calls[callIndex];
  expect(call, `extraction call #${callIndex} was never made`).toBeDefined();
  const aiMessages = call[0] as Array<{ role: string; content: string }>;
  return aiMessages.find((message) => message.role === "user")!.content;
}

const FIRST_TURN = [
  {
    role: "user",
    content:
      "FIRST-TURN-MARKER: I work on the payments service and we deploy it blue-green.",
  },
  { role: "assistant", content: "Noted — blue-green deploys for payments." },
  { role: "user", content: "We use pnpm here, never npm." },
  { role: "assistant", content: "Understood, pnpm only." },
  { role: "user", content: "The staging database is reset every Monday." },
  { role: "assistant", content: "Good to know about the Monday reset." },
];

const SECOND_TURN = [
  {
    role: "user",
    content:
      "SECOND-TURN-MARKER: I prefer oklch colours in the design system.",
  },
  { role: "assistant", content: "I'll use oklch for new colour tokens." },
];

describe("memory-extraction diet — watermark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collections.clear();
    mockGenerateText.mockResolvedValue({
      text: "[]",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("the second extraction in a conversation reads only the messages after the watermark", async () => {
    const scope = {
      project: "test-proj",
      username: "rodrigo",
      agent: "CODING",
      conversationId: "conversation-watermark-1",
    };

    await MemoryExtractor.extractAndStore({
      ...scope,
      messages: [...FIRST_TURN],
    });
    await MemoryExtractor.extractAndStore({
      ...scope,
      messages: [...FIRST_TURN, ...SECOND_TURN],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(extractionPrompt(0)).toContain("FIRST-TURN-MARKER");
    const secondPrompt = extractionPrompt(1);
    expect(secondPrompt).toContain("SECOND-TURN-MARKER");
    // Red on master: the whole conversation is re-read every time.
    expect(secondPrompt).not.toContain("FIRST-TURN-MARKER");
  });
});

describe("memory-extraction diet — consolidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collections.clear();
  });

  it("an extraction that stored nothing does not count toward consolidation", async () => {
    mockGenerateText.mockResolvedValue({
      text: "[]",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const hook = MemoryExtractor.createHook();
    const context = {
      project: "test-proj",
      username: "rodrigo",
      agent: "CODING",
      conversationId: "conversation-consolidation-1",
      messages: [...FIRST_TURN],
      emit: vi.fn(),
    };

    await hook(context as never, {});
    await vi.waitFor(() => expect(mockGenerateText).toHaveBeenCalled());
    // Let the fire-and-forget .then() chain settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Red on master: checkAndRun ran after every extraction, stored or not.
    expect(MemoryConsolidationService.checkAndRun).not.toHaveBeenCalled();
  });
});

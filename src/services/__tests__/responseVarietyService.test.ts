import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

const mockToArray = vi.fn();
const mockLimit = vi.fn(() => ({ toArray: mockToArray }));
const mockSort = vi.fn(() => ({ limit: mockLimit }));
const mockFind = vi.fn((..._arguments: unknown[]) => ({ sort: mockSort }));
const mockCreateIndex = vi.fn().mockResolvedValue("ok");

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: vi.fn(() => ({ find: mockFind })),
    getDb: vi.fn(() => ({
      collection: vi.fn(() => ({ createIndex: mockCreateIndex })),
    })),
  },
}));

vi.mock("#src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.ts")>();
  return {
    ...actual,
    MONGO_DB_NAME: "prism_test",
  };
});

import ResponseVarietyService from "#src/services/ResponseVarietyService";

function conversationDocument(id: string, updatedAt: string, replyText: string | null) {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "<discord-message>hi</discord-message>" },
  ];
  if (replyText !== null) {
    messages.push({ role: "assistant", content: replyText });
  }
  return { id, updatedAt, messages };
}

describe("ResponseVarietyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ResponseVarietyService._resetForTests();
  });

  it("renders recent replies plus a seasoning line", async () => {
    mockToArray.mockResolvedValue([
      conversationDocument("c1", "2026-07-15T10:00:00Z", "Reply to Alice."),
      conversationDocument("c2", "2026-07-15T09:00:00Z", "Reply to Bob."),
    ]);

    const block = await ResponseVarietyService.renderBlock({
      agentId: "LUPOS",
      project: "lupos",
      currentConversationId: "current",
      locale: "en",
    });

    expect(block).not.toBeNull();
    expect(block).toContain("# Your recent replies");
    expect(block).toContain('- "Reply to Alice."');
    expect(block).toContain('- "Reply to Bob."');
    expect(block).toContain("Delivery note for THIS reply only");
  });

  it("excludes the current conversation and scopes by agent + project", async () => {
    mockToArray.mockResolvedValue([]);

    await ResponseVarietyService.renderBlock({
      agentId: "LUPOS",
      project: "lupos",
      currentConversationId: "current-conv",
      locale: "en",
    });

    const filter = mockFind.mock.calls[0][0];
    expect(filter).toMatchObject({
      agent: "LUPOS",
      project: "lupos",
      id: { $ne: "current-conv" },
    });
  });

  it("deduplicates identical replies and truncates long ones", async () => {
    const longReply = "x".repeat(500);
    mockToArray.mockResolvedValue([
      conversationDocument("c1", "2026-07-15T10:00:00Z", "Same joke."),
      conversationDocument("c2", "2026-07-15T09:00:00Z", "Same joke."),
      conversationDocument("c3", "2026-07-15T08:00:00Z", longReply),
    ]);

    const block = await ResponseVarietyService.renderBlock({
      agentId: "LUPOS",
      project: "lupos",
      currentConversationId: null,
      locale: "en",
    });

    expect(block!.match(/Same joke\./g)).toHaveLength(1);
    expect(block).toContain("…");
    expect(block).not.toContain(longReply);
  });

  it("skips conversations without assistant replies", async () => {
    mockToArray.mockResolvedValue([
      conversationDocument("c1", "2026-07-15T10:00:00Z", null),
    ]);

    const block = await ResponseVarietyService.renderBlock({
      agentId: "LUPOS",
      project: "lupos",
      currentConversationId: null,
      locale: "en",
    });

    // No utterances → still returns a seasoning-only block
    expect(block).not.toBeNull();
    expect(block).not.toContain("# Your recent replies");
    expect(block).toContain("Delivery note for THIS reply only");
  });

  it("survives database errors and still seasons", async () => {
    mockToArray.mockRejectedValue(new Error("mongo down"));

    const block = await ResponseVarietyService.renderBlock({
      agentId: "LUPOS",
      project: "lupos",
      currentConversationId: null,
      locale: "en",
    });

    expect(block).not.toBeNull();
    expect(block).toContain("Delivery note for THIS reply only");
  });
});

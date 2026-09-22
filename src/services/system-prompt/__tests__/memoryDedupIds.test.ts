/**
 * Memory de-duplication compares ids as strings.
 *
 * The exclusion set (`injectedMemoryIds` from the conversation document) is a
 * `Set<string>`, and `Set.has` compares by identity — a Mongo `ObjectId` never
 * equals its hex string, nor a freshly loaded `ObjectId` of the same value.
 * These pin that the scorer excludes by the string form of the id and hands
 * back string ids for persistence.
 */
import { describe, it, expect, expectTypeOf, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { SkillMemoryScorer } from "#src/services/system-prompt/SkillMemoryScorer";
import MemoryService from "#src/services/MemoryService";
import type { MemorySearchResult } from "#src/types/memory";

vi.mock("#src/services/MemoryService", () => ({
  default: {
    search: vi.fn(),
    formatForPrompt: vi.fn().mockImplementation((memories: Array<Record<string, unknown>>) =>
      memories.map((memory) => `- **${String(memory.title)}**: ${String(memory.content)}`).join("\n"),
    ),
  },
}));

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn() },
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getDb: vi.fn(), getCollection: vi.fn() },
}));

function searchResult(id: unknown, title: string) {
  return { id, type: "user", title, content: `${title} content` };
}

describe("SkillMemoryScorer.fetchMemories — id matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes a memory whose search result carries an ObjectId when the exclusion set holds its string id", async () => {
    const memoryObjectId = new ObjectId();
    vi.mocked(MemoryService.search).mockResolvedValueOnce([
      searchResult(memoryObjectId, "Deploy preference"),
    ] as never);

    const result = await new SkillMemoryScorer().fetchMemories("CODING", "prism-test", "deploy", {
      excludeMemoryIds: new Set([memoryObjectId.toHexString()]),
    });

    expect(result).toEqual({ memoriesText: "", injectedMemoryIds: [] });
  });

  it("excludes a memory when the exclusion set was built from legacy ObjectIds loaded off a conversation document", async () => {
    const memoryObjectId = new ObjectId();
    // A reload hands back a different ObjectId instance of the same value.
    const loadedFromConversation = [new ObjectId(memoryObjectId.toHexString())];
    vi.mocked(MemoryService.search).mockResolvedValueOnce([
      searchResult(memoryObjectId, "Deploy preference"),
      searchResult(new ObjectId(), "Test runner"),
    ] as never);

    const result = await new SkillMemoryScorer().fetchMemories("CODING", "prism-test", "deploy", {
      excludeMemoryIds: new Set(loadedFromConversation.map(String)),
    });

    expect(result.memoriesText).not.toContain("Deploy preference");
    expect(result.memoriesText).toContain("Test runner");
    expect(result.injectedMemoryIds).toHaveLength(1);
  });

  it("returns the injected ids as strings, so they persist as strings", async () => {
    const memoryObjectId = new ObjectId();
    vi.mocked(MemoryService.search).mockResolvedValueOnce([
      searchResult(memoryObjectId, "Deploy preference"),
    ] as never);

    const result = await new SkillMemoryScorer().fetchMemories("CODING", "prism-test", "deploy");

    expect(result.injectedMemoryIds).toEqual([memoryObjectId.toHexString()]);
    expect(typeof result.injectedMemoryIds[0]).toBe("string");
  });
});

describe("MemoryService.search — declared id type", () => {
  it("types the search result id as a string", () => {
    expectTypeOf<MemorySearchResult["id"]>().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof MemoryService.search>>[number]["id"]
    >().toEqualTypeOf<string>();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import MemoryService, { CODING_MEMORY_TYPES } from "../src/services/MemoryService.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import EmbeddingService from "../src/services/EmbeddingService.ts";
import SettingsService from "../src/services/SettingsService.ts";

vi.mock("../src/wrappers/MongoWrapper.ts", () => {
  const collection = {
    find: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
    insertOne: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    findOne: vi.fn().mockResolvedValue(null),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockReturnThis(),
    createIndex: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: {
      getCollection: vi.fn().mockReturnValue(collection),
      getDb: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue(collection),
      }),
    },
  };
});

vi.mock("../src/services/EmbeddingService.ts", () => ({
  default: {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  },
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getMemoryModelConfig: vi.fn().mockResolvedValue({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3-flash-preview",
    }),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    log: vi.fn(),
    logChatGeneration: vi.fn(),
    logBackgroundLlmCall: vi.fn(),
  },
}));

const mockGenerateText = vi.fn();
vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

describe("MemoryService", () => {
  let mockCollection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection = MongoWrapper.getCollection("", "");
    mockCollection.toArray.mockResolvedValue([]);
    mockCollection.findOne.mockResolvedValue(null);
  });

  describe("store", () => {
    it("should throw an error if agent parameter is missing", async () => {
      await expect(MemoryService.store({
        agent: "",
        content: "test content"
      })).rejects.toThrow("MemoryService.store requires an agent identifier");
    });

    it("should throw an error if content parameter is missing", async () => {
      await expect(MemoryService.store({
        agent: "CODING",
        content: ""
      })).rejects.toThrow("MemoryService.store requires content");
    });

    it("should generate embedding if not provided and store memory in collection", async () => {
      const result = await MemoryService.store({
        agent: "CODING",
        content: "user prefers TypeScript",
        type: "preference"
      });

      expect(EmbeddingService.embed).toHaveBeenCalledWith("user prefers TypeScript", expect.any(Object));
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
      expect(result?.content).toBe("user prefers TypeScript");
      expect(result?.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(result?.type).toBe("project"); // preference mapped to project for CODING agent
    });

    it("should skip storing when a duplicate memory is detected", async () => {
      mockCollection.toArray.mockResolvedValue([
        { embedding: [0.1, 0.2, 0.3] }
      ]);

      const result = await MemoryService.store({
        agent: "CODING",
        content: "user prefers TypeScript",
        type: "project"
      });

      expect(result).toBeNull();
      expect(mockCollection.insertOne).not.toHaveBeenCalled();
    });

    it("should store memory if cosine similarity is below duplicate threshold", async () => {
      mockCollection.toArray.mockResolvedValue([
        { embedding: [-0.1, -0.2, -0.3] }
      ]);

      const result = await MemoryService.store({
        agent: "CODING",
        content: "user prefers TypeScript",
        type: "project"
      });

      expect(result).toBeDefined();
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
    });
  });

  describe("search", () => {
    it("should require an agent", async () => {
      await expect(MemoryService.search({
        agent: "",
        queryText: "something"
      })).rejects.toThrow("MemoryService.search requires an agent identifier");
    });

    it("should return scored results above relevance threshold sorted by score", async () => {
      mockCollection.toArray.mockResolvedValue([
        {
          _id: "doc-1",
          content: "Matches perfectly",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString()
        },
        {
          _id: "doc-2",
          content: "Completely unrelated",
          embedding: [-0.1, -0.2, -0.3],
          createdAt: new Date().toISOString()
        }
      ]);

      const results = await MemoryService.search({
        agent: "CODING",
        queryText: "TypeScript"
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Matches perfectly");
      expect(results[0].score).toBeCloseTo(1.0, 5);
    });
  });

  describe("list", () => {
    it("should call countDocuments and return paginated list of memories", async () => {
      mockCollection.toArray.mockResolvedValue([{ content: "memory list item" }]);
      mockCollection.countDocuments.mockResolvedValue(1);

      const result = await MemoryService.list({ agent: "CODING", limit: 5 });
      expect(result.memories).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockCollection.skip).toHaveBeenCalledWith(0);
      expect(mockCollection.limit).toHaveBeenCalledWith(5);
    });
  });

  describe("delete and remove", () => {
    it("should delete memory by ID", async () => {
      const result = await MemoryService.delete("some-uuid");
      expect(result).toBe(true);
      expect(mockCollection.deleteOne).toHaveBeenCalledWith({ id: "some-uuid" });
    });
  });

  describe("update", () => {
    it("should update metadata and regenerate embedding if content changed", async () => {
      mockCollection.findOne.mockResolvedValue({
        id: "mem-1",
        project: "test-project",
        title: "Old Title"
      });

      const updated = await MemoryService.update("mem-1", {
        content: "New updated content"
      });

      expect(updated).toBe(true);
      expect(EmbeddingService.embed).toHaveBeenCalledWith("Old Title: New updated content", {
        project: "test-project",
        source: "memory"
      });
      expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
    });

    it("should update metadata without content change without embedding regeneration", async () => {
      const updated = await MemoryService.update("mem-1", {
        title: "New Title"
      });

      expect(updated).toBe(true);
      expect(EmbeddingService.embed).not.toHaveBeenCalled();
    });
  });

  describe("formatForPrompt", () => {
    it("should format array of memories for system prompt", () => {
      const memories = [
        {
          type: "project",
          title: "User preference",
          content: "Prefers oklch colors",
          age: "yesterday",
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        }
      ];

      const formatted = MemoryService.formatForPrompt(memories);
      expect(formatted).toBe("- [project] **User preference** (yesterday): Prefers oklch colors");
    });

    it("should return empty string if no memories provided", () => {
      expect(MemoryService.formatForPrompt([])).toBe("");
    });
  });

  describe("ensureIndexes", () => {
    it("should ensure indexes on the unified collection", async () => {
      await MemoryService.ensureIndexes();
      expect(mockCollection.createIndex).toHaveBeenCalled();
    });
  });

  describe("extractAndStore", () => {
    it("should extract facts from conversation via provider and store them", async () => {
      const factsResponse = [
        {
          fact: "Rodrigo lives in Vancouver",
          aboutUserId: "user-123",
          aboutUsername: "rodrigo",
          sourceUserId: "user-123",
          sourceUsername: "rodrigo",
          category: "location",
          confidence: 0.95
        }
      ];

      mockGenerateText.mockResolvedValue({
        text: JSON.stringify(factsResponse)
      });

      const messages = [{ role: "user", content: "I live in Vancouver" }];
      const participants = [{ id: "user-123", username: "rodrigo" }];

      const results = await MemoryService.extractAndStore({
        guildId: "guild-1",
        channelId: "channel-1",
        messages,
        participants
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Rodrigo lives in Vancouver");
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
    });

    it("should filter out low confidence facts", async () => {
      const factsResponse = [
        {
          fact: "Rodrigo hates tea",
          aboutUserId: "user-123",
          aboutUsername: "rodrigo",
          category: "preference",
          confidence: 0.3 // below 0.5 threshold
        }
      ];

      mockGenerateText.mockResolvedValue({
        text: JSON.stringify(factsResponse)
      });

      const results = await MemoryService.extractAndStore({
        messages: [],
        participants: []
      });

      expect(results).toHaveLength(0);
      expect(mockCollection.insertOne).not.toHaveBeenCalled();
    });
  });
});

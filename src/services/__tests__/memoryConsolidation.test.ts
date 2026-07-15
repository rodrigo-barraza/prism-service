import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";
import MemoryService from "#src/services/MemoryService";
import MongoWrapper from "#src/wrappers/MongoWrapper";

vi.mock("#src/services/MemoryService", () => ({
  default: {
    store: vi.fn().mockResolvedValue({ id: "merged-uuid" }),
    remove: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getMemoryModelConfig: vi.fn().mockResolvedValue({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3-flash-preview",
    }),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    log: vi.fn(),
    logChatGeneration: vi.fn(),
    logBackgroundLlmCall: vi.fn(),
  },
}));

const mockGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/wrappers/MongoWrapper", () => {
  const collection = {
    find: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
    insertOne: vi.fn().mockResolvedValue(undefined),
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

describe("MemoryConsolidationService", () => {
  let mockCollection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection = MongoWrapper.getCollection("", "");
    mockCollection.toArray.mockResolvedValue([]);
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.countDocuments.mockResolvedValue(0);
  });

  describe("consolidate", () => {
    it("should skip consolidation if there are fewer than 2 memories", async () => {
      mockCollection.toArray.mockResolvedValueOnce([{ id: "mem-1" }]);

      const result = await MemoryConsolidationService.consolidate({
        agent: "CODING",
        project: "test-proj",
        username: "rodrigo"
      });

      expect(result).toEqual({
        skipped: true,
        reason: "insufficient memories",
        total: 1
      });
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("should consolidate similar memories into a single merged memory", async () => {
      // Mocking 2 memories with high similarity (embedding is identical)
      mockCollection.toArray.mockResolvedValueOnce([
        {
          id: "mem-1",
          type: "project",
          title: "Database Mocking",
          content: "Do not mock database in tests",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString()
        },
        {
          id: "mem-2",
          type: "project",
          title: "Database Mocking confirmation",
          content: "We verified that database mocking is bad in tests",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString()
        }
      ]);

      // Mock LLM response with merge action
      const consolidationActionsResponse = {
        actions: [
          {
            type: "merge",
            sourceIds: ["mem-1", "mem-2"],
            reason: "Redundant information about database mocking",
            merged: {
              type: "project",
              title: "Do not mock database in tests",
              content: "Avoid database mocking in integration tests to prevent masked migrations."
            }
          }
        ]
      };

      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify(consolidationActionsResponse),
        usage: { inputTokens: 100, outputTokens: 50 }
      });

      const result = await MemoryConsolidationService.consolidate({
        agent: "CODING",
        project: "test-proj",
        username: "rodrigo"
      });

      expect(result).toBeDefined();
      expect((result as any)?.merged).toBe(2);
      expect((result as any)?.deleted).toBe(0);
      expect(MemoryService.remove).toHaveBeenCalledTimes(2);
      expect(MemoryService.store).toHaveBeenCalledTimes(1);
      expect(MemoryService.store).toHaveBeenCalledWith(expect.objectContaining({
        type: "project",
        title: "Do not mock database in tests",
        content: "Avoid database mocking in integration tests to prevent masked migrations."
      }));
    });

    it("should delete memories when the LLM recommends delete actions", async () => {
      mockCollection.toArray.mockResolvedValueOnce([
        {
          id: "mem-1",
          type: "project",
          title: "Title 1",
          content: "Content 1",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString()
        },
        {
          id: "mem-2",
          type: "project",
          title: "Title 2",
          content: "Content 2",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString()
        }
      ]);

      const consolidationActionsResponse = {
        actions: [
          {
            type: "delete",
            id: "mem-2",
            reason: "Outdated project memory"
          }
        ]
      };

      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify(consolidationActionsResponse),
        usage: { inputTokens: 100, outputTokens: 50 }
      });

      const result = await MemoryConsolidationService.consolidate({
        agent: "CODING",
        project: "test-proj",
        username: "rodrigo"
      });

      expect((result as any)?.deleted).toBe(1);
      expect(MemoryService.remove).toHaveBeenCalledWith("mem-2");
      expect(MemoryService.store).not.toHaveBeenCalled();
    });

    it("should preserve observer to subject metadata for LUPOS conversational agent merges", async () => {
      // Mock LUPOS memories
      mockCollection.toArray.mockResolvedValueOnce([
        {
          id: "mem-lupos-1",
          type: "personal",
          title: "Hobbies",
          content: "User loves painting",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString(),
          aboutUserId: "user-subject",
          aboutUsername: "subject-username",
          sourceUserId: "user-observer",
          sourceUsername: "observer-username",
          guildId: "guild-abc"
        },
        {
          id: "mem-lupos-2",
          type: "personal",
          title: "Art preference",
          content: "User painting hobby verified",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString(),
          aboutUserId: "user-subject",
          aboutUsername: "subject-username",
          sourceUserId: "user-observer",
          sourceUsername: "observer-username",
          guildId: "guild-abc"
        }
      ]);

      const consolidationActionsResponse = {
        actions: [
          {
            type: "merge",
            sourceIds: ["mem-lupos-1", "mem-lupos-2"],
            reason: "Merge painting hobby information",
            merged: {
              type: "personal",
              title: "Art and Painting Hobby",
              content: "User enjoys painting in traditional art formats."
            }
          }
        ]
      };

      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify(consolidationActionsResponse),
        usage: { inputTokens: 100, outputTokens: 50 }
      });

      const result = await MemoryConsolidationService.consolidate({
        agent: "LUPOS",
        project: "lupos-proj",
        username: "rodrigo",
        guildId: "guild-abc"
      });

      expect((result as any)?.merged).toBe(2);
      expect(MemoryService.store).toHaveBeenCalledWith(expect.objectContaining({
        agent: "LUPOS",
        metadata: expect.objectContaining({
          aboutUserId: "user-subject",
          aboutUsername: "subject-username",
          sourceUserId: "user-observer",
          sourceUsername: "observer-username",
          guildId: "guild-abc"
        })
      }));
    });
  });

  describe("checkAndRun", () => {
    it("should increment count and trigger consolidate when threshold is reached", async () => {
      // Mock run count to return 5 (which is the threshold SESSIONS_BETWEEN_RUNS)
      mockCollection.findOne.mockResolvedValueOnce({ sessionsSinceLastRun: 5 });

      const consolidateSpy = vi.spyOn(MemoryConsolidationService, "consolidate").mockResolvedValue(undefined as any);

      await MemoryConsolidationService.checkAndRun({
        project: "test-proj",
        username: "rodrigo"
      });

      expect(mockCollection.updateOne).toHaveBeenCalledTimes(1);
      // Wait for background tasks to flush
      await vi.waitFor(() => {
        expect(consolidateSpy).toHaveBeenCalled();
      });
    });

    it("should not trigger consolidate if counter is below threshold", async () => {
      mockCollection.findOne.mockResolvedValueOnce({ sessionsSinceLastRun: 2 });
      const consolidateSpy = vi.spyOn(MemoryConsolidationService, "consolidate");

      await MemoryConsolidationService.checkAndRun({
        project: "test-proj",
        username: "rodrigo"
      });

      expect(consolidateSpy).not.toHaveBeenCalled();
    });
  });
});

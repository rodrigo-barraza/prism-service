import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";
import MemoryService from "#src/services/MemoryService";
import MongoWrapper from "#src/wrappers/MongoWrapper";

vi.mock("#src/services/MemoryService", () => ({
  default: {
    store: vi.fn().mockResolvedValue({ id: "merged-uuid" }),
    remove: vi.fn().mockResolvedValue(true),
    invalidate: vi.fn().mockResolvedValue(true),
    reopen: vi.fn().mockResolvedValue(true),
  },
  CURRENT_MEMORY_FILTER: { validTo: null },
  NOT_QUARANTINED_FILTER: { quarantined: { $ne: true } },
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
    findOneAndUpdate: vi.fn().mockResolvedValue({ project: "test-proj" }),
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
      // Non-destructive merge: sources are soft-closed pointing at the
      // merged doc, never hard-removed
      expect(MemoryService.remove).not.toHaveBeenCalled();
      expect(MemoryService.invalidate).toHaveBeenCalledTimes(2);
      expect(MemoryService.invalidate).toHaveBeenCalledWith(
        "mem-1",
        expect.objectContaining({ supersededBy: "merged-uuid" }),
      );
      expect(MemoryService.store).toHaveBeenCalledTimes(1);
      expect(MemoryService.store).toHaveBeenCalledWith(expect.objectContaining({
        type: "project",
        title: "Do not mock database in tests",
        content: "Avoid database mocking in integration tests to prevent masked migrations.",
        dedupe: false
      }));
    });

    it("preserves provenance on a merge and never raises trust", async () => {
      mockCollection.toArray.mockResolvedValueOnce([
        {
          id: "mem-user",
          type: "user",
          title: "Tabs",
          content: "The user prefers tabs.",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString(),
          source: "user",
          trust: "user",
          sourceRefs: [{ source: "user", trust: "user", messageId: "msg-1" }],
        },
        {
          // Accepted from a web page: live, still untrusted.
          id: "mem-web",
          type: "user",
          title: "Tabs width",
          content: "Tabs are four columns wide.",
          embedding: [0.1, 0.2, 0.3],
          createdAt: new Date().toISOString(),
          source: "web",
          trust: "untrusted",
          reviewDecision: "accepted",
        },
      ]);
      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify({
          actions: [
            {
              type: "merge",
              sourceIds: ["mem-user", "mem-web"],
              reason: "same preference",
              merged: { type: "user", title: "Tabs", content: "The user prefers four-column tabs." },
            },
          ],
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
      });

      await MemoryConsolidationService.consolidate({
        agent: "CODING",
        project: "test-proj",
        username: "rodrigo",
      });

      // Quarantined memories are never loaded for a merge.
      expect(mockCollection.find).toHaveBeenCalledWith(
        expect.objectContaining({ quarantined: { $ne: true } }),
      );
      const stored = vi.mocked(MemoryService.store).mock.calls[0][0];
      expect(stored.quarantined).toBe(false);
      expect(stored.provenance).toMatchObject({ source: "web", trust: "untrusted" });
      expect(stored.provenance!.sourceRefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ memoryId: "mem-user", trust: "user" }),
          expect.objectContaining({ memoryId: "mem-web", trust: "untrusted" }),
          expect.objectContaining({ messageId: "msg-1" }),
        ]),
      );
    });

    it("gives a merge of legacy memories the legacy provenance, not more", async () => {
      mockCollection.toArray.mockResolvedValueOnce([
        { id: "old-1", type: "project", title: "A", content: "a", embedding: [0.1, 0.2, 0.3], createdAt: new Date().toISOString() },
        { id: "old-2", type: "project", title: "B", content: "b", embedding: [0.1, 0.2, 0.3], createdAt: new Date().toISOString() },
      ]);
      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify({
          actions: [{ type: "merge", sourceIds: ["old-1", "old-2"], merged: { type: "project", title: "AB", content: "a and b" } }],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      await MemoryConsolidationService.consolidate({ agent: "CODING", project: "test-proj", username: "rodrigo" });

      const stored = vi.mocked(MemoryService.store).mock.calls[0][0];
      expect(stored.provenance).toMatchObject({ source: "assistant", trust: "derived" });
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
      // Legacy "delete" actions are applied as soft invalidation
      expect(MemoryService.remove).not.toHaveBeenCalled();
      expect(MemoryService.invalidate).toHaveBeenCalledWith(
        "mem-2",
        expect.objectContaining({ reason: "Outdated project memory" }),
      );
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

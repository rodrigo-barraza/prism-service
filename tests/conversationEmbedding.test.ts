import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import ConversationEmbeddingService from "../src/services/ConversationEmbeddingService.ts";
import EmbeddingService from "../src/services/EmbeddingService.ts";
import searchConversations from "../src/services/local-tools/ConversationSearchTool.ts";
import { COLLECTIONS, MODEL_TYPES } from "../src/constants.ts";

describe("ConversationEmbeddingService & ConversationSearchTool", () => {
  let mockUpdateOne: any;
  let mockFindOne: any;
  let mockFind: any;
  let mockCountDocuments: any;
  let mockDb: any;
  let getDbSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
    mockFindOne = vi.fn().mockResolvedValue({
      id: "conv-1",
      title: "Debug MCP SSE",
      compactionSummary: "Narrative summary of MCP SSE debugging",
      summaryUpdatedAt: null,
    });
    mockFind = vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        { title: "Memory 1", content: "Memory 1 details", createdAt: "2026-06-13T00:00:00.000Z" }
      ]),
    });
    mockCountDocuments = vi.fn().mockResolvedValue(1);

    mockDb = {
      collection: vi.fn().mockImplementation(() => {
        return {
          findOne: mockFindOne,
          updateOne: mockUpdateOne,
          find: mockFind,
          countDocuments: mockCountDocuments,
        };
      }),
    };

    getDbSpy = vi.spyOn(MongoWrapper, "getDb").mockReturnValue(mockDb);
  });

  afterEach(() => {
    getDbSpy.mockRestore();
  });

  describe("ConversationEmbeddingService", () => {
    it("should skip if conversationId is missing", async () => {
      await ConversationEmbeddingService.generateAndPersist({
        conversationId: null,
        agentConversationId: "session-1",
        project: "prism-chat",
        username: "rodrigo",
        agent: "CODING",
        traceId: "trace-1",
        messageCount: 10,
        endpoint: "/agent",
      });
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it("should skip if not an agent project", async () => {
      await ConversationEmbeddingService.generateAndPersist({
        conversationId: "conv-1",
        agentConversationId: "session-1",
        project: "regular-web-app",
        username: "rodrigo",
        agent: "CODING",
        traceId: "trace-1",
        messageCount: 10,
        endpoint: "/agent",
      });
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it("should skip if messageCount is below threshold", async () => {
      await ConversationEmbeddingService.generateAndPersist({
        conversationId: "conv-1",
        agentConversationId: "session-1",
        project: "prism-chat",
        username: "rodrigo",
        agent: "CODING",
        traceId: "trace-1",
        messageCount: 3,
        endpoint: "/agent",
      });
      expect(mockFindOne).not.toHaveBeenCalled();
    });

    it("should respect cooldown window", async () => {
      mockFindOne.mockResolvedValueOnce({
        id: "conv-1",
        title: "Title",
        summaryUpdatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });

      await ConversationEmbeddingService.generateAndPersist({
        conversationId: "conv-1",
        agentConversationId: "session-1",
        project: "prism-chat",
        username: "rodrigo",
        agent: "CODING",
        traceId: "trace-1",
        messageCount: 10,
        endpoint: "/agent",
      });

      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it("should embed and persist when cooldown passed or null", async () => {
      const embedSpy = vi.spyOn(EmbeddingService, MODEL_TYPES.EMBED).mockResolvedValue([0.5, 0.6, 0.7]);

      await ConversationEmbeddingService.generateAndPersist({
        conversationId: "conv-1",
        agentConversationId: "session-1",
        project: "prism-chat",
        username: "rodrigo",
        agent: "CODING",
        traceId: "trace-1",
        messageCount: 10,
        endpoint: "/agent",
      });

      expect(embedSpy).toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { id: "conv-1", project: "prism-chat", username: "rodrigo" },
        expect.objectContaining({
          $set: expect.objectContaining({
            summaryEmbedding: [0.5, 0.6, 0.7],
          }),
        })
      );
      embedSpy.mockRestore();
    });

    it("should persist compaction summary correctly", async () => {
      await ConversationEmbeddingService.persistCompactionSummary(
        "conv-1",
        "prism-chat",
        "rodrigo",
        "Long summary text"
      );

      expect(mockUpdateOne).toHaveBeenCalledWith(
        { id: "conv-1", project: "prism-chat", username: "rodrigo" },
        expect.objectContaining({
          $set: expect.objectContaining({
            compactionSummary: "Long summary text",
          }),
        })
      );
    });
  });

  describe("ConversationSearchTool", () => {
    it("should execute search and return matches sorted by similarity", async () => {
      const embedSpy = vi.spyOn(EmbeddingService, MODEL_TYPES.EMBED).mockResolvedValue([0.1, 0.2, 0.3]);
      
      mockFind.mockReturnValueOnce({
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: "conv-match-1",
            title: "Match 1 Title",
            compactionSummary: "Summary 1",
            summaryEmbedding: [0.1, 0.2, 0.3],
            createdAt: "2026-06-13T00:00:00Z",
            updatedAt: "2026-06-13T00:00:00Z",
          },
          {
            id: "conv-match-2",
            title: "Match 2 Title",
            compactionSummary: "Summary 2",
            summaryEmbedding: [-0.1, -0.2, -0.3],
            createdAt: "2026-06-13T00:00:00Z",
            updatedAt: "2026-06-13T00:00:00Z",
          }
        ]),
      });

      const context = {
        project: "prism-chat",
        username: "rodrigo",
      };

      const result: any = await searchConversations.execute({ query: "MCP SSE" }, context);

      expect(result.count).toBe(1);
      expect(result.conversations[0].conversationId).toBe("conv-match-1");
      expect(result.conversations[0].score).toBe(1.0);
      expect(result.conversations[0].linkedMemoryCount).toBe(1);

      embedSpy.mockRestore();
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import MemoryService from "#src/services/MemoryService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import {
  acquireConsolidationLock,
  releaseConsolidationLock,
} from "#src/services/memory/ConsolidationTracker";
import { scoreHybrid } from "#src/services/memory/HybridRetrieval";

// ────────────────────────────────────────────────────────────
// Memory trustworthiness suite (survey items B1 + B2 + B3):
//  - B1 bi-temporal: ADD-only dedup, invalidate/reopen soft-close
//  - B2 hybrid retrieval: exact/keyword recovery, gate behavior
//  - B3 consolidation safety: single-writer lock semantics
// ────────────────────────────────────────────────────────────

vi.mock("#src/wrappers/MongoWrapper", () => {
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
    findOneAndUpdate: vi.fn().mockResolvedValue({ project: "p" }),
    findOne: vi.fn().mockResolvedValue(null),
    countDocuments: vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockReturnThis(),
    createIndex: vi.fn().mockResolvedValue(undefined),
    dropIndex: vi.fn().mockResolvedValue(undefined),
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

vi.mock("#src/services/EmbeddingService", () => ({
  default: {
    embed: vi.fn().mockResolvedValue([1, 0, 0]),
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

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: vi.fn(),
  })),
  providers: {},
}));

describe("Memory trustworthiness", () => {
  let mockCollection: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection = MongoWrapper.getCollection("", "");
    mockCollection.toArray.mockResolvedValue([]);
    mockCollection.findOne.mockResolvedValue(null);
    mockCollection.findOneAndUpdate.mockResolvedValue({ project: "p" });
    mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  // ── B1: ADD-only write-time dedup ──────────────────────────
  describe("store() ADD-only dedup policy", () => {
    it("stores a similar-but-different memory instead of dropping it", async () => {
      // Existing memory at cosine ≈ 0.94 — above the legacy duplicate
      // threshold (0.92) but below the exact bar (0.97): must be STORED
      const existingEmbedding = [0.94, Math.sqrt(1 - 0.94 * 0.94), 0];
      mockCollection.toArray.mockResolvedValueOnce([
        { embedding: existingEmbedding },
      ]);

      const stored = await MemoryService.store({
        agent: "CODING",
        project: "p",
        content: "User moved to Victoria",
        embedding: [1, 0, 0],
      });

      expect(stored).not.toBeNull();
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
      // New documents carry open validity
      expect(mockCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ validTo: null, supersededBy: null }),
      );
    });

    it("still skips a verbatim re-extraction (above the exact bar)", async () => {
      mockCollection.toArray.mockResolvedValueOnce([
        { embedding: [1, 0, 0] }, // cosine 1.0 with the new embedding
      ]);

      const stored = await MemoryService.store({
        agent: "CODING",
        project: "p",
        content: "Same fact again",
        embedding: [1, 0, 0],
      });

      expect(stored).toBeNull();
      expect(mockCollection.insertOne).not.toHaveBeenCalled();
    });

    it("only dedups against CURRENT rows", async () => {
      mockCollection.toArray.mockResolvedValueOnce([]);
      await MemoryService.store({
        agent: "CODING",
        project: "p",
        content: "fact",
        embedding: [1, 0, 0],
      });
      expect(mockCollection.find).toHaveBeenCalledWith(
        expect.objectContaining({ validTo: null }),
      );
    });

    it("skips dedup entirely when dedupe:false (consolidation merges)", async () => {
      await MemoryService.store({
        agent: "CODING",
        project: "p",
        content: "merged content",
        embedding: [1, 0, 0],
        dedupe: false,
      });
      expect(mockCollection.find).not.toHaveBeenCalled();
      expect(mockCollection.insertOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── B1: soft-close / reopen ────────────────────────────────
  describe("invalidate() and reopen()", () => {
    it("invalidate soft-closes with supersededBy + reason, no delete", async () => {
      const closed = await MemoryService.invalidate("mem-1", {
        supersededBy: "mem-2",
        reason: "merged",
      });

      expect(closed).toBe(true);
      expect(mockCollection.deleteOne).not.toHaveBeenCalled();
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { id: "mem-1", validTo: null },
        {
          $set: expect.objectContaining({
            validTo: expect.any(String),
            supersededBy: "mem-2",
            closedReason: "merged",
          }),
        },
      );
    });

    it("reopen clears the validity window (rollback path)", async () => {
      const reopened = await MemoryService.reopen("mem-1");
      expect(reopened).toBe(true);
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { id: "mem-1", validTo: { $ne: null } },
        {
          $set: expect.objectContaining({
            validTo: null,
            supersededBy: null,
            closedReason: null,
          }),
        },
      );
    });
  });

  // ── B3: single-writer lock ─────────────────────────────────
  describe("consolidation lock", () => {
    it("acquires when no holder", async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce({ project: "p" });
      expect(await acquireConsolidationLock("p")).toBe(true);
    });

    it("refuses when another run holds the lock", async () => {
      mockCollection.findOneAndUpdate.mockResolvedValueOnce(null);
      expect(await acquireConsolidationLock("p")).toBe(false);
    });

    it("release clears the flag", async () => {
      await releaseConsolidationLock("p");
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { project: "p" },
        { $set: { isConsolidating: false } },
      );
    });
  });

  // ── B2: hybrid retrieval scoring (pure) ────────────────────
  describe("scoreHybrid", () => {
    const OPTIONS = { relevanceThreshold: 0.3, limit: 10 };

    it("recovers an exact-id match that cosine misses", () => {
      const candidates = [
        {
          key: 0,
          title: "Vault secret flow",
          content: "MONGO_URI comes from vault-service projects.json",
          embedding: [0, 1, 0], // orthogonal to the query embedding
          createdAt: "2026-07-01T00:00:00Z",
        },
        {
          key: 1,
          title: "Deployment preference",
          content: "User prefers npm run deploy",
          embedding: [0.9, 0.1, 0],
          createdAt: "2026-07-02T00:00:00Z",
        },
      ];
      const results = scoreHybrid(
        candidates,
        "where does MONGO_URI come from",
        [1, 0, 0],
        OPTIONS,
      );
      const keys = results.map((result) => result.key);
      // The exact "MONGO_URI" hit must survive despite ~0 cosine
      expect(keys).toContain(0);
      expect(results.find((result) => result.key === 0)?.exactHit).toBe(true);
    });

    it("does NOT let a single shared common word bypass the semantic gate", () => {
      const candidates = [
        {
          key: 0,
          title: "Format code styling",
          content: "Task: Format code styling. eslint_fix",
          embedding: [0, 1, 0],
          createdAt: "2026-07-01T00:00:00Z",
        },
      ];
      const results = scoreHybrid(
        candidates,
        "Fix the build failing with compile error",
        [1, 0, 0],
        OPTIONS,
      );
      // Only "fix" is shared — one common token is not a strong keyword hit
      expect(results).toHaveLength(0);
    });

    it("keyword-matches candidates that have no embedding at all", () => {
      const candidates = [
        {
          key: 0,
          title: "Craigslist governor caps",
          content: "search_craigslist limited to 200 per day with 45min TTL",
          embedding: null,
          createdAt: "2026-07-01T00:00:00Z",
        },
      ];
      const results = scoreHybrid(
        candidates,
        "craigslist search daily caps",
        [1, 0, 0],
        OPTIONS,
      );
      expect(results).toHaveLength(1);
      expect(results[0].semantic).toBe(0);
      expect(results[0].bm25Hit).toBe(true);
    });

    it("orders semantically-equal candidates by recency", () => {
      const shared = {
        title: "note",
        content: "irrelevant text",
        embedding: [1, 0, 0],
      };
      const candidates = [
        { key: 0, ...shared, createdAt: "2026-01-01T00:00:00Z" },
        { key: 1, ...shared, createdAt: "2026-07-01T00:00:00Z" },
      ];
      const results = scoreHybrid(candidates, "zzz-no-keyword-overlap", [1, 0, 0], OPTIONS);
      expect(results.map((result) => result.key)).toEqual([1, 0]);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "node:fs/promises";
import BackgroundHousekeepingService from "#src/services/BackgroundHousekeepingService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import MinioWrapper from "#src/wrappers/MinioWrapper";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
}));

describe("BackgroundHousekeepingService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("pruneOrphanedWorktrees", () => {
    it("should prune directories older than 24 hours", async () => {
      const mockDirEntries = ["old-worktree", "new-worktree", "not-a-dir"];
      vi.mocked(fsPromises.readdir).mockResolvedValue(mockDirEntries as any);

      vi.mocked(fsPromises.stat).mockImplementation(async (pathString) => {
        const path = String(pathString);
        if (path.endsWith("old-worktree")) {
          return {
            isDirectory: () => true,
            mtimeMs: Date.now() - 25 * 60 * 60 * 1000 // 25 hours old
          } as any;
        }
        if (path.endsWith("new-worktree")) {
          return {
            isDirectory: () => true,
            mtimeMs: Date.now() - 1 * 60 * 60 * 1000 // 1 hour old
          } as any;
        }
        if (path.endsWith("not-a-dir")) {
          return {
            isDirectory: () => false,
            mtimeMs: Date.now() - 25 * 60 * 60 * 1000
          } as any;
        }
        throw new Error("File not found");
      });

      const removeMock = vi.mocked(fsPromises.rm).mockResolvedValue(undefined);

      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.worktrees).toBeDefined();
      if ("pruned" in result.worktrees!) {
        expect(result.worktrees.pruned).toContain("old-worktree");
        expect(result.worktrees.pruned).not.toContain("new-worktree");
        expect(result.worktrees.pruned).not.toContain("not-a-dir");
      }
      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it("should gracefully handle readdir exceptions", async () => {
      vi.mocked(fsPromises.readdir).mockRejectedValue(new Error("Disk error"));
      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.worktrees).toEqual({ pruned: [], errors: [] });
    });
  });

  describe("clearStaleConversations", () => {
    it("should clear isGenerating flags on conversations older than 2 hours", async () => {
      const updateManyMock = vi.fn().mockResolvedValue({ modifiedCount: 3 });
      const collectionMock = vi.fn().mockReturnValue({
        updateMany: updateManyMock,
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
        find: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: async function* () {} })
      });
      const databaseMock = { collection: collectionMock };
      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.staleConversations).toEqual({
        conversationsCleared: 3,
        agentConversationsCleared: 3,
        staleSubAgentsCleared: 3
      });
      expect(updateManyMock).toHaveBeenCalledTimes(4); // 4 updates in clearStaleConversations
    });

    it("should handle MongoDB connection errors gracefully", async () => {
      vi.spyOn(MongoWrapper, "getDb").mockImplementation(() => {
        throw new Error("MongoDB down");
      });

      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.staleConversations).toEqual({ error: "MongoDB down" });
    });
  });

  describe("pruneOldRequestLogs", () => {
    it("should delete request logs older than 90 days", async () => {
      const deleteManyMock = vi.fn().mockResolvedValue({ deletedCount: 15 });
      const collectionMock = vi.fn().mockReturnValue({
        deleteMany: deleteManyMock,
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
        find: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: async function* () {} })
      });
      const databaseMock = { collection: collectionMock };
      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.requestLogs).toEqual({ deleted: 15 });
      expect(deleteManyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("pruneMinioOrphans", () => {
    it("should remove objects in MinIO that lack corresponding MongoDB records", async () => {
      // Mock Mongo records
      const mockConversations = [{ id: "conv-active" }];
      const cursorMock = {
        [Symbol.asyncIterator]: async function* () {
          for (const item of mockConversations) {
            yield item;
          }
        }
      };

      const findMock = vi.fn().mockReturnValue(cursorMock);
      const collectionMock = vi.fn().mockReturnValue({
        find: findMock,
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 })
      });
      const databaseMock = { collection: collectionMock };
      vi.spyOn(MongoWrapper, "getDb").mockReturnValue(databaseMock as any);

      // Mock MinIO Wrapper
      vi.spyOn(MinioWrapper, "isAvailable").mockReturnValue(true);
      const listObjectsMock = vi.spyOn(MinioWrapper, "listObjects").mockResolvedValue([
        { name: "conv-active/file1.png" },
        { name: "conv-orphaned/file2.png" },
        { name: "projects/proj-1/file3.png" } // Should be skipped (structural prefix)
      ] as any);
      const minioRemoveMock = vi.spyOn(MinioWrapper, "remove").mockResolvedValue(undefined as any);

      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.minioOrphans).toEqual({ removed: 1 });
      expect(minioRemoveMock).toHaveBeenCalledWith("conv-orphaned/file2.png");
      expect(minioRemoveMock).not.toHaveBeenCalledWith("conv-active/file1.png");
      expect(minioRemoveMock).not.toHaveBeenCalledWith("projects/proj-1/file3.png");
    });

    it("should return 0 when MinIO is not available", async () => {
      vi.spyOn(MinioWrapper, "isAvailable").mockReturnValue(false);
      const result = await BackgroundHousekeepingService.run({ trigger: "test" });
      expect(result.minioOrphans).toEqual({ removed: 0 });
    });
  });
});

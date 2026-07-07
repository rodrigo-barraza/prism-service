import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";
import { ObjectId } from "mongodb";

vi.mock("#src/wrappers/MongoWrapper", () => {
  return {
    default: {
      createClient: vi.fn().mockResolvedValue(undefined),
      getDb: vi.fn().mockReturnValue(null),
      getCollection: vi.fn(),
    },
  };
});

// Mock deriveAgentId from utilities-library
vi.mock("@rodrigo-barraza/utilities-library", () => ({
  deriveAgentId: (name: string) => name.toLowerCase().replace(/\s+/g, "-"),
}));

import CustomAgentService from "#src/services/CustomAgentService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";

describe("CustomAgentService Unit Tests", () => {
  let mockCollection: ReturnType<typeof createMockCollection>;
  let databaseNotAvailable = false;

  beforeEach(() => {
    mockCollection = createMockCollection([]);
    databaseNotAvailable = false;

    vi.mocked(MongoWrapper.getCollection).mockImplementation(
      (databaseName, collectionName) => {
        if (databaseNotAvailable) return null as any;
        if (collectionName === COLLECTIONS.CUSTOM_AGENTS) {
          return mockCollection as any;
        }
        return null as any;
      },
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("should insert a new agent and return the document", async () => {
      const agentData = {
        name: "Test Agent",
        project: "p1",
      };
      const result = await CustomAgentService.create(agentData as any);
      expect(result._id).toBeDefined();
      expect(result.agentId).toBe("test-agent");

      const doc = await mockCollection.findOne({ agentId: "test-agent" });
      expect(doc).toBeDefined();
      expect(doc?.name).toBe("Test Agent");
    });

    it("should throw error if name already exists (conflicting agentId)", async () => {
      await mockCollection.insertOne({ agentId: "existing", name: "Existing" });

      await expect(
        CustomAgentService.create({ name: "Existing" } as any),
      ).rejects.toThrow('Agent with name "Existing" already exists');
    });
  });

  describe("list", () => {
    it("should return all agents sorted by createdAt desc", async () => {
      await mockCollection.insertOne({ agentId: "old", createdAt: "2020-01-01" });
      await mockCollection.insertOne({ agentId: "new", createdAt: "2021-01-01" });

      const list = await CustomAgentService.list();
      expect(list).toHaveLength(2);
      // mongoMock.ts find().sort() is a no-op currently, but list() sorts in memory
      expect(list[0].agentId).toBe("new");
    });

    it("should return empty list if DB not available", async () => {
      databaseNotAvailable = true;
      const list = await CustomAgentService.list();
      expect(list).toEqual([]);
    });
  });

  describe("get", () => {
    it("should find an agent by string id (ObjectId)", async () => {
      const id = new ObjectId();
      await mockCollection.insertOne({ _id: id, agentId: "find-me" });

      const agent = await CustomAgentService.get(id.toString());
      expect(agent?.agentId).toBe("find-me");
    });

    it("should return null if not found", async () => {
      const agent = await CustomAgentService.get(new ObjectId().toString());
      expect(agent).toBeNull();
    });
  });

  describe("update", () => {
    it("should update an existing agent", async () => {
      const id = new ObjectId();
      await mockCollection.insertOne({ _id: id, name: "Old", agentId: "old" });

      await CustomAgentService.update(id.toString(), { name: "New" });
      const updated = await mockCollection.findOne({ _id: id });
      expect(updated?.name).toBe("New");
      expect(updated?.agentId).toBe("new");
    });

    it("should throw error if new name conflicts with another agent", async () => {
      const id1 = new ObjectId();
      const id2 = new ObjectId();
      await mockCollection.insertOne({ _id: id1, name: "Agent 1", agentId: "agent-1" });
      await mockCollection.insertOne({ _id: id2, name: "Agent 2", agentId: "agent-2" });

      await expect(
        CustomAgentService.update(id1.toString(), { name: "Agent 2" }),
      ).rejects.toThrow('Agent with name "Agent 2" already exists');
    });
  });

  describe("delete", () => {
    it("should remove an agent", async () => {
      const id = new ObjectId();
      await mockCollection.insertOne({ _id: id });

      const result = await CustomAgentService.delete(id.toString());
      expect(result).toBe(true);
      
      const remaining = await mockCollection.find({}).toArray();
      expect(remaining).toHaveLength(0);
    });
  });
});

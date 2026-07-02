import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("../src/wrappers/MongoWrapper.ts", () => {
  return {
    default: {
      createClient: vi.fn().mockResolvedValue(undefined),
      getDb: vi.fn().mockReturnValue(null),
      getCollection: vi.fn(),
    },
  };
});

import SkillService from "../src/services/SkillService.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import { COLLECTIONS } from "../src/constants.ts";

describe("SkillService Unit Tests", () => {
  let mockCollection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    mockCollection = createMockCollection([
      {
        skillId: "test_skill",
        name: "Test Skill",
        description: "A test skill description",
        prompt: "Say hello to {{name}}",
        steps: ["Step 1"],
        tools: null,
        maxIterations: 25,
        model: "gemini-3.5-flash",
        project: "project-a",
        usageCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    vi.mocked(MongoWrapper.getCollection).mockImplementation(
      (dbName, collectionName) => {
        if (collectionName === COLLECTIONS.AGENT_SKILLS) {
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
    it("should insert a new skill into the database", async () => {
      const newSkill = {
        skillId: "new_skill",
        name: "New Skill",
        description: "Desc",
        prompt: "Prompt",
        project: "project-a",
      };

      const result = await SkillService.create(newSkill as any);
      expect(result).toBeDefined();

      const doc = await mockCollection.findOne({ skillId: "new_skill" });
      expect(doc).toBeDefined();
      expect(doc?.name).toBe("New Skill");
    });
  });

  describe("list", () => {
    it("should return a list of skills for a project", async () => {
      const result = await SkillService.list({ project: "project-a" });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].skillId).toBe("test_skill");
      expect(result.total).toBe(1);
    });

    it("should return empty list for project with no skills", async () => {
      const result = await SkillService.list({ project: "non-existent" });
      expect(result.skills).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("get", () => {
    it("should retrieve a skill by skillId", async () => {
      const skill = await SkillService.get("test_skill");
      expect(skill).toBeDefined();
      expect(skill?.name).toBe("Test Skill");
    });

    it("should return null if skill not found", async () => {
      const skill = await SkillService.get("missing");
      expect(skill).toBeNull();
    });
  });

  describe("delete", () => {
    it("should remove a skill from the database", async () => {
      await SkillService.delete("test_skill");
      const skill = await SkillService.get("test_skill");
      expect(skill).toBeNull();
    });
  });

  describe("prepare", () => {
    it("should interpolate variables and increment usageCount", async () => {
      const result = await SkillService.prepare("test_skill", { name: "Rodrigo" });
      if ("error" in result) throw new Error(result.error);
      
      expect(result.prompt).toBe("Say hello to Rodrigo");
      
      const skill = await SkillService.get("test_skill");
      expect(skill?.usageCount).toBe(3);
    });
  });
});

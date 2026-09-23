import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("#src/wrappers/MongoWrapper", () => {
  return {
    default: {
      createClient: vi.fn().mockResolvedValue(undefined),
      getDb: vi.fn().mockReturnValue(null),
      getCollection: vi.fn(),
    },
  };
});

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue([0.5, 0.5]) },
}));

import SkillService, { toSkill, type SkillCaller } from "#src/services/SkillService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";

const CALLER: SkillCaller = {
  project: "project-a",
  username: "rodrigo",
  profileId: "default",
  agent: "CODING",
};

/** A skill as the create_skill tool wrote it before Landing 1. */
const LEGACY_TOOL_SKILL = {
  _id: "legacy-test-skill",
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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("SkillService Unit Tests", () => {
  let mockCollection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    mockCollection = createMockCollection([LEGACY_TOOL_SKILL]);

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

  describe("toSkill (one type over both stored schemas)", () => {
    it("reads a panel skill", () => {
      const skill = toSkill({
        _id: "abc" as any,
        project: "p",
        username: "u",
        profileId: "work",
        name: "lint-rules",
        description: "How we lint",
        content: "Run oxlint.",
        enabled: false,
        embedding: [1, 2],
        createdAt: new Date("2026-09-01T00:00:00Z"),
      });
      expect(skill).toMatchObject({
        id: "abc",
        skillId: "lint_rules",
        body: "Run oxlint.",
        scope: { project: "p", username: "u", profileId: "work", agent: null },
        enabled: false,
        source: "user",
        embedding: [1, 2],
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    });

    it("reads a legacy SkillService skill: prompt is the body, unset scope is null, enabled by default", () => {
      const skill = toSkill({ ...LEGACY_TOOL_SKILL, _id: undefined, tools: ["read_file"] });
      expect(skill).toMatchObject({
        skillId: "test_skill",
        body: "Say hello to {{name}}",
        scope: { project: "project-a", username: null, profileId: null, agent: null },
        enabled: true,
        source: "agent",
        allowedTools: ["read_file"],
        steps: ["Step 1"],
        maxIterations: 25,
      });
    });
  });

  describe("create", () => {
    it("inserts a skill stamped with the caller's scope, body in `content`", async () => {
      const result = await SkillService.create(
        { name: "New Skill", description: "Desc", body: "Prompt", source: "agent" },
        CALLER,
      );
      expect(result).toHaveProperty("skill");

      const doc = await mockCollection.findOne({ skillId: "new_skill" });
      expect(doc).toMatchObject({
        name: "New Skill",
        content: "Prompt",
        project: "project-a",
        username: "rodrigo",
        profileId: "default",
        enabled: true,
        source: "agent",
        embedding: [0.5, 0.5],
      });
    });

    it("refuses a skill without a body", async () => {
      const result = await SkillService.create({ name: "empty", body: "  " }, CALLER);
      expect(result).toHaveProperty("error");
    });
  });

  describe("list", () => {
    it("returns the caller's skills without bodies", async () => {
      const result = await SkillService.list(CALLER);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]).toMatchObject({ skillId: "test_skill", name: "Test Skill" });
      expect(JSON.stringify(result)).not.toContain("Say hello");
      expect(result.total).toBe(1);
    });

    it("returns an empty list for a project with no skills", async () => {
      const result = await SkillService.list({ ...CALLER, project: "non-existent" });
      expect(result.skills).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("get", () => {
    it("retrieves a skill by skillId", async () => {
      const skill = await SkillService.get("test_skill", CALLER);
      expect(skill?.name).toBe("Test Skill");
    });

    it("returns null if the skill is not found", async () => {
      expect(await SkillService.get("missing", CALLER)).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes a skill from the database", async () => {
      await SkillService.delete("test_skill", CALLER);
      expect(await SkillService.get("test_skill", CALLER)).toBeNull();
    });
  });

  describe("prepare", () => {
    it("interpolates variables and counts the use", async () => {
      const result = await SkillService.prepare("test_skill", { name: "Rodrigo" }, CALLER);
      if ("error" in result && result.error) throw new Error(result.error);

      expect(result.prompt).toBe("Say hello to Rodrigo");
      expect(result.config).toMatchObject({ maxIterations: 25, model: "gemini-3.5-flash" });

      const skill = await SkillService.get("test_skill", CALLER);
      expect(skill?.usageCount).toBe(3);
      expect(skill?.updatedAt).toBe(LEGACY_TOOL_SKILL.updatedAt);
      expect(skill?.lastUsedAt).toBeTruthy();
    });
  });

  describe("upsertImported", () => {
    it("claims an unowned legacy import from the same source", async () => {
      mockCollection = createMockCollection([
        {
          ...LEGACY_TOOL_SKILL,
          _id: "legacy-import",
          skillId: "deploy",
          name: "deploy",
          prompt: "old body",
          source: "claude-config:/ws",
        },
      ]);

      const result = await SkillService.upsertImported(
        { name: "deploy", body: "old body", source: "claude-config:/ws" },
        CALLER,
      );

      expect(result.status).toBe("updated");
      const doc = await mockCollection.findOne({ skillId: "deploy" });
      expect(doc).toMatchObject({ username: "rodrigo", profileId: "default", content: "old body" });
      expect(doc.prompt).toBe("old body");
    });

    it("never clobbers a skill from another source", async () => {
      const result = await SkillService.upsertImported(
        { name: "Test Skill", body: "imported", source: "claude-config:/ws" },
        CALLER,
      );
      expect(result.status).toBe("skipped");
      const doc = await mockCollection.findOne({ skillId: "test_skill" });
      expect(doc.prompt).toBe("Say hello to {{name}}");
    });
  });
});

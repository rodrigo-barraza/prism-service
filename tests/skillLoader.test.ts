/**
 * Skills through the agent's tools (prompt 19, Landing 1): `load_skill`
 * returns a body on demand, `list_skills` never carries vectors or bodies,
 * and every skill tool reads and writes only its caller's scope
 * (project × username × profile, plus the persona a skill is bound to).
 *
 * Storage is the real SkillService over the in-memory Mongo mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    createClient: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn(),
  },
}));

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { requestContext } from "#src/utils/RequestContext";
import skillTools from "#src/services/tool-definitions/SkillTools";

type ToolContext = Record<string, unknown>;

function tool(name: string) {
  const found = (
    skillTools as Array<{
      name: string;
      execute: (toolArguments: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
    }>
  ).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`no internal tool named ${name}`);
  return found;
}

/** Run a skill tool as a request from `username` in `profileId` would. */
function run(
  name: string,
  args: Record<string, unknown>,
  { profileId = "default", ...toolContext }: ToolContext & { profileId?: string } = {},
) {
  const scope = {
    project: "prism-chat",
    username: "alice",
    agent: "CODING",
    ...toolContext,
  } as { project: string; username: string; agent: string };
  return requestContext.run(
    {
      project: scope.project,
      username: scope.username,
      profileId,
      clientIp: null,
      agent: scope.agent,
    },
    () => tool(name).execute(args, scope),
  ) as Promise<any>;
}

function panelSkill(overrides: Record<string, unknown> = {}) {
  return {
    _id: `panel-${String(overrides.name ?? "deploy-service")}-${String(overrides.username ?? "alice")}-${String(overrides.profileId ?? "default")}`,
    project: "prism-chat",
    username: "alice",
    profileId: "default",
    name: "deploy-service",
    description: "Deploy a service to the NAS",
    content: "Run deploy.sh, then GET /health until it answers 200.",
    enabled: true,
    embedding: [0.9, 0.1, 0.4],
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function legacyToolSkill(overrides: Record<string, unknown> = {}) {
  return {
    _id: "legacy-1",
    skillId: "check_node_version",
    name: "check_node_version",
    description: "Checks the Node.js version",
    prompt: "Run `node --version` and report it. Target: {{target}}",
    steps: ["run node --version"],
    tools: ["execute_shell"],
    maxIterations: 5,
    model: null,
    project: null,
    agent: null,
    usageCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("skill tools", () => {
  let collection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    collection = createMockCollection([]);
    vi.mocked(MongoWrapper.getCollection).mockImplementation(
      (_database: string, name: string) =>
        (name === COLLECTIONS.AGENT_SKILLS ? collection : null) as any,
    );
  });

  describe("load_skill", () => {
    it("returns the body and a resource listing", async () => {
      collection = createMockCollection([panelSkill()]);

      const result = await run("load_skill", { name: "deploy-service" });

      expect(result.error).toBeUndefined();
      expect(result.name).toBe("deploy-service");
      expect(result.description).toBe("Deploy a service to the NAS");
      expect(result.body).toBe(
        "Run deploy.sh, then GET /health until it answers 200.",
      );
      expect(Array.isArray(result.resources)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("0.9");
    });

    it("loads a legacy SkillService-schema skill, template and all", async () => {
      collection = createMockCollection([legacyToolSkill()]);

      const result = await run("load_skill", { name: "check_node_version" });

      expect(result.body).toBe(
        "Run `node --version` and report it. Target: {{target}}",
      );
      expect(result.allowedTools).toEqual(["execute_shell"]);
      expect(result.steps).toEqual(["run node --version"]);
      expect(result.templateVariables).toEqual(["target"]);
    });

    it("counts the load", async () => {
      collection = createMockCollection([panelSkill()]);

      await run("load_skill", { name: "deploy-service" });
      await run("load_skill", { name: "deploy-service" });

      const stored = await collection.findOne({ name: "deploy-service" });
      expect(stored.usageCount).toBe(2);
      expect(typeof stored.lastUsedAt).toBe("string");
    });

    it("names what IS available when the skill is not in scope", async () => {
      collection = createMockCollection([
        panelSkill({ name: "mine" }),
        panelSkill({ name: "bobs-secret", username: "bob" }),
      ]);

      const result = await run("load_skill", { name: "bobs-secret" });

      expect(result.error).toMatch(/bobs-secret/);
      expect(result.error).toContain("mine");
      expect(result.body).toBeUndefined();
    });

    it("loads a persona-bound skill only for that persona", async () => {
      collection = createMockCollection([
        panelSkill({ name: "howl", agent: "LUPOS" }),
      ]);

      expect((await run("load_skill", { name: "howl" }, { agent: "LUPOS" })).body).toBeTruthy();
      expect((await run("load_skill", { name: "howl" }, { agent: "CODING" })).body).toBeUndefined();
      expect((await run("load_skill", { name: "howl" }, { agent: null as any })).body).toBeUndefined();
    });

    it("requires a name", async () => {
      const result = await run("load_skill", {});
      expect(result.error).toBeTruthy();
    });
  });

  describe("list_skills", () => {
    it("returns no embedding vectors and no bodies", async () => {
      collection = createMockCollection([panelSkill(), legacyToolSkill()]);

      const result = await run("list_skills", {});
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain("embedding");
      expect(serialized).not.toContain("0.9");
      expect(serialized).not.toContain("Run deploy.sh");
      expect(serialized).not.toContain("node --version");
      expect(result.skills.map((skill: any) => skill.name).sort()).toEqual([
        "check_node_version",
        "deploy-service",
      ]);
    });
  });

  describe("scope isolation — two users, two profiles", () => {
    beforeEach(() => {
      collection = createMockCollection([
        panelSkill({ name: "alice-default" }),
        panelSkill({ name: "alice-work", profileId: "work" }),
        panelSkill({ name: "bob-default", username: "bob" }),
        panelSkill({ name: "bob-work", username: "bob", profileId: "work" }),
      ]);
    });

    const names = async (context: ToolContext & { profileId?: string }) =>
      (await run("list_skills", {}, context)).skills
        .map((skill: any) => skill.name)
        .sort();

    it("lists only the caller's own user × profile", async () => {
      expect(await names({ username: "alice" })).toEqual(["alice-default"]);
      expect(await names({ username: "alice", profileId: "work" })).toEqual([
        "alice-work",
      ]);
      expect(await names({ username: "bob" })).toEqual(["bob-default"]);
      expect(await names({ username: "bob", profileId: "work" })).toEqual([
        "bob-work",
      ]);
    });

    it("loads nothing across users or profiles", async () => {
      expect(
        (await run("load_skill", { name: "bob-default" }, { username: "alice" }))
          .body,
      ).toBeUndefined();
      expect(
        (await run("load_skill", { name: "alice-work" }, { username: "alice" }))
          .body,
      ).toBeUndefined();
      expect(
        (
          await run(
            "load_skill",
            { name: "alice-work" },
            { username: "alice", profileId: "work" },
          )
        ).body,
      ).toBeTruthy();
    });

    it("deletes nothing across users", async () => {
      const result = await run(
        "delete_skill",
        { skillId: "bob-default" },
        { username: "alice" },
      );

      expect(result.error).toBeTruthy();
      expect(await collection.findOne({ name: "bob-default" })).not.toBeNull();
    });

    it("create_skill stamps the caller's scope", async () => {
      await run(
        "create_skill",
        { name: "fresh", prompt: "do the fresh thing", description: "Fresh" },
        { username: "bob", profileId: "work" },
      );

      const stored = await collection.findOne({ name: "fresh" });
      expect(stored).toMatchObject({
        project: "prism-chat",
        username: "bob",
        profileId: "work",
        enabled: true,
      });
      expect(await names({ username: "bob", profileId: "work" })).toContain(
        "fresh",
      );
      expect(await names({ username: "alice", profileId: "work" })).not.toContain(
        "fresh",
      );
    });

    it("the same name may exist once per scope", async () => {
      const aliceCopy = await run(
        "create_skill",
        { name: "bob-default", prompt: "alice's own" },
        { username: "alice" },
      );
      const duplicate = await run(
        "create_skill",
        { name: "alice-default", prompt: "again" },
        { username: "alice" },
      );

      expect(aliceCopy.error).toBeUndefined();
      expect(duplicate.error).toMatch(/already exists/);
    });
  });
});

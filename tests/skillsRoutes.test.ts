import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue([0.25, 0.75]) },
}));

const { default: skillsRouter } = await import("#src/routes/SkillsRoutes");
app.use("/skills", skillsRouter);

/**
 * The Skills panel's contract over HTTP, on the real SkillService: the
 * panel's field names survive (`content` is the body, `id` addresses it),
 * vectors never leave the server, and a request only reaches its own
 * project × user × profile (plus unowned legacy skills, shared as before).
 */
describe("SkillsRoutes", () => {
  const agent = supertest(app);
  let collection: ReturnType<typeof createMockCollection>;

  const as = (request: any, username = "alice", profileId?: string) => {
    const scoped = request.set("x-project", "prism-chat").set("x-username", username);
    return profileId ? scoped.set("x-profile-id", profileId) : scoped;
  };

  beforeEach(() => {
    collection = createMockCollection([
      {
        _id: "alice-1",
        project: "prism-chat",
        username: "alice",
        profileId: "default",
        name: "deploy-service",
        description: "Deploy to the NAS",
        content: "Run deploy.sh.",
        enabled: true,
        embedding: [0.9, 0.1],
      },
      {
        _id: "bob-1",
        project: "prism-chat",
        username: "bob",
        profileId: "default",
        name: "bob-only",
        description: "Bob's",
        content: "Bob's body.",
        enabled: true,
      },
      {
        _id: "legacy-1",
        skillId: "check_node_version",
        name: "check_node_version",
        description: "Checks Node",
        prompt: "Run node --version.",
        project: null,
        agent: null,
        usageCount: 0,
      },
    ]);
    vi.mocked(MongoWrapper.getDb).mockReturnValue({ collection: () => collection } as any);
    vi.mocked(MongoWrapper.getCollection).mockImplementation(
      (_database: string, name: string) =>
        (name === COLLECTIONS.AGENT_SKILLS ? collection : null) as any,
    );
  });

  it("GET lists the caller's skills and shared legacy skills, in the panel's shape, without vectors", async () => {
    const response = await as(agent.get("/skills")).expect(200);

    expect(response.body.map((skill: any) => skill.name)).toEqual([
      "check_node_version",
      "deploy-service",
    ]);
    const deploy = response.body.find((skill: any) => skill.name === "deploy-service");
    expect(deploy).toMatchObject({
      id: "alice-1",
      content: "Run deploy.sh.",
      description: "Deploy to the NAS",
      enabled: true,
    });
    expect(response.body.find((skill: any) => skill.name === "check_node_version").content).toBe(
      "Run node --version.",
    );
    expect(JSON.stringify(response.body)).not.toContain("embedding");
    expect(JSON.stringify(response.body)).not.toContain("0.9");
  });

  it("POST creates a skill in the caller's scope and refuses a duplicate name", async () => {
    const created = await as(agent.post("/skills"), "alice", "work")
      .send({ name: "release-notes", description: "Notes", content: "Read the log." })
      .expect(201);

    expect(created.body).toMatchObject({
      name: "release-notes",
      content: "Read the log.",
      username: "alice",
      profileId: "work",
      source: "user",
    });
    expect(created.body).not.toHaveProperty("embedding");
    const stored = await collection.findOne({ name: "release-notes" });
    expect(stored.embedding).toEqual([0.25, 0.75]);

    await as(agent.post("/skills"), "alice", "work")
      .send({ name: "release-notes", content: "again" })
      .expect(409);
    await as(agent.post("/skills"), "alice").send({ name: "empty" }).expect(400);
  });

  it("PUT updates only a skill the caller can see", async () => {
    const updated = await as(agent.put("/skills/alice-1"))
      .send({ content: "Run deploy.sh, then check /health." })
      .expect(200);
    expect(updated.body.content).toBe("Run deploy.sh, then check /health.");

    await as(agent.put("/skills/bob-1")).send({ enabled: false }).expect(404);
    expect((await collection.findOne({ _id: "bob-1" })).enabled).toBe(true);
  });

  it("DELETE removes only a skill the caller can see", async () => {
    await as(agent.delete("/skills/bob-1")).expect(404);
    expect(await collection.findOne({ _id: "bob-1" })).not.toBeNull();

    await as(agent.delete("/skills/bob-1"), "bob").expect(200);
    expect(await collection.findOne({ _id: "bob-1" })).toBeNull();
  });
});

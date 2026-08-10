/**
 * ProfilesRoutes — the roster of switchable identities per {project, username}.
 *
 * The default profile is implicit (always listed, never stored, never
 * editable/deletable); custom profiles round-trip through CRUD and are
 * scoped to the requesting {project, username}.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";

const { default: profilesRouter } = await import("#src/routes/ProfilesRoutes");

app.use("/profiles", profilesRouter);

const PROJECT = "test-project";
const USERNAME = "test-user";

describe("ProfilesRoutes", () => {
  const agent = supertest(app);
  let profiles: any[] = [];

  /** Every query this router issues is a flat equality match. */
  const matches = (doc: any, query: any) =>
    Object.entries(query || {}).every(([key, value]) => doc[key] === value);

  const collection = {
    find: (query: any = {}) => {
      const cursor: any = {
        sort: () => cursor,
        toArray: async () => profiles.filter((doc) => matches(doc, query)),
      };
      return cursor;
    },
    findOne: async (query: any) =>
      profiles.find((doc) => matches(doc, query)) || null,
    insertOne: async (document: any) => {
      profiles.push({ ...document });
      return { insertedId: "mock-id" };
    },
    findOneAndUpdate: async (query: any, update: any) => {
      const doc = profiles.find((candidate) => matches(candidate, query));
      if (!doc) return null;
      Object.assign(doc, update.$set);
      return doc;
    },
    findOneAndDelete: async (query: any) => {
      const index = profiles.findIndex((doc) => matches(doc, query));
      if (index === -1) return null;
      return profiles.splice(index, 1)[0];
    },
  };

  const mockDb = {
    collection: (name: string) =>
      name === COLLECTIONS.PROFILES
        ? collection
        : { find: () => ({ sort: () => ({ toArray: async () => [] }) }) },
  };

  const scoped = (request: supertest.Test) =>
    request.set("x-project", PROJECT).set("x-username", USERNAME);

  beforeEach(() => {
    profiles = [];
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  it("always lists the built-in default profile first", async () => {
    const response = await scoped(agent.get("/profiles")).expect(200);
    expect(response.body).toEqual([
      { profileId: "default", name: "Default", builtIn: true },
    ]);
  });

  it("round-trips create / list / rename / delete", async () => {
    const created = await scoped(agent.post("/profiles"))
      .send({ name: "Work Stuff", emoji: "💼" })
      .expect(201);
    expect(created.body).toMatchObject({
      profileId: "work-stuff",
      name: "Work Stuff",
      emoji: "💼",
      project: PROJECT,
      username: USERNAME,
    });

    const listed = await scoped(agent.get("/profiles")).expect(200);
    expect(listed.body.map((profile: any) => profile.profileId)).toEqual([
      "default",
      "work-stuff",
    ]);

    const renamed = await scoped(agent.patch("/profiles/work-stuff"))
      .send({ name: "Deep Work" })
      .expect(200);
    expect(renamed.body.name).toBe("Deep Work");

    await scoped(agent.delete("/profiles/work-stuff")).expect(200);
    const after = await scoped(agent.get("/profiles")).expect(200);
    expect(after.body).toHaveLength(1);
  });

  it("rejects duplicate ids and the reserved default id", async () => {
    await scoped(agent.post("/profiles")).send({ name: "Work" }).expect(201);
    await scoped(agent.post("/profiles")).send({ name: "Work" }).expect(409);
    await scoped(agent.post("/profiles"))
      .send({ name: "Whatever", profileId: "default" })
      .expect(409);
  });

  it("never edits or deletes the built-in default profile", async () => {
    await scoped(agent.patch("/profiles/default"))
      .send({ name: "Nope" })
      .expect(400);
    await scoped(agent.delete("/profiles/default")).expect(400);
  });

  it("scopes the roster to the requesting project/username", async () => {
    await scoped(agent.post("/profiles")).send({ name: "Mine" }).expect(201);

    const otherUser = await agent
      .get("/profiles")
      .set("x-project", PROJECT)
      .set("x-username", "someone-else")
      .expect(200);
    expect(otherUser.body).toHaveLength(1); // just the default

    await agent
      .delete("/profiles/mine")
      .set("x-project", PROJECT)
      .set("x-username", "someone-else")
      .expect(404);
  });
});

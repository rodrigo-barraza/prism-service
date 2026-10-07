/**
 * scripts/migrate-owner-username.ts — the one-off move of the owner's data
 * from the username every unauthenticated request used to get (`anonymous`)
 * to the one their login maps to. A dry run by default; never deletes; a
 * collision with a unique key leaves the document where it was.
 */
import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import {
  formatReport,
  migrateOwnerUsername,
  parseArguments,
  productionRefusal,
} from "../scripts/migrate-owner-username.ts";

type Document = Record<string, unknown> & { _id: number };

/** The few Mongo operations the script uses, over arrays — with one unique index, like `profiles`. */
function fakeDb(collections: Record<string, Array<Record<string, unknown>>>, unique: Record<string, string[]> = {}) {
  let nextId = 1;
  const data = new Map<string, Document[]>(
    Object.entries(collections).map(([name, documents]) => [name, documents.map((document) => ({ _id: nextId++, ...document }))]),
  );
  const matches = (document: Document, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = document[key];
      if (expected === null) return actual === null || actual === undefined;
      if (expected && typeof expected === "object" && "$in" in expected) {
        return (expected as { $in: unknown[] }).$in.includes(actual);
      }
      return actual === expected;
    });
  const collides = (name: string, document: Document, changes: Record<string, unknown>) => {
    const keys = unique[name];
    if (!keys) return false;
    const next = { ...document, ...changes };
    return data.get(name)!.some((other) => other._id !== document._id && keys.every((key) => other[key] === next[key]));
  };
  const duplicateKey = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  const collection = (name: string) => {
    const documents = () => data.get(name) ?? [];
    return {
      countDocuments: async (filter: Record<string, unknown>) => documents().filter((document) => matches(document, filter)).length,
      find: (filter: Record<string, unknown>) => ({
        toArray: async () => documents().filter((document) => matches(document, filter)).map(({ _id }) => ({ _id })),
      }),
      updateMany: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
        let modifiedCount = 0;
        for (const document of documents().filter((each) => matches(each, filter))) {
          if (collides(name, document, update.$set)) throw duplicateKey();
          Object.assign(document, update.$set);
          modifiedCount++;
        }
        return { modifiedCount };
      },
      updateOne: async (filter: { _id: number }, update: { $set: Record<string, unknown> }) => {
        const document = documents().find((each) => each._id === filter._id);
        if (!document) return { modifiedCount: 0 };
        if (collides(name, document, update.$set)) throw duplicateKey();
        Object.assign(document, update.$set);
        return { modifiedCount: 1 };
      },
    };
  };
  const db = {
    listCollections: () => ({ toArray: async () => [...data.keys(), "system.views"].map((name) => ({ name })) }),
    collection,
  } as unknown as Db;
  return { db, data };
}

const OWNER_DATA = () => ({
  agent_conversations: [
    { id: "a1", project: "prism-chat", username: "anonymous" },
    { id: "a2", project: "coding", username: "anonymous" },
    { id: "a3", project: "lupos", username: "discord-member" },
  ],
  permission_rules: [{ id: "r1", project: "prism-client", username: "anonymous" }],
  profiles: [
    { project: "prism-chat", username: "anonymous", profileId: "work" },
    { project: "prism-chat", username: "anonymous", profileId: "home" },
    { project: "prism-chat", username: "rodrigo", profileId: "work" },
  ],
  scheduled_tasks: [
    { id: "t1", project: "coding", username: "anonymous" },
    { id: "t2", project: "coding", username: "anonymous", authKind: "service" },
  ],
  conversation_timers: [{ id: "c1", project: "coding", username: "anonymous" }],
  workspaces: [{ id: "w1", name: "coding" }],
});

describe("migrate-owner-username", () => {
  it("a dry run counts, per collection, what would move — and writes nothing", async () => {
    const { db, data } = fakeDb(OWNER_DATA());
    const reports = await migrateOwnerUsername(db, { from: "anonymous", to: "rodrigo", projects: null, apply: false });
    expect(reports).toEqual([
      { collection: "agent_conversations", matched: 2, moved: 2, conflicts: 0, stamped: 0 },
      { collection: "conversation_timers", matched: 1, moved: 1, conflicts: 0, stamped: 1 },
      { collection: "permission_rules", matched: 1, moved: 1, conflicts: 0, stamped: 0 },
      { collection: "profiles", matched: 2, moved: 2, conflicts: 0, stamped: 0 },
      { collection: "scheduled_tasks", matched: 2, moved: 2, conflicts: 0, stamped: 1 },
    ]);
    expect(data.get("agent_conversations")!.filter((document) => document.username === "anonymous")).toHaveLength(2);
    expect(formatReport(reports, { from: "anonymous", to: "rodrigo", projects: null, apply: false, database: "prism" })).toContain(
      "Nothing was written",
    );
  });

  it("--apply moves every collection's documents, stamps the owner's own scheduled runs, and never deletes", async () => {
    const { db, data } = fakeDb(OWNER_DATA(), { profiles: ["project", "username", "profileId"] });
    const before = [...data.values()].reduce((sum, documents) => sum + documents.length, 0);
    const reports = await migrateOwnerUsername(db, { from: "anonymous", to: "rodrigo", projects: null, apply: true });

    expect(reports.find((report) => report.collection === "agent_conversations")).toMatchObject({ moved: 2 });
    // The owner already had a "work" profile: that one stays, counted as a conflict.
    expect(reports.find((report) => report.collection === "profiles")).toMatchObject({ matched: 2, moved: 1, conflicts: 1 });
    expect(data.get("profiles")!.map((document) => [document.profileId, document.username])).toEqual([
      ["work", "anonymous"],
      ["home", "rodrigo"],
      ["work", "rodrigo"],
    ]);
    // Their runs keep owner powers; a run a service saved stays a service's.
    expect(data.get("scheduled_tasks")!.map((document) => [document.id, document.username, document.authKind])).toEqual([
      ["t1", "rodrigo", "user"],
      ["t2", "rodrigo", "service"],
    ]);
    expect(data.get("conversation_timers")![0]).toMatchObject({ username: "rodrigo", authKind: "user" });
    // Someone else's data is untouched; nothing is gone.
    expect(data.get("agent_conversations")![2]).toMatchObject({ username: "discord-member" });
    expect([...data.values()].reduce((sum, documents) => sum + documents.length, 0)).toBe(before);
  });

  it("--projects narrows the move to those projects", async () => {
    const { db, data } = fakeDb(OWNER_DATA());
    const reports = await migrateOwnerUsername(db, { from: "anonymous", to: "rodrigo", projects: ["prism-chat"], apply: true });
    expect(reports.map((report) => [report.collection, report.moved])).toEqual([
      ["agent_conversations", 1],
      ["profiles", 2],
    ]);
    expect(data.get("agent_conversations")!.map((document) => document.username)).toEqual(["rodrigo", "anonymous", "discord-member"]);
  });

  it("reads its flags strictly", () => {
    expect(parseArguments(["--from", "anonymous", "--to", "rodrigo"])).toEqual({
      from: "anonymous",
      to: "rodrigo",
      projects: null,
      apply: false,
      yesProduction: false,
    });
    expect(parseArguments(["--from", "a", "--to", "b", "--projects", "x, y", "--apply", "--yes-production"])).toMatchObject({
      projects: ["x", "y"],
      apply: true,
      yesProduction: true,
    });
    expect(() => parseArguments(["--from", "a"])).toThrow(/--from and --to are required/);
    expect(() => parseArguments(["--from", "a", "--to", "a"])).toThrow(/same username/);
    expect(() => parseArguments(["--from", "a", "--to", "b", "--force"])).toThrow(/Unknown argument/);
    expect(() => parseArguments(["--from", "--to", "b"])).toThrow(/--from needs a value/);
  });

  it("refuses to apply to production without --yes-production; a dry run there is fine", () => {
    expect(productionRefusal("prism", { apply: true, yesProduction: false })).toMatch(/without --yes-production/);
    expect(productionRefusal("prism", { apply: true, yesProduction: true })).toBeNull();
    expect(productionRefusal("prism", { apply: false, yesProduction: false })).toBeNull();
    expect(productionRefusal("prism_test_login_guard", { apply: true, yesProduction: false })).toBeNull();
  });
});

/**
 * POST /conversations/:id/rewind and /fork (docs/prompts/15), plus the
 * served-id / hidden-rewound contract of GET /conversations/:id and the
 * snapshot-ref cleanup of DELETE and housekeeping.
 *
 * Mongo is an in-memory fake with real filter semantics for what these
 * routes use ($in with null-matches-missing, $ne, $exists, dotted array
 * paths, $push/$each, $pull). tools-service is a fake that records every
 * /agentic/git/* request — the git behaviour itself is pinned in
 * tools-service tests/AgenticGitSnapshot.test.ts against a real repo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import conversationsRouter from "#src/routes/ConversationsRoutes";
import conversationBranchRouter from "#src/routes/ConversationBranchRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { pruneExpiredWorkspaceSnapshots } from "#src/services/conversation/workspaceSnapshots";

app.use("/conversations", conversationBranchRouter);
app.use("/conversations", conversationsRouter);

// ── In-memory Mongo ──────────────────────────────────────────

type Doc = Record<string, any>;

function getPath(doc: Doc, path: string): unknown {
  return path.split(".").reduce<any>((value, key) => (value == null ? undefined : value[key]), doc);
}

function matches(doc: Doc, filter: Doc = {}): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = getPath(doc, key);
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("$in" in condition) return condition.$in.includes(value ?? null);
      if ("$ne" in condition) return value !== condition.$ne;
      if ("$exists" in condition) return (value !== undefined) === condition.$exists;
      if ("$lt" in condition) return (value as any) < condition.$lt;
    }
    return value === condition;
  });
}

function createFakeDb() {
  const collections = new Map<string, Doc[]>();
  const writes: Array<{ collection: string; op: string; payload: unknown }> = [];
  const list = (name: string) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name)!;
  };
  const collection = (name: string) => ({
    findOne: async (filter: Doc) => {
      const found = list(name).find((doc) => matches(doc, filter));
      return found ? structuredClone(found) : null;
    },
    find: (filter: Doc) => {
      const cursor: any = {
        project: () => cursor,
        sort: () => cursor,
        limit: () => cursor,
        skip: () => cursor,
        toArray: async () => list(name).filter((doc) => matches(doc, filter)).map((doc) => structuredClone(doc)),
      };
      return cursor;
    },
    insertOne: async (doc: Doc) => {
      writes.push({ collection: name, op: "insertOne", payload: doc });
      list(name).push(structuredClone(doc));
      return { acknowledged: true };
    },
    updateOne: async (filter: Doc, update: Doc) => {
      writes.push({ collection: name, op: "updateOne", payload: update });
      const doc = list(name).find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, structuredClone(update.$set || {}));
      for (const [field, value] of Object.entries(update.$push || {})) {
        const items = value && typeof value === "object" && "$each" in (value as Doc) ? (value as Doc).$each : [value];
        doc[field] = [...(doc[field] || []), ...structuredClone(items)];
      }
      for (const [field, condition] of Object.entries(update.$pull || {})) {
        doc[field] = (doc[field] || []).filter((item: Doc) => !matches(item, condition as Doc));
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (filter: Doc) => {
      const items = list(name);
      const index = items.findIndex((doc) => matches(doc, filter));
      if (index === -1) return { deletedCount: 0 };
      items.splice(index, 1);
      return { deletedCount: 1 };
    },
    deleteMany: async (filter: Doc) => {
      const items = list(name);
      const keep = items.filter((doc) => !matches(doc, filter));
      const deletedCount = items.length - keep.length;
      collections.set(name, keep);
      return { deletedCount };
    },
    countDocuments: async (filter: Doc) => list(name).filter((doc) => matches(doc, filter)).length,
    aggregate: () => {
      throw new Error("aggregate is not used by these tests");
    },
  });
  return { collection, list, writes };
}

// ── Fake tools-service ───────────────────────────────────────

let tools: {
  requests: Array<{ path: string; body: Doc }>;
  restore: (body: Doc) => { status: number; body: Doc };
};

function installToolsFake() {
  const setupFetch = global.fetch;
  tools = {
    requests: [],
    restore: (body) => ({
      status: 200,
      body: {
        snapshotCapable: true,
        ref: body.ref,
        againstRef: body.againstRef,
        dryRun: !!body.dryRun,
        applied: !body.dryRun,
        refused: false,
        conflicts: [],
        restored: ["a.txt"],
        removed: ["b.txt"],
        skipped: [],
        counts: { restored: 1, removed: 1, conflicts: 0, skipped: 0 },
        ...(!body.dryRun && {
          undoRef: "refs/prism/checkpoints/conv-1/undo-1",
          afterRef: "refs/prism/checkpoints/conv-1/restore-1",
        }),
      },
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      const match = /\/agentic\/git\/(.*)$/.exec(target);
      if (!match) return (setupFetch as any)(url, init);
      const body = JSON.parse(String(init?.body || "{}"));
      tools.requests.push({ path: match[1], body });
      const answer =
        match[1] === "restore"
          ? tools.restore(body)
          : { status: 200, body: { snapshotCapable: true, deleted: [`${body.prefix || ""}x`] } };
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body } as Response;
    }),
  );
}

// ── Fixture: two turns, each writing through tools ───────────
//
//  0 user  "write a"            ← turn 1
//  1 assistant → write_file t1
//  2 tool t1
//  3 assistant "wrote a"
//  4 user  "modify a, create b" ← turn 2
//  5 assistant → write_file t2, write_file t3
//  6 tool t2
//  7 tool t3
//  8 assistant "done"

const WORKSPACE = "/work/repo";
const NS = "refs/prism/checkpoints/conv-1/";

function fixtureConversation(overrides: Doc = {}): Doc {
  return {
    id: "conv-1",
    project: "prism-agent",
    username: "rodrigo",
    title: "Two turns",
    agent: "CODING",
    workspaceRoot: WORKSPACE,
    settings: { provider: "anthropic", model: "claude-sonnet-5" },
    systemPrompt: "",
    totalCost: 1.25,
    agentConversationId: "loop-correlation-1",
    messages: [
      { id: "m0", role: "user", content: "write a" },
      { id: "m1", role: "assistant", content: "", model: "claude-sonnet-5", toolCalls: [{ id: "t1", name: "write_file", args: { path: "a.txt" } }], estimatedCost: 0.5, usage: { inputTokens: 10 }, requestId: "req-1" },
      { id: "m2", role: "tool", tool_call_id: "t1", name: "write_file", content: "{\"ok\":true}" },
      { id: "m3", role: "assistant", content: "wrote a", model: "claude-sonnet-5" },
      { id: "m4", role: "user", content: "modify a, create b" },
      { id: "m5", role: "assistant", content: "", model: "claude-sonnet-5", toolCalls: [{ id: "t2", name: "write_file", args: {} }, { id: "t3", name: "write_file", args: {} }] },
      { id: "m6", role: "tool", tool_call_id: "t2", name: "write_file", content: "{\"ok\":true}" },
      { id: "m7", role: "tool", tool_call_id: "t3", name: "write_file", content: "{\"ok\":true}" },
      { id: "m8", role: "assistant", content: "done", model: "claude-sonnet-5" },
    ],
    checkpoints: [{ name: "late", description: null, messageIndex: 6, createdAt: "2026-09-22T10:00:00.000Z" }],
    workspaceSnapshots: [
      { ref: `${NS}1-1`, phase: "before", turn: 1, iteration: 1, messageId: null, messageBoundary: 0, toolCallIds: ["t1"], workspaceRoot: WORKSPACE, commit: "c1", createdAt: "2026-09-22T10:00:01.000Z" },
      { ref: `${NS}1-1-after`, phase: "after", turn: 1, iteration: 1, messageId: null, messageBoundary: 0, toolCallIds: ["t1"], workspaceRoot: WORKSPACE, commit: "c2", createdAt: "2026-09-22T10:00:02.000Z" },
      { ref: `${NS}2-1`, phase: "before", turn: 2, iteration: 1, messageId: "m3", messageBoundary: 4, toolCallIds: ["t2", "t3"], workspaceRoot: WORKSPACE, commit: "c3", createdAt: "2026-09-22T10:01:01.000Z" },
      { ref: `${NS}2-1-after`, phase: "after", turn: 2, iteration: 1, messageId: "m3", messageBoundary: 4, toolCallIds: ["t2", "t3"], workspaceRoot: WORKSPACE, commit: "c4", createdAt: "2026-09-22T10:01:02.000Z" },
    ],
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:02:00.000Z",
    ...overrides,
  };
}

const request = supertest(app);
const HEADERS = { "x-username": "rodrigo", "x-project": "prism-agent" };
let db: ReturnType<typeof createFakeDb>;

const stored = () => db.list(COLLECTIONS.AGENT_CONVERSATIONS).find((doc) => doc.id === "conv-1")!;
const rewind = (body: Doc) => request.post("/conversations/conv-1/rewind").set(HEADERS).send(body);
const restoreRequests = () => tools.requests.filter((entry) => entry.path === "restore");

beforeEach(() => {
  db = createFakeDb();
  vi.mocked(MongoWrapper.getDb).mockReturnValue(db as any);
  vi.mocked(MongoWrapper.getCollection).mockImplementation(((_database: string, name: string) => db.collection(name)) as any);
  db.list(COLLECTIONS.AGENT_CONVERSATIONS).push(fixtureConversation());
  installToolsFake();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /conversations/:id/rewind — conversation", () => {
  it("soft-prunes every message after the target and reports what changed", async () => {
    const response = await rewind({ toMessageId: "m3", restore: "conversation" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId: "conv-1",
      toMessageId: "m3",
      restore: "conversation",
      dryRun: false,
      conversation: { prunedCount: 5, remainingCount: 4, keptThroughMessageId: "m3" },
      code: null,
    });
    const messages = stored().messages;
    expect(messages.slice(0, 4).every((message: Doc) => !message.pruned)).toBe(true);
    expect(messages.slice(4).every((message: Doc) => message.pruned && message.prunedBy === "user-rewind")).toBe(true);
    // Checkpoints pointing into the pruned range go with it.
    expect(stored().checkpoints).toEqual([]);
    expect(restoreRequests()).toHaveLength(0);
  });

  it("keeps an assistant message's tool results when rewinding to it", async () => {
    const response = await rewind({ toMessageId: "m5", restore: "conversation" });

    expect(response.status).toBe(200);
    expect(response.body.conversation).toMatchObject({ prunedCount: 1, keptThroughMessageId: "m7" });
    expect(stored().messages.map((message: Doc) => !!message.pruned)).toEqual([
      false, false, false, false, false, false, false, false, true,
    ]);
  });

  it("hides user-rewound messages from GET displayMessages and serves an id on every message", async () => {
    await rewind({ toMessageId: "m3", restore: "conversation" });

    const response = await request.get("/conversations/conv-1").set(HEADERS);

    expect(response.status).toBe(200);
    expect(response.body.displayMessages.map((message: Doc) => message.id)).toEqual(["m0", "m1", "m3"]);
    // The tool result is merged into its assistant message, as before.
    expect(response.body.displayMessages[1].toolCalls[0].result).toBe("{\"ok\":true}");
  });
});

describe("POST /conversations/:id/rewind — code", () => {
  it("restores the first snapshot taken after the message, against the latest snapshot", async () => {
    const response = await rewind({ toMessageId: "m3", restore: "code" });

    expect(response.status).toBe(200);
    expect(restoreRequests()).toHaveLength(1);
    expect(restoreRequests()[0].body).toEqual({
      workspaceRoot: WORKSPACE,
      ref: `${NS}2-1`,
      againstRef: `${NS}2-1-after`,
      force: false,
      dryRun: false,
    });
    expect(response.body.code).toMatchObject({
      status: "restored",
      workspaces: [{ workspaceRoot: WORKSPACE, ref: `${NS}2-1`, status: "restored", restored: ["a.txt"], removed: ["b.txt"], undoRef: `${NS}undo-1` }],
    });
    expect(response.body.conversation).toBeNull();
    // Conversation untouched; the post-restore state becomes the next baseline.
    expect(stored().messages.some((message: Doc) => message.pruned)).toBe(false);
    expect(stored().workspaceSnapshots.at(-1)).toMatchObject({
      ref: `${NS}restore-1`,
      phase: "restore",
      undoRef: `${NS}undo-1`,
      workspaceRoot: WORKSPACE,
    });
  });

  it("picks the target by position: a user prompt restores the state before its turn's writes", async () => {
    await rewind({ toMessageId: "m0", restore: "code", dryRun: true });
    await rewind({ toMessageId: "m1", restore: "code", dryRun: true });
    await rewind({ toMessageId: "m4", restore: "code", dryRun: true });

    expect(restoreRequests().map((entry) => entry.body.ref)).toEqual([
      `${NS}1-1`, // before turn 1 wrote anything
      `${NS}2-1`, // m1's own writes (with their results) are kept → after turn 1
      `${NS}2-1`, // turn 2's prompt → before turn 2 wrote anything
    ]);
  });

  it("reports nothing to restore when the agent wrote nothing after the message", async () => {
    const response = await rewind({ toMessageId: "m8", restore: "code" });

    expect(response.status).toBe(200);
    expect(response.body.code).toMatchObject({ status: "nothing-to-restore", workspaces: [] });
    expect(restoreRequests()).toHaveLength(0);
  });

  it("reports code as unavailable for a workspace that is not snapshot-capable", async () => {
    db.list(COLLECTIONS.AGENT_CONVERSATIONS).splice(0, 1, fixtureConversation({
      workspaceSnapshots: [],
      workspaceSnapshotStatus: { capable: false, reason: "Not a git repository (or not a work tree): /work/plain", workspaceRoot: "/work/plain", checkedAt: "x" },
    }));

    const response = await rewind({ toMessageId: "m3", restore: "both" });

    expect(response.status).toBe(200);
    expect(response.body.code).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/not a git repository/i) });
    // "both" still rewinds the conversation, and says why the code was not.
    expect(response.body.conversation.prunedCount).toBe(5);
  });
});

describe("POST /conversations/:id/rewind — both, refusal and dry run", () => {
  it("restores code first, then prunes the conversation", async () => {
    const response = await rewind({ toMessageId: "m4", restore: "both" });

    expect(response.status).toBe(200);
    expect(response.body.code.status).toBe("restored");
    expect(response.body.conversation).toMatchObject({ prunedCount: 4, keptThroughMessageId: "m4" });
    expect(restoreRequests()[0].body.ref).toBe(`${NS}2-1`);
  });

  it("returns 409 with the conflicting paths and leaves the conversation untouched", async () => {
    tools.restore = (body) => ({
      status: 409,
      body: {
        snapshotCapable: true, ref: body.ref, againstRef: body.againstRef, dryRun: false, applied: false,
        refused: true, conflicts: ["c.txt"], restored: ["a.txt", "c.txt"], removed: [], skipped: [],
      },
    });

    const response = await rewind({ toMessageId: "m3", restore: "both" });

    expect(response.status).toBe(409);
    expect(response.body.code).toMatchObject({
      status: "refused",
      workspaces: [{ status: "refused", conflicts: ["c.txt"] }],
    });
    expect(response.body.conversation).toBeNull();
    expect(stored().messages.some((message: Doc) => message.pruned)).toBe(false);
    expect(stored().workspaceSnapshots).toHaveLength(4);
  });

  it("a dry run with conflicts still previews the conversation part", async () => {
    tools.restore = (body) => ({
      status: 409,
      body: {
        snapshotCapable: true, ref: body.ref, againstRef: body.againstRef, dryRun: true, applied: false,
        refused: true, conflicts: ["c.txt"], restored: ["a.txt", "c.txt"], removed: ["b.txt"], skipped: [],
      },
    });

    const response = await rewind({ toMessageId: "m3", restore: "both", dryRun: true });

    expect(response.status).toBe(409);
    expect(response.body.code).toMatchObject({ status: "refused", workspaces: [{ conflicts: ["c.txt"], removed: ["b.txt"] }] });
    expect(response.body.conversation).toMatchObject({ prunedCount: 5 });
    expect(stored().messages.some((message: Doc) => message.pruned)).toBe(false);
  });

  it("passes force through", async () => {
    await rewind({ toMessageId: "m3", restore: "code", force: true });
    expect(restoreRequests()[0].body.force).toBe(true);
  });

  it("dry run lists what would change and changes nothing", async () => {
    const before = structuredClone(stored());

    const response = await rewind({ toMessageId: "m3", restore: "both", dryRun: true });

    expect(response.status).toBe(200);
    expect(restoreRequests()[0].body.dryRun).toBe(true);
    expect(response.body).toMatchObject({
      dryRun: true,
      code: { status: "dry-run", workspaces: [{ status: "would-restore", restored: ["a.txt"], removed: ["b.txt"] }] },
      conversation: { prunedCount: 5 },
    });
    expect(stored()).toEqual(before);
  });

  it("refuses while a turn is running, and for unknown or already-rewound messages", async () => {
    db.list(COLLECTIONS.AGENT_CONVERSATIONS)[0].isGenerating = true;
    expect((await rewind({ toMessageId: "m3", restore: "both" })).status).toBe(409);
    db.list(COLLECTIONS.AGENT_CONVERSATIONS)[0].isGenerating = false;

    expect((await rewind({ toMessageId: "nope", restore: "both" })).status).toBe(404);
    expect((await rewind({ toMessageId: "m3", restore: "sideways" })).status).toBe(400);
    await rewind({ toMessageId: "m3", restore: "conversation" });
    expect((await rewind({ toMessageId: "m5", restore: "conversation" })).status).toBe(400);
  });

  it("resolves the served legacy ids of messages persisted before ids existed", async () => {
    const legacy = fixtureConversation();
    legacy.messages = legacy.messages.map(({ id: _id, ...message }: Doc) => message);
    db.list(COLLECTIONS.AGENT_CONVERSATIONS).splice(0, 1, legacy);

    const served = await request.get("/conversations/conv-1").set(HEADERS);
    const lastOfTurnOne = served.body.displayMessages[2];
    expect(lastOfTurnOne).toMatchObject({ id: "legacy-3", content: "wrote a" });

    const response = await rewind({ toMessageId: lastOfTurnOne.id, restore: "conversation" });
    expect(response.status).toBe(200);
    expect(response.body.conversation.prunedCount).toBe(5);
  });
});

describe("POST /conversations/:id/fork", () => {
  it("copies the messages through the target, tool calls and results included, with lineage", async () => {
    const response = await request.post("/conversations/conv-1/fork").set(HEADERS).send({ atMessageId: "m5" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      type: "agent",
      title: "Two turns (fork)",
      messageCount: 8,
      forkedFrom: { conversationId: "conv-1", messageId: "m5", title: "Two turns" },
    });
    const fork = db.list(COLLECTIONS.AGENT_CONVERSATIONS).find((doc) => doc.id === response.body.id)!;
    expect(fork.messages.map((message: Doc) => message.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    expect(fork.messages[5].toolCalls.map((toolCall: Doc) => toolCall.id)).toEqual(["t2", "t3"]);
    expect(fork.messages[6]).toMatchObject({ role: "tool", tool_call_id: "t2" });
    expect(fork.forkedFrom).toMatchObject({ conversationId: "conv-1", messageId: "m5" });
    expect(fork).toMatchObject({ workspaceRoot: WORKSPACE, agent: "CODING", settings: { model: "claude-sonnet-5" } });
    // Costs and request rows stay with the source.
    expect(fork).toMatchObject({ totalCost: 0, inputTokens: 0, outputTokens: 0 });
    expect(fork.agentConversationId).toBeUndefined();
    expect(fork.messages[1].estimatedCost).toBeUndefined();
    expect(fork.messages[1].usage).toBeUndefined();
    expect(db.writes.filter((write) => write.collection === COLLECTIONS.REQUESTS)).toEqual([]);
    // No snapshots, checkpoints or files come along — the fork starts clean.
    expect(fork.workspaceSnapshots).toBeUndefined();
    expect(fork.checkpoints).toBeUndefined();
    expect(tools.requests).toHaveLength(0);
    // The source records its fork.
    expect(stored().forks).toEqual([
      { conversationId: response.body.id, messageId: "m5", position: "at", createdAt: expect.any(String) },
    ]);
  });

  it("forks at a user message without the rest of its turn, and both continue independently", async () => {
    const response = await request.post("/conversations/conv-1/fork").set(HEADERS).send({ atMessageId: "m3" });
    const forkId = response.body.id;

    // The source can be rewound without touching the fork.
    await rewind({ toMessageId: "m0", restore: "conversation" });

    const fork = db.list(COLLECTIONS.AGENT_CONVERSATIONS).find((doc) => doc.id === forkId)!;
    expect(fork.messages.map((message: Doc) => message.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(fork.messages.some((message: Doc) => message.pruned)).toBe(false);
    const served = await request.get(`/conversations/${forkId}`).set(HEADERS);
    expect(served.body.forkedFrom).toMatchObject({ conversationId: "conv-1", messageId: "m3" });
  });

  it("forks BEFORE a message for edit-as-branch — the first message included", async () => {
    const beforeTurnTwo = await request.post("/conversations/conv-1/fork").set(HEADERS).send({ beforeMessageId: "m4" });
    const beforeFirst = await request.post("/conversations/conv-1/fork").set(HEADERS).send({ beforeMessageId: "m0" });

    expect(beforeTurnTwo.status).toBe(201);
    expect(beforeTurnTwo.body.forkedFrom).toMatchObject({ messageId: "m4", position: "before" });
    const fork = db.list(COLLECTIONS.AGENT_CONVERSATIONS).find((doc) => doc.id === beforeTurnTwo.body.id)!;
    expect(fork.messages.map((message: Doc) => message.id)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(beforeFirst.status).toBe(201);
    expect(beforeFirst.body).toMatchObject({ messageCount: 0, forkedFrom: { messageId: "m0", position: "before" } });
    // The source is untouched either way.
    expect(stored().messages).toHaveLength(9);
    expect(stored().messages.some((message: Doc) => message.pruned)).toBe(false);
  });

  it("requires exactly one of atMessageId / beforeMessageId", async () => {
    expect((await request.post("/conversations/conv-1/fork").set(HEADERS).send({})).status).toBe(400);
    expect(
      (await request.post("/conversations/conv-1/fork").set(HEADERS).send({ atMessageId: "m1", beforeMessageId: "m4" })).status,
    ).toBe(400);
  });

  it("404s for an unknown message or conversation", async () => {
    expect((await request.post("/conversations/conv-1/fork").set(HEADERS).send({ atMessageId: "nope" })).status).toBe(404);
    expect((await request.post("/conversations/missing/fork").set(HEADERS).send({ atMessageId: "m0" })).status).toBe(404);
  });
});

describe("snapshot pruning", () => {
  it("deletes a conversation's snapshot refs when the conversation is deleted", async () => {
    const response = await request.delete("/conversations/conv-1").set(HEADERS);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(tools.requests.filter((entry) => entry.path === "snapshot/delete")).toHaveLength(1));
    expect(tools.requests[0].body).toEqual({ workspaceRoot: WORKSPACE, prefix: NS });
  });

  it("housekeeping deletes refs older than the retention window and pulls their records", async () => {
    const now = Date.parse("2026-09-22T10:01:00.000Z");

    const result = await pruneExpiredWorkspaceSnapshots({ maxAgeMilliseconds: 30_000, now });

    expect(tools.requests).toEqual([
      {
        path: "snapshot/delete",
        body: { workspaceRoot: WORKSPACE, prefix: "refs/prism/checkpoints/", olderThanMs: 30_000 },
      },
    ]);
    expect(result).toEqual({ deletedRefs: 1, prunedDocuments: 1 });
    expect(stored().workspaceSnapshots.map((record: Doc) => record.ref)).toEqual([`${NS}2-1`, `${NS}2-1-after`]);
  });
});

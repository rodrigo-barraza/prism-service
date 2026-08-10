import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// Checkpoint / rewind persistence — the storage half of the
// checkpoint & rewind tools. Uses an in-memory Mongo double so the
// real read-modify-write logic in checkpoints.ts runs unmodified.
// ────────────────────────────────────────────────────────────

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface FakeDocument {
  id: string;
  project: string;
  username: string;
  messages: Array<Record<string, unknown>>;
  checkpoints?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

const store = vi.hoisted(() => ({
  documents: [] as FakeDocument[],
}));

function matches(document: FakeDocument, filter: Record<string, unknown>) {
  return Object.entries(filter).every(
    ([key, value]) => document[key] === value,
  );
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: () => ({
      findOne: async (filter: Record<string, unknown>) => {
        const found = store.documents.find((document) =>
          matches(document, filter),
        );
        // Projections in checkpoints.ts only narrow, never rename — the
        // full document is a superset, so returning it is sufficient.
        return found ? structuredClone(found) : null;
      },
      updateOne: async (
        filter: Record<string, unknown>,
        update: {
          $set?: Record<string, unknown>;
          $push?: Record<string, { $each: unknown[] }>;
        },
      ) => {
        const found = store.documents.find((document) =>
          matches(document, filter),
        );
        if (!found) return { matchedCount: 0 };
        if (update.$set) Object.assign(found, structuredClone(update.$set));
        if (update.$push) {
          for (const [key, value] of Object.entries(update.$push)) {
            const target = (found[key] as unknown[]) || [];
            target.push(...structuredClone(value.$each));
            found[key] = target;
          }
        }
        return { matchedCount: 1 };
      },
    }),
  },
}));

const {
  recordCheckpoint,
  rewindToCheckpoint,
  getCheckpoints,
  stripPrunedMessages,
} = await import("#src/services/conversation/checkpoints");

const SCOPE = {
  conversationId: "conversation-1",
  project: "test-project",
  username: "test-user",
};

function seedConversation(messages: Array<Record<string, unknown>>) {
  store.documents = [
    {
      id: SCOPE.conversationId,
      project: SCOPE.project,
      username: SCOPE.username,
      messages,
    },
  ];
}

function turn(userText: string, assistantText: string) {
  return [
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ];
}

describe("recordCheckpoint", () => {
  beforeEach(() => {
    seedConversation([...turn("hello", "hi"), ...turn("plan?", "the plan")]);
  });

  it("persists a named checkpoint at the current persisted-message boundary", async () => {
    const result = await recordCheckpoint({
      ...SCOPE,
      name: "before-spike",
      description: "trying the risky refactor",
    });

    expect(result).toMatchObject({
      moved: false,
      checkpoint: {
        name: "before-spike",
        description: "trying the risky refactor",
        messageIndex: 4,
      },
    });

    const persisted = await getCheckpoints(SCOPE);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      name: "before-spike",
      messageIndex: 4,
    });
  });

  it("auto-names unnamed checkpoints and moves an existing name instead of duplicating", async () => {
    const first = await recordCheckpoint({ ...SCOPE });
    expect(first).toMatchObject({ checkpoint: { name: "checkpoint-1" } });

    store.documents[0].messages.push(...turn("more", "words"));
    const moved = await recordCheckpoint({ ...SCOPE, name: "checkpoint-1" });
    expect(moved).toMatchObject({
      moved: true,
      checkpoint: { name: "checkpoint-1", messageIndex: 6 },
    });

    const persisted = await getCheckpoints(SCOPE);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].messageIndex).toBe(6);
  });

  it("errors on a missing conversation", async () => {
    const result = await recordCheckpoint({
      ...SCOPE,
      conversationId: "nope",
    });
    expect(result).toHaveProperty("error");
  });
});

describe("rewindToCheckpoint", () => {
  beforeEach(async () => {
    seedConversation([...turn("hello", "hi")]);
    await recordCheckpoint({ ...SCOPE, name: "anchor" });
    // Two exploratory turns land after the checkpoint.
    store.documents[0].messages.push(
      ...turn("explore A", "dead end A"),
      ...turn("explore B", "dead end B"),
    );
  });

  it("soft-prunes every message after the checkpoint and keeps the rest", async () => {
    const result = await rewindToCheckpoint({ ...SCOPE });
    expect(result).toMatchObject({
      checkpoint: { name: "anchor", messageIndex: 2 },
      prunedCount: 4,
      remainingCount: 2,
    });

    const messages = store.documents[0].messages;
    expect(messages).toHaveLength(6); // nothing destroyed
    expect(messages.slice(0, 2).every((message) => !message.pruned)).toBe(true);
    expect(
      messages
        .slice(2)
        .every(
          (message) => message.pruned === true && message.prunedBy === "anchor",
        ),
    ).toBe(true);
  });

  it("the next loaded history excludes pruned messages, and stays pruned across reload + new turns", async () => {
    await rewindToCheckpoint({ ...SCOPE });

    // Simulated history load #1 (what ChatRoutes / ConversationTimerService do).
    const loaded = stripPrunedMessages(store.documents[0].messages);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((message) => message.content)).toEqual(["hello", "hi"]);

    // The rewind turn itself persists after the pruning write and survives.
    store.documents[0].messages.push(
      ...turn("rewind please", "rewound; conclusion: use plan B"),
    );

    // Simulated reload: still pruned, new turn present.
    const reloaded = stripPrunedMessages(store.documents[0].messages);
    expect(reloaded.map((message) => message.content)).toEqual([
      "hello",
      "hi",
      "rewind please",
      "rewound; conclusion: use plan B",
    ]);
  });

  it("rewinds to a NAMED checkpoint and drops later checkpoints that point into pruned territory", async () => {
    await recordCheckpoint({ ...SCOPE, name: "late" }); // at index 6

    const result = await rewindToCheckpoint({
      ...SCOPE,
      checkpointName: "anchor",
    });
    expect(result).toMatchObject({ checkpoint: { name: "anchor" } });

    const remaining = await getCheckpoints(SCOPE);
    expect(remaining.map((checkpoint) => checkpoint.name)).toEqual(["anchor"]);
  });

  it("defaults to the most recently recorded checkpoint", async () => {
    await recordCheckpoint({ ...SCOPE, name: "late" }); // at index 6
    store.documents[0].messages.push(...turn("post-late", "post-late reply"));

    const result = await rewindToCheckpoint({ ...SCOPE });
    expect(result).toMatchObject({
      checkpoint: { name: "late" },
      prunedCount: 2,
      remainingCount: 6,
    });
  });

  it("errors on unknown checkpoint names and on conversations without checkpoints", async () => {
    const unknown = await rewindToCheckpoint({
      ...SCOPE,
      checkpointName: "ghost",
    });
    expect(unknown).toHaveProperty("error");
    expect((unknown as { error: string }).error).toContain("anchor");

    seedConversation([...turn("hello", "hi")]);
    const none = await rewindToCheckpoint({ ...SCOPE });
    expect(none).toHaveProperty("error");
  });

  it("is idempotent — a second rewind to the same checkpoint prunes nothing new", async () => {
    await rewindToCheckpoint({ ...SCOPE });
    const second = await rewindToCheckpoint({ ...SCOPE });
    expect(second).toMatchObject({ prunedCount: 0, remainingCount: 2 });
  });
});

describe("compaction-summary interaction rule", () => {
  // Documented in checkpoints.ts: rewind drops any compaction summary
  // covering pruned messages. A summary always sits AFTER everything it
  // covers, so the index-based boundary enforces the rule structurally.
  it("prunes a summary sitting after the boundary, keeps one before it", async () => {
    seedConversation([
      ...turn("old", "old reply"),
      {
        role: "user",
        content: "[Conversation Summary — early]",
        isCompactSummary: true,
      },
    ]);
    await recordCheckpoint({ ...SCOPE, name: "anchor" }); // index 3
    store.documents[0].messages.push(...turn("explore", "dead end"), {
      role: "user",
      content: "[Conversation Summary — covers the detour]",
      isCompactSummary: true,
    });

    await rewindToCheckpoint({ ...SCOPE });

    const loaded = stripPrunedMessages(store.documents[0].messages);
    expect(loaded.map((message) => message.content)).toEqual([
      "old",
      "old reply",
      "[Conversation Summary — early]",
    ]);
  });
});

describe("stripPrunedMessages", () => {
  it("filters only pruned === true", () => {
    const messages = [
      { role: "user", content: "keep" },
      { role: "assistant", content: "drop", pruned: true },
      { role: "user", content: "keep too", pruned: false },
    ];
    expect(
      stripPrunedMessages(messages).map((message) => message.content),
    ).toEqual(["keep", "keep too"]);
  });
});

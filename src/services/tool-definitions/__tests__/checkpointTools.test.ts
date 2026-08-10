import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// checkpoint / rewind internal tools — registry wiring, tier-AUTO
// safety, and end-to-end execution against the real checkpoints
// service over an in-memory Mongo double.
// ────────────────────────────────────────────────────────────

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("#src/services/AgentPersonaRegistry", () => ({
  default: {
    isAgentProject: (project: string) => project === "agent-project",
    // getSchemas() walks EVERY registered tool; DiscoverAndEnableTools'
    // buildSchema consults the persona registry for agent names.
    list: () => [],
    get: () => null,
    has: () => false,
  },
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
  collections: new Map<string, FakeDocument[]>(),
}));

function matches(document: FakeDocument, filter: Record<string, unknown>) {
  return Object.entries(filter).every(
    ([key, value]) => document[key] === value,
  );
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: (_databaseName: string, collectionName: string) => {
      if (!store.collections.has(collectionName)) {
        store.collections.set(collectionName, []);
      }
      const rows = store.collections.get(collectionName)!;
      return {
        findOne: async (filter: Record<string, unknown>) => {
          const found = rows.find((document) => matches(document, filter));
          return found ? structuredClone(found) : null;
        },
        updateOne: async (
          filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown> },
        ) => {
          const found = rows.find((document) => matches(document, filter));
          if (!found) return { matchedCount: 0 };
          if (update.$set) Object.assign(found, structuredClone(update.$set));
          return { matchedCount: 1 };
        },
      };
    },
  },
}));

const { default: InternalToolRegistry } =
  await import("#src/services/tool-definitions/InternalToolRegistry");
const { default: AutoApprovalEngine, APPROVAL_TIERS } =
  await import("#src/services/AutoApprovalEngine");
const { COLLECTIONS } = await import("#src/constants");

const CONTEXT = {
  conversationId: "conversation-1",
  agentConversationId: "loop-1",
  project: "test-project",
  username: "test-user",
};

function seed(collection: string, messages: Array<Record<string, unknown>>) {
  store.collections.set(collection, [
    {
      id: CONTEXT.conversationId,
      project: CONTEXT.project,
      username: CONTEXT.username,
      messages,
    },
  ]);
}

beforeEach(() => {
  store.collections.clear();
});

describe("registry wiring", () => {
  it("registers checkpoint and rewind as internal tools", () => {
    expect(InternalToolRegistry.has("checkpoint")).toBe(true);
    expect(InternalToolRegistry.has("rewind")).toBe(true);
  });

  it("serves localized schemas for both locales without missing keys", () => {
    for (const locale of ["en", "caveman"]) {
      const schemas = InternalToolRegistry.getSchemas(locale);
      for (const name of ["checkpoint", "rewind"]) {
        const schema = schemas.find((entry) => entry.name === name);
        expect(schema, `${name} schema for ${locale}`).toBeDefined();
        expect(schema!.description).not.toContain("[MISSING:");
      }
    }
  });
});

describe("tier-AUTO safety", () => {
  it("checkpoint and rewind auto-approve without full-auto mode", () => {
    const engine = new AutoApprovalEngine({ fullAuto: false });
    for (const name of ["checkpoint", "rewind"]) {
      expect(engine.getTier(name)).toBe(APPROVAL_TIERS.AUTO);
      const verdict = engine.check({ name, args: {} } as never);
      expect(verdict.isApproved).toBe(true);
    }
  });
});

describe("checkpoint tool", () => {
  it("persists a marker on the conversation document", async () => {
    seed(COLLECTIONS.MODEL_CONVERSATIONS, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);

    const result = (await InternalToolRegistry.execute(
      "checkpoint",
      { name: "before-spike" },
      CONTEXT,
    )) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.checkpoint).toMatchObject({
      name: "before-spike",
      messageIndex: 2,
    });

    const persisted = store.collections.get(
      COLLECTIONS.MODEL_CONVERSATIONS,
    )![0];
    expect(persisted.checkpoints).toHaveLength(1);
  });

  it("uses the agent conversations collection for agent contexts", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, [{ role: "user", content: "q" }]);

    const result = (await InternalToolRegistry.execute(
      "checkpoint",
      {},
      { ...CONTEXT, agent: "OMNI" },
    )) as Record<string, unknown>;

    expect(result.success).toBe(true);
    const persisted = store.collections.get(
      COLLECTIONS.AGENT_CONVERSATIONS,
    )![0];
    expect(persisted.checkpoints).toHaveLength(1);
  });

  it("errors without a conversation in context", async () => {
    const result = (await InternalToolRegistry.execute(
      "checkpoint",
      {},
      { project: "p", username: "u" },
    )) as Record<string, unknown>;
    expect(result.error).toBeTruthy();
  });
});

describe("rewind tool", () => {
  it("prunes messages after the checkpoint and reports counts", async () => {
    seed(COLLECTIONS.MODEL_CONVERSATIONS, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    await InternalToolRegistry.execute(
      "checkpoint",
      { name: "anchor" },
      CONTEXT,
    );

    const rows = store.collections.get(COLLECTIONS.MODEL_CONVERSATIONS)!;
    rows[0].messages.push(
      { role: "user", content: "explore" },
      { role: "assistant", content: "dead end" },
    );

    const result = (await InternalToolRegistry.execute(
      "rewind",
      {},
      CONTEXT,
    )) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.prunedCount).toBe(2);
    expect(result.remainingCount).toBe(2);

    // Messages survive in the document, flagged — never destroyed.
    expect(rows[0].messages).toHaveLength(4);
    expect(rows[0].messages.filter((message) => message.pruned)).toHaveLength(
      2,
    );
  });

  it("errors when the named checkpoint does not exist", async () => {
    seed(COLLECTIONS.MODEL_CONVERSATIONS, [{ role: "user", content: "q" }]);
    await InternalToolRegistry.execute(
      "checkpoint",
      { name: "anchor" },
      CONTEXT,
    );

    const result = (await InternalToolRegistry.execute(
      "rewind",
      { checkpoint: "ghost" },
      CONTEXT,
    )) as Record<string, unknown>;
    expect(result.error).toContain("anchor");
  });
});

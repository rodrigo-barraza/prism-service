import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// set_goal / update_goal / clear_goal — registry wiring, scope
// refusals (no conversation id, sub-agent), the goal_update emit
// shape, and end-to-end execution against the real goal service
// over an in-memory Mongo double.
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
    list: () => [],
    get: () => null,
    has: () => false,
  },
}));

interface FakeDocument {
  id: string;
  project: string;
  username: string;
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

function fakeCollection(collectionName: string) {
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
      update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
    ) => {
      const found = rows.find((document) => matches(document, filter));
      if (!found) return { matchedCount: 0 };
      if (update.$set) Object.assign(found, structuredClone(update.$set));
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete found[key];
      return { matchedCount: 1 };
    },
  };
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () => ({ collection: fakeCollection }),
    getCollection: (_databaseName: string, collectionName: string) =>
      fakeCollection(collectionName),
  },
}));

const { default: InternalToolRegistry } =
  await import("#src/services/tool-definitions/InternalToolRegistry");
const { GOAL_TOOL_NAMES } =
  await import("#src/services/tool-definitions/GoalTools");
const { COLLECTIONS } = await import("#src/constants");

const CONTEXT = {
  conversationId: "conversation-1",
  agentConversationId: "loop-1",
  project: "test-project",
  username: "test-user",
};

const TOOL_NAMES = Object.values(GOAL_TOOL_NAMES);

function seed() {
  store.collections.set(COLLECTIONS.AGENT_CONVERSATIONS, [
    {
      id: CONTEXT.conversationId,
      project: CONTEXT.project,
      username: CONTEXT.username,
      messages: [],
    },
  ]);
}

function stored() {
  return store.collections.get(COLLECTIONS.AGENT_CONVERSATIONS)![0] as FakeDocument & {
    goal?: Record<string, unknown>;
  };
}

async function run(name: string, args: Record<string, unknown>, context: Record<string, unknown> = CONTEXT) {
  return (await InternalToolRegistry.execute(name, args, context)) as Record<string, unknown>;
}

beforeEach(() => {
  store.collections.clear();
});

describe("registry wiring", () => {
  it("registers set_goal, update_goal and clear_goal as internal tools", () => {
    for (const name of TOOL_NAMES) {
      expect(InternalToolRegistry.has(name), name).toBe(true);
    }
  });

  it("serves schemas for both locales without missing keys", () => {
    for (const locale of ["en", "caveman"]) {
      const schemas = InternalToolRegistry.getSchemas(locale);
      for (const name of TOOL_NAMES) {
        const schema = schemas.find((entry) => entry.name === name);
        expect(schema, `${name} schema for ${locale}`).toBeDefined();
        expect(schema!.description).not.toContain("[MISSING:");
      }
    }
  });

  it("update_goal never offers 'paused' to the model", () => {
    const schema = InternalToolRegistry.getSchemas("en").find(
      (entry) => entry.name === GOAL_TOOL_NAMES.UPDATE_GOAL,
    )!;
    const status = (schema.parameters as { properties: Record<string, { enum?: string[] }> })
      .properties.status;
    expect(status.enum).toEqual(["active", "completed", "blocked"]);
  });
});

describe("scope refusals", () => {
  it("refuses every goal tool without a conversation id", async () => {
    seed();
    for (const name of TOOL_NAMES) {
      const result = await run(name, { objective: "x", progress: "y" }, {
        project: CONTEXT.project,
        username: CONTEXT.username,
      });
      expect(result.success, name).toBe(false);
      expect(String(result.error)).toMatch(/conversation id/);
    }
    expect(stored().goal).toBeUndefined();
  });

  it("refuses set_goal and clear_goal from a sub-agent but lets it report progress", async () => {
    seed();
    const subAgent = { ...CONTEXT, isSubAgent: true };
    const set = await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "x" }, subAgent);
    expect(set.success).toBe(false);
    expect(String(set.error)).toMatch(/read-only/);
    const clear = await run(GOAL_TOOL_NAMES.CLEAR_GOAL, {}, subAgent);
    expect(clear.success).toBe(false);
    expect(stored().goal).toBeUndefined();

    await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "Parent goal" });
    const child = {
      conversationId: "child-doc",
      agentConversationId: "child-loop",
      parentAgentConversationId: CONTEXT.conversationId,
      _recursionDepth: 1,
      project: CONTEXT.project,
      username: CONTEXT.username,
    };
    const update = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { progress: "worker done" }, child);
    expect(update.success).toBe(true);
    expect(stored().goal).toMatchObject({ progress: { summary: "worker done" } });
    const childSet = await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "hijack" }, child);
    expect(childSet.success).toBe(false);
  });

  it("reports a missing conversation instead of throwing", async () => {
    const result = await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "x" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found/);
  });
});

describe("set_goal", () => {
  it("persists an active goal with its budget and emits goal_update change=set", async () => {
    seed();
    const emit = vi.fn();
    const result = await run(
      GOAL_TOOL_NAMES.SET_GOAL,
      {
        objective: "Ship it",
        completionCriteria: "CI green",
        maxCostDollars: 3,
        maxTurns: 12,
        deadline: "2030-01-01T00:00:00Z",
      },
      { ...CONTEXT, _emit: emit },
    );

    expect(result.success).toBe(true);
    expect(result.goal).toMatchObject({
      objective: "Ship it",
      completionCriteria: "CI green",
      status: "active",
      budget: { maxCostDollars: 3, maxTurns: 12, deadline: "2030-01-01T00:00:00.000Z" },
      progress: { summary: "Not started", percent: 0 },
    });
    expect(stored().goal).toEqual(result.goal);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "goal_update",
      goal: result.goal,
      change: "set",
    });
  });

  it("rejects an empty objective", async () => {
    seed();
    const result = await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: " " });
    expect(result.success).toBe(false);
    expect(stored().goal).toBeUndefined();
  });
});

describe("update_goal", () => {
  it("needs a goal first and at least one field", async () => {
    seed();
    const noGoal = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { progress: "x" });
    expect(noGoal.success).toBe(false);
    expect(String(noGoal.error)).toMatch(/set_goal/);

    await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "Ship it" });
    const empty = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, {});
    expect(empty.success).toBe(false);
  });

  it("refuses to pause — only the user can", async () => {
    seed();
    await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "Ship it" });
    const result = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { status: "paused" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/user/);
    expect(stored().goal!.status).toBe("active");
  });

  it("reports progress, blocks on an obstacle, unblocks, and completes — emitting only meaningful changes", async () => {
    seed();
    const emit = vi.fn();
    const context = { ...CONTEXT, _emit: emit };
    await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "Ship it" }, context);
    emit.mockClear();

    const progress = await run(
      GOAL_TOOL_NAMES.UPDATE_GOAL,
      { progress: "Halfway", percent: 50 },
      context,
    );
    expect(progress.success).toBe(true);
    expect(emit).toHaveBeenLastCalledWith({
      type: "goal_update",
      goal: progress.goal,
      change: "progress",
    });

    emit.mockClear();
    await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { percent: 53 }, context);
    expect(emit).not.toHaveBeenCalled();

    const blocked = await run(
      GOAL_TOOL_NAMES.UPDATE_GOAL,
      { blockedOn: "need API key" },
      context,
    );
    expect(blocked.goal).toMatchObject({ status: "blocked", blockedOn: "need API key" });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ change: "status" }));

    const unblocked = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { blockedOn: "" }, context);
    expect(unblocked.goal).toMatchObject({ status: "active", blockedOn: null });

    const completed = await run(
      GOAL_TOOL_NAMES.UPDATE_GOAL,
      { status: "completed", progress: "Shipped" },
      context,
    );
    expect(completed.goal).toMatchObject({
      status: "completed",
      progress: { summary: "Shipped", percent: 100 },
    });
    expect(stored().goal!.status).toBe("completed");
  });
});

describe("clear_goal", () => {
  it("removes the goal and emits change=cleared with the last snapshot", async () => {
    seed();
    const emit = vi.fn();
    const context = { ...CONTEXT, _emit: emit };
    const set = await run(GOAL_TOOL_NAMES.SET_GOAL, { objective: "Ship it" }, context);
    emit.mockClear();

    const result = await run(GOAL_TOOL_NAMES.CLEAR_GOAL, {}, context);
    expect(result).toEqual({ success: true, cleared: true });
    expect(stored().goal).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({
      type: "goal_update",
      goal: set.goal,
      change: "cleared",
    });

    const again = await run(GOAL_TOOL_NAMES.CLEAR_GOAL, {}, context);
    expect(again).toEqual({ success: true, cleared: false });
  });
});

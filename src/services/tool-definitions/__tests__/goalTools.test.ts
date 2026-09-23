import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// propose_goal / update_goal / clear_goal — registry wiring, scope
// refusals (no conversation id, sub-agent), the goal_update emit
// shape, and end-to-end execution against the real goal service
// over an in-memory Mongo double. The model never activates a goal
// (proposals wait for the user) and never completes one (a claim
// waits for the verifier).
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
const { default: ConversationGoalService } = await import("#src/services/ConversationGoalService");

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
    goalProposal?: Record<string, unknown>;
  };
}

/** The user sets the goal (PUT /conversations/:id/goal) — the model cannot. */
async function userSetsGoal(objective = "Ship it") {
  return ConversationGoalService.set(CONTEXT.conversationId, CONTEXT.project, CONTEXT.username, {
    objective,
    rubric: ["CI is green", "the release note exists"],
  });
}

async function run(name: string, args: Record<string, unknown>, context: Record<string, unknown> = CONTEXT) {
  return (await InternalToolRegistry.execute(name, args, context)) as Record<string, unknown>;
}

beforeEach(() => {
  store.collections.clear();
});

describe("registry wiring", () => {
  it("registers propose_goal, update_goal and clear_goal as internal tools — and no set_goal", () => {
    for (const name of TOOL_NAMES) {
      expect(InternalToolRegistry.has(name), name).toBe(true);
    }
    expect(TOOL_NAMES).toEqual(["propose_goal", "update_goal", "clear_goal"]);
    expect(InternalToolRegistry.has("set_goal")).toBe(false);
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

  it("update_goal never offers 'paused' to the model, and calls 'completed' a claim", () => {
    const schema = InternalToolRegistry.getSchemas("en").find(
      (entry) => entry.name === GOAL_TOOL_NAMES.UPDATE_GOAL,
    )!;
    const status = (schema.parameters as { properties: Record<string, { enum?: string[] }> })
      .properties.status;
    expect(status.enum).toEqual(["active", "completed", "blocked"]);
    expect(schema.description).toMatch(/CLAIM/);
  });

  it("propose_goal requires a rubric", () => {
    const schema = InternalToolRegistry.getSchemas("en").find(
      (entry) => entry.name === GOAL_TOOL_NAMES.PROPOSE_GOAL,
    )!;
    expect((schema.parameters as { required: string[] }).required).toEqual(["objective", "rubric"]);
  });
});

describe("scope refusals", () => {
  it("refuses every goal tool without a conversation id", async () => {
    seed();
    for (const name of TOOL_NAMES) {
      const result = await run(name, { objective: "x", rubric: ["y"], progress: "y" }, {
        project: CONTEXT.project,
        username: CONTEXT.username,
      });
      expect(result.success, name).toBe(false);
      expect(String(result.error)).toMatch(/conversation id/);
    }
    expect(stored().goal).toBeUndefined();
    expect(stored().goalProposal).toBeUndefined();
  });

  it("refuses propose_goal and clear_goal from a sub-agent but lets it report progress", async () => {
    seed();
    const subAgent = { ...CONTEXT, isSubAgent: true };
    const proposed = await run(GOAL_TOOL_NAMES.PROPOSE_GOAL, { objective: "x", rubric: ["y"] }, subAgent);
    expect(proposed.success).toBe(false);
    expect(String(proposed.error)).toMatch(/read-only/);
    const clear = await run(GOAL_TOOL_NAMES.CLEAR_GOAL, {}, subAgent);
    expect(clear.success).toBe(false);
    expect(stored().goalProposal).toBeUndefined();

    await userSetsGoal("Parent goal");
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
    const childProposal = await run(GOAL_TOOL_NAMES.PROPOSE_GOAL, { objective: "hijack", rubric: ["y"] }, child);
    expect(childProposal.success).toBe(false);
  });

  it("reports a missing conversation instead of throwing", async () => {
    const result = await run(GOAL_TOOL_NAMES.PROPOSE_GOAL, { objective: "x", rubric: ["y"] });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/not found/);
  });
});

describe("propose_goal", () => {
  it("stores a proposal — never the goal — and emits goal_update change=proposed", async () => {
    seed();
    const emit = vi.fn();
    const result = await run(
      GOAL_TOOL_NAMES.PROPOSE_GOAL,
      {
        objective: "Ship it",
        rubric: ["CI is green", "the release note exists"],
        stepRubric: ["no failing command is left unaddressed"],
        maxCostDollars: 3,
        maxTurns: 12,
        maxIterations: 4,
        deadline: "2030-01-01T00:00:00Z",
      },
      { ...CONTEXT, _emit: emit },
    );

    expect(result.success).toBe(true);
    expect(result.proposal).toMatchObject({
      objective: "Ship it",
      status: "proposed",
      rubric: [
        { id: "c1", criterion: "CI is green" },
        { id: "c2", criterion: "the release note exists" },
      ],
      stepRubric: [{ id: "c1", criterion: "no failing command is left unaddressed" }],
      maxIterations: 4,
      budget: { maxCostDollars: 3, maxTurns: 12, deadline: "2030-01-01T00:00:00.000Z" },
    });
    // Inactive until the user approves it.
    expect(stored().goal).toBeUndefined();
    expect(stored().goalProposal).toEqual(result.proposal);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "goal_update",
      goal: result.proposal,
      change: "proposed",
    });
  });

  it("leaves the current goal untouched", async () => {
    seed();
    const current = await userSetsGoal("Current goal");
    await run(GOAL_TOOL_NAMES.PROPOSE_GOAL, { objective: "Another goal", rubric: ["x"] });
    expect(stored().goal).toEqual(current);
    expect(stored().goalProposal).toMatchObject({ objective: "Another goal", status: "proposed" });
  });

  it("rejects an empty objective and a missing rubric", async () => {
    seed();
    expect((await run(GOAL_TOOL_NAMES.PROPOSE_GOAL, { objective: " ", rubric: ["x"] })).success).toBe(false);
    const noRubric = await run(GOAL_TOOL_NAMES.PROPOSE_GOAL, { objective: "Ship it" });
    expect(noRubric.success).toBe(false);
    expect(String(noRubric.error)).toMatch(/rubric/);
    expect(stored().goalProposal).toBeUndefined();
  });
});

describe("update_goal", () => {
  it("needs a goal first and at least one field", async () => {
    seed();
    const noGoal = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { progress: "x" });
    expect(noGoal.success).toBe(false);
    expect(String(noGoal.error)).toMatch(/propose_goal/);

    await userSetsGoal();
    const empty = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, {});
    expect(empty.success).toBe(false);
  });

  it("refuses to pause — only the user can", async () => {
    seed();
    await userSetsGoal();
    const result = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { status: "paused" });
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/user/);
    expect(stored().goal!.status).toBe("active");
  });

  it("reports progress, blocks on an obstacle, unblocks — emitting only meaningful changes", async () => {
    seed();
    const emit = vi.fn();
    const context = { ...CONTEXT, _emit: emit };
    await userSetsGoal();

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
  });

  it("status completed is a claim: the goal stays active until the verifier confirms it", async () => {
    seed();
    await userSetsGoal();
    const claim = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { status: "completed", progress: "Shipped" });
    expect(claim.success).toBe(true);
    expect(claim.verification).toBe("pending");
    expect(String(claim.note)).toMatch(/NOT completed/);
    expect(claim.goal).toMatchObject({ status: "active", progress: { summary: "Shipped" } });
    expect(stored().goal!.status).toBe("active");

    // A bare claim (no other field) is accepted too.
    const bare = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { status: "completed" });
    expect(bare.success).toBe(true);
    expect(stored().goal!.status).toBe("active");
  });

  it("a claim on a blocked goal re-activates it for the verifier; a paused goal refuses it", async () => {
    seed();
    await userSetsGoal();
    await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { blockedOn: "need API key" });
    const claim = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { status: "completed" });
    expect(claim.goal).toMatchObject({ status: "active", blockedOn: null });

    await ConversationGoalService.update(CONTEXT.conversationId, CONTEXT.project, CONTEXT.username, {
      status: "paused",
    });
    const paused = await run(GOAL_TOOL_NAMES.UPDATE_GOAL, { status: "completed" });
    expect(paused.success).toBe(false);
    expect(String(paused.error)).toMatch(/paused \(user\)/);
    expect(stored().goal!.status).toBe("paused");
  });
});

describe("clear_goal", () => {
  it("removes the goal and emits change=cleared with the last snapshot", async () => {
    seed();
    const emit = vi.fn();
    const context = { ...CONTEXT, _emit: emit };
    const goal = await userSetsGoal();

    const result = await run(GOAL_TOOL_NAMES.CLEAR_GOAL, {}, context);
    expect(result).toEqual({ success: true, cleared: true });
    expect(stored().goal).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({
      type: "goal_update",
      goal,
      change: "cleared",
    });

    const again = await run(GOAL_TOOL_NAMES.CLEAR_GOAL, {}, context);
    expect(again).toEqual({ success: true, cleared: false });
  });
});

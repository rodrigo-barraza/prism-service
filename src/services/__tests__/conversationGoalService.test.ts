import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// ConversationGoalService — CRUD over an in-memory Mongo double,
// meaningful-change detection, budget exhaustion, the afterResponse
// accounting hook and the prompt rendering.
// ────────────────────────────────────────────────────────────

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

type FakeDocument = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  collections: new Map<string, Array<Record<string, unknown> & { id: string }>>(),
  unavailable: false,
  failFindOne: false,
}));

function matches(document: FakeDocument, filter: Record<string, unknown>) {
  return Object.entries(filter).every(
    ([key, value]) => document[key] === value,
  );
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () =>
      store.unavailable
        ? null
        : {
            collection: (collectionName: string) => {
              if (!store.collections.has(collectionName)) {
                store.collections.set(collectionName, []);
              }
              const rows = store.collections.get(collectionName)!;
              return {
                // Only the boot sweep's query shape: a dotted path with $type.
                find: (filter: Record<string, { $type?: string }>) => ({
                  toArray: async () =>
                    rows
                      .filter((document) =>
                        Object.entries(filter).every(([path, condition]) => {
                          const value = path
                            .split(".")
                            .reduce<unknown>(
                              (node, key) => (node as Record<string, unknown> | undefined)?.[key],
                              document,
                            );
                          return typeof value === condition.$type;
                        }),
                      )
                      .map((document) => structuredClone(document)),
                }),
                findOne: async (filter: Record<string, unknown>) => {
                  if (store.failFindOne) throw new Error("boom");
                  const found = rows.find((document) => matches(document, filter));
                  return found ? structuredClone(found) : null;
                },
                updateOne: async (
                  filter: Record<string, unknown>,
                  update: {
                    $set?: Record<string, unknown>;
                    $unset?: Record<string, unknown>;
                  },
                ) => {
                  const found = rows.find((document) => matches(document, filter));
                  if (!found) return { matchedCount: 0 };
                  if (update.$set) Object.assign(found, structuredClone(update.$set));
                  if (update.$unset) {
                    for (const key of Object.keys(update.$unset)) delete found[key];
                  }
                  return { matchedCount: 1 };
                },
              };
            },
          },
  },
}));

const {
  default: ConversationGoalService,
  ConversationNotFoundError,
  GOAL_UPDATE_EVENT_TYPE,
  NOT_STARTED_SUMMARY,
  applyGoalPatch,
  describeBudgetExhaustion,
  detectMeaningfulChange,
  effectiveRubric,
  formatGoalForPrompt,
  normalizeBudget,
  normalizeRubric,
  resolveGoalConversationId,
} = await import("#src/services/ConversationGoalService");
type GoalVerification = import("#src/services/ConversationGoalService").GoalVerification;
type ConversationGoal = import("#src/services/ConversationGoalService").ConversationGoal;
const { COLLECTIONS } = await import("#src/constants");

const SCOPE = { id: "conv-1", project: "proj", username: "user" } as const;
const ARGS = [SCOPE.id, SCOPE.project, SCOPE.username] as const;

function seed(
  collection: string = COLLECTIONS.AGENT_CONVERSATIONS,
  extra: Record<string, unknown> = {},
) {
  store.collections.set(collection, [{ ...SCOPE, messages: [], ...extra }]);
}

function stored(collection: string = COLLECTIONS.AGENT_CONVERSATIONS) {
  return store.collections.get(collection)![0] as FakeDocument & {
    goal?: ConversationGoal;
    goalProposal?: ConversationGoal;
  };
}

function baseGoal(overrides: Partial<ConversationGoal> = {}): ConversationGoal {
  const now = "2026-09-15T10:00:00.000Z";
  return {
    objective: "Ship the widget",
    progress: { summary: NOT_STARTED_SUMMARY, percent: 0, updatedAt: now },
    blockedOn: null,
    status: "active",
    spentDollars: 0,
    turnsUsed: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  store.collections.clear();
  store.unavailable = false;
  store.failFindOne = false;
});

describe("get / set / clear", () => {
  it("returns null when the conversation or its goal is missing", async () => {
    expect(await ConversationGoalService.get(...ARGS)).toBeNull();
    seed();
    expect(await ConversationGoalService.get(...ARGS)).toBeNull();
  });

  it("returns null when the database is unavailable", async () => {
    store.unavailable = true;
    expect(await ConversationGoalService.get(...ARGS)).toBeNull();
  });

  it("set creates an active goal at 'Not started', persists it and emits change=set", async () => {
    seed();
    const emit = vi.fn();
    const goal = await ConversationGoalService.set(
      ...ARGS,
      {
        objective: "  Ship the widget ",
        completionCriteria: "tests green",
        budget: { maxCostDollars: 2, maxTurns: 10 },
      },
      { emit },
    );

    expect(goal).toMatchObject({
      objective: "Ship the widget",
      completionCriteria: "tests green",
      budget: { maxCostDollars: 2, maxTurns: 10 },
      status: "active",
      blockedOn: null,
      spentDollars: 0,
      turnsUsed: 0,
      progress: { summary: NOT_STARTED_SUMMARY, percent: 0 },
    });
    expect(stored().goal).toEqual(goal);
    expect(await ConversationGoalService.get(...ARGS)).toEqual(goal);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: GOAL_UPDATE_EVENT_TYPE,
      goal,
      change: "set",
    });
  });

  it("set replaces an existing goal from scratch", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ spentDollars: 1.5, turnsUsed: 4, status: "blocked" }),
    });
    const goal = await ConversationGoalService.set(...ARGS, {
      objective: "Something else",
    });
    expect(goal.spentDollars).toBe(0);
    expect(goal.turnsUsed).toBe(0);
    expect(goal.status).toBe("active");
    expect(goal.budget).toBeUndefined();
  });

  it("set rejects an empty objective and a missing conversation", async () => {
    seed();
    await expect(
      ConversationGoalService.set(...ARGS, { objective: "   " }),
    ).rejects.toThrow("objective");
    await expect(
      ConversationGoalService.set("nope", SCOPE.project, SCOPE.username, {
        objective: "x",
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("set drops invalid budget parts and normalises the deadline to ISO", async () => {
    seed();
    const goal = await ConversationGoalService.set(...ARGS, {
      objective: "x",
      budget: {
        maxCostDollars: -1,
        maxTurns: 2.5,
        deadline: "2026-09-16T12:00:00Z",
      },
    });
    expect(goal.budget).toEqual({ deadline: "2026-09-16T12:00:00.000Z" });
    expect(normalizeBudget({ maxCostDollars: 0, deadline: "garbage" })).toBeUndefined();
    expect(normalizeBudget(null)).toBeUndefined();
  });

  it("falls back to the direct-conversation collection", async () => {
    seed(COLLECTIONS.MODEL_CONVERSATIONS);
    const goal = await ConversationGoalService.set(...ARGS, { objective: "x" });
    expect(stored(COLLECTIONS.MODEL_CONVERSATIONS).goal).toEqual(goal);
    expect(await ConversationGoalService.get(...ARGS)).toEqual(goal);
  });

  it("clear removes the goal, emits change=cleared with the last snapshot, and is false when none", async () => {
    seed();
    const emit = vi.fn();
    expect(await ConversationGoalService.clear(...ARGS, { emit })).toBe(false);
    expect(emit).not.toHaveBeenCalled();

    const goal = await ConversationGoalService.set(...ARGS, { objective: "x" });
    expect(await ConversationGoalService.clear(...ARGS, { emit })).toBe(true);
    expect(stored().goal).toBeUndefined();
    expect(emit).toHaveBeenCalledWith({
      type: GOAL_UPDATE_EVENT_TYPE,
      goal,
      change: "cleared",
    });
    await expect(
      ConversationGoalService.clear("nope", SCOPE.project, SCOPE.username),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe("update", () => {
  it("returns null without a goal and throws without a conversation", async () => {
    seed();
    expect(
      await ConversationGoalService.update(...ARGS, { progressSummary: "x" }),
    ).toBeNull();
    await expect(
      ConversationGoalService.update("nope", SCOPE.project, SCOPE.username, {}),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("applies progress and percent, stamping progress.updatedAt", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal() });
    const before = stored().goal!;
    const goal = (await ConversationGoalService.update(...ARGS, {
      progressSummary: "Halfway",
      percent: 50.4,
    }))!;
    expect(goal.progress.summary).toBe("Halfway");
    expect(goal.progress.percent).toBe(50);
    expect(goal.progress.updatedAt).not.toBe(before.progress.updatedAt);
    expect(stored().goal).toEqual(goal);
  });

  it("derives status from blockedOn and clears it on resume/completion", () => {
    const active = baseGoal();
    const blocked = applyGoalPatch(active, { blockedOn: "waiting on creds" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedOn).toBe("waiting on creds");

    const unblocked = applyGoalPatch(blocked, { blockedOn: "" });
    expect(unblocked.status).toBe("active");
    expect(unblocked.blockedOn).toBeNull();

    const resumed = applyGoalPatch(blocked, { status: "active" });
    expect(resumed.blockedOn).toBeNull();

    const paused = applyGoalPatch(blocked, { status: "paused" });
    expect(paused.blockedOn).toBe("waiting on creds");

    const completed = applyGoalPatch(blocked, { status: "completed" });
    expect(completed.status).toBe("completed");
    expect(completed.blockedOn).toBeNull();
    expect(completed.progress.percent).toBe(100);

    const completedAt90 = applyGoalPatch(active, { status: "completed", percent: 90 });
    expect(completedAt90.progress.percent).toBe(90);
  });

  it("clamps percent to 0..100 and accepts null to unset it", () => {
    expect(applyGoalPatch(baseGoal(), { percent: 140 }).progress.percent).toBe(100);
    expect(applyGoalPatch(baseGoal(), { percent: -3 }).progress.percent).toBe(0);
    expect(applyGoalPatch(baseGoal(), { percent: null }).progress.percent).toBeNull();
  });

  it("replaces or drops criteria and budget through the patch", () => {
    const withBudget = applyGoalPatch(baseGoal(), {
      completionCriteria: "done when green",
      budget: { maxTurns: 3 },
    });
    expect(withBudget.completionCriteria).toBe("done when green");
    expect(withBudget.budget).toEqual({ maxTurns: 3 });
    const dropped = applyGoalPatch(withBudget, { completionCriteria: null, budget: null });
    expect(dropped.completionCriteria).toBeUndefined();
    expect(dropped.budget).toBeUndefined();
  });
});

describe("meaningful-change detection", () => {
  it("classifies each field into set / status / progress", () => {
    const goal = baseGoal({ progress: { summary: "s", percent: 41, updatedAt: "t" } });
    const mutate = (overrides: Partial<ConversationGoal>) =>
      detectMeaningfulChange(goal, { ...structuredClone(goal), ...overrides });

    expect(detectMeaningfulChange(null, goal)).toBe("set");
    expect(detectMeaningfulChange(goal, null)).toBe("cleared");
    expect(detectMeaningfulChange(null, null)).toBeNull();
    expect(mutate({ objective: "other" })).toBe("set");
    expect(mutate({ completionCriteria: "c" })).toBe("set");
    expect(mutate({ budget: { maxTurns: 1 } })).toBe("set");
    expect(mutate({ status: "paused" })).toBe("status");
    expect(mutate({ blockedOn: "x" })).toBe("status");
    expect(mutate({ progress: { summary: "moved", percent: 41, updatedAt: "t" } })).toBe("progress");
    expect(mutate({ progress: { summary: "s", percent: 43, updatedAt: "t2" } })).toBeNull();
    expect(mutate({ progress: { summary: "s", percent: 49, updatedAt: "t2" } })).toBeNull();
    expect(mutate({ progress: { summary: "s", percent: 50, updatedAt: "t2" } })).toBe("progress");
    expect(mutate({ spentDollars: 3, turnsUsed: 9, updatedAt: "later" })).toBeNull();
  });

  it("update persists a 41→43 tick but does not emit; a 49→51 step emits progress", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ progress: { summary: "s", percent: 41, updatedAt: "t" } }),
    });
    const emit = vi.fn();

    await ConversationGoalService.update(...ARGS, { percent: 43 }, { emit });
    expect(stored().goal!.progress.percent).toBe(43);
    expect(emit).not.toHaveBeenCalled();

    await ConversationGoalService.update(...ARGS, { percent: 49 }, { emit });
    expect(emit).not.toHaveBeenCalled();

    const goal = await ConversationGoalService.update(...ARGS, { percent: 51 }, { emit });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: GOAL_UPDATE_EVENT_TYPE,
      goal,
      change: "progress",
    });
  });

  it("update emits status for a status change and set for an objective change", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal() });
    const emit = vi.fn();
    await ConversationGoalService.update(...ARGS, { status: "paused" }, { emit });
    expect(emit.mock.calls[0][0].change).toBe("status");
    await ConversationGoalService.update(...ARGS, { objective: "new" }, { emit });
    expect(emit.mock.calls[1][0].change).toBe("set");
  });

  it("emit failures never break the update", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal() });
    const emit = vi.fn(() => {
      throw new Error("socket gone");
    });
    const goal = await ConversationGoalService.update(...ARGS, { status: "paused" }, { emit });
    expect(goal?.status).toBe("paused");
  });
});

describe("recordTurn and budget exhaustion", () => {
  it("accumulates spend and turns without emitting when nothing meaningful changed", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ budget: { maxCostDollars: 5, maxTurns: 10 } }),
    });
    const emit = vi.fn();
    await ConversationGoalService.recordTurn(...ARGS, { costDollars: 0.1 }, { emit });
    const goal = await ConversationGoalService.recordTurn(...ARGS, { costDollars: 0.2 }, { emit });
    expect(goal).toMatchObject({ spentDollars: 0.3, turnsUsed: 2, status: "active" });
    expect(stored().goal!.spentDollars).toBe(0.3);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores negative / non-finite cost and is a no-op without a goal", async () => {
    seed();
    expect(await ConversationGoalService.recordTurn(...ARGS, { costDollars: 1 })).toBeNull();
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal() });
    const goal = await ConversationGoalService.recordTurn(...ARGS, { costDollars: Number.NaN });
    expect(goal).toMatchObject({ spentDollars: 0, turnsUsed: 1 });
  });

  it("pauses the goal (reason budget) when the dollar budget is spent and emits change=status", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ budget: { maxCostDollars: 0.5 }, spentDollars: 0.45 }),
    });
    const emit = vi.fn();
    const goal = (await ConversationGoalService.recordTurn(
      ...ARGS,
      { costDollars: 0.1 },
      { emit },
    ))!;
    expect(goal.status).toBe("paused");
    expect(goal.pause).toMatchObject({ reason: "budget" });
    expect(goal.pause!.detail).toMatch(/^budget exhausted: \$0\.5500 spent of \$0\.5 allowed$/);
    expect(goal.blockedOn).toBeNull();
    expect(emit).toHaveBeenCalledWith({
      type: GOAL_UPDATE_EVENT_TYPE,
      goal,
      change: "status",
    });

    // A second exhausted turn does not re-emit — the pause is already recorded.
    emit.mockClear();
    await ConversationGoalService.recordTurn(...ARGS, { costDollars: 0.01 }, { emit });
    expect(emit).not.toHaveBeenCalled();
  });

  it("pauses on the turn budget and on a passed deadline", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ budget: { maxTurns: 2 }, turnsUsed: 1 }),
    });
    const byTurns = (await ConversationGoalService.recordTurn(...ARGS))!;
    expect(byTurns.status).toBe("paused");
    expect(byTurns.pause).toMatchObject({ reason: "budget", detail: "budget exhausted: 2 of 2 turns used" });

    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ budget: { deadline: "2000-01-01T00:00:00.000Z" } }),
    });
    const byDeadline = (await ConversationGoalService.recordTurn(...ARGS))!;
    expect(byDeadline.status).toBe("paused");
    expect(byDeadline.pause!.detail).toBe(
      "budget exhausted: deadline 2000-01-01T00:00:00.000Z has passed",
    );
  });

  it("a user-paused goal over budget is re-labelled budget once, then left alone", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({
        status: "paused",
        pause: { reason: "user", at: "t" },
        budget: { maxTurns: 1 },
      }),
    });
    const first = (await ConversationGoalService.recordTurn(...ARGS))!;
    expect(first.pause).toMatchObject({ reason: "budget" });
    const second = (await ConversationGoalService.recordTurn(...ARGS))!;
    expect(second.pause!.at).toBe(first.pause!.at);
  });

  it("never blocks a completed goal", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ status: "completed", budget: { maxTurns: 1 }, turnsUsed: 5 }),
    });
    const goal = (await ConversationGoalService.recordTurn(...ARGS, { costDollars: 1 }))!;
    expect(goal.status).toBe("completed");
    expect(goal.turnsUsed).toBe(6);
  });

  it("describeBudgetExhaustion is null while inside every budget line", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(describeBudgetExhaustion(baseGoal(), now)).toBeNull();
    expect(
      describeBudgetExhaustion(
        baseGoal({
          budget: { maxCostDollars: 1, maxTurns: 3, deadline: "2026-09-16T00:00:00Z" },
          spentDollars: 0.5,
          turnsUsed: 2,
        }),
        now,
      ),
    ).toBeNull();
  });
});

describe("afterResponse hook", () => {
  const hook = ConversationGoalService.createHook();

  it("records the persisted final assistant message's estimatedCost as the turn's spend", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal(),
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "…", estimatedCost: 0.02 },
        { role: "tool", content: "r" },
        { role: "assistant", content: "done", estimatedCost: 0.0375 },
      ],
    });
    const emit = vi.fn();
    await hook({
      conversationId: SCOPE.id,
      agentConversationId: "loop-random",
      project: SCOPE.project,
      username: SCOPE.username,
      emit,
    });
    expect(stored().goal).toMatchObject({ spentDollars: 0.0375, turnsUsed: 1 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("counts a turn with zero spend when the last message carries no cost", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal(),
      messages: [{ role: "assistant", content: "done" }],
    });
    await hook({ conversationId: SCOPE.id, project: SCOPE.project, username: SCOPE.username });
    expect(stored().goal).toMatchObject({ spentDollars: 0, turnsUsed: 1 });
  });

  it("emits the budget pause through the context emit", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal({ budget: { maxTurns: 1 } }),
      messages: [{ role: "assistant", content: "done", estimatedCost: 0.01 }],
    });
    const emit = vi.fn();
    await hook({ conversationId: SCOPE.id, project: SCOPE.project, username: SCOPE.username, emit });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: GOAL_UPDATE_EVENT_TYPE,
      change: "status",
      goal: { status: "paused", pause: { reason: "budget" }, turnsUsed: 1 },
    });
  });

  it("books a goal run's whole spend (main loop, sub-agents, verifier) over the message's cost", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, {
      goal: baseGoal(),
      messages: [{ role: "assistant", content: "done", estimatedCost: 0.01 }],
    });
    const bookTurnSpend = vi.fn().mockReturnValue(0.42);
    await hook({
      conversationId: SCOPE.id,
      project: SCOPE.project,
      username: SCOPE.username,
      options: { _goalRun: { bookTurnSpend } },
    });
    expect(bookTurnSpend).toHaveBeenCalledTimes(1);
    expect(stored().goal).toMatchObject({ spentDollars: 0.42, turnsUsed: 1 });
  });

  it("skips sub-agents, contexts without ids, and conversations without a goal", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal(), messages: [] });
    await hook({
      conversationId: "child",
      parentAgentConversationId: SCOPE.id,
      project: SCOPE.project,
      username: SCOPE.username,
    });
    expect(stored().goal!.turnsUsed).toBe(0);

    await hook({ project: SCOPE.project, username: SCOPE.username });
    expect(stored().goal!.turnsUsed).toBe(0);

    seed();
    await hook({ conversationId: SCOPE.id, project: SCOPE.project, username: SCOPE.username });
    expect(stored().goal).toBeUndefined();
  });

  it("swallows database failures", async () => {
    store.failFindOne = true;
    await expect(
      hook({ conversationId: SCOPE.id, project: SCOPE.project, username: SCOPE.username }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveGoalConversationId", () => {
  it("prefers the parent for sub-agents, then the document id, then the loop id", () => {
    expect(
      resolveGoalConversationId({
        conversationId: "doc",
        agentConversationId: "loop",
        parentAgentConversationId: "parent",
      }),
    ).toBe("parent");
    expect(resolveGoalConversationId({ conversationId: "doc", agentConversationId: "loop" })).toBe("doc");
    expect(resolveGoalConversationId({ agentConversationId: "loop" })).toBe("loop");
    expect(resolveGoalConversationId({})).toBeNull();
  });
});

describe("formatGoalForPrompt", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("lists objective, criteria, status, progress, obstacle and remaining budget", () => {
    const text = formatGoalForPrompt(
      baseGoal({
        completionCriteria: "tests green",
        progress: { summary: "Halfway", percent: 50, updatedAt: "t" },
        blockedOn: "creds",
        status: "blocked",
        budget: { maxCostDollars: 2, maxTurns: 10, deadline: "2026-09-15T15:00:00.000Z" },
        spentDollars: 0.5,
        turnsUsed: 3,
      }),
      now,
    );
    expect(text).toContain("Objective: Ship the widget");
    expect(text).toContain("Completion criteria: tests green");
    expect(text).toContain("Status: blocked");
    expect(text).toContain("Progress: 50% — Halfway (updated t)");
    expect(text).toContain("Blocked on: creds");
    expect(text).toContain("$0.5000 of $2 spent ($1.5000 left)");
    expect(text).toContain("3 of 10 turns used (7 left)");
    expect(text).toContain("deadline 2026-09-15T15:00:00.000Z (in 3 h)");
    expect(text).toContain("resolve the obstacle");
  });

  it("carries the update_goal instruction for an active goal and the pause notice when paused", () => {
    expect(formatGoalForPrompt(baseGoal(), now)).toContain("update_goal");
    expect(formatGoalForPrompt(baseGoal(), now)).toContain("independent verifier");
    expect(formatGoalForPrompt(baseGoal(), now)).toContain("never your reasoning");
    expect(formatGoalForPrompt(baseGoal(), now)).toContain("$0.0000 spent · 0 turns used");
    expect(formatGoalForPrompt(baseGoal({ status: "paused" }), now)).toContain("paused");
    expect(formatGoalForPrompt(baseGoal({ status: "completed" }), now)).toContain("completed");
  });
});

// ─── Verified outcomes (prompt 21) ─────────────────────────────

describe("rubric normalization", () => {
  it("takes strings or {id, criterion}, trims, drops blanks, and keeps safe unique ids", () => {
    expect(
      normalizeRubric([
        "  report.md exists ",
        { id: "bullets", criterion: "exactly 3 bullets" },
        { id: "bullets", criterion: "a duplicate id gets a new one" },
        { id: "has spaces", criterion: "an unsafe id gets a new one" },
        "",
        { criterion: "   " },
        42,
      ]),
    ).toEqual([
      { id: "c1", criterion: "report.md exists" },
      { id: "bullets", criterion: "exactly 3 bullets" },
      { id: "c3", criterion: "a duplicate id gets a new one" },
      { id: "c4", criterion: "an unsafe id gets a new one" },
    ]);
    expect(normalizeRubric([])).toBeUndefined();
    expect(normalizeRubric("not a list")).toBeUndefined();
    expect(normalizeRubric(Array.from({ length: 30 }, (_, index) => `criterion ${index}`))).toHaveLength(20);
    expect(normalizeRubric(["x".repeat(900)])![0].criterion).toHaveLength(500);
  });

  it("the verifier checks the rubric, else the completion criteria, else the objective", () => {
    expect(effectiveRubric(baseGoal({ rubric: [{ id: "a", criterion: "A" }] }))).toEqual([{ id: "a", criterion: "A" }]);
    expect(effectiveRubric(baseGoal({ completionCriteria: "tests green" }))).toEqual([
      { id: "criteria", criterion: "tests green" },
    ]);
    expect(effectiveRubric(baseGoal())).toEqual([{ id: "objective", criterion: "Ship the widget" }]);
  });
});

describe("set, propose, approve, decline", () => {
  it("set stores rubric, step rubric, verifier and maxIterations (default 3), and drops a waiting proposal", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goalProposal: baseGoal({ status: "proposed" }) });
    const goal = await ConversationGoalService.set(...ARGS, {
      objective: "Ship it",
      rubric: ["CI green"],
      stepRubric: ["no failing command ignored"],
      verifier: { provider: "anthropic", model: "claude-sonnet-5" },
    });
    expect(goal).toMatchObject({
      status: "active",
      rubric: [{ id: "c1", criterion: "CI green" }],
      stepRubric: [{ id: "c1", criterion: "no failing command ignored" }],
      verifier: { provider: "anthropic", model: "claude-sonnet-5" },
      maxIterations: 3,
      pause: null,
      verification: null,
      verificationRounds: 0,
    });
    expect(stored().goalProposal).toBeUndefined();

    const bounded = await ConversationGoalService.set(...ARGS, { objective: "x", maxIterations: 99, verifier: { provider: "" } });
    expect(bounded.maxIterations).toBe(20);
    expect(bounded.verifier).toBeUndefined();
  });

  it("a proposal is inactive until approved; approving makes it the goal, declining drops it", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal({ objective: "Current" }) });
    const emit = vi.fn();
    const proposal = await ConversationGoalService.propose(
      ...ARGS,
      { objective: "Proposed", rubric: ["A", "B"], budget: { maxCostDollars: 2 } },
      { emit },
    );
    expect(proposal).toMatchObject({ status: "proposed", progress: { summary: "Proposed" } });
    expect(stored().goal!.objective).toBe("Current");
    expect(emit).toHaveBeenCalledWith({ type: GOAL_UPDATE_EVENT_TYPE, goal: proposal, change: "proposed" });

    const approved = await ConversationGoalService.approveProposal(...ARGS, { emit });
    expect(approved).toMatchObject({
      objective: "Proposed",
      status: "active",
      rubric: [
        { id: "c1", criterion: "A" },
        { id: "c2", criterion: "B" },
      ],
      budget: { maxCostDollars: 2 },
      spentDollars: 0,
    });
    expect(stored().goal).toEqual(approved);
    expect(stored().goalProposal).toBeUndefined();
    expect(await ConversationGoalService.approveProposal(...ARGS)).toBeNull();

    await ConversationGoalService.propose(...ARGS, { objective: "Again", rubric: ["C"] });
    emit.mockClear();
    expect(await ConversationGoalService.declineProposal(...ARGS, { emit })).toBe(true);
    expect(stored().goalProposal).toBeUndefined();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ change: "proposal_declined" }));
    expect(await ConversationGoalService.declineProposal(...ARGS)).toBe(false);
    await expect(ConversationGoalService.getState(...ARGS)).resolves.toEqual({ goal: approved, proposal: null });
  });
});

describe("pause and resume", () => {
  const verification: GoalVerification = {
    verdict: "needs_revision",
    criteria: [{ id: "c1", pass: false, evidence: "missing" }],
    iteration: 2,
    verifier: { provider: "anthropic", model: "claude-sonnet-5" },
    costDollars: 0.05,
    at: "2026-09-22T10:00:00.000Z",
  };

  it("a pause records its reason (the user's by default); resuming forgets it and restarts the verifier's rounds", () => {
    const active = baseGoal({ verificationRounds: 3, continuingSince: "t" });
    const paused = applyGoalPatch(active, { status: "paused" }, "now");
    expect(paused.pause).toEqual({ reason: "user", at: "now" });
    expect(paused.continuingSince).toBeNull();
    const budget = applyGoalPatch(active, { status: "paused", pauseReason: "budget", pauseDetail: "$2 of $2" }, "now");
    expect(budget.pause).toEqual({ reason: "budget", detail: "$2 of $2", at: "now" });

    const resumed = applyGoalPatch(paused, { status: "active" }, "later");
    expect(resumed.pause).toBeNull();
    expect(resumed.verificationRounds).toBe(0);
    expect(detectMeaningfulChange(active, paused)).toBe("status");
    expect(detectMeaningfulChange(paused, budget)).toBe("status");
  });

  it("a new rubric forgets the verdict about the old one; an edit is a 'set' change", () => {
    const verified = baseGoal({ rubric: [{ id: "c1", criterion: "A" }], verification, verificationRounds: 2 });
    const edited = applyGoalPatch(verified, { rubric: ["A", "B"] });
    expect(edited.verification).toBeNull();
    expect(edited.verificationRounds).toBe(0);
    expect(detectMeaningfulChange(verified, edited)).toBe("set");
    const sameRubric = applyGoalPatch(verified, { progressSummary: "x" });
    expect(sameRubric.verification).toEqual(verification);
    expect(detectMeaningfulChange(verified, applyGoalPatch(verified, { verifier: { provider: "google", model: "gemini-3.8-flash" } }))).toBe("set");
    expect(detectMeaningfulChange(verified, applyGoalPatch(verified, { maxIterations: 5 }))).toBe("set");
  });

  it("recordVerification: satisfied completes the goal; a paused verdict pauses it — one write, one 'verified' event", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal({ rubric: [{ id: "c1", criterion: "A" }] }) });
    const emit = vi.fn();
    const failing = await ConversationGoalService.recordVerification(...ARGS, verification, {
      pause: { reason: "max_iterations", detail: "2 rounds" },
      emit,
    });
    expect(failing).toMatchObject({
      status: "paused",
      pause: { reason: "max_iterations", detail: "2 rounds" },
      verification,
      verificationRounds: 2,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ change: "verified" }));

    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal({ rubric: [{ id: "c1", criterion: "A" }] }) });
    const satisfied = await ConversationGoalService.recordVerification(...ARGS, {
      ...verification,
      verdict: "satisfied",
      criteria: [{ id: "c1", pass: true, evidence: "read_file shows it" }],
      iteration: 1,
      at: "2026-09-22T11:00:00.000Z",
    });
    expect(satisfied).toMatchObject({
      status: "completed",
      progress: { summary: "Verified: all 1 criteria met", percent: 100 },
      verification: { verdict: "satisfied" },
    });
  });

  it("a restart pauses the goals it cut off (reason restart) and only clears the mark on the others", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal() });
    await ConversationGoalService.markContinuing(...ARGS, "2026-09-22T09:00:00.000Z");
    expect(stored().goal!.continuingSince).toBe("2026-09-22T09:00:00.000Z");
    store.collections.get(COLLECTIONS.AGENT_CONVERSATIONS)!.push({
      id: "conv-2",
      project: SCOPE.project,
      username: SCOPE.username,
      goal: baseGoal({ status: "completed", continuingSince: "2026-09-22T09:00:00.000Z" }),
    });
    store.collections.get(COLLECTIONS.AGENT_CONVERSATIONS)!.push({
      id: "conv-3",
      project: SCOPE.project,
      username: SCOPE.username,
      goal: baseGoal(),
    });

    expect(await ConversationGoalService.pauseInterruptedRuns()).toBe(1);
    const rows = store.collections.get(COLLECTIONS.AGENT_CONVERSATIONS)! as Array<FakeDocument & { goal: ConversationGoal }>;
    expect(rows[0].goal).toMatchObject({ status: "paused", pause: { reason: "restart" }, continuingSince: null });
    expect(rows[1].goal).toMatchObject({ status: "completed", continuingSince: null });
    expect(rows[2].goal).toMatchObject({ status: "active" });

    // A goal that stopped being active is never marked.
    await ConversationGoalService.markContinuing(...ARGS, "2026-09-22T12:00:00.000Z");
    expect(stored().goal!.continuingSince).toBeNull();
  });

  it("late spend is booked without counting a turn", async () => {
    seed(COLLECTIONS.AGENT_CONVERSATIONS, { goal: baseGoal({ spentDollars: 1, turnsUsed: 2 }) });
    await ConversationGoalService.recordLateSpend(...ARGS, 0.25);
    expect(stored().goal).toMatchObject({ spentDollars: 1.25, turnsUsed: 2 });
  });
});

describe("formatGoalForPrompt — rubric and verdict", () => {
  it("lists the rubric with each criterion's last verdict, and a paused goal's reason", () => {
    const goal = baseGoal({
      rubric: [
        { id: "c1", criterion: "report.md exists" },
        { id: "c2", criterion: "exactly 3 bullets" },
      ],
      stepRubric: [{ id: "s1", criterion: "no failing command ignored" }],
      verification: {
        verdict: "needs_revision",
        criteria: [
          { id: "c1", pass: true, evidence: "read_file" },
          { id: "c2", pass: false, evidence: "4 bullets" },
          { id: "s1", pass: true, evidence: "none failed" },
        ],
        iteration: 1,
        verifier: { provider: "anthropic", model: "claude-sonnet-5" },
        costDollars: 0.05,
        at: "t",
      },
    });
    const text = formatGoalForPrompt(goal);
    expect(text).toContain("[c1] report.md exists — verified ✓");
    expect(text).toContain("[c2] exactly 3 bullets — NOT met: 4 bullets");
    expect(text).toContain("Step rubric");
    expect(text).toContain("[s1] no failing command ignored — verified ✓");
    expect(
      formatGoalForPrompt(baseGoal({ status: "paused", pause: { reason: "budget", detail: "$2 of $2", at: "t" } })),
    ).toContain("Status: paused (budget: $2 of $2)");
  });
});

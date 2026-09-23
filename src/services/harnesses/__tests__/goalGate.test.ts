import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "../../../../tests/mongoMock.ts";

// ────────────────────────────────────────────────────────────
// GoalRun's spend: main loop + sub-agents (through the tree's
// SharedCostBudget) + verifier, booked once; spend a detached sub-agent
// records after its turn was booked lands on the next turn's open.
// The gate's decisions are driven end to end in goalVerifiedOutcomes.test.ts.
// ────────────────────────────────────────────────────────────

const mongo = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof import("../../../../tests/mongoMock.ts").createMockCollection>>(),
}));

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection: create } = await import("../../../../tests/mongoMock.ts");
  const collection = (name: string) => {
    if (!mongo.collections.has(name)) mongo.collections.set(name, create());
    return mongo.collections.get(name)!;
  };
  return { default: { getDb: () => ({ collection }), getCollection: (_database: string, name: string) => collection(name) } };
});

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
  NEEDS_YOU_WEBHOOK_EVENTS: { GOAL_UPDATED: "goal.updated" },
}));

const { GoalRun, _clearGoalRuns, formatRevisionRequest, formatEmptyContinuationNudge } = await import(
  "../lifecycle/GoalGate.ts"
);
const { SharedCostBudget } = await import("../lifecycle/CostBudgetEnforcer.ts");

const CONVERSATION_ID = "goal-conversation";

function seed(goal: Record<string, unknown> | null) {
  mongo.collections.clear();
  const collection = createMockCollection();
  mongo.collections.set("agent_conversations", collection);
  collection.insertOne({
    id: CONVERSATION_ID,
    project: "p",
    username: "u",
    messages: [],
    ...(goal && {
      goal: {
        objective: "Ship it",
        progress: { summary: "Not started", percent: 0, updatedAt: "t" },
        status: "active",
        spentDollars: 0,
        turnsUsed: 0,
        createdAt: "t",
        updatedAt: "t",
        ...goal,
      },
    }),
  });
}

function storedGoal() {
  return [...mongo.collections.get("agent_conversations")!._docs.values()][0].goal;
}

/** A root turn on gemini-3.6-flash ($0.75 / $3.75 per M). */
function turn(options: Record<string, unknown> = {}, inputTokens = 100_000) {
  const context = {
    conversationId: CONVERSATION_ID,
    agentConversationId: `loop-${Math.random()}`,
    project: "p",
    username: "u",
    resolvedModel: "gemini-3.6-flash",
    providerName: "google",
    options,
    emit: vi.fn(),
  };
  const state = {
    overallUsage: { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 },
    iterations: 1,
    streamedToolCalls: [],
  };
  return { context, state };
}

beforeEach(() => {
  _clearGoalRuns();
});

describe("GoalRun spend", () => {
  it("counts the main loop and every sub-agent that recorded into the tree's budget, booked once", async () => {
    seed({});
    const { context, state } = turn();
    const run = (await GoalRun.open(context as never, state as never))!;
    const budget = (context.options as { _sharedCostBudget?: InstanceType<typeof SharedCostBudget> })._sharedCostBudget!;
    // An uncapped budget: it only counts.
    expect(budget).toBeInstanceOf(SharedCostBudget);
    expect(budget.isExceeded()).toBe(false);
    expect((context.options as { _goalRun?: unknown })._goalRun).toBe(run);

    budget.record("sub-agent-1", 0.2);
    budget.record("sub-agent-2", 0.05);
    // Main loop: 100 000 input tokens at $0.75/M = $0.075.
    expect(run.bookTurnSpend()).toBeCloseTo(0.075 + 0.25, 8);
    expect(run.bookTurnSpend()).toBe(0);
  });

  it("keeps a request's own capped budget instead of replacing it", async () => {
    seed({});
    const capped = new SharedCostBudget(1);
    const { context, state } = turn({ _sharedCostBudget: capped });
    await GoalRun.open(context as never, state as never);
    expect((context.options as { _sharedCostBudget?: unknown })._sharedCostBudget).toBe(capped);
  });

  it("gives no budget to a turn without an active goal, and no run to a sub-agent", async () => {
    seed({ status: "paused" });
    const { context, state } = turn();
    const run = await GoalRun.open(context as never, state as never);
    expect(run).not.toBeNull();
    expect((context.options as { _sharedCostBudget?: unknown })._sharedCostBudget).toBeUndefined();

    const sub = turn({ isSubAgent: true });
    expect(await GoalRun.open(sub.context as never, sub.state as never)).toBeNull();
  });

  it("books a detached sub-agent's late spend on the goal when the next turn opens", async () => {
    seed({ spentDollars: 1 });
    const first = turn({}, 0);
    const run = (await GoalRun.open(first.context as never, first.state as never))!;
    const budget = (first.context.options as { _sharedCostBudget?: InstanceType<typeof SharedCostBudget> })._sharedCostBudget!;
    budget.record("detached-sub-agent", 0.1);
    expect(run.bookTurnSpend()).toBeCloseTo(0.1, 8);

    // The sub-agent kept working after its parent's turn was booked.
    budget.record("detached-sub-agent", 0.35);
    const second = turn({}, 0);
    await GoalRun.open(second.context as never, second.state as never);
    expect(storedGoal().spentDollars).toBeCloseTo(1.25, 8);
    expect(storedGoal().turnsUsed).toBe(0);

    // Booked once.
    const third = turn({}, 0);
    await GoalRun.open(third.context as never, third.state as never);
    expect(storedGoal().spentDollars).toBeCloseTo(1.25, 8);
  });
});

describe("what the agent is told", () => {
  const goal = {
    objective: "Write the report",
    rubric: [
      { id: "c1", criterion: "report.md exists" },
      { id: "c2", criterion: "exactly 3 bullets" },
    ],
  };
  const verification = {
    verdict: "needs_revision" as const,
    criteria: [
      { id: "c1", pass: true, evidence: "read_file shows it" },
      { id: "c2", pass: false, evidence: "it has 4" },
    ],
    iteration: 1,
    verifier: { provider: "anthropic", model: "claude-sonnet-5" },
    costDollars: 0.05,
    at: "t",
  };

  it("the revision names each failing criterion with its gap, and only the ids of what passed", () => {
    const text = formatRevisionRequest(goal as never, verification, 3);
    expect(text).toContain("round 1 of 3");
    expect(text).toContain("- [c2] exactly 3 bullets — it has 4");
    expect(text).toContain("Met: c1");
    expect(text).not.toContain("read_file shows it");
    expect(text).toContain('status "blocked"');
  });

  it("the empty-continuation nudge counts toward the breaker", () => {
    const text = formatEmptyContinuationNudge(goal as never, verification, 2);
    expect(text).toContain("2 of 3");
    expect(text).toContain("- [c2] exactly 3 bullets — it has 4");
  });
});

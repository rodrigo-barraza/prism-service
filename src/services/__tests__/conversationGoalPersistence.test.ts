import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// A goal set on a conversation must be STORED on it. The goal service reads
// the conversation with a projection ({ goal: 1 }) and then writes back by
// the document it read — MongoDB returns only `_id` and the projected
// fields, so a write keyed on the read document's `id` was keyed on
// `undefined` (sent as null), matched nothing, and "succeeded": PUT and
// set_goal answered with a goal no turn ever saw (found live, 2026-09-22).
//
// This double behaves like the driver where the other doubles did not: an
// inclusion projection returns `_id` + the listed fields only, and an
// `undefined` filter value matches only documents without that field.
// ────────────────────────────────────────────────────────────

vi.mock("#config", () => ({ MONGO_DB_NAME: "prism-test" }));
vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
  NEEDS_YOU_WEBHOOK_EVENTS: { GOAL_UPDATED: "goal.updated" },
}));

type Row = Record<string, unknown>;
const store = vi.hoisted(() => ({ rows: new Map<string, Row[]>() }));

function matches(document: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) =>
    value === undefined || value === null ? document[key] === undefined || document[key] === null : document[key] === value,
  );
}

function project(document: Row, projection: Record<string, unknown> | undefined): Row {
  if (!projection || Object.keys(projection).length === 0) return structuredClone(document);
  const projected: Row = { _id: document._id };
  for (const [key, spec] of Object.entries(projection)) {
    if (!(key in document)) continue;
    if (spec && typeof spec === "object" && "$slice" in (spec as Row)) {
      const slice = (spec as { $slice: number }).$slice;
      projected[key] = structuredClone((document[key] as unknown[]).slice(slice));
    } else if (spec) {
      projected[key] = structuredClone(document[key]);
    }
  }
  return projected;
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () => ({
      collection: (name: string) => {
        if (!store.rows.has(name)) store.rows.set(name, []);
        const rows = store.rows.get(name)!;
        return {
          findOne: async (filter: Row, options?: { projection?: Record<string, unknown> }) => {
            const found = rows.find((document) => matches(document, filter));
            return found ? project(found, options?.projection) : null;
          },
          updateOne: async (filter: Row, update: { $set?: Row; $unset?: Row }) => {
            const found = rows.find((document) => matches(document, filter));
            if (!found) return { matchedCount: 0, modifiedCount: 0 };
            if (update.$set) Object.assign(found, structuredClone(update.$set));
            for (const key of Object.keys(update.$unset ?? {})) delete found[key];
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      },
    }),
  },
}));

const { default: ConversationGoalService } = await import("#src/services/ConversationGoalService");

const ARGS = ["conv-1", "proj", "user"] as const;

function stored(): Row {
  return store.rows.get("agent_conversations")![0];
}

beforeEach(() => {
  store.rows.clear();
  store.rows.set("agent_conversations", [
    { _id: "oid-1", id: "conv-1", project: "proj", username: "user", messages: [{ role: "assistant", content: "hi", estimatedCost: 0.02 }] },
  ]);
});

describe("a goal is stored on its conversation (MongoDB projections)", () => {
  it("set, update and the turn's accounting all reach the document", async () => {
    const goal = await ConversationGoalService.set(...ARGS, { objective: "Ship it" });
    expect(stored().goal).toEqual(goal);
    expect(await ConversationGoalService.get(...ARGS)).toEqual(goal);

    await ConversationGoalService.update(...ARGS, { progressSummary: "Halfway", percent: 50 });
    expect(stored().goal).toMatchObject({ progress: { summary: "Halfway", percent: 50 } });

    await ConversationGoalService.createHook()({ conversationId: "conv-1", project: "proj", username: "user" });
    expect(stored().goal).toMatchObject({ spentDollars: 0.02, turnsUsed: 1 });

    expect(await ConversationGoalService.clear(...ARGS)).toBe(true);
    expect(stored().goal).toBeUndefined();
  });

  it("a proposal and its approval reach the document too", async () => {
    await ConversationGoalService.propose(...ARGS, { objective: "Proposed", rubric: ["A"] });
    expect(stored().goalProposal).toMatchObject({ objective: "Proposed", status: "proposed" });
    await ConversationGoalService.approveProposal(...ARGS);
    expect(stored().goal).toMatchObject({ objective: "Proposed", status: "active" });
    expect(stored().goalProposal).toBeUndefined();
  });

  it("a write never lands on another conversation of the same user", async () => {
    store.rows.get("agent_conversations")!.push({ _id: "oid-2", project: "proj", username: "user" });
    await ConversationGoalService.set(...ARGS, { objective: "Mine" });
    expect(store.rows.get("agent_conversations")![1].goal).toBeUndefined();
    expect(stored().goal).toMatchObject({ objective: "Mine" });
  });
});

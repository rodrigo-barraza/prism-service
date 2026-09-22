import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import WebhookEventBus, { NEEDS_YOU_WEBHOOK_EVENTS } from "#src/services/WebhookEventBus";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * ConversationGoalService — the persistent objective of a conversation.
 *
 * A goal is stored as `goal` on the conversation document (agent
 * conversations first, direct conversations as a fallback — the same two
 * collections GET /conversations/:id reads). It carries what "done" means,
 * how far the agent has got, what it is blocked on, and how much of its
 * budget (dollars / turns / deadline) it has spent.
 *
 * Every mutation compares before/after and reports a `goal_update` SSE event
 * ONLY when something meaningful changed — objective, status, blockedOn, the
 * progress summary, the percent crossing a 10-point step, or the budget —
 * so a panel following the goal is not flooded by 41 % → 43 % ticks.
 */

export type ConversationGoalStatus = "active" | "paused" | "completed" | "blocked";

export const GOAL_STATUSES = {
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  BLOCKED: "blocked",
} as const;

export interface ConversationGoalBudget {
  maxCostDollars?: number;
  maxTurns?: number;
  /** ISO timestamp. */
  deadline?: string;
}

export interface ConversationGoalProgress {
  summary: string;
  percent?: number | null;
  updatedAt: string;
}

export interface ConversationGoal {
  /** What "done" means, in the user's words. */
  objective: string;
  /** How to tell it is done. */
  completionCriteria?: string;
  budget?: ConversationGoalBudget;
  progress: ConversationGoalProgress;
  /** The current obstacle, if any. */
  blockedOn?: string | null;
  status: ConversationGoalStatus;
  /** Accumulated across turns by the afterResponse hook. */
  spentDollars: number;
  turnsUsed: number;
  createdAt: string;
  updatedAt: string;
}

export const GOAL_UPDATE_EVENT_TYPE = "goal_update" as const;

export type GoalChange = "set" | "progress" | "status" | "cleared";

/** A type literal (not an interface) so it satisfies `{ type; [key]: unknown }` emitters. */
export type GoalUpdateEvent = {
  type: typeof GOAL_UPDATE_EVENT_TYPE;
  goal: ConversationGoal;
  change: GoalChange;
};

/** Any emitter that accepts a `{ type, ...payload }` event (SSE emit, tool `_emit`). */
export type GoalEmit = (event: GoalUpdateEvent) => void;

export interface GoalSetInput {
  objective: string;
  completionCriteria?: string | null;
  budget?: ConversationGoalBudget | null;
}

export interface GoalPatch {
  objective?: string;
  completionCriteria?: string | null;
  budget?: ConversationGoalBudget | null;
  status?: ConversationGoalStatus;
  progressSummary?: string;
  percent?: number | null;
  blockedOn?: string | null;
}

interface GoalOptions {
  emit?: GoalEmit | null;
}

/** Ids the harness threads through hook / assembler / tool contexts. */
export interface GoalScopeIds {
  conversationId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
}

export const NOT_STARTED_SUMMARY = "Not started";

/** Prefix of the blockedOn reason recordTurn writes when a budget line is spent. */
export const BUDGET_EXHAUSTED_PREFIX = "budget exhausted: ";

/** A percent change only counts once it crosses a step of this size. */
export const PERCENT_NOTIFY_STEP = 10;

/** Currency rounding for the accumulated spend (8 dp — matches estimatedCost). */
const SPEND_PRECISION = 8;

const GOAL_STATUS_VALUES: readonly ConversationGoalStatus[] = [
  GOAL_STATUSES.ACTIVE,
  GOAL_STATUSES.PAUSED,
  GOAL_STATUSES.COMPLETED,
  GOAL_STATUSES.BLOCKED,
];

/** Goals live on agent conversations; direct conversations are the fallback. */
const GOAL_COLLECTIONS = [
  COLLECTIONS.AGENT_CONVERSATIONS,
  COLLECTIONS.MODEL_CONVERSATIONS,
];

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}

// ─── Pure helpers ───────────────────────────────────────────────

export function isGoalStatus(value: unknown): value is ConversationGoalStatus {
  return (
    typeof value === "string" &&
    (GOAL_STATUS_VALUES as readonly string[]).includes(value)
  );
}

/** Drop invalid / non-positive budget parts; undefined when nothing survives. */
export function normalizeBudget(
  budget: unknown,
): ConversationGoalBudget | undefined {
  if (!budget || typeof budget !== "object") return undefined;
  const raw = budget as Record<string, unknown>;
  const normalized: ConversationGoalBudget = {};
  if (
    typeof raw.maxCostDollars === "number" &&
    Number.isFinite(raw.maxCostDollars) &&
    raw.maxCostDollars > 0
  ) {
    normalized.maxCostDollars = raw.maxCostDollars;
  }
  if (
    typeof raw.maxTurns === "number" &&
    Number.isInteger(raw.maxTurns) &&
    raw.maxTurns > 0
  ) {
    normalized.maxTurns = raw.maxTurns;
  }
  if (typeof raw.deadline === "string") {
    const parsed = Date.parse(raw.deadline);
    if (!Number.isNaN(parsed)) {
      normalized.deadline = new Date(parsed).toISOString();
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** undefined = untouched, null = cleared, number = clamped to 0..100. */
function clampPercent(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function percentStep(percent: number | null | undefined): number | null {
  return typeof percent === "number"
    ? Math.floor(percent / PERCENT_NOTIFY_STEP)
    : null;
}

function sameBudget(
  a: ConversationGoalBudget | undefined,
  b: ConversationGoalBudget | undefined,
): boolean {
  return (
    (a?.maxCostDollars ?? null) === (b?.maxCostDollars ?? null) &&
    (a?.maxTurns ?? null) === (b?.maxTurns ?? null) &&
    (a?.deadline ?? null) === (b?.deadline ?? null)
  );
}

function roundSpend(value: number): number {
  return parseFloat(value.toFixed(SPEND_PRECISION));
}

/**
 * The change worth telling a panel about, or null when nothing meaningful
 * moved. Precedence: set (objective/criteria/budget) > status (status or
 * blockedOn) > progress (summary or a 10-point percent step).
 */
export function detectMeaningfulChange(
  before: ConversationGoal | null | undefined,
  after: ConversationGoal | null | undefined,
): GoalChange | null {
  if (!before && !after) return null;
  if (!before) return "set";
  if (!after) return "cleared";
  if (
    before.objective !== after.objective ||
    (before.completionCriteria ?? null) !== (after.completionCriteria ?? null) ||
    !sameBudget(before.budget, after.budget)
  ) {
    return "set";
  }
  if (
    before.status !== after.status ||
    (before.blockedOn ?? null) !== (after.blockedOn ?? null)
  ) {
    return "status";
  }
  if (
    before.progress.summary !== after.progress.summary ||
    percentStep(before.progress.percent) !== percentStep(after.progress.percent)
  ) {
    return "progress";
  }
  return null;
}

/** The exhaustion reason when a budget line is spent, else null. */
export function describeBudgetExhaustion(
  goal: ConversationGoal,
  now: Date = new Date(),
): string | null {
  const budget = goal.budget;
  if (!budget) return null;
  if (
    budget.maxCostDollars !== undefined &&
    goal.spentDollars >= budget.maxCostDollars
  ) {
    return `${BUDGET_EXHAUSTED_PREFIX}$${goal.spentDollars.toFixed(4)} spent of $${budget.maxCostDollars} allowed`;
  }
  if (budget.maxTurns !== undefined && goal.turnsUsed >= budget.maxTurns) {
    return `${BUDGET_EXHAUSTED_PREFIX}${goal.turnsUsed} of ${budget.maxTurns} turns used`;
  }
  if (budget.deadline && Date.parse(budget.deadline) <= now.getTime()) {
    return `${BUDGET_EXHAUSTED_PREFIX}deadline ${budget.deadline} has passed`;
  }
  return null;
}

/**
 * Apply a partial update. Derived rules keep status and blockedOn coherent:
 * a non-empty blockedOn on an active goal blocks it, clearing blockedOn on a
 * blocked goal re-activates it, an explicit "active" clears the obstacle,
 * and "completed" clears the obstacle and (unless given) lands percent at 100.
 */
export function applyGoalPatch(
  before: ConversationGoal,
  patch: GoalPatch,
  now: string = new Date().toISOString(),
): ConversationGoal {
  const after: ConversationGoal = structuredClone(before);
  after.updatedAt = now;

  if (typeof patch.objective === "string" && patch.objective.trim()) {
    after.objective = patch.objective.trim();
  }
  if (patch.completionCriteria !== undefined) {
    const criteria =
      typeof patch.completionCriteria === "string"
        ? patch.completionCriteria.trim()
        : "";
    if (criteria) after.completionCriteria = criteria;
    else delete after.completionCriteria;
  }
  if (patch.budget !== undefined) {
    const budget = normalizeBudget(patch.budget);
    if (budget) after.budget = budget;
    else delete after.budget;
  }

  let progressTouched = false;
  if (typeof patch.progressSummary === "string" && patch.progressSummary.trim()) {
    after.progress.summary = patch.progressSummary.trim();
    progressTouched = true;
  }
  const percent = clampPercent(patch.percent);
  if (percent !== undefined) {
    after.progress.percent = percent;
    progressTouched = true;
  }
  if (progressTouched) after.progress.updatedAt = now;

  if (patch.blockedOn !== undefined) {
    const blockedOn =
      typeof patch.blockedOn === "string" ? patch.blockedOn.trim() : "";
    after.blockedOn = blockedOn || null;
  }

  if (patch.status !== undefined) {
    after.status = patch.status;
    if (patch.status === GOAL_STATUSES.ACTIVE && patch.blockedOn === undefined) {
      after.blockedOn = null;
    }
  } else if (patch.blockedOn !== undefined) {
    if (after.blockedOn && after.status === GOAL_STATUSES.ACTIVE) {
      after.status = GOAL_STATUSES.BLOCKED;
    } else if (!after.blockedOn && after.status === GOAL_STATUSES.BLOCKED) {
      after.status = GOAL_STATUSES.ACTIVE;
    }
  }

  if (after.status === GOAL_STATUSES.COMPLETED) {
    after.blockedOn = null;
    if (percent === undefined) {
      after.progress.percent = 100;
      after.progress.updatedAt = now;
    }
  }

  return after;
}

/**
 * Which conversation's goal a harness context belongs to. The conversation
 * DOCUMENT is keyed by `conversationId` (`agentConversationId` is the loop
 * id — random on timer-resumed turns); sub-agents read their parent's goal.
 */
export function resolveGoalConversationId(ids: GoalScopeIds): string | null {
  if (ids.parentAgentConversationId) return ids.parentAgentConversationId;
  return ids.conversationId || ids.agentConversationId || null;
}

function formatDeadline(deadline: string, now: Date): string {
  const remainingMilliseconds = Date.parse(deadline) - now.getTime();
  if (Number.isNaN(remainingMilliseconds)) return deadline;
  if (remainingMilliseconds <= 0) return `${deadline} (passed)`;
  const totalMinutes = Math.round(remainingMilliseconds / 60_000);
  if (totalMinutes < 60) return `${deadline} (in ${totalMinutes} min)`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) return `${deadline} (in ${totalHours} h)`;
  return `${deadline} (in ${Math.round(totalHours / 24)} days)`;
}

/** The `<goal>` section body injected into the per-turn system context. */
export function formatGoalForPrompt(
  goal: ConversationGoal,
  now: Date = new Date(),
): string {
  const lines: string[] = [`Objective: ${goal.objective}`];
  if (goal.completionCriteria) {
    lines.push(`Completion criteria: ${goal.completionCriteria}`);
  }
  lines.push(`Status: ${goal.status}`);
  const percent =
    typeof goal.progress.percent === "number"
      ? `${goal.progress.percent}% — `
      : "";
  lines.push(
    `Progress: ${percent}${goal.progress.summary} (updated ${goal.progress.updatedAt})`,
  );
  if (goal.blockedOn) lines.push(`Blocked on: ${goal.blockedOn}`);

  const budget = goal.budget;
  const budgetParts: string[] = [];
  if (budget?.maxCostDollars !== undefined) {
    const remaining = Math.max(0, budget.maxCostDollars - goal.spentDollars);
    budgetParts.push(
      `$${goal.spentDollars.toFixed(4)} of $${budget.maxCostDollars} spent ($${remaining.toFixed(4)} left)`,
    );
  } else {
    budgetParts.push(`$${goal.spentDollars.toFixed(4)} spent`);
  }
  if (budget?.maxTurns !== undefined) {
    const remaining = Math.max(0, budget.maxTurns - goal.turnsUsed);
    budgetParts.push(
      `${goal.turnsUsed} of ${budget.maxTurns} turns used (${remaining} left)`,
    );
  } else {
    budgetParts.push(`${goal.turnsUsed} turns used`);
  }
  if (budget?.deadline) {
    budgetParts.push(`deadline ${formatDeadline(budget.deadline, now)}`);
  }
  lines.push(`Budget: ${budgetParts.join(" · ")}`);

  switch (goal.status) {
    case GOAL_STATUSES.PAUSED:
      lines.push(
        "The user paused this goal — do not pursue it until they resume it; answer only what is asked.",
      );
      break;
    case GOAL_STATUSES.COMPLETED:
      lines.push(
        "This goal is marked completed; only reopen it with update_goal (status active) if the user says it is not done.",
      );
      break;
    case GOAL_STATUSES.BLOCKED:
      lines.push(
        "This goal is blocked — resolve the obstacle above or ask the user for what you need, then call update_goal with status active.",
      );
      break;
    default:
      lines.push(
        "Keep update_goal current as you work: report progress as it changes, call it with status completed once the completion criteria are met, and set blockedOn (status blocked) when you are stuck instead of spinning.",
      );
  }
  return lines.join("\n");
}

// ─── Persistence ────────────────────────────────────────────────

interface GoalDocument {
  id: string;
  project: string;
  username: string;
  goal?: ConversationGoal | null;
  messages?: Array<Record<string, unknown>>;
}

interface LocatedGoalDocument {
  collection: string;
  document: GoalDocument;
}

async function locate(
  conversationId: string,
  project: string,
  username: string,
  projection: Record<string, unknown>,
): Promise<LocatedGoalDocument | null> {
  const database = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!database || !conversationId) return null;
  for (const collection of GOAL_COLLECTIONS) {
    const document = (await database
      .collection(collection)
      .findOne({ id: conversationId, project, username }, { projection })) as
      | GoalDocument
      | null;
    if (document) return { collection, document };
  }
  return null;
}

async function persist(
  located: LocatedGoalDocument,
  project: string,
  username: string,
  goal: ConversationGoal | null,
): Promise<void> {
  const database = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!database) throw new Error("Database not connected");
  const update = goal ? { $set: { goal } } : { $unset: { goal: "" } };
  await database
    .collection(located.collection)
    .updateOne({ id: located.document.id, project, username }, update);
}

/**
 * Announce a meaningful goal change: always as the `goal.updated` webhook,
 * and on the turn's stream as a `goal_update` event when there is one.
 */
function emitChange(
  emit: GoalEmit | null | undefined,
  goal: ConversationGoal,
  change: GoalChange,
  scope: { conversationId: string; project: string; username: string },
): void {
  WebhookEventBus.emit(NEEDS_YOU_WEBHOOK_EVENTS.GOAL_UPDATED, {
    ...scope,
    change,
    goal: structuredClone(goal),
  });
  if (!emit) return;
  try {
    emit({ type: GOAL_UPDATE_EVENT_TYPE, goal: structuredClone(goal), change });
  } catch (error: unknown) {
    logger.warn(
      `[ConversationGoal] goal_update emit failed: ${getErrorMessage(error)}`,
    );
  }
}

/** The cost the Finalizer stamped on the turn's final assistant message. */
function extractTurnCost(
  messages: Array<Record<string, unknown>> | undefined,
): number {
  if (!Array.isArray(messages)) return 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const cost = message.estimatedCost;
    return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
  }
  return 0;
}

interface GoalHookContext extends GoalScopeIds {
  project?: string | null;
  username?: string | null;
  emit?: ((event: { type: string; [key: string]: unknown }) => void) | null;
}

// ─── Service ────────────────────────────────────────────────────

const ConversationGoalService = {
  async get(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<ConversationGoal | null> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    return located?.document.goal ?? null;
  },

  /** Create or replace the goal: status active, progress "Not started". */
  async set(
    conversationId: string,
    project: string,
    username: string,
    input: GoalSetInput,
    { emit }: GoalOptions = {},
  ): Promise<ConversationGoal> {
    const objective =
      typeof input.objective === "string" ? input.objective.trim() : "";
    if (!objective) throw new Error("A goal needs an objective");

    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);

    const now = new Date().toISOString();
    const completionCriteria =
      typeof input.completionCriteria === "string"
        ? input.completionCriteria.trim()
        : "";
    const budget = normalizeBudget(input.budget);
    const goal: ConversationGoal = {
      objective,
      ...(completionCriteria && { completionCriteria }),
      ...(budget && { budget }),
      progress: { summary: NOT_STARTED_SUMMARY, percent: 0, updatedAt: now },
      blockedOn: null,
      status: GOAL_STATUSES.ACTIVE,
      spentDollars: 0,
      turnsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };

    await persist(located, project, username, goal);
    logger.info(
      `[ConversationGoal] Goal set on ${conversationId}: "${objective.slice(0, 80)}"`,
    );
    emitChange(emit, goal, "set", { conversationId, project, username });
    return goal;
  },

  /**
   * Partial update. Returns null when the conversation has no goal. Emits
   * only when the change is meaningful (see detectMeaningfulChange).
   */
  async update(
    conversationId: string,
    project: string,
    username: string,
    patch: GoalPatch,
    { emit }: GoalOptions = {},
  ): Promise<ConversationGoal | null> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);
    const before = located.document.goal;
    if (!before) return null;

    const after = applyGoalPatch(before, patch);
    await persist(located, project, username, after);

    const change = detectMeaningfulChange(before, after);
    if (change) {
      logger.info(
        `[ConversationGoal] Goal ${change} on ${conversationId} (status=${after.status}${
          typeof after.progress.percent === "number"
            ? `, ${after.progress.percent}%`
            : ""
        })`,
      );
      emitChange(emit, after, change, { conversationId, project, username });
    }
    return after;
  },

  /** Remove the goal. Returns false when there was none. */
  async clear(
    conversationId: string,
    project: string,
    username: string,
    { emit }: GoalOptions = {},
  ): Promise<boolean> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);
    const before = located.document.goal;
    if (!before) return false;

    await persist(located, project, username, null);
    logger.info(`[ConversationGoal] Goal cleared on ${conversationId}`);
    emitChange(emit, before, "cleared", { conversationId, project, username });
    return true;
  },

  /**
   * Account one finished turn against the goal. When a budget line is spent
   * the goal turns blocked with `blockedOn: "budget exhausted: …"`.
   */
  async recordTurn(
    conversationId: string,
    project: string,
    username: string,
    { costDollars = 0 }: { costDollars?: number } = {},
    { emit }: GoalOptions = {},
  ): Promise<ConversationGoal | null> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    const before = located?.document.goal;
    if (!located || !before) return null;

    const spend =
      typeof costDollars === "number" && Number.isFinite(costDollars)
        ? Math.max(0, costDollars)
        : 0;
    const after: ConversationGoal = {
      ...structuredClone(before),
      spentDollars: roundSpend(before.spentDollars + spend),
      turnsUsed: before.turnsUsed + 1,
      updatedAt: new Date().toISOString(),
    };

    if (after.status !== GOAL_STATUSES.COMPLETED) {
      // Block once; a goal already blocked on its budget keeps the reason it
      // was blocked with (the spend in the message would otherwise re-emit
      // a "status" change on every later turn).
      const exhaustion = describeBudgetExhaustion(after);
      const alreadyBudgetBlocked =
        after.status === GOAL_STATUSES.BLOCKED &&
        typeof after.blockedOn === "string" &&
        after.blockedOn.startsWith(BUDGET_EXHAUSTED_PREFIX);
      if (exhaustion && !alreadyBudgetBlocked) {
        after.status = GOAL_STATUSES.BLOCKED;
        after.blockedOn = exhaustion;
        logger.warn(
          `[ConversationGoal] Goal on ${conversationId} blocked — ${exhaustion}`,
        );
      }
    }

    await persist(located, project, username, after);
    const change = detectMeaningfulChange(before, after);
    if (change) {
      emitChange(emit, after, change, { conversationId, project, username });
    }
    return after;
  },

  /**
   * afterResponse hook: records the turn's spend (the estimatedCost the
   * Finalizer stamped on the persisted final assistant message) and turn
   * count on the conversation's goal. Sub-agents are skipped — the parent's
   * goal is theirs read-only and their cost rolls up through the parent.
   */
  createHook() {
    return async (context: GoalHookContext): Promise<void> => {
      try {
        if (context.parentAgentConversationId) return;
        const conversationId = resolveGoalConversationId(context);
        if (!conversationId || !context.project || !context.username) return;

        const located = await locate(
          conversationId,
          context.project,
          context.username,
          { goal: 1, messages: { $slice: -1 } },
        );
        if (!located?.document.goal) return;

        await ConversationGoalService.recordTurn(
          conversationId,
          context.project,
          context.username,
          { costDollars: extractTurnCost(located.document.messages) },
          { emit: context.emit ?? null },
        );
      } catch (error: unknown) {
        logger.warn(
          `[ConversationGoal] afterResponse accounting failed: ${getErrorMessage(error)}`,
        );
      }
    };
  },
};

export default ConversationGoalService;

import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import WebhookEventBus, { NEEDS_YOU_WEBHOOK_EVENTS } from "#src/services/WebhookEventBus";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PROTOCOL_EVENT_TYPES } from "#src/protocol/events";

/**
 * ConversationGoalService — the persistent objective of a conversation.
 *
 * A goal is stored as `goal` on the conversation document (agent
 * conversations first, direct conversations as a fallback — the same two
 * collections GET /conversations/:id reads). It carries what "done" means
 * (a rubric of criteria), how far the agent has got, what it is blocked on,
 * how much of its budget (dollars / turns / deadline) it has spent, and the
 * last verdict of its independent verifier.
 *
 * A goal is DONE when the verifier says so (lifecycle/GoalGate.ts), never
 * because the agent said so. A goal the model proposes waits as
 * `goalProposal` until the user approves it. Every pause records why.
 *
 * Every mutation compares before/after and reports a `goal_update` SSE event
 * ONLY when something meaningful changed — objective, rubric, status,
 * blockedOn, a verdict, the progress summary, the percent crossing a
 * 10-point step, or the budget — so a panel following the goal is not
 * flooded by 41 % → 43 % ticks.
 */

export type ConversationGoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  /** Only on a `goalProposal` — never the status of a goal. */
  | "proposed";

export const GOAL_STATUSES = {
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  PROPOSED: "proposed",
} as const;

/** One criterion of a goal's rubric (or step rubric). */
export interface GoalCriterion {
  id: string;
  criterion: string;
}

/** The model that verifies a goal — by default another provider's (GoalVerifier). */
export interface GoalVerifierModel {
  provider: string;
  model: string;
}

/** Why a goal is paused. Every pause records one. */
export const GOAL_PAUSE_REASONS = {
  /** A budget line (dollars, turns, deadline) is spent. */
  BUDGET: "budget",
  /** The verifier asked for revisions `maxIterations` times. */
  MAX_ITERATIONS: "max_iterations",
  /** Three continuations in a row did nothing (no tool use). */
  EMPTY_CONTINUATIONS: "empty_continuations",
  /** The user sent a message while the agent worked on the goal on its own. */
  USER_MESSAGE: "user_message",
  /** A restart cut off the agent working on the goal on its own. */
  RESTART: "restart",
  /** The verifier found the rubric contradicts the task, or could not give a verdict. */
  FAILED: "failed",
  /** The user pressed Pause. */
  USER: "user",
} as const;

export type GoalPauseReason =
  (typeof GOAL_PAUSE_REASONS)[keyof typeof GOAL_PAUSE_REASONS];

const GOAL_PAUSE_REASON_VALUES = Object.values(GOAL_PAUSE_REASONS) as readonly string[];

export function isGoalPauseReason(value: unknown): value is GoalPauseReason {
  return typeof value === "string" && GOAL_PAUSE_REASON_VALUES.includes(value);
}

export interface GoalPause {
  reason: GoalPauseReason;
  detail?: string;
  at: string;
}

export const GOAL_VERDICTS = {
  SATISFIED: "satisfied",
  NEEDS_REVISION: "needs_revision",
  /** The rubric contradicts the task — only the user can resolve it. */
  FAILED: "failed",
} as const;

export type GoalVerdict = (typeof GOAL_VERDICTS)[keyof typeof GOAL_VERDICTS];

export interface GoalCriterionResult {
  id: string;
  pass: boolean;
  evidence: string;
}

/** The verifier's last word on the goal. */
export interface GoalVerification {
  verdict: GoalVerdict;
  criteria: GoalCriterionResult[];
  /** Why a `failed` verdict (the rubric contradicts the task). */
  reason?: string;
  /** 1-based round since the goal was last (re)activated. */
  iteration: number;
  verifier: GoalVerifierModel;
  costDollars: number;
  at: string;
}

/** Revisions the verifier may ask for before the goal pauses. */
export const DEFAULT_GOAL_MAX_ITERATIONS = 3;
export const MAXIMUM_GOAL_MAX_ITERATIONS = 20;
/** Bounds on a rubric, so a goal stays a checklist and not a prompt. */
export const MAXIMUM_GOAL_CRITERIA = 20;
export const MAXIMUM_GOAL_CRITERION_LENGTH = 500;

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
  /** How to tell it is done (free text; the rubric supersedes it). */
  completionCriteria?: string;
  /** The criteria the verifier checks — what "done" means, one by one. */
  rubric?: GoalCriterion[];
  /** Criteria about HOW the work was done, judged over every step. */
  stepRubric?: GoalCriterion[];
  /** The verifier's model; unset = GoalVerifier's default (another provider). */
  verifier?: GoalVerifierModel;
  /** Revisions the verifier may ask for before the goal pauses. */
  maxIterations?: number;
  budget?: ConversationGoalBudget;
  progress: ConversationGoalProgress;
  /** The current obstacle, if any. */
  blockedOn?: string | null;
  status: ConversationGoalStatus;
  /** Why the goal is paused (status `paused` only). */
  pause?: GoalPause | null;
  /** The verifier's last verdict. */
  verification?: GoalVerification | null;
  /** Verifier rounds since the goal was last (re)activated — bounded by maxIterations. */
  verificationRounds?: number;
  /**
   * Set while the harness keeps working on the goal on its own (a
   * verifier-driven continuation). A restart that finds it set pauses the
   * goal with reason `restart` instead of resuming unattended spend.
   */
  continuingSince?: string | null;
  /** Accumulated across turns by the afterResponse hook (main loop, sub-agents, verifier). */
  spentDollars: number;
  turnsUsed: number;
  createdAt: string;
  updatedAt: string;
}

export const GOAL_UPDATE_EVENT_TYPE = PROTOCOL_EVENT_TYPES.GOAL_UPDATE;

export type GoalChange =
  | "set"
  | "progress"
  | "status"
  | "verified"
  | "cleared"
  /** The model proposed a goal: `goal` is the proposal (status `proposed`). */
  | "proposed"
  /** The user declined the proposal: `goal` is the declined proposal. */
  | "proposal_declined";

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
  /** Criteria as `{id?, criterion}` objects or plain strings (normalizeRubric). */
  rubric?: unknown;
  stepRubric?: unknown;
  verifier?: unknown;
  maxIterations?: unknown;
}

export interface GoalPatch {
  objective?: string;
  completionCriteria?: string | null;
  budget?: ConversationGoalBudget | null;
  /** Replaces the rubric (and forgets the verdict about the old one). */
  rubric?: unknown;
  stepRubric?: unknown;
  /** null = back to the default verifier. */
  verifier?: unknown;
  maxIterations?: unknown;
  status?: ConversationGoalStatus;
  /** With status `paused`: why (default `user`). */
  pauseReason?: GoalPauseReason;
  pauseDetail?: string;
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

const CRITERION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

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

/**
 * A rubric from what a form, a route or a model sent: `{id?, criterion}`
 * objects or plain strings. Blank criteria are dropped, each is trimmed and
 * capped, and ids are kept when they are short, safe and unique — otherwise
 * `c1`, `c2`, … by position. Undefined when nothing survives.
 */
export function normalizeRubric(value: unknown): GoalCriterion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rubric: GoalCriterion[] = [];
  const usedIds = new Set<string>();
  for (const entry of value) {
    if (rubric.length >= MAXIMUM_GOAL_CRITERIA) break;
    const raw =
      typeof entry === "string"
        ? { criterion: entry }
        : entry && typeof entry === "object"
          ? (entry as Record<string, unknown>)
          : null;
    const criterion =
      typeof raw?.criterion === "string"
        ? raw.criterion.trim().slice(0, MAXIMUM_GOAL_CRITERION_LENGTH)
        : "";
    if (!criterion) continue;
    let id =
      typeof raw?.id === "string" && CRITERION_ID_PATTERN.test(raw.id.trim())
        ? raw.id.trim()
        : "";
    if (!id || usedIds.has(id)) {
      let position = rubric.length + 1;
      while (usedIds.has(`c${position}`)) position++;
      id = `c${position}`;
    }
    usedIds.add(id);
    rubric.push({ id, criterion });
  }
  return rubric.length > 0 ? rubric : undefined;
}

export function normalizeVerifierModel(value: unknown): GoalVerifierModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  return provider && model ? { provider, model } : undefined;
}

export function normalizeMaxIterations(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return Math.min(value, MAXIMUM_GOAL_MAX_ITERATIONS);
}

/**
 * What the verifier checks: the rubric; for a goal set before rubrics
 * existed, its completion criteria; failing both, the objective itself.
 */
export function effectiveRubric(goal: ConversationGoal): GoalCriterion[] {
  if (goal.rubric && goal.rubric.length > 0) return goal.rubric;
  if (goal.completionCriteria) {
    return [{ id: "criteria", criterion: goal.completionCriteria }];
  }
  return [{ id: "objective", criterion: goal.objective }];
}

export function goalMaxIterations(goal: ConversationGoal): number {
  return normalizeMaxIterations(goal.maxIterations) ?? DEFAULT_GOAL_MAX_ITERATIONS;
}

function sameCriteria(
  a: GoalCriterion[] | undefined,
  b: GoalCriterion[] | undefined,
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
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
 * moved. Precedence: set (objective/criteria/rubric/verifier/budget) >
 * verified (a new verdict) > status (status, pause reason or blockedOn) >
 * progress (summary or a 10-point percent step).
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
    !sameCriteria(before.rubric, after.rubric) ||
    !sameCriteria(before.stepRubric, after.stepRubric) ||
    JSON.stringify(before.verifier ?? null) !== JSON.stringify(after.verifier ?? null) ||
    (before.maxIterations ?? null) !== (after.maxIterations ?? null) ||
    !sameBudget(before.budget, after.budget)
  ) {
    return "set";
  }
  if ((before.verification?.at ?? null) !== (after.verification?.at ?? null)) {
    return "verified";
  }
  if (
    before.status !== after.status ||
    (before.pause?.reason ?? null) !== (after.pause?.reason ?? null) ||
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
 *
 * Pausing records a reason (default `user`); leaving `paused` forgets it and
 * gives the verifier a fresh `maxIterations` rounds. A new rubric forgets
 * the verdict about the old one. Either way the goal stops being worked on
 * "on its own" (`continuingSince`) unless it stays active.
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
  if (patch.rubric !== undefined) {
    const rubric = normalizeRubric(patch.rubric);
    if (rubric) after.rubric = rubric;
    else delete after.rubric;
  }
  if (patch.stepRubric !== undefined) {
    const stepRubric = normalizeRubric(patch.stepRubric);
    if (stepRubric) after.stepRubric = stepRubric;
    else delete after.stepRubric;
  }
  if (patch.verifier !== undefined) {
    const verifier = normalizeVerifierModel(patch.verifier);
    if (verifier) after.verifier = verifier;
    else delete after.verifier;
  }
  if (patch.maxIterations !== undefined) {
    const maxIterations = normalizeMaxIterations(patch.maxIterations);
    if (maxIterations) after.maxIterations = maxIterations;
  }
  if (
    !sameCriteria(before.rubric, after.rubric) ||
    !sameCriteria(before.stepRubric, after.stepRubric)
  ) {
    after.verification = null;
    after.verificationRounds = 0;
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

  if (after.status === GOAL_STATUSES.PAUSED) {
    if (before.status !== GOAL_STATUSES.PAUSED || patch.pauseReason) {
      const detail = patch.pauseDetail?.trim();
      after.pause = {
        reason: patch.pauseReason ?? GOAL_PAUSE_REASONS.USER,
        ...(detail && { detail: detail.slice(0, 1000) }),
        at: now,
      };
    }
  } else if (before.status === GOAL_STATUSES.PAUSED || after.pause) {
    after.pause = null;
    if (after.status === GOAL_STATUSES.ACTIVE) after.verificationRounds = 0;
  }
  if (after.status !== GOAL_STATUSES.ACTIVE) after.continuingSince = null;

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
  const results = new Map(
    (goal.verification?.criteria ?? []).map((result) => [result.id, result]),
  );
  const formatCriterion = ({ id, criterion }: GoalCriterion) => {
    const result = results.get(id);
    const mark = !result ? "" : result.pass ? " — verified ✓" : ` — NOT met: ${result.evidence}`;
    return `  [${id}] ${criterion}${mark}`;
  };
  if (goal.rubric && goal.rubric.length > 0) {
    lines.push("Rubric (every criterion must hold):", ...goal.rubric.map(formatCriterion));
  }
  if (goal.stepRubric && goal.stepRubric.length > 0) {
    lines.push("Step rubric (judged over every step you take):", ...goal.stepRubric.map(formatCriterion));
  }
  lines.push(
    goal.status === GOAL_STATUSES.PAUSED && goal.pause
      ? `Status: paused (${goal.pause.reason}${goal.pause.detail ? `: ${goal.pause.detail}` : ""})`
      : `Status: ${goal.status}`,
  );
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
        "This goal is paused — do not pursue it until the user resumes it; answer only what is asked.",
      );
      break;
    case GOAL_STATUSES.COMPLETED:
      lines.push(
        "This goal is completed — an independent verifier confirmed it; only reopen it with update_goal (status active) if the user says it is not done.",
      );
      break;
    case GOAL_STATUSES.BLOCKED:
      lines.push(
        "This goal is blocked — resolve the obstacle above or ask the user for what you need, then call update_goal with status active.",
      );
      break;
    default:
      lines.push(
        "Keep update_goal current as you work and set blockedOn (status blocked) when you are stuck or need the user, instead of spinning. " +
          "You do not decide when the goal is done: when you finish a turn, an independent verifier checks every criterion against the evidence — " +
          "the tool calls and results in this conversation and your final answer, never your reasoning — and sends back what is not yet met. " +
          "So verify your own work with tools before you finish, and end with a final answer that points at the evidence.",
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
  /** A goal the model proposed, waiting for the user (status `proposed`). */
  goalProposal?: ConversationGoal | null;
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
    // `id` always rides along: every write goes back by it, and MongoDB
    // returns only `_id` and the projected fields.
    const document = (await database
      .collection(collection)
      .findOne(
        { id: conversationId, project, username },
        { projection: { ...projection, id: 1 } },
      )) as GoalDocument | null;
    if (document) return { collection, document };
  }
  return null;
}

async function persist(
  located: LocatedGoalDocument,
  project: string,
  username: string,
  goal: ConversationGoal | null,
  { dropProposal = false }: { dropProposal?: boolean } = {},
): Promise<void> {
  const database = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!database) throw new Error("Database not connected");
  if (!located.document.id) throw new Error("Goal write without a conversation id");
  const unset: Record<string, ""> = {};
  if (!goal) unset.goal = "";
  if (dropProposal) unset.goalProposal = "";
  const update = {
    ...(goal && { $set: { goal } }),
    ...(Object.keys(unset).length > 0 && { $unset: unset }),
  };
  await database
    .collection(located.collection)
    .updateOne({ id: located.document.id, project, username }, update);
}

async function persistProposal(
  located: LocatedGoalDocument,
  project: string,
  username: string,
  proposal: ConversationGoal | null,
): Promise<void> {
  const database = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!database) throw new Error("Database not connected");
  if (!located.document.id) throw new Error("Goal write without a conversation id");
  const update = proposal
    ? { $set: { goalProposal: proposal } }
    : { $unset: { goalProposal: "" } };
  await database
    .collection(located.collection)
    .updateOne({ id: located.document.id, project, username }, update);
}

/** A fresh goal from what the user (or a proposal) asked for. */
function buildGoal(
  input: GoalSetInput,
  status: ConversationGoalStatus,
  now: string,
): ConversationGoal {
  const objective =
    typeof input.objective === "string" ? input.objective.trim() : "";
  if (!objective) throw new Error("A goal needs an objective");
  const completionCriteria =
    typeof input.completionCriteria === "string"
      ? input.completionCriteria.trim()
      : "";
  const budget = normalizeBudget(input.budget);
  const rubric = normalizeRubric(input.rubric);
  const stepRubric = normalizeRubric(input.stepRubric);
  const verifier = normalizeVerifierModel(input.verifier);
  return {
    objective,
    ...(completionCriteria && { completionCriteria }),
    ...(rubric && { rubric }),
    ...(stepRubric && { stepRubric }),
    ...(verifier && { verifier }),
    maxIterations:
      normalizeMaxIterations(input.maxIterations) ?? DEFAULT_GOAL_MAX_ITERATIONS,
    ...(budget && { budget }),
    progress: {
      summary: status === GOAL_STATUSES.PROPOSED ? "Proposed" : NOT_STARTED_SUMMARY,
      percent: 0,
      updatedAt: now,
    },
    blockedOn: null,
    status,
    pause: null,
    verification: null,
    verificationRounds: 0,
    continuingSince: null,
    spentDollars: 0,
    turnsUsed: 0,
    createdAt: now,
    updatedAt: now,
  };
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

/**
 * What a root turn working on the goal knows about its own spend — main
 * loop, its sub-agents and the verifier (lifecycle/GoalGate.ts `GoalRun`).
 * Left on the turn's options so the afterResponse hook can book it.
 */
export interface GoalTurnSpend {
  /** The turn's spend so far, in dollars; records it as booked. */
  bookTurnSpend(): number;
}

interface GoalHookContext extends GoalScopeIds {
  project?: string | null;
  username?: string | null;
  emit?: ((event: { type: string; [key: string]: unknown }) => void) | null;
  options?: { _goalRun?: GoalTurnSpend | null } | null;
}

/** The goal a conversation holds, and the goal its model proposed. */
export interface GoalState {
  goal: ConversationGoal | null;
  proposal: ConversationGoal | null;
}

/** Where a goal paused and why — what `pause()` records. */
export interface GoalPauseInput {
  reason: GoalPauseReason;
  detail?: string;
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

  /** The goal and any proposal waiting for the user. */
  async getState(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<GoalState> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
      goalProposal: 1,
    });
    return {
      goal: located?.document.goal ?? null,
      proposal: located?.document.goalProposal ?? null,
    };
  },

  /**
   * Create or replace the goal: status active, progress "Not started". The
   * user decided, so a proposal still waiting is dropped.
   */
  async set(
    conversationId: string,
    project: string,
    username: string,
    input: GoalSetInput,
    { emit }: GoalOptions = {},
  ): Promise<ConversationGoal> {
    const goal = buildGoal(input, GOAL_STATUSES.ACTIVE, new Date().toISOString());
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);

    await persist(located, project, username, goal, { dropProposal: true });
    logger.info(
      `[ConversationGoal] Goal set on ${conversationId}: "${goal.objective.slice(0, 80)}"`,
    );
    emitChange(emit, goal, "set", { conversationId, project, username });
    return goal;
  },

  /**
   * The model proposes a goal. It waits as `goalProposal` — the current
   * goal, if any, is untouched — until the user approves it.
   */
  async propose(
    conversationId: string,
    project: string,
    username: string,
    input: GoalSetInput,
    { emit }: GoalOptions = {},
  ): Promise<ConversationGoal> {
    const proposal = buildGoal(input, GOAL_STATUSES.PROPOSED, new Date().toISOString());
    const located = await locate(conversationId, project, username, {
      goalProposal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);

    await persistProposal(located, project, username, proposal);
    logger.info(
      `[ConversationGoal] Goal proposed on ${conversationId}: "${proposal.objective.slice(0, 80)}"`,
    );
    emitChange(emit, proposal, "proposed", { conversationId, project, username });
    return proposal;
  },

  /** The user approves the proposal: it becomes the active goal. Null when none waits. */
  async approveProposal(
    conversationId: string,
    project: string,
    username: string,
    { emit }: GoalOptions = {},
  ): Promise<ConversationGoal | null> {
    const located = await locate(conversationId, project, username, {
      goalProposal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);
    const proposal = located.document.goalProposal;
    if (!proposal) return null;

    const goal = buildGoal(proposal, GOAL_STATUSES.ACTIVE, new Date().toISOString());
    await persist(located, project, username, goal, { dropProposal: true });
    logger.info(`[ConversationGoal] Proposed goal approved on ${conversationId}`);
    emitChange(emit, goal, "set", { conversationId, project, username });
    return goal;
  },

  /** The user declines the proposal. False when none waits. */
  async declineProposal(
    conversationId: string,
    project: string,
    username: string,
    { emit }: GoalOptions = {},
  ): Promise<boolean> {
    const located = await locate(conversationId, project, username, {
      goalProposal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);
    const proposal = located.document.goalProposal;
    if (!proposal) return false;

    await persistProposal(located, project, username, null);
    logger.info(`[ConversationGoal] Proposed goal declined on ${conversationId}`);
    emitChange(emit, proposal, "proposal_declined", { conversationId, project, username });
    return true;
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
          after.pause ? `, paused: ${after.pause.reason}` : ""
        }${
          typeof after.progress.percent === "number"
            ? `, ${after.progress.percent}%`
            : ""
        })`,
      );
      emitChange(emit, after, change, { conversationId, project, username });
    }
    return after;
  },

  /** Pause the goal and say why. Null when the conversation has no goal. */
  async pause(
    conversationId: string,
    project: string,
    username: string,
    { reason, detail }: GoalPauseInput,
    options: GoalOptions = {},
  ): Promise<ConversationGoal | null> {
    return ConversationGoalService.update(
      conversationId,
      project,
      username,
      { status: GOAL_STATUSES.PAUSED, pauseReason: reason, pauseDetail: detail },
      options,
    );
  },

  /**
   * Record a verdict. `satisfied` completes the goal; any other verdict
   * leaves it as it is unless `pause` says otherwise (one write, one event:
   * the verdict and why the goal stopped arrive together).
   */
  async recordVerification(
    conversationId: string,
    project: string,
    username: string,
    verification: GoalVerification,
    { pause, emit }: GoalOptions & { pause?: GoalPauseInput | null } = {},
  ): Promise<ConversationGoal | null> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    if (!located) throw new ConversationNotFoundError(conversationId);
    const before = located.document.goal;
    if (!before) return null;

    const now = verification.at;
    const patch: GoalPatch = {};
    if (verification.verdict === GOAL_VERDICTS.SATISFIED) {
      patch.status = GOAL_STATUSES.COMPLETED;
      patch.progressSummary = `Verified: all ${verification.criteria.length} criteria met`;
    } else if (pause) {
      patch.status = GOAL_STATUSES.PAUSED;
      patch.pauseReason = pause.reason;
      patch.pauseDetail = pause.detail;
    }
    const after = applyGoalPatch(before, patch, now);
    after.verification = structuredClone(verification);
    after.verificationRounds = verification.iteration;
    await persist(located, project, username, after);

    logger.info(
      `[ConversationGoal] Verdict on ${conversationId}: ${verification.verdict} (round ${verification.iteration}, ` +
        `${verification.criteria.filter((result) => result.pass).length}/${verification.criteria.length} criteria met, ` +
        `${verification.verifier.provider}/${verification.verifier.model}, $${verification.costDollars.toFixed(4)})` +
        (pause && verification.verdict !== GOAL_VERDICTS.SATISFIED ? ` — paused: ${pause.reason}` : ""),
    );
    emitChange(emit, after, "verified", { conversationId, project, username });
    return after;
  },

  /**
   * Mark (or unmark) the goal as being worked on by the harness on its own.
   * Silent: nothing a panel shows changes.
   */
  async markContinuing(
    conversationId: string,
    project: string,
    username: string,
    since: string | null,
  ): Promise<void> {
    const located = await locate(conversationId, project, username, {
      goal: 1,
    });
    const goal = located?.document.goal;
    if (!located || !goal) return;
    if ((goal.continuingSince ?? null) === since) return;
    // A goal that stopped being active meanwhile is never marked.
    if (since && goal.status !== GOAL_STATUSES.ACTIVE) return;
    await persist(located, project, username, { ...goal, continuingSince: since });
  },

  /**
   * Boot: a goal still marked as being worked on by the harness on its own
   * lost that work to the restart. Pause it (`restart`) rather than let a
   * re-driven turn resume unattended spend. Returns how many were paused.
   */
  async pauseInterruptedRuns(): Promise<number> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return 0;
    let paused = 0;
    for (const collection of GOAL_COLLECTIONS) {
      const interrupted = (await database
        .collection(collection)
        .find(
          { "goal.continuingSince": { $type: "string" } },
          { projection: { id: 1, project: 1, username: 1, goal: 1 } },
        )
        .toArray()) as unknown as GoalDocument[];
      for (const document of interrupted) {
        const goal = document.goal;
        if (!goal) continue;
        const after =
          goal.status === GOAL_STATUSES.ACTIVE
            ? applyGoalPatch(goal, {
                status: GOAL_STATUSES.PAUSED,
                pauseReason: GOAL_PAUSE_REASONS.RESTART,
                pauseDetail: `The service restarted while the agent was working on this goal (since ${goal.continuingSince}).`,
              })
            : { ...goal, continuingSince: null };
        await persist(
          { collection, document },
          document.project,
          document.username,
          after,
        );
        if (after.status === GOAL_STATUSES.PAUSED && goal.status === GOAL_STATUSES.ACTIVE) {
          paused++;
          emitChange(null, after, "status", {
            conversationId: document.id,
            project: document.project,
            username: document.username,
          });
        }
      }
    }
    if (paused > 0) {
      logger.warn(`[ConversationGoal] Paused ${paused} goal(s) a restart interrupted`);
    }
    return paused;
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
   * Account one finished turn against the goal — its whole spend: main
   * loop, sub-agents, verifier. When a budget line is spent the goal pauses
   * with reason `budget`.
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
    let after: ConversationGoal = {
      ...structuredClone(before),
      spentDollars: roundSpend(before.spentDollars + spend),
      turnsUsed: before.turnsUsed + 1,
      updatedAt: new Date().toISOString(),
    };

    // Pause once; a goal already paused on its budget keeps the reason it
    // was paused with (the spend in the detail would otherwise re-emit a
    // "status" change on every later turn). A completed goal stays done.
    const exhaustion = describeBudgetExhaustion(after);
    if (
      exhaustion &&
      after.status !== GOAL_STATUSES.COMPLETED &&
      after.pause?.reason !== GOAL_PAUSE_REASONS.BUDGET
    ) {
      after = applyGoalPatch(after, {
        status: GOAL_STATUSES.PAUSED,
        pauseReason: GOAL_PAUSE_REASONS.BUDGET,
        pauseDetail: exhaustion,
      });
      logger.warn(
        `[ConversationGoal] Goal on ${conversationId} paused — ${exhaustion}`,
      );
    }

    await persist(located, project, username, after);
    const change = detectMeaningfulChange(before, after);
    if (change) {
      emitChange(emit, after, change, { conversationId, project, username });
    }
    return after;
  },

  /**
   * afterResponse hook: books the turn's spend and turn count on the
   * conversation's goal. A turn that worked on the goal knows its whole
   * spend — main loop, sub-agents and verifier (`options._goalRun`); any
   * other turn books the estimatedCost the Finalizer stamped on its
   * persisted final assistant message. Sub-agents are skipped — their cost
   * rolls up through the parent's turn.
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

        const goalRun = context.options?._goalRun;
        await ConversationGoalService.recordTurn(
          conversationId,
          context.project,
          context.username,
          {
            costDollars: goalRun
              ? goalRun.bookTurnSpend()
              : extractTurnCost(located.document.messages),
          },
          { emit: context.emit ?? null },
        );
      } catch (error: unknown) {
        logger.warn(
          `[ConversationGoal] afterResponse accounting failed: ${getErrorMessage(error)}`,
        );
      }
    };
  },

  /**
   * Book spend that arrived after its turn was accounted (a detached
   * sub-agent still running when its parent's turn ended). No turn counted.
   */
  async recordLateSpend(
    conversationId: string,
    project: string,
    username: string,
    costDollars: number,
  ): Promise<void> {
    if (!(costDollars > 0)) return;
    const located = await locate(conversationId, project, username, { goal: 1 });
    const goal = located?.document.goal;
    if (!located || !goal) return;
    await persist(located, project, username, {
      ...goal,
      spentDollars: roundSpend(goal.spentDollars + costDollars),
    });
  },
};

export default ConversationGoalService;

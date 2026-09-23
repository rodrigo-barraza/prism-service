import { calculateTextCost } from "#src/utils/CostCalculator";
import { getPricing, MODALITY_TYPES } from "#src/config";
import { BUDGET_PAUSE } from "#src/constants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "#src/utils/logger";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, EmitFunction } from "#src/services/harnesses/types";
import type { BudgetLimit, StoredBudgetDecision } from "#src/services/PendingDecisionStore";

/**
 * CostBudgetEnforcer — per-session cost ceiling for agentic loops.
 *
 * Based on VeRO (ICML 2026) and "Engineering Pitfalls in AI Coding
 * Tools" (arXiv 2603.20847): without a cost ceiling, pathological
 * sessions (reasoning loops, infinite tool retries) can burn through
 * hundreds of dollars before the iteration limit is reached.
 *
 * The cumulative estimated cost is checked after each pass. At the cap a
 * turn PAUSES (prompt 13, Landing 3): the whole delegation tree waits on
 * one decision — raise the cap, or stop — parked on its user like an
 * approval (`enforceCostBudget`). A turn nobody can answer for (the
 * caller said so: autoApprove / unattended, or `onBudgetReached: "stop"`)
 * stops at the cap, into exhaustion recovery, as before.
 */

/** The conversation goal's dollar budget, as it caps one turn. */
export interface GoalBudgetLimit {
  maxCostDollars: number;
  /** What the goal had spent before this turn — the turn may spend the rest. */
  spentBeforeTurnDollars: number;
}

export interface CostBudgetLimits {
  /** The turn's own cap (the request's `maxCostDollars`, or a raise of it). */
  turnCapDollars?: number | null;
  goal?: GoalBudgetLimit | null;
}

/** What the tree had spent against which cap when it paused. */
export interface BudgetPauseInfo {
  spentDollars: number;
  maxCostDollars: number;
  limitedBy: BudgetLimit;
  turnCapDollars: number | null;
  goalMaxCostDollars: number | null;
  goalSpentBeforeTurnDollars: number | null;
  iteration: number;
}

export type BudgetResolution = { action: "raise" } | { action: "stop" };

/**
 * Opens the tree's pause and waits for its decision — installed by the
 * root turn (AgenticLoopService), which owns the conversation the card
 * goes to. It applies a raise to the budget before it returns.
 */
export type BudgetPauser = (info: BudgetPauseInfo) => Promise<BudgetResolution>;

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * SharedCostBudget — a cost accumulator shared across an agent and every
 * sub-agent it (transitively) spawns. Each loop reports its own latest
 * cumulative cost keyed by its conversation id; the budget is exceeded when
 * the SUM across the tree crosses the ceiling. Without this, a $1 cap is
 * defeated by delegating the spend to sub-agents whose loops each track
 * only their own usage.
 *
 * The ceiling is the lower of two caps: the turn's own and what is left of
 * the conversation goal's dollar budget. A turn re-driven after a restart
 * carries what its previous process spent. When the tree reaches the
 * ceiling, every loop that notices waits on the SAME pause (the first one
 * opens it); a raise lifts the cap for all of them at once.
 */
export class SharedCostBudget {
  private perLoopCost = new Map<string, number>();

  private turnCap: number | null;

  private goal: GoalBudgetLimit | null;

  private pauser: BudgetPauser | null = null;

  private openPause: Promise<BudgetResolution> | null = null;

  constructor(
    limits: number | CostBudgetLimits,
    { carriedSpendDollars = 0 }: { carriedSpendDollars?: number } = {},
  ) {
    const resolved = typeof limits === "number" ? { turnCapDollars: limits } : limits;
    this.turnCap = positiveOrNull(resolved.turnCapDollars);
    this.goal = resolved.goal ?? null;
    if (Number.isFinite(carriedSpendDollars) && carriedSpendDollars > 0) {
      this.perLoopCost.set(BUDGET_PAUSE.CARRIED_SPEND_LOOP_ID, carriedSpendDollars);
    }
  }

  /** The ceiling: the lower of the turn's cap and the goal's remainder (Infinity: none). */
  get maxCostDollars(): number {
    return Math.min(this.turnCap ?? Infinity, this.goalRemainderDollars());
  }

  get turnCapDollars(): number | null {
    return this.turnCap;
  }

  get goalLimit(): GoalBudgetLimit | null {
    return this.goal ? { ...this.goal } : null;
  }

  /** Which cap is the ceiling. */
  limitedBy(): BudgetLimit {
    return this.goalRemainderDollars() < (this.turnCap ?? Infinity) ? "goal" : "turn";
  }

  private goalRemainderDollars(): number {
    return this.goal ? this.goal.maxCostDollars - this.goal.spentBeforeTurnDollars : Infinity;
  }

  /** Record a loop's latest cumulative cost (idempotent per loop). */
  record(loopId: string, cumulativeCostDollars: number): void {
    if (!loopId || !Number.isFinite(cumulativeCostDollars)) return;
    this.perLoopCost.set(loopId, cumulativeCostDollars);
  }

  /** Total spend across every loop in the tree. */
  totalSpentDollars(): number {
    let total = 0;
    for (const cost of this.perLoopCost.values()) total += cost;
    return total;
  }

  isExceeded(): boolean {
    return this.totalSpentDollars() >= this.maxCostDollars;
  }

  /** The user raised a cap: the turn's, the goal's (null: the goal no longer caps the turn), or both. */
  apply(decision: StoredBudgetDecision): void {
    if (decision.action !== "raise") return;
    if (decision.turnCapDollars !== undefined) this.turnCap = positiveOrNull(decision.turnCapDollars);
    if (decision.goalMaxCostDollars !== undefined) {
      const goalMax = positiveOrNull(decision.goalMaxCostDollars);
      this.goal = goalMax === null
        ? null
        : { maxCostDollars: goalMax, spentBeforeTurnDollars: this.goal?.spentBeforeTurnDollars ?? 0 };
    }
  }

  /** The root turn can be asked for a raise while it runs. */
  attachPauser(pauser: BudgetPauser): void {
    this.pauser = pauser;
  }

  /** The root turn ended: a loop still running on this budget stops at the cap. */
  detachPauser(): void {
    this.pauser = null;
  }

  get canPause(): boolean {
    return this.pauser !== null;
  }

  /**
   * Wait for the tree's pause to be decided — opening it when this loop is
   * the first to reach the cap. A loop stopped meanwhile stops waiting; the
   * pause stays open for the rest of the tree.
   */
  async pauseAtCap(info: BudgetPauseInfo, signal?: AbortSignal | null): Promise<BudgetResolution> {
    if (!this.pauser) return { action: "stop" };
    if (!this.openPause) {
      const opened = this.pauser(info).catch((error: unknown) => {
        logger.error(`[CostBudgetEnforcer] Could not pause at the cap: ${String(error)}`);
        return { action: "stop" } as BudgetResolution;
      });
      this.openPause = opened;
      void opened.finally(() => {
        if (this.openPause === opened) this.openPause = null;
      });
    }
    const pause = this.openPause;
    if (!signal) return pause;
    if (signal.aborted) return { action: "stop" };
    return new Promise<BudgetResolution>((resolve) => {
      const onAbort = () => resolve({ action: "stop" });
      signal.addEventListener("abort", onAbort, { once: true });
      void pause.then((resolution) => {
        signal.removeEventListener("abort", onAbort);
        resolve(resolution);
      });
    });
  }
}

interface CostMeasurement {
  spentDollars: number;
  maxCostDollars: number;
}

type SharedBudgetRef = { budget?: SharedCostBudget; loopId?: string };

/**
 * This loop's spend recorded into the tree's budget, and the tree's total
 * against its ceiling. Null when nothing caps the loop or its model has no
 * pricing (then nothing can be enforced).
 */
function measure(
  state: AgenticLoopState,
  resolvedModel: string,
  maxCostDollars: number | undefined,
  shared?: SharedBudgetRef,
): CostMeasurement | null {
  const sharedBudget = shared?.budget;
  if ((!maxCostDollars || maxCostDollars <= 0) && !sharedBudget) return null;

  const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[resolvedModel];
  const currentUsage = { ...state.overallUsage, requests: state.iterations };
  const localCost = calculateTextCost(currentUsage, pricing);
  if (localCost === null) return null;

  if (!sharedBudget) return { spentDollars: localCost, maxCostDollars: maxCostDollars! };
  sharedBudget.record(shared?.loopId || "root", localCost);
  return { spentDollars: sharedBudget.totalSpentDollars(), maxCostDollars: sharedBudget.maxCostDollars };
}

/** Record this loop's spend into the tree's budget (what a restart carries). */
export function recordLoopSpend(context: AgenticContext, state: AgenticLoopState): void {
  const budget = context.options?._sharedCostBudget;
  if (!budget) return;
  measure(state, context.resolvedModel, context.options.maxCostDollars, {
    budget,
    loopId: context.agentConversationId,
  });
}

/** The loop ends at the cap: the stop reason, the status event, the log line. */
function stopAtCap(state: AgenticLoopState, measured: CostMeasurement, emit: EmitFunction): void {
  // The stop reason is persisted by the Finalizer — every harness breaks on
  // a stop, so recording it here covers ReAct, ToT and GoT alike.
  state.conversationOutcome = "budget_exhausted";
  state.costBudgetStop = { spentDollars: measured.spentDollars, maxCostDollars: measured.maxCostDollars };

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.COST_LIMIT_REACHED,
    estimatedCost: measured.spentDollars,
    maxCostDollars: measured.maxCostDollars,
    iteration: state.iterations,
  });

  logger.warn(
    `[CostBudgetEnforcer] Cost limit exceeded on iteration ${state.iterations}: ` +
      `$${measured.spentDollars.toFixed(4)} >= $${measured.maxCostDollars.toFixed(4)} budget. Stopping the loop.`,
  );
}

/**
 * Check whether the cumulative session cost exceeds the configured budget,
 * and stop at it — never pauses (see `enforceCostBudget`).
 *
 * When a SharedCostBudget is provided, this loop's cost is recorded into it
 * and the check runs against the tree-wide total, so sub-agent spend counts
 * against the parent's ceiling.
 *
 * @returns `true` if the cost limit has been exceeded and the loop should break
 */
export function checkCostBudget(
  state: AgenticLoopState,
  resolvedModel: string,
  maxCostDollars: number | undefined,
  emit: EmitFunction,
  shared?: SharedBudgetRef,
): boolean {
  const measured = measure(state, resolvedModel, maxCostDollars, shared);
  if (!measured || measured.spentDollars < measured.maxCostDollars) return false;
  stopAtCap(state, measured, emit);
  return true;
}

/**
 * The cap check a loop runs before it spends again — before a pass's tools
 * run, and before a model call. Under the cap: false, carry on. At the cap:
 * the tree pauses and this loop waits; a raise that lifts the cap past the
 * spend carries on (a raise that does not — a goal budget raised too
 * little — pauses again), anything else stops the loop as before.
 *
 * `beforePause` runs once, just before the first wait: what a restart
 * needs to find the turn paused here (a checkpoint).
 *
 * @returns `true` if the loop must stop
 */
export async function enforceCostBudget(
  context: AgenticContext,
  state: AgenticLoopState,
  { beforePause }: { beforePause?: () => Promise<void> } = {},
): Promise<boolean> {
  const { options, emit } = context;
  const budget = options._sharedCostBudget;
  const shared = { budget, loopId: context.agentConversationId };
  let hasPaused = false;
  for (;;) {
    const measured = measure(state, context.resolvedModel, options.maxCostDollars, shared);
    if (!measured || measured.spentDollars < measured.maxCostDollars) return false;
    if (!budget?.canPause || context.signal?.aborted) {
      stopAtCap(state, measured, emit);
      return true;
    }
    if (!hasPaused) {
      hasPaused = true;
      await beforePause?.();
    }
    const goal = budget.goalLimit;
    logger.info(
      `[CostBudgetEnforcer] ${context.agentConversationId}: $${measured.spentDollars.toFixed(4)} of the ` +
        `$${measured.maxCostDollars.toFixed(4)} ${budget.limitedBy()} cap spent on iteration ${state.iterations} — pausing for a raise`,
    );
    const resolution = await budget.pauseAtCap(
      {
        spentDollars: measured.spentDollars,
        maxCostDollars: measured.maxCostDollars,
        limitedBy: budget.limitedBy(),
        turnCapDollars: budget.turnCapDollars,
        goalMaxCostDollars: goal?.maxCostDollars ?? null,
        goalSpentBeforeTurnDollars: goal?.spentBeforeTurnDollars ?? null,
        iteration: state.iterations,
      },
      context.signal,
    );
    if (resolution.action !== "raise") {
      stopAtCap(state, measured, emit);
      return true;
    }
  }
}

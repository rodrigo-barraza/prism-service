import { calculateTextCost } from "#src/utils/CostCalculator";
import { getPricing, MODALITY_TYPES } from "#src/config";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "#src/utils/logger";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { EmitFunction } from "#src/services/harnesses/types";

/**
 * CostBudgetEnforcer — per-session cost ceiling for agentic loops.
 *
 * Based on VeRO (ICML 2026) and "Engineering Pitfalls in AI Coding
 * Tools" (arXiv 2603.20847): without a cost ceiling, pathological
 * sessions (reasoning loops, infinite tool retries) can burn through
 * hundreds of dollars before the iteration limit is reached.
 *
 * This module checks the cumulative estimated cost after each iteration
 * and signals the harness to break into exhaustion recovery when the
 * configured `maxCostDollars` threshold is exceeded.
 *
 * Returns `true` when the budget has been exceeded and the loop
 * should terminate.
 */

/**
 * SharedCostBudget — a cost accumulator shared across an agent and every
 * sub-agent it (transitively) spawns. Each loop reports its own latest
 * cumulative cost keyed by its conversation id; the budget is exceeded when
 * the SUM across the tree crosses the ceiling. Without this, a $1 cap is
 * defeated by delegating the spend to sub-agents whose loops each track
 * only their own usage.
 */
export class SharedCostBudget {
  private perLoopCost = new Map<string, number>();

  constructor(public readonly maxCostDollars: number) {}

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
}

/**
 * Check whether the cumulative session cost exceeds the configured budget.
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
  shared?: { budget?: SharedCostBudget; loopId?: string },
): boolean {
  const sharedBudget = shared?.budget;
  if ((!maxCostDollars || maxCostDollars <= 0) && !sharedBudget) return false;

  const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[resolvedModel];
  const currentUsage = { ...state.overallUsage, requests: state.iterations };
  const localCost = calculateTextCost(currentUsage, pricing);

  if (localCost === null) return false;

  let estimatedCost = localCost;
  let effectiveMax = maxCostDollars;
  if (sharedBudget) {
    sharedBudget.record(shared?.loopId || "root", localCost);
    estimatedCost = sharedBudget.totalSpentDollars();
    effectiveMax = sharedBudget.maxCostDollars;
  }

  if (!effectiveMax || effectiveMax <= 0) return false;
  const resolvedMaxCostDollars = effectiveMax;
  if (estimatedCost < resolvedMaxCostDollars) return false;
  maxCostDollars = resolvedMaxCostDollars;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.COST_LIMIT_REACHED,
    estimatedCost,
    maxCostDollars,
    iteration: state.iterations,
  });

  logger.warn(
    `[CostBudgetEnforcer] Cost limit exceeded on iteration ${state.iterations}: ` +
      `$${estimatedCost.toFixed(4)} >= $${maxCostDollars.toFixed(4)} budget. Triggering exhaustion recovery.`,
  );

  return true;
}

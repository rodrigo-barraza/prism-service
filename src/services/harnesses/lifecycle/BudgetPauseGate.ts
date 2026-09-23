import BudgetPauseRegistry from "#src/services/BudgetPauseRegistry";
import { resolveLoopKey } from "#src/services/LoopKey";
import { decisionOwnerOf } from "#src/services/conversation/ConversationRunState";
import { BUDGET_PAUSE } from "#src/constants";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { recordCostBudget } from "./TurnRunRecorder.ts";

import type { AgenticContext } from "#src/services/harnesses/types";
import type { BudgetPauseInfo, BudgetResolution } from "./CostBudgetEnforcer.ts";

/**
 * BudgetPauseGate — the ROOT turn's side of a budget pause (prompt 13,
 * Landing 3): what the tree does when any of its loops reaches the cap.
 *
 * Installed as the tree budget's pauser by AgenticLoopService for a root
 * turn that pauses at its cap. It runs once per pause, whichever loop
 * reached the cap first, and speaks for the conversation the user holds:
 *
 *   1. the spend is recorded on the turn's run (a restart carries it);
 *   2. the pause is recorded (BudgetPauseRegistry) — then announced, a
 *      `budget_reached` status with the spend against the cap, which the
 *      "needs you" features pick up (attention count, webhook, push);
 *   3. it waits — no timeout — for a raise, or for the turn to stop;
 *   4. a raise is applied to the budget, recorded on the run, and
 *      announced (`budget_resolved`); the waiting loops carry on.
 *
 * A turn re-driven after a restart picks its pause up again: the same
 * pause, or the raise the user made while it was down (no card then).
 */
export async function waitForBudgetRaise(
  context: AgenticContext,
  info: BudgetPauseInfo,
): Promise<BudgetResolution> {
  const { emit } = context;
  const budget = context.options._sharedCostBudget;
  const loopKey = resolveLoopKey(context);
  await recordCostBudget(context);

  const opened = await BudgetPauseRegistry.open(loopKey, info, decisionOwnerOf(context), {
    resume: !!context.resume,
  });
  if (!opened.decidedWhileAway) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: BUDGET_PAUSE.STATUS_REACHED,
      pauseId: opened.pauseId,
      spentDollars: info.spentDollars,
      maxCostDollars: info.maxCostDollars,
      limitedBy: info.limitedBy,
      iteration: info.iteration,
      ...(info.turnCapDollars !== null && { turnCapDollars: info.turnCapDollars }),
      ...(info.goalMaxCostDollars !== null && { goalMaxCostDollars: info.goalMaxCostDollars }),
    });
  }

  // A stopped turn must not park forever on a card nobody will click.
  const cancelOnAbort = () => void BudgetPauseRegistry.cancel(loopKey);
  context.signal?.addEventListener("abort", cancelOnAbort, { once: true });
  if (context.signal?.aborted) cancelOnAbort();
  let decision: Awaited<typeof opened.decision>;
  try {
    decision = await opened.decision;
  } finally {
    context.signal?.removeEventListener("abort", cancelOnAbort);
  }

  if (decision.action === "raise") {
    budget?.apply(decision);
    await recordCostBudget(context);
  }
  const ceiling = budget?.maxCostDollars;
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: BUDGET_PAUSE.STATUS_RESOLVED,
    pauseId: opened.pauseId,
    action: decision.action,
    source: decision.source,
    ...(decision.action === "raise" &&
      typeof ceiling === "number" &&
      Number.isFinite(ceiling) && { maxCostDollars: ceiling }),
  });
  return decision.action === "raise" ? { action: "raise" } : { action: "stop" };
}

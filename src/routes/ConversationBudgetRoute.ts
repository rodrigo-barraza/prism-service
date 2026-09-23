import type { Request, Response } from "express";
import AgenticLoopService from "#src/services/AgenticLoopService";
import type { BudgetRaiseOutcome } from "#src/services/BudgetPauseRegistry";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * PATCH /conversations/:id/budget — raise the cost cap of the turn paused
 * at it (prompt 13, Landing 3). The turn resumes through the same decision
 * it parked on, like an approval.
 *
 * Body: { maxCostDollars: number }  — the turn's new cap, in dollars.
 *
 * 200 — { status: "raised", pauseId, maxCostDollars, spentDollars, delivered }.
 *       `delivered: false`: no turn is running to take it (the server
 *       restarted) — it is stored, and the re-driven turn applies it.
 * 400 — maxCostDollars is not a positive number.
 * 404 — no turn is paused at its budget on this conversation.
 * 409 — the pause was settled by another request first.
 * 422 — the cap it would run under is no higher than what it has spent, so
 *       it would pause again at once; `limitedBy: "goal"` says the goal's
 *       budget is the lower cap — raise that one (PATCH …/goal).
 */

/** The HTTP answer for a raise, shared with the goal budget PATCH. */
export function budgetRaiseResponse(outcome: BudgetRaiseOutcome): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (outcome.status) {
    case "raised":
      return { status: 200, body: outcome };
    case "not_found":
      return {
        status: 404,
        body: { status: outcome.status, error: "No turn is paused at its budget on this conversation" },
      };
    case "stale":
      return {
        status: 409,
        body: { status: outcome.status, error: "This budget pause was already settled", pauseId: outcome.pauseId },
      };
    case "too_low":
      return {
        status: 422,
        body: {
          status: outcome.status,
          error:
            outcome.limitedBy === "goal"
              ? `The goal's budget leaves $${outcome.maxCostDollars.toFixed(4)} for this turn, which has spent $${outcome.spentDollars.toFixed(4)} — raise the goal's budget`
              : `A $${outcome.maxCostDollars} cap is no higher than the $${outcome.spentDollars.toFixed(4)} already spent`,
          pauseId: outcome.pauseId,
          spentDollars: outcome.spentDollars,
          maxCostDollars: outcome.maxCostDollars,
          limitedBy: outcome.limitedBy,
        },
      };
  }
}

export async function handleConversationBudgetPatch(req: Request, res: Response): Promise<void> {
  const conversationId = req.params.id as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const maxCostDollars = body.maxCostDollars;
  if (typeof maxCostDollars !== "number" || !Number.isFinite(maxCostDollars) || maxCostDollars <= 0) {
    res.status(400).json({ error: "maxCostDollars must be a positive number of dollars" });
    return;
  }
  try {
    const outcome = await AgenticLoopService.raiseBudget(
      conversationId,
      { turnCapDollars: maxCostDollars },
      { username: req.username },
    );
    if (outcome.status === "raised") {
      logger.info(
        `[ConversationBudget] ${conversationId}: cap raised to $${maxCostDollars} (pause ${outcome.pauseId}, delivered: ${outcome.delivered})`,
      );
    }
    const response = budgetRaiseResponse(outcome);
    res.status(response.status).json(response.body);
  } catch (error: unknown) {
    logger.error(`[ConversationBudget] Could not raise the cap of ${conversationId}: ${getErrorMessage(error)}`);
    res.status(500).json({ error: "Could not raise the budget" });
  }
}

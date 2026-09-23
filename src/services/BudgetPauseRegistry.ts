/**
 * BudgetPauseRegistry — the turns paused at their cost cap (prompt 13,
 * Landing 3).
 *
 * A turn whose delegation tree reached its cap does not end: it parks on its
 * user, like an approval, until the cap is raised or the turn is stopped.
 * The pause is a `budget` record in PendingDecisionStore, filed under the
 * ROOT turn's loop key (a sub-agent's spend pauses its whole tree, and the
 * card belongs to the conversation the user holds), written before the
 * `budget_reached` event goes out. A raise is a conditional write on it —
 * exactly once; a second raise of a settled pause is stale — and wakes this
 * process's waiter when the turn runs here. After a restart the raise is
 * stored (`delivered: false`) and the re-driven turn applies it when it
 * reaches the cap again.
 *
 * One pause per loop at a time. No timeout: it waits until the user raises
 * the cap, or the turn ends (stopped).
 */
import crypto from "node:crypto";
import PendingDecisionStore, {
  type BudgetLimit,
  type DecisionOwner,
  type PendingDecisionRecord,
  type StoredBudgetDecision,
} from "#src/services/PendingDecisionStore";
import ConversationRunState, { locatorFor } from "#src/services/conversation/ConversationRunState";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { BudgetPauseInfo } from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";

const BUDGET_KINDS = ["budget"] as const;

/** A raise of the pause's caps: the turn's, the goal's (null: no goal cap), or both. */
export interface BudgetRaiseInput {
  turnCapDollars?: number;
  goalMaxCostDollars?: number | null;
}

export type BudgetRaiseOutcome =
  | {
      status: "raised";
      pauseId: string;
      /** The ceiling the tree now runs under. Null: nothing caps it any more. */
      maxCostDollars: number | null;
      spentDollars: number;
      /** A turn running in this process took the raise. False after a restart: stored for the re-driven turn. */
      delivered: boolean;
    }
  /** The new ceiling is no higher than what the tree has spent: the turn stays paused. */
  | { status: "too_low"; pauseId: string; spentDollars: number; maxCostDollars: number; limitedBy: BudgetLimit }
  /** Nothing is paused on this loop. */
  | { status: "not_found" }
  /** Another request settled the pause first. */
  | { status: "stale"; pauseId: string };

/** A pending pause as a reloaded client shows it. */
export interface PendingBudgetSnapshot {
  pauseId: string;
  spentDollars: number;
  maxCostDollars: number;
  limitedBy: BudgetLimit;
  turnCapDollars: number | null;
  goalMaxCostDollars: number | null;
  iteration: number | null;
  since: string;
}

export interface OpenedBudgetPause {
  pauseId: string;
  decision: Promise<StoredBudgetDecision>;
  /** A raise stored while no turn ran (after a restart): applied now, nothing to show. */
  decidedWhileAway: boolean;
}

interface PauseWaiter {
  pauseId: string;
  owner: DecisionOwner;
  resolve: (decision: StoredBudgetDecision) => void;
}

/** loopKey → the waiter of the pause its turn, running in this process, sits in. */
const waiters = new Map<string, PauseWaiter>();

function recordId(loopKey: string, pauseId: string): string {
  return `${loopKey}/budget/${pauseId}`;
}

/** The ceiling a raise would give the pause: the lower of the turn's cap and the goal's remainder. */
function ceilingAfter(
  record: PendingDecisionRecord,
  input: BudgetRaiseInput,
): { maxCostDollars: number; limitedBy: BudgetLimit } {
  const turnCap =
    input.turnCapDollars !== undefined ? input.turnCapDollars : (record.turnCapDollars ?? null);
  const goalMax =
    input.goalMaxCostDollars !== undefined ? input.goalMaxCostDollars : (record.goalMaxCostDollars ?? null);
  const goalRemainder =
    goalMax === null ? Infinity : goalMax - (record.goalSpentBeforeTurnDollars ?? 0);
  const turnCeiling = turnCap ?? Infinity;
  return goalRemainder < turnCeiling
    ? { maxCostDollars: goalRemainder, limitedBy: "goal" }
    : { maxCostDollars: turnCeiling, limitedBy: "turn" };
}

function snapshotOf(record: PendingDecisionRecord): PendingBudgetSnapshot {
  return {
    pauseId: record.itemId,
    spentDollars: record.spentDollars ?? 0,
    maxCostDollars: record.maxCostDollars ?? 0,
    limitedBy: record.limitedBy ?? "turn",
    turnCapDollars: record.turnCapDollars ?? null,
    goalMaxCostDollars: record.goalMaxCostDollars ?? null,
    iteration: record.iteration ?? null,
    since: record.createdAt,
  };
}

/** Drop a loop's waiter and un-park its conversation. */
function release(loopKey: string): PauseWaiter | undefined {
  const waiter = waiters.get(loopKey);
  if (!waiter) return undefined;
  waiters.delete(loopKey);
  void ConversationRunState.unpark(locatorFor(loopKey, waiter.owner));
  return waiter;
}

/**
 * Hold a waiter for the loop's pause and park its conversation. The decision
 * comes back wrapped: an async function returning a bare promise would make
 * `await park()` wait for the decision itself.
 */
async function park(
  loopKey: string,
  pauseId: string,
  owner: DecisionOwner,
): Promise<{ decision: Promise<StoredBudgetDecision> }> {
  let resolve!: PauseWaiter["resolve"];
  const decision = new Promise<StoredBudgetDecision>((settle) => {
    resolve = settle;
  });
  // One pause per loop: a waiter left from an earlier one is over.
  release(loopKey)?.resolve({ action: "stop", source: "superseded" });
  waiters.set(loopKey, { pauseId, owner, resolve });
  await ConversationRunState.park(locatorFor(loopKey, owner));
  return { decision };
}

/** End every pending pause of a loop without a raise; its waiter stops. */
async function lapse(
  loopKey: string,
  source: "superseded" | "turn_ended",
): Promise<PendingDecisionRecord[]> {
  release(loopKey)?.resolve({ action: "stop", source });
  try {
    return await PendingDecisionStore.settleAll({ loopKey, kinds: BUDGET_KINDS }, () => ({
      status: "cancelled",
    }));
  } catch (error: unknown) {
    logger.warn(`[BudgetPauseRegistry] Could not close the pauses of ${loopKey}: ${getErrorMessage(error)}`);
    return [];
  }
}

const BudgetPauseRegistry = {
  /**
   * Record a pause and park the loop on it: the promise resolves when the
   * cap is raised (or the turn ends). Call BEFORE the `budget_reached`
   * event goes out — a raise can only land on a pause that exists.
   *
   * `resume`: the turn was re-driven after a restart — the pause it was in
   * is picked up again (same id, no new card), and a raise stored while no
   * turn ran is applied at once.
   */
  async open(
    loopKey: string,
    info: BudgetPauseInfo,
    owner: DecisionOwner = {},
    { resume = false }: { resume?: boolean } = {},
  ): Promise<OpenedBudgetPause> {
    if (resume) {
      const newest = (await PendingDecisionStore.find({ loopKey, kinds: BUDGET_KINDS })).at(-1);
      if (newest?.status === "pending") {
        logger.info(`[BudgetPauseRegistry] Re-driven turn ${loopKey} is paused again on ${newest.itemId}`);
        return {
          pauseId: newest.itemId,
          decision: (await park(loopKey, newest.itemId, owner)).decision,
          decidedWhileAway: false,
        };
      }
      if (
        newest?.status === "decided" &&
        newest.delivered === false &&
        newest.budgetDecision?.action === "raise"
      ) {
        await PendingDecisionStore.update(newest.id, { delivered: true });
        logger.info(`[BudgetPauseRegistry] Re-driven turn ${loopKey} takes the raise stored while it was down`);
        return {
          pauseId: newest.itemId,
          decision: Promise.resolve(newest.budgetDecision),
          decidedWhileAway: true,
        };
      }
    }
    await lapse(loopKey, "superseded");
    const pauseId = crypto.randomUUID();
    await PendingDecisionStore.insert([
      {
        ...owner,
        id: recordId(loopKey, pauseId),
        loopKey,
        kind: "budget",
        itemId: pauseId,
        batchId: null,
        position: 0,
        status: "pending",
        createdAt: new Date().toISOString(),
        spentDollars: info.spentDollars,
        maxCostDollars: info.maxCostDollars,
        limitedBy: info.limitedBy,
        turnCapDollars: info.turnCapDollars,
        goalMaxCostDollars: info.goalMaxCostDollars,
        goalSpentBeforeTurnDollars: info.goalSpentBeforeTurnDollars,
        iteration: info.iteration,
      },
    ]);
    return { pauseId, decision: (await park(loopKey, pauseId, owner)).decision, decidedWhileAway: false };
  },

  /**
   * Raise the cap of the pause on this loop. Refused (`too_low`) when the
   * ceiling it gives is no higher than the spend — the turn would pause
   * again at once. Exactly once per pause.
   */
  async raise(loopKey: string, input: BudgetRaiseInput): Promise<BudgetRaiseOutcome> {
    const record = await BudgetPauseRegistry.getPendingRecord(loopKey);
    if (!record) return { status: "not_found" };
    const spentDollars = record.spentDollars ?? 0;
    const ceiling = ceilingAfter(record, input);
    if (ceiling.maxCostDollars <= spentDollars) {
      return { status: "too_low", pauseId: record.itemId, spentDollars, ...ceiling };
    }

    const decision: StoredBudgetDecision = {
      action: "raise",
      source: "user",
      ...(input.turnCapDollars !== undefined && { turnCapDollars: input.turnCapDollars }),
      ...(input.goalMaxCostDollars !== undefined && { goalMaxCostDollars: input.goalMaxCostDollars }),
    };
    const waiter = waiters.get(loopKey);
    const isWaiting = waiter?.pauseId === record.itemId;
    const won = await PendingDecisionStore.settle(record.id, {
      status: "decided",
      budgetDecision: decision,
      delivered: isWaiting,
    });
    if (!won) return { status: "stale", pauseId: record.itemId };

    if (isWaiting) {
      release(loopKey)?.resolve(decision);
    } else if (!(await PendingDecisionStore.isParked(loopKey))) {
      // No turn here was waiting (the process that paused is gone): nothing
      // is awaited any more; the raise waits for the re-driven turn.
      await ConversationRunState.clear(locatorFor(loopKey, record));
    }
    return {
      status: "raised",
      pauseId: record.itemId,
      maxCostDollars: Number.isFinite(ceiling.maxCostDollars) ? ceiling.maxCostDollars : null,
      spentDollars,
      delivered: isWaiting,
    };
  },

  /** The pending pause on this loop, as stored (with its owner). */
  async getPendingRecord(loopKey: string): Promise<PendingDecisionRecord | null> {
    const pending = await PendingDecisionStore.find({ loopKey, kinds: BUDGET_KINDS, status: "pending" });
    return pending.at(-1) ?? null;
  },

  /** The pending pause on this loop, as a reloaded client shows it. */
  async getPending(loopKey: string): Promise<PendingBudgetSnapshot | null> {
    const record = await BudgetPauseRegistry.getPendingRecord(loopKey);
    return record ? snapshotOf(record) : null;
  },

  /** The turn is over (ended, or stopped): its pause lapses unraised. */
  async cancel(loopKey: string): Promise<PendingDecisionRecord[]> {
    return lapse(loopKey, "turn_ended");
  },

  /**
   * A new turn starts on this loop: a pause still pending from a turn that
   * is not running here (it died with a previous process) will never be
   * raised into this one — close it. A live pause is left alone.
   */
  async retireOrphans(loopKey: string): Promise<PendingDecisionRecord[]> {
    if (waiters.has(loopKey)) return [];
    return lapse(loopKey, "superseded");
  },

  /** Test helper — forget every waiter (the store keeps its records). */
  _clearAll(): void {
    waiters.clear();
  },
};

export default BudgetPauseRegistry;

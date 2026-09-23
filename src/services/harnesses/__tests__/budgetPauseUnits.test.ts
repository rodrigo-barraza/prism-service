/**
 * budgetPauseUnits.test.ts — prompt 13, Landing 3, piece by piece:
 *
 *   - SharedCostBudget: the ceiling is the lower of the turn's cap and the
 *     goal's remainder; a raise lifts either; a restart's spend is carried;
 *     every loop of the tree that reaches the cap waits on ONE pause.
 *   - enforceCostBudget: under the cap nothing happens; at it the loop
 *     pauses and carries on after a raise that lifts the cap (pauses again
 *     after one that does not); with nobody to ask it stops as before.
 *   - BudgetPauseRegistry: a raise is exactly once, never below the spend,
 *     and — with no turn to take it — stored for the re-driven turn.
 *   - resolveBudgetAction: who pauses and who stops.
 *
 * The end-to-end behaviour (a real loop, routes, restarts) is
 * budgetPause.test.ts's.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SharedCostBudget,
  enforceCostBudget,
  type BudgetPauseInfo,
  type BudgetResolution,
} from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";
import BudgetPauseRegistry from "#src/services/BudgetPauseRegistry";
import PendingDecisionStore from "#src/services/PendingDecisionStore";
import AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext } from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// 100 input tokens = $1.00.
vi.mock("#src/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/config")>();
  return {
    ...original,
    getPricing: () => ({ "test-model": { inputPerMillion: 10_000, outputPerMillion: 0 } }),
  };
});

const PAUSE_INFO: BudgetPauseInfo = {
  spentDollars: 2,
  maxCostDollars: 1.5,
  limitedBy: "turn",
  turnCapDollars: 1.5,
  goalMaxCostDollars: null,
  goalSpentBeforeTurnDollars: null,
  iteration: 2,
};

function loopAt(dollars: number, budget: SharedCostBudget, loopId = "root", signal?: AbortSignal) {
  const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive: false });
  state.iterations = 2;
  state.overallUsage.inputTokens = dollars * 100;
  const emit = vi.fn();
  const context = {
    resolvedModel: "test-model",
    agentConversationId: loopId,
    options: { _sharedCostBudget: budget },
    emit,
    signal,
  } as unknown as AgenticContext;
  return { state, context, emit };
}

describe("SharedCostBudget", () => {
  it("runs under the lower of the turn's cap and what is left of the goal's budget, and says which binds", () => {
    const budget = new SharedCostBudget({
      turnCapDollars: 5,
      goal: { maxCostDollars: 3, spentBeforeTurnDollars: 1 },
    });
    expect(budget.maxCostDollars).toBe(2);
    expect(budget.limitedBy()).toBe("goal");

    budget.apply({ action: "raise", source: "user", goalMaxCostDollars: 10 });
    expect(budget.maxCostDollars).toBe(5);
    expect(budget.limitedBy()).toBe("turn");

    budget.apply({ action: "raise", source: "user", turnCapDollars: 7, goalMaxCostDollars: null });
    expect(budget.maxCostDollars).toBe(7);
    expect(budget.goalLimit).toBeNull();
  });

  it("a number is the turn's cap (the pre-pause constructor still works); no cap is Infinity", () => {
    expect(new SharedCostBudget(1).maxCostDollars).toBe(1);
    expect(new SharedCostBudget({}).maxCostDollars).toBe(Infinity);
  });

  it("carries what a re-driven turn's previous process spent", () => {
    const budget = new SharedCostBudget(3, { carriedSpendDollars: 2 });
    budget.record("root", 0.5);
    expect(budget.totalSpentDollars()).toBe(2.5);
    budget.record("root", 1);
    expect(budget.isExceeded()).toBe(true);
  });

  it("every loop that reaches the cap waits on the same pause; a stopped loop stops waiting alone", async () => {
    const budget = new SharedCostBudget(1.5);
    let decide!: (resolution: BudgetResolution) => void;
    const pauser = vi.fn(() => new Promise<BudgetResolution>((resolve) => (decide = resolve)));
    budget.attachPauser(pauser);

    const stopSubAgent = new AbortController();
    const root = budget.pauseAtCap(PAUSE_INFO);
    const subAgent = budget.pauseAtCap(PAUSE_INFO, stopSubAgent.signal);
    const otherSubAgent = budget.pauseAtCap(PAUSE_INFO);
    expect(pauser).toHaveBeenCalledTimes(1);

    stopSubAgent.abort();
    await expect(subAgent).resolves.toEqual({ action: "stop" });

    decide({ action: "raise" });
    await expect(root).resolves.toEqual({ action: "raise" });
    await expect(otherSubAgent).resolves.toEqual({ action: "raise" });

    // The next time the cap is reached is a new pause.
    void budget.pauseAtCap(PAUSE_INFO);
    expect(pauser).toHaveBeenCalledTimes(2);
  });

  it("with no pauser (a turn nobody can ask, or one that ended) a loop at the cap stops", async () => {
    const budget = new SharedCostBudget(1.5);
    expect(budget.canPause).toBe(false);
    await expect(budget.pauseAtCap(PAUSE_INFO)).resolves.toEqual({ action: "stop" });
    budget.attachPauser(vi.fn());
    budget.detachPauser();
    await expect(budget.pauseAtCap(PAUSE_INFO)).resolves.toEqual({ action: "stop" });
  });
});

describe("enforceCostBudget", () => {
  it("under the cap: carries on, no pause", async () => {
    const budget = new SharedCostBudget(1.5);
    const pauser = vi.fn();
    budget.attachPauser(pauser);
    const { state, context } = loopAt(1, budget);
    await expect(enforceCostBudget(context, state)).resolves.toBe(false);
    expect(pauser).not.toHaveBeenCalled();
    expect(state.conversationOutcome).not.toBe("budget_exhausted");
  });

  it("at the cap: pauses once (after beforePause) and carries on when the raise lifts the cap", async () => {
    const budget = new SharedCostBudget(1.5);
    const order: string[] = [];
    budget.attachPauser(async (info) => {
      order.push(`pause $${info.spentDollars} of $${info.maxCostDollars} (${info.limitedBy})`);
      budget.apply({ action: "raise", source: "user", turnCapDollars: 5 });
      return { action: "raise" };
    });
    const { state, context, emit } = loopAt(2, budget);
    const stop = await enforceCostBudget(context, state, {
      beforePause: async () => {
        order.push("checkpoint");
      },
    });
    expect(stop).toBe(false);
    expect(order).toEqual(["checkpoint", "pause $2 of $1.5 (turn)"]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a raise that leaves the spend at the cap pauses again; a stop ends the loop with the budget reason", async () => {
    const budget = new SharedCostBudget(1.5);
    const resolutions: BudgetResolution[] = [{ action: "raise" }, { action: "stop" }];
    const pauser = vi.fn(async () => resolutions.shift()!);
    budget.attachPauser(pauser);
    const beforePause = vi.fn(async () => {});
    const { state, context, emit } = loopAt(2, budget);

    await expect(enforceCostBudget(context, state, { beforePause })).resolves.toBe(true);
    expect(pauser).toHaveBeenCalledTimes(2);
    expect(beforePause).toHaveBeenCalledTimes(1);
    expect(state.conversationOutcome).toBe("budget_exhausted");
    expect(state.costBudgetStop).toEqual({ spentDollars: 2, maxCostDollars: 1.5 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ message: "cost_limit_reached" }));
  });

  it("with nobody to ask: stops at the cap as before, without pausing", async () => {
    const budget = new SharedCostBudget(1.5);
    const beforePause = vi.fn(async () => {});
    const { state, context } = loopAt(2, budget);
    await expect(enforceCostBudget(context, state, { beforePause })).resolves.toBe(true);
    expect(beforePause).not.toHaveBeenCalled();
    expect(state.conversationOutcome).toBe("budget_exhausted");
  });
});

describe("BudgetPauseRegistry", () => {
  beforeEach(() => {
    BudgetPauseRegistry._clearAll();
    PendingDecisionStore._clearMemory();
  });

  it("a raise below the spend is refused and the turn stays paused; an adequate one is taken exactly once", async () => {
    const opened = await BudgetPauseRegistry.open("loop-a", PAUSE_INFO);
    let decided: unknown = null;
    void opened.decision.then((decision) => (decided = decision));

    await expect(BudgetPauseRegistry.raise("loop-a", { turnCapDollars: 2 })).resolves.toMatchObject({
      status: "too_low",
      spentDollars: 2,
      maxCostDollars: 2,
      limitedBy: "turn",
    });
    expect(await BudgetPauseRegistry.getPending("loop-a")).toMatchObject({ pauseId: opened.pauseId });

    const [first, second] = await Promise.all([
      BudgetPauseRegistry.raise("loop-a", { turnCapDollars: 5 }),
      BudgetPauseRegistry.raise("loop-a", { turnCapDollars: 6 }),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes[0]).toBe("raised");
    expect(["not_found", "stale"]).toContain(outcomes[1]);
    await Promise.resolve();
    expect(decided).toMatchObject({ action: "raise", source: "user" });
    expect(await BudgetPauseRegistry.getPending("loop-a")).toBeNull();
  });

  it("the goal's remainder can be what binds: a turn raise does not lift it, a goal raise does", async () => {
    await BudgetPauseRegistry.open("loop-goal", {
      ...PAUSE_INFO,
      limitedBy: "goal",
      turnCapDollars: null,
      goalMaxCostDollars: 2.5,
      goalSpentBeforeTurnDollars: 1,
    });
    await expect(BudgetPauseRegistry.raise("loop-goal", { turnCapDollars: 10 })).resolves.toMatchObject({
      status: "too_low",
      limitedBy: "goal",
      maxCostDollars: 1.5,
    });
    await expect(BudgetPauseRegistry.raise("loop-goal", { goalMaxCostDollars: null })).resolves.toMatchObject({
      status: "raised",
      maxCostDollars: null,
    });
  });

  it("a raise with no turn to take it is stored; the re-driven turn takes it without a new pause", async () => {
    const opened = await BudgetPauseRegistry.open("loop-b", PAUSE_INFO);
    BudgetPauseRegistry._clearAll(); // the process that paused is gone

    await expect(BudgetPauseRegistry.raise("loop-b", { turnCapDollars: 5 })).resolves.toMatchObject({
      status: "raised",
      delivered: false,
    });
    const resumed = await BudgetPauseRegistry.open("loop-b", PAUSE_INFO, {}, { resume: true });
    expect(resumed).toMatchObject({ pauseId: opened.pauseId, decidedWhileAway: true });
    await expect(resumed.decision).resolves.toMatchObject({ action: "raise", turnCapDollars: 5 });

    // Taken once: the next re-drive that reaches the cap asks again.
    const again = await BudgetPauseRegistry.open("loop-b", PAUSE_INFO, {}, { resume: true });
    expect(again.decidedWhileAway).toBe(false);
    expect(again.pauseId).not.toBe(opened.pauseId);
  });

  it("a re-driven turn still paused picks up the same pause", async () => {
    const opened = await BudgetPauseRegistry.open("loop-c", PAUSE_INFO);
    BudgetPauseRegistry._clearAll();
    const resumed = await BudgetPauseRegistry.open("loop-c", PAUSE_INFO, {}, { resume: true });
    expect(resumed).toMatchObject({ pauseId: opened.pauseId, decidedWhileAway: false });
    await expect(BudgetPauseRegistry.raise("loop-c", { turnCapDollars: 5 })).resolves.toMatchObject({
      delivered: true,
    });
    await expect(resumed.decision).resolves.toMatchObject({ action: "raise" });
  });

  it("the end of the turn stops its wait; a new turn retires a dead turn's pause but not a live one", async () => {
    const live = await BudgetPauseRegistry.open("loop-d", PAUSE_INFO);
    expect(await BudgetPauseRegistry.retireOrphans("loop-d")).toEqual([]);
    await BudgetPauseRegistry.cancel("loop-d");
    await expect(live.decision).resolves.toEqual({ action: "stop", source: "turn_ended" });
    expect(await BudgetPauseRegistry.getPending("loop-d")).toBeNull();

    await BudgetPauseRegistry.open("loop-e", PAUSE_INFO);
    BudgetPauseRegistry._clearAll();
    const retired = await BudgetPauseRegistry.retireOrphans("loop-e");
    expect(retired.map((record) => record.kind)).toEqual(["budget"]);
    await expect(BudgetPauseRegistry.raise("loop-e", { turnCapDollars: 5 })).resolves.toEqual({
      status: "not_found",
    });
  });
});

describe("resolveBudgetAction — who pauses at the cap", () => {
  it("pauses by default; stops when the request says nobody answers; an explicit choice wins", async () => {
    const { resolveBudgetAction } = await import("#src/services/AgenticLoopService");
    expect(resolveBudgetAction({})).toBe("pause");
    expect(resolveBudgetAction({ autoApprove: true })).toBe("stop");
    expect(resolveBudgetAction({ unattended: true })).toBe("stop");
    expect(resolveBudgetAction({ autoApprove: true, onBudgetReached: "pause" })).toBe("pause");
    expect(resolveBudgetAction({ onBudgetReached: "stop" })).toBe("stop");
  });
});

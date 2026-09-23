import ConversationGoalService, {
  GOAL_PAUSE_REASONS,
  GOAL_STATUSES,
  GOAL_VERDICTS,
  describeBudgetExhaustion,
  effectiveRubric,
  goalMaxIterations,
  resolveGoalConversationId,
  type ConversationGoal,
  type GoalCriterion,
  type GoalPauseInput,
  type GoalTurnSpend,
  type GoalVerification,
} from "#src/services/ConversationGoalService";
import { verifyGoal, type VerifierUsage } from "#src/services/goals/GoalVerifier";
import TurnInputMailbox, { type TurnInputPost } from "#src/services/TurnInputMailbox";
import { resolveLoopKey } from "#src/services/LoopKey";
import { SharedCostBudget } from "./CostBudgetEnforcer.ts";
import { buildTurnInputMessage, drainTurnInput } from "./TurnInputDrain.ts";
import { calculateTextCost } from "#src/utils/CostCalculator";
import {
  CapabilityScopeHandle,
  GOAL_SCOPE_KEY,
  describeScope,
  scopeFromDeclaration,
} from "#src/services/permissions/CapabilityScope";
import { getPricing, MODALITY_TYPES } from "#src/config";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, ConversationMessage } from "#src/services/harnesses/types";

/**
 * GoalGate — a conversation goal is done when an independent verifier says
 * so, and the agent keeps working until then.
 *
 * A root turn of a conversation with a goal opens a `GoalRun`. Where the
 * turn would end on a text answer while the goal is active (the agent's
 * claim — `update_goal` status completed, or just finishing), the run asks
 * the verifier (goals/GoalVerifier) about the rubric:
 *
 *   satisfied       → the goal is completed; the turn ends
 *   needs_revision  → the failing criteria and their evidence gaps go to the
 *                     agent's mailbox and the loop continues — at most
 *                     `maxIterations` verdicts, then the goal pauses
 *   failed          → the rubric contradicts the task: pause, ask the user
 *
 * While it works on its own (a verdict sent it back), the run is narrowed to
 * the goal's declared `capabilities` — `{ network: false }` — on top of
 * whatever it already had (permissions/CapabilityScope): the approval engine
 * refuses a tool outside them for the rest of the turn.
 *
 * Breakers, each a pause with its reason: the budget (main loop, sub-agents
 * and the verifier all count), `max_iterations`, three empty continuations
 * in a row (no tool use: nothing new to verify, so no verifier call either),
 * a user message arriving while the agent works on its own (the user takes
 * the wheel), a verdict that does not parse twice (`failed`), and a restart
 * (ConversationGoalService.pauseInterruptedRuns).
 *
 * The run also owns the turn's spend: it keeps a SharedCostBudget on the
 * turn's options (uncapped unless the request capped it) so every
 * sub-agent's loop records into it, and books main loop + sub-agents +
 * verifier on the goal at afterResponse (GoalTurnSpend). A detached
 * sub-agent still spending after its turn was booked is booked when the
 * conversation's next turn opens.
 */

/** Continuations in a row with no tool use before the goal pauses. */
export const MAXIMUM_EMPTY_GOAL_CONTINUATIONS = 3;
/** `status` message: the verifier is judging a done claim. */
export const GOAL_VERIFYING_STATUS = "goal_verifying";

/** Earlier runs whose budgets a detached sub-agent may still be recording into. */
const EARLIER_RUNS_PER_CONVERSATION = 3;
const MAXIMUM_TRACKED_CONVERSATIONS = 500;
const earlierRuns = new Map<string, GoalRun[]>();

function rememberRun(run: GoalRun): void {
  const runs = earlierRuns.get(run.conversationId) ?? [];
  if (!runs.includes(run)) runs.push(run);
  while (runs.length > EARLIER_RUNS_PER_CONVERSATION) runs.shift();
  earlierRuns.delete(run.conversationId);
  earlierRuns.set(run.conversationId, runs);
  while (earlierRuns.size > MAXIMUM_TRACKED_CONVERSATIONS) {
    const oldest = earlierRuns.keys().next().value;
    if (oldest === undefined) break;
    earlierRuns.delete(oldest);
  }
}

/** What the harness does at a text-only end. */
export type GoalGateOutcome =
  | { action: "end" }
  /** Keep going: the gate's input is queued; push the answer, then drain. */
  | { action: "continue"; input: TurnInputPost };

interface GoalScope {
  conversationId: string;
  project: string;
  username: string;
}

function criteriaById(goal: ConversationGoal): Map<string, GoalCriterion> {
  return new Map(
    [...effectiveRubric(goal), ...(goal.stepRubric ?? [])].map((criterion) => [criterion.id, criterion]),
  );
}

/** The gaps, for the agent: each failing criterion with what is missing. */
export function formatRevisionRequest(
  goal: ConversationGoal,
  verification: GoalVerification,
  maxIterations: number,
): string {
  const byId = criteriaById(goal);
  const failing = verification.criteria.filter((result) => !result.pass);
  const met = verification.criteria.filter((result) => result.pass).map((result) => result.id);
  return [
    `The independent verifier checked your work against the goal's rubric (round ${verification.iteration} of ${maxIterations}): it is not done yet.`,
    "",
    "Not met:",
    ...failing.map(
      (result) => `- [${result.id}] ${byId.get(result.id)?.criterion ?? ""} — ${result.evidence}`,
    ),
    ...(met.length > 0 ? ["", `Met: ${met.join(", ")}`] : []),
    "",
    "Fix what is not met and check it with tools; only tool results count as evidence. Then finish with a final answer that points at that evidence. " +
      'If you cannot go on without the user, call update_goal with status "blocked" and say what you need.',
  ].join("\n");
}

/** The nudge after a continuation that did nothing. */
export function formatEmptyContinuationNudge(
  goal: ConversationGoal,
  verification: GoalVerification | null | undefined,
  emptyCount: number,
): string {
  const byId = criteriaById(goal);
  const failing = (verification?.criteria ?? []).filter((result) => !result.pass);
  return [
    `You ended your turn again without using a tool, so there is nothing new for the verifier to check (${emptyCount} of ${MAXIMUM_EMPTY_GOAL_CONTINUATIONS} — then the goal pauses).`,
    ...(failing.length > 0
      ? [
          "Still not met:",
          ...failing.map(
            (result) => `- [${result.id}] ${byId.get(result.id)?.criterion ?? ""} — ${result.evidence}`,
          ),
        ]
      : []),
    'Act on it with tools, or call update_goal with status "blocked" if you need the user.',
  ].join("\n");
}

export class GoalRun implements GoalTurnSpend {
  readonly conversationId: string;
  private readonly project: string;
  private readonly username: string;
  private readonly budget: SharedCostBudget | null;
  private readonly rootLoopId: string;
  private readonly verifierLoopId: string;
  private verifierSpentDollars = 0;
  private bookedDollars = 0;
  /** The harness is working on the goal on its own (a verdict sent it back). */
  private continuing = false;
  private continuationStartedAt = 0;
  private toolCallsAtContinuation = 0;
  private consecutiveEmptyContinuations = 0;
  private lastVerification: GoalVerification | null = null;
  private readonly context: AgenticContext;
  private readonly state: AgenticLoopState;

  private constructor(
    context: AgenticContext,
    state: AgenticLoopState,
    scope: GoalScope,
    budget: SharedCostBudget | null,
  ) {
    this.context = context;
    this.state = state;
    this.conversationId = scope.conversationId;
    this.project = scope.project;
    this.username = scope.username;
    this.budget = budget;
    this.rootLoopId = (context.agentConversationId as string) || "root";
    this.verifierLoopId = `goal-verifier:${this.rootLoopId}`;
  }

  /**
   * Open the run of a ROOT turn (sub-agents share their parent's goal and
   * never verify). Null without a conversation scope. A turn whose goal is
   * active gets a tree-wide SharedCostBudget, so sub-agent spend counts.
   */
  static async open(context: AgenticContext, state: AgenticLoopState): Promise<GoalRun | null> {
    const options = context.options as AgenticContext["options"] & {
      _goalRun?: GoalRun | null;
    };
    if (options.isSubAgent || context.parentAgentConversationId) return null;
    const conversationId = resolveGoalConversationId({
      conversationId: context.conversationId as string | undefined,
      agentConversationId: context.agentConversationId as string | undefined,
    });
    if (!conversationId || !context.project || !context.username) return null;
    const scope = { conversationId, project: context.project, username: context.username };

    let goal: ConversationGoal | null = null;
    try {
      goal = await ConversationGoalService.get(conversationId, scope.project, scope.username);
    } catch (error: unknown) {
      logger.warn(`[GoalGate] Could not read the goal of ${conversationId}: ${getErrorMessage(error)}`);
    }

    let budget = options._sharedCostBudget ?? null;
    if (goal?.status === GOAL_STATUSES.ACTIVE && !budget) {
      budget = new SharedCostBudget(Number.POSITIVE_INFINITY);
      options._sharedCostBudget = budget;
    }
    const run = new GoalRun(context, state, scope, budget);
    options._goalRun = run;
    if (goal) await run.bookEarlierLateSpend();
    return run;
  }

  // ─── Spend ──────────────────────────────────────────────────

  private rootCostDollars(): number {
    const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
      this.context.resolvedModel as string
    ];
    const usage = { ...this.state.overallUsage, requests: this.state.iterations };
    return calculateTextCost(usage, pricing) ?? 0;
  }

  /** This turn's spend so far: main loop, its sub-agents, the verifier. */
  spentDollars(): number {
    const root = this.rootCostDollars();
    if (!this.budget) return root + this.verifierSpentDollars;
    // The root's cost only grows, so its latest reading replaces the last.
    this.budget.record(this.rootLoopId, root);
    this.budget.record(this.verifierLoopId, this.verifierSpentDollars);
    return this.budget.totalSpentDollars();
  }

  bookTurnSpend(): number {
    const total = this.spentDollars();
    const unbooked = Math.max(0, total - this.bookedDollars);
    this.bookedDollars = total;
    if (this.budget) rememberRun(this);
    return unbooked;
  }

  /** Spend a detached sub-agent recorded after an earlier turn was booked. */
  private async bookEarlierLateSpend(): Promise<void> {
    const runs = earlierRuns.get(this.conversationId);
    if (!runs) return;
    let late = 0;
    for (const run of runs) {
      if (!run.budget) continue;
      const total = run.budget.totalSpentDollars();
      if (total > run.bookedDollars) {
        late += total - run.bookedDollars;
        run.bookedDollars = total;
      }
    }
    if (late <= 0) return;
    try {
      await ConversationGoalService.recordLateSpend(this.conversationId, this.project, this.username, late);
      logger.info(`[GoalGate] Booked $${late.toFixed(4)} of late sub-agent spend on the goal of ${this.conversationId}`);
    } catch (error: unknown) {
      logger.warn(`[GoalGate] Could not book late spend: ${getErrorMessage(error)}`);
    }
  }

  // ─── The gate ───────────────────────────────────────────────

  private emit(event: Record<string, unknown>): void {
    try {
      this.context.emit(event as never);
    } catch {
      /* the stream may be gone */
    }
  }

  private async pause(pause: GoalPauseInput): Promise<void> {
    logger.info(`[GoalGate] Goal of ${this.conversationId} paused: ${pause.reason}${pause.detail ? ` — ${pause.detail}` : ""}`);
    await ConversationGoalService.pause(this.conversationId, this.project, this.username, pause, {
      emit: this.context.emit as never,
    });
  }

  private budgetExhaustion(goal: ConversationGoal): string | null {
    return describeBudgetExhaustion({
      ...goal,
      spentDollars: goal.spentDollars + this.spentDollars(),
    });
  }

  /** A user message reached the loop since the harness began working on its own. */
  private userSpokeSinceContinuing(messages: readonly ConversationMessage[]): boolean {
    if (!this.continuing) return false;
    return messages.some((message) => {
      const turnInput = (message as { _turnInput?: { kind?: string; receivedAt?: number } })._turnInput;
      return (
        turnInput?.kind === "user_update" &&
        typeof turnInput.receivedAt === "number" &&
        turnInput.receivedAt >= this.continuationStartedAt
      );
    });
  }

  /**
   * The turn would end on `finalAnswer`. Decide whether it may: `end`, or
   * `continue` with the input the gate queued for the agent.
   */
  async atTextEnd(
    messages: readonly ConversationMessage[],
    finalAnswer: string,
  ): Promise<GoalGateOutcome> {
    try {
      return await this.decide(messages, finalAnswer);
    } catch (error: unknown) {
      // The gate must never be why a turn fails: it ends as it would have.
      logger.error(`[GoalGate] Verification of ${this.conversationId} failed: ${getErrorMessage(error)}`);
      return { action: "end" };
    }
  }

  private async decide(
    messages: readonly ConversationMessage[],
    finalAnswer: string,
  ): Promise<GoalGateOutcome> {
    if (this.context.signal?.aborted) return { action: "end" };
    const goal = await ConversationGoalService.get(this.conversationId, this.project, this.username);
    if (!goal || goal.status !== GOAL_STATUSES.ACTIVE) return { action: "end" };

    if (this.userSpokeSinceContinuing(messages)) {
      await this.pause({
        reason: GOAL_PAUSE_REASONS.USER_MESSAGE,
        detail: "You sent a message while the agent was working on the goal on its own.",
      });
      return { action: "end" };
    }

    const exhaustedBefore = this.budgetExhaustion(goal);
    if (exhaustedBefore) {
      await this.pause({ reason: GOAL_PAUSE_REASONS.BUDGET, detail: exhaustedBefore });
      return { action: "end" };
    }

    // A continuation that used no tool has no new evidence: no verdict,
    // a firmer nudge, and after three in a row the goal pauses.
    if (this.continuing && this.state.streamedToolCalls.length === this.toolCallsAtContinuation) {
      this.consecutiveEmptyContinuations++;
      if (this.consecutiveEmptyContinuations >= MAXIMUM_EMPTY_GOAL_CONTINUATIONS) {
        await this.pause({
          reason: GOAL_PAUSE_REASONS.EMPTY_CONTINUATIONS,
          detail: `${MAXIMUM_EMPTY_GOAL_CONTINUATIONS} continuations in a row ended without using a tool.`,
        });
        return { action: "end" };
      }
      return this.continueWith(
        goal,
        formatEmptyContinuationNudge(goal, this.lastVerification ?? goal.verification, this.consecutiveEmptyContinuations),
        { emptyContinuation: this.consecutiveEmptyContinuations },
      );
    }
    this.consecutiveEmptyContinuations = 0;

    const round = (goal.verificationRounds ?? 0) + 1;
    const maxIterations = goalMaxIterations(goal);
    this.emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: GOAL_VERIFYING_STATUS,
      round,
      maxIterations,
    });
    const result = await verifyGoal({
      goal,
      messages,
      finalAnswer,
      main: {
        provider: this.context.providerName as string | undefined,
        model: this.context.resolvedModel as string | undefined,
      },
      scope: {
        project: this.project,
        username: this.username,
        agent: this.context.agent as string | undefined,
        traceId: this.context.traceId as string | undefined,
        conversationId: this.conversationId,
        agentConversationId: this.context.agentConversationId as string | undefined,
        requestId: this.context.requestId as string | undefined,
      },
      signal: this.context.signal ?? null,
    });
    this.verifierSpentDollars += result.costDollars;
    this.emitVerifierUsage(result.costDollars, result.usage);

    if (!result.ok) {
      await this.pause({
        reason: GOAL_PAUSE_REASONS.FAILED,
        detail: `The verifier could not give a verdict (${result.error}).`,
      });
      return { action: "end" };
    }

    const verification: GoalVerification = {
      verdict: result.verdict.verdict,
      criteria: result.verdict.criteria,
      ...(result.verdict.reason && { reason: result.verdict.reason }),
      iteration: round,
      verifier: result.verifier,
      costDollars: result.costDollars,
      at: new Date().toISOString(),
    };
    this.lastVerification = verification;

    let pause: GoalPauseInput | null = null;
    if (verification.verdict === GOAL_VERDICTS.FAILED) {
      pause = {
        reason: GOAL_PAUSE_REASONS.FAILED,
        detail: verification.reason || "The verifier says the rubric cannot be met as written.",
      };
    } else if (verification.verdict === GOAL_VERDICTS.NEEDS_REVISION) {
      const exhaustedAfter = this.budgetExhaustion(goal);
      if (round >= maxIterations) {
        pause = {
          reason: GOAL_PAUSE_REASONS.MAX_ITERATIONS,
          detail: `The verifier asked for revisions ${round} time${round === 1 ? "" : "s"} (the limit).`,
        };
      } else if (exhaustedAfter) {
        pause = { reason: GOAL_PAUSE_REASONS.BUDGET, detail: exhaustedAfter };
      }
    }
    await ConversationGoalService.recordVerification(
      this.conversationId,
      this.project,
      this.username,
      verification,
      { pause, emit: this.context.emit as never },
    );
    if (verification.verdict !== GOAL_VERDICTS.NEEDS_REVISION || pause) return { action: "end" };

    return this.continueWith(goal, formatRevisionRequest(goal, verification, maxIterations), {
      goalRound: round,
    });
  }

  private async continueWith(
    goal: ConversationGoal,
    text: string,
    meta: Record<string, unknown>,
  ): Promise<GoalGateOutcome> {
    if (!this.continuing) {
      this.continuing = true;
      this.continuationStartedAt = Date.now();
      this.narrowToGoal(goal);
      await ConversationGoalService.markContinuing(
        this.conversationId,
        this.project,
        this.username,
        new Date(this.continuationStartedAt).toISOString(),
      ).catch((error: unknown) =>
        logger.warn(`[GoalGate] Could not mark the goal as continuing: ${getErrorMessage(error)}`),
      );
    }
    this.toolCallsAtContinuation = this.state.streamedToolCalls.length;
    return { action: "continue", input: { kind: "goal_revision", text, meta } };
  }

  /**
   * From here the agent works on its own: hold it to the goal's declared
   * capabilities for the rest of the turn (the run's scope handle, which
   * every approval engine of the turn reads).
   */
  private narrowToGoal(goal: ConversationGoal): void {
    const scope = scopeFromDeclaration(goal.capabilities);
    const handle = this.context.options._capabilityScope;
    if (!scope || !(handle instanceof CapabilityScopeHandle)) return;
    handle.narrow(GOAL_SCOPE_KEY, scope);
    logger.info(`[GoalGate] ${this.conversationId} continues on its own narrowed: ${describeScope(scope)}`);
  }

  /**
   * Put the gate's input in front of the agent: through its mailbox (so it
   * is acknowledged, shown and kept like any mid-turn input), or straight
   * into the transcript when the box refuses it.
   */
  deliver(
    currentMessages: ConversationMessage[],
    input: TurnInputPost,
  ): void {
    const loopKey = resolveLoopKey(this.context);
    const posted = loopKey ? TurnInputMailbox.post(loopKey, input) : { accepted: false };
    if (posted.accepted) {
      drainTurnInput(currentMessages, this.state, this.context, "before_end");
      return;
    }
    currentMessages.push(
      buildTurnInputMessage({
        id: `goal-${Date.now().toString(36)}`,
        kind: input.kind,
        text: input.text,
        receivedAt: Date.now(),
        ...(input.meta && { meta: input.meta }),
      }),
    );
  }

  /** The verifier's spend on the stream, so the cost badge counts it before stats refresh. */
  private emitVerifierUsage(costDollars: number, usage: VerifierUsage): void {
    const totalInputTokens =
      usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    if (!(costDollars > 0) && totalInputTokens === 0) return;
    this.emit({
      type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
      operation: "goal:verify",
      usage: { ...usage, totalInputTokens, requests: 1, estimatedCost: costDollars },
    });
  }

  /** The turn is over: it no longer works on the goal on its own. */
  async close(): Promise<void> {
    if (!this.continuing) return;
    this.continuing = false;
    await ConversationGoalService.markContinuing(
      this.conversationId,
      this.project,
      this.username,
      null,
    ).catch((error: unknown) =>
      logger.warn(`[GoalGate] Could not clear the continuing mark: ${getErrorMessage(error)}`),
    );
  }
}

/** Test hook — forget the earlier runs kept for late spend. */
export function _clearGoalRuns(): void {
  earlierRuns.clear();
}

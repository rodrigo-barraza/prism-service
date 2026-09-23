import logger from "#src/utils/logger";
import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import ConversationGoalService, {
  ConversationNotFoundError,
  GOAL_STATUSES,
  resolveGoalConversationId,
  type ConversationGoalStatus,
  type GoalEmit,
} from "#src/services/ConversationGoalService";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  type InternalToolContext,
  type InternalToolDefinition,
} from "./InternalToolRegistry.ts";

/**
 * Goal tools — the model's handle on the conversation's persistent goal.
 *
 *   propose_goal  propose an objective + rubric (+ budget); the user
 *                 approves it before it becomes the goal
 *   update_goal   report progress, block on an obstacle, CLAIM completion
 *   clear_goal    drop the goal
 *
 * The model never makes a goal active by itself (a goal drives unattended
 * work and spend — the user approves it), never pauses one (the user's
 * lever, PATCH /conversations/:id/goal), and never completes one: a
 * `completed` claim is checked by the independent verifier when the turn
 * ends (lifecycle/GoalGate.ts). Sub-agents share their parent's goal
 * read-only: propose/clear are refused, update is allowed so a worker can
 * report progress.
 */

export const GOAL_TOOL_NAMES = {
  PROPOSE_GOAL: "propose_goal",
  UPDATE_GOAL: "update_goal",
  CLEAR_GOAL: "clear_goal",
} as const;

/** What update_goal answers a completion claim. */
export const COMPLETION_CLAIM_NOTE =
  "Claim noted — the goal is NOT completed yet. When you finish this turn, an independent verifier checks every " +
  "criterion against the evidence (tool calls and results, and your final answer — never your reasoning). " +
  "Verify your work with tools first, then end with a final answer that points at the evidence.";

/** Statuses the model may set — "paused" is the user's alone. */
const MODEL_SETTABLE_STATUSES: readonly ConversationGoalStatus[] = [
  GOAL_STATUSES.ACTIVE,
  GOAL_STATUSES.COMPLETED,
  GOAL_STATUSES.BLOCKED,
];

interface GoalToolContext extends InternalToolContext {
  _emit?: GoalEmit | null;
  _recursionDepth?: number;
  parentAgentConversationId?: string | null;
}

interface GoalScope {
  conversationId: string;
  project: string;
  username: string;
}

function isSubAgentContext(context: GoalToolContext): boolean {
  return (
    context.isSubAgent === true ||
    !!context.parentAgentConversationId ||
    (typeof context._recursionDepth === "number" && context._recursionDepth > 0)
  );
}

function resolveScope(
  context: GoalToolContext,
): { scope: GoalScope } | { error: string } {
  const conversationId = resolveGoalConversationId({
    conversationId: context.conversationId,
    agentConversationId: context.agentConversationId,
    parentAgentConversationId: context.parentAgentConversationId,
  });
  if (!conversationId) {
    return {
      error:
        "Goal tools need a persisted conversation — no conversation id is available in this context.",
    };
  }
  if (!context.project || !context.username) {
    return {
      error: "Goal tools need the conversation's project and username scope.",
    };
  }
  return {
    scope: { conversationId, project: context.project, username: context.username },
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Criteria as the model sends them: strings (or `{criterion}` objects). */
function criteriaList(value: unknown): unknown[] | undefined {
  if (typeof value === "string" && value.trim()) return [value];
  return Array.isArray(value) ? value : undefined;
}

function failure(error: unknown, action: string) {
  if (error instanceof ConversationNotFoundError) {
    return { success: false, error: error.message };
  }
  logger.warn(`[GoalTools] ${action} failed: ${getErrorMessage(error)}`);
  return { success: false, error: getErrorMessage(error) };
}

const proposeGoalTool: InternalToolDefinition = {
  name: GOAL_TOOL_NAMES.PROPOSE_GOAL,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[GOAL_TOOL_NAMES.PROPOSE_GOAL],
  description:
    "Propose a persistent goal for this conversation: what 'done' means, as a rubric of checkable criteria, " +
    "with an optional budget. The user sees it as a card and approves or declines it — it only becomes the goal " +
    "once approved (it then appears in your context). An approved goal keeps you working across turns until an " +
    "independent verifier confirms every criterion from the evidence. Use it when the user gives you a " +
    "multi-step objective, not for one-off questions.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "What 'done' means, in the user's words. One or two sentences.",
      },
      rubric: {
        type: "array",
        items: { type: "string" },
        description:
          "The criteria that must all hold, each one independently checkable from tool results " +
          "(\"report.md exists\", \"the test suite passes\"). Two to six is typical.",
      },
      stepRubric: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional criteria about HOW the work is done, checked over every step (\"no failing command is left unaddressed\").",
      },
      maxCostDollars: {
        type: "number",
        description: "Optional spend ceiling in dollars across every turn of this goal (the verifier counts).",
      },
      maxTurns: {
        type: "integer",
        description: "Optional ceiling on the number of turns spent on this goal.",
      },
      deadline: {
        type: "string",
        description: "Optional ISO 8601 timestamp after which the goal counts as out of budget.",
      },
      maxIterations: {
        type: "integer",
        description: "Optional: how many times the verifier may send the work back before the goal pauses (default 3).",
      },
    },
    required: ["objective", "rubric"],
  },
  display: {
    activeVerb: "Proposing goal",
    completedVerb: "Proposed goal",
    subjectParam: "objective",
    subjectFormat: "truncate" as const,
  },
  domain: DOMAINS.CORE_HARNESS.displayName,
  labels: ["coding"],

  async execute(toolArguments: Record<string, unknown>, context: GoalToolContext) {
    if (isSubAgentContext(context)) {
      return {
        success: false,
        error:
          "Sub-agents share the parent conversation's goal read-only — only the root agent can propose one.",
      };
    }
    const resolved = resolveScope(context);
    if ("error" in resolved) return { success: false, error: resolved.error };

    const objective = optionalString(toolArguments.objective);
    if (!objective) {
      return { success: false, error: "propose_goal needs a non-empty objective." };
    }
    const rubric = criteriaList(toolArguments.rubric);
    if (!rubric || rubric.length === 0) {
      return {
        success: false,
        error: "propose_goal needs a rubric: at least one checkable criterion.",
      };
    }

    try {
      const proposal = await ConversationGoalService.propose(
        resolved.scope.conversationId,
        resolved.scope.project,
        resolved.scope.username,
        {
          objective,
          rubric,
          stepRubric: criteriaList(toolArguments.stepRubric),
          maxIterations: optionalNumber(toolArguments.maxIterations),
          budget: {
            maxCostDollars: optionalNumber(toolArguments.maxCostDollars),
            maxTurns: optionalNumber(toolArguments.maxTurns),
            deadline: optionalString(toolArguments.deadline),
          },
        },
        { emit: context._emit ?? null },
      );
      return {
        success: true,
        proposal,
        note: "Proposed — the user approves or declines it. It is not the goal until they approve it; do not act as if it were.",
      };
    } catch (error: unknown) {
      return failure(error, "propose_goal");
    }
  },
};

const updateGoalTool: InternalToolDefinition = {
  name: GOAL_TOOL_NAMES.UPDATE_GOAL,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[GOAL_TOOL_NAMES.UPDATE_GOAL],
  description:
    "Update the conversation's goal: report progress (summary and/or percent), record what you are blocked on, " +
    "or claim it is done. Status 'completed' is a CLAIM: the goal completes only when an independent verifier " +
    "confirms every criterion from the evidence at the end of your turn. Set blockedOn (status 'blocked') when " +
    "you are stuck or need the user instead of retrying in circles; pass an empty blockedOn once unblocked. " +
    "Only the user can pause a goal. The user is notified only when something meaningful changes.",
  parameters: {
    type: "object",
    properties: {
      progress: {
        type: "string",
        description: "One-line summary of where the work stands now.",
      },
      percent: {
        type: "number",
        description: "Estimated completion, 0–100.",
      },
      blockedOn: {
        type: "string",
        description: "The current obstacle; pass an empty string once unblocked to clear it.",
      },
      status: {
        type: "string",
        enum: [...MODEL_SETTABLE_STATUSES],
        description: "New status: active, blocked, or completed (a claim the verifier checks).",
      },
    },
    required: [],
  },
  display: {
    activeVerb: "Updating goal",
    completedVerb: "Updated goal",
    subjectParam: "progress",
    subjectFormat: "truncate" as const,
  },
  domain: DOMAINS.CORE_HARNESS.displayName,
  labels: ["coding"],

  async execute(toolArguments: Record<string, unknown>, context: GoalToolContext) {
    const resolved = resolveScope(context);
    if ("error" in resolved) return { success: false, error: resolved.error };

    const status = toolArguments.status;
    if (status !== undefined) {
      if (
        typeof status !== "string" ||
        !(MODEL_SETTABLE_STATUSES as readonly string[]).includes(status)
      ) {
        return {
          success: false,
          error: `status must be one of ${MODEL_SETTABLE_STATUSES.join(", ")} — pausing is the user's decision.`,
        };
      }
    }

    const patch: Parameters<typeof ConversationGoalService.update>[3] = {};
    const progressSummary = optionalString(toolArguments.progress);
    if (progressSummary) patch.progressSummary = progressSummary;
    const percent = optionalNumber(toolArguments.percent);
    if (percent !== undefined) patch.percent = percent;
    // null and "" both clear the obstacle (applyGoalPatch maps "" → null).
    if (toolArguments.blockedOn === null) patch.blockedOn = null;
    else if (typeof toolArguments.blockedOn === "string") {
      patch.blockedOn = toolArguments.blockedOn;
    }
    // A completion is a claim, not a status: the verifier completes the goal.
    const claimsCompletion = status === GOAL_STATUSES.COMPLETED;
    if (typeof status === "string" && !claimsCompletion) {
      patch.status = status as ConversationGoalStatus;
    }

    if (Object.keys(patch).length === 0 && !claimsCompletion) {
      return {
        success: false,
        error: "update_goal needs at least one of progress, percent, blockedOn, status.",
      };
    }

    try {
      const { conversationId, project, username } = resolved.scope;
      const current = await ConversationGoalService.get(conversationId, project, username);
      if (!current) {
        return {
          success: false,
          error: "This conversation has no goal — propose one with propose_goal.",
        };
      }
      if (claimsCompletion) {
        if (current.status === GOAL_STATUSES.PAUSED) {
          return {
            success: false,
            error: `The goal is paused${current.pause ? ` (${current.pause.reason})` : ""} — only the user can resume it.`,
          };
        }
        if (current.status === GOAL_STATUSES.COMPLETED) {
          return { success: true, goal: current, note: "The goal is already completed (verified)." };
        }
        // A claim on a blocked goal means the obstacle is gone.
        if (current.status === GOAL_STATUSES.BLOCKED && patch.blockedOn === undefined) {
          patch.status = GOAL_STATUSES.ACTIVE;
        }
      }
      const goal =
        Object.keys(patch).length > 0
          ? await ConversationGoalService.update(conversationId, project, username, patch, {
              emit: context._emit ?? null,
            })
          : current;
      if (!goal) {
        return {
          success: false,
          error: "This conversation has no goal — propose one with propose_goal.",
        };
      }
      return claimsCompletion
        ? { success: true, goal, verification: "pending", note: COMPLETION_CLAIM_NOTE }
        : { success: true, goal };
    } catch (error: unknown) {
      return failure(error, "update_goal");
    }
  },
};

const clearGoalTool: InternalToolDefinition = {
  name: GOAL_TOOL_NAMES.CLEAR_GOAL,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[GOAL_TOOL_NAMES.CLEAR_GOAL],
  description:
    "Remove the conversation's persistent goal. Use it when the user drops the objective; " +
    "to finish a goal, prefer update_goal with status 'completed' so the record stays.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  display: {
    activeVerb: "Clearing goal",
    completedVerb: "Cleared goal",
    subjectParam: "",
    subjectFormat: "truncate" as const,
  },
  domain: DOMAINS.CORE_HARNESS.displayName,
  labels: ["coding"],

  async execute(_toolArguments: Record<string, unknown>, context: GoalToolContext) {
    if (isSubAgentContext(context)) {
      return {
        success: false,
        error:
          "Sub-agents share the parent conversation's goal read-only — only the root agent can clear it.",
      };
    }
    const resolved = resolveScope(context);
    if ("error" in resolved) return { success: false, error: resolved.error };

    try {
      const cleared = await ConversationGoalService.clear(
        resolved.scope.conversationId,
        resolved.scope.project,
        resolved.scope.username,
        { emit: context._emit ?? null },
      );
      return { success: true, cleared };
    } catch (error: unknown) {
      return failure(error, "clear_goal");
    }
  },
};

export default [proposeGoalTool, updateGoalTool, clearGoalTool];

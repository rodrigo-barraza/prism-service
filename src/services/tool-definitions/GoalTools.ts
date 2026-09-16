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
 *   set_goal     create/replace the objective (+ criteria, budget)
 *   update_goal  report progress, block on an obstacle, mark completed
 *   clear_goal   drop the goal
 *
 * The model can never PAUSE a goal — that is the user's lever (PATCH
 * /conversations/:id/goal). Sub-agents share their parent's goal read-only:
 * set/clear are refused, update is allowed so a worker can report progress.
 */

export const GOAL_TOOL_NAMES = {
  SET_GOAL: "set_goal",
  UPDATE_GOAL: "update_goal",
  CLEAR_GOAL: "clear_goal",
} as const;

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

function failure(error: unknown, action: string) {
  if (error instanceof ConversationNotFoundError) {
    return { success: false, error: error.message };
  }
  logger.warn(`[GoalTools] ${action} failed: ${getErrorMessage(error)}`);
  return { success: false, error: getErrorMessage(error) };
}

const setGoalTool: InternalToolDefinition = {
  name: GOAL_TOOL_NAMES.SET_GOAL,
  emoji: INTERNAL_TOOL_EMOJIS[GOAL_TOOL_NAMES.SET_GOAL],
  description:
    "Set (or replace) the persistent goal of this conversation: what 'done' means, in the user's words. " +
    "Optionally state how completion will be recognised and a budget (max dollars, max turns, deadline). " +
    "The goal is shown to you on every turn and to the user in a panel; keep it current with update_goal. " +
    "Use it when the user gives you a multi-turn objective, not for one-off questions.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "What 'done' means, in the user's words. One or two sentences.",
      },
      completionCriteria: {
        type: "string",
        description: "How to tell the objective is met (tests green, file exists, user confirmed…).",
      },
      maxCostDollars: {
        type: "number",
        description: "Optional spend ceiling in dollars across every turn of this goal.",
      },
      maxTurns: {
        type: "integer",
        description: "Optional ceiling on the number of turns spent on this goal.",
      },
      deadline: {
        type: "string",
        description: "Optional ISO 8601 timestamp after which the goal counts as out of budget.",
      },
    },
    required: ["objective"],
  },
  display: {
    activeVerb: "Setting goal",
    completedVerb: "Set goal",
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
          "Sub-agents share the parent conversation's goal read-only — only the root agent can set it.",
      };
    }
    const resolved = resolveScope(context);
    if ("error" in resolved) return { success: false, error: resolved.error };

    const objective = optionalString(toolArguments.objective);
    if (!objective) {
      return { success: false, error: "set_goal needs a non-empty objective." };
    }

    try {
      const goal = await ConversationGoalService.set(
        resolved.scope.conversationId,
        resolved.scope.project,
        resolved.scope.username,
        {
          objective,
          completionCriteria: optionalString(toolArguments.completionCriteria),
          budget: {
            maxCostDollars: optionalNumber(toolArguments.maxCostDollars),
            maxTurns: optionalNumber(toolArguments.maxTurns),
            deadline: optionalString(toolArguments.deadline),
          },
        },
        { emit: context._emit ?? null },
      );
      return { success: true, goal };
    } catch (error: unknown) {
      return failure(error, "set_goal");
    }
  },
};

const updateGoalTool: InternalToolDefinition = {
  name: GOAL_TOOL_NAMES.UPDATE_GOAL,
  emoji: INTERNAL_TOOL_EMOJIS[GOAL_TOOL_NAMES.UPDATE_GOAL],
  description:
    "Update the conversation's goal: report progress (summary and/or percent), record what you are blocked on, " +
    "or change its status. Call it with status 'completed' when the completion criteria are met, and set " +
    "blockedOn (status 'blocked') when you are stuck instead of retrying in circles; pass an empty blockedOn " +
    "once unblocked. Only the user can pause a goal. The user is notified only when something meaningful changes.",
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
        description: "New status: active, completed, or blocked.",
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
    if (typeof status === "string") patch.status = status as ConversationGoalStatus;

    if (Object.keys(patch).length === 0) {
      return {
        success: false,
        error: "update_goal needs at least one of progress, percent, blockedOn, status.",
      };
    }

    try {
      const goal = await ConversationGoalService.update(
        resolved.scope.conversationId,
        resolved.scope.project,
        resolved.scope.username,
        patch,
        { emit: context._emit ?? null },
      );
      if (!goal) {
        return {
          success: false,
          error: "This conversation has no goal yet — call set_goal first.",
        };
      }
      return { success: true, goal };
    } catch (error: unknown) {
      return failure(error, "update_goal");
    }
  },
};

const clearGoalTool: InternalToolDefinition = {
  name: GOAL_TOOL_NAMES.CLEAR_GOAL,
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

export default [setGoalTool, updateGoalTool, clearGoalTool];

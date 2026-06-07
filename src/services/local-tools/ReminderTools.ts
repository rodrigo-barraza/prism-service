import logger from "../../utils/logger.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import ConversationTimerService from "../ConversationTimerService.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";

interface ToolContext {
  conversationId?: string;
  project?: string;
  username?: string;
  _emit?: (event: Record<string, unknown>) => void;
  [key: string]: unknown;
}

// ── Set Timer Tool ─────────────────────────────────────────
const setTimer = {
  name: TOOL_NAMES.SET_TIMER,
  schema: {
    name: TOOL_NAMES.SET_TIMER,
    description:
      "Set a one-shot timer or a recurring cron within this conversation that fires an instruction or prompt " +
      "back into this conversation after a duration. Use this to wait, sleep, yield, defer execution, " +
      "or to schedule periodic background checks on long-running tasks or builds.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt text or instruction to execute when the timer expires.",
        },
        durationSeconds: {
          type: "number",
          description: "Optional: Number of seconds to wait before firing (one-shot, e.g., 10). Maximum: 86400 (24 hours).",
        },
        cronExpression: {
          type: "string",
          description: "Optional: A standard 5-field cron expression for recurring runs (e.g. '*/5 * * * *').",
        },
        maxIterations: {
          type: "number",
          description: "Optional: Maximum iterations/repeats for recurring timers before automatically expiring.",
        },
      },
      required: ["prompt"],
    },
  },
  domain: "Core Tools",
  labels: ["timer", "automation", "scheduler"],

  async execute(args: Record<string, unknown>, context: ToolContext) {
    const { prompt, durationSeconds, cronExpression, maxIterations } = args;
    const conversationId = context.conversationId;
    const project = context.project || "default";
    const username = context.username || "anonymous";

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    if (!prompt || typeof prompt !== "string") {
      return { error: "'prompt' is a required string parameter." };
    }

    try {
      const timer = await ConversationTimerService.createTimer({
        conversationId,
        project,
        username,
        prompt,
        durationSeconds: durationSeconds ? Number(durationSeconds) : undefined,
        cronExpression: cronExpression ? String(cronExpression) : undefined,
        maxIterations: maxIterations ? Number(maxIterations) : undefined,
      });

      logger.info(`[ReminderTools] set_timer created timer ${timer.id} for conversation ${conversationId}`);

      return {
        success: true,
        timer: {
          id: timer.id,
          mode: timer.mode,
          firesAt: timer.firesAt,
          prompt: timer.prompt,
        },
      };
    } catch (error: unknown) {
      return { error: `Failed to create timer: ${getErrorMessage(error)}` };
    }
  },
};

// ── List Timers Tool ────────────────────────────────────────
 const listTimers = {
  name: TOOL_NAMES.LIST_TIMERS,
  schema: {
    name: TOOL_NAMES.LIST_TIMERS,
    description: "List all active timers and recurring cron schedules for the current conversation.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  domain: "Core Tools",
  labels: ["timer", "automation", "scheduler"],

  async execute(_args: Record<string, unknown>, context: ToolContext) {
    const conversationId = context.conversationId;
    const project = context.project || "default";
    const username = context.username || "anonymous";

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    try {
      const activeTimers = await ConversationTimerService.listActiveTimers(conversationId, project, username);

      return {
        success: true,
        timers: activeTimers.map((timer) => ({
          id: timer.id,
          mode: timer.mode,
          firesAt: timer.firesAt,
          prompt: timer.prompt,
          iterationCount: timer.iterationCount,
        })),
      };
    } catch (error: unknown) {
      return { error: `Failed to list timers: ${getErrorMessage(error)}` };
    }
  },
};

// ── Cancel Timer Tool ───────────────────────────────────────
const cancelTimer = {
  name: TOOL_NAMES.CANCEL_TIMER,
  schema: {
    name: TOOL_NAMES.CANCEL_TIMER,
    description: "Cancel an active timer or recurring cron in the current conversation.",
    parameters: {
      type: "object",
      properties: {
        timerId: {
          type: "string",
          description: "The unique ID of the timer or schedule to cancel.",
        },
      },
      required: ["timerId"],
    },
  },
  domain: "Core Tools",
  labels: ["timer", "automation", "scheduler"],

  async execute(args: Record<string, unknown>, context: ToolContext) {
    const { timerId } = args;
    const project = context.project || "default";
    const username = context.username || "anonymous";

    if (!timerId || typeof timerId !== "string") {
      return { error: "'timerId' is a required string parameter." };
    }

    try {
      const wasCancelled = await ConversationTimerService.cancelTimer(timerId, project, username);

      if (!wasCancelled) {
        return {
          success: false,
          message: `No active timer found with ID ${timerId} in this conversation.`,
        };
      }

      return {
        success: true,
        message: `Successfully cancelled timer ${timerId}.`,
      };
    } catch (error: unknown) {
      return { error: `Failed to cancel timer: ${getErrorMessage(error)}` };
    }
  },
};

export default [setTimer, listTimers, cancelTimer];

import logger from "../../utils/logger.ts";
import ConversationTimerService from "../ConversationTimerService.ts";

interface ToolContext {
  agentSessionId?: string;
  project?: string;
  username?: string;
  _emit?: (event: Record<string, unknown>) => void;
  [key: string]: unknown;
}

// ── Schedule Timer/Cron Tool ────────────────────────────────
const schedule = {
  name: "schedule",
  schema: {
    name: "schedule",
    description:
      "Schedule a one-shot timer or a recurring cron job that fires an instruction or prompt " +
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
  domain: "Agentic: Automation",
  labels: ["timer", "automation", "scheduler"],

  async execute(args: Record<string, unknown>, context: ToolContext) {
    const { prompt, durationSeconds, cronExpression, maxIterations } = args;
    const conversationId = context.agentSessionId;
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

      logger.info(`[ReminderTools] schedule created timer ${timer.id} for conversation ${conversationId}`);

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
      return { error: `Failed to create scheduled timer: ${(error as Error).message}` };
    }
  },
};

// ── List Schedules Tool ──────────────────────────────────────
const listSchedules = {
  name: "list_schedules",
  schema: {
    name: "list_schedules",
    description: "List all active timers, schedules, and cron reminders for the current conversation.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  domain: "Agentic: Automation",
  labels: ["timer", "automation", "scheduler"],

  async execute(_args: Record<string, unknown>, context: ToolContext) {
    const conversationId = context.agentSessionId;
    const project = context.project || "default";
    const username = context.username || "anonymous";

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    try {
      const activeTimers = await ConversationTimerService.listActiveTimers(conversationId, project, username);

      return {
        success: true,
        reminders: activeTimers.map((timer) => ({
          id: timer.id,
          mode: timer.mode,
          firesAt: timer.firesAt,
          prompt: timer.prompt,
          iterationCount: timer.iterationCount,
        })),
      };
    } catch (error: unknown) {
      return { error: `Failed to list schedules: ${(error as Error).message}` };
    }
  },
};

// ── Cancel Schedule Tool ─────────────────────────────────────
const cancelSchedule = {
  name: "cancel_schedule",
  schema: {
    name: "cancel_schedule",
    description: "Cancel an active scheduled timer, schedule, or recurring cron in the current conversation.",
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
  domain: "Agentic: Automation",
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
          message: `No active schedule found with ID ${timerId} in this conversation.`,
        };
      }

      return {
        success: true,
        message: `Successfully cancelled schedule ${timerId}.`,
      };
    } catch (error: unknown) {
      return { error: `Failed to cancel schedule: ${(error as Error).message}` };
    }
  },
};

export default [schedule, listSchedules, cancelSchedule];

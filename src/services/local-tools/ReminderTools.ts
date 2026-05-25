import logger from "../../utils/logger.ts";
import ConversationTimerService from "../ConversationTimerService.ts";

interface ToolContext {
  agentSessionId?: string;
  project?: string;
  username?: string;
  _emit?: (event: Record<string, unknown>) => void;
  [key: string]: unknown;
}

// ── Set Reminder Tool ───────────────────────────────────────
const setReminder = {
  name: "set_reminder",
  schema: {
    name: "set_reminder",
    description:
      "Schedule a timer or a reminder that fires a message back into this conversation " +
      "to wake up the agent. Use this to schedule checks for long-running builds, tasks, " +
      "or to set recurring health-check intervals.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The prompt text to remind you of when the timer expires.",
        },
        durationSeconds: {
          type: "number",
          description: "Optional: Seconds to wait before firing (one-shot, e.g., 30). Maximum: 86400 (24 hours).",
        },
        cronExpression: {
          type: "string",
          description: "Optional: A standard 5-field cron expression for recurring reminders (e.g. '*/5 * * * *').",
        },
        maxIterations: {
          type: "number",
          description: "Optional: Maximum iterations/repeats for recurring timers before expiring.",
        },
      },
      required: ["prompt"],
    },
  },
  domain: "Agentic: Reminders",
  labels: ["timer", "automation"],

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

      logger.info(`[ReminderTools] set_reminder created timer ${timer.id} for conversation ${conversationId}`);

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
      return { error: `Failed to create reminder: ${(error as Error).message}` };
    }
  },
};

// ── List Reminders Tool ─────────────────────────────────────
const listReminders = {
  name: "list_reminders",
  schema: {
    name: "list_reminders",
    description: "List all active timers and reminders scheduled for the current conversation.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  domain: "Agentic: Reminders",
  labels: ["timer", "automation"],

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
      return { error: `Failed to list reminders: ${(error as Error).message}` };
    }
  },
};

// ── Cancel Reminder Tool ────────────────────────────────────
const cancelReminder = {
  name: "cancel_reminder",
  schema: {
    name: "cancel_reminder",
    description: "Cancel an active scheduled timer or reminder in the current conversation.",
    parameters: {
      type: "object",
      properties: {
        timerId: {
          type: "string",
          description: "The unique ID of the timer/reminder to cancel.",
        },
      },
      required: ["timerId"],
    },
  },
  domain: "Agentic: Reminders",
  labels: ["timer", "automation"],

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
      return { error: `Failed to cancel reminder: ${(error as Error).message}` };
    }
  },
};

export default [setReminder, listReminders, cancelReminder];

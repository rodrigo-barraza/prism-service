import logger from "../../utils/logger.ts";
import { TOOL_NAMES, DOMAINS, DEFAULT_USERNAME, DEFAULT_PROJECT } from "@rodrigo-barraza/utilities-library/taxonomy";
import ConversationTimerService from "../ConversationTimerService.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";

import { InternalToolContext } from "./InternalToolRegistry.ts";

interface ReminderContext extends InternalToolContext {
  _emit?: (event: { type: string; [key: string]: unknown }) => void;
}

const TIMER_MINIMUM_SECONDS = 30;
const TIMER_MAXIMUM_SECONDS = 599;
const CRON_MINIMUM_DELAY_SECONDS = 600;
const CRON_MAXIMUM_DELAY_SECONDS = 86400;

// ── Set Timer Tool ─────────────────────────────────────────
// Agent-internal one-shot wait. Fires a prompt back into the
// current conversation after a short delay (30–599 seconds).
// Use when the agent needs to pause, poll, retry, or defer
// execution within a single conversation turn.
const setTimer = {
  name: TOOL_NAMES.SET_TIMER,
  schema: {
    name: TOOL_NAMES.SET_TIMER,
    emoji: ["⏰", "⏳"],
    description:
      "Set a short one-shot timer to pause, wait, or defer execution within this conversation. " +
      "Use this when you need to wait for an asynchronous process to finish, poll a build or deployment, " +
      "retry after a transient failure, or yield briefly before continuing work. " +
      "The timer fires the provided prompt back into this conversation after the specified duration. " +
      "Duration must be between 30 and 599 seconds (under 10 minutes). " +
      "This is an agent-internal tool for in-conversation waits only — " +
      "do NOT use this for user-facing reminders, alarms, or scheduled events (use create_cron_job instead).",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The instruction or context to inject back into this conversation when the timer fires.",
        },
        durationSeconds: {
          type: "number",
          description: "Number of seconds to wait before firing (30–599). Must be under 10 minutes.",
        },
      },
      required: ["prompt", "durationSeconds"],
    },
  },
  labels: ["timer", "wait", "defer"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(toolArguments: Record<string, unknown>, context: ReminderContext) {
    const prompt = typeof toolArguments.prompt === "string" ? toolArguments.prompt : undefined;
    const durationSeconds =
      typeof toolArguments.durationSeconds === "number" || typeof toolArguments.durationSeconds === "string"
        ? Number(toolArguments.durationSeconds)
        : undefined;
    const conversationId = context.agentSessionId;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    if (!prompt || typeof prompt !== "string") {
      return { error: "'prompt' is a required string parameter." };
    }

    if (durationSeconds === undefined || durationSeconds < TIMER_MINIMUM_SECONDS || durationSeconds > TIMER_MAXIMUM_SECONDS) {
      return {
        error: `'durationSeconds' must be between ${TIMER_MINIMUM_SECONDS} and ${TIMER_MAXIMUM_SECONDS} seconds. ` +
          `For longer scheduled reminders or recurring events, use create_cron_job instead.`,
      };
    }

    try {
      const timer = await ConversationTimerService.createTimer({
        conversationId,
        project,
        username,
        prompt,
        durationSeconds,
      });

      logger.info(`[ReminderTools] set_timer created timer ${timer.id} (${durationSeconds}s) for conversation ${conversationId}`);

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

// ── Create Cron Job Tool ───────────────────────────────────
// User-facing scheduled notifications: reminders, alarms,
// recurring events, periodic checks. Cron jobs are standalone
// scheduled entries — they do NOT reply within the originating
// conversation.
const createCronJob = {
  name: TOOL_NAMES.CREATE_CRON_JOB,
  schema: {
    name: TOOL_NAMES.CREATE_CRON_JOB,
    emoji: ["📅", "🔔"],
    description:
      "Create a scheduled cron job for user-facing reminders, alarms, recurring events, or periodic notifications. " +
      "Use this when the user asks to 'set a reminder', 'remind me in…', 'schedule a check every…', " +
      "'set an alarm for…', 'what is my schedule', or any time-based notification request. " +
      "Supports two modes:\n" +
      "  • Recurring schedule — provide a standard 5-field cron expression (minimum interval: every 10 minutes).\n" +
      "  • One-shot reminder — provide delaySeconds (minimum 600s / 10 minutes, maximum 86400s / 24 hours).\n" +
      "Cron jobs are standalone scheduled notifications — they do NOT respond within this conversation.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The reminder message, alarm text, or notification content delivered when the cron job fires.",
        },
        cronExpression: {
          type: "string",
          description:
            "A standard 5-field cron expression for recurring schedules. " +
            "Examples: '*/10 * * * *' (every 10 min), '0 9 * * 1-5' (9 AM weekdays), '30 14 * * *' (2:30 PM daily). " +
            "Minimum interval is every 10 minutes. Mutually exclusive with delaySeconds.",
        },
        delaySeconds: {
          type: "number",
          description:
            "For one-shot scheduled reminders: seconds from now until the notification fires. " +
            "Minimum 600 (10 minutes), maximum 86400 (24 hours). " +
            "Use for requests like 'remind me in 2 hours'. Mutually exclusive with cronExpression.",
        },
        maxIterations: {
          type: "number",
          description:
            "For recurring cron jobs only: maximum number of times the schedule fires before automatically expiring. " +
            "Omit for indefinite recurring schedules.",
        },
      },
      required: ["prompt"],
    },
  },
  labels: ["schedule", "reminder", "alarm", "cron"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(toolArguments: Record<string, unknown>, context: ReminderContext) {
    const prompt = typeof toolArguments.prompt === "string" ? toolArguments.prompt : undefined;
    const cronExpression = typeof toolArguments.cronExpression === "string" ? toolArguments.cronExpression : undefined;
    const delaySeconds =
      typeof toolArguments.delaySeconds === "number" || typeof toolArguments.delaySeconds === "string"
        ? Number(toolArguments.delaySeconds)
        : undefined;
    const maxIterations =
      typeof toolArguments.maxIterations === "number" || typeof toolArguments.maxIterations === "string"
        ? Number(toolArguments.maxIterations)
        : undefined;
    const conversationId = context.agentSessionId;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    if (!prompt || typeof prompt !== "string") {
      return { error: "'prompt' is a required string parameter." };
    }

    if (!cronExpression && delaySeconds === undefined) {
      return { error: "Either 'cronExpression' (for recurring schedules) or 'delaySeconds' (for one-shot reminders) is required." };
    }

    if (cronExpression && delaySeconds !== undefined) {
      return { error: "Provide either 'cronExpression' or 'delaySeconds', not both." };
    }

    if (delaySeconds !== undefined && (delaySeconds < CRON_MINIMUM_DELAY_SECONDS || delaySeconds > CRON_MAXIMUM_DELAY_SECONDS)) {
      return {
        error: `'delaySeconds' must be between ${CRON_MINIMUM_DELAY_SECONDS} (10 minutes) and ${CRON_MAXIMUM_DELAY_SECONDS} (24 hours) seconds.`,
      };
    }

    try {
      const timer = await ConversationTimerService.createTimer({
        conversationId,
        project,
        username,
        prompt,
        durationSeconds: delaySeconds,
        cronExpression,
        maxIterations,
      });

      logger.info(`[ReminderTools] create_cron_job created ${timer.mode} schedule ${timer.id} for conversation ${conversationId}`);

      return {
        success: true,
        schedule: {
          id: timer.id,
          mode: timer.mode,
          firesAt: timer.firesAt,
          prompt: timer.prompt,
          ...(timer.cronExpression && { cronExpression: timer.cronExpression }),
          ...(timer.maxIterations !== undefined && { maxIterations: timer.maxIterations }),
        },
      };
    } catch (error: unknown) {
      return { error: `Failed to create scheduled job: ${getErrorMessage(error)}` };
    }
  },
};

// ── List Timers Tool ────────────────────────────────────────
// Lists active agent-internal one-shot timers for this conversation.
const listTimers = {
  name: TOOL_NAMES.LIST_TIMERS,
  schema: {
    name: TOOL_NAMES.LIST_TIMERS,
    emoji: ["⏱️", "📋"],
    description:
      "List all active one-shot agent timers in the current conversation. " +
      "Shows short-duration waits (30–599 seconds) set by set_timer. " +
      "To view user-facing scheduled reminders, alarms, and recurring events, use list_cron_jobs instead.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  labels: ["timer", "wait"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(_args: Record<string, unknown>, context: ReminderContext) {
    const conversationId = context.agentSessionId;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    try {
      const activeTimers = await ConversationTimerService.listActiveTimers(conversationId, project, username);
      const oneShotTimers = activeTimers.filter(
        (timer) => timer.mode === "one_shot" && (timer.durationSeconds === undefined || timer.durationSeconds < CRON_MINIMUM_DELAY_SECONDS),
      );

      return {
        success: true,
        timers: oneShotTimers.map((timer) => ({
          id: timer.id,
          firesAt: timer.firesAt,
          prompt: timer.prompt,
        })),
      };
    } catch (error: unknown) {
      return { error: `Failed to list timers: ${getErrorMessage(error)}` };
    }
  },
};

// ── List Cron Jobs Tool ─────────────────────────────────────
// Lists active user-facing scheduled cron jobs, reminders, and alarms.
const listCronJobs = {
  name: TOOL_NAMES.LIST_CRON_JOBS,
  schema: {
    name: TOOL_NAMES.LIST_CRON_JOBS,
    emoji: ["📅", "📋"],
    description:
      "List all active scheduled cron jobs, reminders, and alarms for the current conversation. " +
      "Use this when the user asks 'what is my schedule', 'show my reminders', 'list my alarms', " +
      "or 'do I have anything scheduled'. " +
      "To view short-duration agent timers, use list_timers instead.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  labels: ["schedule", "reminder", "alarm", "cron"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(_args: Record<string, unknown>, context: ReminderContext) {
    const conversationId = context.agentSessionId;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!conversationId) {
      return { error: "No active agent session / conversation ID in context." };
    }

    try {
      const activeTimers = await ConversationTimerService.listActiveTimers(conversationId, project, username);
      const cronJobs = activeTimers.filter(
        (timer) =>
          timer.mode === "recurring" ||
          (timer.mode === "one_shot" && timer.durationSeconds !== undefined && timer.durationSeconds >= CRON_MINIMUM_DELAY_SECONDS),
      );

      return {
        success: true,
        schedules: cronJobs.map((timer) => ({
          id: timer.id,
          mode: timer.mode,
          firesAt: timer.firesAt,
          prompt: timer.prompt,
          ...(timer.cronExpression && { cronExpression: timer.cronExpression }),
          iterationCount: timer.iterationCount,
          ...(timer.maxIterations !== undefined && { maxIterations: timer.maxIterations }),
        })),
      };
    } catch (error: unknown) {
      return { error: `Failed to list scheduled jobs: ${getErrorMessage(error)}` };
    }
  },
};

// ── Cancel Timer Tool ───────────────────────────────────────
// Cancels an active agent-internal one-shot timer.
const cancelTimer = {
  name: TOOL_NAMES.CANCEL_TIMER,
  schema: {
    name: TOOL_NAMES.CANCEL_TIMER,
    emoji: ["⏰", "❌"],
    description:
      "Cancel an active one-shot agent timer in the current conversation. " +
      "To delete a scheduled cron job, reminder, or alarm, use delete_cron_job instead.",
    parameters: {
      type: "object",
      properties: {
        timerId: {
          type: "string",
          description: "The unique ID of the timer to cancel.",
        },
      },
      required: ["timerId"],
    },
  },
  labels: ["timer", "wait"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(toolArguments: Record<string, unknown>, context: ReminderContext) {
    const timerId = typeof toolArguments.timerId === "string" ? toolArguments.timerId : undefined;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!timerId || typeof timerId !== "string") {
      return { error: "'timerId' is a required string parameter." };
    }

    try {
      const wasCancelled = await ConversationTimerService.cancelTimer(timerId, project, username);

      if (!wasCancelled) {
        return {
          success: false,
          message: `No active timer found with ID ${timerId}.`,
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

// ── Delete Cron Job Tool ────────────────────────────────────
// Deletes an active user-facing scheduled cron job, reminder, or alarm.
const deleteCronJob = {
  name: TOOL_NAMES.DELETE_CRON_JOB,
  schema: {
    name: TOOL_NAMES.DELETE_CRON_JOB,
    emoji: ["📅", "❌"],
    description:
      "Delete an active scheduled cron job, reminder, or alarm. " +
      "Use this when the user asks to 'cancel my reminder', 'remove my alarm', " +
      "'delete a scheduled event', or 'stop that recurring check'. " +
      "To cancel a short-duration agent timer, use cancel_timer instead.",
    parameters: {
      type: "object",
      properties: {
        cronJobId: {
          type: "string",
          description: "The unique ID of the scheduled cron job, reminder, or alarm to delete.",
        },
      },
      required: ["cronJobId"],
    },
  },
  labels: ["schedule", "reminder", "alarm", "cron"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(toolArguments: Record<string, unknown>, context: ReminderContext) {
    const cronJobId = typeof toolArguments.cronJobId === "string" ? toolArguments.cronJobId : undefined;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!cronJobId || typeof cronJobId !== "string") {
      return { error: "'cronJobId' is a required string parameter." };
    }

    try {
      const wasDeleted = await ConversationTimerService.cancelTimer(cronJobId, project, username);

      if (!wasDeleted) {
        return {
          success: false,
          message: `No active scheduled job found with ID ${cronJobId}.`,
        };
      }

      return {
        success: true,
        message: `Successfully deleted scheduled job ${cronJobId}.`,
      };
    } catch (error: unknown) {
      return { error: `Failed to delete scheduled job: ${getErrorMessage(error)}` };
    }
  },
};

export default [setTimer, createCronJob, listTimers, listCronJobs, cancelTimer, deleteCronJob];

import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
  DEFAULT_USERNAME,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";

import { InternalToolContext } from "./InternalToolRegistry.ts";

interface ReminderContext extends InternalToolContext {
  _emit?: (event: { type: string; [key: string]: unknown }) => void;
}

const TIMER_MINIMUM_SECONDS = 30;
const TIMER_MAXIMUM_SECONDS = 599;
const CRON_MINIMUM_DELAY_SECONDS = 600;

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
          description:
            "The instruction or context to inject back into this conversation when the timer fires.",
        },
        durationSeconds: {
          type: "number",
          description:
            "Number of seconds to wait before firing (30–599). Must be under 10 minutes.",
        },
      },
      required: ["prompt", "durationSeconds"],
    },
  },
  labels: ["timer", "wait", "defer"],
  domain: DOMAINS.CORE_SCHEDULE.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: ReminderContext,
  ) {
    const prompt =
      typeof toolArguments.prompt === "string"
        ? toolArguments.prompt
        : undefined;
    const durationSeconds =
      typeof toolArguments.durationSeconds === "number" ||
      typeof toolArguments.durationSeconds === "string"
        ? Number(toolArguments.durationSeconds)
        : undefined;
    const conversationId = context.agentConversationId;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!conversationId) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.set_timer.noConversation") };
    }

    if (!prompt || typeof prompt !== "string") {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.set_timer.noPrompt") };
    }

    if (
      durationSeconds === undefined ||
      durationSeconds < TIMER_MINIMUM_SECONDS ||
      durationSeconds > TIMER_MAXIMUM_SECONDS
    ) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.set_timer.invalidDuration", { min: String(TIMER_MINIMUM_SECONDS), max: String(TIMER_MAXIMUM_SECONDS) }),
      };
    }

    try {
      const { default: ConversationTimerService } =
        await import("../ConversationTimerService.js");
      const timer = await ConversationTimerService.createTimer({
        conversationId,
        project,
        username,
        prompt,
        durationSeconds,
      });

      logger.info(
        `[ReminderTools] set_timer created timer ${timer.id} (${durationSeconds}s) for conversation ${conversationId}`,
      );

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

  async execute(_toolArguments: Record<string, unknown>, context: ReminderContext) {
    const conversationId = context.agentConversationId;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!conversationId) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.list_timers.noConversation") };
    }

    try {
      const { default: ConversationTimerService } =
        await import("../ConversationTimerService.js");
      const activeTimers = await ConversationTimerService.listActiveTimers(
        conversationId,
        project,
        username,
      );
      const oneShotTimers = activeTimers.filter(
        (timer) =>
          timer.mode === "one_shot" &&
          (timer.durationSeconds === undefined ||
            timer.durationSeconds < CRON_MINIMUM_DELAY_SECONDS),
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

  async execute(
    toolArguments: Record<string, unknown>,
    context: ReminderContext,
  ) {
    const timerId =
      typeof toolArguments.timerId === "string"
        ? toolArguments.timerId
        : undefined;
    const project = context.project || DEFAULT_PROJECT;
    const username = context.username || DEFAULT_USERNAME;

    if (!timerId || typeof timerId !== "string") {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.cancel_timer.noTimerId") };
    }

    try {
      const { default: ConversationTimerService } =
        await import("../ConversationTimerService.js");
      const wasCancelled = await ConversationTimerService.cancelTimer(
        timerId,
        project,
        username,
      );

      if (!wasCancelled) {
        return {
          success: false,
          message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.cancel_timer.notFound", { timerId }),
        };
      }

      return {
        success: true,
        message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.cancel_timer.success", { timerId }),
      };
    } catch (error: unknown) {
      return { error: `Failed to cancel timer: ${getErrorMessage(error)}` };
    }
  },
};

export default [setTimer, listTimers, cancelTimer];

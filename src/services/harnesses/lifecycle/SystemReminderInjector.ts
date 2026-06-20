import logger from "../../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { extractReminderViaLLM } from "./SystemReminderExtractor.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ConversationMessage,
  AgenticContext,
} from "../types.ts";

/**
 * SystemReminderInjector — counteracts instruction fade-out in long sessions.
 *
 * Based on OPENDEV (arXiv 2603.05344) "Event-Driven System Reminders":
 * as agentic sessions grow beyond ~10 iterations, the model's adherence
 * to system-level constraints degrades because the system prompt recedes
 * into the context window's distant prefix. This is the "instruction
 * fade-out" effect documented across all major LLM providers.
 *
 * This module uses the SystemReminderExtractor (LLM-based distillation)
 * to produce a condensed (~300 token) behavioral summary on the first
 * reminder trigger. Subsequent injections reuse the cached summary.
 *
 * Feature gating: if `options.reminderModel` is not set, the entire
 * feature is disabled — no extraction, no injection.
 */

const DEFAULT_REMINDER_INTERVAL = 8;
const MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER = 5;

const cachedReminderContent: Map<string, string> = new Map();

/**
 * Check whether a system reminder should be injected on this iteration.
 * If so, extract (or re-use cached) constraints and inject them.
 *
 * Feature is disabled when `options.reminderModel` is not configured.
 *
 * Call this at the start of each iteration, after incrementing
 * `state.iterations` but before building the provider stream.
 */
export async function maybeInjectSystemReminder(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  context: AgenticContext,
): Promise<void> {
  const { options, emit, provider, signal } = context;
  const agentConversationId = context.agentConversationId || (context.agentSessionId as string) || "";

  // Feature gate: disabled when no reminder model is configured
  const reminderModel = options.reminderModel as string | undefined;
  if (!reminderModel) return;

  const resolvedInterval = options.reminderInterval || DEFAULT_REMINDER_INTERVAL;
  const currentIteration = state.iterations;

  if (currentIteration < MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER) return;
  if (currentIteration % resolvedInterval !== 0) return;

  let reminderContent = cachedReminderContent.get(agentConversationId);

  if (!reminderContent) {
    const systemMessage = currentMessages.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.length > 200,
    );

    if (!systemMessage || typeof systemMessage.content !== "string") return;

    reminderContent = await extractReminderViaLLM(
      systemMessage.content,
      provider,
      reminderModel,
      signal || undefined,
    ) || undefined;

    if (!reminderContent) return;

    cachedReminderContent.set(agentConversationId, reminderContent);
  }

  currentMessages.push({
    role: "system",
    content:
      `[SYSTEM REMINDER — Iteration ${currentIteration}]\n` +
      `The following core behavioral constraints from your system instructions remain in effect:\n\n` +
      `${reminderContent}\n\n` +
      `Continue to follow these constraints strictly throughout the remainder of this session.`,
  });

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.SYSTEM_REMINDER_INJECTED,
    iteration: currentIteration,
    interval: resolvedInterval,
  });

  logger.info(
    `[SystemReminderInjector] Injected system reminder on iteration ${currentIteration} ` +
      `(interval: ${resolvedInterval}, model: ${reminderModel}, ${reminderContent.length} chars)`,
  );
}

/**
 * Clean up cached reminder content for a session.
 * Call during session teardown to prevent memory leaks.
 */
export function cleanupReminderCache(agentConversationId: string): void {
  cachedReminderContent.delete(agentConversationId);
}

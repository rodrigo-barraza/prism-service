import logger from "../../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ConversationMessage,
  EmitFunction,
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
 * This module extracts key behavioral constraints from the system prompt
 * on the first iteration and re-injects them as compact reminders at
 * configurable intervals (default: every 8 iterations). The reminders
 * are placed near the tail of the message array so they fall within
 * the model's recency window.
 *
 * The extraction is a one-time operation that produces a condensed
 * (~300 token) behavioral summary. Subsequent injections reuse the
 * same summary, adding negligible overhead to context size.
 */

const DEFAULT_REMINDER_INTERVAL = 8;
const MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER = 5;
const MAXIMUM_REMINDER_CHARACTERS = 1200;

let cachedReminderContent: Map<string, string> = new Map();

/**
 * Extract a condensed behavioral summary from the system prompt.
 *
 * Pulls the most critical constraints: identity, safety boundaries,
 * output format requirements, and tool usage rules. Uses heuristic
 * extraction (section headers, imperative sentences) rather than
 * an LLM call — zero latency overhead.
 */
function extractReminderFromSystemPrompt(
  systemPromptContent: string,
): string {
  const importantPatterns = [
    /(?:you (?:must|should|are|will)|never|always|do not|important|critical|required|mandatory)[^\n.]*/gi,
    /(?:rule|constraint|guideline|policy|requirement)[^\n.]*/gi,
  ];

  const extractedSentences: Set<string> = new Set();

  for (const pattern of importantPatterns) {
    const matches = systemPromptContent.match(pattern);
    if (matches) {
      for (const match of matches) {
        const trimmedMatch = match.trim();
        if (trimmedMatch.length > 20 && trimmedMatch.length < 200) {
          extractedSentences.add(trimmedMatch);
        }
      }
    }
  }

  if (extractedSentences.size === 0) {
    return "";
  }

  const sortedSentences = [...extractedSentences]
    .slice(0, 15);

  let reminderText = "";
  for (const sentence of sortedSentences) {
    if (reminderText.length + sentence.length > MAXIMUM_REMINDER_CHARACTERS) break;
    reminderText += `- ${sentence}\n`;
  }

  return reminderText.trim();
}

/**
 * Check whether a system reminder should be injected on this iteration.
 * If so, inject it and emit a status event.
 *
 * Call this at the start of each iteration, after incrementing
 * `state.iterations` but before building the provider stream.
 */
export function maybeInjectSystemReminder(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  emit: EmitFunction,
  sessionId: string,
  reminderInterval?: number,
): void {
  const resolvedInterval = reminderInterval || DEFAULT_REMINDER_INTERVAL;
  const currentIteration = state.iterations;

  if (currentIteration < MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER) return;
  if (currentIteration % resolvedInterval !== 0) return;

  let reminderContent = cachedReminderContent.get(sessionId);

  if (!reminderContent) {
    const systemMessage = currentMessages.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.length > 200,
    );

    if (!systemMessage || typeof systemMessage.content !== "string") return;

    reminderContent = extractReminderFromSystemPrompt(systemMessage.content);
    if (!reminderContent) return;

    cachedReminderContent.set(sessionId, reminderContent);
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
      `(interval: ${resolvedInterval}, ${reminderContent.length} chars)`,
  );
}

/**
 * Clean up cached reminder content for a session.
 * Call during session teardown to prevent memory leaks.
 */
export function cleanupReminderCache(sessionId: string): void {
  cachedReminderContent.delete(sessionId);
}

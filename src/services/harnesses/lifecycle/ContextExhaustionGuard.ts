/**
 * ContextExhaustionGuard — pre-flight check that prevents sending a
 * doomed provider request when the output budget is critically low.
 *
 * When the conversation history has consumed so much of the context
 * window that even after compaction and output clamping the remaining
 * output budget is below MINIMUM_VIABLE_OUTPUT_TOKENS, the model
 * cannot produce a complete tool call JSON (typically 500–2K tokens)
 * plus reasoning overhead. Sending the request anyway results in a
 * mid-tool-call truncation that silently breaks the loop.
 *
 * Instead of sending a doomed request, the guard signals the harness
 * to skip the provider call and trigger exhaustion recovery (a tool-free
 * summary pass) immediately.
 */

import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { MINIMUM_VIABLE_OUTPUT_TOKENS } from "#src/constants/TokenBudgetDefaults";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { EmitFunction } from "#src/services/harnesses/types";

export { MINIMUM_VIABLE_OUTPUT_TOKENS };

/**
 * Check whether the output budget is too low for a viable provider request.
 *
 * Returns true when the clamped output tokens fall below the minimum
 * threshold, meaning the model cannot produce a complete response.
 */
export function isContextExhausted(
  clampedMaxTokens: number | undefined | null,
): boolean {
  if (clampedMaxTokens == null) return false;
  return clampedMaxTokens < MINIMUM_VIABLE_OUTPUT_TOKENS;
}

/**
 * Build the user-facing error description when the context window is
 * critically exhausted and exhaustion recovery is triggered.
 */
export function buildContextExhaustedMessage(
  availableTokens: number,
  contextWindow: number,
  iterationCount: number,
  locale?: string,
): string {
  return PromptLocaleService.get(
    locale || PromptLocaleService.getDefaultLocale(),
    "harness.contextWindow.contextExhausted",
    {
      availableTokens: String(availableTokens),
      contextWindow: String(contextWindow),
      iterationCount: String(iterationCount),
    },
  );
}

/**
 * Emit the context_exhausted SSE status event so the client can display
 * a meaningful status indicator.
 */
export function emitContextExhaustedStatus(
  emit: EmitFunction,
  availableOutputTokens: number,
  contextWindow: number,
): void {
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: "context_exhausted",
    availableOutputTokens,
    contextWindow,
  });
}

/**
 * Log a diagnostic warning when the guard fires.
 */
export function logContextExhaustion(
  clampedMaxTokens: number,
  contextWindow: number,
  harnessLabel: string,
): void {
  logger.warn(
    `[ContextExhaustionGuard] ${harnessLabel}: output budget ${clampedMaxTokens} < ` +
      `${MINIMUM_VIABLE_OUTPUT_TOKENS} threshold — context window (${contextWindow}) exhausted. ` +
      `Skipping provider call, triggering exhaustion recovery.`,
  );
}

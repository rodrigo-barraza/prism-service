/**
 * OutputTruncationRecovery — auto-continue when the model's response
 * is cut short by the max_output_tokens limit.
 *
 * Inspired by Claude Code's "Withhold and Recover" pattern:
 *   - When `stopReason` is "length" or "max_tokens", the response was
 *     truncated — the model had more to say but the token budget ran out.
 *   - Instead of discarding the partial output, we append it to the
 *     conversation and inject a continuation prompt so the model can
 *     resume where it left off.
 *   - This is retried up to MAX_OUTPUT_TRUNCATION_RECOVERIES times
 *     with escalated token limits before giving up.
 *
 * If all recovery attempts are exhausted, an error message is injected
 * into the conversation as an assistant message so the LLM can see
 * what happened on the next turn (error-as-context pattern).
 */

import logger from "../../../utils/logger.ts";
import type { ConversationMessage, PassState, AgenticContext } from "../types.ts";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

/** Maximum number of auto-continuation attempts before giving up. */
export const MAX_OUTPUT_TRUNCATION_RECOVERIES = 3;

/** Token escalation multiplier applied to maxTokens on each recovery attempt. */
const TOKEN_ESCALATION_MULTIPLIER = 1.5;

/** Default maxTokens if none is configured on the agent context. */
const DEFAULT_MAX_TOKENS = 8192;

/** The continuation prompt injected as a system message after a truncated response. */
const CONTINUATION_PROMPT =
  "Your previous response was cut short because the output token limit " +
  "was reached before you could finish. The truncated text has been preserved. " +
  "Please continue exactly where you left off. Do NOT repeat what you already said.";

/**
 * Check whether a pass was truncated by the output token limit.
 */
export function isOutputTruncated(pass: PassState): boolean {
  return pass.stopReason === "length" || pass.stopReason === "max_tokens";
}

/**
 * Build the escalated maxTokens value for the next recovery attempt.
 */
export function calculateEscalatedMaxTokens(
  currentMaxTokens: number,
  recoveryAttempt: number,
): number {
  return Math.ceil(
    currentMaxTokens * Math.pow(TOKEN_ESCALATION_MULTIPLIER, recoveryAttempt),
  );
}

/**
 * Inject the truncated partial output and a continuation prompt into
 * the conversation so the model can resume on the next iteration.
 *
 * Returns the escalated maxTokens value that should be used for the
 * next provider call.
 */
export function injectContinuationContext(
  currentMessages: ConversationMessage[],
  pass: PassState,
  context: AgenticContext,
  recoveryAttempt: number,
): number {
  const truncatedContent = pass.streamedText || pass.streamedThinking || "";

  if (truncatedContent.trim()) {
    currentMessages.push({
      role: "assistant",
      content: truncatedContent,
      ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
      ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
    });
  }

  currentMessages.push({
    role: "system",
    content: CONTINUATION_PROMPT,
  });

  const baseMaxTokens = context.options.maxTokens || DEFAULT_MAX_TOKENS;
  const escalatedMaxTokens = calculateEscalatedMaxTokens(baseMaxTokens, recoveryAttempt);

  logger.info(
    `[OutputTruncationRecovery] Recovery attempt ${recoveryAttempt}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}: ` +
      `escalating maxTokens from ${baseMaxTokens} → ${escalatedMaxTokens}. ` +
      `Preserved ${truncatedContent.length} chars of truncated output.`,
  );

  context.emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: "output_truncation_recovery",
    attempt: recoveryAttempt,
    maxAttempts: MAX_OUTPUT_TRUNCATION_RECOVERIES,
    escalatedMaxTokens,
  });

  return escalatedMaxTokens;
}

/**
 * Inject an error message into the conversation as an assistant-role
 * message so the LLM has context about the failure on the next turn.
 *
 * This is the "error-as-context" pattern — the error becomes part
 * of the conversational memory, visible to both the user and the agent.
 */
export function injectErrorAsConversationMessage(
  currentMessages: ConversationMessage[],
  errorDescription: string,
  context: AgenticContext,
): void {
  const errorMessage: ConversationMessage = {
    role: "assistant",
    content: `⚠️ **Error:** ${errorDescription}`,
    _isErrorIndicator: true,
  };

  currentMessages.push(errorMessage);

  context.emit({
    type: SERVER_SENT_EVENT_TYPES.CHUNK,
    content: errorMessage.content,
  });

  logger.warn(
    `[OutputTruncationRecovery] Injected error-as-context message: ${errorDescription.slice(0, 200)}`,
  );
}

/**
 * Build the user-facing error description when all recovery attempts
 * are exhausted.
 */
export function buildExhaustedRecoveryMessage(
  maxAttempts: number,
  configuredMaxTokens: number | string,
): string {
  return (
    `The model's response was cut short because the **max_tokens** limit ` +
    `(${configuredMaxTokens}) was reached, and ${maxAttempts} automatic ` +
    `continuation attempt(s) also hit the limit. This typically happens ` +
    `with very large tool call sequences or extremely long responses. ` +
    `Try increasing the **Max Tokens** setting in your model configuration, ` +
    `or break the task into smaller steps.`
  );
}

/**
 * Build the user-facing error description when a provider timeout
 * or network error occurs mid-loop.
 */
export function buildProviderErrorMessage(
  error: unknown,
  iteration: number,
): string {
  const errorText = error instanceof Error ? error.message : String(error);
  return (
    `The model provider encountered an error on iteration ${iteration}: ` +
    `\`${errorText}\`. The conversation history up to this point has been ` +
    `preserved. You can retry your request, or try a different model/provider ` +
    `if this persists.`
  );
}

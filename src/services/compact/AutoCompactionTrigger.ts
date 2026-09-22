import logger from "#src/utils/logger";
import { COMPACTION } from "#src/constants";
import { computeContextBudgets } from "./ContextBudgets.ts";

// ────────────────────────────────────────────────────────────
// AutoCompactionTrigger — Threshold-Based Auto-Compact
// ────────────────────────────────────────────────────────────
// Modeled after claude-code/src/services/compact/autoCompact.ts
//
// Determines when to automatically trigger LLM-powered compaction
// based on current token usage vs. the model's context window.
//
// Claude Code constants (from autoCompact.ts):
//   AUTOCOMPACT_BUFFER_TOKENS = 13_000
//   MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
//   WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
//   ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
//   MANUAL_COMPACT_BUFFER_TOKENS = 3_000
//   MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
//
// Claude Code threshold calculation:
//   effectiveWindow = contextWindow - min(maxOutputTokens, 20_000)
//   autoCompactThreshold = effectiveWindow - 13_000
// Both come from ContextBudgets — the same function that sets the
// truncation budget, so truncation can never fire below this threshold.
//
// The token count evaluated here is the whole request (messages + system
// prompt + tool schemas), from provider-reported usage whenever the loop
// has it (ContextBudgets.estimateRequestInputTokens).
// ────────────────────────────────────────────────────────────

const MINIMUM_MESSAGES_FOR_COMPACTION = COMPACTION.MINIMUM_MESSAGES_FOR_COMPACTION;

export interface AutoCompactThresholdResult {
  threshold: number;
  effectiveContextWindow: number;
  percentUsed: number;
  shouldCompact: boolean;
}

export default class AutoCompactionTrigger {
  /**
   * Calculate the effective context window size minus output reserve.
   *
   * Claude Code equivalent: getEffectiveContextWindowSize() in autoCompact.ts
   */
  static getEffectiveContextWindowSize(
    contextWindowSize: number,
    maxOutputTokens: number,
  ): number {
    return computeContextBudgets(contextWindowSize, maxOutputTokens)
      .effectiveWindow;
  }

  /**
   * Get the auto-compact threshold — the token count at which
   * compaction should be triggered.
   *
   * Claude Code equivalent: getAutoCompactThreshold() in autoCompact.ts
   */
  static getAutoCompactThreshold(
    contextWindowSize: number,
    maxOutputTokens: number,
  ): number {
    return computeContextBudgets(contextWindowSize, maxOutputTokens)
      .autoCompactThreshold;
  }

  /**
   * Check whether auto-compaction should trigger for the current token usage.
   *
   * `requestedByModel` (the compact_context tool directive) bypasses the
   * token threshold — the model chose this boundary itself (Self-Compacting
   * LM Agents, arXiv 2606.23525) — but the minimum-message floor still
   * applies so a trivial conversation can't be compacted into nothing.
   *
   * Returns a result object with the threshold, usage percentage, and decision.
   */
  static evaluate(
    estimatedTokens: number,
    contextWindowSize: number,
    maxOutputTokens: number,
    messageCount: number,
    requestedByModel: boolean = false,
  ): AutoCompactThresholdResult {
    const effectiveContextWindow = this.getEffectiveContextWindowSize(
      contextWindowSize,
      maxOutputTokens,
    );
    const threshold = this.getAutoCompactThreshold(
      contextWindowSize,
      maxOutputTokens,
    );
    const percentUsed =
      effectiveContextWindow > 0
        ? Math.round((estimatedTokens / effectiveContextWindow) * 100)
        : 0;

    const shouldCompact =
      (estimatedTokens >= threshold || requestedByModel) &&
      messageCount >= MINIMUM_MESSAGES_FOR_COMPACTION;

    if (shouldCompact) {
      logger.info(
        requestedByModel && estimatedTokens < threshold
          ? `[AutoCompaction] Model-requested compaction at ${estimatedTokens} tokens ` +
              `(below ${threshold} threshold, ${messageCount} messages)`
          : `[AutoCompaction] Threshold exceeded: ${estimatedTokens} tokens >= ${threshold} threshold ` +
              `(${percentUsed}% of ${effectiveContextWindow} effective window, ${messageCount} messages)`,
      );
    }

    return {
      threshold,
      effectiveContextWindow,
      percentUsed,
      shouldCompact,
    };
  }
}

import { COMPACTION } from "#src/constants";
import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
  MINIMUM_VIABLE_OUTPUT_TOKENS,
} from "#src/constants/TokenBudgetDefaults";

// ────────────────────────────────────────────────────────────
// ContextBudgets — the ONE effective-window function
// ────────────────────────────────────────────────────────────
// Every context-size decision in a loop reads its budget from here:
// AutoCompactionTrigger (when to summarize) and ContextWindowManager
// (when lossy truncation is the only way left to fit). Before this
// module the two computed their budgets independently, and for any
// window ≥ 128K the truncation budget sat BELOW the compaction
// threshold — a 200K model with 64K max output truncated at ~107K and
// never reached its 167K compaction threshold, so lossy truncation
// did compaction's job on every long conversation.
//
// Invariant (enforced here, tested in contextBudgets.test.ts):
//   autoCompactThreshold  ≤  truncationBudget
// so summarization always gets the first chance.
// ────────────────────────────────────────────────────────────

export interface ContextBudgets {
  contextWindow: number;
  maxOutputTokens: number;
  /** Window minus the output reserved for a summary (Claude Code: getEffectiveContextWindowSize). */
  effectiveWindow: number;
  /** Total request input at which LLM compaction triggers. */
  autoCompactThreshold: number;
  /**
   * Total request input above which lossy truncation may run: the largest
   * input the output clamp can still serve with a viable response, never
   * below the compaction threshold.
   */
  truncationBudget: number;
}

export function computeContextBudgets(
  contextWindow: number,
  maxOutputTokens: number,
): ContextBudgets {
  const effectiveWindow =
    contextWindow -
    Math.min(maxOutputTokens, COMPACTION.MAX_OUTPUT_TOKENS_FOR_SUMMARY);
  const autoCompactThreshold =
    effectiveWindow - COMPACTION.AUTOCOMPACT_BUFFER_TOKENS;
  // The output clamp (ContextBudgetTracker) keeps input × (1 + safety) +
  // headroom + output ≤ window; past this input it cannot leave the
  // minimum viable output and the exhaustion guard fires instead.
  const clampableInputLimit = Math.floor(
    (contextWindow -
      OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS -
      MINIMUM_VIABLE_OUTPUT_TOKENS) /
      (1 + OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER),
  );
  const truncationBudget = Math.max(
    Math.min(effectiveWindow, clampableInputLimit),
    autoCompactThreshold,
  );
  return {
    contextWindow,
    maxOutputTokens,
    effectiveWindow,
    autoCompactThreshold,
    truncationBudget,
  };
}

/**
 * The provider-reported size of the last request, paired with the chars/4
 * size of the messages that request carried — so the next estimate can add
 * only what changed since, in the same units the growth is measured in.
 */
export interface ProviderInputBaseline {
  /** Provider-reported input tokens INCLUDING cache reads and writes. */
  inputTokens: number;
  /** chars/4 estimate of the messages sent with that request. */
  messageTokens: number;
}

export interface RequestInputEstimate {
  tokens: number;
  source: "reported" | "estimated";
}

/**
 * Estimate the input tokens the NEXT request will carry.
 *
 * With a baseline (the previous model call of this loop reported its real
 * input): reported tokens + the chars/4 change in the message array since.
 * The report already contains the system prompt, tool schemas and cached
 * prefix, and it reflects the real tokenizer — dense content (JSON, hex,
 * code) that chars/4 undercounts by 2–3× is counted as it is billed.
 *
 * Without one (the first call of a turn, or a harness that records none):
 * chars/4 of the messages plus the system prompt and tool schemas
 * (`overheadTokens`) — the categories ContextBudgetTracker reports, which
 * the old trigger left out.
 */
export function estimateRequestInputTokens({
  messageTokens,
  overheadTokens,
  baseline,
}: {
  messageTokens: number;
  overheadTokens: number;
  baseline?: ProviderInputBaseline | null;
}): RequestInputEstimate {
  if (baseline && baseline.inputTokens > 0) {
    return {
      tokens: Math.max(
        0,
        baseline.inputTokens + (messageTokens - baseline.messageTokens),
      ),
      source: "reported",
    };
  }
  return { tokens: messageTokens + overheadTokens, source: "estimated" };
}

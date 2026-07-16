import { HARNESS } from "#src/constants";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { ConversationMessage } from "#src/services/harnesses/types";

// ────────────────────────────────────────────────────────────
// CompactionDeferralGuard — "when NOT to compact"
// ────────────────────────────────────────────────────────────
// Threshold-triggered compaction is reasoning-blind: it can fire the
// instant a fresh tool result lands — before the model has read it —
// or while the model is mid-recovery from a behavioral stall,
// destroying exactly the context the next step needs. This guard
// reframes the pressure threshold as PERMISSION to compact and defers
// while either suppression signal is active, up to a hard ceiling
// where pressure wins unconditionally (deferral must never run the
// window into exhaustion).
//
// Suppression signals:
//  1. Unread tool results — the tail (ignoring injected system
//     messages) is an assistant message whose tool calls carry
//     results the model has not yet responded to (mid-derivation).
//  2. Recent stall — SemanticStallDetector warned within the last
//     COMPACTION_STALL_SUPPRESSION_ITERATIONS iterations; compacting
//     away the evidence of what was already tried feeds the loop.
//
// A model-requested compaction (compact_context tool) bypasses this
// guard entirely — the model explicitly chose the boundary.
//
// Research basis (harness_landscape_survey_2026-07.md, A1):
//  - Self-Compacting LM Agents (Li, Zhang & Jurayj, arXiv 2606.23525) —
//    fire at sub-task resolution, suppress mid-derivation or when
//    stuck; matches fixed-interval summarization at 30-70% lower cost
//    while raising accuracy. https://arxiv.org/abs/2606.23525
//  - goose smart-context / OpenHands condenser — industry framings of
//    condensation as a policy decision rather than a threshold reflex:
//    https://github.com/OpenHands/software-agent-sdk
// ────────────────────────────────────────────────────────────

export interface CompactionDeferralVerdict {
  defer: boolean;
  reason: "unread_tool_results" | "recent_stall" | null;
}

const NO_DEFERRAL: CompactionDeferralVerdict = { defer: false, reason: null };

/**
 * True when the newest substantive message is an assistant message whose
 * tool calls carry results the model has not yet read (the loop appends
 * results then re-streams — at the top of the next iteration the model
 * still hasn't seen them). Injected system messages after it are skipped.
 */
export function hasUnreadToolResults(
  messages: ConversationMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "system") continue;
    return (
      message.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length > 0 &&
      message.toolCalls.some((toolCall) => toolCall.result != null)
    );
  }
  return false;
}

/**
 * Evaluate whether compaction should defer this iteration.
 * Pure — pressure ceilings are applied by the caller, which knows
 * which compaction layer (micro vs LLM) is being gated.
 */
export function evaluateCompactionDeferral(
  messages: ConversationMessage[],
  state: AgenticLoopState,
): CompactionDeferralVerdict {
  if (hasUnreadToolResults(messages)) {
    return { defer: true, reason: "unread_tool_results" };
  }
  if (
    state.lastStallWarningIteration !== null &&
    state.iterations - state.lastStallWarningIteration <=
      HARNESS.COMPACTION_STALL_SUPPRESSION_ITERATIONS
  ) {
    return { defer: true, reason: "recent_stall" };
  }
  return NO_DEFERRAL;
}

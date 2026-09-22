import { PROMPT_DELIMITERS } from "#src/constants";
import { pristineOf } from "#src/services/compact/MessageLineage";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, ConversationMessage } from "#src/services/harnesses/types";
import type { MessagePayload } from "#src/services/conversation/types";

// ────────────────────────────────────────────────────────────
// TurnTranscript — what a turn persists, independent of what the model sees
// ────────────────────────────────────────────────────────────
// The loop's message array is a VIEW: micro-compaction replaces old tool
// results with offload stubs, LLM compaction replaces everything older
// than the recent window with a summary, truncation caps or drops what is
// left. Persistence used to slice that same array (computeNewTurnMessages
// from originalMessageCount), which only worked while those layers never
// touched the current turn. With recency protection they do — a long run
// compacts its own early iterations — and the slice would lose them.
//
// So the turn keeps a transcript: at every point where the view is about
// to shrink (the top of ContextPressureManager, enforceContextWindow) and
// at checkpoint/finalize, every message not yet classified is recorded by
// its VERBATIM original (MessageLineage.pristineOf). The first recording
// uses the long-standing slice semantics, so which messages belong to the
// turn is unchanged; from then on, anything the loop adds is recorded
// before the next shrink can hide it.
// ────────────────────────────────────────────────────────────

/**
 * Slice and filter message history to identify new messages for the current turn.
 * Shared between BaseAgenticHarness execution and test suite assertion suites to ensure
 * they do not diverge.
 *
 * For sub-agents, the initial messages array contains both a system message
 * (operational context: topology, workspace, delegation rules) and a user
 * message (the task prompt). Both are new and must be persisted. The scan
 * below walks backward from the default slice point to find the earliest
 * consecutive non-persisted original message so nothing is dropped.
 */
export function computeNewTurnMessages(
  originalMessages: MessagePayload[],
  currentMessages: MessagePayload[],
  originalMessageCount: number,
): MessagePayload[] {
  const lastOriginalMessage = originalMessages[originalMessageCount - 1];
  const isLastAlreadyPersisted =
    lastOriginalMessage && lastOriginalMessage._alreadyPersisted === true;

  let sliceIndex: number;
  if (isLastAlreadyPersisted) {
    // All originals are already in the DB — only persist new messages
    sliceIndex = originalMessageCount;
  } else {
    // Default: include the last original message (the triggering user input)
    sliceIndex = Math.max(0, originalMessageCount - 1);

    // Walk backward to include any preceding non-persisted original messages
    // (e.g. sub-agent operational context system message at index 0)
    for (let scanIndex = sliceIndex - 1; scanIndex >= 0; scanIndex--) {
      if (originalMessages[scanIndex]?._alreadyPersisted) break;
      sliceIndex = scanIndex;
    }
  }

  return currentMessages
    .slice(sliceIndex)
    .filter(
      (message) =>
        !(
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)
        ) && !message._alreadyPersisted,
    );
}

/** A message the turn produced (not history, not a synthetic context artifact). */
function belongsToTurn(message: ConversationMessage): boolean {
  if (message._alreadyPersisted === true) return false;
  if (message.isCompactSummary === true) return false;
  return !(
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)
  );
}

/**
 * Record every not-yet-classified message of the view. Call before any
 * layer shrinks the view, and before reading the transcript.
 */
export function syncTurnTranscript(
  context: Pick<AgenticContext, "messages">,
  state: AgenticLoopState,
  view: ConversationMessage[],
): void {
  if (!state.turnTranscript) {
    state.turnTranscript = (
      computeNewTurnMessages(
        context.messages as MessagePayload[],
        view as MessagePayload[],
        state.originalMessageCount,
      ) as ConversationMessage[]
    ).map(pristineOf);
    for (const message of view) state.turnTranscriptSeen.add(pristineOf(message));
    for (const message of state.turnTranscript) state.turnTranscriptSeen.add(message);
    return;
  }
  for (const viewMessage of view) {
    const message = pristineOf(viewMessage);
    if (state.turnTranscriptSeen.has(message)) continue;
    state.turnTranscriptSeen.add(message);
    if (belongsToTurn(message)) state.turnTranscript.push(message);
  }
}

/**
 * The turn's messages for persistence, verbatim and in order. Before the
 * transcript exists (a harness that never reached a pressure boundary) this
 * is the classic slice of the view.
 */
export function collectTurnMessages(
  context: Pick<AgenticContext, "messages">,
  state: AgenticLoopState,
  view: ConversationMessage[],
): ConversationMessage[] {
  if (!state.turnTranscript) {
    return (
      computeNewTurnMessages(
        context.messages as MessagePayload[],
        view as MessagePayload[],
        state.originalMessageCount,
      ) as ConversationMessage[]
    ).map(pristineOf);
  }
  syncTurnTranscript(context, state, view);
  return [...state.turnTranscript];
}

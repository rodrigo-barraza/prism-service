import { TURN_RESUME } from "#src/constants";
import { resolveToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import { APPROVAL_TIERS } from "#src/services/AutoApprovalEngine";
import type AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import type { StoredPass } from "#src/services/TurnRunStore";
import type { PassState, StreamChunk, ToolCall } from "#src/services/harnesses/types";

/**
 * ResumedPass — the pass a restart interrupted, played back into a
 * re-driven turn (TurnResumeService → ReActHarness).
 *
 * The model already answered: its text, thinking and tool calls are on
 * record (TurnRunStore). Asking again would spend a request and could
 * answer differently — and the decisions the user made (or is making) are
 * about THESE calls. So the re-driven turn's first iteration consumes a
 * REPLAY of the stored pass through the ordinary stream path: the same
 * chunk router fills the pass and the loop state, viewers see the answer
 * again, and every downstream stage (PreToolUse, the approval gate, the
 * tool batch, plan mode) runs unchanged on the same calls.
 *
 * What the restart left of each call decides what the batch does with it
 * (`stampResumedCalls`):
 *
 *   - finished      its recorded result stands — not asked about, not re-run;
 *   - never started it goes through the gate like any call (a decision the
 *                   user already made is picked up by the ApprovalRegistry);
 *   - interrupted   it was running when the process died and may have
 *                   partly happened. A read-only call (AUTO tier with no
 *                   side-effect capability, or flagged idempotent) simply
 *                   runs again; anything else is UNCERTAIN and runs again
 *                   only if the user says so ("the server restarted while
 *                   X was running — run it again?").
 */

/** The stored pass as the chunks a provider would have streamed. */
export async function* replayPassStream(stored: StoredPass): AsyncGenerator<StreamChunk | string> {
  if (stored.providerResponseId || stored.phase !== undefined || stored.reasoningItems?.length) {
    yield {
      type: "providerState",
      ...(stored.providerResponseId ? { providerResponseId: stored.providerResponseId } : {}),
      ...(stored.phase !== undefined ? { phase: stored.phase } : {}),
      ...(stored.reasoningItems?.length ? { reasoningItems: stored.reasoningItems } : {}),
    } as StreamChunk;
  }
  if (stored.thinking) yield { type: "thinking", content: stored.thinking } as StreamChunk;
  for (const block of stored.thinkingBlocks ?? []) {
    yield { type: "thinking_block", block } as StreamChunk;
  }
  if (stored.thinkingSignature) {
    yield { type: "thinking_signature", signature: stored.thinkingSignature } as StreamChunk;
  }
  if (stored.text) yield stored.text;
  for (const toolCall of stored.toolCalls) {
    yield {
      type: "toolCall",
      id: toolCall.id ?? undefined,
      name: toolCall.name,
      args: toolCall.args,
      ...(toolCall.responsesItemId ? { responsesItemId: toolCall.responsesItemId } : {}),
      ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
      ...(toolCall.reasoningItem ? { reasoningItem: toolCall.reasoningItem } : {}),
    } as StreamChunk;
  }
}

/**
 * Whether a call a restart cut off may simply run again: read-only (AUTO
 * tier and no side-effect capability) or flagged idempotent.
 */
export function mayRerunAfterRestart(toolName: string, approvalEngine: AutoApprovalEngine): boolean {
  if ((TURN_RESUME.RERUNNABLE_TOOL_NAMES as readonly string[]).includes(toolName)) return true;
  if ((TURN_RESUME.NOT_RERUNNABLE_TOOL_NAMES as readonly string[]).includes(toolName)) return false;
  if (approvalEngine.getTier(toolName) !== APPROVAL_TIERS.AUTO) return false;
  const sideEffects = TURN_RESUME.SIDE_EFFECT_CAPABILITIES as readonly string[];
  return !resolveToolCapabilities(toolName).some((capability) => sideEffects.includes(capability));
}

/** Stamp each call of a replayed pass with what the restart left of it. */
export function stampResumedCalls(
  pass: PassState,
  stored: StoredPass,
  approvalEngine: AutoApprovalEngine,
): void {
  pass.pendingToolCalls.forEach((toolCall, index) => {
    const recorded = stored.calls?.[String(index)];
    if (!recorded) return; // never started: an ordinary call
    if (recorded.status === "finished" && !recorded.resultOmitted) {
      toolCall._resumed = {
        status: "finished",
        result: recorded.result,
        ...(recorded.durationMilliseconds !== undefined
          ? { durationMilliseconds: recorded.durationMilliseconds }
          : {}),
      };
      return;
    }
    toolCall._resumed = {
      status: mayRerunAfterRestart(toolCall.name, approvalEngine) ? "rerun" : "interrupted",
    };
  });
}

/**
 * Split a batch: the calls that finished before the restart (they skip
 * PreToolUse and the gate — they already ran) and the rest.
 */
export function partitionResumedCalls(toolCalls: ToolCall[]): {
  finished: ToolCall[];
  remaining: ToolCall[];
} {
  const finished: ToolCall[] = [];
  const remaining: ToolCall[] = [];
  for (const toolCall of toolCalls) {
    (toolCall._resumed?.status === "finished" ? finished : remaining).push(toolCall);
  }
  return { finished, remaining };
}

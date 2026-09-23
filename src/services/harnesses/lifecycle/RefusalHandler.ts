import logger from "#src/utils/logger";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  EmitFunction,
  ModelRefusal,
} from "#src/services/harnesses/types";
import { PROTOCOL_EVENT_TYPES } from "#src/protocol/events";

/** SSE event that ends a turn a provider safety classifier declined. */
export const MODEL_REFUSAL_EVENT = PROTOCOL_EVENT_TYPES.REFUSAL;

/**
 * A safety-classifier refusal (Anthropic `stop_reason: "refusal"`) is an
 * outcome, not an empty response: it is never retried with an "empty
 * output" nudge, whatever the refusing pass streamed is discarded by the
 * caller, and the turn ends with a typed event carrying the category.
 */
export function recordRefusal(
  refusal: ModelRefusal,
  state: AgenticLoopState,
  emit: EmitFunction,
  harnessLabel: string,
): void {
  state.refusal = refusal;
  state.conversationOutcome = "refused";
  // The refusing pass's thinking blocks must not reach the final message.
  state.thinkingBlocks = undefined;
  logger.warn(
    `[${harnessLabel}] ${refusal.model ?? "the model"} declined iteration ${state.iterations} ` +
      `(category=${refusal.category ?? "none"})${refusal.explanation ? `: ${refusal.explanation}` : ""}`,
  );
  emit({
    type: MODEL_REFUSAL_EVENT,
    category: refusal.category,
    explanation: refusal.explanation,
    ...(refusal.recommendedModel && { recommendedModel: refusal.recommendedModel }),
    ...(refusal.model && { model: refusal.model }),
    iteration: state.iterations,
  });
}

import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import type { ConversationMessage } from "#src/services/harnesses/types";

/**
 * A plan-mode pass that answered in text keeps that text as an assistant
 * message — and is followed by this continuation, so the next request never
 * ends on an assistant turn. That would be a prefill, which every Claude
 * 4.6+ model rejects with a 400. The provider adapters deliver it as a user
 * turn (or a mid-conversation system message where the model takes one).
 */
export function buildPlanSubmissionContinuation(
  locale?: string,
): ConversationMessage {
  return {
    role: "system",
    content: wrapSystemMessage(
      SYSTEM_MESSAGE_TAGS.PLAN_MODE,
      PromptLocaleService.get(
        locale || PromptLocaleService.getDefaultLocale(),
        "harness.planningMode.submitPlan",
      ),
    ),
  };
}

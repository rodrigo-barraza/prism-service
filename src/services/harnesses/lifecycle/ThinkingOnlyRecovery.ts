import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import type { ConversationMessage } from "#src/services/harnesses/types";

/**
 * What the harness sends after a pass that reasoned but answered nothing —
 * no text, no tool call. It is a harness message (tagged, turn-scoped),
 * never a user turn: sent as the user's `[System: Reasoning preserved…]`,
 * it showed in the chat as five messages the user never wrote, and the
 * model read it as an injection attempt (conversation 9cf6ebdd,
 * 2026-10-04). The caller bounds how many it sends, on the empty-output
 * budget (MAX_EMPTY_OUTPUT_RETRIES).
 */
export function buildThinkingOnlyNudge(locale?: string): ConversationMessage {
  return {
    role: "system",
    content: wrapSystemMessage(
      SYSTEM_MESSAGE_TAGS.EMPTY_OUTPUT,
      PromptLocaleService.get(
        locale || PromptLocaleService.getDefaultLocale(),
        "harness.emptyOutput.thinkingOnly",
      ),
    ),
    turnScoped: true,
  };
}

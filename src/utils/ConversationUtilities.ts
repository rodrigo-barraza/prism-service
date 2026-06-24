import ConversationService from "../services/ConversationService.ts";
import logger from "./logger.ts";
import type { ChatMessage } from "../types/admin.ts";
import type { MessagePayload } from "../services/RequestLogger.ts";
import { COLLECTIONS } from "../constants.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

// ─── Conversation persistence helpers ───────────────────────

/**
 * Mark a conversation as generating (or not). Fire-and-forget with
 * error logging — the caller should not await or chain on this.
 */
export function markGenerating(
  conversationId: string | null | undefined,
  project: string,
  username: string,
  generating: boolean,
  opts: { collection?: string; agent?: string; title?: string; agentConversationId?: string } = {},
): void {
  if (!conversationId) return;
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    generating,
    opts,
  ).catch((error: unknown) =>
    logger.error(
      `Failed to ${generating ? "set" : "clear"} isGenerating: ${getErrorMessage(error)}`,
    ),
  );
}

/**
 * Append messages to a conversation and clear the isGenerating flag.
 * Fire-and-forget with error logging.
 *
 * IMPORTANT: isGenerating is always cleared, even when appendMessages
 * fails — preventing sessions from being permanently stuck as
 * "generating" when the $push operation encounters errors.
 */
export async function appendAndFinalize(
  conversationId: string | null | undefined,
  project: string,
  username: string,
  messagesToAppend: Array<ChatMessage | MessagePayload>,
  meta: Record<string, unknown> | null | undefined,
  opts: { collection?: string } = {},
): Promise<void> {
  if (!conversationId) return;

  try {
    await ConversationService.appendMessages(
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
      opts,
    );
    await ConversationService.setGenerating(
      conversationId,
      project,
      username,
      false,
      opts,
    );
  } catch (error: unknown) {
    logger.error(
      `Failed to append ${messagesToAppend?.length ?? 0} messages to ${conversationId} ` +
        `(project=${project}, collection=${opts?.collection || COLLECTIONS.MODEL_CONVERSATIONS}): ${getErrorMessage(error)}`,
    );

    // Always clear isGenerating even on failure — prevents sessions
    // from being permanently stuck as "generating" on the next page load.
    try {
      await ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
        opts,
      );
    } catch (clearError: unknown) {
      logger.error(
        `Failed to clear isGenerating after append failure: ${getErrorMessage(clearError)}`,
      );
    }
  }
}

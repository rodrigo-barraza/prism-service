import ConversationService from "#src/services/ConversationService";
import logger from "./logger.ts";
import type { ChatMessage } from "#src/types/admin";
import type { MessagePayload } from "#src/services/RequestLogger";
import { COLLECTIONS } from "#src/constants";
import { getErrorMessage } from "#src/utils/ErrorHelpers";

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
  opts: {
    collection?: string;
    agent?: string;
    title?: string;
    agentConversationId?: string;
  } = {},
): void {
  if (!conversationId) return;
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    generating,
    opts,
  ).catch((error: Error) =>
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
 *
 * When `skipGeneratingClear` is true, messages are persisted but the
 * isGenerating flag is NOT cleared. Used by the non-blocking sub-agent
 * dispatch path: the initial finalize persists the orchestrator's
 * messages while keeping the conversation marked as active until the
 * auto-response completes and clears the flag itself.
 */
export async function appendAndFinalize(
  conversationId: string | null | undefined,
  project: string,
  username: string,
  messagesToAppend: Array<ChatMessage | MessagePayload>,
  meta: Record<string, unknown> | null | undefined,
  opts: { collection?: string; skipGeneratingClear?: boolean } = {},
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
    if (!opts.skipGeneratingClear) {
      await ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
        opts,
      );
    }
  } catch (error: unknown) {
    logger.error(
      `Failed to append ${messagesToAppend?.length ?? 0} messages to ${conversationId} ` +
        `(project=${project}, collection=${opts?.collection || COLLECTIONS.MODEL_CONVERSATIONS}): ${getErrorMessage(error)}`,
    );

    // Always clear isGenerating even on failure — prevents sessions
    // from being permanently stuck as "generating" on the next page load.
    // Exception: when skipGeneratingClear is true, the caller owns the flag lifecycle.
    if (!opts.skipGeneratingClear) {
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
}

import ConversationService from "../services/ConversationService.js";
import logger from "./logger.js";
// ─── Conversation persistence helpers ───────────────────────
/**
 * Mark a conversation as generating (or not). Fire-and-forget with
 * error logging — the caller should not await or chain on this.
 *


 */
export function markGenerating(conversationId, project, username, generating, opts) {
    if (!conversationId)
        return;
    ConversationService.setGenerating(conversationId, project, username, generating, opts).catch((error) => logger.error(`Failed to ${generating ? "set" : "clear"} isGenerating: ${error.message}`));
}
/**
 * Append messages to a conversation and clear the isGenerating flag.
 * Fire-and-forget with error logging.
 *
 * IMPORTANT: isGenerating is always cleared, even when appendMessages
 * fails — preventing sessions from being permanently stuck as
 * "generating" when the $push operation encounters errors.
 *


 */
export function appendAndFinalize(conversationId, project, username, messagesToAppend, meta, opts) {
    if (!conversationId)
        return;
    ConversationService.appendMessages(conversationId, project, username, messagesToAppend, meta, opts)
        .then(() => ConversationService.setGenerating(conversationId, project, username, false, opts))
        .catch((error) => {
        logger.error(`Failed to append ${messagesToAppend?.length ?? 0} messages to ${conversationId} ` +
            `(project=${project}, collection=${opts?.collection || "conversations"}): ${error.message}`);
        // Always clear isGenerating even on failure — prevents sessions
        // from being permanently stuck as "generating" on the next page load.
        ConversationService.setGenerating(conversationId, project, username, false, opts).catch((clearErr) => logger.error(`Failed to clear isGenerating after append failure: ${clearErr.message}`));
    });
}
//# sourceMappingURL=ConversationUtilities.js.map
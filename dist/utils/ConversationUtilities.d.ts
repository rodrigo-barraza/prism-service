/**
 * Mark a conversation as generating (or not). Fire-and-forget with
 * error logging — the caller should not await or chain on this.
 *


 */
export declare function markGenerating(conversationId: Record<string, unknown>, project: Record<string, unknown>, username: string, generating: Record<string, unknown>, opts: Record<string, unknown>): void;
/**
 * Append messages to a conversation and clear the isGenerating flag.
 * Fire-and-forget with error logging.
 *
 * IMPORTANT: isGenerating is always cleared, even when appendMessages
 * fails — preventing sessions from being permanently stuck as
 * "generating" when the $push operation encounters errors.
 *


 */
export declare function appendAndFinalize(conversationId: Record<string, unknown>, project: Record<string, unknown>, username: string, messagesToAppend: Record<string, unknown>, meta: Record<string, unknown>, opts: Record<string, unknown>): void;
//# sourceMappingURL=ConversationUtilities.d.ts.map
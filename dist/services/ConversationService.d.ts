/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.


 * @returns {Promise<Array>} messages with refs replacing inline data
 */
export declare function extractFiles(messages: Record<string, unknown>, project?: Record<string, unknown>, username?: string): Promise<Record<string, unknown> | Record<string, unknown>[]>;
/**
 * Compute input/output modalities from messages for lightweight querying.

 * @returns {Object} modalities flags
 */
export declare function computeModalities(messages: Record<string, unknown>): {
    textIn: boolean;
    textOut: boolean;
    imageIn: boolean;
    imageOut: boolean;
    audioIn: boolean;
    audioOut: boolean;
    docIn: boolean;
    webSearch: boolean;
    codeExecution: boolean;
    functionCalling: boolean;
    thinking: boolean;
};
/**
 * Extract unique providers from messages and settings.


 */
export declare function extractProviders(messages: Record<string, unknown>, settings: Record<string, unknown>): unknown[];
/**
 * Compute total estimated cost across all messages.


 */
export declare function computeTotalCost(messages: Record<string, unknown>): number;
/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 *

 * @returns {object} $set fields ready for updateOne
 */
export declare function buildConversationPatchFields({ title, messages, systemPrompt, settings, }: Record<string, unknown>): {
    updatedAt: string;
};
/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
declare const ConversationService: {
    /**
       * Append messages to a conversation, auto-creating it if it doesn't exist.
       * Handles file extraction (MinIO upload) and recomputes derived fields.
       * Optionally applies conversation metadata (title, systemPrompt, settings).
       *
  
  
       * @returns {Promise<object>} The updated conversation document
       */
    appendMessages(conversationId: Record<string, unknown>, project: Record<string, unknown>, username: string, newMessages: Record<string, unknown>, conversationMeta?: Record<string, unknown>, { collection }?: Record<string, unknown>): Promise<{
        modalities: {
            textIn: boolean;
            textOut: boolean;
            imageIn: boolean;
            imageOut: boolean;
            audioIn: boolean;
            audioOut: boolean;
            docIn: boolean;
            webSearch: boolean;
            codeExecution: boolean;
            functionCalling: boolean;
            thinking: boolean;
        };
        providers: unknown[];
        totalCost: number;
        _id: import("bson").ObjectId;
    }>;
    /**
     * Set or clear the isGenerating flag on a conversation.
     * Lightweight update — only touches isGenerating + updatedAt.
     *
  
  
     */
    setGenerating(conversationId: Record<string, unknown>, project: Record<string, unknown>, username: string, generating: Record<string, unknown>, { collection, agent }?: Record<string, unknown>): Promise<void>;
};
export default ConversationService;
//# sourceMappingURL=ConversationService.d.ts.map
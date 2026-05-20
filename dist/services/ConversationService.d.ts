/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.


 * @returns {Promise<Array>} messages with refs replacing inline data
 */
export declare function extractFiles(messages: any, project?: any, username?: string): Promise<any>;
/**
 * Compute input/output modalities from messages for lightweight querying.

 * @returns {Object} modalities flags
 */
export declare function computeModalities(messages: any): {
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
export declare function extractProviders(messages: any, settings: any): unknown[];
/**
 * Compute total estimated cost across all messages.


 */
export declare function computeTotalCost(messages: any): number;
/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 *

 * @returns {object} $set fields ready for updateOne
 */
export declare function buildConversationPatchFields({ title, messages, systemPrompt, settings, }: any): {
    updatedAt: string;
};
/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
declare const ConversationService: any;
export default ConversationService;
//# sourceMappingURL=ConversationService.d.ts.map
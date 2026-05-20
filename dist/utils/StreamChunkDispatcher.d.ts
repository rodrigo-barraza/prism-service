/**
 * Strip XML tool call markup that some local models (e.g. Gemma 4) leak into
 * text output. Applied server-side so SSE chunk events arrive clean.
 *
 * Handles both completed tags (matched pairs) and incomplete tags at the
 * end of a streaming buffer (closing tag hasn't arrived yet).
 *


 */
export declare function stripToolCallMarkup(text: any): any;
/**
 * Process a provider image chunk: upload to MinIO and track the ref.
 *


 * @returns {Promise<string|null>} MinIO ref, or null on failure
 */
export declare function uploadImageChunk(chunk: any, project: any, username: string, logPrefix?: any): Promise<any>;
/**
 * Create an image ref string, preferring MinIO ref over inline base64.
 *


 */
export declare function imageRefOrInline(minioRef: any, data: any, mimeType?: any): any;
/**
 * Dispatch a single typed chunk to an accumulator state object and emit function.
 *
 * This is the single source of truth for the chunk type → handler mapping that was
 * previously duplicated across chat.js (handleStreamingText) and AgenticLoopService.
 *


 * @param {string|null} state.thinking - Accumulated thinking text
 * @param {string} state.thinkingSignature - Anthropic thinking signature
 * @param {Array} state.images - Accumulated MinIO image refs
 * @param {Array} state.toolCalls - Accumulated tool call entries
 * @param {Array} state.audioChunks - Base64-encoded PCM audio chunks
 * @param {number} state.audioSampleRate - Detected audio sample rate
 * @param {number} state.outputCharacters - Total output character count
 * @param {string} state.text - Accumulated text output
 * @param {number|null} state.firstTokenTime - First text token timestamp
 * @param {number|null} state.generationEnd - Last token timestamp
 * @param {object|null} state.usage - Usage object from provider

 * @param {Function} context.emit - SSE emit function
 * @param {string} context.project
 * @param {string} context.username


 * @returns {Promise<boolean>} true if chunk was handled, false if unrecognised
 */
export declare function dispatchChunk(chunk: any, state: any, context: any, options?: any): Promise<boolean>;
/**
 * Create a fresh state accumulator for stream chunk dispatching.

 */
export declare function createStreamState(): {
    usage: null;
    firstTokenTime: null;
    generationEnd: null;
    requestStart: null;
    outputCharacters: number;
    text: string;
    thinking: string;
    thinkingSignature: string;
    images: never[];
    toolCalls: never[];
    audioChunks: never[];
    audioSampleRate: number;
    rateLimits: null;
};
//# sourceMappingURL=StreamChunkDispatcher.d.ts.map
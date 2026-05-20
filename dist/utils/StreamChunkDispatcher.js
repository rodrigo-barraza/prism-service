// ─────────────────────────────────────────────────────────────
// StreamChunkDispatcher — Shared stream chunk processing
// ─────────────────────────────────────────────────────────────
// Centralises the chunk-type dispatching logic used by
// handleStreamingText (chat.js) and AgenticLoopService.
// ─────────────────────────────────────────────────────────────
import FileService from "../services/FileService.js";
import logger from "./logger.js";
/**
 * Strip XML tool call markup that some local models (e.g. Gemma 4) leak into
 * text output. Applied server-side so SSE chunk events arrive clean.
 *
 * Handles both completed tags (matched pairs) and incomplete tags at the
 * end of a streaming buffer (closing tag hasn't arrived yet).
 *


 */
export function stripToolCallMarkup(text) {
    return (
    // @ts-ignore - TODO: strict typing
    text
        // Completed tag pairs
        .replace(/<\|?tool_call\|?>[\s\S]*?<\/?\|?tool_call\|?>/gi, "")
        .replace(/<\|?tool_response\|?>[\s\S]*?<\/?\|?tool_response\|?>/gi, "")
        .replace(/<\|?result\|?>[\s\S]*?<\/?\|?result\|?>/gi, "")
        .replace(/\[END_TOOL_REQUEST\]/gi, "")
        // Incomplete tags at end of stream (closing tag hasn't arrived yet)
        .replace(/<\|?tool_call\|?>[\s\S]*$/gi, "")
        .replace(/<\|?tool_response\|?>[\s\S]*$/gi, "")
        .replace(/<\|?result\|?>[\s\S]*$/gi, ""));
}
/**
 * Process a provider image chunk: upload to MinIO and track the ref.
 *


 * @returns {Promise<string|null>} MinIO ref, or null on failure
 */
export async function uploadImageChunk(chunk, project, username, 
// @ts-ignore - TODO: strict typing
logPrefix = "stream") {
    if (!chunk.data)
        return null;
    try {
        const mimeType = chunk.mimeType || "image/png";
        const dataUrl = `data:${mimeType};base64,${chunk.data}`;
        const { ref } = await FileService.uploadFile(dataUrl, "generations", 
        // @ts-ignore - TODO: strict typing
        project, username);
        return ref;
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[${logPrefix}] MinIO upload failed: ${error.message}`);
        return null;
    }
}
/**
 * Create an image ref string, preferring MinIO ref over inline base64.
 *


 */
export function imageRefOrInline(minioRef, data, 
// @ts-ignore - TODO: strict typing
mimeType = "image/png") {
    return minioRef || `data:${mimeType};base64,${data}`;
}
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
export async function dispatchChunk(chunk, state, context, options = {}) {
    const { emit, project, username } = context;
    // @ts-ignore
    const logPrefix = options.logPrefix || "stream";
    // Non-object chunks are treated as text (raw string from provider)
    if (!chunk || typeof chunk !== "object") {
        if (!state.firstTokenTime) {
            state.firstTokenTime = performance.now();
            if (state.requestStart) {
                // @ts-ignore - TODO: strict typing
                emit({
                    type: "status",
                    message: "generation_started",
                    // @ts-ignore - TODO: strict typing
                    timeToFirstToken: (state.firstTokenTime - state.requestStart) / 1000,
                });
            }
        }
        state.generationEnd = performance.now();
        const rawStr = typeof chunk === "string" ? chunk : "";
        state.text += rawStr;
        // Strip tool call XML markup leaked by some local models (Gemma 4)
        // @ts-ignore - TODO: strict typing
        const cleanText = stripToolCallMarkup(state.text);
        const chunkStr = cleanText.slice(state.outputCharacters);
        state.outputCharacters = cleanText.length;
        if (chunkStr)
            // @ts-ignore - TODO: strict typing
            emit({
                type: "chunk",
                content: chunkStr,
                outputCharacters: state.outputCharacters,
            });
        return true;
    }
    switch (chunk.type) {
        case "usage":
            // @ts-ignore
            if (options.onUsage) {
                // @ts-ignore
                options.onUsage(chunk.usage);
            }
            else {
                state.usage = chunk.usage;
            }
            return true;
        case "rateLimits":
            state.rateLimits = chunk.rateLimits;
            return true;
        case "thinking":
            if (!state.firstTokenTime) {
                state.firstTokenTime = performance.now();
                if (state.requestStart) {
                    // @ts-ignore - TODO: strict typing
                    emit({
                        type: "status",
                        message: "generation_started",
                        timeToFirstToken: 
                        // @ts-ignore - TODO: strict typing
                        (state.firstTokenTime - state.requestStart) / 1000,
                    });
                }
            }
            state.generationEnd = performance.now();
            // @ts-ignore - TODO: strict typing
            state.thinking += chunk.content;
            // @ts-ignore - TODO: strict typing
            state.outputCharacters += (chunk.content || "").length;
            // @ts-ignore - TODO: strict typing
            emit({
                type: "thinking",
                content: chunk.content,
                outputCharacters: state.outputCharacters,
            });
            return true;
        case "thinking_signature":
            state.thinkingSignature = chunk.signature;
            return true;
        case "image": {
            const minioRef = await uploadImageChunk(chunk, 
            // @ts-ignore - TODO: strict typing
            project, username, logPrefix);
            if (chunk.data) {
                // @ts-ignore - TODO: strict typing
                state.images.push(
                // @ts-ignore - TODO: strict typing
                imageRefOrInline(minioRef, chunk.data, chunk.mimeType));
            }
            // @ts-ignore - TODO: strict typing
            emit({
                type: "image",
                data: chunk.data,
                mimeType: chunk.mimeType,
                minioRef,
            });
            return true;
        }
        case "executableCode":
            // @ts-ignore - TODO: strict typing
            emit({
                type: "executableCode",
                code: chunk.code,
                language: chunk.language,
            });
            return true;
        case "codeExecutionResult":
            // @ts-ignore - TODO: strict typing
            emit({
                type: "codeExecutionResult",
                output: chunk.output,
                outcome: chunk.outcome,
            });
            return true;
        case "webSearchResult":
            // @ts-ignore - TODO: strict typing
            emit({ type: "webSearchResult", results: chunk.results });
            return true;
        case "audio":
            // @ts-ignore - TODO: strict typing
            emit({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
            // @ts-ignore - TODO: strict typing
            if (chunk.data)
                state.audioChunks.push(chunk.data);
            if (chunk.mimeType) {
                // @ts-ignore - TODO: strict typing
                const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
                if (rateMatch)
                    state.audioSampleRate = parseInt(rateMatch[1], 10);
            }
            return true;
        case "toolCall":
            // Tool call chunks indicate model output — track generation timing
            if (!state.firstTokenTime) {
                state.firstTokenTime = performance.now();
                if (state.requestStart) {
                    // @ts-ignore - TODO: strict typing
                    emit({
                        type: "status",
                        message: "generation_started",
                        timeToFirstToken: 
                        // @ts-ignore - TODO: strict typing
                        (state.firstTokenTime - state.requestStart) / 1000,
                    });
                }
            }
            state.generationEnd = performance.now();
            if (chunk.status === "done" || chunk.status === "error") {
                // @ts-ignore - TODO: strict typing
                const existing = state.toolCalls.find((tc) => (chunk.id && tc.id === chunk.id) ||
                    (!chunk.id && tc.name === chunk.name && !tc.result));
                if (existing) {
                    existing.result = chunk.result || undefined;
                    existing.status = chunk.status;
                    if (chunk.args && Object.keys(chunk.args).length > 0) {
                        existing.args = chunk.args;
                    }
                }
            }
            else {
                // @ts-ignore - TODO: strict typing
                state.toolCalls.push({
                    id: chunk.id || null,
                    name: chunk.name,
                    args: chunk.args || {},
                    result: chunk.result || undefined,
                    status: chunk.status || undefined,
                    thoughtSignature: chunk.thoughtSignature || undefined,
                });
            }
            // @ts-ignore - TODO: strict typing
            emit({
                type: "toolCall",
                id: chunk.id || null,
                name: chunk.name,
                args: chunk.args || {},
                result: chunk.result || undefined,
                status: chunk.status || undefined,
                thoughtSignature: chunk.thoughtSignature || undefined,
            });
            return true;
        case "toolCallDelta":
            // Incremental tool call argument streaming — track generation timing
            // so the throughput badge stays alive, but don't emit to the client.
            if (!state.firstTokenTime) {
                state.firstTokenTime = performance.now();
                if (state.requestStart) {
                    // @ts-ignore - TODO: strict typing
                    emit({
                        type: "status",
                        message: "generation_started",
                        timeToFirstToken: 
                        // @ts-ignore - TODO: strict typing
                        (state.firstTokenTime - state.requestStart) / 1000,
                    });
                }
            }
            state.generationEnd = performance.now();
            // @ts-ignore - TODO: strict typing
            state.outputCharacters += Math.ceil((chunk.characters || 0) / 4);
            return true;
        case "status":
            // @ts-ignore - TODO: strict typing
            emit({
                type: "status",
                message: chunk.message,
                phase: chunk.phase,
                ...(chunk.progress != null && { progress: chunk.progress }),
            });
            return true;
        default: {
            // Unknown typed chunk — treat as text
            if (!state.firstTokenTime) {
                state.firstTokenTime = performance.now();
                if (state.requestStart) {
                    // @ts-ignore - TODO: strict typing
                    emit({
                        type: "status",
                        message: "generation_started",
                        timeToFirstToken: 
                        // @ts-ignore - TODO: strict typing
                        (state.firstTokenTime - state.requestStart) / 1000,
                    });
                }
            }
            state.generationEnd = performance.now();
            const rawStr = typeof chunk === "string" ? chunk : "";
            state.text += rawStr;
            // Strip tool call XML markup leaked by some local models (Gemma 4)
            // @ts-ignore - TODO: strict typing
            const cleanText = stripToolCallMarkup(state.text);
            const chunkStr = cleanText.slice(state.outputCharacters);
            state.outputCharacters = cleanText.length;
            if (chunkStr)
                // @ts-ignore - TODO: strict typing
                emit({
                    type: "chunk",
                    content: chunkStr,
                    outputCharacters: state.outputCharacters,
                });
            return true;
        }
    }
}
/**
 * Create a fresh state accumulator for stream chunk dispatching.

 */
export function createStreamState() {
    return {
        usage: null,
        firstTokenTime: null,
        generationEnd: null,
        requestStart: null, // Set by caller to enable server-computed TTFT
        outputCharacters: 0,
        text: "",
        thinking: "",
        thinkingSignature: "",
        images: [],
        toolCalls: [],
        audioChunks: [],
        audioSampleRate: 24000,
        rateLimits: null,
    };
}
//# sourceMappingURL=StreamChunkDispatcher.js.map
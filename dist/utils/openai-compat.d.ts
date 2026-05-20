/**
 * Convert generic tool schemas to OpenAI Chat Completions format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", function: { name, description, parameters } }]
 */
export declare function convertToolsToOpenAI(tools: any): {
    type: string;
    function: {
        name: any;
        description: any;
        parameters: any;
    };
}[] | null;
/**
 * Build the common sampling/generation parameters for an
 * OpenAI-compatible Chat Completions payload.
 *
 * Returns a plain object with only the non-undefined fields set.
 *


 * @returns {object} Payload fields to spread into the request body
 */
export declare function buildPayloadParams(options: any, { temperature, maxTokens }?: any): {
    seed?: number | undefined;
    temperature: any;
    top_p: any;
    frequency_penalty: any;
    presence_penalty: any;
    stop: any;
    max_tokens: any;
};
/**
 * Extract tool calls from a non-streaming OpenAI-compatible message object.
 * Handles both nested OpenAI format ({ function: { name, arguments } })
 * and flat llama.cpp format ({ name, arguments }).
 *

 * @returns {Array|null} Array of { id, name, args } or null if no tool calls
 */
export declare function extractToolCallsFromMessage(message: string): any;
/**
 * Build a normalized usage object from OpenAI-compatible usage data.
 * Extracts extended token details when available:
 *   - prompt_tokens_details.cached_tokens  → cacheReadInputTokens
 *   - completion_tokens_details.reasoning_tokens → reasoningOutputTokens
 *
 * The cache field uses the same key as Anthropic (cacheReadInputTokens) so
 * CostCalculator, RequestLogger, and console logging handle it uniformly.
 *

 * @returns {{ inputTokens: number, outputTokens: number, cacheReadInputTokens?: number, reasoningOutputTokens?: number }}
 */
export declare function normalizeUsage(rawUsage: any): {
    inputTokens: any;
    outputTokens: any;
};
/**
 * The default empty usage object, used when no usage data is available.
 */
export declare const EMPTY_USAGE: {
    inputTokens: number;
    outputTokens: number;
};
/**
 * Media handling strategies for prepareOpenAICompatMessages.
 * Controls how non-image media types are handled by different providers.
 */
export declare const MEDIA_STRATEGIES: {
    /** vLLM: supports video_url and input_audio natively */
    FULL_MULTIMODAL: string;
    /** llama-cpp: falls back to text descriptions for audio/video */
    TEXT_FALLBACK: string;
    /** lm-studio: images only, ignore other media types */
    IMAGES_ONLY: string;
};
/**
 * Pre-process messages to expand video attachments into image frames.
 *
 * For providers that don't support raw video data URLs (e.g. LM Studio),
 * this extracts frames from each video using ffmpeg and adds them to the
 * message's `images` array. The original `video` array is removed so
 * downstream processing never sees it.
 *
 * Call this BEFORE prepareOpenAICompatMessages() for providers that need
 * video-as-frames support.
 *


 * @returns {Promise<Array>} The same messages array with videos expanded
 */
export declare function expandVideoToFrames(messages: any, options?: any): Promise<any>;
/**
 * Convert messages with media to OpenAI-compatible multipart content format.
 * Handles images, tool results, assistant tool calls, and optionally
 * audio/video/PDF based on the media strategy.
 *


 * @returns {Array} OpenAI-compatible messages
 */
export declare function prepareOpenAICompatMessages(messages: any, { mediaStrategy }?: any): any;
/**
 * Process a non-streaming OpenAI-compatible chat completion response.
 * Extracts text, thinking (native + <think> tags), usage, and tool calls.
 *
 * When thinkingEnabled is false, thinking content is folded into the text
 * output and the `thinking` field is null.
 *


 * @returns {{ text: string, thinking: string|null, usage: object, toolCalls: Array|null }}
 */
export declare function processNonStreamingResponse(data: any, options?: any): {
    text: any;
    thinking: any;
    usage: {
        inputTokens: any;
        outputTokens: any;
    };
    toolCalls: any;
};
/**
 * Parse an SSE stream from an OpenAI-compatible /v1/chat/completions endpoint.
 * Yields the same event types as the provider generateTextStream methods:
 *   - string (text content)
 *   - { type: "thinking", content } (reasoning content)
 *   - { type: "toolCall", id, name, args }
 *   - { type: "usage", usage }
 *
 * When thinkingEnabled is false, all thinking content (native reasoning_content
 * and <think> tag content) is yielded as plain text strings instead of
 * { type: "thinking" } events.
 *


 */
export declare function parseSSEStream(reader: any, options?: any): AsyncGenerator<any, void, unknown>;
/**
 * Make a fetch request to an OpenAI-compatible endpoint and handle
 * error responses consistently.
 *


 * @returns {Promise<Response>} The fetch response (guaranteed to be ok)
 * @throws {Error} With a parsed error message from the API
 */
export declare function fetchOpenAICompat(url: string, payload: any, options?: any): Promise<Response>;
//# sourceMappingURL=openai-compat.d.ts.map
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { TYPES, getDefaultModels } from "../config.js";
import { convertToolsToOpenAI, buildPayloadParams, prepareOpenAICompatMessages, processNonStreamingResponse, parseSSEStream, fetchOpenAICompat, MEDIA_STRATEGIES, } from "../utils/openai-compat.js";
// ── Helpers ──────────────────────────────────────────────────
// ── Provider ─────────────────────────────────────────────────
/**
 * Factory: create a vLLM provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all vLLM methods
 */
export function createVllmProvider(baseUrl, instanceId = "vllm") {
    const getBaseUrl = () => baseUrl;
    return {
        name: instanceId,
        async generateText(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider("vLLM", `generateText model=${model} baseUrl=${baseUrl}`);
            try {
                const prepared = prepareOpenAICompatMessages(messages, {
                    mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
                });
                const payload = {
                    messages: prepared,
                    model,
                    ...buildPayloadParams(options),
                    // vLLM extensions: top_k, min_p, repetition_penalty
                    ...(options.topK > 0 && { top_k: options.topK }),
                    ...(options.minP !== undefined && { min_p: options.minP }),
                    ...(options.repeatPenalty !== undefined &&
                        options.repeatPenalty !== 1 && {
                        repetition_penalty: options.repeatPenalty,
                    }),
                    stream: false,
                };
                // Function calling tools
                const tools = convertToolsToOpenAI(options.tools);
                if (tools) {
                    payload.tools = tools;
                    payload.tool_choice = "auto";
                }
                // Thinking hard switch — vLLM extension for Qwen3/reasoning models
                // Uses chat_template_kwargs to control <think> token generation
                if (options.thinkingEnabled !== undefined) {
                    payload.chat_template_kwargs = {
                        enable_thinking: options.thinkingEnabled,
                    };
                }
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, payload);
                const data = await response.json();
                const { text, thinking, usage, toolCalls } = processNonStreamingResponse(data, {
                    thinkingEnabled: options.thinkingEnabled,
                });
                const result = { text, thinking, usage };
                if (toolCalls)
                    result.toolCalls = toolCalls;
                return result;
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("vllm", error.message, 500, error);
            }
        },
        // ── Streaming Text Generation (SSE) ──────────────────────
        async *generateTextStream(messages, model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider("vLLM", `generateTextStream model=${model} baseUrl=${baseUrl}`);
            try {
                const prepared = prepareOpenAICompatMessages(messages, {
                    mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
                });
                const payload = {
                    messages: prepared,
                    model,
                    ...buildPayloadParams(options),
                    // vLLM extensions: top_k, min_p, repetition_penalty
                    ...(options.topK > 0 && { top_k: options.topK }),
                    ...(options.minP !== undefined && { min_p: options.minP }),
                    ...(options.repeatPenalty !== undefined &&
                        options.repeatPenalty !== 1 && {
                        repetition_penalty: options.repeatPenalty,
                    }),
                    stream: true,
                    stream_options: { include_usage: true },
                };
                // Function calling tools
                const tools = convertToolsToOpenAI(options.tools);
                if (tools) {
                    payload.tools = tools;
                    payload.tool_choice = "auto";
                }
                // Thinking hard switch — vLLM extension for Qwen3/reasoning models
                if (options.thinkingEnabled !== undefined) {
                    payload.chat_template_kwargs = {
                        enable_thinking: options.thinkingEnabled,
                    };
                }
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, payload, { signal: options.signal });
                const reader = response.body.getReader();
                yield* parseSSEStream(reader, {
                    signal: options.signal,
                    thinkingEnabled: options.thinkingEnabled,
                });
            }
            catch (error) {
                if (error.name === "AbortError")
                    return; // Client disconnected
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("vllm", error.message, 500, error);
            }
        },
        async captionImage(images, prompt = "Describe this image.", model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"], systemPrompt) {
            const baseUrl = getBaseUrl();
            logger.provider("vLLM", `captionImage model=${model} baseUrl=${baseUrl}`);
            try {
                const content = [
                    { type: "text", text: prompt },
                    ...images.map((image) => ({
                        type: "image_url",
                        image_url: { url: image },
                    })),
                ];
                const messages = [];
                if (systemPrompt) {
                    messages.push({ role: "system", content: systemPrompt });
                }
                messages.push({ role: "user", content });
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, {
                    messages,
                    model,
                    temperature: 0.7,
                    max_tokens: -1,
                    stream: false,
                });
                const data = await response.json();
                const text = data.choices?.[0]?.message?.content || "";
                const usage = {
                    inputTokens: data.usage?.prompt_tokens || 0,
                    outputTokens: data.usage?.completion_tokens || 0,
                };
                return { text, usage };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("vllm", error.message, 500, error);
            }
        },
        // ── Embedding Generation ─────────────────────────────────
        /**
         * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
         * vLLM also exposes /v2/embed, but /v1/embeddings keeps the response
         * contract identical to the OpenAI provider.
         *
    
    
         * @returns {Promise<{ embedding: number[], dimensions: number }>}
         */
        async generateEmbedding(content, model, options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider("vLLM", `generateEmbedding model=${model} baseUrl=${baseUrl}`);
            try {
                const payload = {
                    model,
                    input: content,
                };
                if (options.dimensions)
                    payload.dimensions = options.dimensions;
                const response = await fetchOpenAICompat(`${baseUrl}/v1/embeddings`, payload);
                const data = await response.json();
                const embedding = data.data?.[0]?.embedding;
                if (!embedding) {
                    throw new Error("No embedding data in vLLM response");
                }
                return {
                    embedding,
                    dimensions: embedding.length,
                };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("vllm", error.message, 500, error);
            }
        },
        // ── Model Listing ────────────────────────────────────────
        /**
         * List all models available from the vLLM server.
         * Uses the OpenAI-standard GET /v1/models endpoint.
         * Returns { models: [...] } normalized format.
         */
        async listModels() {
            const baseUrl = getBaseUrl();
            logger.provider("vLLM", "listModels");
            try {
                const response = await fetch(`${baseUrl}/v1/models`, {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API error: ${response.status} ${errorText}`);
                }
                const data = await response.json();
                const models = (data.data || []).map((m) => ({
                    key: m.id,
                    display_name: m.id,
                    type: "llm",
                    loaded_instances: [{ id: m.id }], // vLLM models are always loaded
                }));
                return { models };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                throw new ProviderError("vllm", error.message, 500, error);
            }
        },
    };
}
//# sourceMappingURL=vllm.js.map
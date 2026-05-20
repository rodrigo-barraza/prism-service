// ─────────────────────────────────────────────────────────────
// llama.cpp Provider (llama-server)
// ─────────────────────────────────────────────────────────────
// Uses the OpenAI-compatible API exposed by llama-server:
//   POST /v1/chat/completions  — chat completions (stream & non-stream)
//   GET  /v1/models            — list loaded models
//   GET  /health               — server health / readiness check
//
// Docs: https://github.com/ggml-org/llama.cpp/tree/master/tools/server
//
// The /v1/chat/completions endpoint accepts standard OpenAI fields:
//   model, messages, stream, temperature, top_p, frequency_penalty,
//   presence_penalty, max_tokens, stop, tools, stream_options
//
// llama.cpp-specific extensions (passed via top-level body):
//   top_k, min_p, repeat_penalty, grammar, json_schema
//
// Streaming uses standard SSE with "data: " prefix lines.
// The final event is "data: [DONE]".
//
// /v1/models returns:
//   { object: "list", data: [{ id, object: "model", owned_by, created }] }
//
// /health returns:
//   200 { status: "ok", slots_idle: N, slots_processing: M }
//   503 { status: "loading model" }
//   500 { status: "error" }
// ─────────────────────────────────────────────────────────────
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { TYPES, getDefaultModels } from "../config.js";
import { convertToolsToOpenAI, buildPayloadParams, prepareOpenAICompatMessages, expandVideoToFrames, processNonStreamingResponse, parseSSEStream, fetchOpenAICompat, MEDIA_STRATEGIES, } from "../utils/openai-compat.js";
// ── Helpers ──────────────────────────────────────────────────
// ── Provider ─────────────────────────────────────────────────
/**
 * Factory: create a llama.cpp provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all llama.cpp methods
 */
export function createLlamaCppProvider(baseUrl, instanceId = "llama-cpp") {
    const getBaseUrl = () => baseUrl;
    return {
        name: instanceId,
        // ── Non-Streaming Text Generation ──────────────────────────
        // POST /v1/chat/completions with stream: false
        async generateText(messages, 
        // @ts-ignore
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider(
            // @ts-ignore - TODO: strict typing
            "llama.cpp", `generateText model=${model} baseUrl=${baseUrl}`);
            try {
                // Expand video attachments to image frames (ffmpeg) before message prep
                // @ts-ignore - TODO: strict typing
                await expandVideoToFrames(messages);
                // @ts-ignore - TODO: strict typing
                const prepared = prepareOpenAICompatMessages(messages, {
                    mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
                });
                const payload = {
                    messages: prepared,
                    model,
                    ...buildPayloadParams(options),
                    // llama.cpp extension: top_k
                    // @ts-ignore
                    ...(options.topK > 0 && { top_k: options.topK }),
                    // llama.cpp extension: min_p sampling
                    // @ts-ignore
                    ...(options.minP !== undefined && { min_p: options.minP }),
                    // llama.cpp extension: repeat_penalty
                    // @ts-ignore
                    ...(options.repeatPenalty !== undefined &&
                        // @ts-ignore
                        options.repeatPenalty !== 1 && {
                        // @ts-ignore
                        repeat_penalty: options.repeatPenalty,
                    }),
                    stream: false,
                };
                // Function calling tools — standard OpenAI tool schema
                // @ts-ignore
                const tools = convertToolsToOpenAI(options.tools);
                if (tools) {
                    // @ts-ignore
                    payload.tools = tools;
                    // @ts-ignore
                    payload.tool_choice = "auto";
                }
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, payload);
                const data = await response.json();
                const { text, thinking, usage, toolCalls } = 
                // @ts-ignore
                processNonStreamingResponse(data, {
                    // @ts-ignore
                    thinkingEnabled: options.thinkingEnabled,
                });
                // Extract timings for tok/s reporting (llama.cpp extension)
                // @ts-ignore
                if (data.timings?.predicted_per_second) {
                    // @ts-ignore
                    usage.tokensPerSec = parseFloat(
                    // @ts-ignore
                    data.timings.predicted_per_second.toFixed(1));
                }
                const result = { text, thinking, usage };
                // @ts-ignore
                if (toolCalls)
                    result.toolCalls = toolCalls;
                return result;
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("llama-cpp", error.message, 500, error);
            }
        },
        // ── Streaming Text Generation (SSE) ──────────────────────
        async *generateTextStream(messages, 
        // @ts-ignore
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider(
            // @ts-ignore - TODO: strict typing
            "llama.cpp", `generateTextStream model=${model} baseUrl=${baseUrl}`);
            try {
                // Expand video attachments to image frames (ffmpeg) before message prep
                // @ts-ignore - TODO: strict typing
                await expandVideoToFrames(messages);
                // @ts-ignore - TODO: strict typing
                const prepared = prepareOpenAICompatMessages(messages, {
                    mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
                });
                const payload = {
                    messages: prepared,
                    model,
                    ...buildPayloadParams(options),
                    // llama.cpp extension: top_k
                    // @ts-ignore
                    ...(options.topK > 0 && { top_k: options.topK }),
                    // llama.cpp extension: min_p sampling
                    // @ts-ignore
                    ...(options.minP !== undefined && { min_p: options.minP }),
                    // llama.cpp extension: repeat_penalty
                    // @ts-ignore
                    ...(options.repeatPenalty !== undefined &&
                        // @ts-ignore
                        options.repeatPenalty !== 1 && {
                        // @ts-ignore
                        repeat_penalty: options.repeatPenalty,
                    }),
                    stream: true,
                    // Per OpenAI spec: request usage stats in the final SSE chunk
                    stream_options: { include_usage: true },
                };
                // Function calling tools
                // @ts-ignore
                const tools = convertToolsToOpenAI(options.tools);
                if (tools) {
                    // @ts-ignore
                    payload.tools = tools;
                    // @ts-ignore
                    payload.tool_choice = "auto";
                }
                const response = await fetchOpenAICompat(`${baseUrl}/v1/chat/completions`, payload, 
                // @ts-ignore
                { signal: options.signal });
                // @ts-ignore
                const reader = response.body.getReader();
                // @ts-ignore - TODO: strict typing
                yield* parseSSEStream(reader, {
                    // @ts-ignore
                    signal: options.signal,
                    // @ts-ignore
                    thinkingEnabled: options.thinkingEnabled,
                    // llama.cpp extension: extract timings for tok/s
                    onUsage: (json, usage) => {
                        // @ts-ignore - TODO: strict typing
                        if (json.timings?.predicted_per_second) {
                            usage.tokensPerSec = parseFloat(
                            // @ts-ignore - TODO: strict typing
                            json.timings.predicted_per_second.toFixed(1));
                        }
                    },
                });
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                if (error.name === "AbortError")
                    return; // Client disconnected
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("llama-cpp", error.message, 500, error);
            }
        },
        // ── Image Captioning ──────────────────────────────────────
        // Uses POST /v1/chat/completions with image_url content parts.
        // Requires a vision-capable model (LLaVA, Qwen-VL, etc.)
        async captionImage(images, prompt = "Describe this image.", 
        // @ts-ignore
        model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["llama-cpp"], systemPrompt) {
            const baseUrl = getBaseUrl();
            logger.provider(
            // @ts-ignore - TODO: strict typing
            "llama.cpp", `captionImage model=${model} baseUrl=${baseUrl}`);
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
                // @ts-ignore
                const text = data.choices?.[0]?.message?.content || "";
                const usage = {
                    // @ts-ignore
                    inputTokens: data.usage?.prompt_tokens || 0,
                    // @ts-ignore
                    outputTokens: data.usage?.completion_tokens || 0,
                };
                return { text, usage };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("llama-cpp", error.message, 500, error);
            }
        },
        // ── Model Listing ────────────────────────────────────────
        // GET /v1/models
        async listModels() {
            const baseUrl = getBaseUrl();
            // @ts-ignore - TODO: strict typing
            logger.provider("llama.cpp", "listModels");
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
                // Normalize to our standard { models: [...] } format
                // @ts-ignore
                const models = (data.data || []).map((m) => ({
                    // @ts-ignore - TODO: strict typing
                    key: m.id,
                    // @ts-ignore - TODO: strict typing
                    display_name: m.id,
                    type: "llm",
                    // @ts-ignore - TODO: strict typing
                    loaded_instances: [{ id: m.id }], // llama.cpp models are always loaded
                }));
                return { models };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("llama-cpp", error.message, 500, error);
            }
        },
        // ── Health Check ─────────────────────────────────────────
        // GET /health
        async checkHealth() {
            const baseUrl = getBaseUrl();
            // @ts-ignore - TODO: strict typing
            logger.provider("llama.cpp", "checkHealth");
            try {
                const response = await fetch(`${baseUrl}/health`, {
                    method: "GET",
                    signal: AbortSignal.timeout(3000),
                });
                const data = await response.json();
                return {
                    ok: response.ok,
                    status: response.ok
                        ? // @ts-ignore
                            data.status || "ok"
                        : // @ts-ignore
                            data.status || data.error?.message || "error",
                    // @ts-ignore
                    slotsIdle: data.slots_idle ?? null,
                    // @ts-ignore
                    slotsProcessing: data.slots_processing ?? null,
                };
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                return { ok: false, status: "unreachable", error: error.message };
            }
        },
    };
}
//# sourceMappingURL=llama-cpp.js.map
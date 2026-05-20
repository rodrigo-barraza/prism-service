import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { TYPES, getDefaultModels } from "../config.js";
/**
 * Convert messages with images to Ollama's native format.
 * Ollama expects images as base64 strings (without the data URL prefix).
 */
function prepareOllamaMessages(messages) {
    return messages.map((m) => {
        const message = { role: m.role, content: m.content || "" };
        if (m.images && m.images.length > 0) {
            // Ollama's native API expects images as raw base64 strings
            // @ts-ignore
            message.images = m.images.map((dataUrl) => {
                if (dataUrl.startsWith("data:")) {
                    return dataUrl.split(",")[1]; // strip data:image/...;base64, prefix
                }
                return dataUrl;
            });
        }
        return message;
    });
}
/**
 * Factory: create an Ollama provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all Ollama methods
 */
export function createOllamaProvider(baseUrl, instanceId = "ollama") {
    const getBaseUrl = () => baseUrl;
    return {
        name: instanceId,
        // ── Non-Streaming Text Generation ──────────────────────
        async generateText(messages, 
        // @ts-ignore
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider(
            // @ts-ignore - TODO: strict typing
            "Ollama", `generateText model=${model} baseUrl=${baseUrl}`);
            try {
                const prepared = prepareOllamaMessages(messages);
                const body = {
                    model,
                    messages: prepared,
                    stream: false,
                    // @ts-ignore
                    ...(options.thinkingEnabled ? { think: true } : {}),
                };
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API error: ${response.status} ${errorText}`);
                }
                const data = await response.json();
                return {
                    // @ts-ignore
                    text: data.message?.content || "",
                    // @ts-ignore
                    thinking: data.message?.thinking || null,
                    usage: {
                        // @ts-ignore
                        inputTokens: data.prompt_eval_count ?? 0,
                        // @ts-ignore
                        outputTokens: data.eval_count ?? 0,
                    },
                };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("ollama", error.message, 500, error);
            }
        },
        // ── Streaming Text Generation ──────────────────────
        async *generateTextStream(messages, 
        // @ts-ignore
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"], options = {}) {
            const baseUrl = getBaseUrl();
            logger.provider(
            // @ts-ignore - TODO: strict typing
            "Ollama", `generateTextStream model=${model} baseUrl=${baseUrl}`);
            try {
                // Single-model enforcement: unload any other loaded models
                try {
                    const psRes = await fetch(`${baseUrl}/api/ps`);
                    if (psRes.ok) {
                        const psData = await psRes.json();
                        // @ts-ignore
                        const running = psData.models || [];
                        // @ts-ignore
                        for (const m of running) {
                            const runningName = m.model || m.name;
                            if (runningName && runningName !== model) {
                                yield { type: "status", message: `Unloading ${runningName}…` };
                                logger.info(`Ollama: unloading ${runningName} before loading ${model}`);
                                await fetch(`${baseUrl}/api/generate`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ model: runningName, keep_alive: 0 }),
                                });
                            }
                        }
                    }
                }
                catch (unloadErr) {
                    logger.warn(
                    // @ts-ignore - TODO: strict typing
                    `Ollama: could not check/unload models: ${unloadErr.message}`);
                }
                const prepared = prepareOllamaMessages(messages);
                const body = {
                    model,
                    messages: prepared,
                    stream: true,
                    // @ts-ignore
                    ...(options.thinkingEnabled ? { think: true } : {}),
                };
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    // @ts-ignore
                    ...(options.signal && { signal: options.signal }),
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API error: ${response.status} ${errorText}`);
                }
                // Ollama streams NDJSON (one JSON object per line)
                // @ts-ignore
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let usage = null;
                while (true) {
                    // @ts-ignore
                    if (options.signal?.aborted) {
                        reader.cancel();
                        break;
                    }
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    // @ts-ignore
                    buffer = lines.pop(); // keep incomplete line in buffer
                    // @ts-ignore
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed)
                            continue;
                        try {
                            const json = JSON.parse(trimmed);
                            // Thinking content comes in message.thinking
                            if (json.message?.thinking) {
                                yield { type: "thinking", content: json.message.thinking };
                            }
                            // Text content comes in message.content
                            if (json.message?.content) {
                                yield json.message.content;
                            }
                            // Final chunk has done: true with usage stats
                            if (json.done) {
                                const evalDurationSec = json.eval_duration
                                    ? json.eval_duration / 1_000_000_000
                                    : null;
                                usage = {
                                    inputTokens: json.prompt_eval_count ?? 0,
                                    outputTokens: json.eval_count ?? 0,
                                };
                                // Ollama reports precise eval_duration — use it for tok/s
                                if (evalDurationSec &&
                                    evalDurationSec > 0 &&
                                    usage.outputTokens > 0) {
                                    // @ts-ignore
                                    usage.tokensPerSec = parseFloat((usage.outputTokens / evalDurationSec).toFixed(1));
                                }
                            }
                        }
                        catch {
                            // skip malformed JSON lines
                        }
                    }
                }
                if (usage) {
                    yield { type: "usage", usage };
                }
                else {
                    yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
                }
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                if (error.name === "AbortError")
                    return; // Client disconnected
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("ollama", error.message, 500, error);
            }
        },
        // ── Image Captioning ──────────────────────
        async captionImage(images, prompt = "Describe this image.", 
        // @ts-ignore
        model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["ollama"], systemPrompt) {
            const baseUrl = getBaseUrl();
            logger.provider(
            // @ts-ignore - TODO: strict typing
            "Ollama", `captionImage model=${model} baseUrl=${baseUrl}`);
            try {
                // Extract raw base64 from data URLs
                const imageBase64List = images.map((image) => {
                    if (image.startsWith("data:")) {
                        return image.split(",")[1];
                    }
                    return image;
                });
                const messages = [];
                if (systemPrompt) {
                    messages.push({ role: "system", content: systemPrompt });
                }
                messages.push({
                    role: "user",
                    content: prompt,
                    images: imageBase64List,
                });
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model,
                        messages,
                        stream: false,
                    }),
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API error: ${response.status} ${errorText}`);
                }
                const data = await response.json();
                // @ts-ignore
                const text = data.message?.content || "";
                const usage = {
                    // @ts-ignore
                    inputTokens: data.prompt_eval_count || 0,
                    // @ts-ignore
                    outputTokens: data.eval_count || 0,
                };
                return { text, usage };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("ollama", error.message, 500, error);
            }
        },
        // ── Ollama Model Listing ─────────────────────
        /**
         * List all models available in Ollama.
         * GET /api/tags
         */
        async listModels() {
            const baseUrl = getBaseUrl();
            // @ts-ignore - TODO: strict typing
            logger.provider("Ollama", "listModels");
            try {
                const response = await fetch(`${baseUrl}/api/tags`, {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API error: ${response.status} ${errorText}`);
                }
                const data = await response.json();
                // Ollama returns { models: [{ name, model, size, ... }] }
                // @ts-ignore
                return { models: data.models || [] };
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
                // @ts-ignore - TODO: strict typing
                throw new ProviderError("ollama", error.message, 500, error);
            }
        },
    };
}
//# sourceMappingURL=ollama.js.map
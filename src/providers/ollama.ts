import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";

import { TYPES, getDefaultModels } from "../config.ts";

/**
 * Convert messages with images to Ollama's native format.
 * Ollama expects images as base64 strings (without the data URL prefix).
 */
function prepareOllamaMessages(messages: ChatMessage[]) {
  return messages.map((m: ChatMessage) => {
    const message = { role: m.role, content: m.content || "" };
    if (m.images && m.images.length > 0) {
      // Ollama's native API expects images as raw base64 strings
      (message as Record<string, unknown>).images = m.images.map((dataUrl: string) => {
        if (dataUrl.startsWith("data:")) {
          return dataUrl.split(",")[1]; // strip data:image/...;base64, prefix
        }
        return dataUrl;
      });
    }
    return message;
  });
}
export function createOllamaProvider(baseUrl: string, instanceId: string = "ollama") {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    // ── Non-Streaming Text Generation ──────────────────────

    async generateText(
      messages: ChatMessage[],
            model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `generateText model=${model} baseUrl=${baseUrl}`,
      );
      try {
        const prepared = prepareOllamaMessages(messages);

        const body = {
          model,
          messages: prepared,
          stream: false,
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
          text: (data as Record<string, Record<string, string>>).message?.content || "",
          thinking: (data as Record<string, Record<string, string>>).message?.thinking || null,
          usage: {
            inputTokens: (data as Record<string, number>).prompt_eval_count ?? 0,
            outputTokens: (data as Record<string, number>).eval_count ?? 0,
          },
        };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("ollama", (error as Error).message, 500, error);
      }
    },

    // ── Streaming Text Generation ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
            model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      try {
        // Single-model enforcement: unload any other loaded models
        try {
          const psRes = await fetch(`${baseUrl}/api/ps`);
          if (psRes.ok) {
            const psData = await psRes.json();
            const running = (psData as Record<string, unknown[]>).models || [];
            for ( const m of running as Record<string, string>[]) {
              const runningName = m.model || m.name;
              if (runningName && runningName !== model) {
                yield { type: "status", message: `Unloading ${runningName}…` };
                logger.info(
                  `Ollama: unloading ${runningName} before loading ${model}`,
                );
                await fetch(`${baseUrl}/api/generate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ model: runningName, keep_alive: 0 }),
                });
              }
            }
          }
        } catch (unloadErr: unknown) {
          logger.warn(
                        `Ollama: could not check/unload models: ${(unloadErr as Error).message}`,
          );
        }

        const prepared = prepareOllamaMessages(messages);

        const body = {
          model,
          messages: prepared,
          stream: true,
                    ...(options.thinkingEnabled ? { think: true } : {}),
        };

        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
                    ...(options.signal && { signal: options.signal }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} ${errorText}`);
        }

        // Ollama streams NDJSON (one JSON object per line)
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let usage = null;

        while (true) {
                    if (options.signal?.aborted) {
            reader.cancel();
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!; // keep incomplete line in buffer

                    for ( const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

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
                if (
                  evalDurationSec &&
                  evalDurationSec > 0 &&
                  usage.outputTokens > 0
                ) {
                  (usage as Record<string, unknown>).tokensPerSec = parseFloat(
                    (usage.outputTokens / evalDurationSec).toFixed(1),
                  );
                }
              }
            } catch {
              // skip malformed JSON lines
            }
          }
        }

        if (usage) {
          yield { type: "usage", usage };
        } else {
          yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        }
      } catch (error: unknown) {
                if ((error as Error).name === "AbortError") return; // Client disconnected
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("ollama", (error as Error).message, 500, error);
      }
    },

    // ── Image Captioning ──────────────────────

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
            model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["ollama"],
      systemPrompt?: string,
    ) {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `captionImage model=${model} baseUrl=${baseUrl}`,
      );
      try {
        // Extract raw base64 from data URLs
        const imageBase64List = images.map((image: string) => {
          if (image.startsWith("data:")) {
            return image.split(",")[1];
          }
          return image;
        });

        const messages: ChatMessage[] = [];
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
        const text = (data as Record<string, Record<string, string>>).message?.content || "";
        const usage = {
          inputTokens: (data as Record<string, number>).prompt_eval_count || 0,
          outputTokens: (data as Record<string, number>).eval_count || 0,
        };
        return { text, usage };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("ollama", (error as Error).message, 500, error);
      }
    },

    // ── Ollama Model Listing ─────────────────────

    /**
     * List all models available in Ollama.
     * GET /api/tags
     */
    async listModels() {
      const baseUrl = getBaseUrl();
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
        return { models: (data as Record<string, unknown[]>).models || [] };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("ollama", (error as Error).message, 500, error);
      }
    },
  };
}

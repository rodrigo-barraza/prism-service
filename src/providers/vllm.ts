import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";

import { TYPES, getDefaultModels } from "../config.ts";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  MEDIA_STRATEGIES,
} from "../utils/openai-compat.ts";

// ── Helpers ──────────────────────────────────────────────────

// ── Provider ─────────────────────────────────────────────────

/**
 * Factory: create a vLLM provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all vLLM methods
 */
export function createVllmProvider(baseUrl: string, instanceId: string = "vllm") {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    async generateText(
      messages: ChatMessage[],
      // @ts-ignore
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      // @ts-ignore - TODO: strict typing
      logger.provider("vLLM", `generateText model=${model} baseUrl=${baseUrl}`);
      try {
        // @ts-ignore - TODO: strict typing
        const prepared = prepareOpenAICompatMessages(messages, {
          mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
        });

        const payload = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // vLLM extensions: top_k, min_p, repetition_penalty
          // @ts-ignore
          ...(options.topK > 0 && { top_k: options.topK }),
          // @ts-ignore
          ...(options.minP !== undefined && { min_p: options.minP }),
          // @ts-ignore
          ...(options.repeatPenalty !== undefined &&
            // @ts-ignore
            options.repeatPenalty !== 1 && {
              // @ts-ignore
              repetition_penalty: options.repeatPenalty,
            }),
          stream: false,
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

        // Thinking hard switch — vLLM extension for Qwen3/reasoning models
        // Uses chat_template_kwargs to control <think> token generation
        // @ts-ignore
        if (options.thinkingEnabled !== undefined) {
          // @ts-ignore
          payload.chat_template_kwargs = {
            // @ts-ignore
            enable_thinking: options.thinkingEnabled,
          };
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
        );
        const data = await response.json();
        const { text, thinking, usage, toolCalls } =
          // @ts-ignore
          processNonStreamingResponse(data, {
            // @ts-ignore
            thinkingEnabled: options.thinkingEnabled,
          });

        const result = { text, thinking, usage };
        // @ts-ignore
        if (toolCalls) result.toolCalls = toolCalls;
        return result;
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        // @ts-ignore - TODO: strict typing
        throw new ProviderError("vllm", error.message, 500, error);
      }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      // @ts-ignore
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider(
        // @ts-ignore - TODO: strict typing
        "vLLM",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      try {
        // @ts-ignore - TODO: strict typing
        const prepared = prepareOpenAICompatMessages(messages, {
          mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
        });

        const payload = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // vLLM extensions: top_k, min_p, repetition_penalty
          // @ts-ignore
          ...(options.topK > 0 && { top_k: options.topK }),
          // @ts-ignore
          ...(options.minP !== undefined && { min_p: options.minP }),
          // @ts-ignore
          ...(options.repeatPenalty !== undefined &&
            // @ts-ignore
            options.repeatPenalty !== 1 && {
              // @ts-ignore
              repetition_penalty: options.repeatPenalty,
            }),
          stream: true,
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

        // Thinking hard switch — vLLM extension for Qwen3/reasoning models
        // @ts-ignore
        if (options.thinkingEnabled !== undefined) {
          // @ts-ignore
          payload.chat_template_kwargs = {
            // @ts-ignore
            enable_thinking: options.thinkingEnabled,
          };
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
          // @ts-ignore
          { signal: options.signal },
        );

        // @ts-ignore
        const reader = response.body.getReader();
        // @ts-ignore - TODO: strict typing
        yield* parseSSEStream(reader, {
          // @ts-ignore
          signal: options.signal,
          // @ts-ignore
          thinkingEnabled: options.thinkingEnabled,
        });
      } catch (error: unknown) {
        // @ts-ignore - TODO: strict typing
        if (error.name === "AbortError") return; // Client disconnected
        if (error instanceof ProviderError) throw error;
        // @ts-ignore - TODO: strict typing
        throw new ProviderError("vllm", error.message, 500, error);
      }
    },

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      // @ts-ignore
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"],
      systemPrompt?: string,
    ) {
      const baseUrl = getBaseUrl();
      // @ts-ignore - TODO: strict typing
      logger.provider("vLLM", `captionImage model=${model} baseUrl=${baseUrl}`);
      try {
        const content = [
          { type: "text", text: prompt },
          ...images.map((image: string) => ({
            type: "image_url",
            image_url: { url: image },
          })),
        ];
        const messages: ChatMessage[] = [];
        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content });

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          {
            messages,
            model,
            temperature: 0.7,
            max_tokens: -1,
            stream: false,
          },
        );

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
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        // @ts-ignore - TODO: strict typing
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
    async generateEmbedding(content: Record<string, unknown>, model: Record<string, unknown>, options: ProviderOptions = {}) {
      const baseUrl = getBaseUrl();
      logger.provider(
        // @ts-ignore - TODO: strict typing
        "vLLM",
        `generateEmbedding model=${model} baseUrl=${baseUrl}`,
      );
      try {
        const payload = {
          model,
          input: content,
        };
        // @ts-ignore
        if (options.dimensions) payload.dimensions = options.dimensions;

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/embeddings`,
          payload,
        );
        const data = await response.json();

        // @ts-ignore
        const embedding = data.data?.[0]?.embedding;
        if (!embedding) {
          throw new Error("No embedding data in vLLM response");
        }

        return {
          embedding,
          dimensions: embedding.length,
        };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        // @ts-ignore - TODO: strict typing
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
      // @ts-ignore - TODO: strict typing
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
        // @ts-ignore
        const models = (data.data || []).map((m: ChatMessage) => ({
          // @ts-ignore - TODO: strict typing
          key: m.id,
          // @ts-ignore - TODO: strict typing
          display_name: m.id,
          type: "llm",
          // @ts-ignore - TODO: strict typing
          loaded_instances: [{ id: m.id }], // vLLM models are always loaded
        }));
        return { models };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        // @ts-ignore - TODO: strict typing
        throw new ProviderError("vllm", error.message, 500, error);
      }
    },
  };
}

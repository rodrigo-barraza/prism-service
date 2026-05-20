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
            model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
            (logger.provider as any)(("vLLM" as any), (`generateText model=${model} baseUrl=${baseUrl}` as any));
      try {
                const prepared = prepareOpenAICompatMessages((messages as any), {
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
                const tools = convertToolsToOpenAI((options.tools as any));
        if (tools) {
                    (payload as any).tools = tools;
                    (payload as any).tool_choice = "auto";
        }

        // Thinking hard switch — vLLM extension for Qwen3/reasoning models
        // Uses chat_template_kwargs to control <think> token generation
                if (options.thinkingEnabled !== undefined) {
                    (payload as any).chat_template_kwargs = {
                        enable_thinking: options.thinkingEnabled,
          };
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
        );
        const data = await response.json();
        const { text, thinking, usage, toolCalls } =
                    processNonStreamingResponse((data as any), {
                        thinkingEnabled: options.thinkingEnabled,
          });

        const result = { text, thinking, usage };
                if (toolCalls) (result as any).toolCalls = toolCalls;
        return result;
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("vllm", (error as Error).message, 500, error);
      }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
            model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      (logger.provider as any)(
                ("vLLM" as any),
        (`generateTextStream model=${model} baseUrl=${baseUrl}` as any),
      );
      try {
                const prepared = prepareOpenAICompatMessages((messages as any), {
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
                const tools = convertToolsToOpenAI((options.tools as any));
        if (tools) {
                    (payload as any).tools = tools;
                    (payload as any).tool_choice = "auto";
        }

        // Thinking hard switch — vLLM extension for Qwen3/reasoning models
                if (options.thinkingEnabled !== undefined) {
                    (payload as any).chat_template_kwargs = {
                        enable_thinking: options.thinkingEnabled,
          };
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
                    { signal: options.signal },
        );

                const reader = response.body.getReader();
                yield* parseSSEStream((reader as any), {
                    signal: options.signal,
                    thinkingEnabled: options.thinkingEnabled,
        });
      } catch (error: any) {
                if ((error as Error).name === "AbortError") return; // Client disconnected
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("vllm", (error as Error).message, 500, error);
      }
    },

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
            model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"],
      systemPrompt?: string,
    ) {
      const baseUrl = getBaseUrl();
            (logger.provider as any)(("vLLM" as any), (`captionImage model=${model} baseUrl=${baseUrl}` as any));
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
                const text = (data as any).choices?.[0]?.message?.content || "";
        const usage = {
                    inputTokens: (data as any).usage?.prompt_tokens || 0,
                    outputTokens: (data as any).usage?.completion_tokens || 0,
        };
        return { text, usage };
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("vllm", (error as Error).message, 500, error);
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
    async generateEmbedding(content: any, model: any, options: ProviderOptions = {}) {
      const baseUrl = getBaseUrl();
      (logger.provider as any)(
                ("vLLM" as any),
        (`generateEmbedding model=${model} baseUrl=${baseUrl}` as any),
      );
      try {
        const payload = {
          model,
          input: content,
        };
                if (options.dimensions) (payload as any).dimensions = options.dimensions;

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/embeddings`,
          payload,
        );
        const data = await response.json();

                const embedding = (data as any).data?.[0]?.embedding;
        if (!embedding) {
          throw new Error("No embedding data in vLLM response");
        }

        return {
          embedding,
          dimensions: embedding.length,
        };
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("vllm", (error as Error).message, 500, error);
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
            (logger.provider as any)(("vLLM" as any), ("listModels" as any));
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
                const models = ((data as any).data || []).map((m: ChatMessage) => ({
                    key: (m as any).id,
                    display_name: (m as any).id,
          type: "llm",
                    loaded_instances: [{ id: (m as any).id }], // vLLM models are always loaded
        }));
        return { models };
      } catch (error: any) {
        if (error instanceof ProviderError) throw error;
                throw new ProviderError("vllm", (error as Error).message, 500, error);
      }
    },
  };
}

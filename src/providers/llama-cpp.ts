import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
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

import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";

import { TYPES, getDefaultModels } from "../config.ts";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  expandVideoToFrames,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  MEDIA_STRATEGIES,
  type OpenAICompletionResponse,
} from "../utils/openai-compat.ts";
import type { TokenUsage } from "../types/admin.ts";

// ── Types ────────────────────────────────────────────────────

interface LlamaCppTimings {
  predicted_per_second?: number;
}

interface LlamaCppCompletionResponse extends OpenAICompletionResponse {
  timings?: LlamaCppTimings;
}

interface LlamaCppModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

interface LlamaCppModelsResponse {
  object: string;
  data: LlamaCppModel[];
}

interface HealthResponse {
  status: string;
  slots_idle?: number;
  slots_processing?: number;
  error?: { message: string };
}

// ── Provider ─────────────────────────────────────────────────
export function createLlamaCppProvider(baseUrl: string, instanceId: string = "llama-cpp") {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    // ── Non-Streaming Text Generation ──────────────────────────
    // POST /v1/chat/completions with stream: false

    async generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", `generateText model=${model} baseUrl=${baseUrl}`);
      try {
        // Expand video attachments to image frames (ffmpeg) before message prep
        await expandVideoToFrames(messages);

        const prepared = prepareOpenAICompatMessages(messages, {
          mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
        });

        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // llama.cpp extension: top_k
          ...(options.topK !== undefined && options.topK > 0 && { top_k: options.topK }),
          // llama.cpp extension: min_p sampling
          ...(options.minP !== undefined && { min_p: options.minP }),
          // llama.cpp extension: repeat_penalty
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repeat_penalty: options.repeatPenalty,
            }),
          stream: false,
        };

        // Function calling tools — standard OpenAI tool schema
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) {
          payload.tools = tools;
          payload.tool_choice = "auto";
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
        );
        const data = await response.json() as LlamaCppCompletionResponse;
        const { text, thinking, usage, toolCalls } =
          processNonStreamingResponse(data, {
            thinkingEnabled: options.thinkingEnabled,
          });

        // Extract timings for tok/s reporting (llama.cpp extension)
        if (data.timings?.predicted_per_second) {
          usage.tokensPerSec = parseFloat(
            data.timings.predicted_per_second.toFixed(1),
          );
        }

        const result: { text: string; thinking: string | null; usage: TokenUsage; toolCalls?: typeof toolCalls } =
          { text, thinking, usage };
        if (toolCalls) result.toolCalls = toolCalls;
        return result;
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("llama-cpp", (error as Error).message, 500, error);
      }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["llama-cpp"],
      options: ProviderOptions = {},
    ) {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", `generateTextStream model=${model} baseUrl=${baseUrl}`);
      try {
        // Expand video attachments to image frames (ffmpeg) before message prep
        await expandVideoToFrames(messages);

        const prepared = prepareOpenAICompatMessages(messages, {
          mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
        });

        const payload: Record<string, unknown> = {
          messages: prepared,
          model,
          ...buildPayloadParams(options),
          // llama.cpp extension: top_k
          ...(options.topK !== undefined && options.topK > 0 && { top_k: options.topK }),
          // llama.cpp extension: min_p sampling
          ...(options.minP !== undefined && { min_p: options.minP }),
          // llama.cpp extension: repeat_penalty
          ...(options.repeatPenalty !== undefined &&
            options.repeatPenalty !== 1 && {
              repeat_penalty: options.repeatPenalty,
            }),
          stream: true,
          // Per OpenAI spec: request usage stats in the final SSE chunk
          stream_options: { include_usage: true },
        };

        // Function calling tools
        const tools = convertToolsToOpenAI(options.tools);
        if (tools) {
          payload.tools = tools;
          payload.tool_choice = "auto";
        }

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          payload,
          { signal: options.signal },
        );

        const reader = response.body!.getReader();
        yield* parseSSEStream(reader, {
          signal: options.signal,
          thinkingEnabled: options.thinkingEnabled,
          // llama.cpp extension: extract timings for tok/s
          onUsage: (json: OpenAICompletionResponse, usage: TokenUsage) => {
            const timings = (json as LlamaCppCompletionResponse).timings;
            if (timings?.predicted_per_second) {
              usage.tokensPerSec = parseFloat(
                timings.predicted_per_second.toFixed(1),
              );
            }
          },
        });
      } catch (error: unknown) {
        if ((error as Error).name === "AbortError") return; // Client disconnected
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("llama-cpp", (error as Error).message, 500, error);
      }
    },

    // ── Image Captioning ──────────────────────────────────────
    // Uses POST /v1/chat/completions with image_url content parts.
    // Requires a vision-capable model (LLaVA, Qwen-VL, etc.)

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["llama-cpp"],
      systemPrompt?: string,
    ) {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", `captionImage model=${model} baseUrl=${baseUrl}`);
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

        const data = await response.json() as OpenAICompletionResponse;
        const text = data.choices?.[0]?.message?.content || "";
        const usage: TokenUsage = {
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
        };
        return { text, usage };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("llama-cpp", (error as Error).message, 500, error);
      }
    },

    // ── Model Listing ────────────────────────────────────────
    // GET /v1/models

    async listModels() {
      const baseUrl = getBaseUrl();
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
        const data = await response.json() as LlamaCppModelsResponse;
        // Normalize to our standard { models: [...] } format
        const models = (data.data || []).map((m: LlamaCppModel) => ({
          key: m.id,
          display_name: m.id,
          type: "llm",
          loaded_instances: [{ id: m.id }], // llama.cpp models are always loaded
        }));
        return { models };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("llama-cpp", (error as Error).message, 500, error);
      }
    },

    // ── Health Check ─────────────────────────────────────────
    // GET /health

    async checkHealth() {
      const baseUrl = getBaseUrl();
      logger.provider("llama.cpp", "checkHealth");
      try {
        const response = await fetch(`${baseUrl}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        });
        const data = await response.json() as HealthResponse;
        return {
          ok: response.ok,
          status: response.ok
            ? data.status || "ok"
            : data.status || data.error?.message || "error",
          slotsIdle: data.slots_idle ?? null,
          slotsProcessing: data.slots_processing ?? null,
        };
      } catch (error: unknown) {
        return { ok: false, status: "unreachable", error: (error as Error).message };
      }
    },
  };
}

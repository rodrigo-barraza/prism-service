// ─────────────────────────────────────────────────────────────
// Moonshot AI (Kimi) Provider
// ─────────────────────────────────────────────────────────────
// Kimi's API is OpenAI Chat Completions–compatible, so this provider reuses
// the shared openai-compat helpers (message prep, tool conversion, usage
// normalization incl. cached/reasoning tokens, SSE parsing incl. tool-call
// accumulation + stop reasons) exactly like the vLLM provider. The only
// cloud-specific additions are the `Authorization: Bearer` header and
// rate-limit header capture.
//
// Base URL:  https://api.moonshot.ai/v1  (override via MOONSHOT_BASE_URL —
//            e.g. https://api.moonshot.cn/v1 for the China region).
// Docs:      https://platform.moonshot.ai/docs

import {
  type ProviderOptions,
  type ChatMessage,
  type GenerateTextResult,
  type StreamChunk,
} from "#src/types/provider";
import { ProviderError } from "#src/utils/errors";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PROVIDERS } from "#src/constants";
import { MODALITY_TYPES, getDefaultModels, getModelByName } from "#src/config";
import { MOONSHOT_API_KEY, MOONSHOT_BASE_URL } from "#config";
import { extractOpenAIRateLimits } from "#src/utils/rateLimits";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  prependIdentitySystemMessage,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  MEDIA_STRATEGIES,
  type OpenAICompletionResponse,
} from "#src/providers/openai-compat";
import type { InputMessage } from "#src/providers/openai-compat";

const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";

// Kimi K-series recommends a lower default sampling temperature than the
// generic OpenAI-compat default (0.7).
const DEFAULT_TEMPERATURE = 0.6;

// Kimi accepts text + image input only. IMAGES_ONLY passes images through as
// image_url parts and degrades audio/video/pdf to text placeholders rather
// than emitting multipart parts the API would reject.
const MEDIA_STRATEGY = MEDIA_STRATEGIES.IMAGES_ONLY;

function getBaseUrl(): string {
  return MOONSHOT_BASE_URL || DEFAULT_BASE_URL;
}

function authHeaders(): Record<string, string> {
  if (!MOONSHOT_API_KEY) {
    throw new ProviderError("moonshot", "MOONSHOT_API_KEY is not set", 401);
  }
  return { Authorization: `Bearer ${MOONSHOT_API_KEY}` };
}

function defaultModel(): string {
  return getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
    PROVIDERS.MOONSHOT
  ];
}

/**
 * Build the OpenAI-compatible Chat Completions payload for a Kimi request.
 * Exported for unit testing — it is pure (no network, no env reads).
 */
export function buildMoonshotPayload(
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
  stream: boolean,
): Record<string, unknown> {
  const effectiveMessages = prependIdentitySystemMessage(
    messages,
    options.systemPrompt,
  );
  const prepared = prepareOpenAICompatMessages(
    effectiveMessages as InputMessage[],
    { mediaStrategy: MEDIA_STRATEGY },
  );

  const payload: Record<string, unknown> = {
    messages: prepared,
    model,
    ...buildPayloadParams(options, { temperature: DEFAULT_TEMPERATURE }),
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
  };

  // Function calling
  const tools = convertToolsToOpenAI(options.tools);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  // Reasoning control — Kimi K3 accepts reasoning_effort ("low" | "high" | "max").
  // Forward it only when the target model actually declares that level (via its
  // thinkingLevels), so a stale global setting like "medium" (valid on OpenAI /
  // Gemini) can't reach Kimi and 400. Models without thinkingLevels (K2.6,
  // K2.7-Code) never send it.
  if (options.reasoningEffort && options.reasoningEffort !== "none") {
    const modelDefinition = getModelByName(model);
    const supportedLevels =
      modelDefinition && "thinkingLevels" in modelDefinition
        ? ((modelDefinition as { thinkingLevels?: string[] }).thinkingLevels ??
          [])
        : [];
    if (supportedLevels.includes(options.reasoningEffort)) {
      payload.reasoning_effort = options.reasoningEffort;
    }
  }

  // Structured / JSON output — OpenAI-compatible response_format.
  const responseFormat = options.responseFormat;
  if (responseFormat) {
    payload.response_format =
      typeof responseFormat === "string"
        ? { type: responseFormat }
        : responseFormat;
  }

  return payload;
}

// Typed via inference (not annotated `: Provider`) so the streaming generator
// can yield the StreamRateLimitsChunk event, mirroring the openai provider.
// The structural cast to Provider happens at registration in ./index.ts.
const moonshotProvider = {
  name: PROVIDERS.MOONSHOT,

  async generateText(
    messages: ChatMessage[],
    model: string = defaultModel(),
    options: ProviderOptions = {},
  ): Promise<GenerateTextResult> {
    logger.provider("Moonshot", `generateText model=${model}`);
    try {
      const payload = buildMoonshotPayload(messages, model, options, false);
      const response = await fetchOpenAICompat(
        `${getBaseUrl()}/chat/completions`,
        payload,
        { headers: authHeaders() },
      );
      const rateLimits = extractOpenAIRateLimits(
        response,
        model,
        PROVIDERS.MOONSHOT,
      );
      const data = (await response.json()) as OpenAICompletionResponse;
      const { text, thinking, usage, toolCalls } = processNonStreamingResponse(
        data,
        { thinkingEnabled: options.thinkingEnabled },
      );

      const result: GenerateTextResult = {
        text,
        usage: {
          ...usage, // preserve cacheReadInputTokens / reasoningOutputTokens
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
        },
      };
      if (thinking) result.thinking = thinking;
      if (toolCalls) {
        result.toolCalls = toolCalls.map((toolCall) => ({
          id: toolCall.id || "",
          name: toolCall.name,
          args:
            typeof toolCall.args === "object" && toolCall.args !== null
              ? (toolCall.args as Record<string, unknown>)
              : {},
        }));
      }
      if (rateLimits) result.rateLimits = rateLimits;
      return result;
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "moonshot",
        getErrorMessage(error),
        500,
        error as Error,
      );
    }
  },

  async *generateTextStream(
    messages: ChatMessage[],
    model: string = defaultModel(),
    options: ProviderOptions = {},
  ) {
    logger.provider("Moonshot", `generateTextStream model=${model}`);
    try {
      const payload = buildMoonshotPayload(messages, model, options, true);
      const response = await fetchOpenAICompat(
        `${getBaseUrl()}/chat/completions`,
        payload,
        { headers: authHeaders(), signal: options.signal },
      );
      // Rate-limit headers are available on the response before the body is
      // consumed; emit them after the usage event below.
      const rateLimits = extractOpenAIRateLimits(
        response,
        model,
        PROVIDERS.MOONSHOT,
      );

      const reader = response.body!.getReader();
      for await (const chunk of parseSSEStream(reader, {
        signal: options.signal,
        thinkingEnabled: options.thinkingEnabled,
      })) {
        if (typeof chunk === "object" && chunk.type === "usage") {
          yield {
            type: "usage",
            usage: {
              ...chunk.usage, // preserve cacheReadInputTokens etc.
              inputTokens: chunk.usage.inputTokens || 0,
              outputTokens: chunk.usage.outputTokens || 0,
            },
          };
        } else if (typeof chunk === "object" && chunk.type === "toolCall") {
          yield { ...chunk, id: chunk.id || "" };
        } else {
          yield chunk as StreamChunk;
        }
      }

      if (rateLimits) yield { type: "rateLimits", rateLimits };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return; // client disconnected
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "moonshot",
        getErrorMessage(error),
        500,
        error as Error,
      );
    }
  },
};

export default moonshotProvider;

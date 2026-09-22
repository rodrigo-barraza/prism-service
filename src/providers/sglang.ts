// ─────────────────────────────────────────────────────────────
// SGLang Provider (self-hosted)
// ─────────────────────────────────────────────────────────────
// SGLang's server (`python -m sglang.launch_server`, default port 30000)
// speaks the OpenAI Chat Completions API, so this provider reuses the shared
// openai-compat helpers — message prep, tool conversion, usage normalization,
// SSE parsing (reasoning_content, tool-call accumulation, stop reasons,
// in-stream errors) — like the vLLM provider. What is SGLang's own:
//   - The served model's chat template renders the prompt, and several
//     templates reject a system message anywhere but first, so non-leading
//     system messages are demoted to the user role.
//   - Media reaches SGLang as URLs it fetches itself — including file:// and
//     bare paths on the GPU box — so only data: and http(s): URLs are sent.
//     Audio goes as audio_url (input_audio takes only wav and mp3).
//   - Model discovery reads /v1/models (id, max_model_len, LoRA adapters) and
//     /model_info, which says what the server can actually do: tool-call and
//     reasoning parsers, image/audio understanding, embedding vs generation.
//   - /health runs a one-token generation; /ready (v0.5.20+) is the cheap probe.
//
// Launch flags that decide what Prism sees:
//   --tool-call-parser <name>  tool calls; without one they arrive as plain text
//   --reasoning-parser <name>  reasoning_content; without one <think> tags stay
//                              inline (ThinkTagParser still splits them)
//   --enable-cache-report      prompt_tokens_details.cached_tokens in usage
//   --is-embedding             serve a decoder embedding model on /v1/embeddings
//   --host 0.0.0.0             SGLang binds 127.0.0.1 by default
//   --api-key <key>            then set PROVIDER_SGLANG_<N>_API_KEY to match
// Configure instances with PROVIDER_SGLANG_<N>_URL (+ _CONCURRENCY, _NICKNAME,
// _API_KEY). Docs: https://docs.sglang.io/docs/basic_usage/openai_api_completions

import {
  type ProviderOptions,
  type ChatMessage,
  type Provider,
  type GenerateTextResult,
  type StreamChunk,
} from "#src/types/provider";
import { type ProviderInstanceConfig } from "#src/types/ProviderTypes";
import { ProviderError } from "#src/utils/errors";
import logger from "#src/utils/logger";
import { PROVIDERS, TOOL_API_HEALTH_TIMEOUT_MILLISECONDS } from "#src/constants";
import { discoverContextLength } from "#src/utils/ContextLengthDiscovery";
import { MODALITY_TYPES, getDefaultModels } from "#src/config";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  type SglangRawModel,
  type SglangReportedCapabilities,
} from "#src/services/local-provider/types";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  prependIdentitySystemMessage,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  MEDIA_STRATEGIES,
  type ContentPart,
  type InputMessage,
  type OpenAICompletionResponse,
  type PreparedMessage,
} from "#src/providers/openai-compat";

// Model-info endpoints are best-effort metadata; never hold up a model list.
const MODEL_INFO_TIMEOUT_MILLISECONDS = 3000;

// ── Types ────────────────────────────────────────────────────

interface SglangModelCard {
  id: string;
  object?: string;
  owned_by?: string;
  root?: string;
  /** Set on a LoRA adapter's card: the served base model it applies to. */
  parent?: string | null;
  /** The context length the server enforces; null on a LoRA adapter's card. */
  max_model_len?: number | null;
}

export interface SglangModelsResponse {
  object?: string;
  data?: SglangModelCard[];
}

/**
 * GET /model_info (/get_model_info before v0.5.6). Only the fields Prism
 * reads; the parser fields are missing on older servers.
 */
export interface SglangModelInfo {
  model_path?: string;
  served_model_name?: string;
  is_generation?: boolean;
  tool_call_parser?: string | null;
  reasoning_parser?: string | null;
  has_image_understanding?: boolean;
  has_audio_understanding?: boolean;
}

/**
 * GET /server_info (/get_server_info before v0.5.6) — every launch argument,
 * which includes the API keys. Read only for the parser fields an older
 * /model_info lacks, and never passed on.
 */
export interface SglangServerInfo {
  tool_call_parser?: string | null;
  reasoning_parser?: string | null;
  is_embedding?: boolean;
}

interface SglangEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

/** Content parts SGLang accepts beyond the shared ContentPart union. */
type SglangContentPart =
  | ContentPart
  | { type: "audio_url"; audio_url: { url: string } };

// ── Message preparation ──────────────────────────────────────

/**
 * Keep a system message only at index 0; demote every other one to the user
 * role. SGLang renders the served model's chat template, and templates such as
 * Qwen3.5/3.6's raise "System message must be at the beginning." on any other
 * placement. Every mid-conversation system message the harness injects is
 * wrapped in a SYSTEM_MESSAGE_TAGS tag, so the demoted message still reads as
 * a harness instruction — the same trade the Gemini and Anthropic providers
 * make. Done for every model rather than for a list of templates that object.
 */
export function demoteNonLeadingSystemMessages(
  messages: InputMessage[],
): InputMessage[] {
  return messages.map((message, index) =>
    message.role === "system" && index > 0
      ? { ...message, role: "user" }
      : message,
  );
}

/** SGLang fetches media URLs itself; only these schemes are safe to hand it. */
export function isForwardableMediaUrl(url: string): boolean {
  return /^(data:|https?:\/\/)/i.test(url);
}

const OMITTED_MEDIA_TEXT =
  "[Attachment omitted — only data: and http(s): URLs are sent to this model]";

/**
 * Adapt prepared content parts to what SGLang accepts:
 *   - a media URL SGLang would read from its own disk (file://, a bare path)
 *     becomes a text note — the gateway is not a file-read proxy;
 *   - input_audio becomes audio_url with a data: URL, since SGLang's
 *     input_audio takes only wav and mp3 while its audio loader takes the rest.
 */
export function adaptContentPartsForSglang(
  messages: PreparedMessage[],
): PreparedMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((part): SglangContentPart => {
      if (part.type === "input_audio") {
        const url = `data:audio/${part.input_audio.format};base64,${part.input_audio.data}`;
        return { type: "audio_url", audio_url: { url } };
      }
      const url =
        part.type === "image_url"
          ? part.image_url.url
          : part.type === "video_url"
            ? part.video_url.url
            : null;
      if (url !== null && !isForwardableMediaUrl(url)) {
        return { type: "text", text: OMITTED_MEDIA_TEXT };
      }
      return part;
    });
    return { ...message, content: content as ContentPart[] };
  });
}

/**
 * Build the Chat Completions payload for an SGLang request.
 * Exported for unit testing — it is pure (no network, no env reads).
 */
export function buildSglangPayload(
  messages: ChatMessage[],
  model: string,
  options: ProviderOptions,
  stream: boolean,
): Record<string, unknown> {
  const effectiveMessages = prependIdentitySystemMessage(
    messages,
    options.systemPrompt,
  );
  const prepared = adaptContentPartsForSglang(
    prepareOpenAICompatMessages(
      demoteNonLeadingSystemMessages(effectiveMessages as InputMessage[]),
      { mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL },
    ),
  );

  const payload: Record<string, unknown> = {
    messages: prepared,
    model,
    ...buildPayloadParams(options),
    // SGLang sampling extensions (same names as vLLM's)
    ...(options.topK !== undefined &&
      options.topK > 0 && { top_k: options.topK }),
    ...(options.minP !== undefined && { min_p: options.minP }),
    ...(options.repeatPenalty !== undefined &&
      options.repeatPenalty !== 1 && {
        repetition_penalty: options.repeatPenalty,
      }),
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
  };

  // Function calling — parsed only when the server runs a --tool-call-parser
  const tools = convertToolsToOpenAI(options.tools);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  // Thinking hard switch for templates that read it (Qwen3 and kin)
  if (options.thinkingEnabled !== undefined) {
    payload.chat_template_kwargs = {
      enable_thinking: options.thinkingEnabled,
    };
  }

  // SGLang takes every level the UI offers (none … max) and hands it to the
  // chat template (gpt-oss reads it). Not sent when thinking is switched off.
  if (options.reasoningEffort && options.thinkingEnabled !== false) {
    payload.reasoning_effort = options.reasoningEffort;
  }

  return payload;
}

// ── Model discovery ──────────────────────────────────────────

/**
 * Merge /v1/models with what /model_info (or, on a server too old to report
 * its parsers there, /server_info) says into the raw entries the gateway's
 * normalizer reads. A LoRA adapter is addressed as "<base>:<adapter>" —
 * SGLang silently serves the base model for the bare adapter id — and takes
 * the base model's context length. Exported for unit testing — pure.
 */
export function mergeSglangModelMetadata(
  models: SglangModelsResponse | null,
  modelInfo: SglangModelInfo | null,
  serverInfo: SglangServerInfo | null = null,
): SglangRawModel[] {
  const isEmbedding =
    modelInfo?.is_generation === false || serverInfo?.is_embedding === true;

  const parserSource =
    modelInfo && "tool_call_parser" in modelInfo ? modelInfo : serverInfo;
  const sglangCapabilities: SglangReportedCapabilities = {};
  if (parserSource) {
    sglangCapabilities.toolCallParser = parserSource.tool_call_parser ?? null;
    sglangCapabilities.reasoningParser = parserSource.reasoning_parser ?? null;
  }
  if (typeof modelInfo?.has_image_understanding === "boolean") {
    sglangCapabilities.imageUnderstanding = modelInfo.has_image_understanding;
  }
  if (typeof modelInfo?.has_audio_understanding === "boolean") {
    sglangCapabilities.audioUnderstanding = modelInfo.has_audio_understanding;
  }
  const hasReport = Object.keys(sglangCapabilities).length > 0;

  const cards = models?.data || [];
  const contextLengthById = new Map(
    cards.map((card) => [card.id, card.max_model_len]),
  );

  return cards.map((card) => {
    const contextLength = card.parent
      ? contextLengthById.get(card.parent)
      : card.max_model_len;
    return {
      key: card.parent ? `${card.parent}:${card.id}` : card.id,
      display_name: card.parent ? `${card.id} (LoRA)` : card.id,
      type: isEmbedding ? "embedding" : "llm",
      ...(typeof contextLength === "number" &&
        contextLength > 0 && { max_model_len: contextLength }),
      ...(hasReport && { sglangCapabilities }),
    };
  });
}

// ── Provider ─────────────────────────────────────────────────
export function createSglangProvider(
  baseUrl: string,
  instanceId: string = PROVIDERS.SGLANG,
  { apiKey }: Pick<ProviderInstanceConfig, "apiKey"> = {},
): Provider {
  // --api-key guards every route but /health, /ready and /metrics
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  const defaultTextModel = () =>
    getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
      PROVIDERS.SGLANG
    ];

  const discover = (model: string, options: ProviderOptions) =>
    discoverContextLength(instanceId, baseUrl, model, options, headers);

  async function getJson<T>(
    path: string,
  ): Promise<{ status: number; data: T | null } | null> {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(MODEL_INFO_TIMEOUT_MILLISECONDS),
      });
      return {
        status: response.status,
        data: response.ok ? ((await response.json()) as T) : null,
      };
    } catch {
      return null;
    }
  }

  /** The current info route, or its get_-prefixed form on a pre-v0.5.6 server. */
  async function getInfo<T>(path: string, legacyPath: string): Promise<T | null> {
    const current = await getJson<T>(path);
    if (current?.status === 404) return (await getJson<T>(legacyPath))?.data ?? null;
    return current?.data ?? null;
  }

  function toProviderError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    // fetchOpenAICompat and in-stream errors carry the HTTP status: a 400
    // (bad parameter, context overflow) must not be retried like an outage.
    const status = (error as { status?: unknown } | null)?.status;
    return new ProviderError(
      instanceId,
      getErrorMessage(error),
      typeof status === "number" ? status : 500,
      error as Error,
    );
  }

  return {
    name: instanceId,

    async generateText(
      messages: ChatMessage[],
      model: string = defaultTextModel(),
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      logger.provider("SGLang", `generateText model=${model} baseUrl=${baseUrl}`);
      await discover(model, options);
      try {
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          buildSglangPayload(messages, model, options, false),
          { headers, signal: options.signal },
        );
        const data = (await response.json()) as OpenAICompletionResponse;
        const { text, thinking, usage, toolCalls } =
          processNonStreamingResponse(data, {
            thinkingEnabled: options.thinkingEnabled,
          });

        const result: GenerateTextResult = {
          text,
          usage: {
            ...usage, // preserve cacheReadInputTokens etc. from normalizeUsage
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
        return result;
      } catch (error: unknown) {
        throw toProviderError(error);
      }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      model: string = defaultTextModel(),
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      logger.provider(
        "SGLang",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      await discover(model, options);
      try {
        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/chat/completions`,
          buildSglangPayload(messages, model, options, true),
          { headers, signal: options.signal },
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
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") return; // Client disconnected
        throw toProviderError(error);
      }
    },

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(MODALITY_TYPES.IMAGE, MODALITY_TYPES.TEXT)[
        PROVIDERS.SGLANG
      ],
      systemPrompt?: string,
    ): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
      logger.provider("SGLang", `captionImage model=${model} baseUrl=${baseUrl}`);
      try {
        const content = [
          { type: "text", text: prompt },
          ...images.filter(isForwardableMediaUrl).map((image: string) => ({
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
          { messages, model, temperature: 0.7, stream: false },
          { headers },
        );
        const data = (await response.json()) as OpenAICompletionResponse;
        const { text, usage } = processNonStreamingResponse(data);
        return {
          text,
          usage: {
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
          },
        };
      } catch (error: unknown) {
        throw toProviderError(error);
      }
    },

    // ── Embedding Generation ─────────────────────────────────
    // An embedding server (--is-embedding for decoder models). `dimensions`
    // only works on Matryoshka models; SGLang rejects it on the rest.

    async generateEmbedding(
      content: string | string[],
      model: string,
      options: ProviderOptions = {},
    ) {
      logger.provider(
        "SGLang",
        `generateEmbedding model=${model} baseUrl=${baseUrl}`,
      );
      try {
        const payload: Record<string, unknown> = { model, input: content };
        if (options.dimensions) payload.dimensions = options.dimensions;

        const response = await fetchOpenAICompat(
          `${baseUrl}/v1/embeddings`,
          payload,
          { headers },
        );
        const data = (await response.json()) as SglangEmbeddingResponse;

        const embedding = data.data?.[0]?.embedding;
        if (!embedding) {
          throw new Error("No embedding data in SGLang response");
        }
        return { embedding, dimensions: embedding.length };
      } catch (error: unknown) {
        throw toProviderError(error);
      }
    },

    // ── Health Check ─────────────────────────────────────────
    // GET /ready (v0.5.20+) answers at once; older servers only have /health,
    // which runs a one-token generation. Both answer 503 while warming up.

    async checkHealth() {
      logger.provider("SGLang", "checkHealth");
      try {
        const probe = (path: string) =>
          fetch(`${baseUrl}${path}`, {
            method: "GET",
            signal: AbortSignal.timeout(TOOL_API_HEALTH_TIMEOUT_MILLISECONDS),
          });
        let response = await probe("/ready");
        if (response.status === 404) response = await probe("/health");
        return {
          ok: response.ok,
          status: response.ok
            ? "ok"
            : response.status === 503
              ? "starting"
              : "error",
        };
      } catch (error: unknown) {
        return {
          ok: false,
          status: "unreachable",
          error: getErrorMessage(error),
        };
      }
    },

    // ── Model Listing ────────────────────────────────────────

    async listModels() {
      logger.provider("SGLang", "listModels");
      try {
        const [modelsResponse, modelInfo] = await Promise.all([
          fetch(`${baseUrl}/v1/models`, { method: "GET", headers }),
          getInfo<SglangModelInfo>("/model_info", "/get_model_info"),
        ]);
        if (!modelsResponse.ok) {
          const errorText = await modelsResponse.text();
          throw Object.assign(
            new Error(`API error: ${modelsResponse.status} ${errorText}`),
            { status: modelsResponse.status },
          );
        }
        const models = (await modelsResponse.json()) as SglangModelsResponse;

        // Servers older than the parser fields on /model_info report them
        // only among the launch arguments.
        const serverInfo =
          modelInfo && !("tool_call_parser" in modelInfo)
            ? await getInfo<SglangServerInfo>("/server_info", "/get_server_info")
            : null;

        return {
          models: mergeSglangModelMetadata(models, modelInfo, serverInfo),
        };
      } catch (error: unknown) {
        throw toProviderError(error);
      }
    },

    async discoverContextWindow(
      model: string,
      options: ProviderOptions,
    ): Promise<void> {
      await discover(model, options);
    },
  };
}

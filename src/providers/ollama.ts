import {
  type ProviderOptions,
  type ChatMessage,
  type Provider,
  type GenerateTextResult,
  type StreamChunk,
  type StreamToolCallChunk,
} from "#src/types/provider";
import { ProviderError } from "#src/utils/errors";
import {
  STREAMING_DISPATCHER,
  convertToolsToOpenAI,
  prependIdentitySystemMessage,
} from "#src/providers/openai-compat";
import logger from "#src/utils/logger";
import { discoverContextLength } from "#src/utils/ContextLengthDiscovery";

import { MODALITY_TYPES, getDefaultModels } from "#src/config";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/** A tool call as Ollama's /api/chat returns (and accepts) it. */
interface OllamaToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
    index?: number;
  };
}

/** Ollama takes and returns tool arguments as a JSON object, not a string. */
function toOllamaArguments(args: unknown): Record<string, unknown> {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read one of Ollama's tool calls into the `toolCall` chunk every provider
 * emits. Ollama sends each call whole (never argument deltas), and older
 * servers send no id — one is minted so the result can be paired back.
 */
function readOllamaToolCall(rawToolCall: OllamaToolCall): StreamToolCallChunk {
  const rawArguments = rawToolCall.function?.arguments;
  let args: Record<string, unknown> = {};
  let argsParseError = false;
  if (typeof rawArguments === "string") {
    try {
      args = toOllamaArguments(JSON.parse(rawArguments));
    } catch {
      // Flag instead of executing with empty args (see harness handling).
      argsParseError = true;
    }
  } else {
    args = toOllamaArguments(rawArguments);
  }
  return {
    type: "toolCall",
    id: rawToolCall.id || `ollama-toolCall-${crypto.randomUUID()}`,
    name: rawToolCall.function?.name || "",
    args,
    ...(argsParseError && {
      argsParseError: true,
      rawArgs: String(rawArguments).slice(0, 2000),
    }),
  };
}

/**
 * Convert messages to Ollama's native /api/chat format.
 * - Images are base64 strings (without the data URL prefix).
 * - An assistant turn's tool calls go out as `tool_calls` with object
 *   arguments; a tool result names its tool (`tool_name`) and, for servers
 *   that read it, the call it answers (`tool_call_id`).
 */
function prepareOllamaMessages(messages: ChatMessage[]) {
  return messages.map((messageItem: ChatMessage) => {
    const message: Record<string, unknown> = {
      role: messageItem.role,
      content: messageItem.content || "",
    };
    if (messageItem.role === "tool") {
      if (typeof messageItem.content !== "string") {
        message.content = JSON.stringify(messageItem.content ?? "");
      }
      if (messageItem.name) message.tool_name = messageItem.name;
      const toolCallId = messageItem.tool_call_id || messageItem.id;
      if (toolCallId) message.tool_call_id = toolCallId;
      return message;
    }
    if (messageItem.role === "assistant" && messageItem.toolCalls?.length) {
      message.tool_calls = messageItem.toolCalls.map(
        (toolCall): OllamaToolCall => ({
          ...(toolCall.id ? { id: toolCall.id } : {}),
          function: {
            name: toolCall.name,
            arguments: toOllamaArguments(toolCall.args),
          },
        }),
      );
    }
    if (messageItem.images && messageItem.images.length > 0) {
      // Ollama's native API expects images as raw base64 strings
      message.images = messageItem.images.map(
        (dataUrl: string) => {
          if (dataUrl.startsWith("data:")) {
            return dataUrl.split(",")[1]; // strip data:image/...;base64, prefix
          }
          return dataUrl;
        },
      );
    }
    return message;
  });
}

/**
 * POST /api/chat. When the request carries tools and the model's template
 * has none, Ollama answers 400 "<model> does not support tools"; the request
 * is then retried once without them, so such a model still answers — as
 * every Ollama turn did before tools were wired.
 */
async function postOllamaChat(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const send = async (body: Record<string, unknown>): Promise<Response> => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // A streamed body outlives undici's default 5-minute body timeout.
      ...(body.stream === true && { dispatcher: STREAMING_DISPATCHER }),
      ...(signal && { signal }),
    } as RequestInit);
    return response;
  };

  let response = await send(requestBody);
  if (response.ok) return response;
  let errorText = await response.text();
  if (
    requestBody.tools &&
    response.status === 400 &&
    /does not support tools/i.test(errorText)
  ) {
    logger.warn(
      `Ollama: ${String(requestBody.model)} does not support tools — retrying without them`,
    );
    const { tools: _unsupportedTools, ...bodyWithoutTools } = requestBody;
    response = await send(bodyWithoutTools);
    if (response.ok) return response;
    errorText = await response.text();
  }
  throw new Error(`API error: ${response.status} ${errorText}`);
}

/**
 * Build parameters options for Ollama native API options.
 */
function buildOllamaOptions(options: ProviderOptions) {
  const ollamaOptions: Record<string, unknown> = {};

  if (options.temperature !== undefined)
    ollamaOptions.temperature = options.temperature;
  if (options.topP !== undefined) ollamaOptions.top_p = options.topP;
  if (options.topK !== undefined) ollamaOptions.top_k = options.topK;
  if (options.minP !== undefined) ollamaOptions.min_p = options.minP;
  if (options.maxTokens !== undefined)
    ollamaOptions.num_predict = options.maxTokens;
  if (options.stopSequences !== undefined)
    ollamaOptions.stop = options.stopSequences;
  if (options.seed !== undefined) {
    const seedValue =
      typeof options.seed === "string"
        ? parseInt(options.seed, 10)
        : options.seed;
    if (!isNaN(seedValue)) {
      ollamaOptions.seed = seedValue;
    }
  }
  if (options.frequencyPenalty !== undefined)
    ollamaOptions.frequency_penalty = options.frequencyPenalty;
  if (options.presencePenalty !== undefined)
    ollamaOptions.presence_penalty = options.presencePenalty;
  if (options.repeatPenalty !== undefined)
    ollamaOptions.repeat_penalty = options.repeatPenalty;

  return ollamaOptions;
}

/**
 * What each model's template supports, as the server itself reports it on
 * /api/show (`capabilities`: "completion", "tools", "thinking", "vision",
 * "embedding", …). Keyed by server, model and digest — a re-pull changes the
 * digest. `null` records a server that answered without the field.
 */
const reportedCapabilitiesCache = new Map<string, string[] | null>();

/** Model listing runs under a short discovery timeout; one slow model must not sink it. */
const SHOW_TIMEOUT_MILLISECONDS = 1500;

async function fetchReportedCapabilities(
  baseUrl: string,
  model: string,
  digest: string | undefined,
): Promise<string[] | undefined> {
  const cacheKey = `${baseUrl}|${model}|${digest ?? ""}`;
  if (reportedCapabilitiesCache.has(cacheKey)) {
    return reportedCapabilitiesCache.get(cacheKey) ?? undefined;
  }
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { capabilities?: unknown };
    const capabilities = Array.isArray(payload?.capabilities)
      ? payload.capabilities.filter(
          (capability): capability is string => typeof capability === "string",
        )
      : null;
    reportedCapabilitiesCache.set(cacheKey, capabilities);
    return capabilities ?? undefined;
  } catch {
    // Unreachable or too slow — not cached, so the next listing asks again.
    return undefined;
  }
}

export function createOllamaProvider(
  baseUrl: string,
  instanceId: string = "ollama",
): Provider {
  const getBaseUrl = () => baseUrl;

  return {
    name: instanceId,

    // ── Non-Streaming Text Generation ──────────────────────

    async generateText(
      messages: ChatMessage[],
      model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ): Promise<GenerateTextResult> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `generateText model=${model} baseUrl=${baseUrl}`,
      );
      await discoverContextLength(instanceId, baseUrl, model, options);
      try {
        const effectiveMessages = prependIdentitySystemMessage(messages, options.systemPrompt);
        const preparedMessages = prepareOllamaMessages(effectiveMessages);

        const tools = convertToolsToOpenAI(options.tools);
        const requestBody = {
          model,
          messages: preparedMessages,
          stream: false,
          ...(tools ? { tools } : {}),
          ...(options.thinkingEnabled ? { think: true } : {}),
          options: buildOllamaOptions(options),
        };

        const response = await postOllamaChat(baseUrl, requestBody);

        const responseData = (await response.json()) as {
          message?: {
            content?: string;
            thinking?: string;
            tool_calls?: OllamaToolCall[];
          };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const thinking = responseData.message?.thinking || undefined;
        const result: GenerateTextResult = {
          text: responseData.message?.content || "",
          usage: {
            inputTokens: responseData.prompt_eval_count ?? 0,
            outputTokens: responseData.eval_count ?? 0,
          },
        };
        if (thinking) {
          result.thinking = thinking;
        }
        const rawToolCalls = responseData.message?.tool_calls;
        if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
          result.toolCalls = rawToolCalls.map((rawToolCall) => {
            const { id, name, args } = readOllamaToolCall(rawToolCall);
            return { id: id as string, name, args };
          });
        }
        return result;
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error as Error);
      }
    },

    // ── Streaming Text Generation ──────────────────────

    async *generateTextStream(
      messages: ChatMessage[],
      model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)["ollama"],
      options: ProviderOptions = {},
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const baseUrl = getBaseUrl();
      logger.provider(
        "Ollama",
        `generateTextStream model=${model} baseUrl=${baseUrl}`,
      );
      await discoverContextLength(instanceId, baseUrl, model, options);
      let partialOutputCharacters = 0;
      let partialThinkingCharacters = 0;
      try {
        // Single-model enforcement: unload any other loaded models
        try {
          const processStatusResponse = await fetch(`${baseUrl}/api/ps`);
          if (processStatusResponse.ok) {
            const processStatusData = await processStatusResponse.json();
            const runningModels =
              (processStatusData as Record<string, unknown[]>).models || [];
            for (const runningModelInstance of runningModels as Record<
              string,
              string
            >[]) {
              const runningName =
                runningModelInstance.model || runningModelInstance.name;
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
        } catch (unloadError: unknown) {
          logger.warn(
            `Ollama: could not check/unload models: ${getErrorMessage(unloadError)}`,
          );
        }

        const effectiveMessages = prependIdentitySystemMessage(messages, options.systemPrompt);
        const preparedMessages = prepareOllamaMessages(effectiveMessages);

        const tools = convertToolsToOpenAI(options.tools);
        const requestBody = {
          model,
          messages: preparedMessages,
          stream: true,
          ...(tools ? { tools } : {}),
          ...(options.thinkingEnabled ? { think: true } : {}),
          options: buildOllamaOptions(options),
        };

        const response = await postOllamaChat(
          baseUrl,
          requestBody,
          options.signal,
        );

        // Ollama streams NDJSON (one JSON object per line)
        const reader = (
          response.body as ReadableStream<Uint8Array>
        ).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let usage = null;

        while (true) {
          if (options.signal?.aborted) {
            void reader.cancel().catch(() => {
              /* reader teardown is best-effort */
            });
            break;
          }
          const { done: isDone, value } = await reader.read();
          if (isDone) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!; // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const parsedJson = JSON.parse(trimmed);

              // Thinking content comes in message.thinking
              if (parsedJson.message?.thinking) {
                partialThinkingCharacters += (
                  parsedJson.message.thinking as string
                ).length;
                yield {
                  type: "thinking",
                  content: parsedJson.message.thinking,
                };
              }

              // Text content comes in message.content
              if (parsedJson.message?.content) {
                partialOutputCharacters += (
                  parsedJson.message.content as string
                ).length;
                yield parsedJson.message.content;
              }

              // Tool calls arrive whole in message.tool_calls
              if (Array.isArray(parsedJson.message?.tool_calls)) {
                for (const rawToolCall of parsedJson.message
                  .tool_calls as OllamaToolCall[]) {
                  yield readOllamaToolCall(rawToolCall);
                }
              }

              // Final chunk has done: true with usage stats
              if (parsedJson.done) {
                const evalDurationSec = parsedJson.eval_duration
                  ? parsedJson.eval_duration / 1_000_000_000
                  : null;
                usage = {
                  inputTokens: parsedJson.prompt_eval_count ?? 0,
                  outputTokens: parsedJson.eval_count ?? 0,
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
          yield {
            type: "usage",
            usage: {
              ...usage, // preserve cacheReadInputTokens etc. from normalizeUsage
              inputTokens: usage.inputTokens || 0,
              outputTokens: usage.outputTokens || 0,
            },
          };
        } else {
          yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") return; // Client disconnected
        // Yield partial usage before re-throwing so the consumer captures
        // whatever tokens were generated before the stream terminated.
        if (partialOutputCharacters > 0 || partialThinkingCharacters > 0) {
          const estimatedOutputTokens = Math.ceil(partialOutputCharacters / 4);
          const estimatedThinkingTokens = Math.ceil(
            partialThinkingCharacters / 4,
          );
          yield {
            type: "usage",
            usage: {
              inputTokens: 0,
              outputTokens: estimatedOutputTokens + estimatedThinkingTokens,
            },
          };
        }
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error as Error);
      }
    },

    // ── Image Captioning ──────────────────────

    async captionImage(
      images: string[],
      prompt: string = "Describe this image.",
      model: string = getDefaultModels(MODALITY_TYPES.IMAGE, MODALITY_TYPES.TEXT)["ollama"],
      systemPrompt?: string,
    ): Promise<{
      text: string;
      usage: { inputTokens: number; outputTokens: number };
    }> {
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

        const responseData = await response.json();
        const text =
          (responseData as Record<string, Record<string, string>>).message
            ?.content || "";
        const usage = {
          inputTokens:
            (responseData as Record<string, number>).prompt_eval_count || 0,
          outputTokens:
            (responseData as Record<string, number>).eval_count || 0,
        };
        return { text, usage };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error as Error);
      }
    },

    // ── Ollama Model Listing ─────────────────────

    /**
     * List all models available in Ollama.
     * GET /api/tags
     */
    async listModels(): Promise<{
      models: Array<{
        key: string;
        display_name: string;
        type: string;
        loaded_instances?: Array<{ id: string }>;
        name?: string;
        model?: string;
        size?: number;
        details?: Record<string, unknown>;
        ollamaCapabilities?: string[];
      }>;
    }> {
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

        const responseData = await response.json();
        const models = (responseData as Record<string, Record<string, unknown>[]>).models || [];

        let running: Record<string, unknown>[] = [];
        try {
          const processStatusResponse = await fetch(`${baseUrl}/api/ps`);
          if (processStatusResponse.ok) {
            const processStatusData = await processStatusResponse.json();
            running =
              (processStatusData as Record<string, Record<string, unknown>[]>)
                .models || [];
          }
        } catch (error: unknown) {
          logger.warn(
            `Ollama listModels: could not query active models: ${getErrorMessage(error)}`,
          );
        }

        // The capability label ("Tool Calling", "Thinking") comes from what
        // the server reports per model, not from the model's name.
        const reportedCapabilities = await Promise.all(
          models.map((modelItem) =>
            fetchReportedCapabilities(
              baseUrl,
              (modelItem.model || modelItem.name || "") as string,
              modelItem.digest as string | undefined,
            ),
          ),
        );

        const mappedModelsList = models.map((value: Record<string, unknown>, modelIndex: number) => {
          const modelItem = value;
          const tagName = (modelItem.model || modelItem.name || "") as string;
          const matchedRunningModel = running.find((runningModel) => {
            const runningName = (runningModel.model ||
              runningModel.name ||
              "") as string;
            if (runningName === tagName) return true;
            const cleanTagName = tagName.endsWith(":latest")
              ? tagName.slice(0, -7)
              : tagName;
            const cleanRunningName = runningName.endsWith(":latest")
              ? runningName.slice(0, -7)
              : runningName;
            return cleanTagName === cleanRunningName;
          });

          const loadedInstances = matchedRunningModel
            ? [
                {
                  id: String(
                    matchedRunningModel.model || matchedRunningModel.name,
                  ),
                  config: {
                    context_length: null,
                    size_vram: matchedRunningModel.size_vram ?? null,
                    expires_at: matchedRunningModel.expires_at ?? null,
                  },
                },
              ]
            : undefined;

          const ollamaCapabilities = reportedCapabilities[modelIndex];
          return {
            key: tagName,
            display_name: tagName,
            type: "llm",
            loaded_instances: loadedInstances,
            // Raw /api/tags fields the gateway's normalizer reads.
            name: (modelItem.name || tagName) as string,
            model: tagName,
            ...(typeof modelItem.size === "number" && { size: modelItem.size }),
            ...(modelItem.details && typeof modelItem.details === "object"
              ? { details: modelItem.details as Record<string, unknown> }
              : {}),
            ...(ollamaCapabilities && { ollamaCapabilities }),
          };
        });

        return { models: mappedModelsList };
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("ollama", getErrorMessage(error), 500, error as Error);
      }
    },

    async discoverContextWindow(
      model: string,
      options: ProviderOptions,
    ): Promise<void> {
      await discoverContextLength(instanceId, getBaseUrl(), model, options);
    },
  };
}

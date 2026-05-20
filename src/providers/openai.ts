import OpenAI, { toFile } from "openai";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { extractOpenAIRateLimits } from "../utils/rateLimits.ts";
// @ts-ignore
import { OPENAI_API_KEY, OPENAI_TRANSCRIPTION_MODEL } from "../../config.ts";
import {
  TYPES,
  DEFAULT_VOICES,
  getDefaultModels,
  getModelByName,
} from "../config.ts";
import { convertToolsToOpenAI } from "../utils/openai-compat.ts";
import {
  getDataUrlMimeType,
  getUrlType,
  inferMimeFromUrl,
} from "../utils/media.ts";
import type { ProviderOptions } from "../types/provider.ts";
import type { ToolSchema } from "../services/harnesses/types.ts";

/**
 * Check if a model should use the Responses API.
 */
function useResponsesAPI(model: string): boolean {
  const modelDef = getModelByName(model) as Record<string, unknown> | undefined;
  return modelDef?.responsesAPI === true;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!OPENAI_API_KEY) {
      throw new ProviderError("openai", "OPENAI_API_KEY is not set", 401);
    }
    client = new OpenAI({ apiKey: OPENAI_API_KEY as string });
  }
  return client;
}

/** OpenAI conversation message (same shape as Google's ConversationMsg) */
export interface OpenAIMsg {
  role: string;
  content?: string;
  name?: string;
  images?: string[];
  toolCalls?: Array<{
    id?: string;
    name: string;
    args: unknown;
    responsesItemId?: string;
  }>;
  tool_call_id?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Convert generic tool schemas to OpenAI Responses API format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", name, description, parameters }]
 */
function convertToolsToResponsesAPI(tools?: ToolSchema[] | null) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description || "",
    parameters: t.parameters || {},
  }));
}

/** Narrow unknown errors into ProviderError for all catch blocks. */
function toProviderError(error: unknown): never {
  const err = error as Record<string, unknown>;
  throw new ProviderError(
    "openai",
    (err.message as string) || String(error),
    (err.status as number) || 500,
    error,
  );
}

/** Narrow unknown catch to a typed error record for retry logic. */
function asErrorRecord(error: unknown): Record<string, unknown> & { message?: string; status?: number } {
  return error as Record<string, unknown> & { message?: string; status?: number };
}

/**
 * Convert messages with media to OpenAI multimodal content format (Chat Completions).
 */
function prepareOpenAIMessages(messages: OpenAIMsg[]) {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role };
    if (m.name) base.name = m.name;

    // Tool result messages — include tool_call_id for correlation
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id || m.id || "",
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? ""),
      };
    }

    // Assistant messages with tool calls — include tool_calls in OpenAI format
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        ...base,
        content: m.content?.trim() || null,
        tool_calls: m.toolCalls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.args === "string"
                ? tc.args
                : JSON.stringify(tc.args || {}),
          },
        })),
      };
    }

    if (m.images && m.images.length > 0) {
      const content: Record<string, unknown>[] = [];
      for (const mediaRef of m.images) {
        const urlType = getUrlType(mediaRef);

        if (urlType === "data") {
          // Base64 data URL — use MIME type to route
          const mime = getDataUrlMimeType(mediaRef);
          if (mime && mime.startsWith("image/")) {
            content.push({ type: "image_url", image_url: { url: mediaRef } });
          } else if (mime === "application/pdf") {
            content.push({
              type: "file",
              file: { file_data: mediaRef, filename: "document.pdf" },
            });
          } else if (
            mime &&
            (mime.startsWith("text/") || mime === "application/json")
          ) {
            // Decode text files and inline as text
            try {
              const base64 = mediaRef.split(";base64,")[1];
              const decoded = Buffer.from(base64, "base64").toString("utf-8");
              content.push({
                type: "text",
                text: `[Attached file (${mime})]:\n${decoded}`,
              });
            } catch {
              content.push({
                type: "text",
                text: `[Attached file (${mime}): unable to decode]`,
              });
            }
          } else {
            // Other data URL file types
            content.push({
              type: "file",
              file: { file_data: mediaRef, filename: "attachment" },
            });
          }
        } else if (urlType === "http") {
          // HTTP(S) URL — the Chat Completions API accepts URLs in image_url
          const inferredType = inferMimeFromUrl(mediaRef);
          if (inferredType === "image") {
            content.push({ type: "image_url", image_url: { url: mediaRef } });
          } else {
            // Chat Completions file type via URL — use file_data with the URL
            content.push({
              type: "file",
              file: { file_data: mediaRef, filename: "attachment" },
            });
          }
        } else {
          // Unknown ref type (e.g. minio://) — skip with warning
          logger.warn(
            `[openai] Skipping unresolved media ref in Chat Completions input: ${mediaRef.substring(0, 60)}...`,
          );
        }
      }
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      return { ...base, content };
    }
    return { ...base, content: m.content ?? "" };
  });
}

/**
 * Convert messages to Responses API input format.
 * System messages become developer messages; images use input_image, PDFs use input_file.
 */
function prepareResponsesInput(messages: OpenAIMsg[]) {
  const result: Record<string, unknown>[] = [];
  for (const m of messages) {
    // Assistant message with tool calls → expand into function_call items
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // If the assistant also produced text, include it first
      if (m.content?.trim()) {
        result.push({ role: "assistant", content: m.content });
      }
      // Each tool call becomes a function_call output item
      for (const tc of m.toolCalls) {
        // Responses API requires the function_call id to start with "fc_"
        // responsesItemId is the fc_ prefixed ID from the streaming handler
        const fcId = tc.responsesItemId || tc.id || `fc_${Date.now()}`;
        result.push({
          type: "function_call",
          id: fcId,
          call_id: tc.id || fcId,
          name: tc.name,
          arguments:
            typeof tc.args === "string"
              ? tc.args
              : JSON.stringify(tc.args || {}),
        });
      }
      continue;
    }

    // Tool result message → function_call_output item
    if (m.role === "tool") {
      result.push({
        type: "function_call_output",
        call_id: m.tool_call_id || m.id,
        output:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content || ""),
      });
      continue;
    }

    // Standard message (system, user, assistant without tools)
    const role = m.role === "system" ? "developer" : m.role;
    const base: Record<string, unknown> = { role };
    if (m.name) base.name = m.name;
    if (m.images && m.images.length > 0) {
      const content: Record<string, unknown>[] = [];
      for (const mediaRef of m.images) {
        const urlType = getUrlType(mediaRef);

        if (urlType === "data") {
          // Base64 data URL — use MIME type to route
          const mime = getDataUrlMimeType(mediaRef);
          if (mime && mime.startsWith("image/")) {
            content.push({ type: "input_image", image_url: mediaRef });
          } else if (
            mime === "application/pdf" ||
            mime ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ) {
            content.push({
              type: "input_file",
              file_data: mediaRef,
              filename: "document.pdf",
            });
          } else if (
            mime &&
            (mime.startsWith("text/") || mime === "application/json")
          ) {
            // Decode text files and inline as text
            try {
              const base64 = mediaRef.split(";base64,")[1];
              const decoded = Buffer.from(base64, "base64").toString("utf-8");
              content.push({
                type: "input_text",
                text: `[Attached file (${mime})]:\n${decoded}`,
              });
            } catch {
              content.push({
                type: "input_text",
                text: `[Attached file (${mime}): unable to decode]`,
              });
            }
          } else {
            // Other data URL file types
            content.push({
              type: "input_file",
              file_data: mediaRef,
              filename: "attachment",
            });
          }
        } else if (urlType === "http") {
          // HTTP(S) URL — infer type from extension, use URL-based fields
          const inferredType = inferMimeFromUrl(mediaRef);
          if (inferredType === "image") {
            content.push({ type: "input_image", image_url: mediaRef });
          } else {
            content.push({ type: "input_file", file_url: mediaRef });
          }
        } else {
          // Unknown ref type (e.g. minio://) — skip with warning
          logger.warn(
            `[openai] Skipping unresolved media ref in Responses API input: ${mediaRef.substring(0, 60)}...`,
          );
        }
      }
      if (m.content) {
        content.push({ type: "input_text", text: m.content });
      }
      result.push({ ...base, content });
      continue;
    }
    // Responses API requires content to be a string or array, never null
    result.push({ ...base, content: m.content ?? "" });
  }
  return result;
}

const openaiProvider = {
  name: "openai",

  async generateText(
    messages: OpenAIMsg[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `generateText model=${model}`);
    try {
      if (useResponsesAPI(model)) {
        return await this._generateTextResponses(messages, model, options);
      }
      return await this._generateTextChatCompletions(messages, model, options);
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  /**
   * Responses API path for GPT-5.2/5.4 models.
   */
  async _generateTextResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const input = prepareResponsesInput(messages);
    const payload: Record<string, unknown> = { model, input };

    // Reasoning
    const reasoning: Record<string, unknown> = {};
    if (options.reasoningEffort) reasoning.effort = options.reasoningEffort;
    if (options.reasoningSummary) reasoning.summary = options.reasoningSummary;
    if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning;

    // Text / verbosity
    const text: Record<string, unknown> = {};
    if (options.verbosity) text.format = { type: "text" };
    if (options.verbosity) text.verbosity = options.verbosity;
    if (Object.keys(text).length > 0) payload.text = text;

    if (options.maxTokens) payload.max_output_tokens = options.maxTokens;

    // Seed for reproducibility
    if (options.seed !== undefined) payload.seed = options.seed;

    // Service tier: auto / default / priority
    if (options.serviceTier) payload.service_tier = options.serviceTier;

    // Response format (JSON mode) — maps to text.format for Responses API
    if (options.responseFormat === "json_object") {
      text.format = { type: "json_object" };
    } else if (
      options.responseFormat === "json_schema" &&
      options.responseSchema
    ) {
      text.format = {
        type: "json_schema",
        json_schema: options.responseSchema,
      };
    }

    // Temperature/topP only work with reasoning.effort=none
    if (options.reasoningEffort === "none") {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop = options.stopSequences;
    }

    // Web search tool
    if (options.webSearch) {
      payload.tools = [{ type: "web_search" }];
    }

    // Custom function calling tools
    const customTools = convertToolsToResponsesAPI(options.tools);
    if (customTools) {
      payload.tools = [...((payload.tools as unknown[]) || []), ...customTools];
    }

    const { data: response, response: rawResponse } = await getClient()
      .responses.create(payload)
      .withResponse();

    // Extract rate-limit headers
    const rateLimits = extractOpenAIRateLimits(rawResponse, model);

    // Collect tool calls and images from output items
    const images: Array<{ type: string; data: string; mimeType: string }> = [];
    const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
    if (response.output) {
      for (const item of response.output) {
        if (item.type === "image_generation_call" && item.result) {
          images.push({
            type: "image",
            data: item.result,
            mimeType: "image/png",
          });
        } else if (item.type === "function_call") {
          let args = {};
          try {
            args = JSON.parse(item.arguments || "{}");
          } catch {
            /* ignore */
          }
          toolCalls.push({
            id: item.call_id,
            name: item.name,
            args,
          });
        }
      }
    }

    const result: Record<string, unknown> = {
      text: response.output_text || "",
      images,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    if (rateLimits) result.rateLimits = rateLimits;
    return result;
  },

  /**
   * Chat Completions fallback for older models.
   */
  async _generateTextChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const modelDef = getModelByName(model) as Record<string, unknown> | undefined;
    const isReasoning =
      modelDef?.thinking || model.includes("o1") || model.includes("o3");
    const prepared = prepareOpenAIMessages(messages);
    const payload: Record<string, unknown> = {
      model,
      messages: prepared,
    };
    if (isReasoning) {
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
      if (options.reasoningEffort)
        payload.reasoning_effort = options.reasoningEffort;
    } else {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop = options.stopSequences;
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    }

    // Seed for reproducibility
    if (options.seed !== undefined) payload.seed = options.seed;

    // Service tier: auto / default / priority
    if (options.serviceTier) payload.service_tier = options.serviceTier;

    // Response format (JSON mode)
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    if (options.webSearch) {
      payload.tools = [{ type: "web_search" }];
    }

    // Custom function calling tools
    const customTools = convertToolsToOpenAI(options.tools);
    if (customTools) {
      payload.tools = [...((payload.tools as unknown[]) || []), ...customTools];
    }

    try {
      const { data: response, response: rawResponse } = await getClient()
        .chat.completions.create(payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)
        .withResponse();
      const rateLimits = extractOpenAIRateLimits(rawResponse, model);
      const message = response.choices[0].message;
      const result: Record<string, unknown> = {
        text: message.content || "",
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
      if (message.tool_calls && message.tool_calls.length > 0) {
        result.toolCalls = message.tool_calls.map((rawTc) => {
          const tc = rawTc as unknown as Record<string, unknown>;
          const fn = tc.function as { name: string; arguments: string } | undefined;
          let args = {};
          try {
            args = JSON.parse(fn?.arguments || "{}");
          } catch {
            /* ignore */
          }
          return {
            id: tc.id as string,
            name: fn?.name || "",
            args,
          };
        });
      }
      if (rateLimits) result.rateLimits = rateLimits;
      return result;
    } catch (error: unknown) {
      const err = asErrorRecord(error);
      // Retry once after stripping unsupported parameters (e.g. gpt-5-nano rejects temperature)
      if (err.status === 400 && err.message?.includes("Unsupported")) {
        const unsupportedParams = [
          "temperature",
          "top_p",
          "frequency_penalty",
          "presence_penalty",
          "max_completion_tokens",
        ];
        let stripped = false;
        for (const param of unsupportedParams) {
          if (
            err.message?.includes(`'${param}'`) &&
            payload[param] !== undefined
          ) {
            logger.provider(
              "OpenAI",
              `Stripping unsupported param '${param}' for ${model} and retrying`,
            );
            delete payload[param];
            stripped = true;
          }
        }
        if (stripped) {
          const response = await getClient().chat.completions.create(payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
          return {
            text: response.choices[0].message.content,
            usage: {
              inputTokens: response.usage?.prompt_tokens ?? 0,
              outputTokens: response.usage?.completion_tokens ?? 0,
            },
          };
        }
      }
      throw error;
    }
  },

  async *generateTextStream(
    messages: OpenAIMsg[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `generateTextStream model=${model}`);
    try {
      if (useResponsesAPI(model)) {
        yield* this._streamResponses(messages, model, options);
      } else {
        yield* this._streamChatCompletions(messages, model, options);
      }
    } catch (error: unknown) {
      if ((error as Error).name === "AbortError") return;
      toProviderError(error);
    }
  },

  /**
   * Streaming via the Responses API.
   */
  async *_streamResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const input = prepareResponsesInput(messages);
    const payload: Record<string, unknown> = { model, input, stream: true };

    // Reasoning
    const reasoning: Record<string, unknown> = {};
    if (options.reasoningEffort) reasoning.effort = options.reasoningEffort;
    if (options.reasoningSummary) reasoning.summary = options.reasoningSummary;
    if (Object.keys(reasoning).length > 0) payload.reasoning = reasoning;

    // Text / verbosity
    const text: Record<string, unknown> = {};
    if (options.verbosity) text.format = { type: "text" };
    if (options.verbosity) text.verbosity = options.verbosity;
    if (Object.keys(text).length > 0) payload.text = text;

    if (options.maxTokens) payload.max_output_tokens = options.maxTokens;

    // Seed for reproducibility
    if (options.seed !== undefined) payload.seed = options.seed;

    // Service tier: auto / default / priority
    if (options.serviceTier) payload.service_tier = options.serviceTier;

    // Response format (JSON mode) — maps to text.format for Responses API
    if (options.responseFormat === "json_object") {
      text.format = { type: "json_object" };
    } else if (
      options.responseFormat === "json_schema" &&
      options.responseSchema
    ) {
      text.format = {
        type: "json_schema",
        json_schema: options.responseSchema,
      };
    }

    // Temperature/topP only work with reasoning.effort=none
    if (options.reasoningEffort === "none") {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop = options.stopSequences;
    }

    // Web search tool
    if (options.webSearch) {
      payload.tools = [{ type: "web_search" }];
    }

    // Custom function calling tools
    const customTools = convertToolsToResponsesAPI(options.tools);
    if (customTools) {
      payload.tools = [...((payload.tools as unknown[]) || []), ...customTools];
    }

    const { data: streamData, response: rawStreamResponse } = await getClient()
      .responses.create(payload as any, {
        ...(options.signal && { signal: options.signal }),
      })
      .withResponse();
    const stream = streamData as unknown as AsyncIterable<Record<string, unknown>>;
    const rateLimits = extractOpenAIRateLimits(rawStreamResponse, model);
    let usage = null;
    // Track function names from output_item.added events; the arguments.done
    // event may not include the name property (known OpenAI SDK issue).
    const pendingFunctions: Record<string, { name: string; callId: string; args: string }> = {};
    for await (const rawEvent of stream) {
      const event = rawEvent as Record<string, any>;
      if (options.signal?.aborted) break;
      // Text delta from output_text
      if (event.type === "response.output_text.delta") {
        yield event.delta || "";
      }
      // Reasoning / thinking summary delta
      if (event.type === "response.reasoning_summary_text.delta") {
        yield { type: "thinking", content: event.delta || "" };
      }
      // Image generation completed
      if (
        event.type === "response.image_generation_call.completed" &&
        event.result
      ) {
        yield {
          type: "image",
          data: event.result,
          mimeType: "image/png",
        };
      }
      // Track function call metadata from output_item.added
      // item.id matches item_id on subsequent delta/done events
      if (
        event.type === "response.output_item.added" &&
        event.item?.type === "function_call"
      ) {
        pendingFunctions[event.item.id] = {
          name: event.item.name,
          callId: event.item.call_id,
          args: "",
        };
      }
      // Accumulate argument deltas (keyed by item_id)
      if (event.type === "response.function_call_arguments.delta") {
        const entry = pendingFunctions[event.item_id];
        const partial = event.delta || "";
        if (entry) {
          entry.args += partial;
        }
        // Yield progress event so generation throughput tracking stays
        // alive during FC argument streaming.
        if (partial.length > 0) {
          yield { type: "toolCallDelta", characters: partial.length };
        }
      }
      // Function call completed (Responses API)
      if (event.type === "response.function_call_arguments.done") {
        const tracked = pendingFunctions[event.item_id];
        const name = tracked?.name || event.name || "unknown";
        const callId = tracked?.callId || event.call_id || event.item_id;
        let args = {};
        try {
          args = JSON.parse(event.arguments || tracked?.args || "{}");
        } catch {
          /* ignore */
        }
        yield {
          type: "toolCall",
          id: callId,
          // Responses API internal item ID (starts with "fc_")
          responsesItemId: event.item_id,
          name,
          args,
        };
        // Clean up
        delete pendingFunctions[event.item_id];
      }
      // Completed response — extract usage
      if (event.type === "response.completed" && event.response?.usage) {
        usage = {
          inputTokens: event.response.usage.input_tokens ?? 0,
          outputTokens: event.response.usage.output_tokens ?? 0,
        };
      }
    }
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    }
    if (rateLimits) {
      yield { type: "rateLimits", rateLimits };
    }
  },

  /**
   * Streaming via Chat Completions (fallback for older models).
   */
  async *_streamChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const modelDef = getModelByName(model) as Record<string, unknown> | undefined;
    const isReasoning =
      modelDef?.thinking || model.includes("o1") || model.includes("o3");
    const prepared = prepareOpenAIMessages(messages);
    const payload: Record<string, unknown> = {
      model,
      messages: prepared,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (isReasoning) {
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
      if (options.reasoningEffort)
        payload.reasoning_effort = options.reasoningEffort;
    } else {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop = options.stopSequences;
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    }

    // Seed for reproducibility
    if (options.seed !== undefined) payload.seed = options.seed;

    // Service tier: auto / default / priority
    if (options.serviceTier) payload.service_tier = options.serviceTier;

    // Response format (JSON mode)
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    if (options.webSearch) {
      payload.tools = [{ type: "web_search" }];
    }

    // Custom function calling tools
    const customTools = convertToolsToOpenAI(options.tools);
    if (customTools) {
      payload.tools = [...((payload.tools as unknown[]) || []), ...customTools];
    }

    let stream: AsyncIterable<Record<string, unknown>>;
    let rateLimits = null;
    try {
      const { data: streamData, response: rawStreamResponse } =
        await getClient()
          .chat.completions.create(payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
            ...(options.signal && { signal: options.signal }),
          })
          .withResponse();
      stream = streamData as unknown as AsyncIterable<Record<string, unknown>>;
      rateLimits = extractOpenAIRateLimits(rawStreamResponse, model);
    } catch (error: unknown) {
      const err = asErrorRecord(error);
      // Retry once after stripping unsupported parameters (e.g. gpt-5-nano rejects temperature)
      if (err.status === 400 && err.message?.includes("Unsupported")) {
        const unsupportedParams = [
          "temperature",
          "top_p",
          "frequency_penalty",
          "presence_penalty",
          "max_completion_tokens",
        ];
        let stripped = false;
        for ( const param of unsupportedParams) {
          if (
            err.message?.includes(`'${param}'`) &&
            payload[param] !== undefined
          ) {
            logger.provider(
              "OpenAI",
              `Stripping unsupported param '${param}' for ${model} and retrying (stream)`,
            );
            delete payload[param];
            stripped = true;
          }
        }
        if (stripped) {
          const retryResult = await getClient()
            .chat.completions.create(payload as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming, {
              ...(options.signal && { signal: options.signal }),
            })
            .withResponse();
          stream = retryResult.data as unknown as AsyncIterable<Record<string, unknown>>;
          rateLimits = extractOpenAIRateLimits(retryResult.response, model);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    let usage = null;
    // Accumulate tool calls across chunks
    const pendingToolCalls: Record<number, { id: string; name: string; args: string }> = {};

    for await (const rawChunk of stream) {
      const chunk = rawChunk as Record<string, any>;
      if (options.signal?.aborted) break;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      const content = delta?.content || "";
      if (content) {
        yield content;
      }

      // Accumulate tool call deltas
      if (delta?.tool_calls) {
        let deltaChars = 0;
        for ( const tc of delta.tool_calls) {
          const index = tc.index;
          if (!pendingToolCalls[index]) {
            pendingToolCalls[index] = {
              id: tc.id || "",
              name: tc.function?.name || "",
              args: "",
            };
          }
          if (tc.id) pendingToolCalls[index].id = tc.id;
          if (tc.function?.name) pendingToolCalls[index].name = tc.function.name;
          if (tc.function?.arguments) {
            pendingToolCalls[index].args += tc.function.arguments;
            deltaChars += tc.function.arguments.length;
          }
        }
        // Yield progress event so generation throughput tracking stays
        // alive during FC argument streaming.
        if (deltaChars > 0) {
          yield { type: "toolCallDelta", characters: deltaChars };
        }
      }

      // If finish_reason is "tool_calls", yield accumulated tool calls
      if (chunk.choices[0]?.finish_reason === "tool_calls") {
        for ( const tc of Object.values(pendingToolCalls)) {
          let args = {};
          try {
            args = JSON.parse(tc.args || "{}");
          } catch {
            /* ignore */
          }
          yield {
            type: "toolCall",
            id: tc.id,
            name: tc.name,
            args,
          };
        }
      }
    }
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
    }
    if (rateLimits) {
      yield { type: "rateLimits", rateLimits };
    }
  },

  async generateSpeech(text: string, voice: string = DEFAULT_VOICES.openai, options: ProviderOptions = {}) {
    logger.provider("OpenAI", `generateSpeech voice=${voice}`);
    try {
      const response = await getClient().audio.speech.create({
        model:
          options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).openai,
        voice,
        input: text,
        instructions: options.instructions || undefined,
        response_format: (options.format as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm") || "mp3",
      });
      return { stream: response.body, contentType: "audio/mpeg" };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async generateImage(prompt: string, images: Array<string | { imageData: string; mimeType?: string }> = [], model: string = "gpt-image-1.5") {
    logger.provider(
      "OpenAI",
      `generateImage model=${model} images=${images.length}`,
    );
    try {
      let response: OpenAI.Images.ImagesResponse;

      if (images.length > 0) {
        // Use the edit endpoint when input images are provided
        // Take the last image in conversation as the one to edit
        const lastImage = images[images.length - 1];
        let imageBuffer: Buffer, mimeType: string;

        if (typeof lastImage === "object" && lastImage.imageData) {
          // Object format: { imageData: base64, mimeType }
          imageBuffer = Buffer.from(lastImage.imageData, "base64");
          mimeType = lastImage.mimeType || "image/png";
        } else if (typeof lastImage === "string") {
          // Data URL format: data:image/png;base64,...
          const base64Match = lastImage.match(/^data:([^;]+);base64,(.+)$/);
          if (!base64Match) {
            throw new Error("Invalid image data format");
          }
          imageBuffer = Buffer.from(base64Match[2], "base64");
          mimeType = base64Match[1];
        } else {
          throw new Error("Invalid image data format");
        }
        const ext = mimeType.split("/")[1] || "png";
        const imageFile = await toFile(imageBuffer, `input.${ext}`, {
          type: mimeType,
        });

        response = await getClient().images.edit({
          model,
          prompt,
          image: imageFile,
          size: "1024x1024",
        });
      } else {
        // Generate new image
        response = await getClient().images.generate({
          model,
          prompt,
          output_format: "png",
          size: "1024x1024",
          quality: "high",
        });
      }

      const imageData =
        response.data?.[0]?.b64_json || (response.data?.[0] as Record<string, unknown>)?.b64 || (response as unknown as Record<string, unknown>).b64;
      if (!imageData) {
        throw new Error("No image data received from OpenAI");
      }
      return {
        imageData,
        mimeType: "image/png",
        text: response.data?.[0]?.revised_prompt || "",
      };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async captionImage(
    images: string[],
    prompt: string = "What's in this image?",
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    systemPrompt?: string,
  ) {
    logger.provider("OpenAI", `captionImage model=${model}`);
    try {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [
        { type: "text", text: prompt },
        ...images.map((image: string) => ({
          type: "image_url",
          image_url: { url: image },
        }) as OpenAI.Chat.ChatCompletionContentPartImage),
      ];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content });
      const response = await getClient().chat.completions.create({
        model,
        messages,
        max_completion_tokens: 1000,
      });
      const usage = {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      };
      return { text: response.choices[0].message.content, usage };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async generateEmbedding(
    text: string,
    model: string = getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING).openai,
  ) {
    logger.provider("OpenAI", `generateEmbedding model=${model}`);
    try {
      const response = await getClient().embeddings.create({
        model,
        input: text,
      });
      return { embedding: response.data[0].embedding };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    model: string = (OPENAI_TRANSCRIPTION_MODEL as string) || "whisper-1",
    options: ProviderOptions = {},
  ) {
    logger.provider("OpenAI", `transcribeAudio model=${model}`);
    try {
      const ext = (mimeType.split("/")[1] || "wav") as "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm";
      const file = await toFile(audioBuffer, `audio.${ext}`, {
        type: mimeType,
      });
      const payload: Record<string, unknown> = {
        file,
        model,
      };
      if (options.language) payload.language = options.language;
      if (options.prompt) payload.prompt = options.prompt;

      const response = await getClient().audio.transcriptions.create(payload as unknown as OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming);
      const usage: Record<string, number> = {};
      const responseUsage = (response as Record<string, any>).usage;
      if (responseUsage) {
        if (responseUsage.type === "tokens") {
          usage.inputTokens = responseUsage.input_tokens ?? 0;
          usage.outputTokens = responseUsage.output_tokens ?? 0;
        } else if (responseUsage.type === "duration") {
          usage.durationSeconds = responseUsage.seconds ?? 0;
        }
      }
      return {
        text: response.text,
        usage,
      };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },
};

export default openaiProvider;

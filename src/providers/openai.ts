import { ProviderOptions } from "../types/ProviderTypes.ts";
import OpenAI, { toFile } from "openai";
import type { Stream } from "openai/streaming";
import type { Reasoning, ReasoningEffort } from "openai/resources/shared";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { extractOpenAIRateLimits } from "../utils/rateLimits.ts";
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

import type { ToolSchema } from "../services/harnesses/types.ts";
function useResponsesAPI(model: string): boolean {
  const modelDef = getModelByName(model);
  return modelDef !== null && "responsesAPI" in modelDef && (modelDef as any).responsesAPI === true;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!OPENAI_API_KEY) {
      throw new ProviderError("openai", "OPENAI_API_KEY is not set", 401);
    }
    client = new OpenAI({ apiKey: OPENAI_API_KEY });
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
    args: any;
    responsesItemId?: string;
  }>;
  tool_call_id?: string;
  id?: string;
  [key: string]: any;
}

/**
 * Convert generic tool schemas to OpenAI Responses API format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", name, description, parameters }]
 */
function convertToolsToResponsesAPI(tools?: ToolSchema[] | null): OpenAI.Responses.Tool[] | null {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((t: any): OpenAI.Responses.Tool => ({
    type: "function" as const,
    name: (t as any).name,
    description: (t as any).description || "",
    parameters: ((t as any).parameters as any) || {},
    strict: true,
  }));
}

/** Narrow any errors into ProviderError for all catch blocks. */
function toProviderError(error: any): never {
  let message = String(error);
  let status = 500;
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") {
      message = error.message;
    }
    if ("status" in error && typeof error.status === "number") {
      status = error.status;
    }
  }
  throw new ProviderError("openai", message, status, error);
}

interface ErrorRecord {
  message?: string;
  status?: number;
  [key: string]: any;
}

/** Narrow any catch to a typed error record for retry logic. */
function asErrorRecord(error: any): ErrorRecord {
  return error as ErrorRecord;
}
function prepareOpenAIMessages(messages: OpenAIMsg[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m: any): OpenAI.Chat.ChatCompletionMessageParam => {
    // Tool result messages — include tool_call_id for correlation
    if ((m as any).role === "tool") {
      return {
        role: "tool",
        tool_call_id: (m as any).tool_call_id || (m as any).id || "",
        content:
          typeof (m as any).content === "string"
            ? (m as any).content
            : JSON.stringify((m as any).content ?? ""),
      };
    }

    // Assistant messages with tool calls — include tool_calls in OpenAI format
    if ((m as any).role === "assistant") {
      if ((m as any).toolCalls && (m as any).toolCalls.length > 0) {
        return {
          role: "assistant",
          ...((m as any).name ? { name: (m as any).name } : {}),
          content: (m as any).content?.trim() || null,
          tool_calls: (m as any).toolCalls.map((tc: any, i: any) => ({
            id: (tc as any).id || `call_${i}`,
            type: "function" as const,
            function: {
              name: (tc as any).name,
              arguments:
                typeof (tc as any).args === "string"
                  ? (tc as any).args
                  : JSON.stringify((tc as any).args || {}),
            },
          })),
        };
      }
      return {
        role: "assistant",
        ...((m as any).name ? { name: (m as any).name } : {}),
        content: (m as any).content ?? "",
      };
    }

    if ((m as any).role === "system") {
      return {
        role: "system",
        ...((m as any).name ? { name: (m as any).name } : {}),
        content: (m as any).content ?? "",
      };
    }

    if ((m as any).role === "developer") {
      return {
        role: "developer",
        ...((m as any).name ? { name: (m as any).name } : {}),
        content: (m as any).content ?? "",
      };
    }

    // User messages (can be multimodal)
    if ((m as any).images && (m as any).images.length > 0) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const mediaRef of (m as any).images) {
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
            } as any as OpenAI.Chat.ChatCompletionContentPart);
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
            } as any as OpenAI.Chat.ChatCompletionContentPart);
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
            } as any as OpenAI.Chat.ChatCompletionContentPart);
          }
        } else {
          // Unknown ref type (e.g. minio://) — skip with warning
          logger.warn(
            `[openai] Skipping unresolved media ref in Chat Completions input: ${mediaRef.substring(0, 60)}...`,
          );
        }
      }
      if ((m as any).content) {
        content.push({ type: "text", text: (m as any).content });
      }
      return {
        role: "user",
        ...((m as any).name ? { name: (m as any).name } : {}),
        content,
      };
    }

    return {
      role: "user",
      ...((m as any).name ? { name: (m as any).name } : {}),
      content: (m as any).content ?? "",
    };
  });
}

/**
 * Convert messages to Responses API input format.
 * System messages become developer messages; images use input_image, PDFs use input_file.
 */
function prepareResponsesInput(messages: OpenAIMsg[]): OpenAI.Responses.ResponseInputItem[] {
  const result: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    // Assistant message with tool calls → expand into function_call items
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // If the assistant also produced text, include it first
      if (m.content?.trim()) {
        result.push({
          role: "assistant",
          content: m.content,
        } as OpenAI.Responses.ResponseInputItem);
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
        } as OpenAI.Responses.ResponseFunctionToolCall as any as OpenAI.Responses.ResponseInputItem);
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
      } as any as OpenAI.Responses.ResponseInputItem);
      continue;
    }

    // Standard message (system, user, assistant without tools)
    const role = m.role === "system" ? ("developer" as const) : (m.role as "developer" | "user" | "assistant");
    const nameObj = m.name ? { name: m.name } : {};

    if (m.images && m.images.length > 0) {
      const content: OpenAI.Responses.ResponseInputContent[] = [];
      for (const mediaRef of m.images) {
        const urlType = getUrlType(mediaRef);

        if (urlType === "data") {
          // Base64 data URL — use MIME type to route
          const mime = getDataUrlMimeType(mediaRef);
          if (mime && mime.startsWith("image/")) {
            content.push({ type: "input_image", image_url: mediaRef, detail: "auto" });
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
            content.push({ type: "input_image", image_url: mediaRef, detail: "auto" });
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
      result.push({
        role,
        ...nameObj,
        content,
      } as OpenAI.Responses.ResponseInputItem);
      continue;
    }
    // Responses API requires content to be a string or array, never null
    result.push({
      role,
      ...nameObj,
      content: m.content ?? "",
    } as OpenAI.Responses.ResponseInputItem);
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
        (logger.provider as any)(("OpenAI" as any), (`generateText model=${model}` as any));
    try {
      if (useResponsesAPI(model)) {
        return await this._generateTextResponses(messages, model, options);
      }
      return await this._generateTextChatCompletions(messages, model, options);
    } catch (error: unknown) {
      toProviderError(error);
    }
  },
  async _generateTextResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const input = prepareResponsesInput(messages);
    const payload: OpenAI.Responses.ResponseCreateParamsNonStreaming & {
      seed?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stop?: any;
    } = { model, input };

    // Reasoning
    const reasoning: Reasoning = {};
    if (options.reasoningEffort) {
      reasoning.effort = options.reasoningEffort as ReasoningEffort;
    }
    if (options.reasoningSummary) {
            // @ts-ignore - TODO: strict typing
            reasoning.summary = options.reasoningSummary as "auto" | "concise" | "detailed";
    }
    if (Object.keys(reasoning).length > 0) {
      payload.reasoning = reasoning;
    }

    // Text / verbosity
    const text: OpenAI.Responses.ResponseTextConfig = {};
    if (options.verbosity) {
      text.format = { type: "text" };
      text.verbosity = options.verbosity as "low" | "medium" | "high";
    }

    if (options.maxTokens) payload.max_output_tokens = options.maxTokens;

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed = typeof options.seed === "number" ? options.seed : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier = options.serviceTier as OpenAI.Responses.ResponseCreateParamsNonStreaming["service_tier"];
    }

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
      } as any as OpenAI.Responses.ResponseFormatTextJSONSchemaConfig;
    }
    if (Object.keys(text).length > 0) {
      payload.text = text;
    }

    // Temperature/topP only work with reasoning.effort=none
        // @ts-ignore - TODO: strict typing
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
      payload.tools = [{ type: "web_search" } as OpenAI.Responses.Tool];
    }

    // Custom function calling tools
        const customTools = convertToolsToResponsesAPI((options.tools as any as ToolSchema[] | null | undefined));
    if (customTools) {
      payload.tools = [...((payload.tools as OpenAI.Responses.Tool[]) || []), ...customTools];
    }

    const { data: response, response: rawResponse } = await getClient()
      .responses.create(payload)
      .withResponse();

    // Extract rate-limit headers
        const rateLimits = extractOpenAIRateLimits((rawResponse as any), (model as any));

    // Collect tool calls and images from output items
    const images: Array<{ type: string; data: string; mimeType: string }> = [];
    const toolCalls: Array<{ id: string; name: string; args: any }> = [];
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

    const result: any = {
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
  async _generateTextChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const modelDef = getModelByName(model);
    const isReasoning =
      (modelDef && "thinking" in modelDef && (modelDef as { thinking?: boolean }).thinking === true) || model.includes("o1") || model.includes("o3");
    const prepared = prepareOpenAIMessages(messages);
    const payload: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: prepared,
    };
    if (isReasoning) {
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
      if (options.reasoningEffort) {
        payload.reasoning_effort = options.reasoningEffort as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["reasoning_effort"];
      }
    } else {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop = options.stopSequences as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["stop"];
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    }

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed = typeof options.seed === "number" ? options.seed : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier = options.serviceTier as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming["service_tier"];
    }

    // Response format (JSON mode)
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    if (options.webSearch) {
      payload.tools = [{ type: "web_search" } as any as OpenAI.Chat.ChatCompletionTool];
    }

    // Custom function calling tools
        const customTools = convertToolsToOpenAI((options.tools as any)) as OpenAI.Chat.ChatCompletionTool[] | null;
    if (customTools) {
      payload.tools = [...((payload.tools as OpenAI.Chat.ChatCompletionTool[]) || []), ...customTools];
    }

    try {
      const { data: response, response: rawResponse } = await getClient()
        .chat.completions.create(payload)
        .withResponse();
            const rateLimits = extractOpenAIRateLimits((rawResponse as any), (model as any));
      const message = response.choices[0].message;
      const result: any = {
        text: message.content || "",
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
      if (message.tool_calls && message.tool_calls.length > 0) {
        result.toolCalls = message.tool_calls.map((tc: any) => {
          if ((tc as any).type === "function") {
            const fn = (tc as any).function;
            let args = {};
            try {
              args = JSON.parse((fn as any).arguments || "{}");
            } catch {
              /* ignore */
            }
            return {
              id: (tc as any).id,
              name: (fn as any).name || "",
              args,
            };
          }
          return {
            id: (tc as any).id,
            name: "",
            args: {},
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
        const payloadRecord = payload as any;
        for (const param of unsupportedParams) {
          if (
            err.message?.includes(`'${param}'`) &&
            payloadRecord[param] !== undefined
          ) {
            (logger.provider as any)(
                            ("OpenAI" as any),
              (`Stripping unsupported param '${param}' for ${model} and retrying` as any),
            );
            delete payloadRecord[param];
            stripped = true;
          }
        }
        if (stripped) {
          const response = await getClient().chat.completions.create(payload);
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
        (logger.provider as any)(("OpenAI" as any), (`generateTextStream model=${model}` as any));
    try {
      if (useResponsesAPI(model)) {
        yield* this._streamResponses(messages, model, options);
      } else {
        yield* this._streamChatCompletions(messages, model, options);
      }
    } catch (error: unknown) {
      if (error && typeof error === "object" && "name" in error && (error as Error).name === "AbortError") return;
      toProviderError(error);
    }
  },
  async *_streamResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const input = prepareResponsesInput(messages);
    const payload: OpenAI.Responses.ResponseCreateParamsStreaming & {
      seed?: number;
      frequency_penalty?: number;
      presence_penalty?: number;
      stop?: any;
    } = { model, input, stream: true };

    // Reasoning
    const reasoning: Reasoning = {};
    if (options.reasoningEffort) {
      reasoning.effort = options.reasoningEffort as ReasoningEffort;
    }
    if (options.reasoningSummary) {
            // @ts-ignore - TODO: strict typing
            reasoning.summary = options.reasoningSummary as "auto" | "concise" | "detailed";
    }
    if (Object.keys(reasoning).length > 0) {
      payload.reasoning = reasoning;
    }

    // Text / verbosity
    const text: OpenAI.Responses.ResponseTextConfig = {};
    if (options.verbosity) {
      text.format = { type: "text" };
      text.verbosity = options.verbosity as "low" | "medium" | "high";
    }

    if (options.maxTokens) payload.max_output_tokens = options.maxTokens;

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed = typeof options.seed === "number" ? options.seed : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier = options.serviceTier as OpenAI.Responses.ResponseCreateParamsStreaming["service_tier"];
    }

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
      } as any as OpenAI.Responses.ResponseFormatTextJSONSchemaConfig;
    }
    if (Object.keys(text).length > 0) {
      payload.text = text;
    }

    // Temperature/topP only work with reasoning.effort=none
        // @ts-ignore - TODO: strict typing
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
      payload.tools = [{ type: "web_search" } as OpenAI.Responses.Tool];
    }

    // Custom function calling tools
        const customTools = convertToolsToResponsesAPI((options.tools as any as ToolSchema[] | null | undefined));
    if (customTools) {
      payload.tools = [...((payload.tools as OpenAI.Responses.Tool[]) || []), ...customTools];
    }

    const { data: streamData, response: rawStreamResponse } = await getClient()
      .responses.create(payload, {
        ...(options.signal && { signal: options.signal }),
      })
      .withResponse();
        const rateLimits = extractOpenAIRateLimits((rawStreamResponse as any), (model as any));
    let usage = null;
    // Track function names from output_item.added events; the arguments.done
    // event may not include the name property (known OpenAI SDK issue).
    const pendingFunctions: Record<string, { name: string; callId: string; args: string }> = {};
    for await (const event of streamData) {
      if (options.signal?.aborted) break;
      // Text delta from output_text
      if (event.type === "response.output_text.delta") {
        const ev = event as OpenAI.Responses.ResponseTextDeltaEvent;
        yield ev.delta || "";
      }
      // Reasoning / thinking summary delta
      if (event.type === "response.reasoning_summary_text.delta") {
        const ev = event as OpenAI.Responses.ResponseReasoningSummaryTextDeltaEvent;
        yield { type: "thinking", content: ev.delta || "" };
      }
      // Image generation completed
      if (event.type === "response.image_generation_call.completed") {
        const ev = event as OpenAI.Responses.ResponseImageGenCallCompletedEvent & { result?: string };
        if (ev.result) {
          yield {
            type: "image",
            data: ev.result,
            mimeType: "image/png",
          };
        }
      }
      // Track function call metadata from output_item.added
      if (event.type === "response.output_item.added") {
        const ev = event as OpenAI.Responses.ResponseOutputItemAddedEvent;
        if (ev.item?.type === "function_call") {
          const item = ev.item as OpenAI.Responses.ResponseFunctionToolCall;
          if (item.id) {
            pendingFunctions[item.id] = {
              name: item.name,
              callId: item.call_id,
              args: "",
            };
          }
        }
      }
      // Accumulate argument deltas (keyed by item_id)
      if (event.type === "response.function_call_arguments.delta") {
        const ev = event as OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent;
        const entry = pendingFunctions[ev.item_id];
        const partial = ev.delta || "";
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
        const ev = event as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent & { call_id?: string };
        const tracked = pendingFunctions[ev.item_id];
        const name = tracked?.name || ev.name || "any";
        const callId = tracked?.callId || ev.call_id || ev.item_id;
        let args = {};
        try {
          args = JSON.parse(ev.arguments || tracked?.args || "{}");
        } catch {
          /* ignore */
        }
        yield {
          type: "toolCall",
          id: callId,
          // Responses API internal item ID (starts with "fc_")
          responsesItemId: ev.item_id,
          name,
          args,
        };
        // Clean up
        delete pendingFunctions[ev.item_id];
      }
      // Completed response — extract usage
      if (event.type === "response.completed") {
        const ev = event as OpenAI.Responses.ResponseCompletedEvent;
        if (ev.response?.usage) {
          usage = {
            inputTokens: ev.response.usage.input_tokens ?? 0,
            outputTokens: ev.response.usage.output_tokens ?? 0,
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
  async *_streamChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions) {
    const modelDef = getModelByName(model);
    const isReasoning =
      (modelDef && "thinking" in modelDef && (modelDef as { thinking?: boolean }).thinking === true) || model.includes("o1") || model.includes("o3");
    const prepared = prepareOpenAIMessages(messages);
    const payload: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: prepared,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (isReasoning) {
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
      if (options.reasoningEffort) {
        payload.reasoning_effort = options.reasoningEffort as OpenAI.Chat.ChatCompletionCreateParamsStreaming["reasoning_effort"];
      }
    } else {
      if (options.temperature !== undefined)
        payload.temperature = options.temperature;
      if (options.topP !== undefined) payload.top_p = options.topP;
      if (options.frequencyPenalty !== undefined)
        payload.frequency_penalty = options.frequencyPenalty;
      if (options.presencePenalty !== undefined)
        payload.presence_penalty = options.presencePenalty;
      if (options.stopSequences !== undefined)
        payload.stop = options.stopSequences as OpenAI.Chat.ChatCompletionCreateParamsStreaming["stop"];
      if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
    }

    // Seed for reproducibility
    if (options.seed !== undefined) {
      payload.seed = typeof options.seed === "number" ? options.seed : parseInt(String(options.seed), 10);
    }

    // Service tier: auto / default / priority
    if (options.serviceTier) {
      payload.service_tier = options.serviceTier as OpenAI.Chat.ChatCompletionCreateParamsStreaming["service_tier"];
    }

    // Response format (JSON mode)
    if (options.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }

    if (options.webSearch) {
      payload.tools = [{ type: "web_search" } as any as OpenAI.Chat.ChatCompletionTool];
    }

    // Custom function calling tools
        const customTools = convertToolsToOpenAI((options.tools as any)) as OpenAI.Chat.ChatCompletionTool[] | null;
    if (customTools) {
      payload.tools = [...((payload.tools as OpenAI.Chat.ChatCompletionTool[]) || []), ...customTools];
    }

    let stream: Stream<OpenAI.Chat.ChatCompletionChunk>;
    let rateLimits = null;
    try {
      const { data: streamData, response: rawStreamResponse } =
        await getClient()
          .chat.completions.create(payload, {
            ...(options.signal && { signal: options.signal }),
          })
          .withResponse();
      stream = streamData;
            rateLimits = extractOpenAIRateLimits((rawStreamResponse as any), (model as any));
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
        const payloadRecord = payload as any;
        for (const param of unsupportedParams) {
          if (
            err.message?.includes(`'${param}'`) &&
            payloadRecord[param] !== undefined
          ) {
            (logger.provider as any)(
                            ("OpenAI" as any),
              (`Stripping unsupported param '${param}' for ${model} and retrying (stream)` as any),
            );
            delete payloadRecord[param];
            stripped = true;
          }
        }
        if (stripped) {
          const retryResult = await getClient()
            .chat.completions.create(payload, {
              ...(options.signal && { signal: options.signal }),
            })
            .withResponse();
          stream = retryResult.data;
                    rateLimits = extractOpenAIRateLimits((retryResult.response as any), (model as any));
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

    for await (const chunk of stream) {
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
        for (const tc of delta.tool_calls) {
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
        for (const tc of Object.values(pendingToolCalls)) {
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
        (logger.provider as any)(("OpenAI" as any), (`generateSpeech voice=${voice}` as any));
    try {
      const payload: OpenAI.Audio.SpeechCreateParams & { instructions?: string } = {
        model:
          options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).openai,
        voice: voice as OpenAI.Audio.SpeechCreateParams["voice"],
        input: text,
        response_format: (options.format as "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm") || "mp3",
      };
      if (options.instructions) {
        payload.instructions = options.instructions;
      }
      const response = await getClient().audio.speech.create(payload);
      return { stream: response.body, contentType: "audio/mpeg" };
    } catch (error: unknown) {
      toProviderError(error);
    }
  },

  async generateImage(prompt: string, images: Array<string | { imageData: string; mimeType?: string }> = [], model: string = "gpt-image-1.5") {
    (logger.provider as any)(
            ("OpenAI" as any),
      (`generateImage model=${model} images=${images.length}` as any),
    );
    try {
      let response: OpenAI.Images.ImagesResponse;

      if (images.length > 0) {
        // Use the edit endpoint when input images are provided
        // Take the last image in conversation as the one to edit
        const lastImage = images[images.length - 1];
        let imageBuffer: Buffer, mimeType: string;

        if (typeof lastImage === "string") {
          // Data URL format: data:image/png;base64,...
          const base64Match = lastImage.match(/^data:([^;]+);base64,(.+)$/);
          if (!base64Match) {
            throw new Error("Invalid image data format");
          }
          imageBuffer = Buffer.from(base64Match[2], "base64");
          mimeType = base64Match[1];
        } else if (lastImage && typeof lastImage === "object" && "imageData" in lastImage) {
          // Object format: { imageData: base64, mimeType }
          imageBuffer = Buffer.from(lastImage.imageData, "base64");
          mimeType = lastImage.mimeType || "image/png";
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
                    // @ts-ignore - TODO: strict typing
                    output_format: "png" as "url" | "b64_json",
          size: "1024x1024",
          quality: "high",
        });
      }

      const firstImage = response.data?.[0];
      const imageData = firstImage?.b64_json || (firstImage as any)?.b64 || (response as any)?.b64;
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
        (logger.provider as any)(("OpenAI" as any), (`captionImage model=${model}` as any));
    try {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [
        { type: "text" as const, text: prompt },
        ...images.map((image: string): OpenAI.Chat.ChatCompletionContentPartImage => ({
          type: "image_url" as const,
          image_url: { url: image },
        })),
      ];
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
      if (systemPrompt) {
        messages.push({ role: "system" as const, content: systemPrompt });
      }
      messages.push({ role: "user" as const, content });
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
        (logger.provider as any)(("OpenAI" as any), (`generateEmbedding model=${model}` as any));
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
        (logger.provider as any)(("OpenAI" as any), (`transcribeAudio model=${model}` as any));
    try {
      const subType = mimeType.split("/")[1] || "wav";
      const ext = ["wav", "mp3", "opus", "aac", "flac", "pcm"].includes(subType)
        ? (subType as "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm")
        : "wav";
      const file = await toFile(audioBuffer, `audio.${ext}`, {
        type: mimeType,
      });
      const payload: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming = {
        file,
        model,
      };
      if (options.language) payload.language = options.language;
      if (options.prompt) payload.prompt = options.prompt as string;

      const response = await getClient().audio.transcriptions.create(payload);
      const usage: Record<string, number> = {};
      const responseUsage = response.usage;
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

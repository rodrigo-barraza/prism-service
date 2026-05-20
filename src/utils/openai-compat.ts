// ─────────────────────────────────────────────────────────────
// OpenAI-Compatible Provider Utilities
// ─────────────────────────────────────────────────────────────
// Shared helpers for providers that use the OpenAI Chat Completions
// API format: lm-studio, vllm, llama-cpp, and openai itself.

import { getDataUrlMimeType } from "./media.ts";
import { ThinkTagParser, extractThinkTags } from "./ThinkTagParser.ts";

// ── Tool Conversion ─────────────────────────────────────────

/**
 * Convert generic tool schemas to OpenAI Chat Completions format.
 * Input:  [{ name, description, parameters }]
 * Output: [{ type: "function", function: { name, description, parameters } }]
 */
export function convertToolsToOpenAI(tools: Record<string, unknown>) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map((t: Record<string, unknown>) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.parameters || {},
    },
  }));
}

// ── Payload Parameter Building ──────────────────────────────

/**
 * Build the common sampling/generation parameters for an
 * OpenAI-compatible Chat Completions payload.
 *
 * Returns a plain object with only the non-undefined fields set.
 *


 * @returns {object} Payload fields to spread into the request body
 */
export function buildPayloadParams(
  options: Record<string, unknown>,
  { temperature = 0.7, maxTokens = -1 }: Record<string, unknown> = {},
) {
  return {
    temperature:
      options.temperature !== undefined ? options.temperature : temperature,
    top_p: options.topP !== undefined ? options.topP : undefined,
    frequency_penalty:
      options.frequencyPenalty !== undefined
        ? options.frequencyPenalty
        : undefined,
    presence_penalty:
      options.presencePenalty !== undefined
        ? options.presencePenalty
        : undefined,
    stop:
      options.stopSequences !== undefined ? options.stopSequences : undefined,
    max_tokens: options.maxTokens || maxTokens,
    // Reproducibility seed — supported by OpenAI-compat servers (vLLM, LM Studio, llama.cpp)
    ...(options.seed !== undefined &&
      options.seed !== "" && { seed: Number(options.seed) }),
  };
}

// ── Tool Call Extraction ────────────────────────────────────

/**
 * Extract tool calls from a non-streaming OpenAI-compatible message object.
 * Handles both nested OpenAI format ({ function: { name, arguments } })
 * and flat llama.cpp format ({ name, arguments }).
 *

 * @returns {Array|null} Array of { id, name, args } or null if no tool calls
 */
export function extractToolCallsFromMessage(message: string) {
  // @ts-ignore - TODO: strict typing
  if (!message?.tool_calls || message.tool_calls.length === 0) return null;

  // @ts-ignore - TODO: strict typing
  return message.tool_calls.map((tc: Record<string, unknown>) => {
    // @ts-ignore - TODO: strict typing
    const fnName = tc.function?.name || tc.name || "";
    // @ts-ignore - TODO: strict typing
    const fnArgs = tc.function?.arguments || tc.arguments || "{}";
    let args = {};
    try {
      args = JSON.parse(fnArgs);
    } catch {
      /* ignore */
    }
    return {
      id: tc.id,
      name: fnName,
      args,
    };
  });
}

// ── Usage Normalization ─────────────────────────────────────

/**
 * Build a normalized usage object from OpenAI-compatible usage data.
 * Extracts extended token details when available:
 *   - prompt_tokens_details.cached_tokens  → cacheReadInputTokens
 *   - completion_tokens_details.reasoning_tokens → reasoningOutputTokens
 *
 * The cache field uses the same key as Anthropic (cacheReadInputTokens) so
 * CostCalculator, RequestLogger, and console logging handle it uniformly.
 *

 * @returns {{ inputTokens: number, outputTokens: number, cacheReadInputTokens?: number, reasoningOutputTokens?: number }}
 */
export function normalizeUsage(rawUsage: Record<string, unknown>) {
  const usage = {
    inputTokens: rawUsage?.prompt_tokens ?? 0,
    outputTokens: rawUsage?.completion_tokens ?? 0,
  };

  // KV cache hits — reported by LM Studio and OpenAI
  // @ts-ignore - TODO: strict typing
  const cachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens;
  if (cachedTokens > 0) {
    // @ts-ignore
    usage.cacheReadInputTokens = cachedTokens;
    // Adjust inputTokens to reflect only the non-cached portion,
    // mirroring Anthropic's convention where inputTokens excludes cache hits
    // @ts-ignore - TODO: strict typing
    usage.inputTokens = Math.max(0, usage.inputTokens - cachedTokens);
  }

  // Reasoning token breakdown
  // @ts-ignore - TODO: strict typing
  const reasoningTokens = rawUsage?.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens > 0) {
    // @ts-ignore
    usage.reasoningOutputTokens = reasoningTokens;
  }

  return usage;
}

/**
 * The default empty usage object, used when no usage data is available.
 */
export const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 };

// ── Message Preparation ─────────────────────────────────────

/**
 * Media handling strategies for prepareOpenAICompatMessages.
 * Controls how non-image media types are handled by different providers.
 */
export const MEDIA_STRATEGIES = {
  /** vLLM: supports video_url and input_audio natively */
  FULL_MULTIMODAL: "full_multimodal",
  /** llama-cpp: falls back to text descriptions for audio/video */
  TEXT_FALLBACK: "text_fallback",
  /** lm-studio: images only, ignore other media types */
  IMAGES_ONLY: "images_only",
};

/**
 * Pre-process messages to expand video attachments into image frames.
 *
 * For providers that don't support raw video data URLs (e.g. LM Studio),
 * this extracts frames from each video using ffmpeg and adds them to the
 * message's `images` array. The original `video` array is removed so
 * downstream processing never sees it.
 *
 * Call this BEFORE prepareOpenAICompatMessages() for providers that need
 * video-as-frames support.
 *


 * @returns {Promise<Array>} The same messages array with videos expanded
 */
export async function expandVideoToFrames(messages: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const { extractVideoFrames, getDataUrlMimeType } = await import("./media.js");

  // @ts-ignore
  for ( const message of messages) {
    // Collect video data URLs from both `video` and `images` arrays.
    // The frontend may place video files in `images` if it doesn't
    // categorize by MIME type (backwards compatibility).
    const videoUrls: Record<string, unknown>[] = [];
    const keptImages: Record<string, unknown>[] = [];

    // Check explicit video field
    if (message.video && Array.isArray(message.video)) {
      videoUrls.push(...message.video);
      delete message.video;
    }

    // Check images field for misclassified video data URLs
    if (message.images && Array.isArray(message.images)) {
      // @ts-ignore
      for ( const dataUrl of message.images) {
        const mime = getDataUrlMimeType(dataUrl);
        if (mime && mime.startsWith("video/")) {
          videoUrls.push(dataUrl);
        } else {
          keptImages.push(dataUrl);
        }
      }
      message.images = keptImages;
    }

    if (videoUrls.length === 0) continue;

    const allFrames: Record<string, unknown>[] = [];
    // @ts-ignore
    for ( const videoDataUrl of videoUrls) {
      // @ts-ignore - TODO: strict typing
      const frames = await extractVideoFrames(videoDataUrl, options);
      // @ts-ignore - TODO: strict typing
      allFrames.push(...frames);
    }

    if (allFrames.length > 0) {
      // Prepend frames to images array (model card recommends media before text)
      message.images = [...allFrames, ...(message.images || [])];
    }
  }

  return messages;
}

/**
 * Convert messages with media to OpenAI-compatible multipart content format.
 * Handles images, tool results, assistant tool calls, and optionally
 * audio/video/PDF based on the media strategy.
 *


 * @returns {Array} OpenAI-compatible messages
 */
export function prepareOpenAICompatMessages(
  messages: Record<string, unknown>,
  { mediaStrategy = MEDIA_STRATEGIES.IMAGES_ONLY }: Record<string, unknown> = {},
) {
  // @ts-ignore - TODO: strict typing
  return messages.map((m: Record<string, unknown>) => {
    const base = { role: m.role };
    // @ts-ignore
    if (m.name) base.name = m.name;

    // Tool result messages — include tool_call_id for correlation
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id || m.id || "",
        content:
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      };
    }

    // Assistant messages with tool calls — include tool_calls in OpenAI format
    // @ts-ignore - TODO: strict typing
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        ...base,
        // Per OpenAI spec, content must be null when tool_calls are present
        // @ts-ignore - TODO: strict typing
        content: m.content?.trim() || null,
        // @ts-ignore - TODO: strict typing
        tool_calls: m.toolCalls.map((tc: Record<string, unknown>, i: Record<string, unknown>) => ({
          id: tc.id || `call_${i}`,
          type: "function",
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

    // Collect media content based on strategy
    const content: string[] = [];

    if (mediaStrategy === MEDIA_STRATEGIES.IMAGES_ONLY) {
      // Simple image-only handling (lm-studio)
      // @ts-ignore - TODO: strict typing
      if (m.images && m.images.length > 0) {
        // @ts-ignore
        for ( const dataUrl of m.images) {
          // @ts-ignore - TODO: strict typing
          content.push({ type: "image_url", image_url: { url: dataUrl } });
        }
      }
    } else {
      // Full media handling (vllm, llama-cpp)
      // @ts-ignore
      for ( const field of ["images", "audio", "video", "pdf"]) {
        const array = m[field];
        if (!array || !Array.isArray(array) || array.length === 0) continue;

        // @ts-ignore
        for ( const dataUrl of array) {
          const mime = getDataUrlMimeType(dataUrl);

          if (mime && mime.startsWith("image/")) {
            // @ts-ignore - TODO: strict typing
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          } else if (mime && mime.startsWith("video/")) {
            if (mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL) {
              // @ts-ignore - TODO: strict typing
              content.push({ type: "video_url", video_url: { url: dataUrl } });
            } else {
              // @ts-ignore - TODO: strict typing
              content.push({
                type: "text",
                text: "[Attached video file — video input not supported by this model]",
              });
            }
          } else if (mime && mime.startsWith("audio/")) {
            if (mediaStrategy === MEDIA_STRATEGIES.FULL_MULTIMODAL) {
              const base64Data = dataUrl.split(";base64,")[1] || "";
              const audioFormat = mime.split("/")[1] || "wav";
              // @ts-ignore - TODO: strict typing
              content.push({
                type: "input_audio",
                input_audio: { data: base64Data, format: audioFormat },
              });
            } else {
              // @ts-ignore - TODO: strict typing
              content.push({
                type: "text",
                text: "[Attached audio file — audio input not supported by this model]",
              });
            }
          } else if (mime === "application/pdf") {
            // @ts-ignore - TODO: strict typing
            content.push({
              type: "text",
              text: "[Attached PDF document — PDF input not supported by this model]",
            });
          } else if (
            mime &&
            (mime.startsWith("text/") || mime === "application/json")
          ) {
            try {
              const base64 = dataUrl.split(";base64,")[1];
              const decoded = Buffer.from(base64, "base64").toString("utf-8");
              // @ts-ignore - TODO: strict typing
              content.push({
                type: "text",
                text: `[Attached file (${mime})]:\n${decoded}`,
              });
            } catch {
              // @ts-ignore - TODO: strict typing
              content.push({
                type: "text",
                text: `[Attached file (${mime}): unable to decode]`,
              });
            }
          } else {
            // Fallback — try image_url passthrough for unknown types
            // @ts-ignore - TODO: strict typing
            content.push({ type: "image_url", image_url: { url: dataUrl } });
          }
        }
      }
    }

    if (content.length > 0) {
      if (m.content) {
        // @ts-ignore - TODO: strict typing
        content.push({ type: "text", text: m.content });
      }
      return { ...base, content };
    }

    return { ...base, content: m.content ?? "" };
  });
}

// ── Non-Streaming Response Processing ───────────────────────

/**
 * Process a non-streaming OpenAI-compatible chat completion response.
 * Extracts text, thinking (native + <think> tags), usage, and tool calls.
 *
 * When thinkingEnabled is false, thinking content is folded into the text
 * output and the `thinking` field is null.
 *


 * @returns {{ text: string, thinking: string|null, usage: object, toolCalls: Array|null }}
 */
export function processNonStreamingResponse(data: Record<string, unknown>, options: Record<string, unknown> = {}) {
  // @ts-ignore - TODO: strict typing
  const message = data.choices?.[0]?.message;
  const rawText = message?.content || "";

  // When thinking is disabled, return raw text without parsing <think> tags
  // @ts-ignore
  if (options.thinkingEnabled === false) {
    // @ts-ignore - TODO: strict typing
    const usage = normalizeUsage(data.usage);
    const toolCalls = extractToolCallsFromMessage(message);
    return { text: rawText, thinking: null, usage, toolCalls };
  }

  // Check native reasoning fields first, fall back to <think> tag parsing
  const nativeThinking = message?.reasoning_content || message?.reasoning || null;
  const { thinking: tagThinking, text } = extractThinkTags(rawText);
  const thinking = nativeThinking || tagThinking;

  // @ts-ignore - TODO: strict typing
  const usage = normalizeUsage(data.usage);
  const toolCalls = extractToolCallsFromMessage(message);

  return { text, thinking, usage, toolCalls };
}

// ── SSE Stream Parsing ──────────────────────────────────────

/**
 * Parse an SSE stream from an OpenAI-compatible /v1/chat/completions endpoint.
 * Yields the same event types as the provider generateTextStream methods:
 *   - string (text content)
 *   - { type: "thinking", content } (reasoning content)
 *   - { type: "toolCall", id, name, args }
 *   - { type: "usage", usage }
 *
 * When thinkingEnabled is false, all thinking content (native reasoning_content
 * and <think> tag content) is yielded as plain text strings instead of
 * { type: "thinking" } events.
 *


 */
export async function* parseSSEStream(reader: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  // @ts-ignore
  const suppressThinking = options.thinkingEnabled === false;
  // Skip ThinkTagParser entirely when thinking is disabled — no overhead
  const thinkParser = suppressThinking ? null : new ThinkTagParser();
  const pendingToolCalls = {};

  try {
    while (true) {
      // @ts-ignore
      if (options.signal?.aborted) {
        // @ts-ignore - TODO: strict typing
        reader.cancel();
        break;
      }
      // @ts-ignore - TODO: strict typing
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // @ts-ignore
      buffer = lines.pop(); // keep incomplete line in buffer

      // @ts-ignore
      for ( const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // skip empty lines / comments
        if (trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));

          // Extract usage if present (some servers send it on the last chunk)
          if (json.usage) {
            usage = normalizeUsage(json.usage);
            // Let provider handle extensions (e.g. llama.cpp timings)
            // @ts-ignore
            if (options.onUsage) options.onUsage(json, usage);
          }

          // Let provider handle custom fields
          // @ts-ignore
          if (options.onChunkJson) options.onChunkJson(json);

          const delta = json.choices?.[0]?.delta;

          // Native reasoning fields (Qwen3.5, DeepSeek, etc.)
          const reasoning = delta?.reasoning_content || delta?.reasoning || "";
          if (reasoning) {
            if (suppressThinking) {
              yield reasoning; // Emit as plain text
            } else {
              yield { type: "thinking", content: reasoning };
            }
          }

          const content = delta?.content || "";
          if (content) {
            if (suppressThinking) {
              // Pass through raw content without <think> tag parsing
              yield content;
            } else {
              // Parse <think> tags from the streamed content
              // @ts-ignore
              const parts = thinkParser.feed(content);
              // @ts-ignore
              for ( const part of parts) {
                if (part.type === "thinking") {
                  yield { type: "thinking", content: part.content };
                } else {
                  yield part.content;
                }
              }
            }
          }

          // Accumulate tool call deltas and yield progress events so
          // consumers (AgenticLoopService) can track generation throughput
          // during tool call argument streaming.
          if (delta?.tool_calls) {
            let deltaChars = 0;
            // @ts-ignore
            for ( const tc of delta.tool_calls) {
              const index = tc.index;
              // @ts-ignore
              if (!pendingToolCalls[index]) {
                // @ts-ignore
                pendingToolCalls[index] = {
                  id: tc.id || "",
                  name: tc.function?.name || tc.name || "",
                  args: "",
                };
              }
              // @ts-ignore
              if (tc.id) pendingToolCalls[index].id = tc.id;
              const chunkName = tc.function?.name || tc.name;
              // @ts-ignore
              if (chunkName) pendingToolCalls[index].name = chunkName;
              const chunkArgs = tc.function?.arguments || tc.arguments;
              if (chunkArgs) {
                // @ts-ignore
                pendingToolCalls[index].args += chunkArgs;
                deltaChars += chunkArgs.length;
              }
            }
            // Yield a lightweight progress event so the generation tracker
            // sees continuous output during tool call JSON streaming.
            if (deltaChars > 0) {
              yield { type: "toolCallDelta", characters: deltaChars };
            }
          }

          // If finish_reason indicates tool calls, yield accumulated tool calls
          const finishReason = json.choices?.[0]?.finish_reason;
          if (finishReason === "tool_calls" || finishReason === "tool") {
            // @ts-ignore
            for ( const tc of Object.values(pendingToolCalls)) {
              let args = {};
              try {
                // @ts-ignore
                args = JSON.parse(tc.args || "{}");
              } catch {
                /* ignore */
              }
              yield {
                type: "toolCall",
                // @ts-ignore
                id: tc.id,
                // @ts-ignore
                name: tc.name,
                args,
              };
            }
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    // Flush any remaining buffered content from the think parser
    if (thinkParser) {
      const remaining = thinkParser.flush();
      // @ts-ignore
      for ( const part of remaining) {
        if (part.type === "thinking") {
          yield { type: "thinking", content: part.content };
        } else {
          yield part.content;
        }
      }
    }

    // Yield final usage
    if (usage) {
      yield { type: "usage", usage };
    } else {
      yield { type: "usage", usage: EMPTY_USAGE };
    }
  } finally {
    // Ensure reader is released
  }
}

// ── Fetch + Error Handling ──────────────────────────────────

/**
 * Make a fetch request to an OpenAI-compatible endpoint and handle
 * error responses consistently.
 *


 * @returns {Promise<Response>} The fetch response (guaranteed to be ok)
 * @throws {Error} With a parsed error message from the API
 */
export async function fetchOpenAICompat(url: string, payload: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // @ts-ignore
    ...(options.signal && { signal: options.signal }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMsg = `API error: ${response.status} ${errorText}`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed?.error?.message) errorMsg = parsed.error.message;
      else if (parsed?.message) errorMsg = parsed.message;
    } catch {
      /* raw text fallback */
    }
    throw new Error(errorMsg);
  }

  return response;
}

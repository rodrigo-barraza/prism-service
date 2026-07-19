import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "#src/utils/errors";
import logger from "#src/utils/logger";
import { extractAnthropicRateLimits } from "#src/utils/rateLimits";
import {
  compressImageForSizeLimit,
  extractVideoFramesCached,
  getMaxImageDimensionForModel,
  normalizeImageFormatForProvider,
} from "#src/utils/media";
import { getDocumentContextText } from "#src/utils/documentContext";
import AnthropicFileCacheService, {
  ANTHROPIC_FILES_API_BETA,
  type FileSourceApplication,
} from "#src/services/AnthropicFileCacheService";
import { EMPTY_USAGE } from "#src/providers/openai-compat";
import { ANTHROPIC_API_KEY } from "#config";
import { MODALITY_TYPES, getDefaultModels, getModelByName } from "#src/config";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "#src/constants/TokenBudgetDefaults";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { callWithRetries } from "#src/utils/ProviderStreamResilience";

import { ProviderOptions, ChatMessage } from "#src/types/ProviderTypes";
import type { TokenUsage } from "#src/types/admin";

export interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  citations?: Array<{
    type: string;
    url?: string;
    title?: string;
    cited_text?: string;
  }>;
  url?: string;
  title?: string;
  page_age?: string;
}

/** Typed shape for errors thrown by the Anthropic SDK. */
interface AnthropicSdkError extends Error {
  status?: number;
  type?: string;
  error?: { type?: string };
}

/** Result shape returned by generateText/captionImage. */
export interface AnthropicGenerateResult {
  text: string;
  usage: TokenUsage;
  thinking?: string | null;
  thinkingSignature?: string | null;
  citations?: Array<{ url?: string; title?: string; citedText?: string }>;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
  }>;
  rateLimits?: ReturnType<typeof extractAnthropicRateLimits>;
  stopReason?: string;
  stopDetails?: Record<string, unknown>;
}

export type TransformedStreamEvent =
  | string
  | { type: "toolCallStart"; id: string; name: string }
  | { type: "codeExecutionResult"; output: string; outcome: string }
  | { type: "webSearchResult"; results: Array<{ url?: string; title?: string; pageAge?: string }> }
  | { type: "executableCode"; code: string; language: string }
  | { type: "toolCall"; id: string | null; name: string | null; args: Record<string, unknown>; argsParseError?: boolean; rawArgs?: string }
  | { type: "thinking"; content: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "toolCallDelta"; characters: number }
  | { type: "stopReason"; stopReason: string }
  | { type: "stopDetails"; stopDetails: unknown }
  | { type: "usage"; usage: TokenUsage }
  | { type: "rateLimits"; rateLimits: ReturnType<typeof extractAnthropicRateLimits> };

// Default budget tokens mapped from effort level (for non-adaptive models)
const EFFORT_BUDGET_MAP: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 50000,
  xhigh: 100000,
  max: 128000,
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!ANTHROPIC_API_KEY) {
      throw new ProviderError("anthropic", "ANTHROPIC_API_KEY is not set", 401);
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Walk all Anthropic-format message content blocks and compress any
 * base64 image that exceeds 5 MB. Mutates the messages array in-place.
 */
async function enforceImageSizeLimits(
  messages: ChatMessage[],
  maxDimension?: number,
) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as AnthropicBlock[]) {
      if (block.type !== "image" || block.source?.type !== "base64") continue;
      const data = block.source.data;
      if (!data) continue;

      // Enforce byte-size limit
      const size = data.length; // Anthropic checks base64 STRING length
      if (size <= MAX_IMAGE_BYTES) continue;

      logger.warn(
        `[anthropic] SAFETY NET: image still ${(size / 1024 / 1024).toFixed(2)} MB after prepareMessages. Compressing now...`,
      );
      const result = await compressImageForSizeLimit(
        data,
        block.source.media_type || "image/png",
        undefined,
        maxDimension,
      );
      block.source.data = result.data;
      block.source.media_type = result.mediaType;

      const newSize = result.data.length;
      logger.info(
        `[anthropic] SAFETY NET compressed: ${(size / 1024 / 1024).toFixed(2)} → ${(newSize / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  }
}

/**
 * Whether the model natively accepts `role: "system"` messages mid-conversation.
 *
 * Per Anthropic's docs (verified 2026-07): Claude Opus 4.8 only — no beta
 * header required. All other Claude models return a 400
 * ("role 'system' is not supported on this model"). Matched with includes()
 * so provider-prefixed IDs (e.g. Bedrock's "anthropic.claude-opus-4-8")
 * are also recognized.
 */
export function supportsMidConversationSystemMessages(model?: string): boolean {
  return !!model && model.includes("claude-opus-4-8");
}

/**
 * Convert one attachment reference into Anthropic content blocks,
 * routed by MIME type. NOTHING is dropped silently: media the model
 * cannot perceive natively (audio, unresolved refs, failed video
 * extraction) becomes a visible text placeholder that also points the
 * model at the tool-side "attached" escape hatch.
 */
async function buildMediaBlocksForReference(
  reference: string,
  maxDimension: number,
): Promise<AnthropicBlock[]> {
  const match = reference.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    // Non-data references. HTTP(S) image URLs are supported natively via
    // url sources; anything else (e.g. an unresolved minio:// ref) gets a
    // visible placeholder instead of a silent drop.
    if (reference.startsWith("http://") || reference.startsWith("https://")) {
      return [{ type: "image", source: { type: "url", url: reference } }];
    }
    return [
      {
        type: "text",
        text: `[Attached file (unresolved reference "${reference.substring(0, 80)}") — content unavailable to this model]`,
      },
    ];
  }

  let mimeType = match[1];
  let data = match[2];

  // Normalize provider-hostile formats (HEIC/HEIF → JPEG, SVG → PNG) —
  // safety belt for references that bypassed MediaResolutionService.
  // text/plain results are visible conversion fallbacks: emit them as
  // text blocks, never as broken image blocks.
  if (
    mimeType.startsWith("image/") ||
    mimeType === "application/octet-stream"
  ) {
    try {
      const normalized = await normalizeImageFormatForProvider(
        data,
        mimeType,
        maxDimension,
      );
      if (normalized.converted) {
        if (normalized.mediaType === "text/plain") {
          return [
            {
              type: "text",
              text: Buffer.from(normalized.data, "base64").toString("utf-8"),
            },
          ];
        }
        data = normalized.data;
        mimeType = normalized.mediaType;
      }
    } catch (error: unknown) {
      logger.warn(
        `[anthropic] Image format normalization failed: ${getErrorMessage(error)} — continuing with original data`,
      );
    }
  }

  if (mimeType.startsWith("image/")) {
    // Image content block
    let mediaType = mimeType;
    if (data.startsWith("/9j/")) mediaType = "image/jpeg";
    else if (data.startsWith("iVBOR")) mediaType = "image/png";
    else if (data.startsWith("R0lG")) mediaType = "image/gif";
    else if (data.startsWith("UklG")) mediaType = "image/webp";

    // Enforce Anthropic's 5 MB per-image limit
    logger.info(
      `[anthropic] Image block: ${mediaType}, b64_len=${data.length} (${(data.length / 1024 / 1024).toFixed(2)} MB), decoded=${(Buffer.byteLength(data, "base64") / 1024 / 1024).toFixed(2)} MB`,
    );
    const compressed = await compressImageForSizeLimit(
      data,
      mediaType,
      undefined,
      maxDimension,
    );
    data = compressed.data;
    mediaType = compressed.mediaType;

    return [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      },
    ];
  }

  if (mimeType === "application/pdf") {
    // PDF document content block
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      },
    ];
  }

  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    // Text-based files — decode and inline as text
    try {
      const decoded = Buffer.from(data, "base64").toString("utf-8");
      return [
        { type: "text", text: `[Attached file (${mimeType})]:\n${decoded}` },
      ];
    } catch {
      return [
        {
          type: "text",
          text: `[Attached file (${mimeType}): unable to decode]`,
        },
      ];
    }
  }

  if (mimeType.startsWith("audio/")) {
    // Anthropic models cannot hear audio — visible placeholder, never silent
    return [
      {
        type: "text",
        text: `[Attached audio file (${mimeType}) — this model cannot hear audio directly. Audio tools (e.g. transcribe_audio) can access it via their "attached" input.]`,
      },
    ];
  }

  if (mimeType.startsWith("video/")) {
    // Expand into sampled frames (cache-stable across turns); if ffmpeg is
    // unavailable or extraction fails, fall back to a text placeholder.
    try {
      const frames = await extractVideoFramesCached(reference);
      const blocks: AnthropicBlock[] = [
        {
          type: "text",
          text: `[Attached video (${mimeType}) — showing ${frames.length} sampled frame${frames.length === 1 ? "" : "s"} at 1fps; video tools can access the full file via "attached"]`,
        },
      ];
      for (const frameDataUrl of frames) {
        const frameMatch = frameDataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!frameMatch) continue;
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: frameMatch[1],
            data: frameMatch[2],
          },
        });
      }
      return blocks;
    } catch (error: unknown) {
      logger.warn(
        `[anthropic] Video frame extraction failed: ${getErrorMessage(error)} — inserting placeholder`,
      );
      return [
        {
          type: "text",
          text: `[Attached video file (${mimeType}) — this model cannot watch video directly and frame extraction is unavailable. Video tools can access it via their "attached" input.]`,
        },
      ];
    }
  }

  // Unknown MIME type — visible placeholder, never silent
  return [
    {
      type: "text",
      text: `[Attached file (${mimeType}) — this file type is not directly readable by this model. Tools may access it via their "attached" input.]`,
    },
  ];
}

/** Merge consecutive same-role messages into a single turn. */
function mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
  return messages.reduce((acc: ChatMessage[], current: ChatMessage) => {
    if (acc.length && acc[acc.length - 1].role === current.role) {
      const previous = acc[acc.length - 1];
      // Handle merging when content might be string or array
      if (
        typeof previous.content === "string" &&
        typeof current.content === "string"
      ) {
        previous.content += `\n\n${current.content}`;
      } else {
        // Convert both to arrays and concat
        const previousBlocks =
          typeof previous.content === "string"
            ? [{ type: "text", text: previous.content }]
            : previous.content || [];
        const currentBlocks =
          typeof current.content === "string"
            ? [{ type: "text", text: current.content }]
            : current.content || [];
        previous.content = [...previousBlocks, ...currentBlocks];
      }
    } else {
      acc.push({ ...current });
    }
    return acc;
  }, []);
}

/**
 * Anthropic requires alternating user/assistant roles and handles system messages separately.
 * This helper extracts the system message and merges consecutive same-role messages.
 *
 * Pass `model` so mid-conversation system messages can be kept as
 * `role: "system"` on models that support them (Opus 4.8) instead of being
 * demoted to user role.
 */
export async function prepareMessages(messages: ChatMessage[], model?: string) {
  let systemMessage: string | undefined;
  const keepSystemRole = supportsMidConversationSystemMessages(model);
  // High-res Anthropic vision models accept a 2576px long edge; everything
  // else keeps the conservative 2000px default.
  const maxImageDimension = getMaxImageDimensionForModel(model);

  // Extract system message
  const conversation = messages.map((chatMessage: ChatMessage) => ({
    ...chatMessage,
  }));
  if (conversation.length > 0 && conversation[0].role === "system") {
    const extractedContent = conversation.shift()?.content as string | undefined;
    // Anthropic rejects system text blocks containing only whitespace.
    // Normalise empty/whitespace-only values to undefined so the field
    // is omitted from the API payload entirely.
    systemMessage = extractedContent?.trim() ? extractedContent : undefined;
  }

  // Build clean messages with ONLY the fields Anthropic's API accepts.
  // Whitelist approach: explicitly construct each output object instead of
  // destructuring + ...rest, which leaks any new internal fields (e.g.
  // _ttftSamples, _liveGenProgress, _workerTokens) into the API payload.
  //
  // Mid-conversation system messages are kept as role: "system" on models
  // that support them (Opus 4.8) and demoted to user role everywhere else.
  // Either way the harness wraps their content in semantic XML tags
  // (see utils/SystemMessageTags.ts), so demoted messages remain
  // distinguishable from genuine user input.
  const cleaned = await Promise.all(
    conversation
      .filter(
        (chatMessage: ChatMessage) =>
          chatMessage.role === "user" ||
          chatMessage.role === "assistant" ||
          chatMessage.role === "tool" ||
          chatMessage.role === "system",
      )
      .map(async (message: ChatMessage) => {
        // Convert tool role messages to tool_result user messages for Anthropic
        if (message.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id:
                  message.tool_call_id ||
                  message.id ||
                  message.name ||
                  "unknown",
                content:
                  typeof message.content === "string"
                    ? message.content
                    : JSON.stringify(message.content),
              },
            ],
          };
        }

        // Mid-conversation system messages (e.g. dynamic tool updates from
        // the harness). On models with native support they stay system-role
        // (position constraints are enforced after merging); elsewhere they
        // are demoted to user role — the harness's XML tags let the model
        // distinguish them from actual user messages.
        if (message.role === "system") {
          return {
            role: keepSystemRole ? "system" : "user",
            content:
              typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content),
          };
        }

        // Convert assistant messages with toolCalls to multi-part content
        if (
          message.role === "assistant" &&
          message.toolCalls &&
          message.toolCalls.length > 0
        ) {
          const contentBlocks: AnthropicBlock[] = [];
          // Preserve thinking blocks for multi-step reasoning continuity.
          // The signature field is REQUIRED by Anthropic's API for multi-turn
          // conversations — without it the API returns a 400.
          // Only include thinking when we have the signature; conversations
          // missing it must omit the block to avoid API 400 errors.
          if (message.thinking && message.thinkingSignature) {
            contentBlocks.push({
              type: "thinking",
              thinking: message.thinking,
              signature: message.thinkingSignature,
            });
          }
          if (typeof message.content === "string" && message.content.trim()) {
            contentBlocks.push({ type: "text", text: message.content });
          }
          for (const toolCall of message.toolCalls) {
            contentBlocks.push({
              type: "tool_use",
              id: toolCall.id || toolCall.name || `toolCall-${Date.now()}`,
              name: toolCall.name,
              input: (toolCall.args as Record<string, unknown>) || {},
            });
          }
          return {
            role: "assistant",
            content: contentBlocks,
          };
        }

        // Convert messages with media to Anthropic content block format.
        // All media array fields participate — images (which may also carry
        // PDFs/text files/videos routed by MIME type), plus the dedicated
        // audio/video/pdf arrays. Unsupported media becomes visible text
        // placeholders instead of being dropped silently.
        const mediaReferences: string[] = [
          ...(message.images || []),
          ...(Array.isArray(message.audio) ? message.audio : []),
          ...(Array.isArray(message.video) ? message.video : []),
          ...(Array.isArray(message.pdf) ? message.pdf : []),
        ];
        const documentReferences = Array.isArray(message.documents)
          ? message.documents
          : [];
        if (mediaReferences.length > 0 || documentReferences.length > 0) {
          const contentBlocks: AnthropicBlock[] = [];
          for (const reference of mediaReferences) {
            contentBlocks.push(
              ...(await buildMediaBlocksForReference(
                reference,
                maxImageDimension,
              )),
            );
          }
          // Document attachments — small text-like documents were primed
          // at resolution time and inline their content directly; binary
          // or oversized documents keep the reader-tool pointer (the model
          // reads those via reader tools using the "attached" input).
          for (const documentReference of documentReferences) {
            contentBlocks.push({
              type: "text",
              text: getDocumentContextText(documentReference),
            });
          }
          const textContent =
            typeof message.content === "string" ? message.content : "";
          if (textContent) {
            contentBlocks.push({ type: "text", text: textContent });
          }
          return {
            role: message.role,
            content: contentBlocks.length > 0 ? contentBlocks : message.content,
          };
        }

        // Handle assistant messages that have thinking but no toolCalls.
        // Anthropic requires thinking blocks as structured content blocks,
        // not top-level fields — convert them into the proper format.
        // Only include thinking when we have the signature; conversations
        // without it must omit the block to avoid API 400 errors.
        if (
          message.role === "assistant" &&
          message.thinking &&
          !message.toolCalls?.length
        ) {
          const contentBlocks: AnthropicBlock[] = [];
          if (message.thinkingSignature) {
            contentBlocks.push({
              type: "thinking",
              thinking: message.thinking,
              signature: message.thinkingSignature,
            });
          }
          if (typeof message.content === "string" && message.content.trim()) {
            contentBlocks.push({ type: "text", text: message.content });
          } else {
            contentBlocks.push({ type: "text", text: " " });
          }
          return {
            role: "assistant",
            content:
              contentBlocks.length > 1
                ? contentBlocks
                : (typeof message.content === "string"
                    ? message.content.trim()
                    : "") || " ",
          };
        }

        // Ensure assistant messages never have empty content
        if (
          message.role === "assistant" &&
          (!message.content ||
            (typeof message.content === "string" && !message.content.trim()))
        ) {
          return { role: "assistant", content: " " };
        }

        // Default: user or assistant with plain text — whitelist only role + content
        return { role: message.role, content: message.content || " " };
      }),
  );

  // Merge consecutive same-role messages
  let merged = mergeConsecutiveSameRole(cleaned);

  // Enforce Anthropic's placement rules for retained mid-conversation
  // system messages: a system message cannot be messages[0], must follow a
  // user message, and must be either the last entry or followed by an
  // assistant turn. Demote any message violating these to user role, then
  // re-merge in case the demotion created adjacent user messages.
  if (keepSystemRole) {
    let demotedAny = false;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i].role !== "system") continue;
      const followsUser = i > 0 && merged[i - 1].role === "user";
      const validSuccessor =
        i === merged.length - 1 || merged[i + 1].role === "assistant";
      if (!followsUser || !validSuccessor) {
        merged[i].role = "user";
        demotedAny = true;
      }
    }
    if (demotedAny) {
      merged = mergeConsecutiveSameRole(merged);
    }
  }

  // Deduplicate tool_result blocks within merged user messages.
  // Anthropic requires exactly one tool_result per tool_use_id.
  // The frontend may send both inline results (from assistant.toolCalls
  // expansion) and standalone tool-role messages with the same ID,
  // which after merging creates duplicate tool_result blocks.
  for (const message of merged) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const seenToolResultIds = new Set();
    message.content = (message.content as AnthropicBlock[]).filter(
      (block: AnthropicBlock) => {
        if (block.type !== "tool_result") return true;
        if (seenToolResultIds.has(block.tool_use_id)) return false;
        seenToolResultIds.add(block.tool_use_id);
        return true;
      },
    );
  }

  // Ensure conversation starts with a user message
  if (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  // Strip orphaned tool_use blocks: if an assistant message has tool_use
  // content blocks but the next message is NOT a tool_result, remove them.
  // This handles stale conversation history loaded from the database.
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i];
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;

    const hasToolUse = (message.content as AnthropicBlock[]).some(
      (b: AnthropicBlock) => b.type === "tool_use",
    );
    if (!hasToolUse) continue;

    const next = merged[i + 1];
    const nextHasToolResult =
      next?.role === "user" &&
      Array.isArray(next.content) &&
      next.content.some((b: AnthropicBlock) => b.type === "tool_result");

    if (!nextHasToolResult) {
      // Strip tool_use blocks, keep only text
      message.content = (message.content as AnthropicBlock[]).filter(
        (b: AnthropicBlock) => b.type !== "tool_use",
      );
      if (message.content.length === 0) {
        message.content = " ";
      }
    }
  }

  // Anthropic rejects requests where the final assistant message content ends
  // with trailing whitespace (400: "final assistant content cannot end with
  // trailing whitespace"). Sanitize all assistant text blocks to be safe.
  for (const message of merged) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      message.content = message.content.trimEnd() || " ";
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text = block.text.trimEnd() || " ";
        }
      }
    }
  }

  return { systemMessage, messages: merged };
}
export function buildTools(options: ProviderOptions) {
  const tools: Array<Record<string, unknown>> = [];
  if (options.webSearch) {
    tools.push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    });
  }
  if (options.webFetch) {
    tools.push({
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: 10,
    });
  }
  if (options.codeExecution) {
    tools.push({
      type: "code_execution_20260120",
      name: "code_execution",
    });
  }
  // Custom function calling tools
  if (options.tools && Array.isArray(options.tools)) {
    for (const tool of options.tools) {
      tools.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.parameters || { type: "object", properties: {} },
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}
export function extractResponseContent(contentBlocks: AnthropicBlock[]) {
  let text = "";
  let thinking = null;
  let thinkingSignature = null;
  const citations: Array<{ url?: string; title?: string; citedText?: string }> =
    [];
  const toolCalls: Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
  }> = [];

  for (const block of contentBlocks || []) {
    if (block.type === "text") {
      text += block.text || "";
      // Collect inline citations from this text block
      if (block.citations) {
        for (const cite of block.citations) {
          if (cite.type === "web_search_result_location") {
            citations.push({
              url: cite.url,
              title: cite.title,
              citedText: cite.cited_text,
            });
          }
        }
      }
    } else if (block.type === "thinking") {
      thinking = block.thinking;
      if (block.signature) thinkingSignature = block.signature;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input || {},
      });
    }
    // server_tool_use and *_tool_result blocks are informational — skip
  }

  return { text, thinking, thinkingSignature, citations, toolCalls };
}
export function buildUsage(
  responseUsage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      }
    | null
    | undefined,
): TokenUsage {
  return {
    inputTokens: responseUsage?.input_tokens ?? 0,
    outputTokens: responseUsage?.output_tokens ?? 0,
    cacheReadInputTokens: responseUsage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: responseUsage?.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Resolve the effective system prompt for Anthropic's `system:` field.
 *
 * The identity prompt (persona, tool policy, guidelines) flows through
 * `options.systemPrompt` as a first-class parameter from the harness.
 * Contextual injections (local time, agent memory) may also arrive via
 * the messages array as a leading `role: "system"` message, extracted by
 * `prepareMessages` into `prepared.systemMessage`. When both exist, the
 * identity prompt takes precedence and the contextual block is appended.
 */
export function resolveSystemPrompt(
  identityPrompt: string | undefined,
  contextualSystemMessage: string | undefined,
): string | undefined {
  if (identityPrompt && contextualSystemMessage) {
    return `${identityPrompt}\n\n${contextualSystemMessage}`;
  }
  return identityPrompt || contextualSystemMessage;
}

const EPHEMERAL_CACHE = { type: "ephemeral" } as const;

/**
 * Attach real prompt-cache breakpoints to the request.
 *
 * The Anthropic API only honors `cache_control` on system blocks, tool
 * definitions, and message content blocks — the previous top-level
 * `cache_control` key on the payload root was silently ignored, so prompt
 * caching was effectively disabled for every agentic turn.
 *
 * Breakpoints (≤4 allowed; we use up to 3):
 *   1. Last tool definition   → caches the (large, stable) tool schema block
 *   2. System prompt block    → caches the assembled system prompt
 *   3. Last message block     → moving marker; each turn re-hits the prefix
 *      cached by the previous turn's marker and extends it.
 */
export function applyCacheBreakpoints(payload: Record<string, unknown>): void {
  // 1. Tools — serialize first in the prompt; mark the last definition
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: EPHEMERAL_CACHE,
    };
  }

  // 2. System — convert the plain string to a cacheable text block
  if (typeof payload.system === "string" && payload.system.trim()) {
    payload.system = [
      { type: "text", text: payload.system, cache_control: EPHEMERAL_CACHE },
    ];
  }

  // 3. Messages — moving breakpoint on the last cacheable content block
  const messages = payload.messages as
    | Array<{ content: unknown; [key: string]: unknown }>
    | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const lastMessage = messages[messages.length - 1];
  if (typeof lastMessage.content === "string") {
    if (!lastMessage.content.trim()) return; // empty text blocks are rejected
    lastMessage.content = [
      {
        type: "text",
        text: lastMessage.content,
        cache_control: EPHEMERAL_CACHE,
      },
    ];
    return;
  }
  if (Array.isArray(lastMessage.content)) {
    const blocks = lastMessage.content as Array<Record<string, unknown>>;
    // cache_control is not allowed on thinking blocks — walk back to the
    // last block that accepts it.
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (block.type === "thinking" || block.type === "redacted_thinking")
        continue;
      if (block.type === "text" && !String(block.text ?? "").trim()) continue;
      blocks[blockIndex] = { ...block, cache_control: EPHEMERAL_CACHE };
      return;
    }
  }
}

const anthropicProvider = {
  name: "anthropic",

  async generateText(
    messages: ChatMessage[],
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).anthropic,
    options: ProviderOptions = {},
  ): Promise<AnthropicGenerateResult> {
    logger.provider("Anthropic", `generateText model=${model}`);

    const prepared = await prepareMessages(messages, model);
    const effectiveSystemPrompt = resolveSystemPrompt(
      options.systemPrompt,
      prepared.systemMessage,
    );
    const payload: Record<string, unknown> = {
      ...(effectiveSystemPrompt && { system: effectiveSystemPrompt }),
      model,
      messages: prepared.messages,
      max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      temperature:
        options.temperature !== undefined
          ? Math.min(options.temperature, 1)
          : undefined,
      top_p:
        options.temperature === undefined && options.topP !== undefined
          ? options.topP
          : undefined,
      top_k: options.topK !== undefined ? options.topK : undefined,
      stop_sequences:
        options.stopSequences !== undefined ? options.stopSequences : undefined,
      ...(options.serviceTier && {
        service_tier:
          options.serviceTier === "standard"
            ? "standard_only"
            : options.serviceTier,
      }),
      ...(options.responseFormat === "json_object" && {
        output_config: {
          format: {
            type: "json_schema" as const,
            schema: { type: "object", additionalProperties: false },
          },
        },
      }),
    };

    // Opus 4.7+ lock sampling parameters — API rejects non-default values
    const modelDefinition = getModelByName(model);
    const hasLockedSampling =
      (modelDefinition as Record<string, unknown> | null)?.lockedSampling ===
      true;
    if (hasLockedSampling) {
      delete payload.temperature;
      delete payload.top_p;
      delete payload.top_k;
    }

    const isAdaptiveThinking =
      (modelDefinition as Record<string, unknown> | null)?.adaptiveThinking ===
      true;
    if (isAdaptiveThinking) {
      delete payload.top_k;
    }

    // Sonnet 5+ deprecated top_k — API rejects requests containing it
    const hasDeprecatedTopK =
      (modelDefinition as Record<string, unknown> | null)?.deprecatedTopK ===
      true;
    if (hasDeprecatedTopK) {
      delete payload.top_k;
    }

    // Server tools
    const tools = buildTools(options);
    if (tools) payload.tools = tools;

    // Adaptive thinking models (Fable 5, Mythos 5, Opus 4.7+): thinking is
    // inherent to the model — enable by default unless explicitly disabled.
    if (options.thinkingEnabled !== false && isAdaptiveThinking) {
      payload.thinking = { type: "adaptive" };
      if (options.reasoningEffort) {
        payload.output_config = {
          ...((payload.output_config as Record<string, unknown>) || {}),
          effort: options.reasoningEffort,
        };
      }
      // Sampling params are deprecated on adaptive-thinking models — omit
      // entirely rather than sending the tolerated default value.
      delete payload.temperature;
      delete payload.top_p;
      delete payload.top_k;
    } else if (
      options.thinkingEnabled !== false &&
      (options.thinkingEnabled === true ||
        options.thinkingBudget ||
        options.reasoningEffort)
    ) {
      // Legacy models (Opus 4.x, Sonnet 4.x): manual extended thinking with budget_tokens
      const budget = options.thinkingBudget
        ? parseInt(String(options.thinkingBudget))
        : (options.reasoningEffort
            ? EFFORT_BUDGET_MAP[options.reasoningEffort]
            : undefined) || EFFORT_BUDGET_MAP.high;
      payload.thinking = { type: "enabled", budget_tokens: budget };
      if ((payload.max_tokens as number) <= budget) {
        payload.max_tokens = budget + 1024;
      }
      // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
      payload.temperature = 1;
      delete payload.top_p;
      delete payload.top_k;
    }

    // Upload-once media: swap large inline base64 image/PDF blocks for
    // Files API file_id references (first-party API only). Falls back to
    // inline base64 on any Files API failure.
    let fileSources: FileSourceApplication = {
      applied: false,
      substitutions: [],
      fileIds: [],
    };
    if (!options.disableAnthropicFileSources) {
      fileSources = await AnthropicFileCacheService.applyFileSources(
        prepared.messages as Array<{ content?: unknown }>,
      );
    }

    applyCacheBreakpoints(payload);

    try {
      // Transient failures (overloaded, rate limit, network) retry via the
      // shared provider resilience policy — same classification and jittered
      // backoff the harness applies to streams.
      const { data: response, response: rawResponse } = await callWithRetries(
        () =>
          getClient()
            .messages.create(
              payload as unknown as Anthropic.MessageCreateParamsNonStreaming,
              fileSources.applied
                ? { headers: { "anthropic-beta": ANTHROPIC_FILES_API_BETA } }
                : undefined,
            )
            .withResponse(),
        { signal: options.signal, label: "anthropic" },
      );
      const rateLimits = extractAnthropicRateLimits(rawResponse, model);
      const message = response as Anthropic.Messages.Message;

      const { text, thinking, thinkingSignature, citations, toolCalls } =
        extractResponseContent(message.content as AnthropicBlock[]);
      const result: AnthropicGenerateResult = {
        text,
        usage: buildUsage(message.usage),
      };
      if (thinking) result.thinking = thinking;
      if (thinkingSignature) result.thinkingSignature = thinkingSignature;
      if (citations.length > 0) result.citations = citations;
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      if (rateLimits) result.rateLimits = rateLimits;
      // Forward structured stop details for observability (SDK 0.82+)
      if (message.stop_reason) result.stopReason = message.stop_reason;
      if ("stop_details" in message && message.stop_details)
        result.stopDetails = { ...message.stop_details };
      return result;
    } catch (error: unknown) {
      // A rejected file_id (deleted server-side, beta unavailable) —
      // invalidate the stale cache entries and retry once fully inline.
      if (AnthropicFileCacheService.isFileSourceError(error, fileSources)) {
        logger.warn(
          `[anthropic] Files API reference rejected (${getErrorMessage(error)}) — retrying with inline media`,
        );
        await AnthropicFileCacheService.revertFileSources(fileSources);
        return anthropicProvider.generateText(messages, model, {
          ...options,
          disableAnthropicFileSources: true,
        });
      }
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error as Error,
      );
    }
  },
  async captionImage(
    images: string[],
    prompt: string = "Describe this image.",
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).anthropic,
    systemPrompt?: string,
  ) {
    logger.provider("Anthropic", `captionImage model=${model}`);
    try {
      const contentBlocks: AnthropicBlock[] = [];

      for (const imageUrlOrBase64 of images) {
        const match = imageUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          let mediaType = match[1];
          let data = match[2];
          // Auto-detect media type from data prefix
          if (data.startsWith("/9j/")) mediaType = "image/jpeg";
          else if (data.startsWith("iVBOR")) mediaType = "image/png";
          else if (data.startsWith("R0lG")) mediaType = "image/gif";
          else if (data.startsWith("UklG")) mediaType = "image/webp";

          // Enforce Anthropic's 5 MB per-image limit
          const compressed = await compressImageForSizeLimit(data, mediaType);
          data = compressed.data;
          mediaType = compressed.mediaType;

          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data,
            },
          });
        } else if (imageUrlOrBase64.startsWith("http")) {
          // URL-based image
          contentBlocks.push({
            type: "image",
            source: {
              type: "url",
              url: imageUrlOrBase64,
            },
          });
        }
      }

      contentBlocks.push({ type: "text", text: prompt });

      const payload: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: contentBlocks }],
        max_tokens: 1000,
      };
      if (systemPrompt) {
        payload.system = systemPrompt;
      }

      const response = (await getClient().messages.create(
        payload as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as Anthropic.Messages.Message;

      const { text } = extractResponseContent(
        response.content as AnthropicBlock[],
      );
      return {
        text,
        usage: buildUsage(response.usage),
      };
    } catch (error: unknown) {
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error as Error,
      );
    }
  },

  async *generateTextStream(
    messages: ChatMessage[],
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).anthropic,
    options: ProviderOptions = {},
  ): AsyncGenerator<TransformedStreamEvent> {
    logger.provider("Anthropic", `generateTextStream model=${model}`);
    let fileSources: FileSourceApplication = {
      applied: false,
      substitutions: [],
      fileIds: [],
    };
    let receivedAnyStreamChunk = false;
    try {
      const prepared = await prepareMessages(messages, model);
      const effectiveSystemPrompt = resolveSystemPrompt(
        options.systemPrompt,
        prepared.systemMessage,
      );
      const streamPayload: Record<string, unknown> = {
        ...(effectiveSystemPrompt && { system: effectiveSystemPrompt }),
        model,
        messages: prepared.messages,
        max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
        temperature:
          options.temperature !== undefined
            ? Math.min(options.temperature, 1)
            : undefined,
        top_p:
          options.temperature === undefined && options.topP !== undefined
            ? options.topP
            : undefined,
        top_k: options.topK !== undefined ? options.topK : undefined,
        stop_sequences:
          options.stopSequences !== undefined
            ? options.stopSequences
            : undefined,
        ...(options.serviceTier && {
          service_tier:
            options.serviceTier === "standard"
              ? "standard_only"
              : options.serviceTier,
        }),
        ...(options.responseFormat === "json_object" && {
          output_config: {
            format: {
              type: "json_schema" as const,
              schema: { type: "object", additionalProperties: false },
            },
          },
        }),
      };

      // Opus 4.7+ lock sampling parameters — API rejects non-default values
      const modelDefinition = getModelByName(model);
      const hasLockedSampling =
        (modelDefinition as Record<string, unknown> | null)?.lockedSampling ===
        true;
      if (hasLockedSampling) {
        delete streamPayload.temperature;
        delete streamPayload.top_p;
        delete streamPayload.top_k;
      }

      const isAdaptiveThinking =
        (modelDefinition as Record<string, unknown> | null)
          ?.adaptiveThinking === true;
      if (isAdaptiveThinking) {
        delete streamPayload.top_k;
      }

      // Sonnet 5+ deprecated top_k — API rejects requests containing it
      const hasDeprecatedTopK =
        (modelDefinition as Record<string, unknown> | null)?.deprecatedTopK ===
        true;
      if (hasDeprecatedTopK) {
        delete streamPayload.top_k;
      }

      // Server tools
      const tools = buildTools(options);
      if (tools) streamPayload.tools = tools;

      // Adaptive thinking models (Fable 5, Mythos 5, Opus 4.7+): thinking is
      // inherent to the model — enable by default unless explicitly disabled.
      if (options.thinkingEnabled !== false && isAdaptiveThinking) {
        streamPayload.thinking = { type: "adaptive" };
        if (options.reasoningEffort) {
          streamPayload.output_config = {
            ...((streamPayload.output_config as Record<string, unknown>) || {}),
            effort: options.reasoningEffort,
          };
        }
        // Sampling params are deprecated on adaptive-thinking models — omit
        // entirely rather than sending the tolerated default value.
        delete streamPayload.temperature;
        delete streamPayload.top_p;
        delete streamPayload.top_k;
      } else if (
        options.thinkingEnabled !== false &&
        (options.thinkingEnabled === true ||
          options.thinkingBudget ||
          options.reasoningEffort)
      ) {
        // Legacy models (Opus 4.x, Sonnet 4.x): manual extended thinking with budget_tokens
        const budget = options.thinkingBudget
          ? parseInt(String(options.thinkingBudget))
          : (options.reasoningEffort
              ? EFFORT_BUDGET_MAP[options.reasoningEffort]
              : undefined) || EFFORT_BUDGET_MAP.high;
        streamPayload.thinking = { type: "enabled", budget_tokens: budget };
        if ((streamPayload.max_tokens as number) <= budget) {
          streamPayload.max_tokens = budget + 1024;
        }
        // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
        streamPayload.temperature = 1;
        delete streamPayload.top_p;
        delete streamPayload.top_k;
      }

      await enforceImageSizeLimits(
        streamPayload.messages as ChatMessage[],
        getMaxImageDimensionForModel(model),
      );

      // Upload-once media: swap large inline base64 image/PDF blocks for
      // Files API file_id references (first-party API only). Falls back to
      // inline base64 on any Files API failure.
      if (!options.disableAnthropicFileSources) {
        fileSources = await AnthropicFileCacheService.applyFileSources(
          streamPayload.messages as Array<{ content?: unknown }>,
        );
      }

      applyCacheBreakpoints(streamPayload);

      const stream = getClient().messages.stream(
        streamPayload as unknown as Anthropic.MessageCreateParamsNonStreaming,
        {
          ...(options.signal && { signal: options.signal }),
          ...(fileSources.applied && {
            headers: { "anthropic-beta": ANTHROPIC_FILES_API_BETA },
          }),
        },
      );

      // Track current content block type for server tool response processing
      let currentBlockType: string | null = null;
      let currentBlockName: string | null = null;
      let currentToolUseId: string | null = null;
      let codeInput = "";
      let usage: TokenUsage | null = null;
      let messageStartUsage: {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      } | null = null;
      let rateLimits: ReturnType<typeof extractAnthropicRateLimits> | null =
        null;

      for await (const chunk of stream) {
        receivedAnyStreamChunk = true;
        if (options.signal?.aborted) {
          stream.abort();
          break;
        }
        // Capture input token counts from message_start (sent once at stream start).
        // Anthropic sends input_tokens, cache_read_input_tokens, and
        // cache_creation_input_tokens here — message_delta only has output_tokens.
        if (chunk.type === "message_start" && chunk.message?.usage) {
          messageStartUsage = chunk.message.usage;
          // Capture rate-limit headers from the stream's initial response
          if (!rateLimits && stream.response) {
            rateLimits = extractAnthropicRateLimits(stream.response, model);
          }
          continue;
        }
        // Content block start — track what kind of block we're in
        if (chunk.type === "content_block_start") {
          const block = chunk.content_block;
          currentBlockType = block?.type || null;
          currentBlockName = ("name" in block ? block.name : null) as
            | string
            | null;
          currentToolUseId = ("id" in block ? block.id : null) as string | null;
          codeInput = "";

          // Server tool use start — yield the tool name being invoked
          if (
            block?.type === "server_tool_use" &&
            "name" in block &&
            block.name === "code_execution"
          ) {
            // Code execution starting — we'll accumulate the input
          }

          // Custom tool_use start — emit early disclosure before argument streaming
          if (
            block?.type === "tool_use" &&
            currentBlockName &&
            currentToolUseId
          ) {
            yield {
              type: "toolCallStart",
              id: currentToolUseId,
              name: currentBlockName,
            };
          }

          // Code execution tool result — legacy (code_execution_tool_result)
          // and current bash variant (code_execution_20260120 emits
          // bash_code_execution_tool_result) share the stdout/stderr shape.
          if (
            block?.type === "code_execution_tool_result" ||
            block?.type === "bash_code_execution_tool_result"
          ) {
            const result = (
              block as {
                content?: {
                  stdout?: string;
                  stderr?: string;
                  return_code?: number;
                };
              }
            ).content;
            if (result) {
              yield {
                type: "codeExecutionResult",
                output: result.stdout || result.stderr || "",
                outcome: result.return_code === 0 ? "OK" : "ERROR",
              };
            }
          }

          // Web search / web fetch tool result — extract citations.
          // Search success content is a list of web_search_result blocks;
          // fetch success content is a single web_fetch_result object
          // (error content is an object with error_code — skipped by the
          // type filter either way).
          if (
            block?.type === "web_search_tool_result" ||
            block?.type === "web_fetch_tool_result"
          ) {
            const content = (
              block as { content?: AnthropicBlock[] | AnthropicBlock }
            ).content;
            const blocks = Array.isArray(content)
              ? content
              : content
                ? [content]
                : [];
            const results = blocks
              .filter(
                (r: AnthropicBlock) =>
                  r.type === "web_search_result" ||
                  r.type === "web_fetch_result",
              )
              .map((r: AnthropicBlock) => ({
                url: r.url,
                title: r.title,
                pageAge: r.page_age,
              }));
            if (results.length > 0) {
              yield { type: "webSearchResult", results };
            }
          }

          continue;
        }

        // Content block stop
        if (chunk.type === "content_block_stop") {
          // Server code execution — yield code. Legacy tool sends
          // name "code_execution" with {code}; code_execution_20260120
          // sends the "bash_code_execution" sub-tool with {command}.
          if (
            currentBlockType === "server_tool_use" &&
            (currentBlockName === "code_execution" ||
              currentBlockName === "bash_code_execution") &&
            codeInput
          ) {
            try {
              const parsed = JSON.parse(codeInput);
              const code = parsed.code || parsed.command;
              if (code) {
                yield {
                  type: "executableCode",
                  code,
                  language: parsed.language || "bash",
                };
              }
            } catch {
              // Not valid JSON, skip
            }
          }
          // Custom tool_use block ended — emit toolCall
          if (currentBlockType === "tool_use") {
            let args: Record<string, unknown> = {};
            let argsParseError = false;
            if (codeInput) {
              try {
                args = JSON.parse(codeInput);
              } catch {
                // Malformed/truncated tool-call JSON (common at output-token
                // exhaustion). Flag it instead of silently executing with {}
                // — the harness converts this into a synthetic error result
                // telling the model its own JSON was broken.
                argsParseError = true;
              }
            }
            yield {
              type: "toolCall",
              id: currentToolUseId,
              name: currentBlockName,
              args,
              ...(argsParseError && {
                argsParseError: true,
                rawArgs: codeInput.slice(0, 2000),
              }),
            };
          }
          currentBlockType = null;
          currentBlockName = null;
          currentToolUseId = null;
          codeInput = "";
          continue;
        }

        // Content block deltas
        if (chunk.type === "content_block_delta") {
          // Thinking delta
          if (chunk.delta.type === "thinking_delta") {
            yield { type: "thinking", content: chunk.delta.thinking };
            continue;
          }
          // Signature delta — Anthropic sends the thinking block's cryptographic
          // signature as a separate delta event. This MUST be captured and passed
          // back verbatim in multi-turn conversations, otherwise the API rejects
          // the request with a 400.
          if (chunk.delta.type === "signature_delta") {
            yield {
              type: "thinking_signature",
              signature: chunk.delta.signature,
            };
            continue;
          }
          // Text delta
          if (chunk.delta.type === "text_delta") {
            yield chunk.delta.text;
            continue;
          }
          // Input JSON delta for server tool use or custom tool_use (accumulate)
          if (
            chunk.delta.type === "input_json_delta" &&
            (currentBlockType === "server_tool_use" ||
              currentBlockType === "tool_use")
          ) {
            const partial = chunk.delta.partial_json || "";
            codeInput += partial;
            // Yield progress event for tool_use blocks so generation
            // throughput tracking stays alive during FC argument streaming.
            if (currentBlockType === "tool_use" && partial.length > 0) {
              yield { type: "toolCallDelta", characters: partial.length };
            }
            continue;
          }
        }

        // Message delta (final usage + stop details) — carries output_tokens only
        if (chunk.type === "message_delta") {
          if (chunk.usage) {
            usage = {
              inputTokens: messageStartUsage?.input_tokens ?? 0,
              outputTokens: chunk.usage.output_tokens ?? 0,
              cacheReadInputTokens:
                messageStartUsage?.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens:
                messageStartUsage?.cache_creation_input_tokens ?? 0,
            };
          }
          // Forward structured stop details for observability (SDK 0.82+)
          if (chunk.delta?.stop_reason) {
            yield { type: "stopReason", stopReason: chunk.delta.stop_reason };
          }
          if (chunk.delta && "stop_details" in chunk.delta) {
            yield {
              type: "stopDetails",
              stopDetails: chunk.delta.stop_details,
            };
          }
        }
      }

      // Get full usage from the finalized message
      try {
        const finalMessage = await stream.finalMessage();
        if (finalMessage?.usage) {
          usage = buildUsage(finalMessage.usage);
        }
      } catch {
        // finalMessage() can throw for tool_use stop reasons — use message_delta usage
      }
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: EMPTY_USAGE };
      }
      if (rateLimits) {
        yield { type: "rateLimits", rateLimits };
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return;
      // A rejected file_id (deleted server-side, beta unavailable) surfaces
      // at request validation — before any chunk. Invalidate the stale cache
      // entries and retry once fully inline. Zero-chunk guard ensures the
      // retry never replays text or re-executes tool calls.
      if (
        !receivedAnyStreamChunk &&
        AnthropicFileCacheService.isFileSourceError(error, fileSources)
      ) {
        logger.warn(
          `[anthropic] Files API reference rejected (${getErrorMessage(error)}) — retrying stream with inline media`,
        );
        await AnthropicFileCacheService.revertFileSources(fileSources);
        yield* anthropicProvider.generateTextStream(messages, model, {
          ...options,
          disableAnthropicFileSources: true,
        });
        return;
      }
      // No provider-level retry: transient stream failures are retried by the
      // shared streamWithRetries wrapper at the call site (zero-chunk only,
      // so a retry never replays text or re-executes tool calls).
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error as Error,
      );
    }
  },
};

export default anthropicProvider;

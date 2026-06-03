/**
 * Shared utilities for function calling (FC) message expansion.
 *
 * Both HomePage.js and ConsoleComponent.js need to expand assistant messages
 * with toolCalls into the [assistant(tool_calls), tool(result), ...] format
 * expected by the OpenAI Chat Completions spec. This module centralises that
 * logic to avoid duplication.
 */

import type { ChatMessage, ToolCallEntry } from "../types/admin.ts";

// ── Array keys whose entries get capped during truncation ─────
const TRUNCATABLE_ARRAY_KEYS = [
  "events",
  "products",
  "trends",
  "articles",
  "earnings",
  "predictions",
  "commodities",
];

/**
 * Truncate a tool result to avoid blowing up the model's context window.
 * Caps arrays at 10 items and the serialized JSON at ~maxChars.
 * The full result is still stored in the DB and shown in the UI;
 * this only affects what gets re-sent to the model.
 */
export function truncateToolResult(result: unknown, maxChars = 8000): unknown {
  if (!result || typeof result !== "object") return result;

  // Also handle top-level arrays (e.g. tides, earthquakes)
  if (Array.isArray(result) && result.length > 10) {
    const sliced = result.slice(0, 10);
    sliced.push({ _truncated: `Showing 10 of ${result.length}` });
    const serialized = JSON.stringify(sliced);
    return serialized.length > maxChars ? serialized.slice(0, maxChars) + "…}" : sliced;
  }

  // If result has a known array wrapper, cap items at 10
  const trimmed = { ...(result as Record<string, unknown>) };
  for (const key of TRUNCATABLE_ARRAY_KEYS) {
    const items = trimmed[key];
    if (Array.isArray(items) && items.length > 10) {
      const total = items.length;
      trimmed[key] = items.slice(0, 10);
      trimmed[`_${key}Truncated`] = `Showing 10 of ${total}`;
    }
  }

  const serialized = JSON.stringify(trimmed);
  if (serialized.length <= maxChars) return trimmed;
  return serialized.slice(0, maxChars) + "…}";
}

interface ExpandOptions {
  filterDeleted?: boolean;
}

interface ExpandedToolCall {
  id?: string | null;
  name: string;
  args?: unknown;
  responsesItemId?: string;
  thoughtSignature?: string;
  reasoningItem?: { id: string; summary: Array<{ type: string; text: string }> };
}

interface ExpandedMessage {
  role: string;
  content?: string | unknown | null;
  name?: string;
  tool_call_id?: string | null;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ExpandedToolCall[];
  images?: string[];
  video?: string[];
  audio?: string | string[];
  pdf?: string[];
}

/**
 * Expand a messages array into the format expected by LLM providers for
 * function calling. Assistant messages with toolCalls are expanded into
 * [assistant(tool_calls), tool(result1), tool(result2), ...] per the
 * OpenAI Chat Completions spec.
 */
export function expandMessagesForFC(
  messages: ChatMessage[],
  { filterDeleted = true }: ExpandOptions = {},
): ExpandedMessage[] {
  const filtered = filterDeleted
    ? messages.filter(
        (messageItem) =>
          !(messageItem as ChatMessage & { deleted?: boolean }).deleted &&
          (messageItem.role !== "assistant" || messageItem.content?.toString().trim() || messageItem.toolCalls?.length),
      )
    : messages;

  return filtered.flatMap((message) => {
    // Expand assistant messages with toolCalls into
    // [assistant(tool_calls), tool(result1), tool(result2), ...]
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const assistantMessage: ExpandedMessage = {
        role: "assistant",
        content: message.content?.toString().trim() || null,
        // Preserve thinking + signature for Anthropic multi-turn round-trips
        ...(message.thinking && { thinking: message.thinking }),
        ...((message as ChatMessage & { thinkingSignature?: string }).thinkingSignature && {
          thinkingSignature: (message as ChatMessage & { thinkingSignature?: string }).thinkingSignature,
        }),
        toolCalls: message.toolCalls.map((toolCall: ToolCallEntry) => ({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          ...(toolCall.responsesItemId
            ? { responsesItemId: toolCall.responsesItemId }
            : {}),
          ...(toolCall.thoughtSignature
            ? { thoughtSignature: toolCall.thoughtSignature }
            : {}),
          ...(toolCall.reasoningItem
            ? { reasoningItem: toolCall.reasoningItem }
            : {}),
        })),
      };
      const toolMessages: ExpandedMessage[] = message.toolCalls
        .filter((toolCall: ToolCallEntry) => toolCall.result !== undefined)
        .map((toolCall: ToolCallEntry) => ({
          role: "tool",
          name: toolCall.name,
          tool_call_id: toolCall.id,
          content:
            typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(truncateToolResult(toolCall.result)),
        }));
      return [assistantMessage, ...toolMessages];
    }

    // Pass through tool messages with their required fields
    if (message.role === "tool") {
      return [
        {
          role: "tool",
          tool_call_id: (message as ChatMessage & { tool_call_id?: string }).tool_call_id,
          name: message.name,
          content: message.content,
        },
      ];
    }

    // Standard message — include all media fields (images, video, audio, pdf)
    // Preserve thinking + thinkingSignature on assistant messages so Anthropic
    // can receive them back in multi-turn conversations (required by their API).
    return [
      {
        role: message.role,
        ...(message.content?.toString().trim() ? { content: message.content } : { content: " " }),
        ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
        ...(message.video && message.video.length > 0 ? { video: message.video } : {}),
        ...(message.audio && (Array.isArray(message.audio) ? message.audio.length > 0 : message.audio) ? { audio: message.audio } : {}),
        ...(message.pdf && message.pdf.length > 0 ? { pdf: message.pdf } : {}),
        ...(message.role === "assistant" && message.thinking
          ? { thinking: message.thinking }
          : {}),
        ...(message.role === "assistant" && (message as ChatMessage & { thinkingSignature?: string }).thinkingSignature
          ? { thinkingSignature: (message as ChatMessage & { thinkingSignature?: string }).thinkingSignature }
          : {}),
      },
    ];
  });
}

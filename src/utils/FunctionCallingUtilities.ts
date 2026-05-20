/**
 * Shared utilities for function calling (FC) message expansion.
 *
 * Both HomePage.js and ConsoleComponent.js need to expand assistant messages
 * with toolCalls into the [assistant(tool_calls), tool(result), ...] format
 * expected by the OpenAI Chat Completions spec. This module centralises that
 * logic to avoid duplication.
 */

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
// @ts-ignore - TODO: strict typing
export function truncateToolResult(result: Record<string, unknown>, maxChars: Record<string, unknown> = 8000) {
  if (!result || typeof result !== "object") return result;

  // If result has a known array wrapper, cap items at 10
  const trimmed = { ...result };
  // @ts-ignore
  for ( const key of TRUNCATABLE_ARRAY_KEYS) {
    if (Array.isArray(trimmed[key]) && trimmed[key].length > 10) {
      const total = trimmed[key].length;
      trimmed[key] = trimmed[key].slice(0, 10);
      trimmed[`_${key}Truncated`] = `Showing 10 of ${total}`;
    }
  }

  // Also handle top-level arrays (e.g. tides, earthquakes)
  if (Array.isArray(result) && result.length > 10) {
    const sliced = result.slice(0, 10);
    sliced.push({ _truncated: `Showing 10 of ${result.length}` });
    const str = JSON.stringify(sliced);
    // @ts-ignore - TODO: strict typing
    return str.length > maxChars ? str.slice(0, maxChars) + "…}" : sliced;
  }

  const str = JSON.stringify(trimmed);
  // @ts-ignore - TODO: strict typing
  if (str.length <= maxChars) return trimmed;
  // @ts-ignore - TODO: strict typing
  return str.slice(0, maxChars) + "…}";
}

/**
 * Expand a messages array into the format expected by LLM providers for
 * function calling. Assistant messages with toolCalls are expanded into
 * [assistant(tool_calls), tool(result1), tool(result2), ...] per the
 * OpenAI Chat Completions spec.
 *


 * @returns {Array} Provider-ready messages
 */
export function expandMessagesForFC(
  messages: Record<string, unknown>,
  { filterDeleted = true }: Record<string, unknown> = {},
) {
  const filtered = filterDeleted
    // @ts-ignore - TODO: strict typing
    ? messages.filter(
        (m: Record<string, unknown>) =>
          !m.deleted &&
          // @ts-ignore - TODO: strict typing
          (m.role !== "assistant" || m.content?.trim() || m.toolCalls?.length),
      )
    : messages;

  return filtered.flatMap((m: Record<string, unknown>) => {
    // Expand assistant messages with toolCalls into
    // [assistant(tool_calls), tool(result1), tool(result2), ...]
    // @ts-ignore - TODO: strict typing
    if (m.role === "assistant" && m.toolCalls?.length > 0) {
      const assistantMsg = {
        role: "assistant",
        // @ts-ignore - TODO: strict typing
        content: m.content?.trim() || null,
        // Preserve thinking + signature for Anthropic multi-turn round-trips
        // @ts-ignore - TODO: strict typing
        ...(m.thinking && { thinking: m.thinking }),
        // @ts-ignore - TODO: strict typing
        ...(m.thinkingSignature && { thinkingSignature: m.thinkingSignature }),
        // @ts-ignore - TODO: strict typing
        toolCalls: m.toolCalls.map((tc: Record<string, unknown>) => ({
          id: tc.id,
          name: tc.name,
          args: tc.args,
          ...(tc.responsesItemId
            ? { responsesItemId: tc.responsesItemId }
            : {}),
          ...(tc.thoughtSignature
            ? { thoughtSignature: tc.thoughtSignature }
            : {}),
        })),
      };
      // @ts-ignore - TODO: strict typing
      const toolMsgs = m.toolCalls
        .filter((tc: Record<string, unknown>) => tc.result !== undefined)
        .map((tc: Record<string, unknown>) => ({
          role: "tool",
          name: tc.name,
          tool_call_id: tc.id,
          content:
            typeof tc.result === "string"
              ? tc.result
              // @ts-ignore - TODO: strict typing
              : JSON.stringify(truncateToolResult(tc.result)),
        }));
      return [assistantMsg, ...toolMsgs];
    }

    // Pass through tool messages with their required fields
    if (m.role === "tool") {
      return [
        {
          role: "tool",
          tool_call_id: m.tool_call_id,
          name: m.name,
          content: m.content,
        },
      ];
    }

    // Standard message — include all media fields (images, video, audio, pdf)
    // Preserve thinking + thinkingSignature on assistant messages so Anthropic
    // can receive them back in multi-turn conversations (required by their API).
    return [
      {
        role: m.role,
        // @ts-ignore - TODO: strict typing
        ...(m.content?.trim() ? { content: m.content } : { content: " " }),
        // @ts-ignore - TODO: strict typing
        ...(m.images?.length > 0 ? { images: m.images } : {}),
        // @ts-ignore - TODO: strict typing
        ...(m.video?.length > 0 ? { video: m.video } : {}),
        // @ts-ignore - TODO: strict typing
        ...(m.audio?.length > 0 ? { audio: m.audio } : {}),
        // @ts-ignore - TODO: strict typing
        ...(m.pdf?.length > 0 ? { pdf: m.pdf } : {}),
        ...(m.role === "assistant" && m.thinking
          ? { thinking: m.thinking }
          : {}),
        ...(m.role === "assistant" && m.thinkingSignature
          ? { thinkingSignature: m.thinkingSignature }
          : {}),
      },
    ];
  });
}

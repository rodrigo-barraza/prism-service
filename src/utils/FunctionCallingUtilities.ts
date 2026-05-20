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
export function truncateToolResult(result: any, maxChars: any = 8000) {
  if (!result || typeof result !== "object") return result;

  // If result has a known array wrapper, cap items at 10
  const trimmed = { ...result };
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
        return str.length > maxChars ? str.slice(0, (maxChars as any)) + "…}" : sliced;
  }

  const str = JSON.stringify(trimmed);
    if (str.length <= maxChars) return trimmed;
    return str.slice(0, (maxChars as any)) + "…}";
}

/**
 * Expand a messages array into the format expected by LLM providers for
 * function calling. Assistant messages with toolCalls are expanded into
 * [assistant(tool_calls), tool(result1), tool(result2), ...] per the
 * OpenAI Chat Completions spec.
 */
export function expandMessagesForFC(
  messages: any,
  { filterDeleted = true }: any = {},
) {
  const filtered = filterDeleted
        ? (messages as any).filter(
        (m: any) =>
          !m.deleted &&
                    (m.role !== "assistant" || (m.content as any)?.trim() || (m.toolCalls as any)?.length),
      )
    : messages;

  return filtered.flatMap((m: any) => {
    // Expand assistant messages with toolCalls into
    // [assistant(tool_calls), tool(result1), tool(result2), ...]
        if (m.role === "assistant" && (m.toolCalls as any)?.length > 0) {
      const assistantMsg = {
        role: "assistant",
                content: (m.content as any)?.trim() || null,
        // Preserve thinking + signature for Anthropic multi-turn round-trips
                ...(m.thinking && { thinking: m.thinking }),
                ...(m.thinkingSignature && { thinkingSignature: m.thinkingSignature }),
                toolCalls: (m as any).toolCalls.map((tc: any) => ({
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
            const toolMsgs = (m as any).toolCalls
        .filter((tc: any) => tc.result !== undefined)
        .map((tc: any) => ({
          role: "tool",
          name: tc.name,
          tool_call_id: tc.id,
          content:
            typeof tc.result === "string"
              ? tc.result
                            : JSON.stringify(truncateToolResult((tc.result as any))),
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
                ...((m.content as any)?.trim() ? { content: m.content } : { content: " " }),
                ...((m.images as any)?.length > 0 ? { images: m.images } : {}),
                ...((m.video as any)?.length > 0 ? { video: m.video } : {}),
                ...((m.audio as any)?.length > 0 ? { audio: m.audio } : {}),
                ...((m.pdf as any)?.length > 0 ? { pdf: m.pdf } : {}),
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

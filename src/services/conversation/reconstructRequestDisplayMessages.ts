import type { ChatMessage } from "#src/types/admin";
import type { ToolCallPayload } from "./types.ts";
import { prepareDisplayMessages } from "./prepareDisplayMessages.ts";

/**
 * Server-side reconstruction of a display-ready chat preview from a persisted
 * request-log document (requestPayload.messages + canonical responsePayload).
 *
 * Request payloads persist messages close to the provider wire format, so
 * tool calls may appear as snake_case `tool_calls` with JSON-string
 * `function.arguments`, and tool-role messages may key their result by
 * `toolCallId` instead of `tool_call_id`. Everything is normalized to the
 * canonical shape before running the shared prepareDisplayMessages join.
 *
 * Consumed by GET /requests/:id so the frontend renders the chat preview
 * without re-implementing provider normalization (business-logic audit M2).
 */

interface RawWireToolCall {
  id?: string | null;
  name?: string;
  args?: unknown;
  status?: string;
  function?: { name?: string; arguments?: unknown };
}

interface CanonicalResponsePayload {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{
    name?: string;
    id?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    status?: string;
  }>;
  images?: string[];
}

function parseToolCallArguments(
  rawArguments: unknown,
): Record<string, unknown> {
  if (rawArguments && typeof rawArguments === "object") {
    return rawArguments as Record<string, unknown>;
  }
  if (typeof rawArguments === "string") {
    try {
      return JSON.parse(rawArguments) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Normalize a raw request-payload message to the canonical ChatMessage shape:
 * `tool_calls` → `toolCalls` (with parsed args), `toolCallId` → `tool_call_id`.
 */
function normalizeWireMessage(message: Record<string, unknown>): ChatMessage {
  let normalized = message as ChatMessage;

  if (!normalized.toolCalls && Array.isArray(message.tool_calls)) {
    const toolCalls = (message.tool_calls as RawWireToolCall[]).map(
      (toolCall) => ({
        id: toolCall.id ?? undefined,
        name: toolCall.name || toolCall.function?.name || "",
        args: parseToolCallArguments(
          toolCall.args !== undefined ? toolCall.args : toolCall.function?.arguments,
        ),
        ...(toolCall.status ? { status: toolCall.status } : {}),
      }),
    );
    normalized = { ...normalized, toolCalls: toolCalls as ToolCallPayload[] };
  }

  if (!normalized.tool_call_id && typeof message.toolCallId === "string") {
    normalized = { ...normalized, tool_call_id: message.toolCallId };
  }

  return normalized;
}

/**
 * Build display-ready messages (+ system prompt) for a request-log document.
 * Returns null when there is nothing to display.
 */
export function reconstructRequestDisplayMessages(requestDocument: {
  requestPayload?: { messages?: unknown } | null;
  responsePayload?: unknown;
  model?: string;
  provider?: string;
}): { displayMessages: ChatMessage[]; systemPrompt?: string } | null {
  const rawMessages = requestDocument.requestPayload?.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null;

  const chatMessages = (rawMessages as Record<string, unknown>[]).map(
    normalizeWireMessage,
  );

  const responsePayload = requestDocument.responsePayload as
    | CanonicalResponsePayload
    | null
    | undefined;
  if (responsePayload && typeof responsePayload === "object") {
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: responsePayload.text || "",
      ...(requestDocument.model ? { model: requestDocument.model } : {}),
      ...(requestDocument.provider
        ? { provider: requestDocument.provider }
        : {}),
    };
    if (responsePayload.thinking) {
      assistantMessage.thinking = responsePayload.thinking;
    }
    if (
      Array.isArray(responsePayload.toolCalls) &&
      responsePayload.toolCalls.length > 0
    ) {
      assistantMessage.toolCalls = responsePayload.toolCalls.map(
        (toolCall) => ({
          id: toolCall.id,
          name: toolCall.name || "",
          args: toolCall.args || {},
          result: toolCall.result,
          ...(toolCall.status ? { status: toolCall.status } : {}),
        }),
      ) as ToolCallPayload[];
    }
    if (
      Array.isArray(responsePayload.images) &&
      responsePayload.images.length > 0
    ) {
      assistantMessage.images = responsePayload.images;
    }

    const hasDisplayableContent =
      assistantMessage.content ||
      assistantMessage.toolCalls?.length ||
      assistantMessage.images?.length;
    if (hasDisplayableContent) {
      chatMessages.push(assistantMessage);
    }
  }

  const displayMessages = prepareDisplayMessages(chatMessages);
  if (displayMessages.length === 0) return null;

  const systemPromptContent = chatMessages.find(
    (message) => message.role === "system",
  )?.content;

  return {
    displayMessages,
    ...(typeof systemPromptContent === "string" && systemPromptContent
      ? { systemPrompt: systemPromptContent }
      : {}),
  };
}

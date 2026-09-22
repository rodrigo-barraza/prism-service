import { HOOKS } from "#src/constants";
import type { HookEventName, HookPayload } from "./types.ts";

/**
 * Build the base payload handed to a configured hook handler.
 *
 * Every event carries the same identity envelope so a handler can attribute
 * what it is being asked about without knowing which event fired. Event-specific
 * fields are merged on top by the call site.
 *
 * Deliberately shallow: this crosses a process boundary for `http` handlers and
 * gets JSON-stringified into a prompt for `prompt` handlers, so it must not
 * carry the whole message history or anything non-serializable (`emit`,
 * `signal`, provider instances all live on the context and stay there).
 */
export function buildHookPayload(
  event: HookEventName,
  context: {
    conversationId?: string | null;
    agentConversationId?: string | null;
    parentAgentConversationId?: string | null;
    project?: string | null;
    username?: string | null;
    agent?: string | null;
    workspaceRoot?: string | null;
  },
  extra: Record<string, unknown> = {},
): HookPayload {
  const payload: HookPayload = {
    hook_event_name: event,
    session_id: context.conversationId || "",
    agent_conversation_id: context.agentConversationId || "",
    project: context.project || "any",
    username: context.username || "any",
    agent: context.agent || null,
    cwd: context.workspaceRoot || null,
    ...extra,
  };
  if (context.parentAgentConversationId) {
    payload.parent_agent_conversation_id = context.parentAgentConversationId;
  }
  return payload;
}

/** One transcript entry as a hook payload carries it. */
export interface HookTranscriptEntry {
  role: string;
  content: string;
  tool_calls?: string[];
}

/**
 * The tail of a conversation, reduced to what a hook can use: role, text,
 * and the names of any tool calls, each message capped. `Interrupt` payloads
 * and `agent` verifiers carry it; the full history never crosses the hook
 * boundary (images, thinking signatures and provider state stay behind).
 */
export function summarizeTranscript(
  messages: ReadonlyArray<Record<string, unknown>> | null | undefined,
  maxMessages: number = HOOKS.TRANSCRIPT_MESSAGES,
  maxChars: number = HOOKS.TRANSCRIPT_MESSAGE_CHARS,
): HookTranscriptEntry[] {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-maxMessages).map((message) => {
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) =>
                part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join("")
          : "";
    const entry: HookTranscriptEntry = {
      role: typeof message.role === "string" ? message.role : "unknown",
      content: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
    };
    const toolCalls = message.toolCalls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      entry.tool_calls = toolCalls.map((toolCall) => String((toolCall as { name?: unknown })?.name ?? "?"));
    }
    return entry;
  });
}

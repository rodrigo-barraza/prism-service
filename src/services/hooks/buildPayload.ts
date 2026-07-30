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

import { HOOKS } from "#src/constants";
import { transcriptPathFor } from "./ClaudeTranscript.ts";
import {
  claudePermissionModeOf,
  turnHookFacts,
  type TurnHookFacts,
} from "./TurnHookFacts.ts";
import { HOOK_HARNESS_NAME } from "./WorkspaceHookConstants.ts";
import type { HookEventName, HookPayload } from "./types.ts";

/** What a payload is built from: the run's identity, and whatever it knows of the turn. */
export interface HookPayloadIdentity {
  conversationId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  workspaceRoot?: string | null;
  /**
   * The turn's facts, for a payload built after the turn closed (SessionEnd).
   * While it runs they are found by `agentConversationId`.
   */
  hookFacts?: TurnHookFacts | null;
  /** A full agentic context's loop options — its permission mode, when no facts are recorded. */
  options?: { _permissionMode?: unknown; autoApprove?: unknown } | null;
}

/**
 * Build the base payload handed to a configured hook handler.
 *
 * Every event carries the same identity envelope so a handler can attribute
 * what it is being asked about without knowing which event fired — Claude
 * Code's input fields (`session_id`, `transcript_path`, `cwd`,
 * `permission_mode`, `hook_event_name`) and Prism's, plus `harness`,
 * `workspace_root` and, on a sub-agent run, `agent_id`. Event-specific
 * fields are merged on top by the call site.
 *
 * Deliberately shallow: this crosses a process boundary for `http` handlers and
 * gets JSON-stringified into a prompt for `prompt` handlers, so it must not
 * carry the whole message history or anything non-serializable (`emit`,
 * `signal`, provider instances all live on the context and stay there).
 */
export function buildHookPayload(
  event: HookEventName,
  context: HookPayloadIdentity,
  extra: Record<string, unknown> = {},
): HookPayload {
  const facts = context.hookFacts ?? turnHookFacts(context.agentConversationId);
  const workspaceRoot = facts?.workspaceRoot ?? context.workspaceRoot ?? null;
  const payload: HookPayload = {
    hook_event_name: event,
    session_id: context.conversationId || "",
    transcript_path: transcriptPathFor(context.conversationId),
    cwd: workspaceRoot,
    permission_mode: facts ? facts.permissionMode() : claudePermissionModeOf(context.options),
    harness: HOOK_HARNESS_NAME,
    workspace_root: workspaceRoot,
    agent_conversation_id: context.agentConversationId || "",
    project: context.project || "any",
    username: context.username || "any",
    agent: context.agent || null,
    ...extra,
  };
  if (context.parentAgentConversationId) {
    payload.parent_agent_conversation_id = context.parentAgentConversationId;
    payload.agent_id = context.agentConversationId || "";
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

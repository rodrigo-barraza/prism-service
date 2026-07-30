/**
 * XML tags for mid-conversation system-role messages.
 *
 * Every system message the harness injects mid-conversation MUST be wrapped
 * in one of these tags via wrapSystemMessage(). Providers that don't support
 * role: "system" mid-conversation (Gemini, most Claude models, some vLLM
 * chat templates) demote these messages to user role — the tag is the only
 * signal that lets the model distinguish harness instructions from genuine
 * user input, and it hardens against users spoofing harness messages.
 *
 * Naming follows the existing <tool-update> / <task-notification> convention:
 * semantic, kebab-case, one tag per message family.
 *
 * Canonical wrap format (shared with the system prompt's section tags via
 * wrapTag): tags sit on their own lines with a blank line between tag and
 * content, so every tagged block reads identically everywhere:
 *
 *   <tag-name>
 *
 *   content
 *
 *   </tag-name>
 */
export const SYSTEM_MESSAGE_TAGS = {
  /** Dynamic tool-set changes (tools enabled/disabled mid-conversation). */
  TOOL_UPDATE: "tool-update",
  /** Sub-agent lifecycle notifications delivered to a parent agent. */
  TASK_NOTIFICATION: "task-notification",
  /** Structured retry guidance after failed tool calls. */
  TOOL_RETRY: "tool-retry-guidance",
  /** Validation errors from edits or strategy branches. */
  VALIDATION_ERRORS: "validation-errors",
  /** Proactive backtrack guidance from ToT/GoT strategies. */
  BACKTRACK: "backtrack-guidance",
  /** Semantic stall / behavioral loop warning. */
  BEHAVIORAL_LOOP: "behavioral-loop-warning",
  /** Recovery prompt after an empty model response. */
  EMPTY_OUTPUT: "empty-output-recovery",
  /** Max tool-call iterations reached — wrap up now. */
  ITERATION_LIMIT: "iteration-limit",
  /** Continuation prompt after output-token truncation. */
  TRUNCATION_RECOVERY: "truncation-recovery",
  /** Nudge to proceed after a plan was stated without tool calls. */
  CONTINUATION_NUDGE: "continuation-nudge",
  /** Periodic re-injection of core behavioral constraints. */
  SYSTEM_REMINDER: "system-reminder",
  /** Periodic proprioceptive ledger of the context window's contents. */
  CONTEXT_LEDGER: "context-ledger",
  /** Plan-mode state changes and blocked-tool notices. */
  PLAN_MODE: "plan-mode",
  /** Sub-agent operational context (topology, position, workspace). */
  OPERATIONAL_CONTEXT: "operational-context",
  /** Per-turn injected context header (local time, runtime facts). */
  SYSTEM_CONTEXT: "system-context",
  /** Relevance-filtered project skills injected alongside system context. */
  PROJECT_SKILLS: "project-skills",
  /** Embedding-matched long-term memories injected alongside system context. */
  AGENT_MEMORY: "agent-memory",
  /** Cross-conversation procedural workflows injected alongside system context. */
  PAST_WORKFLOWS: "past-workflows",
  /** Runtime platform data (server/channel/participant info, image captions). */
  PLATFORM_CONTEXT: "platform-context",
  /** Agent self context (somatic/emotional state). */
  SELF_CONTEXT: "self-context",
  /** Context injected by a user-configured lifecycle hook. */
  HOOK_CONTEXT: "hook-context",
} as const;

export type SystemMessageTag =
  (typeof SYSTEM_MESSAGE_TAGS)[keyof typeof SYSTEM_MESSAGE_TAGS];

/**
 * Wrap content in an XML tag using the canonical block format: tag lines
 * above and below the content, separated by blank lines. Single source of
 * truth for tag formatting — used by both the system prompt assembler's
 * section tags and mid-conversation system messages.
 */
export function wrapTag(tagName: string, content: string): string {
  return `<${tagName}>\n\n${content}\n\n</${tagName}>`;
}

/** Wrap system-message content in its semantic XML tag. */
export function wrapSystemMessage(
  tag: SystemMessageTag,
  content: string,
): string {
  return wrapTag(tag, content);
}

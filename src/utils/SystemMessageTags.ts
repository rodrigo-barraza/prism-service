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
  /** Plan-mode state changes and blocked-tool notices. */
  PLAN_MODE: "plan-mode",
  /** Sub-agent operational context (topology, position, workspace). */
  OPERATIONAL_CONTEXT: "operational-context",
} as const;

export type SystemMessageTag =
  (typeof SYSTEM_MESSAGE_TAGS)[keyof typeof SYSTEM_MESSAGE_TAGS];

/** Wrap system-message content in its semantic XML tag. */
export function wrapSystemMessage(
  tag: SystemMessageTag,
  content: string,
): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

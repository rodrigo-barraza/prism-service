import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { resolveToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ConversationMessage,
  ToolCall,
  ToolResult,
} from "#src/services/harnesses/types";

/**
 * PlanModeGate — plan mode without touching the request prefix.
 *
 * Plan mode used to swap the request's tools for `[exit_plan_mode]` and
 * splice a planning instruction into the top of the history, then undo
 * both on exit: three prefix rewrites, each a full cache miss (and, on
 * Claude models with preserved thinking, invalid thinking blocks). Now the
 * tool list never changes; read-only is enforced here, as a gate on the
 * calls, and entering / leaving plan mode is announced by a system message
 * appended after the batch that changed it.
 */

/** Capabilities a call may carry and still run in plan mode. */
const PLAN_MODE_READ_ONLY_CAPABILITIES = new Set<string>(["fs_read", "network", "mcp"]);

/**
 * Whether plan mode lets a tool run: the plan-mode tools themselves, and
 * tools whose declared capabilities only read (permissions/ToolCapabilities).
 * An undeclared tool resolves to `external_side_effect` and is blocked.
 */
export function isPlanModeReadOnlyTool(toolName: string): boolean {
  if (
    toolName === TOOL_NAMES.EXIT_PLAN_MODE ||
    toolName === TOOL_NAMES.ENTER_PLAN_MODE
  ) {
    return true;
  }
  return resolveToolCapabilities(toolName).every((capability) =>
    PLAN_MODE_READ_ONLY_CAPABILITIES.has(capability),
  );
}

/**
 * Split a plan-mode batch: calls that only read run as usual; any other
 * call does not run and gets an error result the model can plan around.
 */
export function gatePlanModeCalls(
  toolCalls: ToolCall[],
  locale?: string,
): { callable: ToolCall[]; rejected: ToolResult[] } {
  const callable: ToolCall[] = [];
  const blocked: ToolCall[] = [];
  for (const toolCall of toolCalls) {
    (isPlanModeReadOnlyTool(toolCall.name) ? callable : blocked).push(toolCall);
  }
  if (blocked.length === 0) return { callable, rejected: [] };

  const blockedNames = [...new Set(blocked.map((toolCall) => toolCall.name))].join(", ");
  logger.warn(
    `[PlanningMode] Blocked ${blocked.length} non-read-only tool call(s) in plan mode: ${blockedNames}`,
  );
  const message = PromptLocaleService.get(
    locale || PromptLocaleService.getDefaultLocale(),
    "harness.planningMode.blockedNotReadOnly",
    { blockedNames },
  );
  return {
    callable,
    rejected: blocked.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      result: { error: message, planMode: true },
    })),
  };
}

/**
 * The system message announcing a plan-mode change. Never persisted (the
 * mode is per turn); `_isPlanModeNotice` marks it for the persistence
 * filter. Distinct from the branching strategies' `_isPlanningInjection`,
 * which they splice in and strip out.
 */
export function planModeNotice(
  change: "entered" | "exited",
  locale?: string,
): ConversationMessage {
  return {
    role: "system",
    content: wrapSystemMessage(
      SYSTEM_MESSAGE_TAGS.PLAN_MODE,
      PromptLocaleService.get(
        locale || PromptLocaleService.getDefaultLocale(),
        change === "entered"
          ? "harness.planningMode.planModeOn"
          : "harness.planningMode.planModeOff",
      ),
    ),
    _isPlanModeNotice: true,
  };
}

/** Append the pending plan-mode notice, if any (after the batch's assistant message). */
export function flushPlanModeNotice(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  locale?: string,
): void {
  const change = state.pendingPlanModeNotice;
  if (!change) return;
  state.pendingPlanModeNotice = null;
  currentMessages.push(planModeNotice(change, locale));
}

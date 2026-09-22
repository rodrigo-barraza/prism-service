import PlanningModeService from "#src/services/PlanningModeService";
import { pendingApprovals } from "#src/services/ApprovalRegistry";
import PromptLocaleService from "#src/services/PromptLocaleService";
import logger from "#src/utils/logger";
import { HARNESS } from "#src/constants";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ToolCall,
  ToolResult,
  PassState,
  ConversationMessage,
  AgenticContext,
  EmitFunction,
} from "#src/services/harnesses/types";

/**
 * PlanModeController — manages plan mode state transitions during the agentic loop.
 *
 * Handles:
 *   - Blocking unauthorized tool calls during planning mode
 *   - Processing exit_plan_mode (proposal emission + user approval gate)
 *   - Entering/exiting plan mode based on tool calls
 *
 * Extracted from ReActHarness to allow future plan-aware harnesses
 * to reuse the same plan lifecycle without duplicating the logic.
 */

const PLAN_APPROVAL_TIMEOUT_MILLISECONDS = HARNESS.APPROVAL_TIMEOUT_MILLISECONDS;

/**
 * Filter out unauthorized tool calls during plan mode.
 * Only exit_plan_mode is allowed; all others are blocked and logged.
 */
export function blockUnauthorizedToolCalls(
  pendingToolCalls: ToolCall[],
  currentMessages: ConversationMessage[],
  pass: PassState,
  _state: AgenticLoopState,
  locale?: string,
): { allBlocked: boolean } {
  const blockedToolCalls = pendingToolCalls.filter(
    (toolCall) => toolCall.name !== TOOL_NAMES.EXIT_PLAN_MODE,
  );

  if (blockedToolCalls.length === 0) {
    return { allBlocked: false };
  }

  const blockedToolNames = blockedToolCalls
    .map((toolCall) => toolCall.name)
    .join(", ");

  logger.warn(
    `[PlanningMode] Blocked ${blockedToolCalls.length} unauthorized tool call(s): ${blockedToolNames}`,
  );

  // Remove blocked calls from the pending array
  for (const blockedCall of blockedToolCalls) {
    const index = pendingToolCalls.indexOf(blockedCall);
    if (index >= 0) pendingToolCalls.splice(index, 1);
  }

  if (pendingToolCalls.length === 0) {
    // All tool calls were blocked — add system feedback and continue loop
    if (pass.finalStreamedText || pass.streamedText) {
      currentMessages.push({
        role: "assistant",
        content: pass.finalStreamedText || pass.streamedText,
        ...(pass.streamedThinking && {
          thinking: pass.streamedThinking,
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
      });
    }

    currentMessages.push({
      role: "system",
      content: wrapSystemMessage(
        SYSTEM_MESSAGE_TAGS.PLAN_MODE,
        PromptLocaleService.get(
          locale || PromptLocaleService.getDefaultLocale(),
          "harness.planningMode.blocked",
          { blockedNames: blockedToolNames },
        ),
      ),
    });

    return { allBlocked: true };
  }

  return { allBlocked: false };
}

/**
 * Handle the exit_plan_mode tool call: emit the plan proposal,
 * wait for user approval, and transition out of plan mode.
 *
 * Either way the decision is written into the exit_plan_mode tool result, so
 * the caller's assistant message carries the plan AND the verdict. On a
 * rejection, a timeout or an abort the caller must still finalize the turn
 * (persist, clear isGenerating, emit `done`) — this function emits no `done`
 * of its own.
 */
export async function handleExitPlanMode(
  exitPlanToolCall: ToolCall,
  pass: PassState,
  toolResults: ToolResult[],
  currentMessages: ConversationMessage[],
  context: AgenticContext,
  state: AgenticLoopState,
): Promise<{ shouldContinueLoop: boolean }> {
  const { options, emit, signal, conversationId } = context;

  // Models that stream no plan text put it in the tool's `summary` argument.
  const summaryArgument = exitPlanToolCall.args?.summary;
  const planText =
    state.planModeText.trim() ||
    pass.streamedText.trim() ||
    (typeof summaryArgument === "string" ? summaryArgument.trim() : "");
  const planSteps = PlanningModeService.extractSteps(planText);

  logger.info(
    `[PlanningMode] exit_plan_mode called — planText=${planText.length} chars, steps=${planSteps.length}, autoApprove=${!!options.autoApprove}`,
  );

  emit({
    type: "plan_proposal",
    plan: planText,
    steps: planSteps,
    autoApproved: !!options.autoApprove,
  });

  let planDecision: "approved" | "rejected" | "timed_out";
  if (options.autoApprove) {
    planDecision = "approved";
    logger.info("[PlanningMode] Auto-approved plan (autoApprove=true)");
  } else {
    planDecision = await new Promise<"approved" | "rejected" | "timed_out">((resolve) => {
      const timeoutId = setTimeout(() => {
        pendingApprovals.delete(conversationId);
        resolve("timed_out");
      }, PLAN_APPROVAL_TIMEOUT_MILLISECONDS);

      const existingApproval = pendingApprovals.get(conversationId);
      if (existingApproval) {
        existingApproval.resolve(false as never);
        pendingApprovals.delete(conversationId);
      }

      pendingApprovals.set(conversationId, {
        resolve: (value: boolean) => {
          clearTimeout(timeoutId);
          pendingApprovals.delete(conversationId);
          resolve(value ? "approved" : "rejected");
        },
        type: "plan",
      });
    });
  }

  const locale =
    (options?.locale as string | undefined) ||
    PromptLocaleService.getDefaultLocale();
  const exitResult = toolResults.find(
    (result) =>
      result.id === exitPlanToolCall.id ||
      result.name === TOOL_NAMES.EXIT_PLAN_MODE,
  );

  if (planDecision !== "approved" || signal?.aborted) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: PromptLocaleService.get(
        locale,
        "harness.planningMode.rejectionStatus",
      ),
    });
    // The plan and the verdict are part of the turn: the caller pushes the
    // assistant message carrying this result and finalizes.
    if (exitResult) {
      exitResult.result = {
        isApproved: false,
        status: signal?.aborted ? "aborted" : planDecision,
        message: PromptLocaleService.get(
          locale,
          "harness.planningMode.rejectionResult",
        ),
        plan: planText,
      };
    }
    state.conversationOutcome = "plan_rejected";
    return { shouldContinueLoop: false };
  }

  // Inject approved plan text into the exit_plan_mode result
  if (exitResult) {
    exitResult.result = {
      isApproved: true,
      message: `${PromptLocaleService.get(locale, "harness.planningMode.approvalResult")}\n\n${planText}`,
    };
  }

  state.planModeActive = false;
  state.planModeText = "";
  PlanningModeService.stripPlanningInstruction(currentMessages);
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.PLAN_MODE_EXITED,
  });

  return { shouldContinueLoop: true };
}

/** Check if any tool calls enter plan mode and apply the transition. */
export async function checkForPlanModeEntry(
  executedToolCalls: ToolCall[],
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  emit: EmitFunction,
  locale?: string,
): Promise<void> {
  const hasEnterPlanMode = executedToolCalls.some(
    (toolCall) => toolCall.name === TOOL_NAMES.ENTER_PLAN_MODE,
  );

  if (hasEnterPlanMode) {
    state.planModeActive = true;
    state.planModeText = "";
    await PlanningModeService.injectPlanningInstruction(
      currentMessages,
      locale,
    );
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
  }
}

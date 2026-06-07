import PlanningModeService from "../../PlanningModeService.ts";
import { pendingApprovals } from "../../ApprovalRegistry.ts";
import logger from "../../../utils/logger.ts";
import { SSE_EVENT_TYPES, STATUS_MESSAGES, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ToolCall,
  ToolResult,
  PassState,
  ConversationMessage,
  AgenticContext,
  EmitFunction,
} from "../types.ts";

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

const PLAN_APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Filter out unauthorized tool calls during plan mode.
 * Only exit_plan_mode is allowed; all others are blocked and logged.
 */
export function blockUnauthorizedToolCalls(
  pendingToolCalls: ToolCall[],
  currentMessages: ConversationMessage[],
  pass: PassState,
  _state: AgenticLoopState,
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
    if (pass.streamedText) {
      currentMessages.push({
        role: "assistant",
        content: pass.streamedText,
        ...(pass.streamedThinking && {
          thinking: pass.streamedThinking,
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
      });
    }

    currentMessages.push({
      role: "user",
      content: `[SYSTEM] You are in PLANNING MODE. Your tool call(s) [${blockedToolNames}] were blocked because only exit_plan_mode is available during planning. You MUST call exit_plan_mode to present your plan for approval before any other tools can be used.`,
    });

    return { allBlocked: true };
  }

  return { allBlocked: false };
}

/**
 * Handle the exit_plan_mode tool call: emit the plan proposal,
 * wait for user approval, and transition out of plan mode.
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

  const planText = state.planModeText.trim() || pass.streamedText.trim();
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

  let planApproved: boolean;
  if (options.autoApprove) {
    planApproved = true;
    logger.info("[PlanningMode] Auto-approved plan (autoApprove=true)");
  } else {
    planApproved = await new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        pendingApprovals.delete(conversationId);
        resolve(false);
      }, PLAN_APPROVAL_TIMEOUT_MS);

      pendingApprovals.set(conversationId, {
        resolve: (value: boolean) => {
          clearTimeout(timeoutId);
          pendingApprovals.delete(conversationId);
          resolve(value);
        },
        type: "plan",
      });
    });
  }

  if (!planApproved || signal?.aborted) {
    emit({
      type: SSE_EVENT_TYPES.STATUS,
      message: "Plan rejected — execution cancelled.",
    });
    emit({
      type: SSE_EVENT_TYPES.DONE,
      usage: state.overallUsage,
      totalTime: (performance.now() - (context.requestStart ?? performance.now())) / 1000,
    });
    return { shouldContinueLoop: false };
  }

  // Inject approved plan text into the exit_plan_mode result
  const exitResult = toolResults.find(
    (result) =>
      result.id === exitPlanToolCall.id || result.name === TOOL_NAMES.EXIT_PLAN_MODE,
  );
  if (exitResult) {
    exitResult.result = {
      approved: true,
      message: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.\n\n${planText}`,
    };
  }

  state.planModeActive = false;
  state.planModeText = "";
  PlanningModeService.stripPlanningInstruction(currentMessages);
  emit({ type: SSE_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_EXITED });

  return { shouldContinueLoop: true };
}

/** Check if any tool calls enter plan mode and apply the transition. */
export function checkForPlanModeEntry(
  executedToolCalls: ToolCall[],
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  emit: EmitFunction,
): void {
  const hasEnterPlanMode = executedToolCalls.some(
    (toolCall) => toolCall.name === TOOL_NAMES.ENTER_PLAN_MODE,
  );

  if (hasEnterPlanMode) {
    state.planModeActive = true;
    state.planModeText = "";
    PlanningModeService.injectPlanningInstruction(currentMessages);
    emit({ type: SSE_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
  }
}

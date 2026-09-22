import PlanningModeService from "#src/services/PlanningModeService";
import crypto from "node:crypto";
import { ApprovalRegistry, type ToolCallDecision } from "#src/services/ApprovalRegistry";
import { resolveLoopKey } from "#src/services/LoopKey";
import { decisionOwnerOf } from "#src/services/conversation/ConversationRunState";
import PromptLocaleService from "#src/services/PromptLocaleService";
import logger from "#src/utils/logger";
import { APPROVALS } from "#src/constants";
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
        ...(pass.thinkingBlocks?.length && {
          thinkingBlocks: pass.thinkingBlocks,
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
 * the caller's assistant message carries the plan AND the verdict. There is
 * no timeout: the proposal is recorded (PendingDecisionStore) before it is
 * shown and the turn parks until the user decides. On a rejection or an
 * abort the caller must still finalize the turn
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
  const { options, emit, signal } = context;

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

  // The plan is decided like any other call: by the exit_plan_mode call's
  // id, through the same registry and POST /agent/approve as tool cards.
  const batchId = crypto.randomUUID();
  const toolCallId = exitPlanToolCall.id || `${batchId}:plan`;

  let planDecision: "approved" | "rejected";
  let rejectionReason: string | undefined;
  let decisionsPromise: Promise<Map<string, ToolCallDecision>> | null = null;
  const loopKey = resolveLoopKey(context);
  if (!options.autoApprove) {
    // Recorded first, THEN shown — as ApprovalGate does for tool cards.
    ({ decisions: decisionsPromise } = await ApprovalRegistry.open(
      loopKey,
      {
        type: "plan",
        batchId,
        calls: [{ toolCallId, name: exitPlanToolCall.name, args: { plan: planText } }],
        onDecided: (decidedToolCallId, decision) => {
          emit({
            type: APPROVALS.DECIDED_EVENT_TYPE,
            toolCallId: decidedToolCallId,
            batchId,
            decision: decision.decision,
            scope: decision.scope,
            source: decision.source,
            ...(decision.reason ? { reason: decision.reason } : {}),
          });
        },
      },
      decisionOwnerOf(context),
    ));
  }

  emit({
    type: "plan_proposal",
    plan: planText,
    steps: planSteps,
    autoApproved: !!options.autoApprove,
    toolCallId,
    batchId,
  });

  if (!decisionsPromise) {
    planDecision = "approved";
    logger.info("[PlanningMode] Auto-approved plan (autoApprove=true)");
  } else {
    const cancelOnAbort = () => void ApprovalRegistry.cancel(loopKey);
    signal?.addEventListener("abort", cancelOnAbort, { once: true });
    if (signal?.aborted) cancelOnAbort();
    try {
      const decision = (await decisionsPromise).get(toolCallId);
      planDecision = decision?.decision === "allow" ? "approved" : "rejected";
      rejectionReason = decision?.reason;
      if (planDecision === "approved" && decision?.scope === "conversation") {
        options.autoApprove = true;
      }
    } finally {
      signal?.removeEventListener("abort", cancelOnAbort);
    }
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
        rejectionReason
          ? "harness.planningMode.rejectionStatusWithReason"
          : "harness.planningMode.rejectionStatus",
        rejectionReason ? { reason: rejectionReason } : undefined,
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
        ...(rejectionReason ? { reason: rejectionReason } : {}),
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

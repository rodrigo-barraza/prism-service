import PlanningModeService from "#src/services/PlanningModeService";
import crypto from "node:crypto";
import { ApprovalRegistry, type ToolCallDecision } from "#src/services/ApprovalRegistry";
import { resolveLoopKey } from "#src/services/LoopKey";
import { decisionOwnerOf } from "#src/services/conversation/ConversationRunState";
import PromptLocaleService from "#src/services/PromptLocaleService";
import logger from "#src/utils/logger";
import { APPROVALS } from "#src/constants";
import ConversationApprovalSettings from "#src/services/ConversationApprovalSettings";
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
 *   - Processing exit_plan_mode (proposal emission + user approval gate)
 *   - Entering/exiting plan mode based on tool calls
 *
 * Extracted from ReActHarness to allow future plan-aware harnesses
 * to reuse the same plan lifecycle without duplicating the logic.
 */

/**
 * An approved plan ends plan mode: the conversation's permission mode goes
 * back to `default` — for this turn (the handle every engine in the tree
 * reads) and for the turns after it (stored on the conversation). Anything
 * other than `plan` is left as the user set it.
 */
function leavePlanPermissionMode(context: AgenticContext): void {
  const handle = context.options._permissionMode;
  if (handle?.mode !== "plan") return;
  handle.set("default", "plan_approved");
  if (context.options.isSubAgent || !context.conversationId) return;
  void ConversationApprovalSettings.setPermissionMode(
    context.conversationId,
    context.project,
    context.username,
    "default",
  ).catch((error: unknown) =>
    logger.warn(`[PlanningMode] Could not store the mode after the plan was approved: ${String(error)}`),
  );
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

  // A denied exit_plan_mode proposes nothing: its tool result already says
  // why (a deny rule, or a run nobody watches — where a plan card would
  // park the turn on a person who will never come). The loop goes on.
  if (exitPlanToolCall._approval?.isDenied) {
    return { shouldContinueLoop: true };
  }

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
  let batchId: string = crypto.randomUUID();
  const toolCallId = exitPlanToolCall.id || `${batchId}:plan`;

  let planDecision: "approved" | "rejected";
  let rejectionReason: string | undefined;
  let decisionsPromise: Promise<Map<string, ToolCallDecision>> | null = null;
  // A pass replayed after a restart picks up the proposal it made before
  // (ResumedPass): a decision already made is applied, not asked again.
  let isProposalPending = true;
  const loopKey = resolveLoopKey(context);
  if (!options.autoApprove) {
    // Recorded first, THEN shown — as ApprovalGate does for tool cards.
    const opened = await ApprovalRegistry.open(
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
      { resume: pass.replayed === true },
    );
    decisionsPromise = opened.decisions;
    batchId = opened.batchId;
    isProposalPending = opened.pendingToolCallIds.length > 0;
  }

  if (isProposalPending) {
    emit({
      type: "plan_proposal",
      plan: planText,
      steps: planSteps,
      autoApproved: !!options.autoApprove,
      toolCallId,
      batchId,
    });
  }

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
  leavePlanPermissionMode(context);
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.PLAN_MODE_EXITED,
  });

  return { shouldContinueLoop: true };
}

/**
 * Check if any tool calls enter plan mode and apply the transition. The
 * tool list stays as it is (PlanModeGate.ts enforces read-only), and the
 * "plan mode is on" notice is appended after the batch's assistant message
 * (PlanModeNotice.ts) — never spliced into history.
 */
export async function checkForPlanModeEntry(
  executedToolCalls: ToolCall[],
  _currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  emit: EmitFunction,
  _locale?: string,
): Promise<void> {
  const hasEnterPlanMode = executedToolCalls.some(
    (toolCall) => toolCall.name === TOOL_NAMES.ENTER_PLAN_MODE,
  );

  if (hasEnterPlanMode && !state.planModeActive) {
    state.planModeActive = true;
    state.planModeText = "";
    state.pendingPlanModeNotice = "entered";
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
  }
}

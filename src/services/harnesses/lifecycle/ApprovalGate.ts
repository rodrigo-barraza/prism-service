import { pendingApprovals } from "#src/services/ApprovalRegistry";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { ToolCall, AgenticContext } from "#src/services/harnesses/types";
import type AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { HARNESS } from "#src/constants";

/**
 * ApprovalGate — extracted approval gating logic.
 *
 * Handles the promise-based approval pattern: emit approval_required events,
 * register a pending approval resolver, wait for the user's response
 * (or timeout after 2 minutes), and return the decision.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

const APPROVAL_TIMEOUT_MILLISECONDS = HARNESS.APPROVAL_TIMEOUT_MILLISECONDS;

/**
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user responds or timeout occurs.
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
): Promise<{
  isApproved: boolean;
  shouldApproveAll: boolean;
  /** Policy-denied calls — terminal rejections that must not execute and are never user-approvable. */
  deniedToolCalls: ToolCall[];
}> {
  const { conversationId, emit, options } = context;

  const { needsApproval, denied = [] } = approvalEngine.checkBatch(toolCalls);

  if (denied.length > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution denied by policy: ${denied.map((toolCall) => toolCall.name).join(", ")}`,
    });
  }

  const deniedIds = new Set(denied.map((toolCall) => toolCall.id));
  const deniedToolCalls = toolCalls.filter((toolCall) =>
    deniedIds.has(toolCall.id),
  );

  if (needsApproval.length === 0 || options.autoApprove) {
    // Mid-loop "approve all" (options.autoApprove flipped after engine
    // construction) — stamp the skipped-over calls as approved so the
    // decide-hook pass in ToolExecutor doesn't re-veto them.
    if (options.autoApprove) {
      for (const toolCall of toolCalls) {
        if (toolCall._approval && !toolCall._approval.isDenied) {
          toolCall._approval = {
            ...toolCall._approval,
            isApproved: true,
            reason: toolCall._approval.isApproved
              ? toolCall._approval.reason
              : "approve_all",
          };
        }
      }
    }
    return { isApproved: true, shouldApproveAll: false, deniedToolCalls };
  }

  // Emit approval_required events for each tool needing approval
  for (const toolCallRequiringApproval of needsApproval) {
    emit({
      type: "approval_required",
      toolCall: {
        name: toolCallRequiringApproval.name,
        args: toolCallRequiringApproval.args,
        id: toolCallRequiringApproval.id,
      },
      tier: toolCallRequiringApproval._approval?.tier,
      tierLabel: toolCallRequiringApproval._approval?.tierLabel,
    });
  }

  // Wait for user approval or timeout
  const approvalResult = await new Promise<
    import("../../ApprovalRegistry.ts").ApprovalResolution
  >((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(conversationId);
      resolve({ isApproved: false, reason: "timeout" });
    }, APPROVAL_TIMEOUT_MILLISECONDS);

    const existingApproval = pendingApprovals.get(conversationId);
    if (existingApproval) {
      existingApproval.resolve({
        isApproved: false,
        reason: "superseded",
      } as never);
      pendingApprovals.delete(conversationId);
    }

    pendingApprovals.set(conversationId, {
      resolve: (
        value: import("../../ApprovalRegistry.ts").ApprovalResolution,
      ) => {
        clearTimeout(timeoutId);
        pendingApprovals.delete(conversationId);
        resolve(value);
      },
      type: "tool",
      tools: needsApproval.map((toolCall) => toolCall.name),
      toolCalls: needsApproval.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        _approval: {
          tier: String(toolCall._approval.tier),
          tierLabel: toolCall._approval.tierLabel,
        },
      })),
    });
  });

  if (!approvalResult?.isApproved) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution rejected: ${needsApproval.map((toolCall) => toolCall.name).join(", ")}`,
    });
    return { isApproved: false, shouldApproveAll: false, deniedToolCalls };
  }

  // Stamp the user's decision onto the original tool call objects so the
  // decide-hook pass in ToolExecutor honors it instead of re-vetoing.
  for (const toolCall of toolCalls) {
    if (
      toolCall._approval &&
      !toolCall._approval.isDenied &&
      !toolCall._approval.isApproved
    ) {
      toolCall._approval = {
        ...toolCall._approval,
        isApproved: true,
        reason: "user_approved",
      };
    }
  }

  if (approvalResult.shouldApproveAll) {
    return { isApproved: true, shouldApproveAll: true, deniedToolCalls };
  }

  return { isApproved: true, shouldApproveAll: false, deniedToolCalls };
}

import { pendingApprovals } from "../../ApprovalRegistry.ts";
import type { ToolCall, AgenticContext } from "../types.ts";
import type AutoApprovalEngine from "../../AutoApprovalEngine.ts";

/**
 * ApprovalGate — extracted approval gating logic.
 *
 * Handles the promise-based approval pattern: emit approval_required events,
 * register a pending approval resolver, wait for the user's response
 * (or timeout after 2 minutes), and return the decision.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user responds or timeout occurs.
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
): Promise<{ approved: boolean; approveAll: boolean }> {
  const { agentSessionId, emit, options } = context;

    const { needsApproval } = approvalEngine.checkBatch((toolCalls as any));

  if (needsApproval.length === 0 || options.autoApprove) {
    return { approved: true, approveAll: false };
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
            tier: (toolCallRequiringApproval._approval as any)?.tier,
            tierLabel: (toolCallRequiringApproval._approval as any)?.tierLabel,
    });
  }

  // Wait for user approval or timeout
  const approvalResult = await new Promise<{
    approved: boolean;
    approveAll?: boolean;
    reason?: string;
  }>((resolve: unknown) => {
    const timeoutId = setTimeout(() => {
      pendingApprovals.delete(agentSessionId);
      (resolve as any)({ approved: false, reason: "timeout" });
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(agentSessionId, {
      resolve: (value: {
        approved: boolean;
        approveAll?: boolean;
        reason?: string;
      }) => {
        clearTimeout(timeoutId);
        pendingApprovals.delete(agentSessionId);
        (resolve as any)(value);
      },
      type: "tool",
      tools: needsApproval.map((toolCall: unknown) => (toolCall as any).name),
    });
  });

  if (!approvalResult?.approved) {
    emit({
      type: "status",
      message: `Tool execution rejected: ${needsApproval.map((toolCall: unknown) => (toolCall as any).name).join(", ")}`,
    });
    return { approved: false, approveAll: false };
  }

  if (approvalResult.approveAll) {
    return { approved: true, approveAll: true };
  }

  return { approved: true, approveAll: false };
}

import { pendingApprovals } from "#src/services/ApprovalRegistry";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { ToolCall, AgenticContext } from "#src/services/harnesses/types";
import type AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import type AgentHooks from "#src/services/AgentHooks";
import { HARNESS } from "#src/constants";
import { buildHookPayload } from "#src/services/hooks/buildPayload";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import { firePermissionDenied } from "./TurnHooks.ts";

/**
 * ApprovalGate — extracted approval gating logic.
 *
 * Handles the promise-based approval pattern: emit approval_required events,
 * register a pending approval resolver, wait for the user's response
 * (or timeout after 2 minutes), and return the decision.
 *
 * Where configured hooks meet it (Claude Code's order: hooks → rules → mode
 * → ask). The PreToolUse hooks ran BEFORE this gate and stamped their `ask` /
 * `allow` on the calls; `approvalEngine.checkBatch` applies rules and mode on
 * top. Then, only for the calls a human would actually be asked about:
 *   1. `PermissionRequest` hooks may answer instead of the human (allow/deny);
 *   2. `Notification` fires once — the loop is about to go idle on a person;
 *   3. the cards go out and the gate waits.
 * `PermissionDenied` fires for every call denied along the way (rule, hook,
 * user). A batch that needs nobody fires none of this.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

const APPROVAL_TIMEOUT_MILLISECONDS = HARNESS.APPROVAL_TIMEOUT_MILLISECONDS;

/** Find the original (non-copied) call for a `checkBatch` result. */
function originalOf(toolCalls: ToolCall[], call: { id: string | null }): ToolCall {
  return toolCalls.find((candidate) => candidate.id === call.id) ?? (call as ToolCall);
}

/**
 * `PermissionRequest` for each call about to be put to a human. `allow`
 * answers it (optionally rewriting the arguments), `deny` refuses it; the
 * rest stay pending. Returns the calls still waiting on a person.
 */
async function runPermissionRequestHooks<T extends ToolCall>(
  pending: T[],
  toolCalls: ToolCall[],
  context: AgenticContext,
  hooks: AgentHooks,
): Promise<T[]> {
  const permissionMode = context.options?.autoApprove ? "auto" : "default";
  const verdicts = await Promise.all(
    pending.map((call) =>
      hooks.run(
        "permissionRequest",
        originalOf(toolCalls, call),
        {
          permission_mode: permissionMode,
          tier: call._approval?.tierLabel ?? null,
          reason: call._approval?.reason ?? null,
        },
        context,
      ),
    ),
  );

  const stillPending: T[] = [];
  for (let index = 0; index < pending.length; index++) {
    const call = pending[index];
    const original = originalOf(toolCalls, call);
    const verdict = verdicts[index];
    if (
      verdict?.updatedInput &&
      typeof verdict.updatedInput === "object" &&
      !Array.isArray(verdict.updatedInput)
    ) {
      original.args = verdict.updatedInput as Record<string, unknown>;
    }
    if (verdict?.permissionDecision === "deny" || verdict?.isApproved === false) {
      const reason =
        typeof verdict.reason === "string" && verdict.reason
          ? verdict.reason
          : "denied by a PermissionRequest hook";
      original._approval = {
        ...(original._approval ?? { tier: 2, tierLabel: "write" }),
        isApproved: false,
        isDenied: true,
        deniedBy: "hook",
        reason,
      };
      await firePermissionDenied(hooks, context, original, "hook", reason);
      continue;
    }
    if (verdict?.permissionDecision === "allow") {
      original._approval = {
        ...(original._approval ?? { tier: 2, tierLabel: "write" }),
        isApproved: true,
        reason: "hook_permission_request",
      };
      continue;
    }
    stillPending.push(call);
  }
  return stillPending;
}

/**
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user responds or timeout occurs.
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
  hooks?: AgentHooks,
): Promise<{
  isApproved: boolean;
  shouldApproveAll: boolean;
  /** Denied calls (rule or hook) — terminal: they must not execute and are never user-approvable. */
  deniedToolCalls: ToolCall[];
}> {
  const { conversationId, emit, options } = context;

  const { needsApproval, denied = [] } = approvalEngine.checkBatch(toolCalls);

  if (denied.length > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution denied by policy: ${denied.map((toolCall) => toolCall.name).join(", ")}`,
    });
    for (const deniedCall of denied) {
      await firePermissionDenied(
        hooks,
        context,
        originalOf(toolCalls, deniedCall),
        "rule",
        deniedCall._approval?.reason || "policy rule",
      );
    }
  }

  const collectDenied = () =>
    toolCalls.filter((toolCall) => toolCall._approval?.isDenied === true);

  // Mid-loop "approve all" (options.autoApprove flipped after engine
  // construction) answers every prompt — except the ones a PreToolUse hook
  // explicitly asked for, which is the whole point of `ask`.
  let pending = options.autoApprove
    ? needsApproval.filter((toolCall) => toolCall._hookPermission?.decision === "ask")
    : needsApproval;

  if (options.autoApprove) {
    // Stamp the skipped-over calls as approved so the decide-hook pass in
    // ToolExecutor doesn't re-veto them.
    const pendingIds = new Set(pending.map((toolCall) => toolCall.id));
    for (const toolCall of toolCalls) {
      if (
        toolCall._approval &&
        !toolCall._approval.isDenied &&
        !pendingIds.has(toolCall.id)
      ) {
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

  if (pending.length > 0 && hooks) {
    pending = await runPermissionRequestHooks(pending, toolCalls, context, hooks);
  }

  if (pending.length === 0) {
    return { isApproved: true, shouldApproveAll: false, deniedToolCalls: collectDenied() };
  }

  // A person is about to be asked — the one moment a Notification hook is
  // for (ping a phone, post to a channel): the loop now idles on a human.
  await hooks?.run(
    "notification",
    buildHookPayload(
      HOOK_EVENTS.NOTIFICATION,
      {
        conversationId: context.conversationId,
        agentConversationId: context.agentConversationId as string,
        parentAgentConversationId: context.parentAgentConversationId as string,
        project: context.project,
        username: context.username,
        agent: context.agent,
        workspaceRoot: context.workspaceRoot,
      },
      {
        notification_type: "approval_required",
        notification_message: `Approval requested for ${pending.length} tool call(s)`,
        tool_names: pending.map((toolCall) => toolCall.name),
      },
    ),
  );

  // Emit approval_required events for each tool needing approval
  for (const toolCallRequiringApproval of pending) {
    const original = originalOf(toolCalls, toolCallRequiringApproval);
    emit({
      type: "approval_required",
      toolCall: {
        name: original.name,
        args: original.args,
        id: original.id,
      },
      tier: toolCallRequiringApproval._approval?.tier,
      tierLabel: toolCallRequiringApproval._approval?.tierLabel,
      ...(toolCallRequiringApproval._hookPermission?.decision === "ask" && {
        requestedBy: "hook",
        reason: toolCallRequiringApproval._hookPermission.reason ?? null,
      }),
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
      tools: pending.map((toolCall) => toolCall.name),
      toolCalls: pending.map((toolCall) => {
        const original = originalOf(toolCalls, toolCall);
        return {
          id: original.id,
          name: original.name,
          args: original.args,
          _approval: {
            tier: String(toolCall._approval.tier),
            tierLabel: toolCall._approval.tierLabel,
          },
        };
      }),
    });
  });

  if (!approvalResult?.isApproved) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution rejected: ${pending.map((toolCall) => toolCall.name).join(", ")}`,
    });
    for (const toolCall of pending) {
      await firePermissionDenied(
        hooks,
        context,
        originalOf(toolCalls, toolCall),
        "user",
        approvalResult?.reason || "user_rejected",
      );
    }
    return { isApproved: false, shouldApproveAll: false, deniedToolCalls: collectDenied() };
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
    return { isApproved: true, shouldApproveAll: true, deniedToolCalls: collectDenied() };
  }

  return { isApproved: true, shouldApproveAll: false, deniedToolCalls: collectDenied() };
}

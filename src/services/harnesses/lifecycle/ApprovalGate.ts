import crypto from "node:crypto";
import {
  ApprovalRegistry,
  type ApprovalRequestCall,
  type ToolCallDecision,
} from "#src/services/ApprovalRegistry";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type {
  ToolCall,
  ToolResult,
  ToolSchema,
  AgenticContext,
} from "#src/services/harnesses/types";
import type AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import type AgentHooks from "#src/services/AgentHooks";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { resolveLoopKey } from "#src/services/LoopKey";
import { decisionOwnerOf } from "#src/services/conversation/ConversationRunState";
import { APPROVALS, TURN_RESUME } from "#src/constants";
import { buildHookPayload } from "#src/services/hooks/buildPayload";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import { buildApprovalPreview } from "./ApprovalPreview.ts";
import { buildDeniedToolResult, firePermissionDenied } from "./TurnHooks.ts";

/**
 * ApprovalGate — per-call approval of a tool batch.
 *
 * The approval engine sorts the batch into auto-approved, policy-denied and
 * needs-a-human. Each call that needs a human gets its own
 * `approval_required` event (toolCallId, batchId, tier, full args, and a
 * diff preview for file writes) and its own decision in the
 * ApprovalRegistry; the batch proceeds once every one of them is decided —
 * allowed (possibly with edited arguments) or denied (possibly with a
 * reason). Results are then assembled in the model's order.
 *
 * There is no timeout (prompt 13). The batch is recorded in
 * PendingDecisionStore before its cards go out, and the turn parks
 * `awaiting_user` until the user decides — however long that takes, and
 * across a restart. Only the end of the turn (or a newer batch of the same
 * loop) lapses a card unanswered.
 *
 * Where configured hooks meet it (Claude Code's order: hooks → rules → mode
 * → ask). The PreToolUse hooks ran BEFORE this gate and stamped their `ask` /
 * `allow` on the calls; `approvalEngine.checkBatch` applies rules and mode on
 * top. Then, only for the calls a human would actually be asked about:
 *   1. `PermissionRequest` hooks may answer instead of the human (allow/deny);
 *   2. `Notification` fires once — the loop is about to go idle on a person;
 *   3. the cards go out and the gate waits.
 * `PermissionDenied` fires for every call denied along the way (rule, hook,
 * user) and every card that lapsed unanswered (superseded, turn_ended). A
 * batch that needs nobody fires none of this.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

export interface ApprovalVerdict {
  /**
   * Calls cleared to run — auto-approved by tier/policy, allowed by a
   * PermissionRequest hook, or allowed by the user with any edited arguments
   * already applied — in the model's order.
   */
  executableToolCalls: ToolCall[];
  /**
   * One tool result per call that must not run (policy DENY, hook deny, user
   * deny, a card that lapsed with its turn), in the model's order.
   */
  blockedResults: ToolResult[];
  /** Denied calls (rule or hook) — terminal rejections that must not execute and are never user-approvable. */
  deniedToolCalls: ToolCall[];
  /** The user chose "auto-approve this conversation": the rest of the turn skips the gate. */
  shouldApproveAll: boolean;
}

export interface ApprovalGateOptions {
  /** The run's tool schemas — an edited call's arguments are validated against them. */
  toolSchemas?: ToolSchema[];
  /** The run's hooks — PermissionRequest, Notification and PermissionDenied fire through them. */
  hooks?: AgentHooks;
  /**
   * The batch is a pass replayed after a restart (ResumedPass): the cards it
   * put out before are picked up again, not asked twice.
   */
  resume?: boolean;
}

/**
 * A call a restart cut off mid-run that is not read-only: it may have
 * partly happened, so it runs again only if the user says so.
 */
function isInterruptedCall(toolCall: ToolCall): boolean {
  return toolCall._resumed?.status === "interrupted";
}

/** Order results the way the model emitted the calls. */
export function orderResultsLikeCalls(
  toolCalls: ToolCall[],
  results: ToolResult[],
): ToolResult[] {
  const claimed = new Set<number>();
  return results
    .map((result, resultIndex) => {
      let index = toolCalls.findIndex(
        (toolCall, callIndex) =>
          !claimed.has(callIndex) && toolCall.id === result.id && toolCall.name === result.name,
      );
      if (index >= 0) claimed.add(index);
      else index = toolCalls.length + resultIndex;
      return { result, index };
    })
    .sort((left, right) => left.index - right.index)
    .map(({ result }) => result);
}

/**
 * The approval record kept on a persisted tool call: which calls a human
 * decided, how, and — for an edited call — what the model had asked for.
 * Spread into the history entry; empty for calls nobody had to decide.
 */
export function approvalRecordFor(toolCall: ToolCall): Pick<ToolCall, "_approval"> {
  const stamp = toolCall._approval;
  if (!stamp || (!stamp.decidedBy && !stamp.isDenied)) return {};
  return {
    _approval: {
      tier: stamp.tier,
      tierLabel: stamp.tierLabel,
      isApproved: stamp.isApproved === true,
      ...(stamp.isDenied ? { isDenied: true } : {}),
      ...(stamp.deniedBy ? { deniedBy: stamp.deniedBy } : {}),
      ...(stamp.reason ? { reason: stamp.reason } : {}),
      ...(stamp.decidedBy ? { decidedBy: stamp.decidedBy } : {}),
      ...(stamp.userReason ? { userReason: stamp.userReason } : {}),
      ...(stamp.editedByUser ? { editedByUser: true, originalArgs: stamp.originalArgs } : {}),
    },
  };
}

function userDeclinedResult(
  toolCall: ToolCall,
  decision: ToolCallDecision,
  locale: string,
): ToolResult {
  if (isInterruptedCall(toolCall)) {
    // Not "declined": it ran (at least partly) before the restart; it was
    // not run AGAIN. The model must not assume either outcome.
    return {
      name: toolCall.name,
      id: toolCall.id,
      result: {
        success: false,
        error: "INTERRUPTED_BY_RESTART",
        message: PromptLocaleService.get(locale, "harness.resume.notRerun", {
          toolName: toolCall.name,
        }),
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
    };
  }
  const isLapsed = decision.source !== "user";
  const messageKey = isLapsed
    ? "harness.approval.lapsed"
    : decision.reason
      ? "harness.approval.declinedWithReason"
      : "harness.approval.declined";
  return {
    name: toolCall.name,
    id: toolCall.id,
    result: {
      success: false,
      error: isLapsed ? "APPROVAL_LAPSED" : "USER_REJECTED",
      message: PromptLocaleService.get(locale, messageKey, {
        toolName: toolCall.name,
        reason: decision.reason ?? "",
      }),
      ...(decision.reason ? { reason: decision.reason } : {}),
    },
  };
}

/**
 * Pair each call the engine returned (copies, or stubs in tests) with the
 * ORIGINAL call object, by id and name in order, and make sure the original
 * carries the engine's stamp — the ToolExecutor hook pass reads it there.
 */
function matchOriginals(toolCalls: ToolCall[], categorized: ToolCall[]): Set<ToolCall> {
  const matched = new Set<ToolCall>();
  for (const entry of categorized) {
    const original = toolCalls.find(
      (toolCall) =>
        !matched.has(toolCall) && toolCall.id === entry.id && toolCall.name === entry.name,
    );
    if (!original) continue;
    if (!original._approval && entry._approval) original._approval = entry._approval;
    matched.add(original);
  }
  return matched;
}

/**
 * `PermissionRequest` for each call about to be put to a human. `allow`
 * answers it (optionally rewriting the arguments), `deny` refuses it; the
 * rest stay pending. Returns the calls still waiting on a person.
 */
async function runPermissionRequestHooks(
  pending: ToolCall[],
  context: AgenticContext,
  hooks: AgentHooks,
): Promise<ToolCall[]> {
  const permissionMode = context.options?.autoApprove ? "auto" : "default";
  const verdicts = await Promise.all(
    pending.map((call) =>
      hooks.run(
        "permissionRequest",
        call,
        {
          permission_mode: permissionMode,
          tier: call._approval?.tierLabel ?? null,
          reason: call._approval?.reason ?? null,
        },
        context,
      ),
    ),
  );

  const stillPending: ToolCall[] = [];
  for (let index = 0; index < pending.length; index++) {
    const call = pending[index];
    const verdict = verdicts[index];
    if (
      verdict?.updatedInput &&
      typeof verdict.updatedInput === "object" &&
      !Array.isArray(verdict.updatedInput)
    ) {
      call.args = verdict.updatedInput as Record<string, unknown>;
    }
    if (verdict?.permissionDecision === "deny" || verdict?.isApproved === false) {
      const reason =
        typeof verdict.reason === "string" && verdict.reason
          ? verdict.reason
          : "denied by a PermissionRequest hook";
      call._approval = {
        ...(call._approval ?? { tier: 2, tierLabel: "write" }),
        isApproved: false,
        isDenied: true,
        deniedBy: "hook",
        reason,
      };
      await firePermissionDenied(hooks, context, call, "hook", reason);
      continue;
    }
    if (verdict?.permissionDecision === "allow") {
      call._approval = {
        ...(call._approval ?? { tier: 2, tierLabel: "write" }),
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
 * require approval, park until the user has decided every one of them.
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
  { toolSchemas = [], hooks, resume = false }: ApprovalGateOptions = {},
): Promise<ApprovalVerdict> {
  const { emit, options } = context;

  const { needsApproval, denied = [] } = approvalEngine.checkBatch(toolCalls);

  const deniedOriginals = matchOriginals(toolCalls, denied);
  if (deniedOriginals.size > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution denied by policy: ${denied.map((toolCall) => toolCall.name).join(", ")}`,
    });
    for (const deniedCall of deniedOriginals) {
      await firePermissionDenied(
        hooks,
        context,
        deniedCall,
        "rule",
        deniedCall._approval?.reason || "policy rule",
      );
    }
  }
  const awaitingOriginals = matchOriginals(toolCalls, needsApproval);

  // Mid-loop "auto-approve this conversation" (options.autoApprove flipped
  // after engine construction) answers every prompt — except the ones a
  // PreToolUse hook explicitly asked for, which is the whole point of `ask`.
  let pending = toolCalls.filter(
    (toolCall) =>
      awaitingOriginals.has(toolCall) &&
      (!options.autoApprove || toolCall._hookPermission?.decision === "ask"),
  );

  if (options.autoApprove) {
    // Stamp the skipped-over calls as approved so the decide-hook pass in
    // ToolExecutor doesn't re-veto them.
    const pendingCalls = new Set(pending);
    for (const toolCall of toolCalls) {
      if (toolCall._approval && !toolCall._approval.isDenied && !pendingCalls.has(toolCall)) {
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

  // A call a restart cut off mid-run is asked about whatever its tier or the
  // mode, and only a person answers "run it again?" — not the mode, not a
  // PermissionRequest hook: it is not a permission anyone gave already.
  const interruptedCalls = toolCalls.filter(
    (toolCall) => isInterruptedCall(toolCall) && !deniedOriginals.has(toolCall),
  );
  pending = pending.filter((toolCall) => !isInterruptedCall(toolCall));

  if (pending.length > 0 && hooks) {
    pending = await runPermissionRequestHooks(pending, context, hooks);
  }

  if (interruptedCalls.length > 0) {
    pending = [...pending, ...interruptedCalls].sort(
      (left, right) => toolCalls.indexOf(left) - toolCalls.indexOf(right),
    );
  }

  const isDenied = (toolCall: ToolCall) =>
    deniedOriginals.has(toolCall) || toolCall._approval?.isDenied === true;
  const deniedToolCalls = toolCalls.filter(isDenied);

  if (pending.length === 0) {
    return {
      executableToolCalls: toolCalls.filter((toolCall) => !isDenied(toolCall)),
      blockedResults: deniedToolCalls.map(buildDeniedToolResult),
      deniedToolCalls,
      shouldApproveAll: false,
    };
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

  // ── One decision per call ────────────────────────────────────
  const proposedBatchId = crypto.randomUUID();
  const usedKeys = new Set<string>();
  const pendingCalls = new Set(pending);
  const awaiting = toolCalls.flatMap((toolCall, index) => {
    if (!pendingCalls.has(toolCall)) return [];
    // The id the client decides the call by: the provider's id, made
    // unique within the batch (providers without ids, or repeating ones).
    let toolCallId = toolCall.id || `${proposedBatchId}:${index}`;
    if (usedKeys.has(toolCallId)) toolCallId = `${toolCallId}#${index}`;
    usedKeys.add(toolCallId);
    // "Run it again?" is its own decision — never the approval it had
    // before the restart, which is spent.
    if (isInterruptedCall(toolCall)) toolCallId += TURN_RESUME.RETRY_DECISION_SUFFIX;
    return [{ toolCallId, toolCall }];
  });

  const schemaByName = new Map(
    toolSchemas.map((schema) => [schema.name, schema.parameters ?? null]),
  );
  const previews = await Promise.all(
    awaiting.map(({ toolCall }) => buildApprovalPreview(toolCall, context)),
  );
  const locale =
    (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale();
  const requests: ApprovalRequestCall[] = awaiting.map(({ toolCallId, toolCall }, index) => ({
    toolCallId,
    name: toolCall.name,
    args: toolCall.args,
    tier: toolCall._approval?.tier,
    tierLabel: toolCall._approval?.tierLabel,
    argsSchema: (schemaByName.get(toolCall.name) as Record<string, unknown> | null) ?? null,
    preview: previews[index],
    ...(isInterruptedCall(toolCall)
      ? {
          requestedBy: TURN_RESUME.RETRY_REQUESTED_BY,
          reason: PromptLocaleService.get(locale, "harness.resume.retryReason", {
            toolName: toolCall.name,
          }),
        }
      : {}),
  }));

  // Recorded first, THEN shown: a decision can only land on a call that
  // exists, and a card must never outlive the process that showed it.
  // A replayed pass picks up the batch it opened before the restart (its
  // own batch id, the decisions already made) — only what is still
  // undecided gets a card.
  const loopKey = resolveLoopKey(context);
  let batchId: string = proposedBatchId;
  const opened = await ApprovalRegistry.open(
    loopKey,
    {
      type: "tool",
      batchId: proposedBatchId,
      calls: requests,
      onDecided: (toolCallId, decision) => {
        emit({
          type: APPROVALS.DECIDED_EVENT_TYPE,
          toolCallId,
          batchId,
          decision: decision.decision,
          scope: decision.scope,
          source: decision.source,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.editedArgs ? { editedByUser: true } : {}),
        });
      },
    },
    decisionOwnerOf(context),
    { resume },
  );
  batchId = opened.batchId;
  const decisionsPromise = opened.decisions;
  const stillPending = new Set(opened.pendingToolCallIds);

  requests.forEach((request, index) => {
    if (!stillPending.has(request.toolCallId)) return;
    const hookPermission = awaiting[index].toolCall._hookPermission;
    emit({
      type: "approval_required",
      toolCallId: request.toolCallId,
      batchId,
      batchSize: requests.length,
      toolCall: {
        name: request.name,
        args: request.args,
        id: request.toolCallId,
      },
      tier: request.tier,
      tierLabel: request.tierLabel,
      ...(request.preview ? { preview: request.preview } : {}),
      ...(request.requestedBy && {
        requestedBy: request.requestedBy,
        reason: request.reason ?? null,
      }),
      ...(hookPermission?.decision === "ask" && {
        requestedBy: "hook",
        reason: hookPermission.reason ?? null,
      }),
    });
  });

  // A stopped turn must not park forever on a card nobody will click.
  const cancelOnAbort = () => void ApprovalRegistry.cancel(loopKey);
  context.signal?.addEventListener("abort", cancelOnAbort, { once: true });
  if (context.signal?.aborted) cancelOnAbort();
  let decisions: Awaited<typeof decisionsPromise>;
  try {
    decisions = await decisionsPromise;
  } finally {
    context.signal?.removeEventListener("abort", cancelOnAbort);
  }

  // ── Assemble, in the model's order ───────────────────────────
  const decisionByCall = new Map(
    awaiting.map(({ toolCallId, toolCall }) => [toolCall, decisions.get(toolCallId)]),
  );
  const executableToolCalls: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const declinedNames: string[] = [];
  let shouldApproveAll = false;

  for (const toolCall of toolCalls) {
    if (isDenied(toolCall)) {
      blockedResults.push(buildDeniedToolResult(toolCall));
      continue;
    }
    if (!decisionByCall.has(toolCall)) {
      executableToolCalls.push(toolCall);
      continue;
    }
    const decision = decisionByCall.get(toolCall);
    if (decision?.decision === "allow") {
      if (decision.scope === "conversation") shouldApproveAll = true;
      const originalArgs = toolCall.args;
      if (decision.editedArgs) toolCall.args = decision.editedArgs;
      // Stamp the user's decision onto the original call so the decide-hook
      // pass in ToolExecutor honors it instead of re-vetoing.
      toolCall._approval = {
        ...toolCall._approval!,
        isApproved: true,
        reason: decision.editedArgs ? "user_edited" : "user_approved",
        decidedBy: "user",
        ...(decision.editedArgs ? { editedByUser: true, originalArgs } : {}),
      };
      executableToolCalls.push(toolCall);
    } else {
      const declined = decision ?? { decision: "deny", scope: "call", source: "turn_ended" };
      const reason = declined.source === "user" ? "user_rejected" : declined.source;
      toolCall._approval = {
        ...toolCall._approval!,
        isApproved: false,
        reason,
        decidedBy: declined.source,
        ...(declined.reason ? { userReason: declined.reason } : {}),
      };
      declinedNames.push(toolCall.name);
      blockedResults.push(userDeclinedResult(toolCall, declined as ToolCallDecision, locale));
      // Only a person's "no" is the user's; a lapsed card names how it lapsed.
      await firePermissionDenied(hooks, context, toolCall, declined.source, declined.reason || reason);
    }
  }

  if (declinedNames.length > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution rejected: ${declinedNames.join(", ")}`,
    });
  }

  return { executableToolCalls, blockedResults, deniedToolCalls, shouldApproveAll };
}

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
import PromptLocaleService from "#src/services/PromptLocaleService";
import { resolveLoopKey } from "#src/services/LoopKey";
import { APPROVALS, HARNESS } from "#src/constants";
import { buildApprovalPreview } from "./ApprovalPreview.ts";

/**
 * ApprovalGate — per-call approval of a tool batch.
 *
 * The approval engine sorts the batch into auto-approved, policy-denied and
 * needs-a-human. Each call that needs a human gets its own
 * `approval_required` event (toolCallId, batchId, tier, full args, and a
 * diff preview for file writes) and its own decision in the
 * ApprovalRegistry; the batch proceeds once every one of them is decided —
 * allowed (possibly with edited arguments), denied (possibly with a reason),
 * or timed out (denied). Results are then assembled in the model's order.
 *
 * Reusable by any harness that executes write/danger-tier tools.
 */

const APPROVAL_TIMEOUT_MILLISECONDS = HARNESS.APPROVAL_TIMEOUT_MILLISECONDS;

export interface ApprovalVerdict {
  /**
   * Calls cleared to run — auto-approved by tier/policy or allowed by the
   * user, with any edited arguments already applied — in the model's order.
   */
  executableToolCalls: ToolCall[];
  /**
   * One tool result per call that must not run (policy DENY, user deny,
   * approval timeout), in the model's order.
   */
  blockedResults: ToolResult[];
  /** Policy-denied calls — terminal rejections that must not execute and are never user-approvable. */
  deniedToolCalls: ToolCall[];
  /** The user chose "auto-approve this conversation": the rest of the turn skips the gate. */
  shouldApproveAll: boolean;
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
      ...(stamp.reason ? { reason: stamp.reason } : {}),
      ...(stamp.decidedBy ? { decidedBy: stamp.decidedBy } : {}),
      ...(stamp.userReason ? { userReason: stamp.userReason } : {}),
      ...(stamp.editedByUser ? { editedByUser: true, originalArgs: stamp.originalArgs } : {}),
    },
  };
}

function policyDeniedResult(toolCall: ToolCall): ToolResult {
  return {
    name: toolCall.name,
    id: toolCall.id,
    result: {
      success: false,
      error: "POLICY_DENIED",
      message: `Tool execution denied by policy: ${toolCall._approval?.reason || "policy rule"}`,
    },
  };
}

function userDeclinedResult(
  toolCall: ToolCall,
  decision: ToolCallDecision,
  locale: string,
): ToolResult {
  const isTimeout = decision.source === "timeout";
  const messageKey = isTimeout
    ? "harness.approval.timedOut"
    : decision.reason
      ? "harness.approval.declinedWithReason"
      : "harness.approval.declined";
  return {
    name: toolCall.name,
    id: toolCall.id,
    result: {
      success: false,
      error: isTimeout ? "APPROVAL_TIMED_OUT" : "USER_REJECTED",
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
 * Check a batch of tool calls against the approval engine and, if any
 * require approval, pause until the user has decided every one of them
 * (or the timeout denies the rest).
 */
export async function checkAndWaitForApproval(
  toolCalls: ToolCall[],
  context: AgenticContext,
  approvalEngine: AutoApprovalEngine,
  { toolSchemas = [] }: { toolSchemas?: ToolSchema[] } = {},
): Promise<ApprovalVerdict> {
  const { emit, options } = context;

  const { needsApproval, denied = [] } = approvalEngine.checkBatch(toolCalls);

  if (denied.length > 0) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: `Tool execution denied by policy: ${denied.map((toolCall) => toolCall.name).join(", ")}`,
    });
  }

  const deniedOriginals = matchOriginals(toolCalls, denied);
  const deniedToolCalls = toolCalls.filter((toolCall) => deniedOriginals.has(toolCall));
  const awaitingOriginals = matchOriginals(toolCalls, needsApproval);

  if (awaitingOriginals.size === 0 || options.autoApprove) {
    // Mid-loop "auto-approve this conversation" (options.autoApprove flipped
    // after engine construction) — stamp the skipped-over calls as approved
    // so the decide-hook pass in ToolExecutor doesn't re-veto them.
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
    return {
      executableToolCalls: toolCalls.filter((toolCall) => !deniedOriginals.has(toolCall)),
      blockedResults: deniedToolCalls.map(policyDeniedResult),
      deniedToolCalls,
      shouldApproveAll: false,
    };
  }

  // ── One decision per call ────────────────────────────────────
  const batchId = crypto.randomUUID();
  const usedKeys = new Set<string>();
  const awaiting = toolCalls.flatMap((toolCall, index) => {
    if (!awaitingOriginals.has(toolCall)) return [];
    // The id the client decides the call by: the provider's id, made
    // unique within the batch (providers without ids, or repeating ones).
    let toolCallId = toolCall.id || `${batchId}:${index}`;
    if (usedKeys.has(toolCallId)) toolCallId = `${toolCallId}#${index}`;
    usedKeys.add(toolCallId);
    return [{ toolCallId, toolCall }];
  });

  const schemaByName = new Map(
    toolSchemas.map((schema) => [schema.name, schema.parameters ?? null]),
  );
  const previews = await Promise.all(
    awaiting.map(({ toolCall }) => buildApprovalPreview(toolCall, context)),
  );
  const requests: ApprovalRequestCall[] = awaiting.map(({ toolCallId, toolCall }, index) => ({
    toolCallId,
    name: toolCall.name,
    args: toolCall.args,
    tier: toolCall._approval?.tier,
    tierLabel: toolCall._approval?.tierLabel,
    argsSchema: (schemaByName.get(toolCall.name) as Record<string, unknown> | null) ?? null,
    preview: previews[index],
  }));

  for (const request of requests) {
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
    });
  }

  const loopKey = resolveLoopKey(context);
  const decisionsPromise = ApprovalRegistry.waitForDecisions(loopKey, {
    type: "tool",
    batchId,
    calls: requests,
    timeoutMilliseconds: APPROVAL_TIMEOUT_MILLISECONDS,
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
  });
  // A stopped turn must not sit out the timeout on a card nobody will click.
  const cancelOnAbort = () => ApprovalRegistry.cancel(loopKey);
  context.signal?.addEventListener("abort", cancelOnAbort, { once: true });
  if (context.signal?.aborted) cancelOnAbort();
  let decisions: Awaited<typeof decisionsPromise>;
  try {
    decisions = await decisionsPromise;
  } finally {
    context.signal?.removeEventListener("abort", cancelOnAbort);
  }

  // ── Assemble, in the model's order ───────────────────────────
  const locale =
    (options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale();
  const decisionByCall = new Map(
    awaiting.map(({ toolCallId, toolCall }) => [toolCall, decisions.get(toolCallId)]),
  );
  const executableToolCalls: ToolCall[] = [];
  const blockedResults: ToolResult[] = [];
  const declinedNames: string[] = [];
  let shouldApproveAll = false;

  for (const toolCall of toolCalls) {
    if (deniedOriginals.has(toolCall)) {
      blockedResults.push(policyDeniedResult(toolCall));
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
      const declined = decision ?? { decision: "deny", scope: "call", source: "timeout" };
      toolCall._approval = {
        ...toolCall._approval!,
        isApproved: false,
        reason: declined.source === "user" ? "user_rejected" : declined.source,
        decidedBy: declined.source,
        ...(declined.reason ? { userReason: declined.reason } : {}),
      };
      declinedNames.push(toolCall.name);
      blockedResults.push(userDeclinedResult(toolCall, declined as ToolCallDecision, locale));
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

import type { Request, Response } from "express";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ConversationApprovalSettings from "#src/services/ConversationApprovalSettings";
import ConversationAttentionRegistry from "#src/services/ConversationAttentionRegistry";
import PendingDecisionStore from "#src/services/PendingDecisionStore";
import type {
  ApprovalDecisionInput,
  ApprovalDecisionKind,
  ApprovalScope,
} from "#src/services/ApprovalRegistry";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * POST /agent/approve (and its /conversation/approve alias) — one decision
 * for one pending tool or plan call. Fails closed: nothing is approved unless
 * the body says "allow" in so many words.
 *
 * Body:
 *   {
 *     conversationId: string,
 *     toolCallId?: string,            // required when more than one call is pending
 *     batchId?: string,               // from approval_required; a mismatch is stale (409)
 *     decision: "allow" | "deny",
 *     reason?: string,                // a denial's reason, relayed to the model
 *     editedArgs?: object,            // allow with these arguments (validated, 400 if invalid)
 *     scope?: "call" | "batch" | "conversation",
 *   }
 *
 * Legacy `{ approved }` is read only as a strict boolean (true → allow,
 * false → deny) and legacy `approveAll: true` as scope "batch". A missing
 * decision, `approved: "false"`, or any other value is a 400 — never a yes.
 *
 * 404 — nothing pending under this conversation, or an id never seen.
 * 409 — the call was already decided (a second POST of one decision reads
 *       this: each call is decided exactly once), or belongs to a batch
 *       that is done.
 *
 * The pending calls are durable (PendingDecisionStore): a decision for a
 * turn parked when the previous process stopped is accepted and stored —
 * `delivered: false` in the response — and the turn picks it up when it is
 * re-driven. `delivered: true` means the running turn took it.
 */

const DECISIONS: readonly ApprovalDecisionKind[] = ["allow", "deny"];
const SCOPES: readonly ApprovalScope[] = ["call", "batch", "conversation"];

type ParsedBody =
  | { ok: true; conversationId: string; input: ApprovalDecisionInput }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): ParsedBody {
  if (!isPlainObject(body)) return { ok: false, error: "Body must be a JSON object" };
  const { conversationId, toolCallId, batchId, decision, approved, approveAll, reason, editedArgs, scope } = body;

  if (typeof conversationId !== "string" || !conversationId) {
    return { ok: false, error: "Missing conversationId" };
  }

  let resolvedDecision: ApprovalDecisionKind;
  if (decision !== undefined) {
    if (!DECISIONS.includes(decision as ApprovalDecisionKind)) {
      return { ok: false, error: 'decision must be "allow" or "deny"' };
    }
    resolvedDecision = decision as ApprovalDecisionKind;
    if (approved !== undefined && approved !== (resolvedDecision === "allow")) {
      return { ok: false, error: "approved contradicts decision" };
    }
  } else if (approved === true || approved === false) {
    resolvedDecision = approved ? "allow" : "deny";
  } else {
    return {
      ok: false,
      error: 'Missing decision: send decision "allow" or "deny" (or a boolean approved)',
    };
  }

  if (toolCallId !== undefined && (typeof toolCallId !== "string" || !toolCallId)) {
    return { ok: false, error: "toolCallId must be a non-empty string" };
  }
  if (batchId !== undefined && (typeof batchId !== "string" || !batchId)) {
    return { ok: false, error: "batchId must be a non-empty string" };
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  if (editedArgs !== undefined && !isPlainObject(editedArgs)) {
    return { ok: false, error: "editedArgs must be a JSON object" };
  }

  let resolvedScope: ApprovalScope | undefined;
  if (scope !== undefined) {
    if (!SCOPES.includes(scope as ApprovalScope)) {
      return { ok: false, error: 'scope must be "call", "batch" or "conversation"' };
    }
    resolvedScope = scope as ApprovalScope;
  } else if (approveAll === true && resolvedDecision === "allow") {
    resolvedScope = "batch";
  }

  return {
    ok: true,
    conversationId,
    input: {
      decision: resolvedDecision,
      ...(toolCallId ? { toolCallId: toolCallId as string } : {}),
      ...(batchId ? { batchId: batchId as string } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
      ...(editedArgs !== undefined ? { editedArgs: editedArgs as Record<string, unknown> } : {}),
      ...(resolvedScope ? { scope: resolvedScope } : {}),
    },
  };
}

export async function handleApprovalDecision(
  request: Request,
  response: Response,
  logPrefix: string,
) {
  const parsed = parseBody(request.body);
  if (!parsed.ok) return response.status(400).json({ error: parsed.error });
  const { conversationId, input } = parsed;

  const outcome = await AgenticLoopService.decideApproval(conversationId, input);

  switch (outcome.status) {
    case "not_found":
      return response.status(404).json({
        error: input.toolCallId
          ? "No pending approval with this toolCallId"
          : "No pending approval for this conversation",
        conversationId,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      });
    case "stale":
      return response.status(409).json({
        error: "This call was already decided, or its batch is no longer pending",
        conversationId,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      });
    case "ambiguous":
      return response.status(400).json({
        error: `toolCallId is required: ${outcome.pendingToolCallIds.length} calls are pending`,
        conversationId,
        pendingToolCallIds: outcome.pendingToolCallIds,
      });
    case "invalid":
      return response.status(400).json({ error: outcome.error, conversationId });
  }

  const scope = input.scope ?? "call";
  let persisted: boolean | undefined;
  if (scope === "conversation") {
    try {
      persisted = await ConversationApprovalSettings.enableAutoApprove(
        conversationId,
        request.project as string,
        request.username as string,
      );
    } catch (error: unknown) {
      persisted = false;
      logger.error(
        `${logPrefix} Could not persist auto-approve for ${conversationId}: ${getErrorMessage(error)}`,
      );
    }
  }

  if (!outcome.delivered && outcome.decidedToolCallIds.length > 0) {
    // No running turn emitted `approval_decided` for these: close their
    // "needs you" entries here.
    const decided = await PendingDecisionStore.find({ loopKey: conversationId });
    ConversationAttentionRegistry.forget(
      decided.filter(
        (record) =>
          record.batchId === outcome.batchId && outcome.decidedToolCallIds.includes(record.itemId),
      ),
    );
  }

  logger.info(
    `${logPrefix} ${input.decision} ${outcome.decidedToolCallIds.join(", ")} (scope ${scope}${input.editedArgs ? ", edited args" : ""}) for conversation ${conversationId}; ${outcome.remaining} still pending${outcome.delivered ? "" : " — stored for the re-driven turn"}`,
  );

  return response.json({
    ok: true,
    approved: input.decision === "allow",
    decision: input.decision,
    scope,
    type: outcome.type,
    batchId: outcome.batchId,
    decidedToolCallIds: outcome.decidedToolCallIds,
    remaining: outcome.remaining,
    delivered: outcome.delivered,
    ...(persisted !== undefined ? { persisted } : {}),
  });
}

/**
 * ApprovalRegistry — the tool and plan approvals a turn is waiting on.
 *
 * Durable (prompt 13): every call awaiting a human is a record in
 * PendingDecisionStore, written before its card goes out; a decision is a
 * conditional write on that record, and this process's waiter — if the turn
 * that asked is still running here — is woken with it. So the database, not
 * this module, says what is pending: a decision survives a restart (stored;
 * the turn resumes when it is re-driven) and is applied exactly once.
 *
 * No timeout: a batch waits until the user decides every call, a newer batch
 * of the same loop supersedes it, or its turn ends.
 *
 * Also home to the question types (QuestionRegistry holds the questions).
 * Lives in its own module to avoid circular imports between
 * AgenticLoopService (the public façade) and harness implementations.
 */
import { APPROVALS } from "#src/constants";
import { validateToolArgs } from "#src/utils/ToolArgsValidator";
import PendingDecisionStore, {
  pendingDecisionId,
  type DecisionOwner,
  type PendingDecisionRecord,
} from "#src/services/PendingDecisionStore";
import ConversationRunState, { locatorFor } from "#src/services/conversation/ConversationRunState";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

// ── Approval Types ─────────────────────────────────────────

export type ApprovalDecisionKind = "allow" | "deny";

/**
 * How far one decision reaches: this call only, every still-pending call of
 * its batch, or — "conversation" — the batch plus every later batch of the
 * conversation (persisted by the route, applied by the running loop).
 */
export type ApprovalScope = "call" | "batch" | "conversation";

/**
 * Who settled a call: the user — or, when the wait lapsed without them, a
 * newer batch of the same loop ("superseded") or the end of the turn.
 */
export type ApprovalDecisionSource = "user" | "superseded" | "turn_ended";

export interface ToolCallDecision {
  decision: ApprovalDecisionKind;
  scope: ApprovalScope;
  source: ApprovalDecisionSource;
  /** The user's reason for a denial (already trimmed and length-capped). */
  reason?: string;
  /** Replacement arguments, validated against the tool's schema. */
  editedArgs?: Record<string, unknown>;
}

/** What a file-writing call would change, rendered on its approval card. */
export interface ApprovalPreview {
  kind: "diff";
  path: string;
  /** Unified diff (`---`/`+++`/`@@`), possibly cut — see `isTruncated`. */
  diff: string;
  isNewFile?: boolean;
  isTruncated?: boolean;
}

export interface PendingToolCallSummary {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  batchId?: string;
  preview?: ApprovalPreview | null;
  _approval?: { tier: string; tierLabel: string };
}

export interface ApprovalRequestCall {
  /** Unique within the batch; the id the client decides it by. */
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  tier?: number | string;
  tierLabel?: string;
  /** The tool's JSON-Schema `parameters`; edited arguments must satisfy it. */
  argsSchema?: Record<string, unknown> | null;
  preview?: ApprovalPreview | null;
}

export interface ApprovalBatchRequest {
  type: "tool" | "plan";
  batchId: string;
  calls: ApprovalRequestCall[];
  /** Runs once per call, as it is decided — the gate turns it into an event. */
  onDecided?: (toolCallId: string, decision: ToolCallDecision) => void;
}

export interface ApprovalDecisionInput {
  /** Omitted only by legacy clients: then it must be unambiguous. */
  toolCallId?: string;
  /** When given, must match the pending batch (a card from an older batch → stale). */
  batchId?: string;
  decision: ApprovalDecisionKind;
  scope?: ApprovalScope;
  reason?: string;
  editedArgs?: Record<string, unknown>;
}

export type ApprovalDecisionOutcome =
  | {
      status: "decided";
      type: "tool" | "plan";
      batchId: string;
      decidedToolCallIds: string[];
      /** Calls of the batch still waiting for a decision. */
      remaining: number;
      /**
       * A turn running in this process took the decision. False after a
       * restart: the decision is stored and the turn picks it up when it
       * is re-driven.
       */
      delivered: boolean;
    }
  /** No batch is waiting on this loop, and the id was never seen here. */
  | { status: "not_found" }
  /** Already decided, or from a batch that has since been settled. */
  | { status: "stale"; toolCallId?: string }
  /** No toolCallId and more than one call is pending — the client must name one. */
  | { status: "ambiguous"; pendingToolCallIds: string[] }
  | { status: "invalid"; error: string };

export interface PendingApprovalSnapshot {
  type: "tool" | "plan";
  batchId: string;
  /** Undecided calls only, in the model's order. */
  toolCalls: PendingToolCallSummary[];
}

// ── Question Entry Types ───────────────────────────────────

export interface QuestionAnswer {
  answer: string | string[];
  annotations?: string;
}

export interface QuestionResolution {
  answers: QuestionAnswer[] | null;
  /** The wait ended without an answer — its turn was stopped. */
  isCancelled?: boolean;
}

export interface QuestionDefinition {
  question: string;
  [key: string]: unknown;
}

/**
 * What happened to an answer once its question was taken off the registry.
 * A blocking question always takes it (the loop is awaiting the promise); a
 * non-blocking one posts it into the TurnInputMailbox, which refuses when
 * the turn has already closed — the route then answers 404 so the client
 * sends the answer as a normal message instead, and it is delivered once.
 */
export interface QuestionDelivery {
  delivered: boolean;
  reason?: string;
}

export interface PendingQuestionEntry {
  /** The `questionId` the `user_question` event carried. */
  questionId: string;
  /** false → the loop kept working; the answer rides the TurnInputMailbox. */
  blocking: boolean;
  /** Registration time — "the oldest blocking question" is by this. */
  createdAt: number;
  /**
   * The loop's agentConversationId. Questions used to be filed under it; an
   * answer addressed by it still resolves (for one release, logged).
   */
  agentConversationId?: string | null;
  resolve: (value: QuestionResolution) => QuestionDelivery | void;
  question?: string;
  questions?: QuestionDefinition[];
  choices?: string[];
}

// ── Approval Registry ──────────────────────────────────────
// The truth is PendingDecisionStore: one record per call, keyed by the loop
// (resolveLoopKey: the client-facing conversation id of a root turn, a
// sub-agent's own id for a sub-agent) and the batch. What lives here is only
// the WAITER of a batch whose turn is running in this process: every
// decision the store accepts is applied to it, and it resolves when the last
// call of its batch is decided, so results keep the model's order.

const APPROVAL_KINDS = ["tool", "plan"] as const;

interface BatchWaiter {
  loopKey: string;
  type: "tool" | "plan";
  batchId: string;
  /** toolCallIds in the model's order. */
  order: string[];
  decisions: Map<string, ToolCallDecision>;
  onDecided?: ApprovalBatchRequest["onDecided"];
  resolve: (decisions: Map<string, ToolCallDecision>) => void;
  owner: DecisionOwner;
}

const waiters = new Map<string, BatchWaiter>();

function normalizeReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  return trimmed.length > APPROVALS.MAXIMUM_REASON_LENGTH
    ? `${trimmed.slice(0, APPROVALS.MAXIMUM_REASON_LENGTH)}…`
    : trimmed;
}

/**
 * Hand one decision the store accepted to the waiting batch, if its turn is
 * running here. True when a waiter took it.
 */
function deliver(loopKey: string, batchId: string, toolCallId: string, decision: ToolCallDecision): boolean {
  const waiter = waiters.get(loopKey);
  if (!waiter || waiter.batchId !== batchId) return false;
  if (!waiter.order.includes(toolCallId) || waiter.decisions.has(toolCallId)) return false;
  waiter.decisions.set(toolCallId, decision);
  waiter.onDecided?.(toolCallId, decision);
  if (waiter.decisions.size === waiter.order.length) {
    waiters.delete(loopKey);
    void ConversationRunState.unpark(locatorFor(loopKey, waiter.owner));
    waiter.resolve(
      new Map(waiter.order.map((id) => [id, waiter.decisions.get(id)!] as const)),
    );
  }
  return true;
}

function recordDecision(record: PendingDecisionRecord): ToolCallDecision | null {
  const stored = record.decision;
  if (!stored) return null;
  return {
    decision: stored.decision,
    scope: stored.scope,
    source: stored.source,
    ...(stored.reason ? { reason: stored.reason } : {}),
    ...(stored.editedArgs ? { editedArgs: stored.editedArgs } : {}),
  };
}

/**
 * Settle every pending call of a loop on the user's behalf (a newer batch,
 * or the end of the turn), and wake its waiter with the same decision. A
 * waiter whose calls the store could not settle — the write failed, or the
 * record was never persisted — is still resolved: a lapsed wait must never
 * hang the turn.
 */
async function lapse(
  loopKey: string,
  source: Exclude<ApprovalDecisionSource, "user">,
): Promise<PendingDecisionRecord[]> {
  const decision: ToolCallDecision = { decision: "deny", scope: "call", source };
  const waiter = waiters.get(loopKey);
  let settled: PendingDecisionRecord[] = [];
  try {
    settled = await PendingDecisionStore.settleAll(
      { loopKey, kinds: APPROVAL_KINDS },
      () => ({ status: "decided", decision }),
    );
  } catch (error: unknown) {
    logger.error(
      `[ApprovalRegistry] Could not settle pending approvals of ${loopKey} (${source}): ${getErrorMessage(error)}`,
    );
  }
  for (const record of settled) {
    if (record.batchId) deliver(loopKey, record.batchId, record.itemId, decision);
  }
  if (waiter && waiters.get(loopKey) === waiter) {
    for (const toolCallId of waiter.order) {
      if (!waiter.decisions.has(toolCallId)) deliver(loopKey, waiter.batchId, toolCallId, decision);
    }
  }
  return settled;
}

export const ApprovalRegistry = {
  /**
   * Record a batch as pending and park it: the returned promise resolves
   * when every call in it is decided. Call BEFORE the cards go out — a
   * decision can only land on a call that exists. A batch still open under
   * the same loop key is superseded (its undecided calls are denied): one
   * loop runs one tool batch at a time.
   */
  async open(
    loopKey: string,
    request: ApprovalBatchRequest,
    owner: DecisionOwner = {},
  ): Promise<{ decisions: Promise<Map<string, ToolCallDecision>> }> {
    await lapse(loopKey, "superseded");
    if (request.calls.length === 0) return { decisions: Promise.resolve(new Map()) };

    const createdAt = new Date().toISOString();
    await PendingDecisionStore.insert(
      request.calls.map((call, position) => ({
        ...owner,
        id: pendingDecisionId(loopKey, request.batchId, call.toolCallId),
        loopKey,
        kind: request.type,
        itemId: call.toolCallId,
        batchId: request.batchId,
        position,
        status: "pending",
        createdAt,
        name: call.name,
        args: call.args,
        ...(call.tier !== undefined ? { tier: call.tier } : {}),
        ...(call.tierLabel !== undefined ? { tierLabel: call.tierLabel } : {}),
        argsSchema: call.argsSchema ?? null,
        ...(call.preview ? { preview: call.preview } : {}),
      })),
    );

    let resolve!: BatchWaiter["resolve"];
    const decisions = new Promise<Map<string, ToolCallDecision>>((settle) => {
      resolve = settle;
    });
    waiters.set(loopKey, {
      loopKey,
      type: request.type,
      batchId: request.batchId,
      order: request.calls.map((call) => call.toolCallId),
      decisions: new Map(),
      onDecided: request.onDecided,
      resolve,
      owner,
    });
    await ConversationRunState.park(locatorFor(loopKey, owner));
    return { decisions };
  },

  /**
   * Apply one decision from the client. Never approves anything implicitly;
   * each call is decided at most once (a conditional write on its record),
   * however many POSTs race for it.
   */
  async decide(loopKey: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionOutcome> {
    const toolCallId = input.toolCallId;
    const pending = await PendingDecisionStore.find({
      loopKey,
      kinds: APPROVAL_KINDS,
      status: "pending",
    });
    // One batch is pending per loop; if a race ever left two, the newest is it.
    const batchId = pending.at(-1)?.batchId ?? null;
    const batch = pending.filter((record) => record.batchId === batchId);

    if (batch.length === 0) {
      if (!toolCallId) return { status: "not_found" };
      const known = await PendingDecisionStore.findItem(loopKey, toolCallId, APPROVAL_KINDS);
      return known ? { status: "stale", toolCallId } : { status: "not_found" };
    }
    if (input.batchId && input.batchId !== batchId) {
      return { status: "stale", toolCallId };
    }

    let target: PendingDecisionRecord | undefined;
    if (toolCallId) {
      target = batch.find((record) => record.itemId === toolCallId);
      if (!target) {
        const known = await PendingDecisionStore.findItem(loopKey, toolCallId, APPROVAL_KINDS);
        return known ? { status: "stale", toolCallId } : { status: "not_found" };
      }
    }

    const scope: ApprovalScope = input.scope ?? "call";
    if (scope !== "call" && input.decision !== "allow") {
      return { status: "invalid", error: `scope "${scope}" can only allow` };
    }

    if (!target && scope === "call") {
      if (batch.length !== 1) {
        return {
          status: "ambiguous",
          pendingToolCallIds: batch.map((record) => record.itemId),
        };
      }
      target = batch[0];
    }

    const type = batch[0].kind === "plan" ? "plan" : "tool";
    if (input.editedArgs !== undefined) {
      if (!target) return { status: "invalid", error: "editedArgs needs a toolCallId" };
      if (input.decision !== "allow") {
        return { status: "invalid", error: "editedArgs can only accompany an allow" };
      }
      if (type === "plan") {
        return { status: "invalid", error: "a plan's arguments cannot be edited" };
      }
      const validation = validateToolArgs(target.argsSchema, input.editedArgs);
      if (!validation.ok) {
        return { status: "invalid", error: `editedArgs rejected: ${validation.error}` };
      }
    }

    const decisionsToApply: Array<[PendingDecisionRecord, ToolCallDecision]> = [];
    if (target) {
      const reason = input.decision === "deny" ? normalizeReason(input.reason) : undefined;
      decisionsToApply.push([
        target,
        {
          decision: input.decision,
          scope,
          source: "user",
          ...(reason ? { reason } : {}),
          ...(input.editedArgs !== undefined ? { editedArgs: input.editedArgs } : {}),
        },
      ]);
    }
    if (scope !== "call") {
      for (const record of batch) {
        if (record === target) continue;
        decisionsToApply.push([record, { decision: "allow", scope, source: "user" }]);
      }
    }

    const decidedToolCallIds: string[] = [];
    let delivered = false;
    for (const [record, decision] of decisionsToApply) {
      const won = await PendingDecisionStore.settle(record.id, { status: "decided", decision });
      if (!won) {
        // Another POST decided it first: that one was the decision.
        if (record === target) return { status: "stale", toolCallId: record.itemId };
        continue;
      }
      decidedToolCallIds.push(record.itemId);
      if (deliver(loopKey, record.batchId!, record.itemId, decision)) delivered = true;
    }

    const remaining = (
      await PendingDecisionStore.find({ loopKey, kinds: APPROVAL_KINDS, status: "pending" })
    ).filter((record) => record.batchId === batchId).length;
    if (!delivered && !(await PendingDecisionStore.isParked(loopKey))) {
      // No turn here was waiting (the process that asked is gone): nothing
      // is awaited any more; the decisions wait for the re-driven turn.
      await ConversationRunState.clear(locatorFor(loopKey, batch[0]));
    }
    return {
      status: "decided",
      type,
      batchId: batchId!,
      decidedToolCallIds,
      remaining,
      delivered,
    };
  },

  /** The undecided calls of the batch pending on this loop, if any. */
  async getPending(loopKey: string): Promise<PendingApprovalSnapshot | null> {
    const pending = await PendingDecisionStore.find({
      loopKey,
      kinds: APPROVAL_KINDS,
      status: "pending",
    });
    if (pending.length === 0) return null;
    const batchId = pending.at(-1)!.batchId!;
    const batch = pending.filter((record) => record.batchId === batchId);
    return {
      type: batch[0].kind === "plan" ? "plan" : "tool",
      batchId,
      toolCalls: batch.map((record) => ({
        id: record.itemId,
        name: record.name ?? "",
        args: record.args ?? {},
        batchId,
        ...(record.preview ? { preview: record.preview as ApprovalPreview } : {}),
        _approval: {
          tier: String(record.tier ?? ""),
          tierLabel: record.tierLabel ?? "",
        },
      })),
    };
  },

  /** A decided call, as recorded — null while pending or never seen. */
  async getDecision(loopKey: string, toolCallId: string): Promise<ToolCallDecision | null> {
    const record = await PendingDecisionStore.findItem(loopKey, toolCallId, APPROVAL_KINDS);
    return record ? recordDecision(record) : null;
  },

  /** The turn is over (ended, or stopped): deny whatever it was still waiting on. */
  async cancel(loopKey: string): Promise<void> {
    await lapse(loopKey, "turn_ended");
  },

  /**
   * A new turn starts on this loop: calls still pending from a turn that is
   * not running here (it died with a previous process) will never be acted
   * on by this one — supersede them. A live batch is left alone. Returns
   * the records it settled.
   */
  async retireOrphans(loopKey: string): Promise<PendingDecisionRecord[]> {
    if (waiters.has(loopKey)) return [];
    return lapse(loopKey, "superseded");
  },

  /** Test helper — forget every waiter and every in-memory record. */
  _clearAll(): void {
    waiters.clear();
    PendingDecisionStore._clearMemory();
    ConversationRunState._reset();
  },
};

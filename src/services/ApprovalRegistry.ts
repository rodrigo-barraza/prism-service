/**
 * ApprovalRegistry — shared mutable state for pending tool/plan approvals
 * and user-question prompts during agentic loop execution.
 *
 * Lives in its own module to avoid circular imports between
 * AgenticLoopService (the public façade) and harness implementations.
 */
import { APPROVALS } from "#src/constants";
import { validateToolArgs } from "#src/utils/ToolArgsValidator";

// ── Approval Types ─────────────────────────────────────────

export type ApprovalDecisionKind = "allow" | "deny";

/**
 * How far one decision reaches: this call only, every still-pending call of
 * its batch, or — "conversation" — the batch plus every later batch of the
 * conversation (persisted by the route, applied by the running loop).
 */
export type ApprovalScope = "call" | "batch" | "conversation";

/** Who settled a call: the user, or the gate on the user's behalf. */
export type ApprovalDecisionSource =
  | "user"
  | "timeout"
  | "superseded"
  | "turn_ended";

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
  timeoutMilliseconds: number;
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
  isTimedOut?: boolean;
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
// One pending batch per loop key (resolveLoopKey: the client-facing
// conversation id of a root turn, a sub-agent's own id for a sub-agent).
// Every call of the batch is decided on its own; the batch's promise
// resolves when the last one is, so results can keep the model's order.

interface PendingCall extends ApprovalRequestCall {
  decision?: ToolCallDecision;
}

interface PendingBatch {
  loopKey: string;
  type: "tool" | "plan";
  batchId: string;
  calls: PendingCall[];
  onDecided?: ApprovalBatchRequest["onDecided"];
  resolve: (decisions: Map<string, ToolCallDecision>) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

const pendingBatches = new Map<string, PendingBatch>();

/**
 * Settled `(loopKey, toolCallId)` pairs, oldest first, bounded. Lets a
 * decision for a call that is already done answer 409 ("stale") instead of
 * 404, even after its turn ended.
 */
const settledToolCalls = new Map<string, string>();

function settledKey(loopKey: string, toolCallId: string): string {
  return `${loopKey}\u0000${toolCallId}`;
}

function rememberSettled(loopKey: string, toolCallId: string, batchId: string): void {
  const key = settledKey(loopKey, toolCallId);
  settledToolCalls.delete(key);
  settledToolCalls.set(key, batchId);
  while (settledToolCalls.size > APPROVALS.SETTLED_MEMORY) {
    const oldest = settledToolCalls.keys().next().value;
    if (oldest === undefined) break;
    settledToolCalls.delete(oldest);
  }
}

function normalizeReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  return trimmed.length > APPROVALS.MAXIMUM_REASON_LENGTH
    ? `${trimmed.slice(0, APPROVALS.MAXIMUM_REASON_LENGTH)}…`
    : trimmed;
}

function decideCall(batch: PendingBatch, call: PendingCall, decision: ToolCallDecision): void {
  call.decision = decision;
  batch.onDecided?.(call.toolCallId, decision);
}

function finishIfDecided(batch: PendingBatch): void {
  if (batch.calls.some((call) => !call.decision)) return;
  if (batch.timeoutId) clearTimeout(batch.timeoutId);
  if (pendingBatches.get(batch.loopKey) === batch) pendingBatches.delete(batch.loopKey);
  const decisions = new Map<string, ToolCallDecision>();
  for (const call of batch.calls) {
    rememberSettled(batch.loopKey, call.toolCallId, batch.batchId);
    decisions.set(call.toolCallId, call.decision!);
  }
  batch.resolve(decisions);
}

/** Deny every still-pending call of a batch on the user's behalf. */
function settleRemaining(batch: PendingBatch, source: Exclude<ApprovalDecisionSource, "user">): void {
  for (const call of batch.calls) {
    if (!call.decision) decideCall(batch, call, { decision: "deny", scope: "call", source });
  }
  finishIfDecided(batch);
}

export const ApprovalRegistry = {
  /**
   * Park a batch until every call in it is decided (or the timeout denies
   * the rest). A batch still open under the same key is superseded: its
   * undecided calls are denied — one loop runs one tool batch at a time.
   */
  waitForDecisions(
    loopKey: string,
    request: ApprovalBatchRequest,
  ): Promise<Map<string, ToolCallDecision>> {
    const existing = pendingBatches.get(loopKey);
    if (existing) settleRemaining(existing, "superseded");

    return new Promise((resolve) => {
      const batch: PendingBatch = {
        loopKey,
        type: request.type,
        batchId: request.batchId,
        calls: request.calls.map((call) => ({ ...call })),
        onDecided: request.onDecided,
        resolve,
        timeoutId: null,
      };
      pendingBatches.set(loopKey, batch);
      if (batch.calls.length === 0) {
        finishIfDecided(batch);
        return;
      }
      batch.timeoutId = setTimeout(
        () => settleRemaining(batch, "timeout"),
        request.timeoutMilliseconds,
      );
    });
  },

  /** Apply one decision from the client. Never approves anything implicitly. */
  decide(loopKey: string, input: ApprovalDecisionInput): ApprovalDecisionOutcome {
    const batch = pendingBatches.get(loopKey);
    const toolCallId = input.toolCallId;

    if (!batch) {
      return toolCallId && settledToolCalls.has(settledKey(loopKey, toolCallId))
        ? { status: "stale", toolCallId }
        : { status: "not_found" };
    }
    if (input.batchId && input.batchId !== batch.batchId) {
      return { status: "stale", toolCallId };
    }

    let target: PendingCall | undefined;
    if (toolCallId) {
      target = batch.calls.find((call) => call.toolCallId === toolCallId);
      if (!target) {
        return settledToolCalls.has(settledKey(loopKey, toolCallId))
          ? { status: "stale", toolCallId }
          : { status: "not_found" };
      }
      if (target.decision) return { status: "stale", toolCallId };
    }

    const scope: ApprovalScope = input.scope ?? "call";
    if (scope !== "call" && input.decision !== "allow") {
      return { status: "invalid", error: `scope "${scope}" can only allow` };
    }

    const undecided = batch.calls.filter((call) => !call.decision);
    if (!target && scope === "call") {
      if (undecided.length !== 1) {
        return {
          status: "ambiguous",
          pendingToolCallIds: undecided.map((call) => call.toolCallId),
        };
      }
      target = undecided[0];
    }

    if (input.editedArgs !== undefined) {
      if (!target) return { status: "invalid", error: "editedArgs needs a toolCallId" };
      if (input.decision !== "allow") {
        return { status: "invalid", error: "editedArgs can only accompany an allow" };
      }
      if (batch.type === "plan") {
        return { status: "invalid", error: "a plan's arguments cannot be edited" };
      }
      const validation = validateToolArgs(target.argsSchema, input.editedArgs);
      if (!validation.ok) {
        return { status: "invalid", error: `editedArgs rejected: ${validation.error}` };
      }
    }

    const decidedToolCallIds: string[] = [];
    if (target) {
      decideCall(batch, target, {
        decision: input.decision,
        scope,
        source: "user",
        ...(input.decision === "deny" && normalizeReason(input.reason)
          ? { reason: normalizeReason(input.reason) }
          : {}),
        ...(input.editedArgs !== undefined ? { editedArgs: input.editedArgs } : {}),
      });
      decidedToolCallIds.push(target.toolCallId);
    }
    if (scope !== "call") {
      for (const call of batch.calls) {
        if (call.decision) continue;
        decideCall(batch, call, { decision: "allow", scope, source: "user" });
        decidedToolCallIds.push(call.toolCallId);
      }
    }

    const remaining = batch.calls.filter((call) => !call.decision).length;
    const { type, batchId } = batch;
    finishIfDecided(batch);
    return { status: "decided", type, batchId, decidedToolCallIds, remaining };
  },

  /** The undecided calls of the batch waiting on this loop, if any. */
  getPending(loopKey: string): PendingApprovalSnapshot | null {
    const batch = pendingBatches.get(loopKey);
    if (!batch) return null;
    return {
      type: batch.type,
      batchId: batch.batchId,
      toolCalls: batch.calls
        .filter((call) => !call.decision)
        .map((call) => ({
          id: call.toolCallId,
          name: call.name,
          args: call.args,
          batchId: batch.batchId,
          ...(call.preview ? { preview: call.preview } : {}),
          _approval: {
            tier: String(call.tier ?? ""),
            tierLabel: call.tierLabel ?? "",
          },
        })),
    };
  },

  /** The turn is over: deny whatever it was still waiting on. */
  cancel(loopKey: string): void {
    const batch = pendingBatches.get(loopKey);
    if (batch) settleRemaining(batch, "turn_ended");
  },

  /** Test helper — forget every pending batch and settled id. */
  _clearAll(): void {
    for (const batch of pendingBatches.values()) {
      if (batch.timeoutId) clearTimeout(batch.timeoutId);
    }
    pendingBatches.clear();
    settledToolCalls.clear();
  },
};

// ── Question Resolver Registry ─────────────────────────────
// loop key (LoopKey.resolveLoopKey — the id the client answers with) →
// questionId → entry. Several can be open at once: non-blocking cards stay
// open while the loop keeps working and may ask again.
// The HTTP endpoint resolves these when the user answers an ask_user_question.
export const pendingQuestions = new Map<string, Map<string, PendingQuestionEntry>>();

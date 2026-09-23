import type { Collection, Document } from "mongodb";
import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS, PENDING_DECISIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * PendingDecisionStore — the durable half of every wait a turn makes on its
 * user: a tool call's approval, a plan's approval, an `ask_user` question.
 *
 * One record per decision in `pending_decisions`. The registries
 * (ApprovalRegistry, QuestionRegistry) write a record BEFORE the card goes
 * out, and every decision is a conditional write on it
 * (`status: "pending"` → decided/answered), so the database — not a map in
 * the process that asked — says what is pending and what was decided. That
 * is what makes a decision survive a restart (it is stored, and the turn
 * picks it up when it is re-driven) and what makes it exactly-once (a second
 * POST loses the conditional write and reads 409).
 *
 * There is no timeout. A record leaves `pending` only when the user decides,
 * a newer batch of the same loop supersedes it, or the turn that asked ends.
 * Settled records expire after PENDING_DECISIONS.SETTLED_RETENTION_DAYS
 * (TTL index on `expiresAt`, see src/index.ts); pending ones never do.
 *
 * Without a connected database (unit tests, a degraded boot) records live in
 * a process-local map with the same semantics — and die with the process,
 * which is exactly what they did before this store existed.
 */

export type PendingDecisionKind = "tool" | "plan" | "question" | "budget";
export type PendingDecisionStatus = "pending" | "decided" | "answered" | "cancelled";

/** An approval as recorded — the same shape the loop acts on. */
export interface StoredApprovalDecision {
  decision: "allow" | "deny";
  scope: "call" | "batch" | "conversation";
  source: "user" | "superseded" | "turn_ended";
  reason?: string;
  editedArgs?: Record<string, unknown>;
}

/** Which cap a budget pause is bound by: the turn's own, or the conversation goal's. */
export type BudgetLimit = "turn" | "goal";

/** A budget pause as decided: raise a cap (the turn's and/or the goal's), or stop. */
export interface StoredBudgetDecision {
  action: "raise" | "stop";
  source: "user" | "superseded" | "turn_ended";
  /** The turn's new cap. */
  turnCapDollars?: number | null;
  /** The goal's new dollar budget (null: the goal no longer caps it). */
  goalMaxCostDollars?: number | null;
}

/** Who asked, and where their conversation lives — enough to find it after a restart. */
export interface DecisionOwner {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  agentConversationId?: string | null;
  /** The parent loop's conversation, for a sub-agent (null for a root turn). */
  parentConversationId?: string | null;
  /** Collection of the conversation document the loop persists into. */
  conversationCollection?: string | null;
}

export interface PendingDecisionRecord extends DecisionOwner {
  /** `<loopKey>/<batchId|"question">/<itemId>` — unique. */
  id: string;
  /** The loop the decision belongs to (LoopKey.resolveLoopKey). */
  loopKey: string;
  kind: PendingDecisionKind;
  /** A tool call's toolCallId, or a question's questionId. */
  itemId: string;
  /** The approval batch; null for a question. */
  batchId: string | null;
  /** Position in the batch — results keep the model's order. */
  position: number;
  status: PendingDecisionStatus;
  createdAt: string;
  decidedAt?: string;
  /** Set when the record leaves `pending`; the TTL index removes it after. */
  expiresAt?: Date;

  // ── An approval: what the call would do ──
  name?: string;
  args?: Record<string, unknown>;
  tier?: number | string;
  tierLabel?: string;
  /** The tool's JSON-Schema `parameters` — edited arguments must satisfy it. */
  argsSchema?: Record<string, unknown> | null;
  preview?: unknown;
  /** Who asked for the card besides the tier: a hook, a restart ("run it again?"), or auto mode ("classifier"). */
  requestedBy?: string;
  reason?: string;
  /** The taint check asked: the untrusted text the arguments carry, and where it was read. */
  untrustedText?: { excerpt: string; source: string };
  decision?: StoredApprovalDecision;

  // ── A question ──
  /** The ask_user call that asked it — how a turn re-driven after a restart finds it again. */
  toolCallId?: string | null;
  /**
   * An answer to a non-blocking card that no turn took (it arrived while
   * the server was down); the re-driven turn delivers it and clears this.
   */
  undelivered?: boolean;
  blocking?: boolean;
  question?: string;
  questions?: unknown[];
  choices?: string[];
  answers?: unknown[];

  // ── A budget pause (the tree reached its cost cap) ──
  /** What the tree had spent when it paused. */
  spentDollars?: number;
  /** The cap it reached — the lower of the turn's and the goal's. */
  maxCostDollars?: number;
  limitedBy?: BudgetLimit;
  /** The turn's own cap (null: none — the goal's is the only one). */
  turnCapDollars?: number | null;
  /** The goal's dollar budget and what it had spent before this turn (null: no goal cap). */
  goalMaxCostDollars?: number | null;
  goalSpentBeforeTurnDollars?: number | null;
  /** The iteration the pause stopped at. */
  iteration?: number;
  budgetDecision?: StoredBudgetDecision;
  /** False: the raise was stored with no turn running to take it — the re-driven turn applies it. */
  delivered?: boolean;
}

export interface PendingDecisionQuery {
  loopKey?: string;
  kinds?: readonly PendingDecisionKind[];
  status?: PendingDecisionStatus;
  itemId?: string;
  agentConversationId?: string;
  /** Records of a sub-agent loop, filed under its parent's conversation. */
  parentConversationId?: string;
}

export type SettlePatch =
  | { status: "decided"; decision: StoredApprovalDecision }
  | { status: "answered"; answers: unknown[] }
  | { status: "decided"; budgetDecision: StoredBudgetDecision; delivered: boolean }
  | { status: "cancelled" };

// ── Backends ─────────────────────────────────────────────────────────

/** Process-local fallback: used only when no database is connected. */
const memoryRecords = new Map<string, PendingDecisionRecord>();

function database(): Collection<Document> | null {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME)?.collection(COLLECTIONS.PENDING_DECISIONS) ?? null;
  } catch {
    // Not connected (tests, a boot without Mongo): the memory map stands in.
    return null;
  }
}

function matches(record: PendingDecisionRecord, query: PendingDecisionQuery): boolean {
  if (query.loopKey !== undefined && record.loopKey !== query.loopKey) return false;
  if (query.kinds && !query.kinds.includes(record.kind)) return false;
  if (query.status !== undefined && record.status !== query.status) return false;
  if (query.itemId !== undefined && record.itemId !== query.itemId) return false;
  if (
    query.agentConversationId !== undefined &&
    record.agentConversationId !== query.agentConversationId
  ) {
    return false;
  }
  if (
    query.parentConversationId !== undefined &&
    record.parentConversationId !== query.parentConversationId
  ) {
    return false;
  }
  return true;
}

function toMongoFilter(query: PendingDecisionQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.loopKey !== undefined) filter.loopKey = query.loopKey;
  if (query.status !== undefined) filter.status = query.status;
  if (query.itemId !== undefined) filter.itemId = query.itemId;
  if (query.agentConversationId !== undefined) {
    filter.agentConversationId = query.agentConversationId;
  }
  if (query.parentConversationId !== undefined) {
    filter.parentConversationId = query.parentConversationId;
  }
  if (query.kinds) filter.kind = { $in: [...query.kinds] };
  return filter;
}

/** Oldest first; a batch in the model's order. */
function byCreation(left: PendingDecisionRecord, right: PendingDecisionRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.position - right.position;
}

function stripMongoId(document: Document): PendingDecisionRecord {
  const { _id: _ignored, ...record } = document;
  return record as PendingDecisionRecord;
}

function settledFields(patch: SettlePatch, now: Date): Record<string, unknown> {
  return {
    ...patch,
    decidedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + PENDING_DECISIONS.SETTLED_RETENTION_DAYS * 86_400_000,
    ),
  };
}

// ── Store ────────────────────────────────────────────────────────────

export function pendingDecisionId(
  loopKey: string,
  batchId: string | null,
  itemId: string,
): string {
  return `${loopKey}/${batchId ?? "question"}/${itemId}`;
}

const PendingDecisionStore = {
  /**
   * Record decisions about to be asked for. Throws only if the database
   * write fails — then the records are kept in memory instead (logged),
   * so the turn still gets its answer; they just don't survive a restart.
   */
  async insert(records: PendingDecisionRecord[]): Promise<void> {
    if (records.length === 0) return;
    const collection = database();
    if (collection) {
      try {
        await collection.insertMany(records.map((record) => ({ ...record })));
        return;
      } catch (error: unknown) {
        logger.error(
          `[PendingDecisionStore] Could not persist ${records.length} decision(s) for ${records[0].loopKey} — kept in memory only: ${getErrorMessage(error)}`,
        );
      }
    }
    for (const record of records) memoryRecords.set(record.id, { ...record });
  },

  /** Records matching the query, oldest first. */
  async find(query: PendingDecisionQuery): Promise<PendingDecisionRecord[]> {
    const fromMemory = [...memoryRecords.values()].filter((record) => matches(record, query));
    const collection = database();
    let fromDatabase: PendingDecisionRecord[] = [];
    if (collection) {
      try {
        fromDatabase = (await collection.find(toMongoFilter(query)).toArray()).map(stripMongoId);
      } catch (error: unknown) {
        // A read that fails still serves what this process holds in memory.
        logger.error(`[PendingDecisionStore] Lookup failed: ${getErrorMessage(error)}`);
      }
    }
    const seen = new Set(fromMemory.map((record) => record.id));
    return [...fromMemory, ...fromDatabase.filter((record) => !seen.has(record.id))]
      .map((record) => ({ ...record }))
      .sort(byCreation);
  },

  /** The newest record for one item of a loop, whatever its status. */
  async findItem(
    loopKey: string,
    itemId: string,
    kinds: readonly PendingDecisionKind[],
  ): Promise<PendingDecisionRecord | null> {
    const records = await PendingDecisionStore.find({ loopKey, itemId, kinds });
    return records.at(-1) ?? null;
  },

  /**
   * Take one record out of `pending`. True only for the write that did it —
   * the one and only time this decision is applied.
   */
  async settle(id: string, patch: SettlePatch): Promise<boolean> {
    const now = new Date();
    const inMemory = memoryRecords.get(id);
    if (inMemory) {
      if (inMemory.status !== "pending") return false;
      Object.assign(inMemory, settledFields(patch, now));
      return true;
    }
    const collection = database();
    if (!collection) return false;
    const result = await collection.updateOne(
      { id, status: "pending" },
      { $set: settledFields(patch, now) },
    );
    return result.modifiedCount === 1;
  },

  /**
   * Put an answered record back to cancelled — the answer never reached a
   * turn (a non-blocking card whose turn had closed), so it was not taken.
   */
  async markUndelivered(id: string): Promise<void> {
    const inMemory = memoryRecords.get(id);
    if (inMemory) {
      inMemory.status = "cancelled";
      return;
    }
    await database()?.updateOne({ id }, { $set: { status: "cancelled" } });
  },

  /** Set bookkeeping fields on a record (never its status — `settle` owns that). */
  async update(
    id: string,
    fields: Partial<Pick<PendingDecisionRecord, "undelivered" | "delivered">>,
  ): Promise<void> {
    const inMemory = memoryRecords.get(id);
    if (inMemory) {
      Object.assign(inMemory, fields);
      return;
    }
    await database()?.updateOne({ id }, { $set: fields });
  },

  /** Settle every pending record matching the query; returns the ones this call settled. */
  async settleAll(
    query: Omit<PendingDecisionQuery, "status">,
    patchFor: (record: PendingDecisionRecord) => SettlePatch,
  ): Promise<PendingDecisionRecord[]> {
    const pending = await PendingDecisionStore.find({ ...query, status: "pending" });
    const settled: PendingDecisionRecord[] = [];
    for (const record of pending) {
      const patch = patchFor(record);
      if (await PendingDecisionStore.settle(record.id, patch)) {
        settled.push({ ...record, ...patch });
      }
    }
    return settled;
  },

  /**
   * Is the loop still parked on its user — an approval pending, or a
   * blocking question? (A non-blocking question never parks a turn.)
   */
  async isParked(loopKey: string): Promise<boolean> {
    const pending = await PendingDecisionStore.find({ loopKey, status: "pending" });
    return pending.some((record) => record.kind !== "question" || record.blocking !== false);
  },

  /** Every pending record — what a starting process restores. */
  async listAllPending(): Promise<PendingDecisionRecord[]> {
    return PendingDecisionStore.find({ status: "pending" });
  },

  /** Test helper — forget the in-memory records. */
  _clearMemory(): void {
    memoryRecords.clear();
  },
};

export default PendingDecisionStore;

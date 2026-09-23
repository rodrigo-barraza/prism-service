import type { Collection, Document } from "mongodb";
import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS, TURN_RESUME } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * DetachedWorkStore — background work a turn started and has not been told
 * the outcome of: an async task (`run_async_task`) or a sub-agent dispatch
 * (`create_subagent(s)` / `resume_subagent`, DetachedDispatchRegistry).
 *
 * Both registries live in memory; this is their durable shadow, one record
 * per task or dispatch in `detached_work`:
 *
 *   running    started, no outcome yet
 *   settled    finished (an async task's outcome and result text are kept)
 *   delivered  its outcome reached the parent — through a running turn's
 *              mailbox, a `wait_for_tasks`, a woken turn, or a restart
 *
 * A record still `running` or `settled` when a process starts is work whose
 * outcome its parent never received. TurnResumeService tells the parent
 * once — `claimForRestart` is a conditional write, taken before anything is
 * delivered, so a second boot (or a race) cannot deliver it twice. A running
 * task is reported UNCERTAIN (it may have partly happened) and is never run
 * again on its own. Every write is best-effort.
 */

export type DetachedWorkKind = "async_task" | "subagent_dispatch";
export type DetachedWorkStatus = "running" | "settled" | "delivered";

export interface DetachedWorkRecord {
  /** Unique: `detachedWorkId(kind, scope, itemId)` — task ids repeat across conversations. */
  id: string;
  /** The task id, or the dispatch id. */
  itemId: string;
  kind: DetachedWorkKind;
  /** The parent loop's mailbox key (LoopKey.resolveLoopKey). */
  loopKey: string;
  conversationId: string | null;
  agentConversationId: string | null;
  project: string | null;
  username: string | null;
  // ── An async task ──
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  // ── A sub-agent dispatch ──
  agentIds?: string[];
  status: DetachedWorkStatus;
  /** completed | failed | cancelled — an async task's outcome. */
  outcome?: string;
  /** The task's result, already cut to the notification limit. */
  resultText?: string;
  error?: string | null;
  durationMilliseconds?: number;
  deliveredVia?: string;
  createdAt: string;
  settledAt?: string;
  deliveredAt?: string;
  /** Set once delivered; the TTL index removes it after. */
  expiresAt?: Date;
}

const UNDELIVERED: DetachedWorkStatus[] = ["running", "settled"];

/**
 * A record's key. An async task id is only unique within its loop
 * (`task-<n>-<4 hex>`), so the key names the loop that owns it.
 */
export function detachedWorkId(kind: DetachedWorkKind, scope: string | null, itemId: string): string {
  return `${kind}:${scope ?? ""}:${itemId}`;
}

function collection(): Collection<Document> | null {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME)?.collection(COLLECTIONS.DETACHED_WORK) ?? null;
  } catch {
    return null;
  }
}

async function write(label: string, operation: (work: Collection<Document>) => Promise<unknown>) {
  const work = collection();
  if (!work) return;
  try {
    await operation(work);
  } catch (error: unknown) {
    logger.warn(`[DetachedWorkStore] ${label} failed: ${getErrorMessage(error)}`);
  }
}

function deliveredFields(via: string, now = new Date()) {
  return {
    status: "delivered" as const,
    deliveredVia: via,
    deliveredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TURN_RESUME.SETTLED_RETENTION_DAYS * 86_400_000),
  };
}

const DetachedWorkStore = {
  async started(record: Omit<DetachedWorkRecord, "status" | "createdAt">): Promise<void> {
    await write(`start ${record.id}`, (work) =>
      work.insertOne({ ...record, status: "running", createdAt: new Date().toISOString() }),
    );
  },

  /** A dispatch learned which sub-agents it covers. */
  async assignAgents(id: string, agentIds: string[]): Promise<void> {
    await write(`agents ${id}`, (work) => work.updateOne({ id }, { $set: { agentIds } }));
  },

  /** An async task finished; its outcome waits to be delivered. */
  async settled(
    id: string,
    fields: Pick<DetachedWorkRecord, "outcome" | "resultText" | "error" | "durationMilliseconds">,
  ): Promise<void> {
    await write(`settle ${id}`, (work) =>
      work.updateOne(
        { id, status: "running" },
        { $set: { ...fields, status: "settled", settledAt: new Date().toISOString() } },
      ),
    );
  },

  /** Its outcome reached the parent (or was deliberately not sent: `cancelled`, `dropped`). */
  async delivered(id: string, via: string): Promise<void> {
    await write(`deliver ${id}`, (work) => work.updateOne({ id }, { $set: deliveredFields(via) }));
  },

  /**
   * Take one undelivered record for delivery after a restart. True only for
   * the write that took it — deliver only then.
   */
  async claimForRestart(id: string): Promise<boolean> {
    const work = collection();
    if (!work) return false;
    try {
      const result = await work.updateOne(
        { id, status: { $in: UNDELIVERED } },
        { $set: deliveredFields("restart") },
      );
      return result.modifiedCount === 1;
    } catch (error: unknown) {
      logger.warn(`[DetachedWorkStore] claim ${id} failed: ${getErrorMessage(error)}`);
      return false;
    }
  },

  /** Work whose parent was never told — at boot. */
  async listUndelivered(): Promise<DetachedWorkRecord[]> {
    const work = collection();
    if (!work) return [];
    try {
      const documents = await work.find({ status: { $in: UNDELIVERED } }).toArray();
      return documents
        .map(({ _id: _ignored, ...record }) => record as unknown as DetachedWorkRecord)
        .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
    } catch (error: unknown) {
      logger.error(`[DetachedWorkStore] Could not list detached work: ${getErrorMessage(error)}`);
      return [];
    }
  },
};

export default DetachedWorkStore;

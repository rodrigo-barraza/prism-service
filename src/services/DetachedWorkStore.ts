import type { Collection, Document } from "mongodb";
import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS, TURN_RESUME } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { WorkspaceTaskStatus, WorkspaceTaskType } from "#src/constants/BackgroundTasks";
import type { AuthKind } from "#src/utils/RequestContext";

/**
 * DetachedWorkStore — background work a turn started and has not been told
 * the outcome of: an async task (`run_async_task`), a sub-agent dispatch
 * (`create_subagent(s)` / `resume_subagent`, DetachedDispatchRegistry), or
 * a workspace task (a background `execute_command`, a `monitor`:
 * BackgroundTaskWatcher).
 *
 * The registries live in memory; this is their durable shadow, one record
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
 *
 * A workspace task is the exception: it runs on the workspace, not in this
 * process, so a restart does not end it. Its record keeps the last event it
 * handled (`task.lastSeq`) and the watcher picks it up there at boot
 * (`listUnsettledWorkspaceTasks`); it is delivered once its exit is.
 */

export type DetachedWorkKind = "async_task" | "subagent_dispatch" | "workspace_task";
export type DetachedWorkStatus = "running" | "settled" | "delivered";

/** A workspace task's own fields (BackgroundTaskWatcher). */
export interface WorkspaceTaskFields {
  type: WorkspaceTaskType;
  description: string;
  command?: string;
  wsUrl?: string;
  outputFile?: string;
  /** A monitor's deadline (ms). */
  timeoutMs?: number | null;
  /** The workspace root (or worktree) it runs in. */
  workspaceRoot?: string | null;
  /** Its owner is a sub-agent: never woken; its monitors end with its run. */
  isSubAgent?: boolean;
  /** `running`, then how it ended. */
  status: WorkspaceTaskStatus;
  /** The last event (or the exit) handled: a re-attach resumes after it. */
  lastSeq: number;
  /** A monitor's event lines delivered so far. */
  eventCount: number;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
}

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
  /**
   * How the turn that started it authenticated: a wake it causes runs with
   * the same (TaskNotificationDelivery) — owner powers only for a signed-in
   * user's work. Absent on a record from before authentication: none.
   */
  authKind?: AuthKind | null;
  // ── An async task ──
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  // ── A sub-agent dispatch ──
  agentIds?: string[];
  // ── A workspace task ──
  task?: WorkspaceTaskFields;
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

  /**
   * Work whose parent was never told — at boot. Not a workspace task: a
   * restart did not end it, and the watcher picks it up where it was.
   */
  async listUndelivered(): Promise<DetachedWorkRecord[]> {
    return find({ status: { $in: UNDELIVERED }, kind: { $ne: "workspace_task" } }, "detached work");
  },

  /** A workspace task handled more of its stream (`task.lastSeq`, its count, its status). */
  async progressed(id: string, fields: Partial<WorkspaceTaskFields>): Promise<void> {
    const update = Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [`task.${field}`, value]),
    );
    if (Object.keys(update).length === 0) return;
    await write(`progress ${id}`, (work) => work.updateOne({ id }, { $set: update }));
  },

  /** A workspace task's exit reached its owner (or was deliberately not sent: `stopped`, `dropped`). */
  async workspaceTaskEnded(id: string, fields: Partial<WorkspaceTaskFields>, via: string): Promise<void> {
    const update = Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [`task.${field}`, value]),
    );
    await write(`end ${id}`, (work) =>
      work.updateOne({ id }, { $set: { ...update, ...deliveredFields(via) } }),
    );
  },

  /** Workspace tasks still being watched when the last process stopped — at boot. */
  async listUnsettledWorkspaceTasks(): Promise<DetachedWorkRecord[]> {
    return find({ kind: "workspace_task", status: { $in: UNDELIVERED } }, "workspace tasks");
  },

  /** A conversation's workspace tasks, running and ended (until the TTL removes them). */
  async listWorkspaceTasks(owner: {
    conversationId: string;
    project?: string | null;
    username?: string | null;
  }): Promise<DetachedWorkRecord[]> {
    return find(
      {
        kind: "workspace_task",
        conversationId: owner.conversationId,
        ...(owner.project ? { project: owner.project } : {}),
        ...(owner.username ? { username: owner.username } : {}),
      },
      "a conversation's workspace tasks",
    );
  },

  /** One workspace task's record, by its task id. */
  async findWorkspaceTask(taskId: string): Promise<DetachedWorkRecord | null> {
    const [record] = await find({ kind: "workspace_task", itemId: taskId }, `workspace task ${taskId}`);
    return record ?? null;
  },
};

/** Records matching `filter`, oldest first; [] when the database is not there. */
async function find(filter: Document, label: string): Promise<DetachedWorkRecord[]> {
  const work = collection();
  if (!work) return [];
  try {
    const documents = await work.find(filter).toArray();
    return documents
      .map(({ _id: _ignored, ...record }) => record as unknown as DetachedWorkRecord)
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
  } catch (error: unknown) {
    logger.error(`[DetachedWorkStore] Could not list ${label}: ${getErrorMessage(error)}`);
    return [];
  }
}

export default DetachedWorkStore;

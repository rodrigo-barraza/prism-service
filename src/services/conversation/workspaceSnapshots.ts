import {
  IDENTITY_HEADERS,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME, TOOLS_SERVICE_URL } from "#config";
import { COLLECTIONS, WORKSPACE_SNAPSHOTS } from "#src/constants";
import logger from "#src/utils/logger";
import type { Document } from "mongodb";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, ToolCall } from "#src/services/harnesses/types";
import { servedMessageId } from "./messageIds.ts";

// ────────────────────────────────────────────────────────────
// Workspace snapshots — the CODE half of rewind
// ────────────────────────────────────────────────────────────
// Before every tool batch that can write to the workspace (file writes,
// shell), tools-service snapshots the workspace into a shadow git ref —
// refs/prism/checkpoints/<conversationId>/<turn>-<iteration> — through a
// temporary index, never the user's (tools-service
// AgenticGitSnapshotService). After the batch a second `-after` snapshot
// records what the agent left behind, so a later restore can tell the
// agent's writes from the user's: anything that differs from the latest
// snapshot was changed by someone else, and the restore refuses unless
// forced. Read-only batches are never snapshotted.
//
// Each snapshot is recorded on the conversation document under
// `workspaceSnapshots`; rewind (branching.ts) picks the target from them.
// A workspace that is not a git repository is recorded once per turn under
// `workspaceSnapshotStatus` so rewind can say why code is not restorable.
// ────────────────────────────────────────────────────────────

/** Tools whose batch is snapshotted first: file writes and shell. */
export const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.REPLACE_IN_FILE,
  TOOL_NAMES.PATCH_FILE,
  // tools-service registers the patch tool as `apply_patch`
  "apply_patch",
  TOOL_NAMES.MOVE_FILE,
  TOOL_NAMES.DELETE_FILE,
  TOOL_NAMES.EDIT_NOTEBOOK,
  TOOL_NAMES.EXECUTE_SHELL,
  TOOL_NAMES.EXECUTE_COMMAND,
  // run_git can check out / reset; commit_split rewrites the index and commits
  "run_git",
  "commit_split",
]);

export type WorkspaceSnapshotPhase = "before" | "after" | "restore";

export interface WorkspaceSnapshotRecord {
  ref: string;
  phase: WorkspaceSnapshotPhase;
  turn: number;
  iteration: number;
  /** Served id of the last persisted message when the snapshot was taken; the snapshot sits after it. */
  messageId: string | null;
  /** Persisted message count at snapshot time — where the turn's first message lands. */
  messageBoundary: number;
  /** The batch's tool call ids: locate the assistant message that issued them once the turn persists. */
  toolCallIds: string[];
  /** The workspace root as tools-service resolved it (realpath). */
  workspaceRoot: string;
  commit: string;
  createdAt: string;
  /** restore records: the pre-restore state, kept so a forced restore can be undone. */
  undoRef?: string;
}

export interface WorkspaceSnapshotStatus {
  capable: boolean;
  reason: string;
  workspaceRoot: string | null;
  checkedAt: string;
}

// ── tools-service client ────────────────────────────────────

export interface ToolsSnapshotResponse {
  snapshotCapable?: boolean;
  reason?: string;
  error?: string;
  ref?: string;
  commit?: string;
  workspaceRoot?: string;
  createdAt?: number;
}

export interface ToolsRestoreResponse {
  snapshotCapable?: boolean;
  reason?: string;
  error?: string;
  ref?: string;
  againstRef?: string | null;
  workspaceRoot?: string;
  dryRun?: boolean;
  applied?: boolean;
  refused?: boolean;
  conflicts?: string[];
  restored?: string[];
  removed?: string[];
  skipped?: string[];
  counts?: Record<string, number>;
  truncated?: boolean;
  undoRef?: string;
  afterRef?: string;
}

interface CallerIdentity {
  project?: string | null;
  username?: string | null;
  conversationId?: string | null;
}

async function postToTools<T extends object>(
  path: string,
  body: Record<string, unknown>,
  identity: CallerIdentity,
): Promise<T & { httpStatus: number }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (identity.project) headers[IDENTITY_HEADERS.project] = identity.project;
  if (identity.username) headers[IDENTITY_HEADERS.username] = identity.username;
  if (identity.conversationId) {
    headers[IDENTITY_HEADERS.conversationId] = identity.conversationId;
  }
  try {
    const response = await fetch(`${TOOLS_SERVICE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WORKSPACE_SNAPSHOTS.REQUEST_TIMEOUT_MILLISECONDS),
    });
    const payload = (await response.json().catch(() => ({}))) as T;
    return { ...payload, httpStatus: response.status };
  } catch (error: unknown) {
    return {
      error: `tools-service unreachable: ${getErrorMessage(error)}`,
      httpStatus: 0,
    } as unknown as T & { httpStatus: number };
  }
}

export function requestWorkspaceSnapshot(
  workspaceRoot: string,
  ref: string,
  identity: CallerIdentity,
) {
  return postToTools<ToolsSnapshotResponse>(
    "/agentic/git/snapshot",
    { workspaceRoot, ref },
    identity,
  );
}

export function requestWorkspaceRestore(
  body: {
    workspaceRoot: string;
    ref: string;
    againstRef?: string | null;
    /** The agent's own changes since `ref` — the restore touches only these paths. */
    agentRanges?: Array<{ from: string; to: string | null }>;
    force?: boolean;
    dryRun?: boolean;
  },
  identity: CallerIdentity,
) {
  return postToTools<ToolsRestoreResponse>("/agentic/git/restore", body, identity);
}

export function requestWorkspaceSnapshotDeletion(
  body: {
    workspaceRoot: string;
    refs?: string[];
    prefix?: string;
    olderThanMs?: number;
  },
  identity: CallerIdentity = {},
) {
  return postToTools<{ deleted?: string[]; error?: string; reason?: string }>(
    "/agentic/git/snapshot/delete",
    body,
    identity,
  );
}

// ── Ref naming ──────────────────────────────────────────────

/** A conversation's ref namespace. Ids are uuids; anything else is made ref-safe. */
export function snapshotNamespace(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[-_.]+/, "") || "conversation";
  return `${WORKSPACE_SNAPSHOTS.REF_PREFIX}${safe}/`;
}

// ── Recording ───────────────────────────────────────────────

/** Same collection rule as Finalizer.getCollectionOpts / CheckpointTools. */
async function resolveCollection(context: Pick<AgenticContext, "agent" | "project">) {
  const { default: AgentPersonaRegistry } = await import(
    "#src/services/AgentPersonaRegistry"
  );
  if (context.agent || AgentPersonaRegistry.isAgentProject(context.project || "")) {
    return COLLECTIONS.AGENT_CONVERSATIONS;
  }
  return COLLECTIONS.MODEL_CONVERSATIONS;
}

/** Per loop: the turn number and whether this turn already found the workspace not capable. */
interface TurnSnapshotState {
  turn: number;
  collection: string;
  notCapable: boolean;
}
const turnStates = new WeakMap<AgenticLoopState, TurnSnapshotState>();

export interface PendingWorkspaceSnapshot {
  context: AgenticContext;
  turnState: TurnSnapshotState;
  collection: string;
  workspaceRoot: string;
  turn: number;
  iteration: number;
  messageId: string | null;
  messageBoundary: number;
  toolCallIds: string[];
}

function resolveWorkspaceRoot(context: AgenticContext): string | null {
  return typeof context.workspaceRoot === "string" && context.workspaceRoot.trim()
    ? context.workspaceRoot
    : null;
}

async function takeSnapshot(
  pending: PendingWorkspaceSnapshot,
  phase: "before" | "after",
): Promise<void> {
  const { context } = pending;
  const ref =
    `${snapshotNamespace(context.conversationId)}${pending.turn}-${pending.iteration}` +
    (phase === "after" ? "-after" : "");
  const response = await requestWorkspaceSnapshot(pending.workspaceRoot, ref, context);
  const conversations = MongoWrapper.getCollection(MONGO_DB_NAME, pending.collection);
  const owner = {
    id: context.conversationId,
    project: context.project,
    username: context.username,
  };

  if (response.snapshotCapable === false) {
    pending.turnState.notCapable = true;
    const status: WorkspaceSnapshotStatus = {
      capable: false,
      reason: response.reason || "Workspace is not snapshot-capable",
      workspaceRoot: pending.workspaceRoot,
      checkedAt: new Date().toISOString(),
    };
    await conversations.updateOne(owner, { $set: { workspaceSnapshotStatus: status } });
    logger.info(`[workspaceSnapshots] ${context.conversationId}: not snapshot-capable — ${status.reason}`);
    return;
  }
  if (response.error || !response.commit) {
    logger.warn(
      `[workspaceSnapshots] ${phase} snapshot failed for ${context.conversationId} (${ref}): ${response.error || `HTTP ${response.httpStatus}`}`,
    );
    return;
  }

  const record: WorkspaceSnapshotRecord = {
    ref,
    phase,
    turn: pending.turn,
    iteration: pending.iteration,
    messageId: pending.messageId,
    messageBoundary: pending.messageBoundary,
    toolCallIds: pending.toolCallIds,
    workspaceRoot: response.workspaceRoot || pending.workspaceRoot,
    commit: response.commit,
    createdAt: new Date(response.createdAt || Date.now()).toISOString(),
  };
  await conversations.updateOne(owner, {
    $push: { workspaceSnapshots: record },
    $set: {
      workspaceSnapshotStatus: {
        capable: true,
        reason: "",
        workspaceRoot: record.workspaceRoot,
        checkedAt: record.createdAt,
      } satisfies WorkspaceSnapshotStatus,
    },
  } as Document);
}

/**
 * Snapshot the workspace before a tool batch that can write to it.
 * Returns the pending handle for snapshotAfterToolBatch, or null when the
 * batch is read-only, there is no conversation or workspace, or the
 * workspace already proved not snapshot-capable this turn. Never throws:
 * a snapshot failure must not block the agent's tools.
 */
export async function snapshotBeforeToolBatch(
  toolCalls: ToolCall[],
  context: AgenticContext,
  state: AgenticLoopState,
): Promise<PendingWorkspaceSnapshot | null> {
  if (!toolCalls.some((toolCall) => WORKSPACE_WRITE_TOOLS.has(toolCall.name))) {
    return null;
  }
  const workspaceRoot = resolveWorkspaceRoot(context);
  if (!workspaceRoot || !context.conversationId) return null;

  try {
    let turnState = turnStates.get(state);
    const collection = turnState?.collection || (await resolveCollection(context));
    const conversations = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
    const owner = {
      id: context.conversationId,
      project: context.project,
      username: context.username,
    };
    const document = await conversations.findOne(owner, {
      projection: { "messages.id": 1, "workspaceSnapshots.turn": 1 },
    });
    const messages = (document?.messages as object[] | undefined) || [];

    if (!turnState) {
      const turns = ((document?.workspaceSnapshots as Array<{ turn?: number }>) || [])
        .map((record) => record.turn || 0);
      turnState = {
        turn: (turns.length ? Math.max(...turns) : 0) + 1,
        collection,
        notCapable: false,
      };
      turnStates.set(state, turnState);
    }
    if (turnState.notCapable) return null;

    const pending: PendingWorkspaceSnapshot = {
      context,
      turnState,
      collection,
      workspaceRoot,
      turn: turnState.turn,
      iteration: state.iterations,
      messageId: servedMessageId(messages[messages.length - 1], messages.length - 1),
      messageBoundary: messages.length,
      toolCallIds: toolCalls
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    };
    await takeSnapshot(pending, "before");
    return turnState.notCapable ? null : pending;
  } catch (error: unknown) {
    logger.warn(
      `[workspaceSnapshots] before-batch snapshot skipped for ${context.conversationId}: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

/** Snapshot what the batch left behind — the baseline that tells agent writes from user edits. */
export async function snapshotAfterToolBatch(
  pending: PendingWorkspaceSnapshot | null,
): Promise<void> {
  if (!pending) return;
  try {
    await takeSnapshot(pending, "after");
  } catch (error: unknown) {
    logger.warn(
      `[workspaceSnapshots] after-batch snapshot skipped for ${pending.context.conversationId}: ${getErrorMessage(error)}`,
    );
  }
}

// ── Pruning ─────────────────────────────────────────────────

/**
 * Delete every snapshot ref of the given conversations (e.g. on delete),
 * in each workspace their records name. Best-effort; returns the count.
 */
export async function deleteConversationSnapshotRefs(
  owners: Array<{ conversationId: string; workspaceRoots: string[] }>,
): Promise<number> {
  let deleted = 0;
  for (const { conversationId, workspaceRoots } of owners) {
    for (const workspaceRoot of new Set(workspaceRoots)) {
      const response = await requestWorkspaceSnapshotDeletion({
        workspaceRoot,
        prefix: snapshotNamespace(conversationId),
      });
      if (response.error) {
        logger.warn(
          `[workspaceSnapshots] could not delete refs of ${conversationId} in ${workspaceRoot}: ${response.error}`,
        );
        continue;
      }
      deleted += response.deleted?.length || 0;
    }
  }
  return deleted;
}

/** Workspace roots named by a conversation document's snapshot records. */
export function snapshotRootsOf(document: { workspaceSnapshots?: unknown } | null): string[] {
  const records = (document?.workspaceSnapshots as WorkspaceSnapshotRecord[] | undefined) || [];
  return [...new Set(records.map((record) => record.workspaceRoot).filter(Boolean))];
}

/**
 * Age-based pruning (housekeeping): in every workspace any conversation's
 * records name, delete snapshot refs older than the retention window —
 * including refs of conversations already deleted — then drop the expired
 * records from the documents.
 */
export async function pruneExpiredWorkspaceSnapshots({
  maxAgeMilliseconds = WORKSPACE_SNAPSHOTS.RETENTION_MILLISECONDS,
  now = Date.now(),
}: { maxAgeMilliseconds?: number; now?: number } = {}): Promise<{
  deletedRefs: number;
  prunedDocuments: number;
}> {
  const cutoff = new Date(now - maxAgeMilliseconds).toISOString();
  let deletedRefs = 0;
  let prunedDocuments = 0;

  for (const collectionName of [
    COLLECTIONS.MODEL_CONVERSATIONS,
    COLLECTIONS.AGENT_CONVERSATIONS,
  ]) {
    const conversations = MongoWrapper.getCollection(MONGO_DB_NAME, collectionName);
    const documents = await conversations
      .find({ "workspaceSnapshots.0": { $exists: true } })
      .project({ id: 1, project: 1, username: 1, workspaceSnapshots: 1 })
      .toArray();

    const roots = new Set<string>();
    for (const document of documents) {
      for (const root of snapshotRootsOf(document)) roots.add(root);
    }
    for (const workspaceRoot of roots) {
      const response = await requestWorkspaceSnapshotDeletion({
        workspaceRoot,
        prefix: WORKSPACE_SNAPSHOTS.REF_PREFIX,
        olderThanMs: maxAgeMilliseconds,
      });
      if (response.error) {
        logger.warn(`[workspaceSnapshots] prune in ${workspaceRoot} failed: ${response.error}`);
        continue;
      }
      deletedRefs += response.deleted?.length || 0;
    }

    for (const document of documents) {
      const records = (document.workspaceSnapshots as WorkspaceSnapshotRecord[]) || [];
      if (!records.some((record) => record.createdAt < cutoff)) continue;
      // $pull, not a read-modify-write: a turn may $push a record meanwhile.
      await conversations.updateOne(
        { id: document.id, project: document.project, username: document.username },
        { $pull: { workspaceSnapshots: { createdAt: { $lt: cutoff } } } } as Document,
      );
      prunedDocuments += 1;
    }
  }
  return { deletedRefs, prunedDocuments };
}

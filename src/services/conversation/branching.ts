import { randomUUID } from "node:crypto";
import type { Db, Document } from "mongodb";
import { DEFAULT_CONVERSATION_TITLE } from "@rodrigo-barraza/utilities-library/taxonomy";
import { COLLECTIONS } from "#src/constants";
import type { ChatMessage } from "#src/types/admin";
import logger from "#src/utils/logger";
import type { ProfileIdFilter } from "#src/utils/ProfileScope";
import {
  USER_REWIND_PRUNED_BY,
  isHiddenFromDisplay,
  pruneMessagesFrom,
  type ConversationCheckpoint,
} from "./checkpoints.ts";
import { ensureMessageIds, resolveMessageIndex, servedMessageId } from "./messageIds.ts";
import {
  computeModalities,
  computeToolCounts,
  extractProviders,
} from "./utils.ts";
import {
  requestWorkspaceRestore,
  type ToolsRestoreResponse,
  type WorkspaceSnapshotRecord,
  type WorkspaceSnapshotStatus,
} from "./workspaceSnapshots.ts";
import type { ConversationSettings } from "./types.ts";

// ────────────────────────────────────────────────────────────
// Rewind and fork — user-initiated branching of a conversation
// ────────────────────────────────────────────────────────────
// Both address a message by its served id (messageIds.ts). "At message M"
// always INCLUDES M; when M is an assistant message that called tools, it
// also includes the role:"tool" results right after it — the client shows
// them inside M, and a history ending in an unanswered tool call is
// rejected by providers.
//
// rewind {restore: conversation | code | both}
//   conversation — soft-prunes every message after M with the same pruning
//     the model's `rewind` tool uses (checkpoints.ts), stamped
//     prunedBy: "user-rewind" so display serving hides them.
//   code — restores each workspace to the first "before" snapshot taken
//     after M (the state the user saw at M: the agent's next write had not
//     happened yet), via tools-service. The conflict baseline is the
//     latest snapshot, so a file the user edited after the agent's last
//     write makes the restore refuse (409) unless `force`.
//   both — code first; a refused or failed restore leaves the
//     conversation untouched.
//
// fork — a NEW conversation holding a copy of the messages through M
// (tool calls and results included) and `forkedFrom: {conversationId,
// messageId}`. Files are not touched; request rows and costs are not
// copied, so the fork's cost rollup starts at zero. `position: "before"`
// copies only what precedes M — edit-as-branch: the client then sends the
// edited prompt in the fork, and the original conversation stays intact.
// ────────────────────────────────────────────────────────────

export const REWIND_RESTORE_MODES = ["conversation", "code", "both"] as const;
export type RewindRestoreMode = (typeof REWIND_RESTORE_MODES)[number];

export interface ConversationScope {
  conversationId: string;
  project: string;
  username: string;
  profileId: ProfileIdFilter;
}

interface ConversationDocument extends Document {
  id: string;
  project: string;
  username: string;
  title?: string;
  profileId?: string | null;
  messages?: ChatMessage[];
  checkpoints?: ConversationCheckpoint[];
  workspaceSnapshots?: WorkspaceSnapshotRecord[];
  workspaceSnapshotStatus?: WorkspaceSnapshotStatus;
  isGenerating?: boolean;
  settings?: ConversationSettings;
}

interface FoundConversation {
  document: ConversationDocument;
  collection: string;
  type: "direct" | "agent";
}

async function findConversation(db: Db, scope: ConversationScope): Promise<FoundConversation | null> {
  const filter = {
    id: scope.conversationId,
    project: scope.project,
    username: scope.username,
    profileId: scope.profileId,
  };
  for (const [collection, type] of [
    [COLLECTIONS.MODEL_CONVERSATIONS, "direct"],
    [COLLECTIONS.AGENT_CONVERSATIONS, "agent"],
  ] as const) {
    const document = (await db.collection(collection).findOne(filter)) as ConversationDocument | null;
    if (document) return { document, collection, type };
  }
  return null;
}

export class BranchingError extends Error {
  status: number;
  details: Record<string, unknown>;
  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** M's index, extended through the role:"tool" results that answer its tool calls. */
export function extendThroughToolResults(messages: ChatMessage[], index: number): number {
  const message = messages[index];
  if (message?.role !== "assistant" || !message.toolCalls?.length) return index;
  let end = index;
  while (messages[end + 1]?.role === "tool") end += 1;
  return end;
}

/**
 * Where a snapshot sits in the raw message order: right after the
 * assistant message that issued its batch (found by tool call id once the
 * turn persisted), else right after the turn's first message.
 */
export function snapshotPosition(record: WorkspaceSnapshotRecord, messages: ChatMessage[]): number {
  if (record.toolCallIds?.length) {
    const wanted = new Set(record.toolCallIds);
    const index = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((toolCall) => toolCall.id && wanted.has(toolCall.id)),
    );
    if (index !== -1) return index;
  }
  return record.messageBoundary;
}

export interface RestorePlan {
  workspaceRoot: string;
  target: WorkspaceSnapshotRecord;
  baseline: WorkspaceSnapshotRecord;
}

/**
 * Per workspace: the target is the earliest "before" snapshot at or after
 * `keepThrough` (the next write after M had not happened yet); the
 * baseline is the latest snapshot of any phase.
 */
export function planRestores(
  records: WorkspaceSnapshotRecord[],
  messages: ChatMessage[],
  keepThrough: number,
): RestorePlan[] {
  const byRoot = new Map<string, WorkspaceSnapshotRecord[]>();
  for (const record of records) {
    const list = byRoot.get(record.workspaceRoot) || [];
    list.push(record);
    byRoot.set(record.workspaceRoot, list);
  }
  const plans: RestorePlan[] = [];
  for (const [workspaceRoot, list] of byRoot) {
    const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const target = ordered.find(
      (record) => record.phase === "before" && snapshotPosition(record, messages) >= keepThrough,
    );
    if (!target) continue;
    plans.push({ workspaceRoot, target, baseline: ordered[ordered.length - 1] });
  }
  return plans;
}

// ── Rewind ──────────────────────────────────────────────────

export interface CodeWorkspaceReport {
  workspaceRoot: string;
  ref: string;
  status: "restored" | "would-restore" | "refused" | "failed";
  restored: string[];
  removed: string[];
  conflicts: string[];
  skipped: string[];
  truncated?: boolean;
  undoRef?: string;
  error?: string;
}

export interface CodeRewindReport {
  status: "restored" | "dry-run" | "refused" | "failed" | "nothing-to-restore" | "unavailable";
  reason?: string;
  workspaces: CodeWorkspaceReport[];
}

export interface ConversationRewindReport {
  prunedCount: number;
  remainingCount: number;
  /** Served id of the last message kept (M, or M's last tool result). */
  keptThroughMessageId: string | null;
}

export interface RewindReport {
  conversationId: string;
  toMessageId: string;
  restore: RewindRestoreMode;
  dryRun: boolean;
  conversation: ConversationRewindReport | null;
  code: CodeRewindReport | null;
}

function workspaceReport(
  plan: RestorePlan,
  response: ToolsRestoreResponse & { httpStatus: number },
): CodeWorkspaceReport {
  const base = {
    workspaceRoot: plan.workspaceRoot,
    ref: plan.target.ref,
    restored: response.restored || [],
    removed: response.removed || [],
    conflicts: response.conflicts || [],
    skipped: response.skipped || [],
    ...(response.truncated && { truncated: true }),
  };
  if (response.refused) return { ...base, status: "refused" };
  if (response.error || response.snapshotCapable === false || response.httpStatus >= 400 || response.httpStatus === 0) {
    return {
      ...base,
      status: "failed",
      error: response.error || response.reason || `tools-service answered HTTP ${response.httpStatus}`,
    };
  }
  if (response.applied) {
    return { ...base, status: "restored", ...(response.undoRef && { undoRef: response.undoRef }) };
  }
  return { ...base, status: "would-restore" };
}

function aggregateCodeStatus(workspaces: CodeWorkspaceReport[], dryRun: boolean): CodeRewindReport["status"] {
  if (workspaces.some((workspace) => workspace.status === "refused")) return "refused";
  if (workspaces.some((workspace) => workspace.status === "failed")) return "failed";
  return dryRun ? "dry-run" : "restored";
}

export async function rewindConversation(
  db: Db,
  scope: ConversationScope,
  {
    toMessageId,
    restore,
    force = false,
    dryRun = false,
  }: { toMessageId: string; restore: RewindRestoreMode; force?: boolean; dryRun?: boolean },
): Promise<{ status: number; report: RewindReport }> {
  const found = await findConversation(db, scope);
  if (!found) throw new BranchingError(404, "Conversation not found");
  const { document, collection } = found;
  if (document.isGenerating && !dryRun) {
    throw new BranchingError(409, "A turn is running in this conversation — stop it before rewinding.");
  }

  const messages = document.messages || [];
  const index = resolveMessageIndex(messages, toMessageId);
  if (index === -1) throw new BranchingError(404, `Message not found: ${toMessageId}`);
  if (messages[index].pruned === true) {
    throw new BranchingError(400, "That message was already rewound out of the conversation.");
  }
  const keepThrough = extendThroughToolResults(messages, index);
  const wantsCode = restore === "code" || restore === "both";
  const wantsConversation = restore === "conversation" || restore === "both";

  const report: RewindReport = {
    conversationId: scope.conversationId,
    toMessageId,
    restore,
    dryRun,
    conversation: null,
    code: null,
  };

  // ── Code ────────────────────────────────────────────────
  const restoreRecords: WorkspaceSnapshotRecord[] = [];
  if (wantsCode) {
    const records = document.workspaceSnapshots || [];
    const plans = planRestores(records, messages, keepThrough);
    if (records.length === 0) {
      const status = document.workspaceSnapshotStatus;
      report.code = {
        status: "unavailable",
        reason:
          status && !status.capable
            ? `Code is not restorable: ${status.reason}`
            : "No workspace snapshots exist for this conversation — the agent made no file or shell writes in a workspace.",
        workspaces: [],
      };
    } else if (plans.length === 0) {
      report.code = {
        status: "nothing-to-restore",
        reason: "The agent wrote nothing to the workspace after this message.",
        workspaces: [],
      };
    } else {
      const identity = { project: scope.project, username: scope.username, conversationId: scope.conversationId };
      const run = (plan: RestorePlan, planDryRun: boolean) =>
        requestWorkspaceRestore(
          {
            workspaceRoot: plan.workspaceRoot,
            ref: plan.target.ref,
            againstRef: plan.baseline.ref,
            force,
            dryRun: planDryRun,
          },
          identity,
        ).then((response) => ({ plan, response }));

      // Several workspaces: preflight all of them so a refusal in one
      // cannot leave another half-restored.
      if (!dryRun && plans.length > 1 && !force) {
        const preflight = await Promise.all(plans.map((plan) => run(plan, true)));
        const blocked = preflight.map(({ plan, response }) => workspaceReport(plan, response));
        const blockedStatus = aggregateCodeStatus(blocked, true);
        if (blockedStatus === "refused" || blockedStatus === "failed") {
          report.code = { status: blockedStatus, workspaces: blocked };
          return { status: blockedStatus === "refused" ? 409 : 502, report };
        }
      }

      const outcomes = await Promise.all(plans.map((plan) => run(plan, dryRun)));
      const workspaces = outcomes.map(({ plan, response }) => workspaceReport(plan, response));
      report.code = { status: aggregateCodeStatus(workspaces, dryRun), workspaces };
      for (const { plan, response } of outcomes) {
        if (!response.applied || !response.afterRef) continue;
        restoreRecords.push({
          ref: response.afterRef,
          phase: "restore",
          turn: plan.target.turn,
          iteration: plan.target.iteration,
          messageId: servedMessageId(messages[keepThrough], keepThrough),
          messageBoundary: messages.length,
          toolCallIds: [],
          workspaceRoot: plan.workspaceRoot,
          commit: "",
          createdAt: new Date().toISOString(),
          ...(response.undoRef && { undoRef: response.undoRef }),
        });
      }
      if (report.code.status === "refused") {
        return { status: 409, report };
      }
      if (report.code.status === "failed" && restoreRecords.length === 0) {
        return { status: 502, report };
      }
    }
  }

  // ── Conversation ────────────────────────────────────────
  const now = new Date().toISOString();
  const pruned = pruneMessagesFrom(messages, keepThrough + 1, USER_REWIND_PRUNED_BY, now);
  if (wantsConversation) {
    report.conversation = {
      prunedCount: pruned.prunedCount,
      remainingCount: pruned.remainingCount,
      keptThroughMessageId: servedMessageId(messages[keepThrough], keepThrough),
    };
  }

  if (!dryRun && (restoreRecords.length > 0 || (wantsConversation && pruned.prunedCount > 0))) {
    const update: Document = { $set: { updatedAt: now } };
    if (wantsConversation && pruned.prunedCount > 0) {
      update.$set.messages = pruned.messages;
      update.$set.checkpoints = (document.checkpoints || []).filter(
        (checkpoint) => checkpoint.messageIndex <= keepThrough + 1,
      );
    }
    if (restoreRecords.length > 0) {
      update.$push = { workspaceSnapshots: { $each: restoreRecords } };
    }
    // Optimistic concurrency: no turn started and nothing was appended
    // since the read, or the read-modify-write of `messages` would drop it.
    const result = await db.collection(collection).updateOne(
      {
        id: scope.conversationId,
        project: scope.project,
        username: scope.username,
        profileId: scope.profileId,
        isGenerating: { $ne: true },
        [`messages.${messages.length}`]: { $exists: false },
      },
      update,
    );
    if (result.matchedCount === 0) {
      throw new BranchingError(
        409,
        "The conversation changed while rewinding (a turn started or messages were added). Nothing in the conversation was changed; retry.",
        { code: report.code },
      );
    }
  }

  logger.info(
    `[branching] rewind ${scope.conversationId} to ${toMessageId} (${restore}${dryRun ? ", dry run" : ""}): ` +
      `conversation ${report.conversation ? `${report.conversation.prunedCount} pruned` : "untouched"}, ` +
      `code ${report.code?.status || "untouched"}`,
  );
  const partialFailure = report.code?.status === "failed";
  return { status: partialFailure ? 207 : 200, report };
}

// ── Fork ────────────────────────────────────────────────────

/** Per-message cost and usage stay with the source: the fork's rollup is its own. */
const TELEMETRY_FIELDS = ["estimatedCost", "usage", "_intermediateUsage", "_intermediateEstimatedCost"];

function stripTelemetry(message: ChatMessage): ChatMessage {
  const copy: Record<string, unknown> = { ...message };
  for (const field of TELEMETRY_FIELDS) delete copy[field];
  return copy as ChatMessage;
}

export type ForkPosition = "at" | "before";

export interface ForkResult {
  id: string;
  type: "direct" | "agent";
  title: string;
  messageCount: number;
  forkedFrom: {
    conversationId: string;
    messageId: string;
    position: ForkPosition;
    title: string;
    forkedAt: string;
  };
}

export async function forkConversation(
  db: Db,
  scope: ConversationScope,
  {
    messageId,
    position = "at",
    stampProfileId,
  }: { messageId: string; position?: ForkPosition; stampProfileId?: string | null },
): Promise<ForkResult> {
  const found = await findConversation(db, scope);
  if (!found) throw new BranchingError(404, "Conversation not found");
  const { document, collection, type } = found;

  const messages = document.messages || [];
  const index = resolveMessageIndex(messages, messageId);
  if (index === -1) throw new BranchingError(404, `Message not found: ${messageId}`);
  if (isHiddenFromDisplay(messages[index])) {
    throw new BranchingError(400, "That message was rewound out of the conversation.");
  }
  const end = position === "before" ? index - 1 : extendThroughToolResults(messages, index);
  const copied = ensureMessageIds(
    messages
      .slice(0, end + 1)
      .filter((message) => !isHiddenFromDisplay(message))
      .map(stripTelemetry),
  );

  const now = new Date().toISOString();
  const sourceTitle = document.title || DEFAULT_CONVERSATION_TITLE;
  const forkedFrom = {
    conversationId: scope.conversationId,
    messageId: servedMessageId(messages[index], index) as string,
    position,
    title: sourceTitle,
    forkedAt: now,
  };
  const settings = (document.settings || {}) as ConversationSettings;
  const modelNames = [
    ...new Set(
      copied
        .filter((message) => message.role === "assistant" && typeof message.model === "string")
        .map((message) => message.model as string),
    ),
  ];
  const forkId = randomUUID();
  const fork: Document = {
    id: forkId,
    project: document.project,
    username: document.username,
    ...((document.profileId || stampProfileId) && {
      profileId: document.profileId || stampProfileId,
    }),
    title: `${sourceTitle} (fork)`,
    systemPrompt: document.systemPrompt || "",
    settings: { ...settings },
    ...(document.workspaceRoot ? { workspaceRoot: document.workspaceRoot } : {}),
    ...(document.agent ? { agent: document.agent } : {}),
    ...(Array.isArray(document.injectedMemoryIds) && { injectedMemoryIds: document.injectedMemoryIds }),
    messages: copied,
    messageCount: copied.length,
    modalities: computeModalities(copied),
    providers: extractProviders(copied, settings),
    toolCounts: computeToolCounts(copied),
    modelNames: modelNames.length ? modelNames : settings.model ? [settings.model] : [],
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    isGenerating: false,
    isActive: false,
    forkedFrom,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(collection).insertOne(fork);
  await db.collection(collection).updateOne(
    {
      id: scope.conversationId,
      project: scope.project,
      username: scope.username,
      profileId: scope.profileId,
    },
    {
      $push: {
        forks: { conversationId: forkId, messageId: forkedFrom.messageId, position, createdAt: now },
      },
    } as Document,
  );

  logger.info(
    `[branching] forked ${scope.conversationId} at ${forkedFrom.messageId} → ${forkId} (${copied.length} message(s))`,
  );
  return { id: forkId, type, title: fork.title as string, messageCount: copied.length, forkedFrom };
}

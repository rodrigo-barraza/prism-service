import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// Conversation checkpoints — named rewind markers
// ────────────────────────────────────────────────────────────
// The `checkpoint` tool records a named marker at the current
// persisted-message boundary of a conversation; the `rewind` tool
// prunes everything recorded after a marker. Pruning is SOFT:
// messages are flagged `pruned: true` on the conversation document
// (the admin UI still reads them, nothing is destroyed) and every
// history-load path excludes them via stripPrunedMessages():
//   - ChatRoutes.prepareGenerationContext (client-sent history)
//   - ConversationTimerService.executeAgenticLoop (timer auto-responses;
//     orchestrator auto-responses route through prepareGenerationContext)
//
// Boundary semantics: a checkpoint's messageIndex is the number of
// messages PERSISTED at the time the tool ran. Messages of the turn
// that recorded the checkpoint only land in the document at finalize —
// i.e. AFTER the marker — so a later rewind prunes that turn too. The
// rewind turn itself also persists after the pruning write, so the
// model keeps the turn in which it invoked rewind.
//
// Compaction interaction rule (chosen rule — documented here because
// this is where the rule lives): REWIND DROPS ANY COMPACTION SUMMARY
// COVERING PRUNED MESSAGES. This holds by construction:
//   1. Compaction summaries are never persisted to the messages array
//      (Finalizer.sanitizeMessagesForPersistence filters
//      `isCompactSummary`), so a summary only ever covers pruned
//      messages inside the live in-memory loop that created it — and
//      the next history load starts from the document, summary-free.
//   2. If a summary-like message ever does sit in the array (legacy or
//      imported docs), a summary always sits AFTER every message it
//      covers, so index-based pruning can never keep a summary whose
//      sources were pruned: covering a pruned message implies an index
//      at or beyond the boundary, which prunes the summary with them.
// ────────────────────────────────────────────────────────────

export interface ConversationCheckpoint {
  name: string;
  description: string | null;
  /** Count of persisted messages when the marker was recorded — the rewind boundary. */
  messageIndex: number;
  createdAt: string;
}

interface CheckpointScope {
  conversationId: string;
  project: string;
  username: string;
  collection?: string;
}

interface PrunableMessage {
  pruned?: boolean;
  prunedAt?: string;
  prunedBy?: string;
  [key: string]: unknown;
}

const DEFAULT_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;

function getCollection(collection: string) {
  return MongoWrapper.getCollection(MONGO_DB_NAME, collection);
}

/**
 * Exclude soft-pruned messages from a loaded history. Every path that
 * feeds persisted conversation messages back into a model context must
 * pass through this filter so a reloaded session honors rewind.
 */
export function stripPrunedMessages<T extends object>(messages: T[]): T[] {
  return messages.filter(
    (message) => (message as PrunableMessage).pruned !== true,
  );
}

/** All checkpoints recorded on a conversation, in recording order. */
export async function getCheckpoints({
  conversationId,
  project,
  username,
  collection = DEFAULT_COLLECTION,
}: CheckpointScope): Promise<ConversationCheckpoint[]> {
  const dbCollection = getCollection(collection);
  const document = await dbCollection.findOne(
    { id: conversationId, project, username },
    { projection: { checkpoints: 1 } },
  );
  return (document?.checkpoints as ConversationCheckpoint[]) || [];
}

/**
 * Record a named checkpoint at the current persisted-message boundary.
 * Re-using an existing name MOVES that checkpoint to the current
 * boundary instead of duplicating it.
 */
export async function recordCheckpoint({
  conversationId,
  project,
  username,
  collection = DEFAULT_COLLECTION,
  name,
  description,
}: CheckpointScope & {
  name?: string | null;
  description?: string | null;
}): Promise<
  { checkpoint: ConversationCheckpoint; moved: boolean } | { error: string }
> {
  const dbCollection = getCollection(collection);
  const document = await dbCollection.findOne(
    { id: conversationId, project, username },
    { projection: { "messages.role": 1, checkpoints: 1 } },
  );
  if (!document) {
    return { error: `Conversation not found: ${conversationId}` };
  }

  const messageIndex = Array.isArray(document.messages)
    ? document.messages.length
    : 0;
  const existing = (document.checkpoints as ConversationCheckpoint[]) || [];
  const resolvedName =
    (typeof name === "string" && name.trim()) ||
    `checkpoint-${existing.length + 1}`;

  const checkpoint: ConversationCheckpoint = {
    name: resolvedName,
    description:
      (typeof description === "string" && description.trim()) || null,
    messageIndex,
    createdAt: new Date().toISOString(),
  };

  const moved = existing.some((entry) => entry.name === resolvedName);
  const nextCheckpoints = [
    ...existing.filter((entry) => entry.name !== resolvedName),
    checkpoint,
  ];

  await dbCollection.updateOne(
    { id: conversationId, project, username },
    {
      $set: {
        checkpoints: nextCheckpoints,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  logger.info(
    `[checkpoints] Recorded "${resolvedName}" at message index ${messageIndex} on ${conversationId}${moved ? " (moved existing)" : ""}`,
  );

  return { checkpoint, moved };
}

/**
 * Soft-prune every persisted message recorded after a checkpoint
 * (default: the most recently recorded one). Checkpoints that point
 * into the pruned range are dropped with it. Nothing is deleted —
 * pruned messages stay on the document, flagged, for the admin UI.
 *
 * Concurrency note: this is a read-modify-write of the messages array.
 * It runs from a tool call mid-turn, when the only other writers of the
 * array ($push at finalize, turnCheckpoint $set) belong to the same
 * loop and are strictly ordered after tool execution.
 */
export async function rewindToCheckpoint({
  conversationId,
  project,
  username,
  collection = DEFAULT_COLLECTION,
  checkpointName,
}: CheckpointScope & { checkpointName?: string | null }): Promise<
  | {
      checkpoint: ConversationCheckpoint;
      prunedCount: number;
      remainingCount: number;
    }
  | { error: string }
> {
  const dbCollection = getCollection(collection);
  const document = await dbCollection.findOne({
    id: conversationId,
    project,
    username,
  });
  if (!document) {
    return { error: `Conversation not found: ${conversationId}` };
  }

  const checkpoints = (document.checkpoints as ConversationCheckpoint[]) || [];
  if (checkpoints.length === 0) {
    return { error: "No checkpoints recorded on this conversation." };
  }

  const requestedName =
    typeof checkpointName === "string" && checkpointName.trim()
      ? checkpointName.trim()
      : null;
  const checkpoint = requestedName
    ? checkpoints.find((entry) => entry.name === requestedName)
    : checkpoints[checkpoints.length - 1];
  if (!checkpoint) {
    return {
      error: `Checkpoint "${requestedName}" not found. Available: ${checkpoints
        .map((entry) => entry.name)
        .join(", ")}`,
    };
  }

  const boundary = checkpoint.messageIndex;
  const now = new Date().toISOString();
  const messages = (document.messages as PrunableMessage[]) || [];

  let prunedCount = 0;
  const nextMessages = messages.map((message, index) => {
    if (index < boundary || message.pruned === true) return message;
    prunedCount += 1;
    return {
      ...message,
      pruned: true,
      prunedAt: now,
      prunedBy: checkpoint.name,
    };
  });

  // Checkpoints recorded beyond the boundary point into pruned territory —
  // drop them so they can never be rewound to.
  const nextCheckpoints = checkpoints.filter(
    (entry) => entry.messageIndex <= boundary,
  );

  await dbCollection.updateOne(
    { id: conversationId, project, username },
    {
      $set: {
        messages: nextMessages,
        checkpoints: nextCheckpoints,
        updatedAt: now,
      },
    },
  );

  const remainingCount = nextMessages.filter(
    (message) => message.pruned !== true,
  ).length;

  logger.info(
    `[checkpoints] Rewound ${conversationId} to "${checkpoint.name}" (index ${boundary}): ` +
      `pruned ${prunedCount} message(s), ${remainingCount} remain in context`,
  );

  return { checkpoint, prunedCount, remainingCount };
}

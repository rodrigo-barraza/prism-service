import type { Collection, Document } from "mongodb";
import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS, TURN_INPUT } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { TurnInputEntry } from "#src/services/TurnInputMailbox";
import type { DecisionOwner } from "#src/services/PendingDecisionStore";

/**
 * TurnInputStore — the durable copy of what a running turn's mailbox
 * (TurnInputMailbox) accepted: a user's mid-turn update, a non-blocking
 * answer, a task completion, a parent's message to a sub-agent.
 *
 * An entry is written when the mailbox accepts it and forgotten when the
 * turn that accepted it ends (by then it is in the turn's persisted
 * messages, or it was dropped exactly as it always was). No expiry: a turn
 * parked on its user waits as long as it takes, and so does its input. One
 * still here when a process starts was accepted by a turn that never
 * finished; the
 * turn's messages say whether it got in — an injected message carries the
 * entry's id (`_turnInput.id`, `_turnInputId`) — and TurnResumeService
 * delivers the rest once: into the re-driven turn, or into the transcript.
 */

export interface StoredTurnInput extends TurnInputEntry {
  loopKey: string;
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  conversationCollection?: string | null;
}

function collection(): Collection<Document> | null {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME)?.collection(COLLECTIONS.TURN_INPUTS) ?? null;
  } catch {
    return null;
  }
}

/** The ids of the mailbox entries a message array already carries. */
export function turnInputIdsIn(messages: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const marker = message?.[TURN_INPUT.MESSAGE_KEY] as { id?: unknown } | undefined;
    if (typeof marker?.id === "string") ids.add(marker.id);
    if (typeof message?._turnInputId === "string") ids.add(message._turnInputId);
  }
  return ids;
}

const TurnInputStore = {
  /** A mailbox accepted an entry. Best-effort: a failed write only costs its restart survival. */
  async record(loopKey: string, entry: TurnInputEntry, owner: DecisionOwner): Promise<void> {
    const inputs = collection();
    if (!inputs) return;
    try {
      await inputs.insertOne({
        ...entry,
        loopKey,
        project: owner.project ?? null,
        username: owner.username ?? null,
        agent: owner.agent ?? null,
        conversationCollection: owner.conversationCollection ?? null,
      });
    } catch (error: unknown) {
      logger.warn(`[TurnInputStore] Could not record ${entry.id} for ${loopKey}: ${getErrorMessage(error)}`);
    }
  },

  /** The turn that accepted these ended: they are in its messages, or were dropped with it. */
  async forget(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await collection()?.deleteMany({ id: { $in: ids } });
    } catch (error: unknown) {
      logger.warn(`[TurnInputStore] Could not forget ${ids.length} entr(ies): ${getErrorMessage(error)}`);
    }
  },

  /** Everything a previous process left — at boot. */
  async listAll(): Promise<StoredTurnInput[]> {
    const inputs = collection();
    if (!inputs) return [];
    try {
      const documents = await inputs.find({}).toArray();
      return documents
        .map(({ _id: _ignored, ...entry }) => entry as unknown as StoredTurnInput)
        .sort((left, right) => left.receivedAt - right.receivedAt);
    } catch (error: unknown) {
      logger.error(`[TurnInputStore] Could not list turn inputs: ${getErrorMessage(error)}`);
      return [];
    }
  },
};

export default TurnInputStore;

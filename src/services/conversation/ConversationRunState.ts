import { MONGO_DB_NAME } from "#config";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import { COLLECTIONS, PENDING_DECISIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { DecisionOwner } from "#src/services/PendingDecisionStore";

/**
 * ConversationRunState — a turn PARKED on its user.
 *
 * While a turn waits for an approval or a blocking answer, its conversation
 * document carries `runState: "awaiting_user"` and `awaitingUserSince`.
 * That is what the `isGenerating` flag could not say: the turn is open but
 * nothing is working — the user is. So:
 *
 *   - the stale-flag sweeps (ChangeStreamService, BackgroundHousekeeping)
 *     leave a parked turn's `isGenerating` alone — waiting an hour is not
 *     a crash;
 *   - a restart clears `isGenerating` (nothing runs any more) but keeps the
 *     park: the decisions are still pending in PendingDecisionStore, and the
 *     conversation still waits on its user.
 *
 * The flag is cleared when the last parked wait of the loop settles. Parks
 * are counted per conversation in this process — a loop has at most one
 * approval batch or blocking question open, but the two registries count
 * independently. Best-effort: a failed write is logged, never thrown into
 * the turn.
 */

export interface ConversationLocator {
  id: string;
  project?: string | null;
  username?: string | null;
  collection: string;
}

const parkCounts = new Map<string, number>();

function countKey(locator: ConversationLocator): string {
  return `${locator.collection}/${locator.id}`;
}

/** The collection a loop persists into — agent turns to agent_conversations (Finalizer's rule). */
export function conversationCollectionFor(
  project: string | null | undefined,
  agent: string | null | undefined,
): string {
  return agent || AgentPersonaRegistry.isAgentProject(project || "")
    ? COLLECTIONS.AGENT_CONVERSATIONS
    : COLLECTIONS.MODEL_CONVERSATIONS;
}

/** Who is asking, as a decision records it — from the loop's context. */
export function decisionOwnerOf(context: {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  agentConversationId?: string | null;
  parentConversationId?: string | null;
}): DecisionOwner {
  return {
    project: context.project ?? null,
    username: context.username ?? null,
    agent: context.agent ?? null,
    agentConversationId: context.agentConversationId ?? null,
    parentConversationId: context.parentConversationId ?? null,
    conversationCollection: conversationCollectionFor(context.project, context.agent),
  };
}

/** The locator of a loop's own conversation document, from what a decision records. */
export function locatorFor(loopKey: string, owner: DecisionOwner): ConversationLocator {
  return {
    id: loopKey,
    project: owner.project,
    username: owner.username,
    collection:
      owner.conversationCollection || conversationCollectionFor(owner.project, owner.agent),
  };
}

async function write(locator: ConversationLocator, update: Record<string, unknown>): Promise<void> {
  if (!locator.id) return;
  const filter: Record<string, unknown> = { id: locator.id };
  if (locator.project) filter.project = locator.project;
  if (locator.username) filter.username = locator.username;
  let collection;
  try {
    collection = MongoWrapper.getDb(MONGO_DB_NAME).collection(locator.collection);
  } catch {
    return; // no database connected (unit tests): nothing to mark
  }
  try {
    await collection.updateOne(filter, update);
  } catch (error: unknown) {
    logger.warn(
      `[ConversationRunState] Could not update runState on ${locator.id}: ${getErrorMessage(error)}`,
    );
  }
}

const ConversationRunState = {
  /** A wait opened: the conversation is awaiting its user. */
  async park(locator: ConversationLocator): Promise<void> {
    const key = countKey(locator);
    const count = (parkCounts.get(key) ?? 0) + 1;
    parkCounts.set(key, count);
    if (count > 1) return;
    await write(locator, {
      $set: {
        runState: PENDING_DECISIONS.RUN_STATE_AWAITING_USER,
        awaitingUserSince: new Date().toISOString(),
      },
    });
  },

  /** A wait settled: when it was the last one, the turn is running again. */
  async unpark(locator: ConversationLocator): Promise<void> {
    const key = countKey(locator);
    const count = (parkCounts.get(key) ?? 1) - 1;
    if (count > 0) {
      parkCounts.set(key, count);
      return;
    }
    parkCounts.delete(key);
    await ConversationRunState.clear(locator);
  },

  /**
   * Nothing is awaited any more — e.g. the last pending decision of a turn
   * that died with the previous process was decided. A park still counted
   * in this process wins: its turn is alive and still waiting.
   */
  async clear(locator: ConversationLocator): Promise<void> {
    if ((parkCounts.get(countKey(locator)) ?? 0) > 0) return;
    await write(locator, { $unset: { runState: "", awaitingUserSince: "" } });
  },

  /** Test helper — forget every counted park. */
  _reset(): void {
    parkCounts.clear();
  },
};

export default ConversationRunState;

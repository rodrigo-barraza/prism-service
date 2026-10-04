import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  isPermissionMode,
  type PermissionMode,
} from "#src/services/permissions/PermissionModes";

/**
 * "Auto-approve this conversation" — a per-conversation setting, persisted
 * on the conversation document as `approvals.autoApprove`, that the approval
 * card's conversation scope sets. Every later turn of THAT conversation
 * starts with `options.autoApprove` on (AgenticLoopService); other
 * conversations, and a new one in the same browser tab, are untouched.
 *
 * Not inside `settings`: the turn finalizer rewrites `settings` wholesale
 * from the request (ConversationService.appendMessages), which erased a flag
 * set mid-turn before the next turn could read it (seen live). `approvals`
 * is written by nothing else. Looked up with the same
 * `{ id, project, username }` scope as goals, agent conversations first —
 * the identity the conversation is stored under, which the approval route
 * takes from the decided turn, not from the request (ApprovalDecisionRoute).
 *
 * The conversation's permission mode (`approvals.permissionMode`, see
 * permissions/PermissionModes.ts) lives beside it for the same reason.
 */

export const CONVERSATION_APPROVALS_FIELD = "approvals";

const SEARCHED_COLLECTIONS = [
  COLLECTIONS.AGENT_CONVERSATIONS,
  COLLECTIONS.MODEL_CONVERSATIONS,
];

/** Delegation is capped far below this (SpawnCaps); a longer chain is a cycle. */
const MAXIMUM_DELEGATION_HOPS = 32;

function getDatabase() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  } catch {
    return null;
  }
}

/**
 * The conversation its user is in, from any conversation of its delegation
 * tree: a sub-agent's own conversation (`isSubAgent`) names the one that
 * spawned it (`parentConversationId`, SubAgentPersistenceService), followed
 * up to a conversation that is no sub-agent's. Null when none is stored.
 */
async function findUsersConversation(
  database: NonNullable<ReturnType<typeof getDatabase>>,
  conversationId: string,
  project: string,
  username: string,
): Promise<{ id: string; collection: string } | null> {
  const visited = new Set<string>();
  let id = conversationId;
  while (!visited.has(id) && visited.size < MAXIMUM_DELEGATION_HOPS) {
    visited.add(id);
    let found: { collection: string; parent: unknown; isSubAgent: unknown } | null = null;
    for (const collection of SEARCHED_COLLECTIONS) {
      const document = (await database
        .collection(collection)
        .findOne(
          { id, project, username },
          { projection: { isSubAgent: 1, parentConversationId: 1 } },
        )) as { isSubAgent?: unknown; parentConversationId?: unknown } | null;
      if (document) {
        found = { collection, parent: document.parentConversationId, isSubAgent: document.isSubAgent };
        break;
      }
    }
    if (!found) return null;
    if (found.isSubAgent !== true || typeof found.parent !== "string" || !found.parent) {
      return { id, collection: found.collection };
    }
    id = found.parent;
  }
  return null;
}

const ConversationApprovalSettings = {
  async isAutoApproveEnabled(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<boolean> {
    const database = getDatabase();
    if (!database || !conversationId || !project || !username) return false;
    try {
      for (const collection of SEARCHED_COLLECTIONS) {
        const document = (await database
          .collection(collection)
          .findOne(
            { id: conversationId, project, username },
            { projection: { [CONVERSATION_APPROVALS_FIELD]: 1 } },
          )) as { approvals?: { autoApprove?: unknown } | null } | null;
        if (document) return document.approvals?.autoApprove === true;
      }
    } catch (error: unknown) {
      logger.warn(
        `[ConversationApprovalSettings] read failed for ${conversationId}: ${getErrorMessage(error)}`,
      );
    }
    return false;
  },

  /**
   * Turn the flag on for the conversation its user is in: this one, or —
   * for a sub-agent's own conversation (a card a sub-agent raised) — the
   * root of its delegation tree, whose later turns read the flag; a
   * sub-agent inherits its parent's approval mode and never reads it.
   * Resolves false when no such conversation exists.
   */
  async enableAutoApprove(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<boolean> {
    const database = getDatabase();
    if (!database || !conversationId || !project || !username) return false;
    const target = await findUsersConversation(database, conversationId, project, username);
    if (!target) return false;
    const result = await database.collection(target.collection).updateOne(
      { id: target.id, project, username },
      {
        $set: {
          [`${CONVERSATION_APPROVALS_FIELD}.autoApprove`]: true,
          [`${CONVERSATION_APPROVALS_FIELD}.autoApproveSetAt`]: new Date().toISOString(),
        },
      },
    );
    return result.matchedCount > 0;
  },

  /** The conversation's stored permission mode, or `null` when it names none. */
  async getPermissionMode(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<PermissionMode | null> {
    const database = getDatabase();
    if (!database || !conversationId || !project || !username) return null;
    try {
      for (const collection of SEARCHED_COLLECTIONS) {
        const document = (await database
          .collection(collection)
          .findOne(
            { id: conversationId, project, username },
            { projection: { [CONVERSATION_APPROVALS_FIELD]: 1 } },
          )) as { approvals?: { permissionMode?: unknown } | null } | null;
        if (document) {
          const stored = document.approvals?.permissionMode;
          return isPermissionMode(stored) ? stored : null;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[ConversationApprovalSettings] mode read failed for ${conversationId}: ${getErrorMessage(error)}`,
      );
    }
    return null;
  },

  /** Store the conversation's mode. Resolves false when no such conversation exists. */
  async setPermissionMode(
    conversationId: string,
    project: string,
    username: string,
    mode: PermissionMode,
  ): Promise<boolean> {
    const database = getDatabase();
    if (!database || !conversationId || !project || !username) return false;
    for (const collection of SEARCHED_COLLECTIONS) {
      const result = await database.collection(collection).updateOne(
        { id: conversationId, project, username },
        {
          $set: {
            [`${CONVERSATION_APPROVALS_FIELD}.permissionMode`]: mode,
            [`${CONVERSATION_APPROVALS_FIELD}.permissionModeSetAt`]: new Date().toISOString(),
          },
        },
      );
      if (result.matchedCount > 0) return true;
    }
    return false;
  },
};

export default ConversationApprovalSettings;

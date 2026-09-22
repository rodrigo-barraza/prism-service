import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * "Auto-approve this conversation" — a per-conversation flag, persisted in
 * the conversation document's `settings`, that the approval card's
 * conversation scope sets. Every later turn of THAT conversation starts with
 * `options.autoApprove` on (AgenticLoopService); other conversations, and a
 * new one in the same browser tab, are untouched.
 *
 * Written with a dotted `$set` so the rest of `settings` is kept. Looked up
 * with the same `{ id, project, username }` scope as goals, agent
 * conversations first.
 */

export const CONVERSATION_AUTO_APPROVE_SETTING = "autoApprove";

const SEARCHED_COLLECTIONS = [
  COLLECTIONS.AGENT_CONVERSATIONS,
  COLLECTIONS.MODEL_CONVERSATIONS,
];

function getDatabase() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  } catch {
    return null;
  }
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
            { projection: { settings: 1 } },
          )) as { settings?: Record<string, unknown> | null } | null;
        if (document) {
          return document.settings?.[CONVERSATION_AUTO_APPROVE_SETTING] === true;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[ConversationApprovalSettings] read failed for ${conversationId}: ${getErrorMessage(error)}`,
      );
    }
    return false;
  },

  /** Turn the flag on. Resolves false when no such conversation exists. */
  async enableAutoApprove(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<boolean> {
    const database = getDatabase();
    if (!database || !conversationId || !project || !username) return false;
    for (const collection of SEARCHED_COLLECTIONS) {
      const result = await database.collection(collection).updateOne(
        { id: conversationId, project, username },
        {
          $set: {
            [`settings.${CONVERSATION_AUTO_APPROVE_SETTING}`]: true,
            updatedAt: new Date().toISOString(),
          },
        },
      );
      if (result.matchedCount > 0) return true;
    }
    return false;
  },
};

export default ConversationApprovalSettings;

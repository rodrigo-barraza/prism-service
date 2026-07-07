import logger from "#src/utils/logger";
import { COLLECTIONS, SYSTEM_STATUSES } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { getErrorMessage } from "#src/utils/ErrorHelpers";
import { MONGO_DB_NAME } from "#config";

/**
 * Service for persisting sub-agent metadata and state to MongoDB.
 */
export class SubAgentPersistenceService {
  /**
   * Register a sub-agent's relationship with its parent and initialize its conversation metadata.
   */
  static async registerSubAgent({
    parentConversationId,
    project,
    username,
    subAgentConversationId,
    agentId,
    description,
    subAgentProvider,
    subAgentModel,
    currentRecursionDepth,
    globalSpawnIndex,
    branchName,
    files,
    agentConversationId,
    subAgentAgentType,
    worktreeError,
  }: {
    parentConversationId: string;
    project: string;
    username: string;
    subAgentConversationId: string;
    agentId: string;
    description: string;
    subAgentProvider: string;
    subAgentModel: string;
    currentRecursionDepth: number;
    globalSpawnIndex?: number;
    branchName: string | null;
    files: string[];
    agentConversationId: string;
    subAgentAgentType: string | null;
    worktreeError: string | null;
  }): Promise<void> {
    try {
      const conversationCollection = MongoWrapper.getCollection(
        MONGO_DB_NAME,
        COLLECTIONS.AGENT_CONVERSATIONS,
      );

      if (!conversationCollection) {
        logger.warn("[SubAgentPersistence] MongoDB connection not available");
        return;
      }

      // Push the child's conversationId into the parent's subAgentIds array
      const parentUpdateResult = await conversationCollection.updateOne(
        { id: parentConversationId, project, username },
        {
          $set: { hasSubAgents: true },
          $addToSet: { subAgentIds: subAgentConversationId },
        },
      );

      if (parentUpdateResult.matchedCount === 0) {
        logger.warn(
          `[SubAgentPersistence] subAgentIds push matched 0 documents for parent ${parentConversationId}`,
        );
      }

      // Set sub-agent metadata on the child conversation document
      await conversationCollection.updateOne(
        { id: subAgentConversationId },
        {
          $set: {
            isSubAgent: true,
            subAgentId: agentId,
            subAgentDescription: description,
            subAgentStatus: SYSTEM_STATUSES.RUNNING,
            subAgentProviderName: subAgentProvider,
            subAgentResolvedModel: subAgentModel,
            subAgentRecursionDepth: currentRecursionDepth + 1,
            subAgentGlobalSpawnIndex: globalSpawnIndex ?? null,
            subAgentBranchName: worktreeError ? null : branchName,
            subAgentFiles: files || [],
            parentConversationId,
            parentAgentConversationId: agentConversationId || null,
            project,
            username,
            agent: subAgentAgentType,
          },
          $setOnInsert: {
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );

      logger.info(
        `[SubAgentPersistence] Registered sub-agent ${agentId} on parent ${parentConversationId}`,
      );
    } catch (error: unknown) {
      logger.error(
        `[SubAgentPersistence] Failed to persist sub-agent spawn: ${getErrorMessage(error)}`,
      );
    }
  }
}

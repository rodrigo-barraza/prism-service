import logger from "#src/utils/logger";
import { COLLECTIONS, SYSTEM_STATUSES } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
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

      // Set sub-agent metadata on the child conversation document.
      // isActive/isGenerating mirror ConversationService.setGenerating(true) —
      // the client's live-stream gate (viewed sub-agent → WebSocket subscribe)
      // and history activity dots key off the persisted isActive flag.
      await conversationCollection.updateOne(
        { id: subAgentConversationId },
        {
          $set: {
            isSubAgent: true,
            isActive: true,
            isGenerating: true,
            updatedAt: new Date().toISOString(),
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

  /**
   * Persist a sub-agent's return to the running state (follow-up message,
   * continuation, resume). Counterpart of markSubAgentTerminal — re-raises
   * the isActive/isGenerating lifecycle flags so a viewer of the sub-agent
   * conversation re-opens the live stream for the new run.
   */
  static async markSubAgentActive(
    subAgentConversationId: string,
  ): Promise<void> {
    try {
      const conversationCollection = MongoWrapper.getCollection(
        MONGO_DB_NAME,
        COLLECTIONS.AGENT_CONVERSATIONS,
      );

      if (!conversationCollection) {
        logger.warn("[SubAgentPersistence] MongoDB connection not available");
        return;
      }

      await conversationCollection.updateOne(
        { id: subAgentConversationId },
        {
          $set: {
            subAgentStatus: SYSTEM_STATUSES.RUNNING,
            isActive: true,
            isGenerating: true,
            updatedAt: new Date().toISOString(),
          },
        },
      );
    } catch (error: unknown) {
      logger.warn(
        `[SubAgentPersistence] Failed to persist active status for ${subAgentConversationId}: ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Persist a sub-agent's terminal state (completed/failed/stopped) to its
   * conversation document. Single write path for ALL terminal transitions so
   * the isActive/isGenerating lifecycle flags can never be left dangling —
   * a sub-agent doc stuck at isActive:true reads as "still running" to the
   * client (activity dots, live-stream subscribe gate).
   */
  static async markSubAgentTerminal({
    subAgentConversationId,
    status,
    extraFields = {},
  }: {
    subAgentConversationId: string;
    status: string;
    extraFields?: Record<string, unknown>;
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

      const now = new Date().toISOString();
      const updateResult = await conversationCollection.updateOne(
        { id: subAgentConversationId },
        {
          $set: {
            subAgentStatus: status,
            isActive: false,
            isGenerating: false,
            subAgentCompletedAt: now,
            updatedAt: now,
            ...extraFields,
          },
        },
      );

      if (updateResult.matchedCount === 0) {
        logger.debug(
          `[SubAgentPersistence] Sub-agent conversation not found for terminal update: ${subAgentConversationId}`,
        );
      }
    } catch (error: unknown) {
      logger.warn(
        `[SubAgentPersistence] Failed to persist terminal status for ${subAgentConversationId}: ${getErrorMessage(error)}`,
      );
    }
  }
}

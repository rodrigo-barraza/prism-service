import logger from "#src/utils/logger";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { TopologyRouter } from "./TopologyRouter.ts";

/**
 * Service for executing multi-agent team topologies.
 */
export class TopologyExecutionService {
  /**
   * Sync the active topology to the conversation settings in MongoDB.
   */
  static async syncTopologyToDatabase(
    conversationId: string,
    project: string | undefined,
    username: string | undefined,
    topology: string,
  ): Promise<void> {
    try {
      const { MONGO_DB_NAME: databaseName } = await import("#config");
      const { COLLECTIONS: collectionNames } = await import("#src/constants");
      const MongoWrapper = (await import("#src/wrappers/MongoWrapper")).default;
      const databaseCollection = MongoWrapper.getCollection(
        databaseName,
        collectionNames.AGENT_CONVERSATIONS,
      );

      if (databaseCollection) {
        const topologyResult = await databaseCollection.updateOne(
          {
            id: conversationId,
            project,
            username,
          },
          {
            $set: {
              "settings.agents.topology": topology,
              updatedAt: new Date().toISOString(),
            },
          },
        );
        if (topologyResult.matchedCount === 0) {
          logger.warn(
            `[TopologyExecution] Topology sync matched 0 documents for conversation ${conversationId}`,
          );
        } else {
          logger.info(
            `[TopologyExecution] Updated conversation settings topology to "${topology}" for conversation ${conversationId}`,
          );
        }
      }
    } catch (databaseError: unknown) {
      logger.warn(
        `[TopologyExecution] Failed to update conversation settings topology in MongoDB: ${getErrorMessage(databaseError)}`,
      );
    }
  }

  /**
   * Resolve and instantiate the appropriate router for a given topology.
   */
  static async resolveRouter(topology: string): Promise<TopologyRouter> {
    switch (topology) {
      case TOPOLOGIES.SEQUENTIAL: {
        const { SequentialRouter } = await import("./routers/SequentialRouter.ts");
        return new SequentialRouter();
      }
      case TOPOLOGIES.PEER_TO_PEER: {
        const { PeerToPeerRouter } = await import("./routers/PeerToPeerRouter.ts");
        return new PeerToPeerRouter();
      }
      case TOPOLOGIES.HIERARCHICAL_AGGREGATION: {
        const { HierarchicalAggregationRouter } = await import(
          "./routers/HierarchicalAggregationRouter.ts"
        );
        return new HierarchicalAggregationRouter();
      }
      case TOPOLOGIES.TOURNAMENT: {
        const { TournamentRouter } = await import("./routers/TournamentRouter.ts");
        return new TournamentRouter();
      }
      case TOPOLOGIES.CRITIC_LOOP: {
        const { CriticLoopRouter } = await import("./routers/CriticLoopRouter.ts");
        return new CriticLoopRouter();
      }
      case TOPOLOGIES.DIVIDE_AND_CONQUER: {
        const { DivideAndConquerRouter } = await import(
          "./routers/DivideAndConquerRouter.ts"
        );
        return new DivideAndConquerRouter();
      }
      case TOPOLOGIES.MCTS: {
        const { MCTSRouter } = await import("./routers/MCTSRouter.ts");
        return new MCTSRouter();
      }
      default: {
        const { HierarchicalRouter } = await import("./routers/HierarchicalRouter.ts");
        return new HierarchicalRouter();
      }
    }
  }
}

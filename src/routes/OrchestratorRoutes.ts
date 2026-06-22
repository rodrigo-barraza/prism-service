import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import OrchestratorService from "../services/OrchestratorService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

interface SubAgentSummary {
  agentId: string;
  description: string;
  status: string;
  providerName?: string;
  resolvedModel?: string;
  durationMs: number;
  toolUses: number;
  hasChanges: boolean;
  totalCost?: number | null;
  branchName?: string | null;
  files?: string[];
  toolCallCount?: number;
  recursionDepth?: number;
  toolNames?: Record<string, number>;
}

const router = Router();

// ═══════════════════════════════════════════════════════════════
// Chat-Spawned Sub-Agent Endpoints
// ═══════════════════════════════════════════════════════════════

/*
 * GET /orchestrator/sub-agents
 * List all active sub-agents spawned via chat tools.
 * Optional query: ?conversationId=xxx to filter by parent conversation.
 */
router.get(
  "/sub-agents",
  asyncHandler(async (request: Request, response: Response) => {
    const conversationIdQuery = request.query.conversationId;
    const conversationIdentifier =
      typeof conversationIdQuery === "string" ? conversationIdQuery : undefined;
    const activeSubAgentsList = conversationIdentifier
      ? OrchestratorService.listAllDescendantSubAgents(conversationIdentifier)
      : OrchestratorService.listSubAgents();

    let persistedSubAgentsList: SubAgentSummary[] = [];
    if (conversationIdentifier) {
      try {
        const { default: MongoWrapper } =
          await import("../wrappers/MongoWrapper.js");
        const { MONGO_DB_NAME } = await import("../../config.js");
        const { COLLECTIONS } = await import("../constants.js");
        const collection = MongoWrapper.getCollection(
          MONGO_DB_NAME,
          COLLECTIONS.AGENT_CONVERSATIONS,
        );

        const rootConversationDocument = await collection.findOne(
          { id: conversationIdentifier },
          { projection: { subAgents: 1 } },
        );
        if (rootConversationDocument && rootConversationDocument.subAgents) {
          if (rootConversationDocument.subAgents.length > 0) {
            persistedSubAgentsList = rootConversationDocument.subAgents;
          }
        }

        // Recursively discover all descendant sub-agents by traversing the
        // parentAgentConversationId chain in the AGENT_CONVERSATIONS collection.
        // Each sub-agent conversation may itself have a subAgents array if it
        // spawned its own workers (recursive sub-agent delegation).
        const MAX_DESCENDANT_DEPTH = 10;
        let frontier = [conversationIdentifier];
        const visitedConversationIds = new Set<string>([conversationIdentifier]);

        for (
          let depth = 0;
          depth < MAX_DESCENDANT_DEPTH && frontier.length > 0;
          depth++
        ) {
          const childConversationDocuments = await collection
            .find(
              { parentAgentConversationId: { $in: frontier } },
              { projection: { id: 1, subAgents: 1 } },
            )
            .toArray();

          if (childConversationDocuments.length === 0) break;

          const nextFrontier: string[] = [];
          for (const childDocument of childConversationDocuments) {
            const childConversationId = childDocument.id as string;
            if (visitedConversationIds.has(childConversationId)) continue;
            visitedConversationIds.add(childConversationId);
            nextFrontier.push(childConversationId);

            if (
              Array.isArray(childDocument.subAgents) &&
              childDocument.subAgents.length > 0
            ) {
              for (const descendantSubAgent of childDocument.subAgents) {
                persistedSubAgentsList.push(descendantSubAgent);
              }
            }
          }
          frontier = nextFrontier;
        }
      } catch (error: unknown) {
        logger.warn(
          `[orchestrator] Failed to load persisted sub-agents: ${getErrorMessage(error)}`,
        );
      }
    }

    const mergedSubAgentsMap = new Map<string, SubAgentSummary>();
    for (const subAgent of persistedSubAgentsList) {
      mergedSubAgentsMap.set(subAgent.agentId, subAgent);
    }
    for (const subAgent of activeSubAgentsList) {
      mergedSubAgentsMap.set(subAgent.agentId, subAgent);
    }
    const finalSubAgentsList = Array.from(mergedSubAgentsMap.values());

    response.json({ subAgents: finalSubAgentsList });
  }),
);

/*
 * POST /orchestrator/sub-agents/stop
 * Abort all running sub-agents for a given parent conversation.
 * Called by the frontend when the user presses stop.
 *
 * Body: { conversationId: string }
 */
router.post(
  "/sub-agents/stop",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId } = request.body;
    if (!conversationId) {
      return response
        .status(400)
        .json({ error: "'conversationId' is required" });
    }

    const result =
      await OrchestratorService.abortSubAgentsByConversation(conversationId);
    response.json(result);
  }),
);

/*
 * GET /orchestrator/sub-agents/:agentId
 * Get the status of a specific chat-spawned sub-agent.
 */
router.get("/sub-agents/:agentId", (request: Request, response: Response) => {
  const agentId = request.params.agentId;
  if (typeof agentId !== "string" || !agentId) {
    return response.status(400).json({ error: "agentId is required" });
  }
  const status = OrchestratorService.getSubAgentStatus(agentId);
  if (!status) {
    return response.status(404).json({ error: "Sub-agent not found" });
  }
  response.json(status);
});

export default router;

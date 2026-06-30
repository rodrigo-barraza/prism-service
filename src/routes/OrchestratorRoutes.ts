import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import OrchestratorService from "../services/OrchestratorService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { ORCHESTRATOR } from "../constants.ts";

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
  subAgentConversationId?: string;
}

const router = Router();

// ═══════════════════════════════════════════════════════════════
// Chat-Spawned Sub-Agent Endpoints
// ═══════════════════════════════════════════════════════════════

/*
 * GET /orchestrator/sub-agents
 * List all sub-agents spawned via chat tools.
 * Optional query: ?conversationId=xxx to filter by parent conversation.
 *
 * Sub-agents are agent_conversations that reference themselves via subAgentIds[].
 * BFS traverses the tree to discover all descendants.
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

        const conversationCollection = MongoWrapper.getCollection(
          MONGO_DB_NAME,
          COLLECTIONS.AGENT_CONVERSATIONS,
        );

        // Fetch the root conversation's subAgentIds
        const rootDocument = await conversationCollection.findOne(
          { id: conversationIdentifier },
          { projection: { subAgentIds: 1 } },
        );

        if (rootDocument && Array.isArray(rootDocument.subAgentIds) && rootDocument.subAgentIds.length > 0) {
          // BFS: discover all descendant sub-agents through the self-referential model.
          // Each agent_conversation with isSubAgent=true stores its own subAgent* fields.
          const visitedConversationIds = new Set<string>([conversationIdentifier]);
          let frontier: string[] = [...rootDocument.subAgentIds];
          const MAX_DESCENDANT_DEPTH = ORCHESTRATOR.AGENT_TREE_DISCOVERY_MAX_DEPTH;

          for (
            let depth = 0;
            depth < MAX_DESCENDANT_DEPTH && frontier.length > 0;
            depth++
          ) {
            const unvisitedIds = frontier.filter((conversationId) => !visitedConversationIds.has(conversationId));
            if (unvisitedIds.length === 0) break;

            for (const conversationId of unvisitedIds) {
              visitedConversationIds.add(conversationId);
            }

            const subAgentDocuments = await conversationCollection
              .find(
                { id: { $in: unvisitedIds }, isSubAgent: true },
                {
                  projection: {
                    id: 1,
                    subAgentId: 1,
                    subAgentDescription: 1,
                    subAgentStatus: 1,
                    subAgentProviderName: 1,
                    subAgentResolvedModel: 1,
                    subAgentDurationMs: 1,
                    subAgentToolUses: 1,
                    subAgentHasChanges: 1,
                    subAgentTotalCost: 1,
                    subAgentBranchName: 1,
                    subAgentFiles: 1,
                    subAgentRecursionDepth: 1,
                    subAgentToolNames: 1,
                    subAgentIds: 1,
                  },
                },
              )
              .toArray();

            if (subAgentDocuments.length === 0) break;

            const nextFrontier: string[] = [];
            for (const subAgentDocument of subAgentDocuments) {
              persistedSubAgentsList.push({
                agentId: (subAgentDocument.subAgentId as string) || (subAgentDocument.id as string),
                description: (subAgentDocument.subAgentDescription as string) || "",
                status: (subAgentDocument.subAgentStatus as string) || "unknown",
                providerName: subAgentDocument.subAgentProviderName as string | undefined,
                resolvedModel: subAgentDocument.subAgentResolvedModel as string | undefined,
                durationMs: (subAgentDocument.subAgentDurationMs as number) || 0,
                toolUses: (subAgentDocument.subAgentToolUses as number) || 0,
                hasChanges: (subAgentDocument.subAgentHasChanges as boolean) || false,
                totalCost: subAgentDocument.subAgentTotalCost as number | null | undefined,
                branchName: subAgentDocument.subAgentBranchName as string | null | undefined,
                files: subAgentDocument.subAgentFiles as string[] | undefined,
                toolCallCount: (subAgentDocument.subAgentToolUses as number) || 0,
                recursionDepth: subAgentDocument.subAgentRecursionDepth as number | undefined,
                toolNames: subAgentDocument.subAgentToolNames as Record<string, number> | undefined,
                subAgentConversationId: subAgentDocument.id as string,
              });

              // If this sub-agent itself has children, add them to the next frontier
              const childSubAgentIds = subAgentDocument.subAgentIds as string[] | undefined;
              if (Array.isArray(childSubAgentIds) && childSubAgentIds.length > 0) {
                nextFrontier.push(...childSubAgentIds);
              }
            }
            frontier = nextFrontier;
          }
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

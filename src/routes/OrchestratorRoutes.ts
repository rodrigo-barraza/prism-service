import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import { OrchestratorService } from "../services/OrchestratorService.ts";

interface SubAgentSummary {
  agentId: string;
  description: string;
  status: string;
  providerName?: string;
  resolvedModel?: string;
  durationMilliseconds: number;
  toolUses: number;
  hasChanges: boolean;
  totalCost?: number | null;
  branchName?: string | null;
  files?: string[];
  toolCallCount?: number;
  recursionDepth?: number;
  globalSpawnIndex?: number;
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

    const persistedSubAgentsList = conversationIdentifier
      ? await OrchestratorService.getPersistedDescendantSubAgents(conversationIdentifier)
      : [];


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

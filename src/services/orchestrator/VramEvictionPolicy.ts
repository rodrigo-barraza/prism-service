// ─── VRAM Eviction Policy ────────────────────────────────────
// Unloads models from secondary GPU instances when no sub-agents
// remain active on them, preventing idle VRAM consumption.
// Extracted from OrchestratorService._runSubAgentLoop()

import { getProvider } from "#src/providers/index";
import logger from "#src/utils/logger";
import type { SubAgentState } from "#src/types/orchestrator";
import { getErrorMessage } from "#src/utils/ErrorHelpers";

/*
 * Evict the model from a secondary GPU instance when no other sub-agents
 * are still active on it. The primary (orchestrator) instance is never evicted.
 *
 * @param completedSubAgent       The sub-agent that just finished.
 * @param orchestratorInstanceId  The orchestrator's own provider instance (never evicted).
 * @param activeSubAgents         Map of all active/running sub-agents.
 */
export async function evictIdleSecondaryModel(
  completedSubAgent: SubAgentState,
  orchestratorInstanceId: string,
  activeSubAgents: Map<string, SubAgentState>,
): Promise<void> {
  const subAgentInstanceId = completedSubAgent.providerName;

  // Never evict the orchestrator's own instance
  if (subAgentInstanceId === orchestratorInstanceId) return;

  const othersOnSameInstance = [...activeSubAgents.values()].filter(
    (subAgent) =>
      subAgent.providerName === subAgentInstanceId &&
      subAgent.agentId !== completedSubAgent.agentId &&
      subAgent.status === "running",
  );

  if (othersOnSameInstance.length === 0) {
    try {
      const provider = getProvider(subAgentInstanceId);
      if (provider?.unloadModelByKey) {
        logger.info(
          `[Orchestrator] VRAM eviction: unloading "${completedSubAgent.resolvedModel}" from secondary instance ${subAgentInstanceId} (no active sub-agents remain)`,
        );
        await provider
          .unloadModelByKey(completedSubAgent.resolvedModel)
          .catch((error: Error) =>
            logger.warn(
              `[Orchestrator] VRAM eviction failed on ${subAgentInstanceId}: ${getErrorMessage(error)}`,
            ),
          );
      }
    } catch (error: unknown) {
      logger.warn(
        `[Orchestrator] VRAM eviction error: ${getErrorMessage(error)}`,
      );
    }
  } else {
    logger.info(
      `[Orchestrator] VRAM eviction deferred: ${othersOnSameInstance.length} sub-agent(s) still active on ${subAgentInstanceId}`,
    );
  }
}

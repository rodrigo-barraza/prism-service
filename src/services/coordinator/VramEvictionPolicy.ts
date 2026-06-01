// ─── VRAM Eviction Policy ────────────────────────────────────
// Unloads models from secondary GPU instances when no workers
// remain active on them, preventing idle VRAM consumption.
// Extracted from CoordinatorService._runWorkerLoop()

import { getProvider } from "../../providers/index.ts";
import logger from "../../utils/logger.ts";
import type { WorkerState } from "../../types/coordinator.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";

/**
 * Evict the model from a secondary GPU instance when no other workers
 * are still active on it. The primary (coordinator) instance is never evicted.
 *
 * @param completedWorker    The worker that just finished.
 * @param coordinatorInstanceId  The coordinator's own provider instance (never evicted).
 * @param activeWorkers      Map of all active/running workers.
 */
export async function evictIdleSecondaryModel(
  completedWorker: WorkerState,
  coordinatorInstanceId: string,
  activeWorkers: Map<string, WorkerState>,
): Promise<void> {
  const workerInstanceId = completedWorker.providerName;

  // Never evict the coordinator's own instance
  if (workerInstanceId === coordinatorInstanceId) return;

  const othersOnSameInstance = [...activeWorkers.values()].filter(
    (worker) =>
      worker.providerName === workerInstanceId &&
      worker.agentId !== completedWorker.agentId &&
      worker.status === "running",
  );

  if (othersOnSameInstance.length === 0) {
    try {
      const provider = getProvider(workerInstanceId);
      if (provider?.unloadModelByKey) {
        logger.info(
          `[Coordinator] VRAM eviction: unloading "${completedWorker.resolvedModel}" from secondary instance ${workerInstanceId} (no active workers remain)`,
        );
        await provider
          .unloadModelByKey(completedWorker.resolvedModel)
          .catch((error: unknown) =>
            logger.warn(
              `[Coordinator] VRAM eviction failed on ${workerInstanceId}: ${getErrorMessage(error)}`,
            ),
          );
      }
    } catch (error: unknown) {
      logger.warn(`[Coordinator] VRAM eviction error: ${getErrorMessage(error)}`);
    }
  } else {
    logger.info(
      `[Coordinator] VRAM eviction deferred: ${othersOnSameInstance.length} worker(s) still active on ${workerInstanceId}`,
    );
  }
}

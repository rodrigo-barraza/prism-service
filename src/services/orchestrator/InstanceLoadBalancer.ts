import logger from "../../utils/logger.ts";
import type {
  InstanceAssignment,
  SubAgentState,
} from "../../types/orchestrator.ts";
import type { InstanceEntry } from "../../types/ProviderTypes.ts";

/**
 * Synchronous per-instance reservation counter.
 * Prevents race conditions when multiple team_create calls fire concurrently
 * via Promise.all — each spawn increments the counter immediately at selection
 * time, so the next spawn sees the correct active count.
 * Keyed by instance id (provider name).
 */
const instanceReservations = new Map<string, number>();

export class InstanceLoadBalancer {
  static getActiveOn(
    instanceId: string,
    activeSubAgents: Map<string, SubAgentState>,
  ): number {
    const reserved = instanceReservations.get(instanceId) || 0;
    const running = [...activeSubAgents.values()].filter(
      (subAgent) =>
        subAgent.providerName === instanceId && subAgent.status === "running",
    ).length;
    return reserved + running;
  }

  static selectAndReserveInstance(
    siblings: InstanceEntry[],
    orchestratorInstanceId: string,
    instanceModelOverrides: Map<string, string>,
    defaultModel: string,
    activeSubAgents: Map<string, SubAgentState>,
  ): InstanceAssignment | null {
    // Debug: log the full instance state for tracing assignment decisions
    const stateSnapshot = siblings
      .map((sibling) => {
        const active = InstanceLoadBalancer.getActiveOn(
          sibling.id,
          activeSubAgents,
        );
        return `${sibling.id}(concurrency=${sibling.concurrency}, active=${active}, free=${sibling.concurrency - active})`;
      })
      .join(", ");
    logger.info(
      `[Orchestrator] selectAndReserveInstance: siblings=[${stateSnapshot}], orchestrator=${orchestratorInstanceId}`,
    );

    // Least-connections strategy: always pick the instance with the most
    // available capacity (concurrency - active). This distributes work
    // evenly across heterogeneous hardware instead of saturating one
    // device before touching the next.
    //
    // Tie-breaking: when multiple instances have equal availability,
    // prefer the orchestrator's own instance (its inference is IDLE
    // while sub-agents run, so its slots are effectively free).

    let bestInstance: InstanceEntry | null = null;
    let bestAvailable = -Infinity;
    for (const instance of siblings) {
      const active = InstanceLoadBalancer.getActiveOn(
        instance.id,
        activeSubAgents,
      );
      const available = instance.concurrency - active;
      if (
        available > bestAvailable ||
        (available === bestAvailable && instance.id === orchestratorInstanceId)
      ) {
        bestAvailable = available;
        bestInstance = instance;
      }
    }

    if (bestInstance && bestAvailable <= 0) {
      logger.info(
        `[Orchestrator] selectAndReserveInstance: all at capacity — overflow to ${bestInstance.id} (active=${bestInstance.concurrency - bestAvailable}, overload=+${-bestAvailable + 1})`,
      );
    }

    if (!bestInstance) {
      logger.info(
        `[Orchestrator] selectAndReserveInstance: no instances available`,
      );
      return null;
    }

    const activeCountForSelected = InstanceLoadBalancer.getActiveOn(
      bestInstance.id,
      activeSubAgents,
    );
    const available = bestInstance.concurrency - activeCountForSelected;

    // Increment reservation synchronously so the next call sees it
    instanceReservations.set(
      bestInstance.id,
      (instanceReservations.get(bestInstance.id) || 0) + 1,
    );

    // Apply quant fallback model if the selected instance has an override
    const model = instanceModelOverrides.get(bestInstance.id) || defaultModel;

    return { provider: bestInstance.id, model, slotsAvailable: available };
  }

  static releaseReservation(instanceId: string): void {
    const currentReservations = instanceReservations.get(instanceId) || 0;
    if (currentReservations > 0) {
      instanceReservations.set(instanceId, currentReservations - 1);
    }
  }

  static getReservations(): Map<string, number> {
    return instanceReservations;
  }
}

import logger from "../../utils/logger.ts";
import type { InstanceAssignment, WorkerState } from "../../types/coordinator.ts";
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
  static getActiveOn(instanceId: string, activeWorkers: Map<string, WorkerState>): number {
    const reserved = instanceReservations.get(instanceId) || 0;
    const running = [...activeWorkers.values()].filter(
      (worker) => worker.providerName === instanceId && worker.status === "running",
    ).length;
    return reserved + running;
  }

  static selectAndReserveInstance(
    siblings: InstanceEntry[],
    coordinatorInstanceId: string,
    instanceModelOverrides: Map<string, string>,
    defaultModel: string,
    activeWorkers: Map<string, WorkerState>,
  ): InstanceAssignment | null {
    // Debug: log the full instance state for tracing assignment decisions
    const stateSnapshot = siblings
      .map((sibling) => {
        const active = InstanceLoadBalancer.getActiveOn(sibling.id, activeWorkers);
        return `${sibling.id}(concurrency=${sibling.concurrency}, active=${active}, free=${sibling.concurrency - active})`;
      })
      .join(", ");
    logger.info(
      `[Coordinator] selectAndReserveInstance: siblings=[${stateSnapshot}], coordinator=${coordinatorInstanceId}`,
    );

    // Two-phase assignment strategy:
    //
    // Phase 1 — Fill-first (bin-packing): saturate each instance's
    // concurrency in declaration order before spilling to the next.
    // The coordinator's own instance gets priority when it has slots
    // (its orchestrator inference is IDLE while workers run).
    //
    // Phase 2 — Least-loaded overflow: when ALL instances are at
    // capacity, distribute the overflow evenly by picking the instance
    // with the fewest active workers. This prevents piling all excess
    // workers onto a single instance or falling through to cloud
    // fallback unnecessarily.

    // Build ordered candidate list: coordinator's instance first, then rest in order
    const ordered: InstanceEntry[] = [];
    for (const inst of siblings) {
      if (inst.id === coordinatorInstanceId) {
        ordered.unshift(inst); // coordinator instance goes first
      } else {
        ordered.push(inst);
      }
    }

    // Phase 1: find the first instance with free concurrency slots
    let bestInstance: InstanceEntry | null = null;
    for (const inst of ordered) {
      const active = InstanceLoadBalancer.getActiveOn(inst.id, activeWorkers);
      const available = inst.concurrency - active;
      if (available > 0) {
        bestInstance = inst;
        break; // fill-first: take the first instance with any availability
      }
    }

    // Phase 2: all instances at capacity — least-loaded overflow
    // Spread the overload evenly across instances instead of returning
    // null (which would force all overflow to cloud fallback or queue).
    if (!bestInstance && siblings.length > 0) {
      let minActive = Infinity;
      for (const inst of ordered) {
        const active = InstanceLoadBalancer.getActiveOn(inst.id, activeWorkers);
        if (active < minActive) {
          minActive = active;
          bestInstance = inst;
        }
      }
      const overload = minActive - bestInstance!.concurrency;
      logger.info(
        `[Coordinator] selectAndReserveInstance: all at capacity — overflow to ${bestInstance!.id} (active=${minActive}, overload=+${overload + 1})`,
      );
    }

    if (!bestInstance) {
      logger.info(
        `[Coordinator] selectAndReserveInstance: no instances available`,
      );
      return null;
    }

    const activeCountForSelected = InstanceLoadBalancer.getActiveOn(bestInstance.id, activeWorkers);
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
    const currentRes = instanceReservations.get(instanceId) || 0;
    if (currentRes > 0) {
      instanceReservations.set(instanceId, currentRes - 1);
    }
  }

  static getReservations(): Map<string, number> {
    return instanceReservations;
  }
}

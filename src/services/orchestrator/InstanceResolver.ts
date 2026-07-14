import type {
  TeamMember,
  InstanceAssignment,
  SubAgentState,
} from "#src/types/orchestrator";
import type { InstanceEntry } from "#src/types/ProviderTypes";
import { InstanceLoadBalancer } from "./InstanceLoadBalancer.ts";
import { resolveModelForInstances } from "#src/utils/ModelResolution";
import {
  getInstancesByType,
  getInstanceType,
} from "#src/providers/instance-registry";
import localModelQueue from "#src/services/LocalModelQueue";
import logger from "#src/utils/logger";
import { getSubAgentFallback } from "./SubAgentFallback.ts";

export interface InstanceResolutionContext {
  providerName: string;
  resolvedModel: string;
}

export interface ResolvedInstance {
  assignedProvider: string;
  assignedModel: string;
  /** Load-balancer assignment when an instance slot was reserved (null on fallback/queue). */
  assignment: InstanceAssignment | null;
  /** True when the configured sub-agent fallback model was used instead of an instance. */
  usedFallback: boolean;
}

interface ResolvedSiblings {
  isLocal: boolean;
  siblings: InstanceEntry[];
  instanceModelOverrides: Map<string, string>;
  orchestratorFallback: { provider: string; model: string } | null;
}

/**
 * Pre-resolve the provider's sibling instances and model overrides.
 *
 * Call this once before a batch loop (Hierarchical topologies) or at
 * the top of each iteration (Sequential / P2P) when instance
 * availability may change between steps.
 */
export async function resolveSiblingInstances(
  context: InstanceResolutionContext,
  routerLabel: string,
): Promise<ResolvedSiblings> {
  const { providerName, resolvedModel } = context;
  const isLocal = localModelQueue.isLocal(providerName);
  const providerType = getInstanceType(providerName) || providerName;
  let siblings = getInstancesByType(providerType);
  let instanceModelOverrides = new Map<string, string>();

  if (isLocal && siblings.length > 1) {
    const { usable, modelOverrides } = await resolveModelForInstances(
      resolvedModel,
      siblings,
    );
    instanceModelOverrides = modelOverrides;
    if (usable.length > 0) {
      siblings = usable;
    } else {
      logger.warn(
        `[${routerLabel}] Model "${resolvedModel}" not available on any ${providerType} instance`,
      );
      siblings = [];
    }
  }

  const orchestratorFallback = await getSubAgentFallback();

  return { isLocal, siblings, instanceModelOverrides, orchestratorFallback };
}

/**
 * Select an instance for a single team member using the pre-resolved
 * sibling context. Returns the final { assignedProvider, assignedModel }
 * after load-balancing and fallback.
 *
 * Pass `activeSubAgents` so load accounting sees already-running agents
 * in addition to synchronous reservations — otherwise the balancer only
 * counts reservations made this batch.
 */
export function selectInstanceForMember(
  member: TeamMember,
  resolvedSiblings: ResolvedSiblings,
  context: InstanceResolutionContext,
  activeSubAgents: Map<string, SubAgentState> = new Map(),
): ResolvedInstance {
  const { providerName, resolvedModel } = context;
  const { isLocal, siblings, instanceModelOverrides, orchestratorFallback } =
    resolvedSiblings;

  let assignedProvider = providerName;
  let assignedModel = member.model || resolvedModel;
  let assignment: InstanceAssignment | null = null;
  let usedFallback = false;

  if (isLocal) {
    assignment =
      siblings.length > 0
        ? InstanceLoadBalancer.selectAndReserveInstance(
            siblings,
            providerName,
            instanceModelOverrides,
            assignedModel,
            activeSubAgents,
          )
        : null;
    if (assignment) {
      assignedProvider = assignment.provider;
      assignedModel = assignment.model;
    } else if (orchestratorFallback) {
      // No usable instance (model unavailable everywhere) — use the
      // configured sub-agent fallback instead of queuing on the local provider.
      assignedProvider = orchestratorFallback.provider;
      assignedModel = orchestratorFallback.model;
      usedFallback = true;
    }
  }

  return { assignedProvider, assignedModel, assignment, usedFallback };
}

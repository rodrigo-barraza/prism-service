import type { TeamMember } from "../../types/orchestrator.ts";
import type { InstanceEntry } from "../../types/ProviderTypes.ts";
import { InstanceLoadBalancer } from "./InstanceLoadBalancer.ts";
import { resolveModelForInstances } from "../../utils/ModelResolution.ts";
import {
  getInstancesByType,
  getInstanceType,
} from "../../providers/instance-registry.ts";
import localModelQueue from "../LocalModelQueue.ts";
import logger from "../../utils/logger.ts";
import { getSubAgentFallback } from "./SubAgentFallback.ts";

export interface InstanceResolutionContext {
  providerName: string;
  resolvedModel: string;
}

export interface ResolvedInstance {
  assignedProvider: string;
  assignedModel: string;
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
 */
export function selectInstanceForMember(
  member: TeamMember,
  resolvedSiblings: ResolvedSiblings,
  context: InstanceResolutionContext,
): ResolvedInstance {
  const { providerName, resolvedModel } = context;
  const {
    isLocal,
    siblings,
    instanceModelOverrides,
    orchestratorFallback,
  } = resolvedSiblings;

  let assignedProvider = providerName;
  let assignedModel = member.model || resolvedModel;

  if (isLocal && siblings.length > 0) {
    const assigned = InstanceLoadBalancer.selectAndReserveInstance(
      siblings,
      providerName,
      instanceModelOverrides,
      assignedModel,
      new Map(),
    );
    if (assigned) {
      assignedProvider = assigned.provider;
      assignedModel = assigned.model;
    } else if (orchestratorFallback) {
      assignedProvider = orchestratorFallback.provider;
      assignedModel = orchestratorFallback.model;
    }
  }

  return { assignedProvider, assignedModel };
}

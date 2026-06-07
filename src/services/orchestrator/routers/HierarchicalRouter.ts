import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter } from "../TopologyRouter.ts";
import { InstanceLoadBalancer } from "../InstanceLoadBalancer.ts";
import { resolveModelForInstances } from "../../../utils/ModelResolution.ts";
import { getInstancesByType, getInstanceType } from "../../../providers/instance-registry.ts";
import localModelQueue from "../../LocalModelQueue.ts";
import logger from "../../../utils/logger.ts";
import SettingsService from "../../SettingsService.ts";

async function getSubAgentFallback(): Promise<{ provider: string; model: string } | null> {
  try {
    const agents = await SettingsService.getSection("agents");
    if (agents) {
      const provider = agents.subAgentProvider || agents.subagentProvider;
      const model = agents.subAgentModel || agents.subagentModel;
      if (typeof provider === "string" && typeof model === "string") {
        return { provider, model };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class HierarchicalRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    logger.info(
      `[HierarchicalRouter] createTeam: batch assignment of ${members.length} sub-agent(s)...`
    );

    const isLocal = localModelQueue.isLocal(providerName);
    const providerType = getInstanceType(providerName) || providerName;
    let siblings = getInstancesByType(providerType);
    let instanceModelOverrides = new Map<string, string>();

    if (isLocal && siblings.length > 1) {
      const { usable, modelOverrides } = await resolveModelForInstances(
        resolvedModel,
        siblings
      );
      instanceModelOverrides = modelOverrides;
      if (usable.length > 0) {
        siblings = usable;
      } else {
        logger.warn(
          `[HierarchicalRouter] Model "${resolvedModel}" not available on any ${providerType} instance`
        );
        siblings = [];
      }
    }

    const assignments: OrchestratorSpawnParams[] = [];
    const orchestratorFallback = await getSubAgentFallback();

    for (const member of members) {
      let assignedProvider = providerName;
      let assignedModel = member.model || resolvedModel;

      if (isLocal && siblings.length > 0) {
        const assigned = InstanceLoadBalancer.selectAndReserveInstance(
          siblings,
          providerName,
          instanceModelOverrides,
          assignedModel,
          new Map()
        );
        if (assigned) {
          assignedProvider = assigned.provider;
          assignedModel = assigned.model;
        } else if (orchestratorFallback) {
          assignedProvider = orchestratorFallback.provider;
          assignedModel = orchestratorFallback.model;
        }
      }

      assignments.push({
        description: member.description,
        prompt: member.prompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        orchestratorContext,
      });
    }

    const spawnPromises = assignments.map((assignment) => spawnSubAgent(assignment));
    return Promise.all(spawnPromises);
  }
}

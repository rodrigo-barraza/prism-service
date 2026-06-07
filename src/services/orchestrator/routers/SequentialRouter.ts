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
import { GitWorktreeHelper } from "../GitWorktreeHelper.ts";

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

export class SequentialRouter implements TopologyRouter {
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
      `[SequentialRouter] Starting sequential team execution of ${members.length} member(s)...`
    );

    const isLocal = localModelQueue.isLocal(providerName);
    const providerType = getInstanceType(providerName) || providerName;
    const orchestratorFallback = await getSubAgentFallback();

    const results: (SubAgentResult | { error: string })[] = [];
    let accumulatedContext = "";

    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      logger.info(`[SequentialRouter] Running step ${index + 1}/${members.length}: ${member.description}`);

      // 1. Resolve instance for this step
      let siblings = getInstancesByType(providerType);
      let instanceModelOverrides = new Map<string, string>();
      let assignedProvider = providerName;
      let assignedModel = member.model || resolvedModel;

      if (isLocal && siblings.length > 1) {
        const { usable, modelOverrides } = await resolveModelForInstances(
          assignedModel,
          siblings
        );
        instanceModelOverrides = modelOverrides;
        if (usable.length > 0) {
          siblings = usable;
        } else {
          logger.warn(
            `[SequentialRouter] Model "${assignedModel}" not available on any ${providerType} instance`
          );
          siblings = [];
        }
      }

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

      // 2. Prepare step prompt by prepending accumulated context
      const basePrompt = member.prompt;
      const stepPrompt = accumulatedContext
        ? `--- PREVIOUS STEP RESULT ---\n${accumulatedContext}\n\n--- YOUR TASK ---\n${basePrompt}`
        : basePrompt;

      const assignment: OrchestratorSpawnParams = {
        description: member.description,
        prompt: stepPrompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        orchestratorContext,
      };

      // 3. Spawn and wait for this sub-agent to finish
      const spawnResult = await spawnSubAgent(assignment);
      results.push(spawnResult);

      if ("error" in spawnResult) {
        logger.error(`[SequentialRouter] Step ${index + 1} failed: ${spawnResult.error}. Aborting sequence.`);
        break;
      }

      if (spawnResult.status === "failed") {
        logger.error(`[SequentialRouter] Step ${index + 1} failed. Aborting sequence.`);
        break;
      }

      // 4. Merge changes back to main branch so subsequent worktrees inherit them
      if (spawnResult.status === "completed" && spawnResult.agent_id) {
        const subAgentId = spawnResult.agent_id;
        const branchName = `orchestrator/${subAgentId}`;
        const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(orchestratorContext.workspaceRoot ?? undefined);
        const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(workspaceRoot, member.files || []);

        logger.info(`[SequentialRouter] Merging branch ${branchName} back into main repo`);
        const mergeResult = await GitWorktreeHelper.mergeWorktree(
          repositoryPath,
          branchName,
          `chore(sequence): merge work from sequential sub-agent ${subAgentId}`
        );

        if (mergeResult.error) {
          logger.error(`[SequentialRouter] Failed to merge branch for ${subAgentId}: ${mergeResult.error}`);
        }
      }

      // 5. Accumulate text result for the next agent
      accumulatedContext = `Step ${index + 1} (${member.description}):\n${spawnResult.result || spawnResult.summary}`;
    }

    return results;
  }
}

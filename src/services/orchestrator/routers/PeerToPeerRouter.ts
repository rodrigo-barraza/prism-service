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

export class PeerToPeerRouter implements TopologyRouter {
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
      `[PeerToPeerRouter] Starting Peer-to-Peer mesh execution of ${members.length} member(s)...`
    );

    const isLocal = localModelQueue.isLocal(providerName);
    const providerType = getInstanceType(providerName) || providerName;
    const orchestratorFallback = await getSubAgentFallback();

    const results: (SubAgentResult | { error: string })[] = [];
    const sharedDiscussion: string[] = [];
    
    // We execute turn-based speaker turns. Max turns is set to 2 * number of members (up to 8 turns max)
    const maxTurns = Math.min(8, members.length * 2);

    for (let turn = 0; turn < maxTurns; turn++) {
      const memberIndex = turn % members.length;
      const member = members[memberIndex];
      const speakerName = member.agent || `agent-${memberIndex}`;

      logger.info(
        `[PeerToPeerRouter] Turn ${turn + 1}/${maxTurns}: Active Speaker is "${speakerName}" (${member.description})`
      );

      // 1. Resolve instance
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
            `[PeerToPeerRouter] Model "${assignedModel}" not available on any ${providerType} instance`
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

      // 2. Compile shared conversation thread history
      const promptHistory = sharedDiscussion.length > 0
        ? `--- SHARED DISCUSSION BOARD ---\n${sharedDiscussion.join("\n\n")}\n\n--- YOUR TASK (${speakerName}) ---\n${member.prompt}`
        : member.prompt;

      const assignment: OrchestratorSpawnParams = {
        description: `${member.description} (Turn ${turn + 1})`,
        prompt: promptHistory,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        orchestratorContext,
      };

      // 3. Run speaker turn
      const spawnResult = await spawnSubAgent(assignment);
      results.push(spawnResult);

      if ("error" in spawnResult) {
        logger.error(`[PeerToPeerRouter] Turn failed for speaker "${speakerName}": ${spawnResult.error}. Aborting mesh.`);
        break;
      }

      if (spawnResult.status === "failed") {
        logger.error(`[PeerToPeerRouter] Turn failed for speaker "${speakerName}". Aborting mesh.`);
        break;
      }

      // 4. Merge modifications back so other worktrees see them
      if (spawnResult.status === "completed" && spawnResult.agent_id) {
        const subAgentId = spawnResult.agent_id;
        const branchName = `orchestrator/${subAgentId}`;
        const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(orchestratorContext.workspaceRoot ?? undefined);
        const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(workspaceRoot, member.files || []);

        logger.info(`[PeerToPeerRouter] Merging branch ${branchName} back into main repo`);
        const mergeResult = await GitWorktreeHelper.mergeWorktree(
          repositoryPath,
          branchName,
          `chore(mesh): merge turn ${turn + 1} from ${speakerName}`
        );

        if (mergeResult.error) {
          logger.error(`[PeerToPeerRouter] Failed to merge branch for ${subAgentId}: ${mergeResult.error}`);
        }
      }

      // 5. Append speaker output to shared thread
      const responseText = spawnResult.result || spawnResult.summary;
      sharedDiscussion.push(`[${speakerName}]: ${responseText}`);

      // 6. Early exit check: if an agent signs off with [DONE] or all tasks are finished
      if (responseText.toUpperCase().includes("[DONE]")) {
        logger.info(`[PeerToPeerRouter] Speaker "${speakerName}" signaled termination ([DONE]). Stopping.`);
        break;
      }
    }

    return results;
  }
}

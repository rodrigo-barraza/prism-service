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

    // Validate member prompts upfront — undefined/empty prompts cause
    // runaway loops where every agent reports "no task" without signaling [DONE]
    const invalidMembers = members.filter(
      (member) => !member.prompt || typeof member.prompt !== "string" || member.prompt.trim().length === 0
    );
    if (invalidMembers.length > 0) {
      const invalidNames = invalidMembers.map(
        (member) => member.agent || member.description || "(unnamed)"
      );
      const errorMessage = `${invalidMembers.length} member(s) have missing or empty prompts: [${invalidNames.join(", ")}]. Every peer-to-peer member requires a non-empty 'prompt' field.`;
      logger.error(`[PeerToPeerRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    const isLocal = localModelQueue.isLocal(providerName);
    const providerType = getInstanceType(providerName) || providerName;
    const orchestratorFallback = await getSubAgentFallback();

    const results: (SubAgentResult | { error: string })[] = [];
    const sharedDiscussion: string[] = [];
    let consecutiveStallCount = 0;
    const maximumConsecutiveStalls = 3;
    
    // Ensure every member gets at least 1 turn, with up to 2 rounds, capped at 10
    const maxTurnsCount = Math.max(members.length, Math.min(10, members.length * 2));

    for (let turnIndex = 0; turnIndex < maxTurnsCount; turnIndex++) {
      const memberIndex = turnIndex % members.length;
      const member = members[memberIndex];
      const speakerName = member.agent || `agent-${memberIndex}`;

      logger.info(
        `[PeerToPeerRouter] Turn ${turnIndex + 1}/${maxTurnsCount}: Active Speaker is "${speakerName}" (${member.description})`
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
        description: `${member.description} (Turn ${turnIndex + 1})`,
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

      // 4. Merge modifications back so other worktrees see them (only if the agent actually changed files)
      const hasFileChanges = spawnResult.status === "completed"
        && spawnResult.agent_id
        && spawnResult.diff;

      if (hasFileChanges) {
        const subAgentId = spawnResult.agent_id!;
        const branchName = `orchestrator/${subAgentId}`;
        const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(orchestratorContext.workspaceRoot ?? undefined);
        const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(workspaceRoot, member.files || []);

        logger.info(`[PeerToPeerRouter] Merging branch ${branchName} back into main repo`);
        const mergeResult = await GitWorktreeHelper.mergeWorktree(
          repositoryPath,
          branchName,
          `chore(mesh): merge turn ${turnIndex + 1} from ${speakerName}`
        );

        if (mergeResult.error) {
          const errorMessage = `Failed to merge branch for ${subAgentId}: ${mergeResult.error}`;
          logger.error(`[PeerToPeerRouter] ${errorMessage}`);
          return [
            ...results,
            { error: errorMessage }
          ];
        }
      } else if (spawnResult.status === "completed") {
        logger.info(`[PeerToPeerRouter] No file changes from speaker "${speakerName}" — skipping merge step`);
      }

      // 5. Append speaker output to shared thread
      const responseText = spawnResult.result || spawnResult.summary;
      sharedDiscussion.push(`[${speakerName}]: ${responseText}`);

      // 6. Early exit check: if an agent signs off with [DONE] or all tasks are finished
      if (responseText.toUpperCase().includes("[DONE]")) {
        logger.info(`[PeerToPeerRouter] Speaker "${speakerName}" signaled termination ([DONE]). Stopping.`);
        break;
      }

      // 7. Stall detection — if consecutive agents produce boilerplate "no task" responses,
      // break the loop early to prevent runaway cycles of empty reports
      const normalizedResponse = responseText.toLowerCase();
      const isStallResponse =
        normalizedResponse.includes("no actionable task") ||
        normalizedResponse.includes("standing by") ||
        normalizedResponse.includes("no specific work") ||
        normalizedResponse.includes("task assigned: `undefined`") ||
        normalizedResponse.includes("task assigned:**  `undefined`") ||
        (normalizedResponse.includes("undefined") && normalizedResponse.includes("no pending"));

      if (isStallResponse) {
        consecutiveStallCount++;
        logger.warn(
          `[PeerToPeerRouter] Stall detected from "${speakerName}" (${consecutiveStallCount}/${maximumConsecutiveStalls} consecutive stalls)`
        );
        if (consecutiveStallCount >= maximumConsecutiveStalls) {
          logger.error(
            `[PeerToPeerRouter] ${maximumConsecutiveStalls} consecutive stall responses detected — aborting mesh to prevent runaway loop`
          );
          break;
        }
      } else {
        consecutiveStallCount = 0;
      }
    }

    return results;
  }
}

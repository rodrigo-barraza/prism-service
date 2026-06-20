import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter } from "../TopologyRouter.ts";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../InstanceResolver.ts";
import logger from "../../../utils/logger.ts";
import { GitWorktreeHelper } from "../GitWorktreeHelper.ts";

const MINIMUM_SUBSTANTIVE_RESPONSE_LENGTH = 80;

/**
 * Detect stall responses using structural signals rather than brittle
 * keyword matching. A response is considered a stall when it is very
 * short AND the agent performed no tool work — indicating it had
 * nothing actionable to do.
 */
function isStallResponse(
  responseText: string,
  spawnResult: SubAgentResult,
): boolean {
  const isShortResponse = responseText.trim().length < MINIMUM_SUBSTANTIVE_RESPONSE_LENGTH;
  const hasNoToolUsage = spawnResult.toolUses === 0;
  return isShortResponse && hasNoToolUsage;
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
      `[PeerToPeerRouter] Starting Peer-to-Peer mesh execution of ${members.length} member(s)...`,
    );

    const invalidMembersCount = members.filter(
      (member) => !member.prompt || member.prompt.trim() === "",
    ).length;

    if (invalidMembersCount > 0) {
      const errorMessage = `${invalidMembersCount} member(s) have missing or empty prompts. Cannot execute Peer-to-Peer mesh topology.`;
      logger.error(`[PeerToPeerRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    const results: (SubAgentResult | { error: string })[] = [];
    const sharedDiscussion: string[] = [];
    let consecutiveStallCount = 0;
    const maximumConsecutiveStalls = 3;

    // Ensure every member gets at least 1 turn, with up to 2 rounds, capped at 10
    const maxTurnsCount = Math.max(
      members.length,
      Math.min(10, members.length * 2),
    );

    for (let turnIndex = 0; turnIndex < maxTurnsCount; turnIndex++) {
      const memberIndex = turnIndex % members.length;
      const member = members[memberIndex];
      const speakerName = member.agent || `agent-${memberIndex}`;

      logger.info(
        `[PeerToPeerRouter] Turn ${turnIndex + 1}/${maxTurnsCount}: Active Speaker is "${speakerName}" (${member.description})`,
      );

      // 1. Re-resolve instances per turn (availability changes between turns)
      const resolvedSiblings = await resolveSiblingInstances(
        { providerName, resolvedModel },
        "PeerToPeerRouter",
      );
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        member,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

      // 2. Compile shared conversation thread history
      const promptHistory =
        sharedDiscussion.length > 0
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
        agentIndex: memberIndex,
        teamSize: members.length,
        orchestratorContext,
      };

      // 3. Run speaker turn
      const spawnResult = await spawnSubAgent(assignment);
      results.push(spawnResult);

      if ("error" in spawnResult) {
        logger.error(
          `[PeerToPeerRouter] Turn failed for speaker "${speakerName}": ${spawnResult.error}. Aborting mesh.`,
        );
        break;
      }

      if (spawnResult.status === "failed") {
        logger.error(
          `[PeerToPeerRouter] Turn failed for speaker "${speakerName}". Aborting mesh.`,
        );
        break;
      }

      // 4. Merge modifications back so other worktrees see them (only if the agent actually changed files)
      const hasFileChanges =
        spawnResult.status === "completed" &&
        spawnResult.agent_id &&
        spawnResult.diff;

      if (hasFileChanges) {
        const subAgentId = spawnResult.agent_id!;
        const branchName = `orchestrator/${subAgentId}`;
        const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(
          orchestratorContext.workspaceRoot ?? undefined,
        );
        const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(
          workspaceRoot,
          member.files || [],
        );

        logger.info(
          `[PeerToPeerRouter] Merging branch ${branchName} back into main repo`,
        );
        const mergeResult = await GitWorktreeHelper.mergeWorktree(
          repositoryPath,
          branchName,
          `chore(mesh): merge turn ${turnIndex + 1} from ${speakerName}`,
        );

        if (mergeResult.error) {
          const errorMessage = `Failed to merge branch for ${subAgentId}: ${mergeResult.error}`;
          logger.error(`[PeerToPeerRouter] ${errorMessage}`);
          return [...results, { error: errorMessage }];
        }
      } else if (spawnResult.status === "completed") {
        logger.info(
          `[PeerToPeerRouter] No file changes from speaker "${speakerName}" — skipping merge step`,
        );
      }

      // 5. Append speaker output to shared thread
      const responseText =
        spawnResult.result ||
        buildToolCallFallbackSummary(spawnResult) ||
        spawnResult.summary;
      sharedDiscussion.push(`[${speakerName}]: ${responseText}`);

      // 6. Early exit check: if an agent signs off with [DONE] or all tasks are finished
      if (responseText.toUpperCase().includes("[DONE]")) {
        logger.info(
          `[PeerToPeerRouter] Speaker "${speakerName}" signaled termination ([DONE]). Stopping.`,
        );
        break;
      }

      // 7. Stall detection — short response with no tool usage indicates the agent
      // had nothing actionable. Consecutive stalls abort the mesh to prevent runaway loops.
      if (isStallResponse(responseText, spawnResult)) {
        consecutiveStallCount++;
        logger.warn(
          `[PeerToPeerRouter] Stall detected from "${speakerName}" (${consecutiveStallCount}/${maximumConsecutiveStalls} consecutive stalls)`,
        );
        if (consecutiveStallCount >= maximumConsecutiveStalls) {
          logger.error(
            `[PeerToPeerRouter] ${maximumConsecutiveStalls} consecutive stall responses detected — aborting mesh to prevent runaway loop`,
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

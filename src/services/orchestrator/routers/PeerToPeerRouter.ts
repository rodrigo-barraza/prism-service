import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter, ContinueSubAgentCallback } from "../TopologyRouter.ts";
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

/**
 * Peer-to-Peer (Mesh) Router — Stateful Session Reuse
 *
 * Implements a turn-based conversational mesh where agents take turns on a
 * shared discussion thread. Unlike stateless spawn-per-turn, this router:
 *
 * 1. Spawns each agent ONCE on their first turn (with `preserveWorktree: true`)
 * 2. Continues the SAME agent instance on subsequent turns via `continueSubAgent`
 * 3. Preserves agent state: conversation history, worktree edits, CLI state
 * 4. Merges worktree changes between turns so agents see each other's file edits
 *
 * This aligns with the AutoGen GroupChat persistent-agent model and eliminates
 * the overhead of creating/destroying Git worktrees on every turn.
 */
export class PeerToPeerRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    continueSubAgent?: ContinueSubAgentCallback,
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

    // Map of memberIndex → agentId for stateful session reuse.
    // Populated on each agent's first turn, then reused for subsequent turns.
    const agentIdsByMemberIndex = new Map<number, string>();

    // The most recent result per member slot — returned to the orchestrator
    const latestResultByMemberIndex = new Map<number, SubAgentResult | { error: string }>();

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
      const speakerName = member.agent || `agent-${memberIndex + 1}`;
      const isFirstTurnForMember = !agentIdsByMemberIndex.has(memberIndex);

      logger.info(
        `[PeerToPeerRouter] Turn ${turnIndex + 1}/${maxTurnsCount}: Active Speaker is "${speakerName}" (${member.description})${isFirstTurnForMember ? " [initial spawn]" : " [session continuation]"}`,
      );

      // Compile shared conversation thread history
      const promptHistory =
        sharedDiscussion.length > 0
          ? `--- SHARED DISCUSSION BOARD ---\n${sharedDiscussion.join("\n\n")}\n\n--- YOUR TASK (${speakerName}) ---\n${member.prompt}`
          : member.prompt;

      let spawnResult: SubAgentResult | { error: string };

      if (isFirstTurnForMember) {
        // ── First turn: Spawn the agent with preserveWorktree so the worktree
        // stays alive for subsequent continuation turns.
        const resolvedSiblings = await resolveSiblingInstances(
          { providerName, resolvedModel },
          "PeerToPeerRouter",
        );
        const { assignedProvider, assignedModel } = selectInstanceForMember(
          member,
          resolvedSiblings,
          { providerName, resolvedModel },
        );

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
          preserveWorktree: true,
        };

        spawnResult = await spawnSubAgent(assignment);

        // Register the agentId so subsequent turns reuse this agent
        if (!("error" in spawnResult)) {
          agentIdsByMemberIndex.set(memberIndex, spawnResult.agent_id);
        }
      } else {
        // ── Subsequent turn: Continue the existing agent session.
        // The agent retains its conversation history, worktree state, and tool context.
        const existingAgentId = agentIdsByMemberIndex.get(memberIndex)!;

        if (!continueSubAgent) {
          logger.error(
            `[PeerToPeerRouter] continueSubAgent callback not provided — cannot reuse session for "${speakerName}"`,
          );
          spawnResult = { error: "continueSubAgent callback not available for session reuse" };
        } else {
          spawnResult = await continueSubAgent(
            existingAgentId,
            promptHistory,
            orchestratorContext,
          );
        }
      }

      latestResultByMemberIndex.set(memberIndex, spawnResult);

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

      // Merge modifications back so other worktrees see them (only if the agent actually changed files)
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
          return [...latestResultByMemberIndex.values(), { error: errorMessage }];
        }
      } else if (spawnResult.status === "completed") {
        logger.info(
          `[PeerToPeerRouter] No file changes from speaker "${speakerName}" — skipping merge step`,
        );
      }

      // Append speaker output to shared thread
      const responseText =
        spawnResult.result ||
        buildToolCallFallbackSummary(spawnResult) ||
        spawnResult.summary;
      sharedDiscussion.push(`[${speakerName}]: ${responseText}`);

      // Early exit check: if an agent signs off with [DONE] or all tasks are finished
      if (responseText.toUpperCase().includes("[DONE]")) {
        logger.info(
          `[PeerToPeerRouter] Speaker "${speakerName}" signaled termination ([DONE]). Stopping.`,
        );
        break;
      }

      // Stall detection — short response with no tool usage indicates the agent
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

    // Return the most recent result per member slot (not per turn).
    // This keeps the result array aligned 1:1 with the original members array,
    // which is what the frontend TeamCreateRenderer expects.
    return [...latestResultByMemberIndex.values()];
  }
}

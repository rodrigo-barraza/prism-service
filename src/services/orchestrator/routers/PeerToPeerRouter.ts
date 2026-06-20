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
 * Strip echoed shared discussion board markers from a sub-agent's response
 * before appending it to the shared thread. Sub-agents often echo the
 * `--- SHARED DISCUSSION BOARD ---` prompt structure in their output,
 * which creates nested/duplicated boards on subsequent turns.
 */
function stripEchoedDiscussionMarkers(responseText: string): string {
  let cleanedText = responseText.trim();

  // Remove leading "--- SHARED DISCUSSION BOARD ---" and everything
  // up to the agent's actual new contribution. Look for the pattern
  // where the agent echoes the board then starts their own section.
  if (cleanedText.startsWith("--- SHARED DISCUSSION BOARD ---")) {
    // Find the last board marker — the agent may have echoed
    // the entire accumulated thread which itself contains markers
    const lastMarkerIndex = cleanedText.lastIndexOf(
      "--- SHARED DISCUSSION BOARD ---",
    );
    const afterLastMarker = cleanedText.slice(lastMarkerIndex);

    // Look for the agent's own content boundary: either a "---" separator
    // followed by a speaker tag, or a standalone markdown header
    const ownContentMatch = afterLastMarker.match(
      /\n---\s*\n+\s*(?:\[[\w-]+\]:\s|\#{1,4}\s)/,
    );

    if (ownContentMatch && ownContentMatch.index != null) {
      const bracketIndex = afterLastMarker.indexOf(
        "[",
        ownContentMatch.index,
      );
      const headerIndex = afterLastMarker.indexOf(
        "#",
        ownContentMatch.index,
      );
      const contentStart =
        bracketIndex >= 0 && (headerIndex < 0 || bracketIndex < headerIndex)
          ? bracketIndex
          : headerIndex;

      if (contentStart >= 0) {
        cleanedText = afterLastMarker.slice(contentStart).trim();
      }
    }
  }

  // Strip leading speaker self-tag if it matches the pattern [speaker-name]:
  // since we prepend our own "[speakerName]: " when appending to the thread
  cleanedText = cleanedText.replace(/^\[[\w-]+\]:\s*/, "").trim();

  return cleanedText;
}

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
  const isShortResponse =
    responseText.trim().length < MINIMUM_SUBSTANTIVE_RESPONSE_LENGTH;
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
 * Agent identifiers use 0-based indexing (agent-0, agent-1, ...) to align
 * with LLM-natural naming conventions — LLMs default to 0-based from their
 * code-heavy training data, eliminating identity conflicts.
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

    // Pre-compute 0-based speaker names for all members.
    // Custom agent names (e.g. "Dev", "QA") are used as-is.
    // Generic "agent-N" names or missing names default to agent-{memberIndex}.
    const speakerNamesByMemberIndex = members.map((member, index) => {
      const rawName = member.agent || `agent-${index}`;
      return /^agent-\d+$/i.test(rawName) ? `agent-${index}` : rawName;
    });

    // Map of memberIndex → agentId for stateful session reuse.
    // Populated on each agent's first turn, then reused for subsequent turns.
    const agentIdsByMemberIndex = new Map<number, string>();

    // The most recent result per member slot — returned to the orchestrator
    const latestResultByMemberIndex = new Map<
      number,
      SubAgentResult | { error: string }
    >();

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
      const speakerName = speakerNamesByMemberIndex[memberIndex];
      const isFirstTurnForMember = !agentIdsByMemberIndex.has(memberIndex);

      const currentRound = Math.floor(turnIndex / members.length) + 1;

      logger.info(
        `[PeerToPeerRouter] Turn ${turnIndex + 1}/${maxTurnsCount} (Round ${currentRound}): Active Speaker is "${speakerName}" (${member.description})${isFirstTurnForMember ? " [initial spawn]" : " [session continuation]"}`,
      );

      // Compile shared conversation thread history with explicit speaker identity
      const speakerIdentityLine = `Your speaker identity in this discussion is ${speakerName}. Tag all your contributions with [${speakerName}].`;
      const promptHistory =
        sharedDiscussion.length > 0
          ? `--- SHARED DISCUSSION BOARD ---\n${sharedDiscussion.join("\n\n")}\n\n--- YOUR TASK (${speakerName}) ---\n${speakerIdentityLine}\n\n${member.prompt}`
          : `${speakerIdentityLine}\n\n${member.prompt}`;

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
          round: currentRound,
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
          spawnResult = {
            error:
              "continueSubAgent callback not available for session reuse",
          };
        } else {
          spawnResult = await continueSubAgent(
            existingAgentId,
            promptHistory,
            orchestratorContext,
            currentRound,
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
          return [
            ...latestResultByMemberIndex.values(),
            { error: errorMessage },
          ];
        }
      } else if (spawnResult.status === "completed") {
        logger.info(
          `[PeerToPeerRouter] No file changes from speaker "${speakerName}" — skipping merge step`,
        );
      }

      // Append speaker output to shared thread — strip any echoed discussion
      // board markers the sub-agent may have included in its response to keep
      // the shared thread flat and avoid nested board duplication.
      const rawResponseText =
        spawnResult.result ||
        buildToolCallFallbackSummary(spawnResult) ||
        spawnResult.summary;
      const cleanedResponseText =
        stripEchoedDiscussionMarkers(rawResponseText);
      sharedDiscussion.push(`[${speakerName}]: ${cleanedResponseText}`);

      // Early exit check: if an agent signs off with [DONE] or all tasks are finished
      if (rawResponseText.toUpperCase().includes("[DONE]")) {
        logger.info(
          `[PeerToPeerRouter] Speaker "${speakerName}" signaled termination ([DONE]). Stopping.`,
        );
        break;
      }

      // Stall detection — short response with no tool usage indicates the agent
      // had nothing actionable. Consecutive stalls abort the mesh to prevent runaway loops.
      if (isStallResponse(rawResponseText, spawnResult)) {
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

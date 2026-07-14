import logger from "#src/utils/logger";
import { SYSTEM_STATUSES, ORCHESTRATOR } from "#src/constants";
import { GitWorktreeHelper } from "./GitWorktreeHelper.ts";
import { buildSubAgentResult } from "./SubAgentResultBuilder.ts";
import { SubAgentPersistenceService } from "./SubAgentPersistenceService.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type {
  SubAgentState,
  SubAgentResult,
  SubAgentStopResult,
} from "#src/types/orchestrator";

/**
 * Service for managing the lifecycle of sub-agents (stopping, aborting, output retrieval).
 */
export class SubAgentLifecycleService {
  /**
   * Persist the terminal status of a sub-agent to MongoDB so that
   * reloading the conversation after a stop/abort doesn't leave
   * stale "running" entries that the frontend renders as "Generating…".
   */
  private static async persistSubAgentTerminalStatus(
    subAgent: SubAgentState,
  ): Promise<void> {
    await SubAgentPersistenceService.markSubAgentTerminal({
      subAgentConversationId: subAgent.subAgentConversationId,
      status: subAgent.status,
      extraFields: {
        subAgentDurationMilliseconds: subAgent.durationMilliseconds,
      },
    });
  }

  /**
   * Stop a specific sub-agent and clean up its worktree.
   */
  static async stopSubAgent(
    agentId: string,
    activeSubAgents: Map<string, SubAgentState>,
  ): Promise<SubAgentStopResult | { error: string }> {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return { error: `Sub-agent "${agentId}" not found.` };
    }

    // Abort the sub-agent's loop
    if (subAgent.abortController) {
      subAgent.abortController.abort();
    }

    // Clean up worktree (only if sub-agent was running in an isolated worktree)
    if (subAgent.isolated && subAgent.worktreePath) {
      await GitWorktreeHelper.removeWorktree(
        subAgent.repositoryPath,
        subAgent.worktreePath,
      ).catch((error: unknown) =>
        logger.warn(
          `[SubAgentLifecycle] Worktree cleanup failed for ${agentId}: ${getErrorMessage(error)}`,
        ),
      );
      subAgent.worktreePath = null;
    }

    subAgent.status = SYSTEM_STATUSES.STOPPED;
    subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;

    // Persist to DB so reloads don't show stale "running" → "Generating…"
    await SubAgentLifecycleService.persistSubAgentTerminalStatus(subAgent);

    logger.info(`[SubAgentLifecycle] Stopped sub-agent ${agentId}`);

    return { agent_id: agentId, status: SYSTEM_STATUSES.STOPPED };
  }

  /**
   * Abort all running sub-agents associated with a parent conversation.
   */
  static async abortSubAgentsByConversation(
    parentConversationId: string,
    activeSubAgents: Map<string, SubAgentState>,
  ): Promise<void> {
    const sessionSubAgents = Array.from(activeSubAgents.values()).filter(
      (subAgent) => subAgent.parentConversationId === parentConversationId,
    );
    if (sessionSubAgents.length === 0) return;

    logger.info(
      `[SubAgentLifecycle] Aborting ${sessionSubAgents.length} sub-agent(s) for conversation ${parentConversationId}`,
    );

    const cleanupPromises: Promise<unknown>[] = [];
    const stoppedSubAgents: SubAgentState[] = [];
    for (const subAgent of sessionSubAgents) {
      if (subAgent.status === SYSTEM_STATUSES.RUNNING) {
        subAgent.abortController?.abort();
        subAgent.status = SYSTEM_STATUSES.STOPPED;
        subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;
        stoppedSubAgents.push(subAgent);
      }

      // Cleanup isolated worktrees immediately
      if (subAgent.isolated && subAgent.worktreePath) {
        const cleanupPromise = GitWorktreeHelper.removeWorktree(
          subAgent.repositoryPath,
          subAgent.worktreePath,
        )
          .then(() => {
            subAgent.worktreePath = null;
          })
          .catch((error: unknown) =>
            logger.warn(
              `[SubAgentLifecycle] Worktree cleanup failed for ${subAgent.agentId}: ${getErrorMessage(error)}`,
            ),
          );
        cleanupPromises.push(cleanupPromise);
      }
    }

    // Persist terminal status for all stopped sub-agents to MongoDB
    for (const stoppedSubAgent of stoppedSubAgents) {
      cleanupPromises.push(
        SubAgentLifecycleService.persistSubAgentTerminalStatus(stoppedSubAgent),
      );
    }

    await Promise.allSettled(cleanupPromises);
  }

  /**
   * Read the output or status from a sub-agent.
   */
  static getTaskOutput(
    agentId: string,
    activeSubAgents: Map<string, SubAgentState>,
    stripToolCallMarkup: (text: string) => string,
  ):
    | SubAgentResult
    | { error: string }
    | {
        agent_id: string;
        description: string;
        status: string;
        partialOutput: string | null;
        toolUses: number;
      } {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return {
        error: `Sub-agent "${agentId}" not found. It may have been cleaned up.`,
      };
    }

    if (subAgent.status === SYSTEM_STATUSES.RUNNING) {
      return {
        agent_id: agentId,
        description: subAgent.description,
        status: SYSTEM_STATUSES.RUNNING,
        partialOutput:
          stripToolCallMarkup(
            (subAgent.output || "").slice(
              -ORCHESTRATOR.PARTIAL_OUTPUT_TAIL_CHARACTERS,
            ),
          ) || null,
        toolUses: subAgent.toolCalls?.length || 0,
      };
    }

    const subAgentResult = buildSubAgentResult(subAgent);
    subAgent.messages = null; // Release heavy message data from RAM after copying to result
    return subAgentResult;
  }
}

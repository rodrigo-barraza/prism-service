import logger from "#src/utils/logger";
import { SYSTEM_STATUSES, ORCHESTRATOR } from "#src/constants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { GitWorktreeHelper } from "./GitWorktreeHelper.ts";
import { buildSubAgentResult } from "./SubAgentResultBuilder.ts";
import { SubAgentPersistenceService } from "./SubAgentPersistenceService.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type {
  SubAgentState,
  SubAgentResult,
  SubAgentStopResult,
} from "#src/types/orchestrator";
import type { EmitFunction } from "#src/services/harnesses/types";

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
   * Emit the initial live-status SSE event for a freshly spawned, continued,
   * or resumed sub-agent so the frontend can render it immediately — before
   * the agentic loop starts and before any result exists.
   */
  static emitSpawnedStatus(
    emit: EmitFunction | undefined,
    subAgent: SubAgentState,
  ): void {
    if (!emit) return;
    emit({
      type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
      subAgentId: subAgent.agentId,
      message: STATUS_MESSAGES.SPAWNED,
      description: subAgent.description,
      status: SYSTEM_STATUSES.RUNNING,
      agentConversationId: subAgent.parentAgentConversationId,
      conversationId: subAgent.subAgentConversationId,
      parentConversationId: subAgent.parentConversationId || null,
      model: subAgent.resolvedModel,
      provider: subAgent.providerName,
      agentIndex: subAgent.agentIndex ?? null,
      globalSpawnIndex: subAgent.globalSpawnIndex ?? null,
    });
  }

  /**
   * Mark a sub-agent as failed on an error path: set terminal status/error/
   * duration, emit the FAILED status event, and — when `cleanupResources` is
   * set (the spawn paths, which own a worktree and a persisted document) —
   * remove the worktree and persist the terminal status. Resource cleanup is
   * best-effort and fire-and-forget so the caller's error handling never
   * blocks on it.
   */
  static markSubAgentFailed(
    subAgent: SubAgentState,
    error: unknown,
    options: { emit?: EmitFunction; cleanupResources?: boolean } = {},
  ): void {
    const { emit, cleanupResources = false } = options;
    const errorMessage = getErrorMessage(error);

    subAgent.status = SYSTEM_STATUSES.FAILED;
    subAgent.error = errorMessage;
    subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;

    if (cleanupResources) {
      if (subAgent.isolated && subAgent.worktreePath) {
        void GitWorktreeHelper.removeWorktree(
          subAgent.repositoryPath,
          subAgent.worktreePath,
        ).catch((cleanupError: unknown) =>
          logger.warn(
            `[SubAgentLifecycle] Worktree cleanup failed for ${subAgent.agentId}: ${getErrorMessage(cleanupError)}`,
          ),
        );
      }
      void SubAgentPersistenceService.markSubAgentTerminal({
        subAgentConversationId: subAgent.subAgentConversationId,
        status: SYSTEM_STATUSES.FAILED,
        extraFields: {
          subAgentDurationMilliseconds: subAgent.durationMilliseconds,
        },
      });
    }

    if (emit) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
        subAgentId: subAgent.agentId,
        message: SYSTEM_STATUSES.FAILED,
        conversationId: subAgent.subAgentConversationId || null,
        error: errorMessage,
      });
    }
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

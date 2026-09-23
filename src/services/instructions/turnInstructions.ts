import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import logger from "#src/utils/logger";
import { createToolsServiceFileSource } from "./toolsServiceFileSource.ts";
import {
  discoverWorkspaceInstructions,
  type WorkspaceInstructions,
} from "./WorkspaceInstructions.ts";

/**
 * The workspace instructions for the directory a turn works in: an isolated
 * worktree's when the agent has one (standing in for its repository), else
 * the request's workspace, else the root the caller named, else the first
 * registered root. null without a workspace — never a guess like $HOME.
 * Never throws.
 */
export async function readTurnWorkspaceInstructions(
  turn: { agentConversationId?: string | null; workspaceRoot?: string | null },
  fallbackRoot: string | null = null,
): Promise<WorkspaceInstructions | null> {
  try {
    const worktree = ToolOrchestratorService.getWorktreeState?.(turn.agentConversationId);
    const workingDirectory =
      worktree?.worktreePath ||
      turn.workspaceRoot ||
      fallbackRoot ||
      ToolOrchestratorService.getWorkspaceRoot?.() ||
      null;
    if (!workingDirectory) return null;
    return await discoverWorkspaceInstructions(workingDirectory, {
      registeredRoots: ToolOrchestratorService.getWorkspaceRoots?.() ?? [],
      // The tools-service sandbox admits a worktree's paths only with its header.
      source: createToolsServiceFileSource({ workspaceOverride: worktree?.worktreePath ?? null }),
      worktree:
        worktree?.worktreePath && worktree.repoPath
          ? { repository: worktree.repoPath, worktree: worktree.worktreePath }
          : null,
    });
  } catch (error: unknown) {
    logger.warn(`[WorkspaceInstructions] Could not load workspace instructions: ${getErrorMessage(error)}`);
    return null;
  }
}

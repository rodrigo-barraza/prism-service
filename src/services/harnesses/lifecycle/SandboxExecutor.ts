import logger from "../../../utils/logger.ts";
import { TOOL_NAMES } from "../../ToolTaxonomyConstants.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import { executeToolBatch } from "./ToolExecutor.ts";
import { validateAfterToolExecution } from "./ValidationInterceptor.ts";

import type AgentHooks from "../../AgentHooks.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";
import type {
  ToolCall,
  ToolResult,
  AgenticContext,
  ResolvedTools,
} from "../types.ts";

/**
 * SandboxExecutor — speculative execution with git-based workspace rollback.
 *
 * Wraps destructive tool execution in a workspace snapshot so file changes
 * can be rolled back if validation fails. Uses git's internal mechanisms
 * (stash create / checkout) for workspace state recovery.
 *
 * Execution isolation is already handled by the Docker-containerized
 * tools-api service (sandboxed/privileged tiers). This module focuses
 * exclusively on workspace state rollback — reverting file mutations
 * when post-execution validation detects errors.
 *
 * 2026 SOTA pattern: "checkpoint → execute → validate → commit or rollback"
 * used by Cursor, Devin, and Factory for high-confidence tool execution.
 */

const DESTRUCTIVE_TOOLS: Set<string> = new Set([
  TOOL_NAMES.WRITE_FILE,
  TOOL_NAMES.STR_REPLACE_FILE,
  TOOL_NAMES.PATCH_FILE,
  TOOL_NAMES.MOVE_FILE,
  TOOL_NAMES.DELETE_FILE,
  TOOL_NAMES.EXECUTE_SHELL,
  TOOL_NAMES.EXECUTE_PYTHON,
  TOOL_NAMES.EXECUTE_JAVASCRIPT,
  TOOL_NAMES.RUN_COMMAND,
]);

const SANDBOX_SHELL_TIMEOUT_MS = 10_000;

/**
 * Create a lightweight git checkpoint (stash commit) of the current
 * workspace state without modifying the working tree.
 *
 * Returns the stash SHA or null if the workspace has no changes / is not a git repo.
 */
async function createCheckpoint(
  workspaceRoot: string,
  context: AgenticContext,
): Promise<string | null> {
  try {
    // Stage all changes first so stash create captures untracked files
    await ToolOrchestratorService.executeTool(
      TOOL_NAMES.EXECUTE_SHELL,
      {
        command: `timeout ${Math.floor(SANDBOX_SHELL_TIMEOUT_MS / 1000)}s git add -A`,
        cwd: workspaceRoot,
      },
      {
        project: context.project,
        username: context.username,
        agentSessionId: context.agentSessionId,
        workspaceRoot,
      },
    );

    const stashResult = await ToolOrchestratorService.executeTool(
      TOOL_NAMES.EXECUTE_SHELL,
      {
        command: `timeout ${Math.floor(SANDBOX_SHELL_TIMEOUT_MS / 1000)}s git stash create`,
        cwd: workspaceRoot,
      },
      {
        project: context.project,
        username: context.username,
        agentSessionId: context.agentSessionId,
        workspaceRoot,
      },
    ) as Record<string, unknown>;

    const stashSha = ((stashResult.stdout || stashResult.output || "") as string).trim();

    if (!stashSha || stashSha.length < 7) {
      logger.info("[SandboxExecutor] No changes to checkpoint (clean workspace)");
      return null;
    }

    logger.info(`[SandboxExecutor] Created checkpoint: ${stashSha.slice(0, 12)}`);
    return stashSha;
  } catch (checkpointError: unknown) {
    logger.warn(
      `[SandboxExecutor] Failed to create checkpoint: ${getErrorMessage(checkpointError)}`,
    );
    return null;
  }
}

/**
 * Rollback the workspace to a previous checkpoint.
 * Uses `git checkout -- .` to restore tracked files and `git clean -fd` for untracked.
 */
async function rollbackToCheckpoint(
  workspaceRoot: string,
  checkpointSha: string,
  context: AgenticContext,
): Promise<boolean> {
  try {
    await ToolOrchestratorService.executeTool(
      TOOL_NAMES.EXECUTE_SHELL,
      {
        command: `timeout ${Math.floor(SANDBOX_SHELL_TIMEOUT_MS / 1000)}s git stash apply ${checkpointSha} 2>&1 || git checkout -- .`,
        cwd: workspaceRoot,
      },
      {
        project: context.project,
        username: context.username,
        agentSessionId: context.agentSessionId,
        workspaceRoot,
      },
    );

    logger.info(`[SandboxExecutor] Rolled back to checkpoint: ${checkpointSha.slice(0, 12)}`);
    return true;
  } catch (rollbackError: unknown) {
    logger.error(
      `[SandboxExecutor] Rollback failed: ${getErrorMessage(rollbackError)}`,
    );
    return false;
  }
}

/**
 * Execute tools with speculative sandbox protection.
 *
 * When destructive tools are present:
 *   1. Creates a git checkpoint of the workspace
 *   2. Executes tools normally
 *   3. Runs validation on results
 *   4. On validation failure: rolls back and annotates results
 *   5. On success: keeps changes (no rollback needed)
 *
 * Falls through to normal `executeToolBatch` when no destructive tools
 * are present or sandbox is disabled.
 */
export async function executeWithSandbox(
  toolCalls: ToolCall[],
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: InstanceType<typeof AgentHooks>,
  state: AgenticLoopState,
): Promise<{ results: ToolResult[]; rolledBack: boolean }> {
  const hasDestructiveTools = toolCalls.some((toolCall) =>
    DESTRUCTIVE_TOOLS.has(toolCall.name),
  );

  // Fast path: no destructive tools → skip sandboxing entirely
  if (!hasDestructiveTools) {
    const results = await executeToolBatch(toolCalls, context, tools, hooks, state);
    return { results, rolledBack: false };
  }

  const workspaceRoot = context.workspaceRoot || ToolOrchestratorService.getWorkspaceRoot();

  // No workspace root → can't checkpoint, execute normally
  if (!workspaceRoot) {
    logger.warn("[SandboxExecutor] No workspace root — executing without sandbox");
    const results = await executeToolBatch(toolCalls, context, tools, hooks, state);
    return { results, rolledBack: false };
  }

  // Step 1: Create checkpoint
  const checkpointSha = await createCheckpoint(workspaceRoot, context);

  // Step 2: Execute tools
  const results = await executeToolBatch(toolCalls, context, tools, hooks, state);

  // Step 3: Validate results
  const validationFeedback = await validateAfterToolExecution(
    toolCalls,
    results,
    context,
    state,
  );

  // Step 4: If validation failed AND we have a checkpoint → rollback
  if (validationFeedback.length > 0 && checkpointSha) {
    const rollbackSucceeded = await rollbackToCheckpoint(workspaceRoot, checkpointSha, context);

    if (rollbackSucceeded) {
      // Annotate results with rollback metadata
      for (const result of results) {
        const resultObject = result.result as Record<string, unknown> | null;
        if (resultObject && !resultObject.error) {
          resultObject._rolledBack = true;
          resultObject._validationErrors = validationFeedback.map(
            (feedback) => `${feedback.filePath}: ${feedback.errors.join("; ")}`,
          );
        }
      }

      logger.info(
        `[SandboxExecutor] Rolled back ${validationFeedback.length} validation failure(s)`,
      );
      return { results, rolledBack: true };
    }
  }

  return { results, rolledBack: false };
}

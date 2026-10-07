import { resolveLoopKey } from "#src/services/LoopKey";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { ToolExecutionContext } from "#src/services/tool-orchestrator/types";

// ────────────────────────────────────────────────────────────
// BackgroundCommands — execute_command with `run_in_background`
// ────────────────────────────────────────────────────────────
// tools-service starts the command as a task and answers at once with its
// id and output file (`backgrounded: true`). Prism watches the task
// (BackgroundTaskWatcher), so its exit reaches the agent — into the
// running turn, or by waking a new one — and tells the model Claude Code's
// line. The model reads the output file with read_file and stops the
// command with task_stop.
// ────────────────────────────────────────────────────────────

/** Longest description taken from the command itself when the call gave none. */
const DESCRIPTION_FROM_COMMAND_CHARACTERS = 80;

export interface BackgroundedCommandResult {
  backgrounded: true;
  taskId: string;
  outputFile?: string;
  [key: string]: unknown;
}

/** tools-service started the command in the background (not a foreground result). */
export function isBackgroundedCommand(result: unknown): result is BackgroundedCommandResult {
  const fields = result as { backgrounded?: unknown; taskId?: unknown } | null;
  return !!fields && fields.backgrounded === true && typeof fields.taskId === "string" && fields.taskId !== "";
}

/** Claude Code's answer to a background Bash call. */
export function backgroundCommandLine(taskId: string, outputFile: string | undefined): string {
  return `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile ?? "(unknown)"}`;
}

/** What the notifications call the command: the call's own description, else the command. */
function descriptionOf(args: Record<string, unknown>): string {
  if (typeof args.description === "string" && args.description.trim()) return args.description.trim();
  const command = typeof args.command === "string" ? args.command.trim().split("\n")[0] : "";
  return command.length > DESCRIPTION_FROM_COMMAND_CHARACTERS
    ? `${command.slice(0, DESCRIPTION_FROM_COMMAND_CHARACTERS - 1)}…`
    : command || "background command";
}

/**
 * Watch the background command tools-service started and give the model
 * Claude Code's line. A call with no conversation to report to is still
 * answered; nothing will tell it when the command ends.
 */
export async function watchBackgroundCommand(
  result: BackgroundedCommandResult,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<Record<string, unknown>> {
  const message = backgroundCommandLine(result.taskId, result.outputFile);
  const loopKey = resolveLoopKey({
    conversationId: context.conversationId,
    agentConversationId: context.agentConversationId,
  });
  if (!loopKey) {
    logger.warn(`[BackgroundCommands] ${result.taskId} has no conversation to report its exit to`);
    return { ...result, message };
  }
  try {
    const { default: ToolOrchestratorService } = await import("#src/services/ToolOrchestratorService");
    const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
    const { default: BackgroundTaskWatcher } = await import("./BackgroundTaskWatcher.ts");
    await BackgroundTaskWatcher.watch({
      taskId: result.taskId,
      taskType: "shell",
      description: descriptionOf(args),
      ...(typeof args.command === "string" ? { command: args.command } : {}),
      ...(result.outputFile ? { outputFile: result.outputFile } : {}),
      owner: {
        conversationId: loopKey,
        agentConversationId: context.agentConversationId ?? null,
        project: context.project ?? null,
        username: context.username ?? null,
        workspaceRoot:
          ToolOrchestratorService.getWorktreeState(context.agentConversationId)?.worktreePath ||
          context.workspaceRoot ||
          ToolOrchestratorService.getWorkspaceRoot() ||
          null,
        isSubAgent: OrchestratorService.isSubAgentConversation(loopKey),
      },
    });
  } catch (error: unknown) {
    logger.warn(`[BackgroundCommands] Could not watch ${result.taskId}: ${getErrorMessage(error)}`);
  }
  return { ...result, message };
}

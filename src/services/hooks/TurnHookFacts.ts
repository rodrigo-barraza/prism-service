import path from "node:path";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import type { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import {
  hookPermissionModeName,
  isPermissionMode,
  type PermissionMode,
} from "#src/services/permissions/PermissionModes";
import { worktreeCheckoutRoot } from "#src/services/tool-orchestrator/WorktreePathRewrite";
import type { WorktreeState } from "#src/services/tool-orchestrator/types";
import type { TurnTranscript } from "#src/services/hooks/ClaudeTranscript";

/**
 * TurnHookFacts — what every hook payload of a running turn says about
 * where and how the turn runs: its workspace root, its permission mode and
 * its transcript.
 *
 * Payloads are built in several places, each from a different slice of the
 * turn: TurnHooks from the agentic context, the registry's adapter from a
 * tool call and the scope its hooks were registered with, and a few seams
 * from the identity they were handed (the approval gate's Notification,
 * compaction, a SessionEnd that fires after its turn). Before this registry
 * each of them derived `cwd` on its own, and a turn without an explicit
 * workspace root reported `cwd: null` on some events and nothing on others.
 * TurnHooks records the facts once when the turn opens (`openTurnHooks`)
 * and drops them when it closes; every builder reads them by the run's
 * `agentConversationId`.
 *
 * Also here, because every turn needs them before anything heavier is
 * loaded: where the turn works (`resolveTurnWorkspace`, `hostRootOf`), and
 * whether it will run a command hook (`runsCommandHooks`) — the one thing
 * that makes it keep a transcript.
 */

export interface TurnHookFacts {
  /**
   * The directory the turn works in: a sub-agent's worktree, the requested
   * workspace root, or tools-service's default root. Null without a workspace.
   */
  workspaceRoot: string | null;
  /** The worktree the turn works in, when it has one. */
  worktree: WorktreeState | null;
  /** Claude Code's name for the turn's permission mode, read when a payload is built. */
  permissionMode: () => string;
  /** The turn's Claude-shaped transcript, when it keeps one (ClaudeTranscript). */
  transcript?: TurnTranscript | null;
}

const live = new Map<string, TurnHookFacts>();

/** Record a turn's facts. Returns the release; only the facts recorded release themselves. */
export function rememberTurnHookFacts(
  agentConversationId: string | null | undefined,
  facts: TurnHookFacts,
): () => void {
  if (!agentConversationId) return () => {};
  live.set(agentConversationId, facts);
  return () => {
    if (live.get(agentConversationId) === facts) live.delete(agentConversationId);
  };
}

/** The facts of the running turn of `agentConversationId`, if one is open. */
export function turnHookFacts(
  agentConversationId: string | null | undefined,
): TurnHookFacts | null {
  return agentConversationId ? (live.get(agentConversationId) ?? null) : null;
}

/**
 * Claude Code's name for a mode, which is what `permission_mode` carries.
 * "Approve all" on top of the default mode is what Claude Code calls
 * bypassing permissions — the PermissionRequest payload's rule.
 */
export function claudePermissionMode(
  mode: PermissionModeHandle | PermissionMode | string | null | undefined,
  autoApprove = false,
): string {
  const name = typeof mode === "string" ? mode : mode?.mode;
  const resolved: PermissionMode = isPermissionMode(name) ? name : "default";
  return hookPermissionModeName(autoApprove && resolved === "default" ? "bypass" : resolved);
}

/** The mode carried on a turn's loop options (`_permissionMode`, `autoApprove`). */
export function claudePermissionModeOf(
  options: { _permissionMode?: unknown; autoApprove?: unknown } | null | undefined,
): string {
  return claudePermissionMode(
    options?._permissionMode as PermissionModeHandle | string | null | undefined,
    options?.autoApprove === true,
  );
}

/** Test seam. */
export function _clearTurnHookFacts(): void {
  live.clear();
}

// ── The turn's workspace ──────────────────────────────────────

/** The directory a turn works in, and its worktree when it has one. */
export interface TurnWorkspace {
  root: string | null;
  worktree: WorktreeState | null;
}

/**
 * The workspace a turn works in — what its tools use and what its
 * instruction files are read from (turnInstructions): the sub-agent's
 * worktree, the request's root, else tools-service's default root. None
 * with Workspace off. Never throws.
 */
export async function resolveTurnWorkspace(turn: {
  agentConversationId?: string | null;
  workspaceRoot?: string | null;
  options?: Record<string, unknown> | null;
}): Promise<TurnWorkspace> {
  if (turn.options?.workspaceEnabled === false) return { root: null, worktree: null };
  try {
    const { default: ToolOrchestratorService } = await import("#src/services/ToolOrchestratorService");
    const worktree =
      (ToolOrchestratorService.getWorktreeState?.(turn.agentConversationId) as WorktreeState | null | undefined) ??
      null;
    const root =
      worktree?.worktreePath ||
      turn.workspaceRoot ||
      (ToolOrchestratorService.getWorkspaceRoot?.() as string | null | undefined) ||
      null;
    return { root: root ? path.posix.resolve(root) : null, worktree };
  } catch (error: unknown) {
    logger.warn(`[TurnHookFacts] Could not resolve the turn's workspace: ${errorMessage(error)}`);
    return { root: turn.workspaceRoot ? path.posix.resolve(turn.workspaceRoot) : null, worktree: null };
  }
}

/**
 * The registered root a turn's requests to tools-service are routed by: the
 * checkout a worktree was cut from (worktrees live outside every registered
 * root, under tools-service's worktree directory), else the turn's root.
 */
export function hostRootOf(workspace: TurnWorkspace): string | null {
  if (!workspace.worktree) return workspace.root;
  const checkout = worktreeCheckoutRoot(workspace.worktree);
  return checkout ? path.posix.resolve(checkout) : workspace.root;
}

// ── Runs that execute command hooks ───────────────────────────

/** `AgentHooks` instances a `command` hook was registered into (a stored one, or a repository's). */
const instancesRunningCommands = new WeakSet<object>();

/** Recorded by the registry when it registers a command hook. */
export function noteCommandHooks(hooks: object): void {
  instancesRunningCommands.add(hooks);
}

/**
 * Will this run execute a command hook? Those are the hooks that read files
 * on the workspace's machine — the turn keeps a Claude-shaped transcript for
 * them (ClaudeTranscript), and for nothing else.
 */
export function runsCommandHooks(hooks: object): boolean {
  return instancesRunningCommands.has(hooks);
}

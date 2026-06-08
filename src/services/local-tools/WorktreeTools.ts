import logger from "../../utils/logger.ts";
import { SSE_EVENT_TYPES, STATUS_MESSAGES, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

// ── Worktree Isolation Tools ────────────────────────────────
// Allows the agent to self-isolate into a git worktree for
// speculative or risky changes. The active worktree state is
// managed by ToolOrchestratorService (activeWorktrees map).

interface ToolContext {
  agentSessionId?: string;
  project?: string;
  _emit?: (event: { type: string; [key: string]: unknown }) => void;
  [key: string]: unknown;
}

interface WorktreeCreateResult {
  worktreePath?: string;
  error?: string;
}

interface WorktreeMergeResult {
  error?: string;
  diff?: unknown;
}

interface EnterWorktreeArgs {
  reason?: string;
}

interface ExitWorktreeArgs {
  action: "merge" | "discard";
  commitMessage?: string;
}

const enterWorktree = {
  name: TOOL_NAMES.ENTER_WORKTREE,
  schema: {
    name: TOOL_NAMES.ENTER_WORKTREE,
    description:
      "Enter an isolated git worktree for the current conversation. Creates a new branch " +
      "and redirects all file/git/shell tool calls to the worktree directory. " +
      "Use this to try risky refactors, experimental changes, or speculative edits " +
      "without affecting the main branch. Your full conversation context is preserved. " +
      "Call exit_worktree to merge or discard when done.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Why you're entering an isolated worktree (e.g. 'risky refactor', 'experimental approach').",
        },
      },
      required: [],
    },
  },
  domain: "Core Harness Tools",
  labels: ["coding", "git"],

  async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
    const enterArgs = args as unknown as EnterWorktreeArgs;
    const typedContext = context as unknown as ToolContext;

    const { default: ToolOrchestratorService } =
      await import("../ToolOrchestratorService.js");
    const { resolve } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const sessionId = typedContext.agentSessionId;
    if (!sessionId) {
      return {
        error:
          "No agent session — worktree isolation requires an active session",
      };
    }

    const worktreeState = ToolOrchestratorService.getWorktreeState(sessionId);
    if (worktreeState) {
      return {
        error: `Already in a worktree (branch: ${worktreeState.branchName}). Call exit_worktree first.`,
      };
    }

    const workspaceRoot = ToolOrchestratorService.getWorkspaceRoot();
    if (!workspaceRoot) {
      return { error: "No workspace root configured" };
    }

    const repoPath = existsSync(resolve(workspaceRoot, ".git"))
      ? workspaceRoot
      : workspaceRoot;

    const branchName = `worktree/${sessionId.slice(0, 8)}-${Date.now().toString(36)}`;

    // Create worktree via tools-api
    const createResult = await ToolOrchestratorService._proxyPost(
      "/agentic/git/worktree/create",
      { path: repoPath, branch: branchName },
      typedContext,
    ) as WorktreeCreateResult;

    if (createResult.error) {
      return { error: `Failed to create worktree: ${createResult.error}` };
    }

    // Store the worktree state
    ToolOrchestratorService._setWorktree(sessionId, {
      originalRoot: workspaceRoot,
      worktreePath: createResult.worktreePath!,
      branchName,
      repoPath,
    });

    logger.info(
      `[Worktree] enter: ${branchName} → ${createResult.worktreePath}`,
    );

    if (typedContext._emit) {
      typedContext._emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.WORKTREE_ENTERED,
        branch: branchName,
        path: createResult.worktreePath,
      });
    }

    return {
      acknowledged: true,
      branch: branchName,
      worktreePath: createResult.worktreePath,
      reason: enterArgs.reason || null,
      message: `Now working in isolated worktree. All file operations are redirected to ${createResult.worktreePath}. Call exit_worktree with action 'merge' or 'discard' when done.`,
    };
  },
};

const exitWorktree = {
  name: TOOL_NAMES.EXIT_WORKTREE,
  schema: {
    name: TOOL_NAMES.EXIT_WORKTREE,
    description:
      "Exit the current isolated worktree and return to the main workspace. " +
      "Choose to 'merge' changes back to the main branch or 'discard' them entirely. " +
      "If merging, changes are committed and merged automatically.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["merge", "discard"],
          description:
            "'merge' to apply changes to main branch, 'discard' to throw them away.",
        },
        commitMessage: {
          type: "string",
          description:
            "Commit message for the merge (used when action is 'merge'). Auto-generated if not provided.",
        },
      },
      required: ["action"],
    },
  },
  domain: "Core Harness Tools",
  labels: ["coding", "git"],

  async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
    const exitArgs = args as unknown as ExitWorktreeArgs;
    const typedContext = context as unknown as ToolContext;

    const { default: ToolOrchestratorService } =
      await import("../ToolOrchestratorService.js");

    const sessionId = typedContext.agentSessionId;
    const worktreeState = ToolOrchestratorService.getWorktreeState(sessionId);
    if (!sessionId || !worktreeState) {
      return {
        error: "Not currently in a worktree. Call enter_worktree first.",
      };
    }

    const { action, commitMessage } = exitArgs;
    let mergeResult: WorktreeMergeResult | null = null;

    if (action === "merge") {
      const diffResult = await ToolOrchestratorService._proxyPost(
        "/agentic/git/worktree/diff",
        { path: worktreeState.repoPath, branch: worktreeState.branchName },
        typedContext,
      ) as { error?: string };

      mergeResult = await ToolOrchestratorService._proxyPost(
        "/agentic/git/worktree/merge",
        {
          path: worktreeState.repoPath,
          branch: worktreeState.branchName,
          message: commitMessage || `Merge worktree: ${worktreeState.branchName}`,
        },
        typedContext,
      ) as WorktreeMergeResult;

      if (mergeResult.error) {
        return {
          error: `Merge failed: ${mergeResult.error}. Worktree preserved at ${worktreeState.worktreePath}. Resolve conflicts and try again, or exit_worktree with action 'discard'.`,
        };
      }

      mergeResult.diff = diffResult.error ? null : diffResult;
    }

    // Remove the worktree (both merge and discard)
    await ToolOrchestratorService._proxyPost(
      "/agentic/git/worktree/remove",
      { path: worktreeState.repoPath, worktreePath: worktreeState.worktreePath, deleteBranch: true },
      typedContext,
    );

    ToolOrchestratorService._clearWorktree(sessionId);

    logger.info(`[Worktree] exit: ${action} — ${worktreeState.branchName}`);

    if (typedContext._emit) {
      typedContext._emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.WORKTREE_EXITED,
        action,
        branch: worktreeState.branchName as string,
      });
    }

    return {
      acknowledged: true,
      action,
      branch: worktreeState.branchName,
      merged: action === "merge" ? mergeResult : undefined,
      message:
        action === "merge"
          ? `Changes from ${worktreeState.branchName} merged into main branch. Workspace restored.`
          : `Worktree ${worktreeState.branchName} discarded. All changes removed. Workspace restored.`,
    };
  },
};

export default [enterWorktree, exitWorktree];

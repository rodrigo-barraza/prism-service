import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";

// ── Worktree Isolation Tools ────────────────────────────────
// Allows the agent to self-isolate into a git worktree for
// speculative or risky changes. The active worktree state is
// managed by ToolOrchestratorService (activeWorktrees map).

import { type InternalToolContext } from "./InternalToolRegistry.ts";

interface WorktreeContext extends InternalToolContext {
  _emit?: (event: { type: string; [key: string]: unknown }) => void;
}

interface WorktreeCreateResult {
  worktreePath?: string;
  branch?: string;
  error?: string;
}

interface WorktreeMergeResult {
  error?: string;
  diff?: unknown;
}

const enterWorktree = {
  name: TOOL_NAMES.ENTER_WORKTREE,
  capabilities: ["fs_write"] as const,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.ENTER_WORKTREE],
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
  display: {
    activeVerb: "Entering worktree",
    completedVerb: "Entered worktree",
    subjectParam: "reason",
    subjectFormat: "truncate" as const,
  },
  domain: DOMAINS.CORE_WORKSPACE.displayName,
  labels: ["coding", "git"],

  async execute(
    toolArguments: Record<string, unknown>,
    context: WorktreeContext,
  ) {
    const reason =
      typeof toolArguments.reason === "string"
        ? toolArguments.reason
        : undefined;

    const { default: ToolOrchestratorService } =
      await import("#src/services/ToolOrchestratorService");
    const { resolve } = await import("node:path");
    const { existsSync } = await import("node:fs");

    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.enter_worktree.noConversation",
        ),
      };
    }

    const worktreeState =
      ToolOrchestratorService.getWorktreeState(agentConversationId);
    if (worktreeState) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.enter_worktree.alreadyInWorktree",
          { branch: String(worktreeState.branchName) },
        ),
      };
    }

    const workspaceRoot = ToolOrchestratorService.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.enter_worktree.noWorkspace",
        ),
      };
    }

    const repoPath = existsSync(resolve(workspaceRoot, ".git"))
      ? workspaceRoot
      : workspaceRoot;

    const requestedBranchName = `worktree/${agentConversationId.slice(0, 8)}-${Date.now().toString(36)}`;

    // Create worktree via tools-api
    const proxyResult = await ToolOrchestratorService._proxyPost(
      "/agentic/git/worktree/create",
      { path: repoPath, branch: requestedBranchName },
      context,
    );

    const createResult: WorktreeCreateResult = {};
    if (
      proxyResult &&
      typeof proxyResult === "object" &&
      !Array.isArray(proxyResult)
    ) {
      const record = proxyResult as Record<string, unknown>;
      if (typeof record.worktreePath === "string") {
        createResult.worktreePath = record.worktreePath;
      }
      if (typeof record.branch === "string") {
        createResult.branch = record.branch;
      }
      if (typeof record.error === "string") {
        createResult.error = record.error;
      }
    }

    if (createResult.error) {
      return { error: `Failed to create worktree: ${createResult.error}` };
    }
    // Store the branch tools-service created, never the name we asked for.
    const branchName = createResult.branch ?? requestedBranchName;

    // Store the worktree state
    ToolOrchestratorService._setWorktree(agentConversationId, {
      originalRoot: workspaceRoot,
      worktreePath: createResult.worktreePath!,
      branchName,
      repoPath,
    });

    logger.info(
      `[Worktree] enter: ${branchName} → ${createResult.worktreePath}`,
    );

    if (context._emit) {
      context._emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.WORKTREE_ENTERED,
        branch: branchName,
        path: createResult.worktreePath,
      });
    }

    return {
      acknowledged: true,
      branch: branchName,
      worktreePath: createResult.worktreePath,
      reason: reason || null,
      message: PromptLocaleService.get(
        PromptLocaleService.getDefaultLocale(),
        "internal-tools-runtime.enter_worktree.success",
        { path: createResult.worktreePath! },
      ),
    };
  },
};

const exitWorktree = {
  name: TOOL_NAMES.EXIT_WORKTREE,
  capabilities: ["fs_write"] as const,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.EXIT_WORKTREE],
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
  display: {
    activeVerb: "Exiting worktree",
    completedVerb: "Exited worktree",
    subjectParam: "action",
    subjectFormat: "quoted" as const,
  },
  domain: DOMAINS.CORE_WORKSPACE.displayName,
  labels: ["coding", "git"],

  async execute(
    toolArguments: Record<string, unknown>,
    context: WorktreeContext,
  ) {
    const action =
      typeof toolArguments.action === "string" &&
      (toolArguments.action === "merge" || toolArguments.action === "discard")
        ? toolArguments.action
        : undefined;
    const commitMessage =
      typeof toolArguments.commitMessage === "string"
        ? toolArguments.commitMessage
        : undefined;

    const { default: ToolOrchestratorService } =
      await import("#src/services/ToolOrchestratorService");

    const agentConversationId = context.agentConversationId;
    const worktreeState =
      ToolOrchestratorService.getWorktreeState(agentConversationId);
    if (!agentConversationId || !worktreeState) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.exit_worktree.notInWorktree",
        ),
      };
    }

    if (!action) {
      return {
        error:
          "Missing or invalid parameter 'action'. Must be 'merge' or 'discard'.",
      };
    }

    let mergeResult: WorktreeMergeResult | null = null;

    const errorOf = (value: unknown): string | undefined =>
      value && typeof value === "object" && !Array.isArray(value)
        ? typeof (value as Record<string, unknown>).error === "string"
          ? ((value as Record<string, unknown>).error as string)
          : undefined
        : undefined;
    const mergeFailed = (error: string) => ({
      error: PromptLocaleService.get(
        PromptLocaleService.getDefaultLocale(),
        "internal-tools-runtime.exit_worktree.mergeFailed",
        { error, path: worktreeState.worktreePath },
      ),
    });

    if (action === "merge") {
      // The agent's edits are uncommitted until now: commit them first, or
      // the merge carries nothing.
      const commitError = errorOf(
        await ToolOrchestratorService._proxyPost(
          "/agentic/git/worktree/commit",
          {
            path: worktreeState.repoPath,
            worktreePath: worktreeState.worktreePath,
            message:
              commitMessage || `Worktree work: ${worktreeState.branchName}`,
          },
          context,
        ),
      );
      if (commitError) return mergeFailed(commitError);

      const proxyDiffResult = await ToolOrchestratorService._proxyPost(
        "/agentic/git/worktree/diff",
        { path: worktreeState.repoPath, branch: worktreeState.branchName },
        context,
      );

      const proxyMergeResult = await ToolOrchestratorService._proxyPost(
        "/agentic/git/worktree/merge",
        {
          path: worktreeState.repoPath,
          branch: worktreeState.branchName,
          message:
            commitMessage || `Merge worktree: ${worktreeState.branchName}`,
        },
        context,
      );
      // A refused merge (conflict, or uncommitted edits in the main tree)
      // keeps the worktree and branch: the error names the path.
      const mergeError = errorOf(proxyMergeResult);
      if (mergeError) return mergeFailed(mergeError);

      mergeResult = {
        diff: errorOf(proxyDiffResult) ? null : proxyDiffResult,
      };
    }

    // Remove the worktree. After a merge its branch is contained, so the
    // safe removal succeeds; only an explicit discard forces.
    const removeError = errorOf(
      await ToolOrchestratorService._proxyPost(
        "/agentic/git/worktree/remove",
        {
          path: worktreeState.repoPath,
          worktreePath: worktreeState.worktreePath,
          deleteBranch: true,
          force: action === "discard",
        },
        context,
      ),
    );
    if (removeError) {
      logger.warn(
        `[Worktree] exit: kept ${worktreeState.worktreePath} (${worktreeState.branchName}): ${removeError}`,
      );
    }

    ToolOrchestratorService._clearWorktree(agentConversationId);

    logger.info(`[Worktree] exit: ${action} — ${worktreeState.branchName}`);

    if (context._emit) {
      context._emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
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
          ? PromptLocaleService.get(
              PromptLocaleService.getDefaultLocale(),
              "internal-tools-runtime.exit_worktree.merged",
              { branch: String(worktreeState.branchName) },
            )
          : PromptLocaleService.get(
              PromptLocaleService.getDefaultLocale(),
              "internal-tools-runtime.exit_worktree.discarded",
              { branch: String(worktreeState.branchName) },
            ),
    };
  },
};

export default [enterWorktree, exitWorktree];

import logger from "../../utils/logger.js";
// ── Worktree Isolation Tools ────────────────────────────────
// Allows the agent to self-isolate into a git worktree for
// speculative or risky changes. The active worktree state is
// managed by ToolOrchestratorService (activeWorktrees map).
const enterWorktree = {
    name: "enter_worktree",
    schema: {
        name: "enter_worktree",
        description: "Enter an isolated git worktree for the current conversation. Creates a new branch " +
            "and redirects all file/git/shell tool calls to the worktree directory. " +
            "Use this to try risky refactors, experimental changes, or speculative edits " +
            "without affecting the main branch. Your full conversation context is preserved. " +
            "Call exit_worktree to merge or discard when done.",
        parameters: {
            type: "object",
            properties: {
                reason: {
                    type: "string",
                    description: "Why you're entering an isolated worktree (e.g. 'risky refactor', 'experimental approach').",
                },
            },
            required: [],
        },
    },
    domain: "Agentic: Git Isolation",
    labels: ["coding", "git"],
    async execute(args, context) {
        const { default: ToolOrchestratorService } = await import("../ToolOrchestratorService.js");
        const { resolve } = await import("node:path");
        const { existsSync } = await import("node:fs");
        const sessionId = context.agentSessionId;
        if (!sessionId) {
            return {
                error: "No agent session — worktree isolation requires an active session",
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
        const createResult = await ToolOrchestratorService._proxyPost("/agentic/git/worktree/create", { path: repoPath, branch: branchName }, context);
        if (createResult.error) {
            return { error: `Failed to create worktree: ${createResult.error}` };
        }
        // Store the worktree state
        ToolOrchestratorService._setWorktree(sessionId, {
            originalRoot: workspaceRoot,
            worktreePath: createResult.worktreePath,
            branchName,
            repoPath,
        });
        logger.info(`[Worktree] enter: ${branchName} → ${createResult.worktreePath}`);
        if (context._emit) {
            context._emit({
                type: "status",
                message: "worktree_entered",
                branch: branchName,
                path: createResult.worktreePath,
            });
        }
        return {
            acknowledged: true,
            branch: branchName,
            worktreePath: createResult.worktreePath,
            reason: args.reason || null,
            message: `Now working in isolated worktree. All file operations are redirected to ${createResult.worktreePath}. Call exit_worktree with action 'merge' or 'discard' when done.`,
        };
    },
};
const exitWorktree = {
    name: "exit_worktree",
    schema: {
        name: "exit_worktree",
        description: "Exit the current isolated worktree and return to the main workspace. " +
            "Choose to 'merge' changes back to the main branch or 'discard' them entirely. " +
            "If merging, changes are committed and merged automatically.",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["merge", "discard"],
                    description: "'merge' to apply changes to main branch, 'discard' to throw them away.",
                },
                commitMessage: {
                    type: "string",
                    description: "Commit message for the merge (used when action is 'merge'). Auto-generated if not provided.",
                },
            },
            required: ["action"],
        },
    },
    domain: "Agentic: Git Isolation",
    labels: ["coding", "git"],
    async execute(args, context) {
        const { default: ToolOrchestratorService } = await import("../ToolOrchestratorService.js");
        const sessionId = context.agentSessionId;
        const wt = ToolOrchestratorService.getWorktreeState(sessionId);
        if (!sessionId || !wt) {
            return {
                error: "Not currently in a worktree. Call enter_worktree first.",
            };
        }
        const { action, commitMessage } = args;
        let mergeResult = null;
        if (action === "merge") {
            const diffResult = await ToolOrchestratorService._proxyPost("/agentic/git/worktree/diff", { path: wt.repoPath, branch: wt.branchName }, context);
            mergeResult = await ToolOrchestratorService._proxyPost("/agentic/git/worktree/merge", {
                path: wt.repoPath,
                branch: wt.branchName,
                message: commitMessage || `Merge worktree: ${wt.branchName}`,
            }, context);
            if (mergeResult.error) {
                return {
                    error: `Merge failed: ${mergeResult.error}. Worktree preserved at ${wt.worktreePath}. Resolve conflicts and try again, or exit_worktree with action 'discard'.`,
                };
            }
            mergeResult.diff = diffResult.error ? null : diffResult;
        }
        // Remove the worktree (both merge and discard)
        await ToolOrchestratorService._proxyPost("/agentic/git/worktree/remove", { path: wt.repoPath, worktreePath: wt.worktreePath, deleteBranch: true }, context);
        ToolOrchestratorService._clearWorktree(sessionId);
        logger.info(`[Worktree] exit: ${action} — ${wt.branchName}`);
        if (context._emit) {
            context._emit({
                type: "status",
                message: "worktree_exited",
                action,
                branch: wt.branchName,
            });
        }
        return {
            acknowledged: true,
            action,
            branch: wt.branchName,
            merged: action === "merge" ? mergeResult : undefined,
            message: action === "merge"
                ? `Changes from ${wt.branchName} merged into main branch. Workspace restored.`
                : `Worktree ${wt.branchName} discarded. All changes removed. Workspace restored.`,
        };
    },
};
export default [enterWorktree, exitWorktree];
//# sourceMappingURL=WorktreeTools.js.map
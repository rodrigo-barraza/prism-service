import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { TOOLS_SERVICE_URL } from "#config";
import { traceHeaders } from "#src/services/Tracing";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import type {
  ToolsApiResponse,
  WorktreeCommitResponse,
  WorktreeCreateResponse,
  WorktreeDiff,
  WorktreeDiffFile,
  WorktreeMergeResponse,
  WorktreeRemoveResponse,
} from "#src/types/orchestrator";

const WORKTREE_FILE_STATUSES = new Set<string>([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
]);

function isWorktreeDiffFile(value: unknown): value is WorktreeDiffFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.path === "string" &&
    typeof file.status === "string" &&
    WORKTREE_FILE_STATUSES.has(file.status) &&
    (file.previousPath === undefined || typeof file.previousPath === "string")
  );
}

/**
 * Validate a tools-service diff response against the contract. Anything else
 * (an error, an older tools-service's `{hasChanges, diff}` shape) is null, and
 * a null diff never merges and never cleans up.
 */
export function parseWorktreeDiff(value: unknown): WorktreeDiff | null {
  if (!value || typeof value !== "object") return null;
  const diff = value as Record<string, unknown>;
  const stats = diff.stats as Record<string, unknown> | undefined;
  if (
    typeof diff.branch !== "string" ||
    typeof diff.base !== "string" ||
    typeof diff.patch !== "string" ||
    !Array.isArray(diff.files) ||
    !diff.files.every(isWorktreeDiffFile) ||
    !stats ||
    typeof stats.filesChanged !== "number" ||
    typeof stats.additions !== "number" ||
    typeof stats.deletions !== "number"
  ) {
    return null;
  }
  return {
    branch: diff.branch,
    base: diff.base,
    files: diff.files,
    patch: diff.patch,
    stats: {
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
    },
    ...(diff.patchTruncated === true && { patchTruncated: true }),
  };
}
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

export class GitWorktreeHelper {
  static getDefaultWorkspaceRoot(overrideRoot?: string): string {
    return (
      overrideRoot ||
      ToolOrchestratorService.getWorkspaceRoot() ||
      resolve(process.env.HOME || "/home")
    );
  }

  /**
   * Derive the git repository path from a sub-agent's file list.
   *
   * If files live under a git subdirectory of the workspace root
   * (e.g. /workspace/projectA/.git exists), return that subdirectory
   * as the repository path so worktrees branch from it.
   *
   * Falls back to workspaceRoot if no git repository is found.
   */
  static resolveRepositoryPath(workspaceRoot: string, files: string[]): string {
    if (!files?.length) return workspaceRoot;

    // Check if workspace root itself is a git repository
    if (existsSync(resolve(workspaceRoot, ".git"))) return workspaceRoot;

    // Take the first file, get its path relative to workspace root,
    // extract the first directory segment (the project dir)
    const firstFile = resolve(files[0]);
    const relativePath = relative(workspaceRoot, firstFile);
    const firstSegment = relativePath.split("/")[0];
    if (!firstSegment) return workspaceRoot;

    const candidate = resolve(workspaceRoot, firstSegment);
    if (existsSync(resolve(candidate, ".git"))) {
      return candidate;
    }

    return workspaceRoot;
  }

  static async toolsApiPost<T extends ToolsApiResponse>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    try {
      const response = await fetch(`${TOOLS_SERVICE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...traceHeaders() },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const errorMessage =
          typeof errorData.error === "string"
            ? errorData.error
            : `API returned ${response.status}`;
        // Keep the rest of the body: a refused merge names its conflicting
        // files, a refused remove says it kept the worktree.
        return { ...errorData, error: errorMessage } as unknown as T;
      }
      return (await response.json()) as T;
    } catch (error: unknown) {
      return {
        error: `Failed to reach tools-api: ${getErrorMessage(error)}`,
      } as unknown as T;
    }
  }

  static async createWorktree(
    repositoryPath: string,
    branchName: string,
  ): Promise<WorktreeCreateResponse> {
    return GitWorktreeHelper.toolsApiPost<WorktreeCreateResponse>(
      "/agentic/git/worktree/create",
      {
        path: repositoryPath,
        branch: branchName,
      },
    );
  }

  /** Stage and commit everything in a worktree (tools-service runs git by argv). */
  static async commitWorktree(
    repositoryPath: string,
    worktreePath: string,
    message: string,
  ): Promise<WorktreeCommitResponse> {
    return GitWorktreeHelper.toolsApiPost<WorktreeCommitResponse>(
      "/agentic/git/worktree/commit",
      {
        path: repositoryPath,
        worktreePath,
        message,
      },
    );
  }

  /**
   * Remove a worktree and delete its branch. tools-service refuses (and keeps
   * both) when that would lose work; `force` is for an explicit discard only.
   */
  static async removeWorktree(
    repositoryPath: string,
    worktreePath: string,
    options: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<WorktreeRemoveResponse> {
    return GitWorktreeHelper.toolsApiPost<WorktreeRemoveResponse>(
      "/agentic/git/worktree/remove",
      {
        path: repositoryPath,
        worktreePath,
        ...options,
      },
    );
  }

  static async getWorktreeDiff(
    repositoryPath: string,
    branchName: string,
  ): Promise<WorktreeDiff | { error: string }> {
    const response = await GitWorktreeHelper.toolsApiPost<ToolsApiResponse>(
      "/agentic/git/worktree/diff",
      {
        path: repositoryPath,
        branch: branchName,
      },
    );
    if (typeof response.error === "string") return { error: response.error };
    return (
      parseWorktreeDiff(response) ?? {
        error: `tools-service returned a diff outside the contract for '${branchName}'`,
      }
    );
  }

  static async mergeWorktree(
    repositoryPath: string,
    branchName: string,
    message: string,
  ): Promise<WorktreeMergeResponse> {
    return GitWorktreeHelper.toolsApiPost<WorktreeMergeResponse>(
      "/agentic/git/worktree/merge",
      {
        path: repositoryPath,
        branch: branchName,
        message,
      },
    );
  }

  static async cleanupWorktrees(
    repositoryPath: string,
  ): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost<ToolsApiResponse>(
      "/agentic/git/worktree/cleanup",
      {
        path: repositoryPath,
      },
    );
  }
}

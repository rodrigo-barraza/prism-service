import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { TOOLS_SERVICE_URL } from "../../../config.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import type {
  ToolsApiResponse,
  WorktreeCreateResponse,
  WorktreeDiff,
} from "../../types/coordinator.ts";
import logger from "../../utils/logger.ts";

export class GitWorktreeHelper {
  static getDefaultWorkspaceRoot(overrideRoot?: string): string {
    return (
      overrideRoot ||
      ToolOrchestratorService.getWorkspaceRoot() ||
      resolve(process.env.HOME || "/home")
    );
  }

  /**
   * Derive the git repo path from a worker's file list.
   *
   * If files live under a git subdirectory of the workspace root
   * (e.g. /workspace/projectA/.git exists), return that subdirectory
   * as the repo path so worktrees branch from it.
   *
   * Falls back to workspaceRoot if no git repo is found.
   */
  static resolveRepoPath(workspaceRoot: string, files: string[]): string {
    if (!files?.length) return workspaceRoot;

    // Check if workspace root itself is a git repo
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

  static async toolsApiPost(path: string, body: Record<string, unknown>): Promise<ToolsApiResponse> {
    try {
      const response = await fetch(`${TOOLS_SERVICE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as ToolsApiResponse;
        return { error: error.error || `API returned ${response.status}` };
      }
      return (await response.json()) as ToolsApiResponse;
    } catch (error: unknown) {
      return { error: `Failed to reach tools-api: ${(error as Error).message}` };
    }
  }

  static async createWorktree(repoPath: string, branchName: string): Promise<WorktreeCreateResponse> {
    return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/create", {
      path: repoPath,
      branch: branchName,
    }) as Promise<WorktreeCreateResponse>;
  }

  static async removeWorktree(repoPath: string, worktreePath: string): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/remove", {
      path: repoPath,
      worktreePath,
    });
  }

  static async getWorktreeDiff(repoPath: string, branchName: string): Promise<ToolsApiResponse & Partial<WorktreeDiff>> {
    return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/diff", {
      path: repoPath,
      branch: branchName,
    }) as Promise<ToolsApiResponse & Partial<WorktreeDiff>>;
  }

  static async mergeWorktree(repoPath: string, branchName: string, message: string): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/merge", {
      path: repoPath,
      branch: branchName,
      message,
    });
  }

  static async cleanupWorktrees(repoPath: string): Promise<ToolsApiResponse> {
    return GitWorktreeHelper.toolsApiPost("/agentic/git/worktree/cleanup", { path: repoPath });
  }
}

import logger from "#src/utils/logger";
import { createAbortController } from "#src/utils/AbortController";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { TOOLS_SERVICE_URL } from "#config";
import {
  DIRECTORY_CACHE_TIME_TO_LIVE_MILLISECONDS,
  DIRECTORY_FETCH_TIMEOUT_MILLISECONDS,
  DIRECTORY_TREE_CHILD_LIMIT,
} from "#src/constants";
import { type DirectoryData } from "./types.ts";

export class DirectoryTreeFormatter {
  private workspaceRoot: string;
  private _directoryCache: string | null = null;
  private _directoryCacheTime = 0;
  private _directoryCacheTTL: number;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this._directoryCacheTTL = DIRECTORY_CACHE_TIME_TO_LIVE_MILLISECONDS;
  }

  /**
   * Fetch project directory tree from tools-api.
   * Cached to avoid hammering the API.
   */
  async fetchDirectoryTree(): Promise<string> {
    const now = Date.now();
    if (
      this._directoryCache &&
      now - this._directoryCacheTime < this._directoryCacheTTL
    ) {
      return this._directoryCache;
    }

    try {
      const controller = createAbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        DIRECTORY_FETCH_TIMEOUT_MILLISECONDS,
      );

      const url = `${TOOLS_SERVICE_URL}/filesystem/list?path=${encodeURIComponent(this.workspaceRoot)}&depth=2`;
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn(
          `[SystemPromptAssembler] Directory fetch failed: ${response.status}`,
        );
        return "";
      }

      const data = (await response.json()) as DirectoryData;
      const tree = this._formatDirectoryTree(data);
      this._directoryCache = tree;
      this._directoryCacheTime = now;
      return tree;
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Directory fetch error: ${getErrorMessage(error)}`,
      );
      return this._directoryCache || "";
    }
  }

  private _formatDirectoryTree(data: DirectoryData): string {
    if (!data || !data.entries) return "";

    const lines: string[] = [];
    for (const entry of data.entries) {
      const prefix = entry.type === "directory" ? "📁" : "📄";
      const name = entry.name || entry.path;
      lines.push(`${prefix} ${name}`);

      // Include first-level children for directories
      if (entry.children && Array.isArray(entry.children)) {
        for (const child of entry.children.slice(0, DIRECTORY_TREE_CHILD_LIMIT)) {
          const childPrefix = child.type === "directory" ? "📁" : "📄";
          lines.push(`  ${childPrefix} ${child.name || child.path}`);
        }
        if (entry.children.length > DIRECTORY_TREE_CHILD_LIMIT) {
          lines.push(`  ... and ${entry.children.length - DIRECTORY_TREE_CHILD_LIMIT} more`);
        }
      }
    }

    return lines.join("\n");
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillFolderFile } from "./SkillFolderStore.ts";

// ────────────────────────────────────────────────────────────
// workspaceFolders — reading an import source from local disk
// ────────────────────────────────────────────────────────────
// The Claude config and plugin importers read the LOCAL filesystem, and
// only inside a registered workspace root (tools-service's list, cached by
// ToolOrchestratorService): an import copies what it reads into skill
// storage the agent can read back, so an unconfined path would let a
// request copy any file on this host there. The check is on the REAL
// path — a symlink inside a workspace that points out is refused.
//
// A folder is read bounded, and symlinks inside it are never followed:
// they are skipped and reported.
// ────────────────────────────────────────────────────────────

export interface FolderReadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const SKILL_FOLDER_LIMITS: FolderReadLimits = {
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

export const PLUGIN_FOLDER_LIMITS: FolderReadLimits = {
  maxFiles: 2_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

/** Never copied out of a source folder. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface SkippedPath {
  path: string;
  reason: string;
}

async function registeredWorkspaceRoots(): Promise<string[]> {
  const { default: ToolOrchestratorService } = await import(
    "#src/services/ToolOrchestratorService"
  );
  const roots = ToolOrchestratorService.getWorkspaceRoots();
  return Array.isArray(roots) ? roots.filter((root): root is string => typeof root === "string") : [];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The real path of `input` when it is a directory inside a registered
 * workspace root; otherwise why not.
 */
export async function resolveInsideRegisteredWorkspace(
  input: string,
): Promise<{ path: string } | { error: string; notFound?: true }> {
  const requested = path.resolve(input);
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch {
    return { error: `Workspace path not found: ${requested}`, notFound: true };
  }
  if (!(await fs.stat(real)).isDirectory()) {
    return { error: `Not a directory: ${requested}` };
  }

  const roots = await registeredWorkspaceRoots();
  if (roots.length === 0) {
    return {
      error: "No workspace is registered, so there is no registered workspace to import from. Add one under Settings → Workspaces.",
    };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(path.resolve(root));
    } catch {
      continue;
    }
    if (isWithin(realRoot, real)) return { path: real };
  }
  return {
    error: `${requested} is not inside a registered workspace (${roots.join(", ")}). Import from a folder under one of them.`,
  };
}

/**
 * Every regular file under `root`, relative `/` paths in byte order.
 * Symlinks and special files are skipped; too many or too large is an error.
 */
export async function readLocalFolder(
  root: string,
  limits: FolderReadLimits,
): Promise<{ files: SkillFolderFile[]; skipped: SkippedPath[] } | { error: string }> {
  const files: SkillFolderFile[] = [];
  const skipped: SkippedPath[] = [];
  let totalBytes = 0;

  async function walk(directory: string): Promise<string | null> {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: "symbolic link (not followed)" });
      } else if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const failure = await walk(absolute);
        if (failure) return failure;
      } else if (entry.isFile()) {
        const { size } = await fs.stat(absolute);
        if (size > limits.maxFileBytes) {
          skipped.push({ path: relative, reason: `larger than ${limits.maxFileBytes} bytes` });
          continue;
        }
        if (files.length + 1 > limits.maxFiles) {
          return `${root} holds more than ${limits.maxFiles} files`;
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {
          return `${root} holds more than ${limits.maxTotalBytes} bytes`;
        }
        files.push({ path: relative, content: await fs.readFile(absolute) });
      } else {
        skipped.push({ path: relative, reason: "not a regular file" });
      }
    }
    return null;
  }

  const failure = await walk(root);
  return failure ? { error: failure } : { files, skipped };
}

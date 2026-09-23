/**
 * ScratchWorkspace — a fresh directory per run of a dataset case, where the
 * agent's file tools work and a file_exists grader looks afterwards.
 *
 * Files live where the tools run — tools-service's filesystem, or a
 * workspace agent it routes to — so every step is one of the file tools the
 * agent itself calls: write_file makes the directory (its parents with it)
 * and the case's seed files; get_file_info / find_files / read_file answer
 * the grader; delete_file (recursive) removes the directory. The directory
 * sits under a registered workspace root, and tools-service accepts any
 * path under a root as the workspace root of a request, so the run's
 * relative paths resolve inside it.
 */
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";

/** Every scratch workspace lives under this directory of the workspace root. */
export const SCRATCH_DIRECTORY = ".prism-benchmarks";
const MARKER_FILE = ".benchmark-workspace";
/** read_file prefixes each line with `<line>:<hash>|` (tools-service hashlines). */
const HASHLINE_PREFIX = /^\d+:[0-9a-z]{4}\|/gm;
const GLOB_CHARACTERS = /[*?[\]{}]/;

export interface ScratchWorkspace {
  /** Absolute path of the directory — the run's workspace root. */
  root: string;
}

export interface WorkspaceIdentity {
  project: string | null;
  username: string;
}

/**
 * A relative path that stays inside the workspace: no leading slash, no
 * `..` segment, no empty segments. Returns the normalised path or null.
 */
export function normaliseWorkspacePath(path: string): string | null {
  const trimmed = path.trim().replace(/^\.\/+/, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return null;
  return segments.join("/");
}

function errorOf(result: unknown): string | null {
  if (!result || typeof result !== "object") return "no result";
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && error ? error : null;
}

function toolContext(workspaceRoot: string, identity: WorkspaceIdentity) {
  return {
    workspaceRoot,
    ...(identity.project && { project: identity.project }),
    username: identity.username,
  };
}

const pathSafe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Make the directory for one run of one case and write its seed files.
 * `baseRoot`: a registered workspace root (default: tools-service's first).
 */
export async function createScratchWorkspace({
  baseRoot,
  runId,
  caseId,
  trial,
  files,
  identity,
}: {
  baseRoot?: string | null;
  runId: string;
  caseId: string;
  trial: number;
  files?: Record<string, string>;
  identity: WorkspaceIdentity;
}): Promise<ScratchWorkspace> {
  const base = baseRoot || ToolOrchestratorService.getWorkspaceRoot();
  if (!base) {
    throw new Error(
      "No workspace root for the scratch workspace: the dataset names none and tools-service reports none",
    );
  }
  const root = `${base.replace(/\/+$/, "")}/${SCRATCH_DIRECTORY}/${pathSafe(runId)}/${pathSafe(caseId)}-${trial}`;
  const marker = await ToolOrchestratorService.executeTool(
    TOOL_NAMES.WRITE_FILE,
    { path: `${root}/${MARKER_FILE}`, content: `${runId} ${caseId} ${trial}\n` },
    toolContext(base, identity),
  );
  const markerError = errorOf(marker);
  if (markerError) {
    throw new Error(`Could not create the scratch workspace ${root}: ${markerError}`);
  }
  for (const [path, content] of Object.entries(files ?? {})) {
    const relativePath = normaliseWorkspacePath(path);
    if (!relativePath) throw new Error(`Seed file path escapes the workspace: ${path}`);
    const written = await ToolOrchestratorService.executeTool(
      TOOL_NAMES.WRITE_FILE,
      { path: `${root}/${relativePath}`, content },
      toolContext(root, identity),
    );
    const writeError = errorOf(written);
    if (writeError) throw new Error(`Could not seed ${relativePath}: ${writeError}`);
  }
  return { root };
}

/**
 * The files in the workspace matching `pattern` (relative paths): a glob
 * goes through find_files, a plain path through get_file_info.
 */
export async function findWorkspaceFiles(
  workspace: ScratchWorkspace,
  pattern: string,
  identity: WorkspaceIdentity,
): Promise<string[]> {
  const relativePattern = normaliseWorkspacePath(pattern);
  if (!relativePattern) throw new Error(`Path escapes the workspace: ${pattern}`);
  const context = toolContext(workspace.root, identity);
  if (GLOB_CHARACTERS.test(relativePattern)) {
    const result = (await ToolOrchestratorService.executeTool(
      TOOL_NAMES.FIND_FILES,
      { pattern: relativePattern, searchPath: workspace.root },
      context,
    )) as { error?: string; matches?: Array<{ relativePath?: string; path?: string }> };
    const findError = errorOf(result);
    if (findError) throw new Error(`find_files failed: ${findError}`);
    return (result.matches ?? [])
      .map((match) => match.relativePath ?? match.path?.slice(workspace.root.length + 1) ?? "")
      .filter((path) => path && !path.endsWith(MARKER_FILE));
  }
  const info = (await ToolOrchestratorService.executeTool(
    TOOL_NAMES.GET_FILE_INFO,
    { path: `${workspace.root}/${relativePattern}` },
    context,
  )) as { exists?: boolean; isFile?: boolean; error?: string };
  return info?.exists && info.isFile !== false ? [relativePattern] : [];
}

/** A workspace file's text, without read_file's line prefixes (null when unreadable). */
export async function readWorkspaceFile(
  workspace: ScratchWorkspace,
  relativePath: string,
  identity: WorkspaceIdentity,
): Promise<string | null> {
  const result = (await ToolOrchestratorService.executeTool(
    TOOL_NAMES.READ_FILE,
    { path: `${workspace.root}/${relativePath}` },
    toolContext(workspace.root, identity),
  )) as { content?: unknown; error?: string };
  if (errorOf(result) || typeof result.content !== "string") return null;
  return result.content.replace(HASHLINE_PREFIX, "");
}

/** Remove the directory. Best-effort: a leftover scratch directory costs nothing but disk. */
export async function removeScratchWorkspace(
  workspace: ScratchWorkspace,
  identity: WorkspaceIdentity,
): Promise<void> {
  try {
    await ToolOrchestratorService.executeTool(
      TOOL_NAMES.DELETE_FILE,
      { path: workspace.root, recursive: true },
      toolContext(workspace.root, identity),
    );
  } catch {
    /* best-effort */
  }
}

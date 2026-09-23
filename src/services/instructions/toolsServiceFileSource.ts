import path from "node:path";
import { WORKSPACE_MAX_LINES_PER_READ } from "@rodrigo-barraza/utilities-library/workspace";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/service";
import { TOOLS_SERVICE_URL } from "#config";
import { traceHeaders } from "#src/services/Tracing";
import type { FileStat, WorkspaceFileSource } from "./WorkspaceInstructions.ts";

// ────────────────────────────────────────────────────────────
// toolsServiceFileSource — workspace files as the agent's tools see them
// ────────────────────────────────────────────────────────────
// tools-service stats, lists and reads the workspace on the machine it is
// on, or routes a path to the workspace agent serving it — the same files
// read_file sees. Its read endpoints number every line: tools-service with
// hashline anchors (`12:ab3f|text`), a workspace agent as `12: text`. The
// line number is known for every line of a page, so the prefix is removed
// exactly and the text comes back byte for byte (CR and all).
// ────────────────────────────────────────────────────────────

/** tools-service's cap on paths per /file/info and files per /file/read-multi. */
const BATCH_LIMIT = 20;
const REQUEST_TIMEOUT_MILLISECONDS = 8_000;
/** Rule folders are listed this deep. */
const LIST_MAX_DEPTH = 3;

interface RawStat {
  path?: unknown;
  exists?: unknown;
  isFile?: unknown;
  isDirectory?: unknown;
  sizeBytes?: unknown;
  lastModified?: unknown;
  lines?: unknown;
}

interface RawRead {
  content?: unknown;
  startLine?: unknown;
  error?: unknown;
}

export interface ToolsServiceFileSourceOptions {
  baseUrl?: string;
  /** A worktree session's path: the tools-service sandbox admits it only with this header. */
  workspaceOverride?: string | null;
  fetchImplementation?: typeof fetch;
  timeoutMilliseconds?: number;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/**
 * The text of one numbered page: each line loses its `N:hash|` (hashline)
 * or `N: ` (workspace agent) prefix, N counting up from `startLine`.
 */
export function stripLineNumbers(content: string, startLine: number): string | null {
  const lines = content.split("\n");
  const out: string[] = [];
  for (const [index, line] of lines.entries()) {
    const prefix = `${startLine + index}:`;
    if (!line.startsWith(prefix)) return null;
    const rest = line.slice(prefix.length);
    if (rest.startsWith(" ")) out.push(rest.slice(1));
    else if (/^[0-9a-z]{4}\|/.test(rest)) out.push(rest.slice(5));
    else return null;
  }
  return out.join("\n");
}

function missing(requested: string): FileStat {
  return {
    path: requested,
    exists: false,
    isFile: false,
    isDirectory: false,
    sizeBytes: 0,
    lastModified: "",
    lines: null,
    realPath: requested,
  };
}

function toStat(requested: string, raw: RawStat | undefined): FileStat {
  if (!raw || raw.exists !== true) return missing(requested);
  return {
    path: requested,
    exists: true,
    isFile: raw.isFile === true,
    isDirectory: raw.isDirectory === true,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0,
    lastModified: typeof raw.lastModified === "string" ? raw.lastModified : "",
    lines: typeof raw.lines === "number" ? raw.lines : null,
    realPath: typeof raw.path === "string" && raw.path ? raw.path : requested,
  };
}

export function createToolsServiceFileSource({
  baseUrl = TOOLS_SERVICE_URL as string,
  workspaceOverride = null,
  fetchImplementation = fetch,
  timeoutMilliseconds = REQUEST_TIMEOUT_MILLISECONDS,
}: ToolsServiceFileSourceOptions = {}): WorkspaceFileSource {
  async function post(route: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...traceHeaders(),
    };
    if (workspaceOverride) headers[IDENTITY_HEADERS.workspaceOverride] = workspaceOverride;
    const response = await fetchImplementation(`${baseUrl}/agentic${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    // A single-path stat that fails validation comes back 400 with the
    // entry itself; everything else that is not 2xx is a failure.
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok && !(payload && typeof payload === "object" && "path" in payload)) {
      throw new Error(`tools-service ${route} answered ${response.status}`);
    }
    return payload;
  }

  return {
    async stat(paths) {
      const stats: FileStat[] = [];
      for (const batch of chunks(paths, BATCH_LIMIT)) {
        const payload = (await post("/file/info", { paths: batch })) as
          | { results?: RawStat[] }
          | RawStat
          | null;
        // One path comes back as its entry, several as { results } in order.
        const entries =
          batch.length === 1
            ? [payload as RawStat]
            : Array.isArray((payload as { results?: RawStat[] })?.results)
              ? (payload as { results: RawStat[] }).results
              : [];
        batch.forEach((requested, index) => stats.push(toStat(requested, entries[index])));
      }
      return stats;
    },

    async listFiles(directory) {
      const payload = (await post("/directory/list", {
        path: directory,
        recursive: true,
        maxDepth: LIST_MAX_DEPTH,
      })) as { entries?: Array<{ path?: unknown; isDir?: unknown }> };
      // Entries are relative to the listed directory: report them under the
      // path that was asked for, not the one a symlink resolved to.
      return (Array.isArray(payload?.entries) ? payload.entries : [])
        .filter((entry) => entry.isDir !== true && typeof entry.path === "string")
        .map((entry) => path.posix.join(directory, entry.path as string));
    },

    async read(files) {
      const pages = files.flatMap(({ path: filePath, lines }) => {
        const count = Math.max(1, lines);
        const filePages: Array<{ path: string; startLine: number; endLine: number }> = [];
        for (let start = 1; start <= count; start += WORKSPACE_MAX_LINES_PER_READ) {
          filePages.push({
            path: filePath,
            startLine: start,
            endLine: Math.min(count, start + WORKSPACE_MAX_LINES_PER_READ - 1),
          });
        }
        return filePages;
      });
      const pageTexts = new Map<string, string[]>();
      const failed = new Set<string>();
      for (const batch of chunks(pages, BATCH_LIMIT)) {
        let results: RawRead[] = [];
        try {
          const payload = (await post("/file/read-multi", {
            files: batch.map((page) => ({
              absolutePath: page.path,
              startLine: page.startLine,
              endLine: page.endLine,
            })),
          })) as { results?: RawRead[] } | null;
          if (Array.isArray(payload?.results)) results = payload.results;
        } catch {
          // Every page of this batch reads as failed below.
        }
        batch.forEach((page, index) => {
          const result = results[index];
          const text =
            result && typeof result.content === "string" && typeof result.error !== "string"
              ? stripLineNumbers(
                  result.content,
                  typeof result.startLine === "number" ? result.startLine : page.startLine,
                )
              : null;
          if (text === null) {
            failed.add(page.path);
            return;
          }
          const parts = pageTexts.get(page.path) ?? [];
          parts.push(text);
          pageTexts.set(page.path, parts);
        });
      }
      const texts = new Map<string, string>();
      for (const [filePath, parts] of pageTexts) {
        if (!failed.has(filePath)) texts.set(filePath, parts.join("\n"));
      }
      return texts;
    },
  };
}

import fs from "node:fs";
import path from "node:path";

/**
 * tools-service's workspace file endpoints over a local directory tree, as
 * `fetch` — the contract the production source (toolsServiceFileSource.ts)
 * speaks, served from real files with real mtimes:
 *   POST /agentic/file/info       one path → its entry; several → { results }
 *   POST /agentic/directory/list  { directory, entries: [{ path (relative), isDir }] }
 *   POST /agentic/file/read-multi { results: [{ content: hashlines | `N: text` }] }
 * `format: "agent"` numbers lines the way a workspace agent does (`12: text`).
 */
export interface FakeToolsService {
  fetch: typeof fetch;
  calls: Array<{ route: string; body: Record<string, unknown> }>;
}

/** tools-service's line hash (utilities/hashline.ts): FNV-1a, base36, 4 chars. */
function lineHash(line: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < line.length; index++) {
    hash ^= line.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(4, "0").slice(0, 4);
}

function entryFor(requested: string) {
  try {
    const real = fs.realpathSync(requested);
    const stats = fs.statSync(real);
    const entry: Record<string, unknown> = {
      path: real,
      exists: true,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      sizeBytes: stats.size,
      lastModified: stats.mtime.toISOString(),
    };
    if (stats.isFile()) entry.lines = fs.readFileSync(real, "utf8").split("\n").length;
    return entry;
  } catch {
    return { path: requested, exists: false };
  }
}

function listRecursive(root: string, directory: string, depth: number, maxDepth: number, out: unknown[]) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    out.push({ name: entry.name, path: path.relative(root, absolute), isDir: entry.isDirectory() });
    if (entry.isDirectory() && depth < maxDepth) listRecursive(root, absolute, depth + 1, maxDepth, out);
  }
}

export function fakeToolsService({ format = "hashline" }: { format?: "hashline" | "agent" } = {}): FakeToolsService {
  const calls: FakeToolsService["calls"] = [];
  const json = (body: unknown, status = 200) =>
    ({ ok: status < 300, status, json: async () => body }) as Response;

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = String(url).replace(/^.*\/agentic/, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ route, body });

    if (route === "/file/info") {
      const paths = body.paths as string[];
      if (paths.length === 1) return json(entryFor(paths[0]!));
      return json({ totalRequested: paths.length, results: paths.map(entryFor) });
    }
    if (route === "/directory/list") {
      const directory = fs.realpathSync(body.path as string);
      const entries: unknown[] = [];
      listRecursive(directory, directory, 1, Number(body.maxDepth ?? 3), entries);
      return json({ directory, totalEntries: entries.length, entries });
    }
    if (route === "/file/read-multi") {
      const files = body.files as Array<{ absolutePath: string; startLine: number; endLine: number }>;
      return json({
        results: files.map((file) => {
          const lines = fs.readFileSync(file.absolutePath, "utf8").split("\n");
          const end = Math.min(lines.length, file.endLine, file.startLine + 799);
          const selected = lines.slice(file.startLine - 1, end);
          const content = selected
            .map((text, index) => {
              const number = file.startLine + index;
              return format === "agent" ? `${number}: ${text}` : `${number}:${lineHash(text)}|${text}`;
            })
            .join("\n");
          return { absolutePath: file.absolutePath, filePath: file.absolutePath, totalLines: lines.length, startLine: file.startLine, endLine: end, content };
        }),
      });
    }
    return json({ error: `unknown route ${route}` }, 404);
  }) as typeof fetch;

  return { fetch: fakeFetch, calls };
}

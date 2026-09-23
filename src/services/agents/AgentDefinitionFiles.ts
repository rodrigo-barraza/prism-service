import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { deriveAgentId } from "@rodrigo-barraza/utilities-library";
import {
  normalizeAgentDefinitionFields,
  type AgentDefinitionFields,
} from "./AgentDefinitionFields.ts";

// ────────────────────────────────────────────────────────────
// AgentDefinitionFiles — custom agents defined as Markdown files
// ────────────────────────────────────────────────────────────
// `<workspace root>/.prism/agents/*.md` and `<workspace root>/.claude/agents/*.md`
// (Claude Code's format): YAML frontmatter holds the fields
// (AgentDefinitionFields plus `name`, `color`, `icon`), the Markdown body is
// the agent's system prompt. Every workspace root is scanned; within a root
// `.prism/agents` outranks `.claude/agents`, and an earlier root outranks a
// later one. A file is re-parsed only when its mtime or size changes.
//
// Frontmatter keys Prism does not know (`hooks`, `mcpServers`, `skills`, …)
// are ignored — a workspace file never gets to run commands or connect
// servers through its agent definition.
//
// Reads the LOCAL filesystem, like ClaudeConfigImportService.
// ────────────────────────────────────────────────────────────

/** Scanned in this order: the first definition of an agent id wins. */
export const AGENT_DEFINITION_DIRECTORIES = [".prism/agents", ".claude/agents"] as const;

/** One parsed agent file. */
export interface AgentDefinitionFile {
  agentId: string;
  name: string;
  /** The Markdown body — the agent's system prompt. */
  prompt: string;
  fields: AgentDefinitionFields;
  color?: string;
  icon?: string;
  path: string;
}

export interface AgentDefinitionFileError {
  path: string;
  error: string;
}

/** A definition hidden by an earlier one with the same agent id. */
export interface ShadowedAgentDefinitionFile {
  path: string;
  agentId: string;
  shadowedBy: string;
}

export interface AgentDefinitionFileScan {
  definitions: AgentDefinitionFile[];
  errors: AgentDefinitionFileError[];
  shadowed: ShadowedAgentDefinitionFile[];
  /** False when nothing on disk moved since the previous scan. */
  changed: boolean;
}

type ParseResult = { definition: AgentDefinitionFile } | { error: string };

const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Claude Code's own agent files often carry a plain scalar with a colon in
 * it (`description: Use this agent when: …`), which strict YAML rejects.
 * Quote such top-level values and try once more — the same leniency Claude
 * Code applies. Anything else that fails to parse is reported as-is.
 */
export function quoteAmbiguousScalars(frontmatter: string): string {
  return frontmatter
    .split("\n")
    .map((line) => {
      const match = /^([A-Za-z_][\w-]*):[ \t]+(.+?)\s*$/.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      if (/^["'[{|>&*!]/.test(value)) return line;
      if (!value.includes(": ") && !value.includes(" #")) return line;
      return `${key}: ${JSON.stringify(value)}`;
    })
    .join("\n");
}

function describeYamlError(error: unknown): string {
  if (error instanceof YAMLParseError) {
    const position = error.linePos?.[0];
    const where = position ? ` at line ${position.line}, column ${position.col}` : "";
    return `invalid YAML frontmatter${where}: ${error.message.split("\n")[0]}`;
  }
  return `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`;
}

function parseFrontmatterYaml(frontmatter: string): { value: unknown } | { error: string } {
  try {
    return { value: parseYaml(frontmatter) };
  } catch (firstError: unknown) {
    const lenient = quoteAmbiguousScalars(frontmatter);
    if (lenient !== frontmatter) {
      try {
        return { value: parseYaml(lenient) };
      } catch {
        /* report the original error — it points at the author's text */
      }
    }
    return { error: describeYamlError(firstError) };
  }
}

/**
 * Parse one agent file. Never throws: a file that cannot become an agent
 * comes back as `{ error }` naming what to fix.
 */
export function parseAgentDefinitionFile(content: string, filePath: string): ParseResult {
  const match = FRONTMATTER_PATTERN.exec(content.replace(/^\uFEFF/, ""));
  if (!match) {
    return { error: "missing YAML frontmatter — the file must start with a `---` block" };
  }
  const parsed = parseFrontmatterYaml(match[1]);
  if ("error" in parsed) return parsed;
  const frontmatter = parsed.value ?? {};
  if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { error: "the frontmatter must be a mapping of `key: value` fields" };
  }
  const raw = frontmatter as Record<string, unknown>;

  const rawName = raw.name ?? path.basename(filePath, path.extname(filePath));
  if (typeof rawName !== "string" && typeof rawName !== "number") {
    return { error: "name must be a string" };
  }
  const name = String(rawName).trim();
  const agentId = deriveAgentId(name);
  if (!name || agentId === "CUSTOM_") {
    return { error: `name ${JSON.stringify(rawName)} has no letters or digits` };
  }

  const { fields, errors } = normalizeAgentDefinitionFields(raw);
  if (!fields.description) {
    errors.unshift("description is required — it is how the orchestrator decides when to use this agent");
  }
  if (errors.length > 0) return { error: errors.join("; ") };

  return {
    definition: {
      agentId,
      name,
      prompt: content.slice(match.index + match[0].length).trim(),
      fields,
      ...(typeof raw.color === "string" && raw.color.trim() && { color: raw.color.trim() }),
      ...(typeof raw.icon === "string" && raw.icon.trim() && { icon: raw.icon.trim() }),
      path: filePath,
    },
  };
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  result: ParseResult;
}

function listMarkdownFiles(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch {
    return []; // no such directory (the common case) or unreadable
  }
}

/**
 * The agent files under a set of workspace roots, cached by mtime. `scan()`
 * is synchronous (the persona registry's lookups are) and throttled: within
 * `minimumScanIntervalMilliseconds` of the last scan it returns that scan.
 */
export class AgentDefinitionFileCache {
  private readonly files = new Map<string, CachedFile>();
  private lastScanAt = 0;
  private lastSignature = "";
  private lastScan: AgentDefinitionFileScan = { definitions: [], errors: [], shadowed: [], changed: false };
  private readonly roots: () => readonly string[];
  private readonly minimumScanIntervalMilliseconds: number;
  private readonly onParsed?: (filePath: string, result: ParseResult) => void;

  constructor(
    roots: () => readonly string[],
    minimumScanIntervalMilliseconds = 1_000,
    onParsed?: (filePath: string, result: ParseResult) => void,
  ) {
    this.roots = roots;
    this.minimumScanIntervalMilliseconds = minimumScanIntervalMilliseconds;
    this.onParsed = onParsed;
  }

  scan({ force = false }: { force?: boolean } = {}): AgentDefinitionFileScan {
    const now = Date.now();
    if (!force && this.lastScanAt > 0 && now - this.lastScanAt < this.minimumScanIntervalMilliseconds) {
      return { ...this.lastScan, changed: false };
    }
    this.lastScanAt = now;

    const roots = [...new Set(this.roots().filter((root) => typeof root === "string" && root.trim()))];
    const seen = new Set<string>();
    const signatureParts: string[] = [];
    const definitions: AgentDefinitionFile[] = [];
    const errors: AgentDefinitionFileError[] = [];
    const shadowed: ShadowedAgentDefinitionFile[] = [];
    const firstPathById = new Map<string, string>();

    for (const root of roots) {
      for (const relativeDirectory of AGENT_DEFINITION_DIRECTORIES) {
        for (const filePath of listMarkdownFiles(path.join(root, relativeDirectory))) {
          let stats: fs.Stats;
          try {
            stats = fs.statSync(filePath);
          } catch {
            continue; // removed between readdir and stat
          }
          seen.add(filePath);
          signatureParts.push(`${filePath}:${stats.mtimeMs}:${stats.size}`);

          let cached = this.files.get(filePath);
          if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
            let result: ParseResult;
            try {
              result = parseAgentDefinitionFile(fs.readFileSync(filePath, "utf-8"), filePath);
            } catch (error: unknown) {
              result = { error: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
            }
            cached = { mtimeMs: stats.mtimeMs, size: stats.size, result };
            this.files.set(filePath, cached);
            this.onParsed?.(filePath, result);
          }

          if ("error" in cached.result) {
            errors.push({ path: filePath, error: cached.result.error });
            continue;
          }
          const { definition } = cached.result;
          const earlierPath = firstPathById.get(definition.agentId);
          if (earlierPath) {
            shadowed.push({ path: filePath, agentId: definition.agentId, shadowedBy: earlierPath });
            continue;
          }
          firstPathById.set(definition.agentId, filePath);
          definitions.push(definition);
        }
      }
    }

    for (const cachedPath of [...this.files.keys()]) {
      if (!seen.has(cachedPath)) this.files.delete(cachedPath);
    }

    const signature = signatureParts.join("\n");
    const changed = signature !== this.lastSignature;
    this.lastSignature = signature;
    this.lastScan = { definitions, errors, shadowed, changed };
    return this.lastScan;
  }
}

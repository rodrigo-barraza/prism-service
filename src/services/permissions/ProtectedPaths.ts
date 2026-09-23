import { canonicalValues, splitShellCommand, type MatchableCall } from "./PermissionMatcher.ts";
import type { Capability } from "./types.ts";

/**
 * ProtectedPaths — writes that always ask.
 *
 * Repository state, secrets and the configuration that steers the agent:
 *
 *   - `.git`                 the repository itself (objects, hooks, config)
 *   - `.env*`                secrets (`.env`, `.env.local`, `.envrc`, …)
 *   - Prism configuration    `.prism/`, `.claude/` (agent definitions and
 *                            rules a workspace hands the agent — except
 *                            `.claude/worktrees`, which holds checkouts),
 *                            `PRISM.md`, `.mcp.json`
 *
 * No mode runs such a write without a person: `acceptEdits`, `auto`,
 * `bypass`, an allow rule and the legacy "approve all" all still ask, and a
 * run that cannot ask (`dontAsk`, unattended) denies it. Only a human's yes
 * on the card lets it through.
 *
 * File tools are judged by the paths they name. A shell command is judged by
 * its words: any word that names a protected path makes the call ask — a
 * tripwire for `rm -rf .git` or `echo KEY=… > .env`, not a parser. Code
 * handed to an interpreter is not inspected.
 */

const PROTECTED_DIRECTORIES = new Set([".git", ".prism", ".claude"]);
/** Files by name — plus `.env*`. (A worktree's `.git` is a file; the directory set covers it.) */
const PROTECTED_FILES = new Set(["PRISM.md", ".mcp.json"]);
/** `.claude/<this>` is not configuration. */
const UNPROTECTED_CLAUDE_CHILDREN = new Set(["worktrees"]);

export interface ProtectedPathHit {
  /** The path (or shell word) that names it. */
  path: string;
  /** What it is: `.git`, `.env*` or `Prism configuration`. */
  target: string;
}

function targetOf(name: string): string {
  if (name === ".git") return ".git";
  if (name.startsWith(".env")) return ".env*";
  return "Prism configuration";
}

/** What protected thing `rawPath` names, or `null`. */
export function protectedTargetOf(rawPath: string): string | null {
  const segments = rawPath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    if (PROTECTED_DIRECTORIES.has(segment)) {
      // `.claude/worktrees/<checkout>/…` is a checkout: keep looking inside it.
      if (segment === ".claude" && UNPROTECTED_CLAUDE_CHILDREN.has(segments[index + 1])) {
        index++;
        continue;
      }
      return targetOf(segment);
    }
    if (isLast && (PROTECTED_FILES.has(segment) || segment.startsWith(".env"))) {
      return targetOf(segment);
    }
  }
  return null;
}

/** Shell words, unquoted, with redirections and `--flag=` prefixes taken off. */
function shellWords(command: string): string[] {
  const split = splitShellCommand(command);
  const segments = split ? split.segments : [command];
  const words: string[] = [];
  for (const segment of segments) {
    for (const raw of segment.split(/\s+/)) {
      const word = raw.replace(/^[0-9]*[<>&|]+/, "").replace(/^["']|["']$/g, "");
      if (!word) continue;
      words.push(word);
      const assigned = word.split("=").slice(1).join("=");
      if (assigned) words.push(assigned.replace(/^["']|["']$/g, ""));
    }
  }
  return words;
}

/**
 * The protected path a call would write, or `null`. Reads are not writes:
 * only calls that can write files (`fs_write`) or run a shell are checked.
 */
export function findProtectedPathWrite(
  call: MatchableCall,
  capabilities: readonly Capability[],
): ProtectedPathHit | null {
  const canonical = canonicalValues(call);
  if (canonical.kind === "path" && capabilities.includes("fs_write")) {
    for (const value of canonical.values) {
      const target = protectedTargetOf(value);
      if (target) return { path: value, target };
    }
    return null;
  }
  if (canonical.kind === "command" && capabilities.includes("shell")) {
    for (const value of canonical.values) {
      for (const word of shellWords(value)) {
        const target = protectedTargetOf(word);
        if (target) return { path: word, target };
      }
    }
  }
  return null;
}

import path from "node:path";
import {
  compileGlob,
  isInvalidPattern,
  type ArgumentPattern,
  type GlobFlavor,
  type ParsedRule,
} from "./PermissionRuleSyntax.ts";
import type { Capability, PermissionDecision } from "./types.ts";

/**
 * PermissionMatcher — does one parsed rule match one tool call?
 *
 * The asymmetry that runs through this file: an ALLOW rule must match
 * EVERYTHING the call would do, a DENY or ASK rule matches if it touches
 * ANYTHING. Concretely:
 *
 *   - A shell command is split on `;` `&&` `||` `|` `&` and newlines. Allow
 *     needs every segment to match; deny needs one segment, or the whole
 *     command. A command with substitution (`$(…)`, backticks, `<(…)`) is
 *     never allowed by a pattern — there is no telling what it runs.
 *   - A call with several paths (`move_file`, `read_files`) is allowed only
 *     if every path matches, denied if one does.
 *   - Paths are normalized before matching (`src/../../x` is `../x`), and an
 *     allow pattern that doesn't itself mention `..` or an absolute root
 *     never matches a path that escapes the workspace. A deny pattern is
 *     also tried against the absolute form of an in-workspace path.
 *
 * Anything this file cannot interpret resolves toward the safe side.
 */

export interface MatchableCall {
  name: string;
  args: Record<string, unknown>;
}

type ValueKind = "command" | "path" | "text";

interface CanonicalSpec {
  kind: ValueKind;
  /** Argument names read, in order; array arguments contribute every element. */
  arguments: string[];
}

const SHELL_COMMAND: CanonicalSpec = { kind: "command", arguments: ["command"] };
const CODE: CanonicalSpec = { kind: "text", arguments: ["code", "script"] };
const URL_ARGUMENT: CanonicalSpec = { kind: "text", arguments: ["url"] };

/** The canonical value of a tool call, per tool. */
const CANONICAL: Record<string, CanonicalSpec> = {
  execute_shell: SHELL_COMMAND,
  execute_command: SHELL_COMMAND,
  execute_python: CODE,
  execute_javascript: CODE,
  execute_browser_script: CODE,

  read_file: { kind: "path", arguments: ["absolutePath", "path"] },
  read_files: { kind: "path", arguments: ["files"] },
  write_file: { kind: "path", arguments: ["path"] },
  replace_in_file: { kind: "path", arguments: ["path"] },
  apply_patch: { kind: "path", arguments: ["path"] },
  delete_file: { kind: "path", arguments: ["path"] },
  edit_notebook: { kind: "path", arguments: ["path"] },
  list_directory: { kind: "path", arguments: ["path"] },
  get_file_info: { kind: "path", arguments: ["path", "paths"] },
  summarize_project: { kind: "path", arguments: ["path"] },
  run_git: { kind: "path", arguments: ["path"] },
  move_file: { kind: "path", arguments: ["source", "destination"] },
  search_file_contents: { kind: "path", arguments: ["searchPath"] },
  find_files: { kind: "path", arguments: ["searchPath"] },
  code_intel: { kind: "path", arguments: ["filePath"] },

  read_web_page: URL_ARGUMENT,
  read_url: URL_ARGUMENT,
  read_pdf: URL_ARGUMENT,
  read_docx: URL_ARGUMENT,
  read_spreadsheet: URL_ARGUMENT,
  http_headers: URL_ARGUMENT,
  send_webhook: URL_ARGUMENT,
  control_browser: URL_ARGUMENT,
  search_web: { kind: "text", arguments: ["query"] },
};

/** Named arguments that hold paths, so `name=pattern` uses path semantics. */
const PATH_ARGUMENT_NAMES = new Set([
  "path",
  "paths",
  "absolutePath",
  "filePath",
  "searchPath",
  "source",
  "destination",
  "files",
  "cwd",
]);

/** Primary path key inside object elements of an array argument (`read_files`). */
const NESTED_PATH_KEYS = ["absolutePath", "path", "filePath"];

function stringsOf(value: unknown, preferPathKeys: boolean): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((element) => stringsOf(element, preferPathKeys));
  }
  if (typeof value === "object") {
    if (preferPathKeys) {
      for (const key of NESTED_PATH_KEYS) {
        const nested = (value as Record<string, unknown>)[key];
        if (typeof nested === "string") return [nested];
      }
    }
    return [stableJson(value)];
  }
  return [];
}

/** JSON with sorted keys, so the same arguments always read the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface CanonicalValues {
  kind: ValueKind;
  values: string[];
}

/**
 * The value(s) a pattern without `name=` is tested against. Tools without a
 * canonical spec are matched on their arguments as compact, key-sorted JSON.
 */
export function canonicalValues(call: MatchableCall): CanonicalValues {
  const spec = CANONICAL[call.name];
  if (!spec) return { kind: "text", values: [stableJson(call.args ?? {})] };
  const values: string[] = [];
  for (const argumentName of spec.arguments) {
    values.push(...stringsOf(call.args?.[argumentName], spec.kind === "path"));
  }
  if (spec.kind === "command" && typeof call.args?.command === "string") {
    // `execute_command` may pass argv separately; match the full line.
    const extra = stringsOf(call.args?.args, false);
    if (extra.length > 0) values[0] = `${values[0]} ${extra.join(" ")}`;
  }
  return { kind: spec.kind, values };
}

function namedValues(call: MatchableCall, argumentName: string): CanonicalValues {
  const isPath = PATH_ARGUMENT_NAMES.has(argumentName);
  const kind: ValueKind = isPath ? "path" : argumentName === "command" ? "command" : "text";
  return { kind, values: stringsOf(call.args?.[argumentName], isPath) };
}

// ── Paths ─────────────────────────────────────────────────────────

const WINDOWS_DRIVE = /^[A-Za-z]:\//;

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || WINDOWS_DRIVE.test(value);
}

export interface NormalizedPath {
  /** Relative to the workspace when inside it, otherwise absolute/as given. */
  display: string;
  /** Absolute form when resolvable (for deny patterns written absolute). */
  absolute: string | null;
  /** Outside the workspace: absolute outside the root, or climbing out with `..`. */
  isOutside: boolean;
}

export function normalizePath(raw: string, workspaceRoot: string | null): NormalizedPath {
  let value = raw.trim().replace(/\\/g, "/");
  if (!value) return { display: "", absolute: null, isOutside: false };
  const root = workspaceRoot
    ? path.posix.normalize(workspaceRoot.replace(/\\/g, "/")).replace(/\/+$/, "")
    : null;

  value = path.posix.normalize(value);
  if (value.length > 1) value = value.replace(/\/+$/, "");

  if (isAbsolutePath(value)) {
    if (root && (value === root || value.startsWith(`${root}/`))) {
      const relative = value === root ? "." : value.slice(root.length + 1);
      return { display: relative, absolute: value, isOutside: false };
    }
    return { display: value, absolute: value, isOutside: Boolean(root) };
  }

  if (value.startsWith("./")) value = value.slice(2);
  const climbsOut = value === ".." || value.startsWith("../");
  return {
    display: value,
    absolute: root ? path.posix.normalize(`${root}/${value}`) : null,
    isOutside: climbsOut,
  };
}

// ── Shell commands ────────────────────────────────────────────────

export interface SplitCommand {
  segments: string[];
  /** `$(…)`, backticks or process substitution outside single quotes. */
  hasSubstitution: boolean;
}

/**
 * Split a shell command into simple commands. Quote- and escape-aware;
 * returns `null` for an unterminated quote (unparseable → never allowed).
 */
export function splitShellCommand(command: string): SplitCommand | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasSubstitution = false;

  const flush = () => {
    const segment = current.replace(/\s+/g, " ").trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    const next = command[index + 1];

    if (quote === "'") {
      current += character;
      if (character === "'") quote = null;
      continue;
    }
    if (character === "\\" && next !== undefined) {
      current += character + next;
      index++;
      continue;
    }
    if (character === "`" || (character === "$" && next === "(")) {
      hasSubstitution = true;
    }
    if (quote === '"') {
      current += character;
      if (character === '"') quote = null;
      continue;
    }
    if ((character === "<" || character === ">") && next === "(") {
      hasSubstitution = true;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "\n" || character === "\r") {
      flush();
      continue;
    }
    if (character === "&" || character === "|") {
      // `&&`, `||`, `|&` and a lone `|` / `&` all end a simple command —
      // except `>&`/`<&` (fd duplication) and `&>` (redirect both streams).
      const previous = command[index - 1];
      if (character === "&" && (previous === ">" || previous === "<" || next === ">")) {
        current += character;
        continue;
      }
      flush();
      if (next === character || (character === "|" && next === "&")) index++;
      continue;
    }
    current += character;
  }
  if (quote) return null;
  flush();
  return { segments, hasSubstitution };
}

// ── Matching ──────────────────────────────────────────────────────

function flavorOf(kind: ValueKind): GlobFlavor {
  return kind === "path" ? "path" : "text";
}

function testPattern(
  pattern: ArgumentPattern,
  value: string,
  kind: ValueKind,
  strict: boolean,
): boolean {
  if (pattern.kind === "regex") return pattern.regex ? pattern.regex.test(value) : false;
  return compileGlob(pattern.source, flavorOf(kind), strict && kind === "command").test(value);
}

function patternMentionsOutside(pattern: ArgumentPattern): boolean {
  const source = pattern.kind === "regex" ? pattern.source.slice(1, -1) : pattern.source;
  return source.includes("..") || isAbsolutePath(source.replace(/^\^/, ""));
}

/** ALLOW semantics: every value must match. No values → no match. */
function allowMatches(
  pattern: ArgumentPattern,
  canonical: CanonicalValues,
  workspaceRoot: string | null,
): boolean {
  if (canonical.values.length === 0) return false;
  for (const value of canonical.values) {
    if (canonical.kind === "command") {
      const split = splitShellCommand(value);
      if (!split || split.hasSubstitution || split.segments.length === 0) return false;
      if (!split.segments.every((segment) => testPattern(pattern, segment, "command", true))) {
        return false;
      }
    } else if (canonical.kind === "path") {
      const normalized = normalizePath(value, workspaceRoot);
      if (normalized.isOutside && !patternMentionsOutside(pattern)) return false;
      if (!testPattern(pattern, normalized.display, "path", true)) return false;
    } else if (!testPattern(pattern, value, "text", true)) {
      return false;
    }
  }
  return true;
}

/** DENY/ASK semantics: one value (or one form of one value) is enough. */
function restrictMatches(
  pattern: ArgumentPattern,
  canonical: CanonicalValues,
  workspaceRoot: string | null,
): boolean {
  for (const value of canonical.values) {
    if (canonical.kind === "command") {
      const whole = value.replace(/\s+/g, " ").trim();
      if (testPattern(pattern, whole, "command", false)) return true;
      const split = splitShellCommand(value);
      if (split?.segments.some((segment) => testPattern(pattern, segment, "command", false))) {
        return true;
      }
    } else if (canonical.kind === "path") {
      const normalized = normalizePath(value, workspaceRoot);
      const forms = new Set([normalized.display, value.trim()]);
      if (normalized.absolute) forms.add(normalized.absolute);
      for (const form of forms) {
        if (form && testPattern(pattern, form, "path", false)) return true;
      }
    } else if (testPattern(pattern, value, "text", false)) {
      return true;
    }
  }
  return false;
}

/**
 * Does `rule` (with `decision`) match `call`? Invalid patterns fail closed:
 * no match for allow, a match for ask and deny.
 */
export function ruleMatchesCall(
  rule: ParsedRule,
  decision: PermissionDecision,
  call: MatchableCall,
  capabilities: readonly Capability[],
  workspaceRoot: string | null,
): boolean {
  if (rule.kind === "capability") return capabilities.includes(rule.capability);
  if (!rule.toolRegex.test(call.name)) return false;
  const pattern = rule.argument;
  if (!pattern) return true;
  if (isInvalidPattern(pattern)) return decision !== "allow";

  const canonical = pattern.argumentName
    ? namedValues(call, pattern.argumentName)
    : canonicalValues(call);
  return decision === "allow"
    ? allowMatches(pattern, canonical, workspaceRoot)
    : restrictMatches(pattern, canonical, workspaceRoot);
}

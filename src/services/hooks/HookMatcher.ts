import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * HookMatcher — Claude Code's matcher syntax, ported verbatim.
 *
 * A configured hook carries a `matcher` string that decides whether it runs
 * for a given tool name. The syntax has three tiers, and the tier is inferred
 * from the characters in the pattern rather than declared:
 *
 *   1. Empty, absent, or `*`  → matches everything.
 *   2. Only `[A-Za-z0-9_- ,|]` → an exact tool name, or a `|`/`,`-separated
 *      list of exact names (`Bash|Edit`, `Write, Edit`).
 *   3. Anything else          → an UNANCHORED regex (`Notebook.*`, `^mcp__`).
 *
 * Tier 2 exists so the common case never has to think about regex escaping:
 * `mcp__github__create_issue` is a literal name even though `_` would be a
 * perfectly valid regex. The tier boundary is deliberately the same character
 * class Claude Code uses, so its published matcher documentation reads as a
 * spec for this file.
 *
 * Two safety properties this module guarantees to its callers:
 *   - It never throws. A malformed pattern is a non-match plus a warning; a
 *     user typo in a `PreToolUse` matcher must not take down a tool call.
 *   - It never runs an unbounded pattern. Patterns beyond
 *     `MAX_MATCHER_LENGTH` are rejected outright — a hook matcher is
 *     attacker-adjacent input (it is written once and then evaluated on every
 *     tool call), so a catastrophically backtracking pattern would be a
 *     self-inflicted denial of service on the agentic loop's hot path.
 */

/**
 * Patterns longer than this are refused. Real matchers are tool names and
 * short alternations; length is the cheapest available proxy for the nested
 * quantifiers that cause catastrophic backtracking.
 */
export const MAX_MATCHER_LENGTH = 200;

/** The character class that marks a pattern as a literal name list. */
const LITERAL_LIST_PATTERN = /^[A-Za-z0-9_\-, |]+$/;

/** Separators inside a literal list. */
const LIST_SEPARATOR_PATTERN = /[|,]/;

/**
 * Compiled-regex cache. `null` memoizes a pattern already known to be
 * invalid, so a broken matcher warns once rather than once per tool call.
 */
const compiledMatcherCache = new Map<string, RegExp | null>();

/** Matchers that match everything, before any parsing. */
function matchesEverything(matcher: string | null | undefined): boolean {
  if (matcher === null || matcher === undefined) return true;
  const trimmed = matcher.trim();
  return trimmed === "" || trimmed === "*";
}

/**
 * Is this pattern already known to be unusable — too long, or previously
 * failed to compile? The `null` entries in the cache double as the
 * "already warned about this one" record, so a broken matcher on a
 * `PreToolUse` hook logs once instead of once per tool call.
 *
 * The length ceiling is applied before tier detection rather than only on
 * the regex path: a 200-character matcher is a mistake whichever tier it
 * lands in, and one rule is easier to document than two.
 */
function isRejectedPattern(matcher: string): boolean {
  if (compiledMatcherCache.has(matcher)) {
    return compiledMatcherCache.get(matcher) === null;
  }
  if (matcher.length > MAX_MATCHER_LENGTH) {
    logger.warn(
      `[HookMatcher] Matcher rejected: ${matcher.length} chars exceeds the ${MAX_MATCHER_LENGTH}-char limit. Pattern: "${matcher.slice(0, 60)}…"`,
    );
    compiledMatcherCache.set(matcher, null);
    return true;
  }
  return false;
}

/**
 * Compile (and cache) a matcher as an unanchored regex.
 * Returns `null` for patterns that are oversized or malformed.
 */
function compileMatcher(matcher: string): RegExp | null {
  if (isRejectedPattern(matcher)) return null;
  if (compiledMatcherCache.has(matcher)) {
    return compiledMatcherCache.get(matcher) ?? null;
  }

  try {
    const compiled = new RegExp(matcher);
    compiledMatcherCache.set(matcher, compiled);
    return compiled;
  } catch (compileError: unknown) {
    logger.warn(
      `[HookMatcher] Invalid regex matcher "${matcher}": ${errorMessage(compileError)}. Treating as a non-match.`,
    );
    compiledMatcherCache.set(matcher, null);
    return null;
  }
}

/**
 * Does `value` (a tool name) satisfy `matcher`?
 *
 * Never throws — an unusable pattern is a non-match. The one exception to
 * "unusable means false" is the match-everything tier, which is checked
 * before any parsing and therefore cannot fail.
 */
export function matchesMatcher(
  matcher: string | null | undefined,
  value: string | null | undefined,
): boolean {
  if (matchesEverything(matcher)) return true;
  if (typeof value !== "string" || value.length === 0) return false;

  const pattern = (matcher as string).trim();
  if (isRejectedPattern(pattern)) return false;

  // Tier 2 — exact name, or a `|`/`,`-separated list of exact names.
  if (LITERAL_LIST_PATTERN.test(pattern)) {
    if (!LIST_SEPARATOR_PATTERN.test(pattern)) {
      return pattern === value;
    }
    return pattern
      .split(LIST_SEPARATOR_PATTERN)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .some((entry) => entry === value);
  }

  // Tier 3 — unanchored regex.
  const compiled = compileMatcher(pattern);
  if (!compiled) return false;

  // `lastIndex` is stateful on /g and /y patterns; a user-supplied flagless
  // pattern can't set them, but `new RegExp` inherits nothing else that would
  // make `.test` stateful, so a reset here is cheap insurance.
  compiled.lastIndex = 0;
  try {
    return compiled.test(value);
  } catch (matchError: unknown) {
    logger.warn(
      `[HookMatcher] Matcher "${pattern}" failed while testing "${value}": ${errorMessage(matchError)}`,
    );
    return false;
  }
}

// ─── Argument rules: `Tool(argPattern)` ───────────────────────────────────────
//
// The permission-rule syntax of docs/prompts/12 (Claude Code's `Bash(git *)`),
// so a hook and a rule that mean the same call read the same:
//
//   rule      := toolGlob "(" [ name "=" ] pattern ")"
//   pattern   := "/" regex "/"   — ANCHORED: compiled as ^(?:regex)$
//              | glob            — `*` any run (never `/` in a path), `**` any
//                                  run including `/`, `?` one character, `\`
//                                  escapes; a trailing `:*` is the prefix form
//                                  (`npm run test:*`)
//
// Without `name=`, the pattern is tested against the call's canonical value:
// the command of a shell tool, the path of a file tool, the URL or query of a
// web tool, and otherwise the arguments as compact key-sorted JSON. A matcher
// shaped `name(…)` is always read as a rule, never as a regex.
//
// Hooks only decide whether a hook RUNS, so there is no allow/deny asymmetry
// here: a malformed rule is rejected at write time (`describeMatcher` →
// "invalid") and is a non-match at run time, like any other broken matcher.

const RULE_PATTERN = /^([A-Za-z0-9_.*-]+)\(([\s\S]*)\)$/;
const ARGUMENT_NAME_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

type CanonicalKind = "command" | "path" | "text";

/** Which argument holds a tool's canonical value, and how globs read it. */
const CANONICAL_ARGUMENTS: Record<string, { keys: string[]; kind: CanonicalKind }> = {
  execute_shell: { keys: ["command"], kind: "command" },
  execute_command: { keys: ["command"], kind: "command" },
  execute_python: { keys: ["code"], kind: "text" },
  execute_javascript: { keys: ["code"], kind: "text" },
  read_file: { keys: ["path", "file_path", "filePath"], kind: "path" },
  read_files: { keys: ["paths"], kind: "path" },
  write_file: { keys: ["path", "file_path", "filePath"], kind: "path" },
  replace_in_file: { keys: ["path", "file_path", "filePath"], kind: "path" },
  patch_file: { keys: ["path", "file_path", "filePath"], kind: "path" },
  move_file: { keys: ["source", "destination"], kind: "path" },
  delete_file: { keys: ["path", "file_path", "filePath"], kind: "path" },
  list_directory: { keys: ["path"], kind: "path" },
  find_files: { keys: ["pattern", "path"], kind: "path" },
  search_file_contents: { keys: ["path", "query"], kind: "path" },
  get_file_info: { keys: ["path"], kind: "path" },
  edit_notebook: { keys: ["path", "notebook_path"], kind: "path" },
  read_web_page: { keys: ["url"], kind: "text" },
  search_web: { keys: ["query"], kind: "text" },
};

/** Path-shaped argument names: a glob over one of these uses path rules. */
const PATH_ARGUMENT_NAMES = new Set([
  "path",
  "paths",
  "file_path",
  "filePath",
  "source",
  "destination",
  "notebook_path",
  "cwd",
]);

interface ParsedArgumentRule {
  toolRegex: RegExp;
  argumentName: string | null;
  /** `null` when a `/regex/` failed to compile. */
  compile: ((kind: CanonicalKind) => RegExp | null) | null;
}

const parsedRuleCache = new Map<string, ParsedArgumentRule | null>();

function escapeRegExp(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** A glob as an anchored regex. `path` keeps `*` inside one path segment. */
export function globToRegExp(glob: string, kind: CanonicalKind): RegExp {
  let body = glob;
  let prefixForm = false;
  if (kind !== "path" && body.endsWith(":*") && !body.endsWith("\\:*")) {
    body = body.slice(0, -2);
    prefixForm = true;
  }
  const star = kind === "path" ? "[^/]*" : "[\\s\\S]*";
  const single = kind === "path" ? "[^/]" : "[\\s\\S]";

  let source = "";
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === "\\" && index + 1 < body.length) {
      source += escapeRegExp(body[++index]);
    } else if (character === "*" && body[index + 1] === "*") {
      index++;
      if (kind === "path" && body[index + 1] === "/") {
        index++;
        source += "(?:[\\s\\S]*/)?";
      } else {
        source += "[\\s\\S]*";
      }
    } else if (character === "*") {
      source += star;
    } else if (character === "?") {
      source += single;
    } else {
      source += escapeRegExp(character);
    }
  }
  // Prefix form: the prefix alone, or the prefix followed by a word break.
  if (prefixForm) source += "(?:\\s[\\s\\S]*)?";
  return new RegExp(`^${source}$`);
}

function parseArgumentRule(pattern: string): ParsedArgumentRule | null {
  if (parsedRuleCache.has(pattern)) return parsedRuleCache.get(pattern) ?? null;

  const ruleMatch = RULE_PATTERN.exec(pattern);
  if (!ruleMatch) {
    parsedRuleCache.set(pattern, null);
    return null;
  }
  const [, toolPattern, inner] = ruleMatch;
  const named = ARGUMENT_NAME_PATTERN.exec(inner);
  const argumentName = named ? named[1] : null;
  const patternSource = (named ? named[2] : inner).trim();

  let compile: ParsedArgumentRule["compile"] = null;
  if (patternSource.length >= 2 && patternSource.startsWith("/") && patternSource.endsWith("/")) {
    try {
      const regex = new RegExp(`^(?:${patternSource.slice(1, -1)})$`);
      compile = () => regex;
    } catch (compileError: unknown) {
      logger.warn(
        `[HookMatcher] Invalid argument regex in "${pattern}": ${errorMessage(compileError)}. Treating as a non-match.`,
      );
    }
  } else if (patternSource.length > 0) {
    const byKind = new Map<CanonicalKind, RegExp>();
    compile = (kind) => {
      if (!byKind.has(kind)) byKind.set(kind, globToRegExp(patternSource, kind));
      return byKind.get(kind) ?? null;
    };
  }

  const parsed: ParsedArgumentRule = {
    toolRegex: globToRegExp(toolPattern, "text"),
    argumentName,
    compile,
  };
  parsedRuleCache.set(pattern, parsed);
  return parsed;
}

/** Is this matcher the `Tool(argPattern)` form? */
export function isArgumentRule(matcher: string | null | undefined): boolean {
  return typeof matcher === "string" && RULE_PATTERN.test(matcher.trim());
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Every string an argument pattern is tested against for this call. */
function candidateValues(
  toolName: string,
  args: Record<string, unknown>,
  argumentName: string | null,
): { values: string[]; kind: CanonicalKind } {
  const flatten = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(flatten)
      : value === undefined || value === null
        ? []
        : [typeof value === "string" ? value : stableJson(value)];

  if (argumentName) {
    return {
      values: flatten(args[argumentName]),
      kind: PATH_ARGUMENT_NAMES.has(argumentName) ? "path" : "text",
    };
  }
  const spec = CANONICAL_ARGUMENTS[toolName];
  if (spec) {
    const values = spec.keys.flatMap((key) => flatten(args[key]));
    if (values.length > 0) return { values, kind: spec.kind };
  }
  return { values: [stableJson(args)], kind: "text" };
}

/**
 * Does a tool call satisfy `matcher`? Name-only matchers behave exactly as
 * `matchesMatcher`; the `Tool(argPattern)` form also tests the arguments.
 * Never throws.
 */
export function matchesToolCall(
  matcher: string | null | undefined,
  toolName: string | null | undefined,
  args: Record<string, unknown> | null | undefined,
): boolean {
  if (matchesEverything(matcher)) return true;
  const pattern = (matcher as string).trim();
  if (!isArgumentRule(pattern)) return matchesMatcher(pattern, toolName);
  if (typeof toolName !== "string" || !toolName) return false;
  if (isRejectedPattern(pattern)) return false;

  const rule = parseArgumentRule(pattern);
  if (!rule || !rule.compile) return false;
  if (!rule.toolRegex.test(toolName)) return false;

  try {
    const { values, kind } = candidateValues(toolName, args || {}, rule.argumentName);
    const regex = rule.compile(kind);
    return !!regex && values.some((value) => regex.test(value));
  } catch (matchError: unknown) {
    logger.warn(
      `[HookMatcher] Rule "${pattern}" failed while testing "${toolName}": ${errorMessage(matchError)}`,
    );
    return false;
  }
}

/**
 * Classify a matcher without evaluating it. Exposed for the routes layer,
 * which wants to tell a user at write time whether their matcher will be read
 * as a name list, an argument rule or a regex — and to refuse one that can
 * never match.
 */
export function describeMatcher(
  matcher: string | null | undefined,
): "all" | "literal" | "rule" | "regex" | "invalid" {
  if (matchesEverything(matcher)) return "all";
  const pattern = (matcher as string).trim();
  if (isRejectedPattern(pattern)) return "invalid";
  if (LITERAL_LIST_PATTERN.test(pattern)) return "literal";
  if (isArgumentRule(pattern)) {
    const rule = parseArgumentRule(pattern);
    return rule && rule.compile ? "rule" : "invalid";
  }
  return compileMatcher(pattern) ? "regex" : "invalid";
}

/** Drop the compiled-pattern caches. Test seam; also safe at runtime. */
export function clearMatcherCache(): void {
  compiledMatcherCache.clear();
  parsedRuleCache.clear();
}

export default matchesMatcher;

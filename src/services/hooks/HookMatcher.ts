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

/**
 * Classify a matcher without evaluating it. Exposed for the routes layer,
 * which wants to tell a user at write time whether their matcher will be read
 * as a name list or as a regex.
 */
export function describeMatcher(
  matcher: string | null | undefined,
): "all" | "literal" | "regex" | "invalid" {
  if (matchesEverything(matcher)) return "all";
  const pattern = (matcher as string).trim();
  if (isRejectedPattern(pattern)) return "invalid";
  if (LITERAL_LIST_PATTERN.test(pattern)) return "literal";
  return compileMatcher(pattern) ? "regex" : "invalid";
}

/** Drop the compiled-pattern cache. Test seam; also safe at runtime. */
export function clearMatcherCache(): void {
  compiledMatcherCache.clear();
}

export default matchesMatcher;

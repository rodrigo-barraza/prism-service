import { CAPABILITIES, type Capability } from "./types.ts";

/**
 * Permission rule syntax.
 *
 *   rule        := capability | tool
 *   capability  := "capability:" tag                 capability:network
 *   tool        := toolGlob [ "(" argument ")" ]      execute_shell(git *)
 *   argument    := [ name "=" ] pattern              read_file(path=src/**)
 *   pattern     := "/" regex "/" | glob
 *
 * - `toolGlob` matches the tool name; `*` is any run of characters, so
 *   `mcp__github__*` covers one MCP server and `*` every tool.
 * - Without `name=`, the pattern is tested against the call's canonical
 *   value (the command of a shell tool, the path of a file tool, the URL of
 *   a web tool — see PermissionMatcher). With it, against that one argument.
 * - A regex is ANCHORED: `/git (status|log)/` compiles to
 *   `^(?:git (status|log))$`. An unanchored allow regex is the classic way a
 *   rule meant for `git status` ends up allowing `git status; rm -rf ~`.
 * - Glob: `*` any run (never `/` inside a path), `**` any run including `/`,
 *   `?` one character, `\` escapes. A trailing `:*` is Claude Code's prefix
 *   form: `npm run test:*` matches `npm run test` and `npm run test --watch`.
 *
 * Parsing never throws. A pattern that cannot compile comes back with
 * `regex: null` and an `error`, and the evaluator treats it as FAIL-CLOSED:
 * such a rule matches nothing when it allows and everything when it asks or
 * denies (the old persona-policy loader dropped the predicate instead, so a
 * typo'd ALLOW pattern allowed every call of the tool).
 */

export type GlobFlavor = "path" | "text";

export interface ArgumentPattern {
  /** `null` means "the call's canonical value". */
  argumentName: string | null;
  kind: "glob" | "regex";
  source: string;
  /**
   * Compiled matchers, or `null` when the pattern is invalid. Globs compile
   * once per flavor and strictness (see `compileGlob`); a regex compiles once.
   */
  regex: RegExp | null;
  error?: string;
}

export interface ParsedToolRule {
  kind: "tool";
  toolPattern: string;
  toolRegex: RegExp;
  argument: ArgumentPattern | null;
}

export interface ParsedCapabilityRule {
  kind: "capability";
  capability: Capability;
}

export type ParsedRule = ParsedToolRule | ParsedCapabilityRule;

export type ParseResult =
  | { ok: true; rule: ParsedRule }
  | { ok: false; error: string };

const CAPABILITY_PREFIX = "capability:";
const TOOL_PATTERN = /^[A-Za-z0-9_.*-]+$/;
const ARGUMENT_NAME = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const CAPABILITY_SET = new Set<string>(CAPABILITIES);

/** `/body/` with at least one character between the slashes' outer edges. */
function isRegexLiteral(pattern: string): boolean {
  return pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/");
}

export function parsePermissionRule(text: string): ParseResult {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return { ok: false, error: "Rule is empty." };

  if (trimmed.startsWith(CAPABILITY_PREFIX)) {
    const tag = trimmed.slice(CAPABILITY_PREFIX.length).trim();
    if (!CAPABILITY_SET.has(tag)) {
      return {
        ok: false,
        error: `Unknown capability "${tag}". Known: ${CAPABILITIES.join(", ")}.`,
      };
    }
    return { ok: true, rule: { kind: "capability", capability: tag as Capability } };
  }

  const openIndex = trimmed.indexOf("(");
  const toolPattern = (openIndex === -1 ? trimmed : trimmed.slice(0, openIndex)).trim();
  if (!TOOL_PATTERN.test(toolPattern)) {
    return {
      ok: false,
      error: `"${toolPattern}" is not a tool name or tool glob (letters, digits, _ . - and *).`,
    };
  }
  const toolRegex = new RegExp(`^${globToRegExpSource(toolPattern, "text")}$`);

  if (openIndex === -1) {
    return { ok: true, rule: { kind: "tool", toolPattern, toolRegex, argument: null } };
  }
  if (!trimmed.endsWith(")")) {
    return { ok: false, error: `Missing ")" — write ${toolPattern}(pattern).` };
  }
  const inner = trimmed.slice(openIndex + 1, -1);
  if (!inner.trim()) {
    return {
      ok: false,
      error: `Empty argument pattern — write ${toolPattern} alone to match every call.`,
    };
  }

  const named = ARGUMENT_NAME.exec(inner);
  const argumentName = named ? named[1] : null;
  const patternSource = named ? named[2] : inner;
  if (!patternSource) {
    return { ok: false, error: `Empty pattern for argument "${argumentName}".` };
  }

  return {
    ok: true,
    rule: {
      kind: "tool",
      toolPattern,
      toolRegex,
      argument: compileArgumentPattern(argumentName, patternSource),
    },
  };
}

function compileArgumentPattern(
  argumentName: string | null,
  source: string,
): ArgumentPattern {
  if (!isRegexLiteral(source)) {
    // Globs always compile; their regex is built per flavor at match time.
    return { argumentName, kind: "glob", source, regex: null };
  }
  const body = source.slice(1, -1);
  try {
    return { argumentName, kind: "regex", source, regex: new RegExp(`^(?:${body})$`) };
  } catch (error: unknown) {
    return {
      argumentName,
      kind: "regex",
      source,
      regex: null,
      error: `Invalid regular expression ${source}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Whether a parsed argument pattern is unusable (and so must fail closed). */
export function isInvalidPattern(pattern: ArgumentPattern): boolean {
  return pattern.kind === "regex" && pattern.regex === null;
}

function escapeRegExp(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Translate a glob to a regular-expression body (unanchored).
 *
 * `strict` narrows `*` for the allow side of a shell command: there a star
 * must not stretch across a redirection, so `echo *` allows `echo hi` but not
 * `echo hi > ~/.bashrc`. Deny and ask patterns are compiled permissive — the
 * wider match is the safer one for them.
 */
export function globToRegExpSource(
  glob: string,
  flavor: GlobFlavor,
  strict = false,
): string {
  let body = glob;
  let prefixForm = false;
  if (flavor === "text" && body.endsWith(":*") && !body.endsWith("\\:*")) {
    body = body.slice(0, -2);
    prefixForm = true;
  }

  const star = flavor === "path" ? "[^/]*" : strict ? "[^<>]*" : "[\\s\\S]*";
  const single = flavor === "path" ? "[^/]" : strict ? "[^<>]" : "[\\s\\S]";
  const globstar = strict && flavor === "text" ? "[^<>]*" : "[\\s\\S]*";

  let out = "";
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === "\\" && index + 1 < body.length) {
      out += escapeRegExp(body[++index]);
    } else if (character === "*") {
      if (body[index + 1] === "*") {
        index++;
        if (flavor === "path" && body[index + 1] === "/") {
          // `**/` — zero or more whole directories.
          index++;
          out += "(?:[\\s\\S]*/)?";
        } else {
          out += globstar;
        }
      } else {
        out += star;
      }
    } else if (character === "?") {
      out += single;
    } else {
      out += escapeRegExp(character);
    }
  }

  if (prefixForm) {
    // Claude Code's `prefix:*` — the prefix alone, or the prefix then a space.
    const tail = strict ? "[^<>]*" : "[\\s\\S]*";
    out += `(?: ${tail})?`;
  }
  return out;
}

const globCache = new Map<string, RegExp>();

/** Compile (and memoize) an anchored glob matcher. */
export function compileGlob(glob: string, flavor: GlobFlavor, strict: boolean): RegExp {
  const key = `${flavor}:${strict ? 1 : 0}:${glob}`;
  let regex = globCache.get(key);
  if (!regex) {
    regex = new RegExp(`^${globToRegExpSource(glob, flavor, strict)}$`);
    if (globCache.size > 5_000) globCache.clear();
    globCache.set(key, regex);
  }
  return regex;
}

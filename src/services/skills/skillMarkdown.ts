import { parse as parseYaml } from "yaml";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { quoteAmbiguousScalars } from "#src/services/agents/AgentDefinitionFiles";

// ────────────────────────────────────────────────────────────
// skillMarkdown — SKILL.md: YAML frontmatter + a Markdown body
// ────────────────────────────────────────────────────────────
// The frontmatter is real YAML (1.2 core schema: `yes` stays a string),
// so folded and literal descriptions, block and flow lists, quoted values
// with colons and nested maps all read as their authors meant. The one
// fence rule: `---` on the first line opens it, the next line that is
// exactly `---` closes it. Like Claude Code (and Prism's agent files), a
// plain top-level value with ": " in it (`description: Use when: …`) is
// quoted and tried once more before the file is called invalid.
// ────────────────────────────────────────────────────────────

export const SKILL_FILE_NAME = "SKILL.md";

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Why the frontmatter could not be read; the body is still returned. */
  error: string | null;
}

const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /^---[ \t]*(?:\r?\n|$)/m;
/** Agent Skills: lowercase letters and digits, single hyphens between. */
const AGENT_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_SKILL_NAME_MAX_CHARS = 64;
const AGENT_SKILL_DESCRIPTION_MAX_CHARS = 1024;

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const text = content.replace(/^﻿/, "");
  const opening = text.match(OPENING_FENCE);
  if (!opening) return { frontmatter: {}, body: text.trim(), error: null };

  const rest = text.slice(opening[0].length);
  const closing = rest.match(CLOSING_FENCE);
  if (!closing || closing.index === undefined) {
    return {
      frontmatter: {},
      body: text.trim(),
      error: "frontmatter opened with --- but never closed",
    };
  }

  const header = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length).trim();
  let parsed: unknown;
  try {
    parsed = parseYaml(header, { prettyErrors: false });
  } catch (error: unknown) {
    const lenient = quoteAmbiguousScalars(header);
    try {
      if (lenient === header) throw error;
      parsed = parseYaml(lenient, { prettyErrors: false });
    } catch {
      const reason = getErrorMessage(error).split("\n")[0];
      return { frontmatter: {}, body, error: `invalid YAML frontmatter: ${reason}` };
    }
  }
  if (parsed === null || parsed === undefined) return { frontmatter: {}, body, error: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: {}, body, error: "frontmatter must be a mapping of keys to values" };
  }
  return { frontmatter: parsed as Record<string, unknown>, body, error: null };
}

/** A scalar frontmatter value as one trimmed line of text ("" when absent). */
export function frontmatterText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Split a tool list on commas and whitespace, except inside parentheses —
 * `Bash(git status:*)` is one entry.
 */
function splitToolList(text: string): string[] {
  const tools: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (character === "," || /\s/.test(character))) {
      if (current) tools.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tools.push(current);
  return tools;
}

/**
 * `allowed-tools` as a list: a YAML list, a comma-separated string (Claude
 * Code) or a space-separated one (Agent Skills). null when absent or not
 * one of those.
 */
export function readAllowedTools(value: unknown): string[] | null {
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (typeof value === "string") entries = splitToolList(value);
  else return null;
  const tools = entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(tools)];
}

/** The frontmatter's `allowed-tools` (either spelling). */
export function allowedToolsOf(frontmatter: Record<string, unknown>): string[] | null {
  return readAllowedTools(frontmatter["allowed-tools"] ?? frontmatter.allowedTools);
}

/**
 * The Agent Skills rules a plugin's skill must meet — null when it does,
 * else why not. (Claude config imports are lenient: a nameless skill takes
 * its directory's name.)
 */
export function validateAgentSkill(
  frontmatter: { name?: unknown; description?: unknown },
  directoryName: string,
): string | null {
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  if (!name) return "SKILL.md frontmatter has no name";
  if (name.length > AGENT_SKILL_NAME_MAX_CHARS) {
    return `name is longer than ${AGENT_SKILL_NAME_MAX_CHARS} characters`;
  }
  if (!AGENT_SKILL_NAME.test(name)) {
    return `name "${name}" must be lowercase letters and digits joined by single hyphens`;
  }
  if (name !== directoryName) {
    return `name "${name}" is not its directory's name ("${directoryName}")`;
  }
  const description = frontmatterText(frontmatter.description);
  if (!description) return "SKILL.md frontmatter has no description";
  if (description.length > AGENT_SKILL_DESCRIPTION_MAX_CHARS) {
    return `description is longer than ${AGENT_SKILL_DESCRIPTION_MAX_CHARS} characters`;
  }
  return null;
}

import { MODELS, getModelByName, type ModelDefinition } from "#src/config";
import { PROVIDERS } from "#src/constants";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

// ────────────────────────────────────────────────────────────
// Agent definition fields — the vocabulary a custom agent (a Mongo
// document or a `.claude/agents/*.md` / `.prism/agents/*.md` file) uses
// to pin how it runs as a sub-agent. One normaliser serves both sources,
// so a file and a stored agent can never disagree about what a value means.
// ────────────────────────────────────────────────────────────

/**
 * Permission modes (the names prompt 12's modes use; Claude Code's
 * `bypassPermissions` is accepted as `bypass`). A definition can only
 * NARROW its parent's approval mode — see resolveSubAgentApproval.
 */
export const AGENT_PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypass",
] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/** Reasoning-effort levels (ParameterRegistry's `reasoningEffort` options). */
export const AGENT_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

/** The harness clamps iterations to 100; a definition may not ask for more. */
export const AGENT_MAX_TURNS_LIMIT = 100;

/** The pinned fields, normalised. Every one is optional. */
export interface AgentDefinitionFields {
  description?: string;
  model?: string;
  provider?: string;
  effort?: AgentEffort;
  /** `["*"]` = the parent's enabled tools. */
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  permissionMode?: AgentPermissionMode;
}

/** The pinned fields a stored custom agent keeps as top-level document keys. */
export const AGENT_DEFINITION_PIN_KEYS = [
  "model",
  "provider",
  "effort",
  "maxTurns",
  "permissionMode",
  "disallowedTools",
] as const;

export interface NormalizedAgentDefinitionFields {
  fields: AgentDefinitionFields;
  /** One line per invalid field, naming the field. Empty = valid. */
  errors: string[];
}

/**
 * Claude Code's tool names → Prism's, so a `.claude/agents` file written for
 * Claude Code scopes the same tools here. `Bash(git *)`-style rule text keeps
 * only the tool. Names not listed pass through (Prism names, `domain:` entries,
 * `mcp__server__tool`).
 */
const CLAUDE_CODE_TOOL_NAMES: Record<string, string[]> = {
  Read: [TOOL_NAMES.READ_FILE],
  NotebookRead: [TOOL_NAMES.READ_FILE],
  Write: [TOOL_NAMES.WRITE_FILE],
  Edit: [TOOL_NAMES.REPLACE_IN_FILE],
  MultiEdit: [TOOL_NAMES.REPLACE_IN_FILE],
  NotebookEdit: [TOOL_NAMES.EDIT_NOTEBOOK],
  Glob: [TOOL_NAMES.FIND_FILES],
  Grep: [TOOL_NAMES.SEARCH_FILE_CONTENTS],
  LS: [TOOL_NAMES.LIST_DIRECTORY],
  Bash: [TOOL_NAMES.EXECUTE_SHELL],
  WebFetch: [TOOL_NAMES.READ_WEB_PAGE],
  WebSearch: [TOOL_NAMES.SEARCH_WEB],
  TodoWrite: [TOOL_NAMES.WRITE_TODO],
  Task: [TOOL_NAMES.CREATE_SUBAGENT],
  Agent: [TOOL_NAMES.CREATE_SUBAGENT],
  AskUserQuestion: [TOOL_NAMES.ASK_USER],
};

/** Model aliases → a family prefix; `inherit` means "no pin". */
const MODEL_FAMILY_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-",
  sonnet: "claude-sonnet-",
  opus: "claude-opus-",
  fable: "claude-fable-",
};

/** `claude-opus-5-5` → [5, 5]; a dated snapshot's 8-digit date is dropped. */
function familyVersion(modelName: string, prefix: string): number[] {
  return modelName
    .slice(prefix.length)
    .split("-")
    .filter((part) => /^\d{1,3}$/.test(part))
    .map(Number);
}

function compareVersions(first: number[], second: number[]): number {
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest catalogued model of an alias's family (`opus` → `claude-opus-5-5`). */
export function resolveModelAlias(alias: string): string | null {
  const prefix = MODEL_FAMILY_ALIASES[alias.toLowerCase()];
  if (!prefix) return null;
  let newest: ModelDefinition | null = null;
  for (const model of Object.values(MODELS) as ModelDefinition[]) {
    if (model.provider !== PROVIDERS.ANTHROPIC || !model.name.startsWith(prefix)) continue;
    if (
      !newest ||
      compareVersions(familyVersion(model.name, prefix), familyVersion(newest.name, prefix)) > 0
    ) {
      newest = model;
    }
  }
  return newest?.name ?? null;
}

/** The catalogued provider of a model id, or null for an unknown/local model. */
export function inferProviderForModel(model: string): string | null {
  return getModelByName(model)?.provider ?? null;
}

/**
 * A tool list from a definition: an array, or Claude Code's comma-separated
 * string. Claude Code names map to Prism's; duplicates collapse.
 */
export function parseToolList(value: unknown): string[] | null {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (!entries || !entries.every((entry) => typeof entry === "string")) return null;
  const tools: string[] = [];
  for (const rawEntry of entries as string[]) {
    const entry = rawEntry.trim().replace(/\(.*\)$/, "").trim();
    if (!entry) continue;
    for (const toolName of CLAUDE_CODE_TOOL_NAMES[entry] ?? [entry]) {
      if (!tools.includes(toolName)) tools.push(toolName);
    }
  }
  return tools;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Validate and normalise the pinned fields of a raw definition (a request
 * body, a Mongo document, or parsed frontmatter). Absent/blank fields stay
 * absent. `tools` also accepts the legacy `availableTools` / `enabledTools`
 * spellings of a stored agent.
 */
export function normalizeAgentDefinitionFields(
  raw: Record<string, unknown>,
): NormalizedAgentDefinitionFields {
  const fields: AgentDefinitionFields = {};
  const errors: string[] = [];

  if (!isBlank(raw.description)) {
    if (typeof raw.description === "string") fields.description = raw.description.trim();
    else errors.push("description must be a string");
  }

  if (!isBlank(raw.model)) {
    if (typeof raw.model !== "string") {
      errors.push("model must be a string");
    } else {
      const model = raw.model.trim();
      if (model.toLowerCase() !== "inherit") {
        fields.model = resolveModelAlias(model) ?? model;
      }
    }
  }

  if (!isBlank(raw.provider)) {
    if (typeof raw.provider === "string") fields.provider = raw.provider.trim();
    else errors.push("provider must be a string");
  }
  if (fields.provider && !fields.model) {
    errors.push("provider needs a model — pin both, or only a model the catalog knows");
  }
  if (fields.model && !fields.provider) {
    const inferredProvider = inferProviderForModel(fields.model);
    if (inferredProvider) fields.provider = inferredProvider;
  }

  if (!isBlank(raw.effort)) {
    const effort = typeof raw.effort === "string" ? raw.effort.trim().toLowerCase() : null;
    if (effort && (AGENT_EFFORTS as readonly string[]).includes(effort)) {
      fields.effort = effort as AgentEffort;
    } else {
      errors.push(`effort must be one of ${AGENT_EFFORTS.join(", ")} (got ${JSON.stringify(raw.effort)})`);
    }
  }

  const rawTools = raw.tools ?? raw.availableTools ?? raw.enabledTools;
  if (!isBlank(rawTools)) {
    const tools = parseToolList(rawTools);
    if (tools) fields.tools = tools;
    else errors.push("tools must be a list of tool names or a comma-separated string");
  }

  if (!isBlank(raw.disallowedTools)) {
    const disallowedTools = parseToolList(raw.disallowedTools);
    if (disallowedTools) fields.disallowedTools = disallowedTools;
    else errors.push("disallowedTools must be a list of tool names or a comma-separated string");
  }

  if (!isBlank(raw.maxTurns)) {
    const maxTurns = typeof raw.maxTurns === "string" ? Number(raw.maxTurns.trim()) : raw.maxTurns;
    if (
      typeof maxTurns === "number" &&
      Number.isInteger(maxTurns) &&
      maxTurns >= 1 &&
      maxTurns <= AGENT_MAX_TURNS_LIMIT
    ) {
      fields.maxTurns = maxTurns;
    } else {
      errors.push(
        `maxTurns must be an integer from 1 to ${AGENT_MAX_TURNS_LIMIT} (got ${JSON.stringify(raw.maxTurns)})`,
      );
    }
  }

  if (!isBlank(raw.permissionMode)) {
    const requested = typeof raw.permissionMode === "string" ? raw.permissionMode.trim() : "";
    const permissionMode = requested === "bypassPermissions" ? "bypass" : requested;
    if ((AGENT_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
      fields.permissionMode = permissionMode as AgentPermissionMode;
    } else {
      errors.push(
        `permissionMode must be one of ${AGENT_PERMISSION_MODES.join(", ")} (got ${JSON.stringify(raw.permissionMode)})`,
      );
    }
  }

  return { fields, errors };
}

/**
 * A create/update body's definition fields, normalised for storage:
 * `{ errors }` when any is invalid, else the body with them rewritten
 * (`tools` → `availableTools`, Claude Code tool names mapped, the model
 * alias resolved and its provider filled in). Fields the body does not
 * mention are left alone, so a partial update keeps the stored ones.
 */
export function normalizeAgentDefinitionBody(
  body: Record<string, unknown>,
): { body: Record<string, unknown> } | { errors: string[] } {
  const { fields, errors } = normalizeAgentDefinitionFields(body);
  if (errors.length > 0) return { errors };
  const normalized: Record<string, unknown> = { ...body };
  delete normalized.tools;
  for (const key of AGENT_DEFINITION_PIN_KEYS) {
    if (fields[key] !== undefined) normalized[key] = fields[key];
  }
  if (fields.tools && body.tools !== undefined) normalized.availableTools = fields.tools;
  return { body: normalized };
}

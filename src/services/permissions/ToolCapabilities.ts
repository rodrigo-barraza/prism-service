import logger from "#src/utils/logger";
import { lookupMcpTool } from "#src/services/mcp/McpToolRegistry";
import { toMcpScope, type McpScope } from "#src/services/mcp/McpScope";
import { CAPABILITIES, type Capability } from "./types.ts";

/**
 * ToolCapabilities — what each tool can do, for `capability:<tag>` rules.
 *
 * Three sources declare tags, and each pushes them here rather than this
 * module pulling from them (the tool orchestrator imports half the codebase;
 * a pull would put the approval engine at the end of that import chain):
 *
 *   - tools-service schemas carry `capabilities` (its `ToolCapabilities.ts`);
 *     ToolOrchestratorService registers them after every schema fetch.
 *   - Internal tools declare `capabilities` on their definition;
 *     InternalToolRegistry registers them at initialize.
 *   - MCP tools derive them from the server's annotations
 *     (`capabilitiesFromMcpAnnotations`); MCPClientService records them per
 *     connection in McpToolRegistry, which is read by the CALLER's scope —
 *     two profiles can each have a server with the same name.
 *
 * A tool nobody declared resolves conservatively. The rules that care most —
 * deny rules — are better served by "may have side effects" than by "none".
 */

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

/**
 * Prism-owned tools whose schemas are built outside InternalToolRegistry
 * (the delegation tools come from `getOrchestratorToolSchemas`), plus the
 * core tools-service tools so a tools-service that predates capability tags
 * still gets correct answers for the tools rules target most.
 */
const BUILT_IN: Record<string, readonly Capability[]> = {
  create_subagent: ["subagent"],
  create_subagents: ["subagent"],
  send_subagent_message: ["subagent"],
  resume_subagent: ["subagent"],
  stop_subagent: ["subagent"],
  delete_subagents: ["subagent"],
  get_subagent_output: ["subagent"],

  // Plan-mode control flow and questions: no side effects of their own.
  // Declared here too so plan mode can never refuse its own way out when a
  // registry has not reported them.
  enter_plan_mode: [],
  exit_plan_mode: [],
  ask_user: [],

  read_file: ["fs_read"],
  read_files: ["fs_read"],
  list_directory: ["fs_read"],
  search_file_contents: ["fs_read"],
  find_files: ["fs_read"],
  get_file_info: ["fs_read"],
  summarize_project: ["fs_read"],
  run_git: ["fs_read"],
  write_file: ["fs_write"],
  replace_in_file: ["fs_write"],
  apply_patch: ["fs_write"],
  move_file: ["fs_write"],
  delete_file: ["fs_write"],
  edit_notebook: ["fs_write"],
  execute_shell: ["shell", "fs_write", "network"],
  execute_command: ["shell", "fs_write", "network"],
  execute_python: ["shell", "fs_write", "network"],
  execute_javascript: ["shell", "network"],
  read_web_page: ["network"],
  read_url: ["network"],
  search_web: ["network"],
  control_browser: ["network", "external_side_effect"],
  save_memory: ["memory_write"],
};

/** What an undeclared tool is assumed to be able to do. */
const UNDECLARED: readonly Capability[] = ["external_side_effect"];

/** MCP spec defaults: not read-only, open-world. */
const UNDECLARED_MCP: readonly Capability[] = [
  "mcp",
  "network",
  "external_side_effect",
];

const declared = new Map<string, readonly Capability[]>();

/** Keep only known tags; `null` when the value isn't a tag list at all. */
export function sanitizeCapabilities(value: unknown): Capability[] | null {
  if (!Array.isArray(value)) return null;
  const tags: Capability[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && CAPABILITY_SET.has(entry)) {
      if (!tags.includes(entry as Capability)) tags.push(entry as Capability);
    }
  }
  return tags;
}

/**
 * Record the tags a set of tools declares. Entries without a `capabilities`
 * array are skipped — they stay undeclared rather than becoming "no
 * capabilities", which would be the permissive reading.
 */
export function registerToolCapabilities(
  entries: Iterable<{ name?: unknown; capabilities?: unknown }>,
  source: string,
): number {
  let count = 0;
  for (const entry of entries) {
    if (typeof entry?.name !== "string") continue;
    const tags = sanitizeCapabilities(entry.capabilities);
    if (!tags) continue;
    if (
      Array.isArray(entry.capabilities) &&
      tags.length !== new Set(entry.capabilities).size
    ) {
      logger.warn(
        `[ToolCapabilities] ${source}: "${entry.name}" declares unknown capability tags ${JSON.stringify(entry.capabilities)}; kept ${JSON.stringify(tags)}`,
      );
    }
    declared.set(entry.name, tags);
    count++;
  }
  return count;
}

/**
 * Map MCP tool annotations to tags. Annotations are hints from a server we
 * may not trust, so they only ever ADD tags relative to the spec defaults —
 * `readOnlyHint` adds `fs_read` in place of `external_side_effect`, and
 * `openWorldHint` (default true) adds `network`. Tags feed rules; the tier
 * is `mcpTierFromAnnotations`, which lowers a tool only on a trusted server.
 */
export function capabilitiesFromMcpAnnotations(annotations: unknown): Capability[] {
  const hints =
    annotations && typeof annotations === "object"
      ? (annotations as Record<string, unknown>)
      : {};
  const tags: Capability[] = ["mcp"];
  tags.push(hints.readOnlyHint === true ? "fs_read" : "external_side_effect");
  if (hints.openWorldHint !== false) tags.push("network");
  return tags;
}

/**
 * Capabilities of a tool, by name. Never empty-by-omission. An MCP tool is
 * resolved in `scope` (default: the ambient request's).
 */
export function resolveToolCapabilities(
  toolName: string,
  scope?: McpScope,
): readonly Capability[] {
  if (toolName.startsWith("mcp__")) {
    return lookupMcpTool(toolName, scope ?? toMcpScope())?.capabilities ?? UNDECLARED_MCP;
  }
  const registered = declared.get(toolName);
  if (registered) return registered;
  return BUILT_IN[toolName] ?? UNDECLARED;
}

/** Test seam: forget every registration. */
export function resetToolCapabilities(): void {
  declared.clear();
}

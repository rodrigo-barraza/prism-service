import fs from "node:fs/promises";
import path from "node:path";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { normalizeProfileId } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import {
  AGENT_DEFINITION_DIRECTORIES,
  parseAgentDefinitionFile,
} from "#src/services/agents/AgentDefinitionFiles";
import { MCP_SERVER_NAME_PATTERN } from "#src/services/mcp/McpNaming";
import {
  SKILL_FILE_NAME,
  allowedToolsOf,
  frontmatterText,
  parseSkillMarkdown,
} from "#src/services/skills/skillMarkdown";
import {
  SKILL_FOLDER_LIMITS,
  readLocalFolder,
  resolveInsideRegisteredWorkspace,
} from "#src/services/skills/workspaceFolders";
import {
  emptyMcpSummary,
  emptySkillSummary,
  recordSkillResult,
  recordSkippedServer,
  recordSkippedSkill,
  type ImportSkipped,
  type McpImportSummary,
  type SkillImportSummary,
} from "#src/services/skills/importSummary";
import {
  importMcpServerConfigs,
  type ImportableMcpServer,
} from "#src/services/skills/mcpServerImport";

// ────────────────────────────────────────────────────────────
// ClaudeConfigImportService — .claude config inheritance
// ────────────────────────────────────────────────────────────
// Port of oh-my-pi's config discovery: when the coding agent works
// in a workspace that already carries Claude Code assets, import
// them into Prism without a migration step:
//
//   CLAUDE.md (workspace root only, no upward walk)
//     → one "Imported from CLAUDE.md" section of the project
//       instructions document (ProjectInstructionsService), so it is
//       injected into every system prompt. Re-import is idempotent —
//       appendSection is a no-op when the content is unchanged.
//   .claude/skills/*/SKILL.md
//     → Prism skills (SkillService.upsertImported): YAML frontmatter
//       name/description/allowed-tools, body = the skill body, the
//       whole folder stored (SkillFolderStore) so read_skill_file
//       reaches its scripts and references. In the importer's
//       project/user/profile scope. Upsert keyed by name + source; a
//       name collision with a skill NOT imported from this workspace
//       is skipped, never clobbered.
//   .mcp.json + .claude/settings.json mcpServers
//     → MCP server configs (mcp_servers collection, same shape as
//       McpServersRoutes), in the importer's user + profile. Imported
//       DISABLED — configs may contain arbitrary commands, so nothing
//       is ever auto-connected; the user enables each server in the UI.
//   .claude/settings.json hooks
//     → NEVER imported (arbitrary command execution on someone
//       else's trigger schedule); counted in the summary as skipped.
//   .claude/agents/*.md, .prism/agents/*.md
//     → listed only: AgentPersonaRegistry reads them from the
//       workspace at turn time, so there is nothing to copy.
//
// Only a path inside a registered workspace root is read, and a dry
// run reports everything it would do without writing. Reads the LOCAL
// filesystem only — agent-served remote workspaces are not supported
// by this importer.
// ────────────────────────────────────────────────────────────

export const CLAUDE_MD_SECTION_HEADING = "Imported from CLAUDE.md";
export const CLAUDE_CONFIG_SOURCE_PREFIX = "claude-config:";

export type { ImportSkipped };

/** How long a preview of CLAUDE.md may be. */
const INSTRUCTIONS_PREVIEW_MAX_CHARS = 2_000;
const MCP_SERVER_NAME_MAX_CHARS = 40;

export interface ClaudeConfigImportSummary {
  workspaceRoot: string;
  dryRun: boolean;
  projectInstructions: {
    imported: boolean;
    unchanged: boolean;
    bytes: number;
    skipped: string | null;
    /** The start of CLAUDE.md, for the preview. */
    preview?: string;
  };
  skills: SkillImportSummary;
  mcpServers: McpImportSummary;
  hooks: {
    skippedCount: number;
    note: string | null;
  };
  agents: {
    found: Array<{ name: string; path: string; error?: string }>;
    note: string | null;
  };
  /** Files left out of a skill folder (symlinks, oversized files). */
  warnings: string[];
}

export interface ClaudeConfigImportScope {
  project: string;
  username: string;
  /** Defaults to the request's profile. */
  profileId?: string | null;
  agent?: string | null;
}

export interface ClaudeConfigImportOptions {
  dryRun?: boolean;
}

interface RawMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  transport?: string;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** SKILL.md's frontmatter (real YAML) and the body below it. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const { frontmatter, body } = parseSkillMarkdown(content);
  return { frontmatter, body };
}

function normalizeMcpEntry(name: string, entry: RawMcpServerEntry): ImportableMcpServer | null {
  const command = typeof entry.command === "string" ? entry.command : "";
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!command && !url) return null;

  const declaredType = (entry.type || entry.transport || "").toLowerCase();
  let transport: ImportableMcpServer["transport"];
  if (command) {
    transport = "stdio";
  } else if (declaredType === "sse") {
    transport = "sse";
  } else {
    transport = "streamable-http";
  }

  return {
    name,
    displayName: name,
    transport,
    command,
    args: Array.isArray(entry.args)
      ? entry.args.filter((argument) => typeof argument === "string")
      : [],
    env:
      entry.env && typeof entry.env === "object"
        ? (entry.env as Record<string, string>)
        : {},
    url,
    headers:
      entry.headers && typeof entry.headers === "object"
        ? (entry.headers as Record<string, string>)
        : {},
  };
}

/**
 * Demote headings so an imported CLAUDE.md nests INSIDE the
 * "Imported from CLAUDE.md" `##` section. Without this, any `#`/`##`
 * heading in the body terminates the section, and every re-import
 * appends the tail again instead of replacing in place (idempotency
 * depends on upsertMarkdownSection seeing one contiguous section).
 * Caveat: `#` at line start inside fenced code blocks is demoted too —
 * accepted, instructions are prose.
 */
export function demoteMarkdownHeadings(body: string): string {
  return body.replace(
    /^(#{1,6})(\s)/gm,
    (_match, hashes: string, whitespace: string) =>
      "#".repeat(Math.min(hashes.length + 2, 6)) + whitespace,
  );
}

async function importProjectInstructions(
  workspaceRoot: string,
  scope: ClaudeConfigImportScope,
  dryRun: boolean,
): Promise<ClaudeConfigImportSummary["projectInstructions"]> {
  const content = await readFileIfExists(path.join(workspaceRoot, "CLAUDE.md"));
  if (content === null || !content.trim()) {
    return {
      imported: false,
      unchanged: false,
      bytes: 0,
      skipped: "no CLAUDE.md at workspace root",
    };
  }

  const { default: ProjectInstructionsService, upsertMarkdownSection } = await import(
    "#src/services/ProjectInstructionsService"
  );
  const database = ProjectInstructionsService.getDatabase();
  if (!database) {
    return {
      imported: false,
      unchanged: false,
      bytes: 0,
      skipped: "database unavailable",
    };
  }

  const section = demoteMarkdownHeadings(content.trim());
  const preview = content.trim().slice(0, INSTRUCTIONS_PREVIEW_MAX_CHARS);
  const writeScope = await ProjectInstructionsService.resolveWriteScope(
    database,
    scope,
  );
  const before = await ProjectInstructionsService.getExactCurrent(
    database,
    writeScope,
  );
  if (dryRun) {
    const next = upsertMarkdownSection(before?.content ?? "", CLAUDE_MD_SECTION_HEADING, section);
    return {
      imported: false,
      unchanged: !!before && next === before.content,
      bytes: content.length,
      skipped: null,
      preview,
    };
  }
  const document = await ProjectInstructionsService.appendSection(
    database,
    writeScope,
    CLAUDE_MD_SECTION_HEADING,
    section,
    "user",
  );

  const unchanged = !!before && document.version === before.version;
  return {
    imported: true,
    unchanged,
    bytes: content.length,
    skipped: null,
    preview,
  };
}

async function importSkills(
  workspaceRoot: string,
  scope: ClaudeConfigImportScope,
  source: string,
  warnings: string[],
  dryRun: boolean,
): Promise<SkillImportSummary> {
  const summary = emptySkillSummary();

  const skillsDirectory = path.join(workspaceRoot, ".claude", "skills");
  let entries: string[];
  try {
    entries = (await fs.readdir(skillsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return summary;
  }

  const { default: SkillService, resolveSkillCaller } = await import(
    "#src/services/SkillService"
  );
  // Imported skills serve every persona (agent: null) in the importer's
  // own project, user and profile (the profile comes from the request).
  const caller = resolveSkillCaller({
    project: scope.project,
    username: scope.username,
    profileId: scope.profileId,
    agent: null,
  });

  for (const skillDirectory of entries.sort()) {
    const folderPath = path.join(skillsDirectory, skillDirectory);
    const content = await readFileIfExists(path.join(folderPath, SKILL_FILE_NAME));
    const base = { name: skillDirectory, description: "", allowedTools: null, files: [] };
    if (content === null) {
      recordSkippedSkill(summary, base, `no ${SKILL_FILE_NAME}`);
      continue;
    }

    const { frontmatter, body, error } = parseSkillMarkdown(content);
    const name = frontmatterText(frontmatter.name) || skillDirectory;
    const description = frontmatterText(frontmatter.description);
    const allowedTools = allowedToolsOf(frontmatter);
    if (error) {
      recordSkippedSkill(summary, { ...base, name }, error);
      continue;
    }
    if (!body) {
      recordSkippedSkill(summary, { ...base, name, description, allowedTools }, "empty skill body");
      continue;
    }

    const folder = await readLocalFolder(folderPath, SKILL_FOLDER_LIMITS);
    if ("error" in folder) {
      recordSkippedSkill(summary, { ...base, name, description, allowedTools }, folder.error);
      continue;
    }
    for (const skipped of folder.skipped) {
      warnings.push(`.claude/skills/${skillDirectory}/${skipped.path}: ${skipped.reason}`);
    }

    const item = {
      name,
      description,
      allowedTools,
      files: folder.files.map((file) => file.path).sort(),
    };
    const result = await SkillService.upsertImported(
      { name, description, body, source, allowedTools, files: folder.files },
      caller,
      { dryRun },
    );
    recordSkillResult(summary, item, result);
  }

  return summary;
}

async function importMcpServers(
  workspaceRoot: string,
  scope: ClaudeConfigImportScope,
  source: string,
  settings: Record<string, unknown> | null,
  dryRun: boolean,
): Promise<McpImportSummary> {
  const summary = emptyMcpSummary();
  const discovered = new Map<string, RawMcpServerEntry>();

  const mcpJsonRaw = await readFileIfExists(
    path.join(workspaceRoot, ".mcp.json"),
  );
  if (mcpJsonRaw !== null) {
    try {
      const parsed = JSON.parse(mcpJsonRaw) as {
        mcpServers?: Record<string, RawMcpServerEntry>;
      };
      for (const [name, entry] of Object.entries(parsed.mcpServers || {})) {
        discovered.set(name, entry);
      }
    } catch (error: unknown) {
      recordSkippedServer(summary, ".mcp.json", `unparseable: ${getErrorMessage(error)}`);
    }
  }

  const settingsServers = settings?.mcpServers as
    Record<string, RawMcpServerEntry> | undefined;
  if (settingsServers && typeof settingsServers === "object") {
    for (const [name, entry] of Object.entries(settingsServers)) {
      if (!discovered.has(name)) discovered.set(name, entry);
    }
  }

  const importable: ImportableMcpServer[] = [];
  for (const [name, entry] of discovered) {
    const normalized = normalizeMcpEntry(name, entry);
    if (!normalized) {
      recordSkippedServer(summary, name, "neither command nor url");
    } else if (!MCP_SERVER_NAME_PATTERN.test(name) || name.length > MCP_SERVER_NAME_MAX_CHARS) {
      recordSkippedServer(
        summary,
        name,
        `a server name is up to ${MCP_SERVER_NAME_MAX_CHARS} letters and digits joined by single '-' or '_' (it namespaces the server's tools)`,
        normalized.transport,
      );
    } else {
      importable.push(normalized);
    }
  }

  await importMcpServerConfigs(
    importable,
    {
      project: scope.project,
      username: scope.username,
      profileId: normalizeProfileId(scope.profileId ?? getRequestContext().profileId),
    },
    source,
    summary,
    { dryRun },
  );
  return summary;
}

function summarizeHooks(
  settings: Record<string, unknown> | null,
): ClaudeConfigImportSummary["hooks"] {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object") {
    return { skippedCount: 0, note: null };
  }
  let count = 0;
  for (const value of Object.values(hooks as Record<string, unknown>)) {
    count += Array.isArray(value) ? value.length : 1;
  }
  if (count === 0) return { skippedCount: 0, note: null };
  return {
    skippedCount: count,
    note:
      "Hooks from .claude/settings.json are never imported — they execute arbitrary commands. " +
      "Recreate any hook you actually want through Prism's own hooks UI.",
  };
}

/** Agent definition files: read live at turn time, so only listed here. */
async function listAgentFiles(
  workspaceRoot: string,
): Promise<ClaudeConfigImportSummary["agents"]> {
  const found: ClaudeConfigImportSummary["agents"]["found"] = [];
  for (const directory of AGENT_DEFINITION_DIRECTORIES) {
    let names: string[];
    try {
      names = (await fs.readdir(path.join(workspaceRoot, directory), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const fileName of names) {
      const relative = `${directory}/${fileName}`;
      const content = (await readFileIfExists(path.join(workspaceRoot, relative))) ?? "";
      const parsed = parseAgentDefinitionFile(content, relative);
      found.push(
        "definition" in parsed
          ? { name: parsed.definition.name, path: relative }
          : { name: fileName.replace(/\.md$/, ""), path: relative, error: parsed.error },
      );
    }
  }
  return {
    found,
    note:
      found.length > 0
        ? "Agent files are read from the workspace at every turn — they are already live, nothing is copied."
        : null,
  };
}

const ClaudeConfigImportService = {
  /**
   * Discover and import Claude Code assets from a directory inside a
   * registered workspace. Idempotent: re-running against the same
   * workspace creates nothing new. `dryRun` previews without writing.
   */
  async importFromWorkspace(
    workspaceRoot: string,
    scope: ClaudeConfigImportScope,
    { dryRun = false }: ClaudeConfigImportOptions = {},
  ): Promise<ClaudeConfigImportSummary | { error: string; notFound?: true }> {
    const resolved = await resolveInsideRegisteredWorkspace(workspaceRoot);
    if ("error" in resolved) return resolved;
    const resolvedRoot = resolved.path;

    const source = `${CLAUDE_CONFIG_SOURCE_PREFIX}${resolvedRoot}`;

    let settings: Record<string, unknown> | null = null;
    const settingsRaw = await readFileIfExists(
      path.join(resolvedRoot, ".claude", "settings.json"),
    );
    if (settingsRaw !== null) {
      try {
        settings = JSON.parse(settingsRaw) as Record<string, unknown>;
      } catch (error: unknown) {
        logger.warn(
          `[ClaudeConfigImport] Unparseable .claude/settings.json in ${resolvedRoot}: ${getErrorMessage(error)}`,
        );
      }
    }

    const warnings: string[] = [];
    const summary: ClaudeConfigImportSummary = {
      workspaceRoot: resolvedRoot,
      dryRun,
      projectInstructions: await importProjectInstructions(resolvedRoot, scope, dryRun),
      skills: await importSkills(resolvedRoot, scope, source, warnings, dryRun),
      mcpServers: await importMcpServers(resolvedRoot, scope, source, settings, dryRun),
      hooks: summarizeHooks(settings),
      agents: await listAgentFiles(resolvedRoot),
      warnings,
    };

    logger.info(
      `[ClaudeConfigImport] ${dryRun ? "(dry run) " : ""}${resolvedRoot}: instructions=${summary.projectInstructions.imported ? (summary.projectInstructions.unchanged ? "unchanged" : "imported") : "none"}, ` +
        `skills +${summary.skills.created}/~${summary.skills.updated}/=${summary.skills.unchanged} (${summary.skills.skipped.length} skipped), ` +
        `mcp +${summary.mcpServers.imported}/=${summary.mcpServers.unchanged} (${summary.mcpServers.skipped.length} skipped), ` +
        `hooks skipped=${summary.hooks.skippedCount}, agents listed=${summary.agents.found.length}`,
    );

    return summary;
  },
};

export default ClaudeConfigImportService;

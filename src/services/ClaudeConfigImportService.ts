import fs from "node:fs/promises";
import path from "node:path";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

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
//     → Prism skills (SkillService.upsertImported): frontmatter
//       name/description, body = the skill prompt. Upsert keyed by
//       name + source; a name collision with a skill NOT imported
//       from this workspace is skipped, never clobbered.
//   .mcp.json + .claude/settings.json mcpServers
//     → MCP server configs (mcp_servers collection, same shape as
//       McpServersRoutes). Imported DISABLED — configs may contain
//       arbitrary commands, so nothing is ever auto-connected; the
//       user enables each server in the UI.
//   .claude/settings.json hooks
//     → NEVER imported (arbitrary command execution on someone
//       else's trigger schedule); counted in the summary as skipped.
//
// Reads the LOCAL filesystem only — agent-served remote workspaces
// are not supported by this importer.
// ────────────────────────────────────────────────────────────

export const CLAUDE_MD_SECTION_HEADING = "Imported from CLAUDE.md";
export const CLAUDE_CONFIG_SOURCE_PREFIX = "claude-config:";

export interface ImportSkipped {
  name: string;
  reason: string;
}

export interface ClaudeConfigImportSummary {
  workspaceRoot: string;
  projectInstructions: {
    imported: boolean;
    unchanged: boolean;
    bytes: number;
    skipped: string | null;
  };
  skills: {
    created: number;
    updated: number;
    unchanged: number;
    skipped: ImportSkipped[];
  };
  mcpServers: {
    imported: number;
    unchanged: number;
    skipped: ImportSkipped[];
  };
  hooks: {
    skippedCount: number;
    note: string | null;
  };
}

export interface ClaudeConfigImportScope {
  project: string;
  username: string;
  agent?: string | null;
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

/**
 * Minimal YAML-frontmatter parser — enough for SKILL.md's flat
 * `name:` / `description:` keys. Returns the frontmatter map and the
 * body below it; a file without frontmatter is all body.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};
  if (!content.startsWith("---")) {
    return { frontmatter, body: content.trim() };
  }
  const closingIndex = content.indexOf("\n---", 3);
  if (closingIndex === -1) {
    return { frontmatter, body: content.trim() };
  }
  const header = content.slice(3, closingIndex);
  const body = content.slice(closingIndex + 4).replace(/^-*\s*/, "");
  for (const line of header.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: body.trim() };
}

function normalizeMcpEntry(
  name: string,
  entry: RawMcpServerEntry,
): {
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
} | null {
  const command = typeof entry.command === "string" ? entry.command : "";
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!command && !url) return null;

  const declaredType = (entry.type || entry.transport || "").toLowerCase();
  let transport: "stdio" | "sse" | "streamable-http";
  if (command) {
    transport = "stdio";
  } else if (declaredType === "sse") {
    transport = "sse";
  } else {
    transport = "streamable-http";
  }

  return {
    name,
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

  const { default: ProjectInstructionsService } =
    await import("#src/services/ProjectInstructionsService");
  const database = ProjectInstructionsService.getDatabase();
  if (!database) {
    return {
      imported: false,
      unchanged: false,
      bytes: 0,
      skipped: "database unavailable",
    };
  }

  const writeScope = await ProjectInstructionsService.resolveWriteScope(
    database,
    scope,
  );
  const before = await ProjectInstructionsService.getExactCurrent(
    database,
    writeScope,
  );
  const document = await ProjectInstructionsService.appendSection(
    database,
    writeScope,
    CLAUDE_MD_SECTION_HEADING,
    demoteMarkdownHeadings(content.trim()),
    "user",
  );

  const unchanged = !!before && document.version === before.version;
  return {
    imported: true,
    unchanged,
    bytes: content.length,
    skipped: null,
  };
}

async function importSkills(
  workspaceRoot: string,
  scope: ClaudeConfigImportScope,
  source: string,
): Promise<ClaudeConfigImportSummary["skills"]> {
  const summary: ClaudeConfigImportSummary["skills"] = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: [],
  };

  const skillsDirectory = path.join(workspaceRoot, ".claude", "skills");
  let entries: string[];
  try {
    entries = (await fs.readdir(skillsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return summary;
  }

  const { default: SkillService } = await import("#src/services/SkillService");

  for (const skillDirectory of entries.sort()) {
    const skillFile = path.join(skillsDirectory, skillDirectory, "SKILL.md");
    const content = await readFileIfExists(skillFile);
    if (content === null) {
      summary.skipped.push({ name: skillDirectory, reason: "no SKILL.md" });
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const name = frontmatter.name || skillDirectory;
    if (!body) {
      summary.skipped.push({ name, reason: "empty skill body" });
      continue;
    }

    const result = await SkillService.upsertImported({
      name,
      description: frontmatter.description || "",
      prompt: body,
      project: scope.project,
      source,
    });

    if ("error" in result && result.error) {
      summary.skipped.push({ name, reason: result.error });
    } else if (result.status === "created") {
      summary.created += 1;
    } else if (result.status === "updated") {
      summary.updated += 1;
    } else if (result.status === "unchanged") {
      summary.unchanged += 1;
    } else {
      summary.skipped.push({
        name,
        reason: result.reason || "skipped",
      });
    }
  }

  return summary;
}

async function importMcpServers(
  workspaceRoot: string,
  scope: ClaudeConfigImportScope,
  source: string,
  settings: Record<string, unknown> | null,
): Promise<ClaudeConfigImportSummary["mcpServers"]> {
  const summary: ClaudeConfigImportSummary["mcpServers"] = {
    imported: 0,
    unchanged: 0,
    skipped: [],
  };

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
      summary.skipped.push({
        name: ".mcp.json",
        reason: `unparseable: ${getErrorMessage(error)}`,
      });
    }
  }

  const settingsServers = settings?.mcpServers as
    Record<string, RawMcpServerEntry> | undefined;
  if (settingsServers && typeof settingsServers === "object") {
    for (const [name, entry] of Object.entries(settingsServers)) {
      if (!discovered.has(name)) discovered.set(name, entry);
    }
  }

  if (discovered.size === 0) return summary;

  const collection = MongoWrapper.getCollection(
    MONGO_DB_NAME,
    COLLECTIONS.MCP_SERVERS,
  );

  for (const [name, entry] of discovered) {
    const normalized = normalizeMcpEntry(name, entry);
    if (!normalized) {
      summary.skipped.push({ name, reason: "neither command nor url" });
      continue;
    }

    const existing = await collection.findOne({
      project: scope.project,
      username: scope.username,
      name,
    });
    if (existing) {
      // Never touch an existing config — in particular, never flip a
      // server the user already enabled, and never overwrite manual edits.
      summary.unchanged += 1;
      continue;
    }

    const now = new Date().toISOString();
    await collection.insertOne({
      project: scope.project,
      username: scope.username,
      name: normalized.name,
      displayName: normalized.name,
      transport: normalized.transport,
      command: normalized.command,
      args: normalized.args,
      env: normalized.env,
      url: normalized.url,
      headers: normalized.headers,
      // SECURITY: imported configs may contain arbitrary commands —
      // always land disabled, never auto-connect (the user enables in
      // the UI, and MCP tools stay Tier-3 DANGER regardless).
      enabled: false,
      importedFrom: source,
      createdAt: now,
      updatedAt: now,
    });
    summary.imported += 1;
  }

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

const ClaudeConfigImportService = {
  /**
   * Discover and import Claude Code assets from a workspace root.
   * Idempotent: re-running against the same workspace creates nothing new.
   */
  async importFromWorkspace(
    workspaceRoot: string,
    scope: ClaudeConfigImportScope,
  ): Promise<ClaudeConfigImportSummary | { error: string }> {
    const resolvedRoot = path.resolve(workspaceRoot);

    let rootStat;
    try {
      rootStat = await fs.stat(resolvedRoot);
    } catch {
      return { error: `Workspace path not found: ${resolvedRoot}` };
    }
    if (!rootStat.isDirectory()) {
      return { error: `Workspace path is not a directory: ${resolvedRoot}` };
    }

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

    const summary: ClaudeConfigImportSummary = {
      workspaceRoot: resolvedRoot,
      projectInstructions: await importProjectInstructions(resolvedRoot, scope),
      skills: await importSkills(resolvedRoot, scope, source),
      mcpServers: await importMcpServers(resolvedRoot, scope, source, settings),
      hooks: summarizeHooks(settings),
    };

    logger.info(
      `[ClaudeConfigImport] ${resolvedRoot}: instructions=${summary.projectInstructions.imported ? (summary.projectInstructions.unchanged ? "unchanged" : "imported") : "none"}, ` +
        `skills +${summary.skills.created}/~${summary.skills.updated}/=${summary.skills.unchanged} (${summary.skills.skipped.length} skipped), ` +
        `mcp +${summary.mcpServers.imported}/=${summary.mcpServers.unchanged} (${summary.mcpServers.skipped.length} skipped), ` +
        `hooks skipped=${summary.hooks.skippedCount}`,
    );

    return summary;
  },
};

export default ClaudeConfigImportService;

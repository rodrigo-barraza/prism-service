import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { normalizeProfileId } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import { MCP_SERVER_NAME_PATTERN } from "#src/services/mcp/McpNaming";
import {
  SKILL_FILE_NAME,
  allowedToolsOf,
  frontmatterText,
  parseSkillMarkdown,
  validateAgentSkill,
} from "./skillMarkdown.ts";
import { normalizeSkillFilePath } from "./skillFilePaths.ts";
import { readZipArchive, type ZipFile } from "./zipArchive.ts";
import {
  PLUGIN_FOLDER_LIMITS,
  SKILL_FOLDER_LIMITS,
  readLocalFolder,
  resolveInsideRegisteredWorkspace,
} from "./workspaceFolders.ts";
import {
  emptyMcpSummary,
  emptySkillSummary,
  recordSkillResult,
  recordSkippedServer,
  recordSkippedSkill,
  type McpImportSummary,
  type SkillImportSummary,
} from "./importSummary.ts";
import { importMcpServerConfigs, type ImportableMcpServer } from "./mcpServerImport.ts";

// ────────────────────────────────────────────────────────────
// AgentPluginImportService — Agent Plugins 1.0 into Prism
// ────────────────────────────────────────────────────────────
// https://agent-plugins.org/specification (1.0.0, 2026-08-06). A plugin
// is a folder: `plugin.json` (required), `skills/<id>/SKILL.md` and
// `mcp.json` (both optional). It arrives as an uploaded zip or as a path
// inside a registered workspace.
//
//   plugin.json  validated against the spec's schema. Fatal: missing,
//                not JSON, a missing or unsupported `$schema`, a bad
//                `name`, a field of the wrong type. Reported and
//                ignored: unknown top-level fields, a non-object
//                `extensions` (no extension namespace is implemented, so
//                none is read).
//   skills/      each immediate child with a SKILL.md is one skill; one
//                that breaks the Agent Skills rules is skipped and named.
//                A skill registers as `plugin:skill`, its folder stored
//                (read_skill_file), keyed by source `plugin:<name>`.
//   mcp.json     its `$schema` version must be plugin.json's. Each server
//                is validated alone (an invalid or unsupported one is
//                skipped) and lands DISABLED as `<plugin>-<server>`.
//                `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are expanded once,
//                non-recursively, in args, env values and cwd only — never
//                in command, env names or headers; a stdio `command` is a
//                bare name or a `./` path resolved inside the root; the
//                subprocess env gets PLUGIN_ROOT and PLUGIN_DATA.
//
// PLUGIN_ROOT is the plugin's own folder for a workspace import. A zip has
// no folder, so when it brings a stdio server it is extracted to
// <PRISM_PLUGINS_DIRECTORY>/<owner>/<name>/root (default ~/.prism/plugins);
// PLUGIN_DATA is .../data beside it, created before any server can run and
// kept across re-imports, as the spec requires.
//
// Bundled scripts get no privilege: the agent reads them with
// read_skill_file and runs them, if at all, through the shell tool and its
// approvals. A dry run reports every status and writes nothing.
// ────────────────────────────────────────────────────────────

export const AGENT_PLUGINS_VERSION = "1.0.0";
const SCHEMA_BASE = "https://agent-plugins.org/schemas";
const SCHEMA_PATTERN = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/(plugin|mcp)\.schema\.json$/;
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PLUGIN_NAME_MAX_CHARS = 64;
const MCP_SERVER_NAME_MAX_CHARS = 40;
const MANIFEST_STRING_FIELDS = ["version", "description", "homepage", "repository", "license"] as const;
const MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  ...MANIFEST_STRING_FIELDS,
  "author",
  "keywords",
  "extensions",
]);
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);
const PLACEHOLDER_PATTERN = /\$\{PLUGIN_(ROOT|DATA)\}/g;
const CWD_PATTERN = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;
const RESERVED_ENV_NAMES = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);
const SERVER_FIELDS: Record<string, Set<string>> = {
  stdio: new Set(["type", "command", "args", "env", "cwd"]),
  "streamable-http": new Set(["type", "url", "headers"]),
  sse: new Set(["type", "url", "headers"]),
};

export type PluginSource =
  | { kind: "workspace"; path: string }
  | { kind: "zip"; archive: Buffer; name?: string };

export interface PluginImportScope {
  project: string;
  username: string;
  /** Defaults to the request's profile. */
  profileId?: string | null;
  agent?: string | null;
}

export interface PluginManifest {
  name: string;
  version: string | null;
  description: string | null;
}

export interface PluginImportSummary {
  dryRun: boolean;
  source: "zip" | "workspace";
  plugin: PluginManifest;
  /** Where stdio servers run from (null: nothing needs a folder). */
  pluginRoot: string | null;
  /** The plugin's persistent data directory (null: no stdio server). */
  pluginData: string | null;
  warnings: string[];
  skills: SkillImportSummary;
  mcpServers: McpImportSummary;
}

interface PluginFiles {
  files: ZipFile[];
  /** The folder a workspace plugin lives in; null for a zip. */
  root: string | null;
  warnings: string[];
}

interface PluginDirectories {
  root: string;
  data: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Where zip plugins are extracted and every plugin keeps its data. */
export function pluginsDirectory(): string {
  return path.resolve(
    process.env.PRISM_PLUGINS_DIRECTORY || path.join(os.homedir(), ".prism", "plugins"),
  );
}

function ownerKey(username: string, profileId: string): string {
  return createHash("sha256").update(`${username}\n${profileId}`).digest("hex").slice(0, 16);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ── Reading the source ────────────────────────────────────────

/** A zip wrapped in one folder (`release-kit/plugin.json`) is unwrapped. */
function unwrapSingleFolder(files: ZipFile[]): ZipFile[] {
  if (files.some((file) => file.path === "plugin.json")) return files;
  const prefixes = new Set(files.map((file) => file.path.split("/")[0]));
  if (prefixes.size !== 1) return files;
  const [prefix] = prefixes;
  if (!files.some((file) => file.path === `${prefix}/plugin.json`)) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(prefix.length + 1) }));
}

async function readSource(source: PluginSource): Promise<PluginFiles | { error: string }> {
  if (source.kind === "zip") {
    const archive = readZipArchive(source.archive, {
      maxEntries: PLUGIN_FOLDER_LIMITS.maxFiles,
      maxFileBytes: PLUGIN_FOLDER_LIMITS.maxFileBytes,
      maxTotalBytes: PLUGIN_FOLDER_LIMITS.maxTotalBytes,
    });
    if ("error" in archive) {
      return { error: `The upload is not a usable plugin zip: ${archive.error}` };
    }
    return {
      files: unwrapSingleFolder(archive.files),
      root: null,
      warnings: archive.skipped.map((skipped) => `${skipped.path}: ${skipped.reason} (not extracted)`),
    };
  }

  const resolved = await resolveInsideRegisteredWorkspace(source.path);
  if ("error" in resolved) return { error: resolved.error };
  const folder = await readLocalFolder(resolved.path, PLUGIN_FOLDER_LIMITS);
  if ("error" in folder) return { error: folder.error };
  return {
    files: folder.files,
    root: resolved.path,
    warnings: folder.skipped.map((skipped) => `${skipped.path}: ${skipped.reason}`),
  };
}

// ── plugin.json ───────────────────────────────────────────────

/** The version a `$schema` URL names for `kind`, or null. */
function schemaVersion(value: unknown, kind: "plugin" | "mcp"): string | null {
  if (typeof value !== "string") return null;
  const match = SCHEMA_PATTERN.exec(value);
  return match && match[2] === kind ? match[1] : null;
}

export function validatePluginManifest(
  value: unknown,
): { manifest: PluginManifest; warnings: string[] } | { error: string } {
  const expectedSchema = `${SCHEMA_BASE}/${AGENT_PLUGINS_VERSION}/plugin.schema.json`;
  if (!isPlainObject(value)) return { error: "plugin.json must be a JSON object" };
  if (schemaVersion(value.$schema, "plugin") !== AGENT_PLUGINS_VERSION) {
    return {
      error:
        value.$schema === undefined
          ? `plugin.json has no $schema; Agent Plugins ${AGENT_PLUGINS_VERSION} requires "${expectedSchema}"`
          : `plugin.json $schema ${JSON.stringify(value.$schema)} is not supported; this client reads "${expectedSchema}"`,
    };
  }

  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    return { error: "plugin.json needs a name (a non-empty string)" };
  }
  if (name.length > PLUGIN_NAME_MAX_CHARS || !PLUGIN_NAME_PATTERN.test(name)) {
    return {
      error: `plugin.json name "${name}" must be 1–${PLUGIN_NAME_MAX_CHARS} of a-z, 0-9, '.' and '-', starting and ending with a letter or digit, with no '--' or '..'`,
    };
  }
  for (const field of MANIFEST_STRING_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return { error: `plugin.json ${field} must be a string` };
    }
  }
  if (value.author !== undefined) {
    const author = value.author;
    if (
      !isPlainObject(author) ||
      Object.entries(author).some(
        ([key, entry]) => !AUTHOR_FIELDS.has(key) || typeof entry !== "string",
      )
    ) {
      return { error: "plugin.json author must be an object of name, email and url strings" };
    }
  }
  if (
    value.keywords !== undefined &&
    (!Array.isArray(value.keywords) || value.keywords.some((keyword) => typeof keyword !== "string"))
  ) {
    return { error: "plugin.json keywords must be a list of strings" };
  }

  const warnings: string[] = [];
  if (value.extensions !== undefined && !isPlainObject(value.extensions)) {
    warnings.push("plugin.json extensions is not an object — ignored");
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_FIELDS.has(key)) warnings.push(`plugin.json: unknown field "${key}" ignored`);
  }
  return {
    manifest: {
      name,
      version: typeof value.version === "string" ? value.version : null,
      description: typeof value.description === "string" ? value.description : null,
    },
    warnings,
  };
}

// ── mcp.json ──────────────────────────────────────────────────

/** `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, once, non-recursively. */
export function expandPluginPlaceholders(text: string, directories: PluginDirectories): string {
  return text.replace(PLACEHOLDER_PATTERN, (_match, which: string) =>
    which === "ROOT" ? directories.root : directories.data,
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) return host === "::1";
  return false;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  return Object.values(value).every((entry) => typeof entry === "string")
    ? (value as Record<string, string>)
    : null;
}

function resolveCwd(cwd: string, directories: PluginDirectories): string | null {
  if (!CWD_PATTERN.test(cwd)) return null;
  const [base, rest] = cwd.startsWith("./")
    ? [directories.root, cwd.slice(2)]
    : cwd.startsWith("${PLUGIN_ROOT}")
      ? [directories.root, cwd.slice("${PLUGIN_ROOT}".length)]
      : [directories.data, cwd.slice("${PLUGIN_DATA}".length)];
  const resolved = path.resolve(base, `.${rest.startsWith("/") ? "" : "/"}${rest}`);
  return isWithin(base, resolved) ? resolved : null;
}

/** One mcp.json entry as Prism will store it, or why it is skipped. */
function validateServer(
  pluginName: string,
  serverId: string,
  entry: unknown,
  directories: PluginDirectories,
): { server: ImportableMcpServer } | { reason: string; transport?: string } {
  if (!isPlainObject(entry)) return { reason: "not an object" };
  const type = entry.type;
  if (typeof type !== "string") return { reason: "no transport type" };
  const allowedFields = SERVER_FIELDS[type];
  if (!allowedFields) return { reason: `unsupported transport "${type}"`, transport: type };
  const unknown = Object.keys(entry).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) {
    return { reason: `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`, transport: type };
  }

  const name = `${pluginName}-${serverId}`.replace(/\./g, "-");
  if (name.length > MCP_SERVER_NAME_MAX_CHARS || !MCP_SERVER_NAME_PATTERN.test(name)) {
    return {
      reason: `"${name}" is not a usable server name (up to ${MCP_SERVER_NAME_MAX_CHARS} letters and digits joined by single '-' or '_')`,
      transport: type,
    };
  }
  const base = {
    name,
    displayName: `${pluginName} · ${serverId}`,
    command: "",
    args: [] as string[],
    env: {} as Record<string, string>,
    url: "",
    headers: {} as Record<string, string>,
  };

  if (type === "stdio") {
    const command = entry.command;
    if (typeof command !== "string" || command.length === 0) return { reason: "no command", transport: type };
    let resolvedCommand: string;
    if (command.startsWith("./")) {
      const relative = normalizeSkillFilePath(command.slice(2));
      if ("error" in relative) return { reason: `command ${command} leaves the plugin root`, transport: type };
      resolvedCommand = path.join(directories.root, ...relative.path.split("/"));
    } else if (/[\s\\/]/.test(command)) {
      return {
        reason: `command "${command}" must be a single executable name or a ./ path inside the plugin`,
        transport: type,
      };
    } else {
      resolvedCommand = command;
    }
    const args = entry.args ?? [];
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
      return { reason: "args must be a list of strings", transport: type };
    }
    const env = stringRecord(entry.env);
    if (!env) return { reason: "env must map names to strings", transport: type };
    const reserved = Object.keys(env).filter((key) => RESERVED_ENV_NAMES.has(key));
    if (reserved.length > 0) {
      return { reason: `env may not set ${reserved.join(" or ")} (the client sets them)`, transport: type };
    }
    let cwd = directories.root;
    if (entry.cwd !== undefined) {
      const resolvedCwd = typeof entry.cwd === "string" ? resolveCwd(entry.cwd, directories) : null;
      if (!resolvedCwd) {
        return {
          reason: `cwd ${JSON.stringify(entry.cwd)} must start with ./, \${PLUGIN_ROOT} or \${PLUGIN_DATA} and stay inside it`,
          transport: type,
        };
      }
      cwd = resolvedCwd;
    }
    const expandedEnv = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, expandPluginPlaceholders(value, directories)]),
    );
    return {
      server: {
        ...base,
        transport: "stdio",
        command: resolvedCommand,
        args: (args as string[]).map((argument) => expandPluginPlaceholders(argument, directories)),
        // The plugin's env overlays the base environment; the client's
        // PLUGIN_ROOT / PLUGIN_DATA go on last.
        env: { ...expandedEnv, PLUGIN_ROOT: directories.root, PLUGIN_DATA: directories.data },
        cwd,
      },
    };
  }

  const url = entry.url;
  if (typeof url !== "string" || url.length === 0) return { reason: "no url", transport: type };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { reason: `url "${url}" is not an absolute URL`, transport: type };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { reason: `url "${url}" is not http(s)`, transport: type };
  }
  if (parsed.username || parsed.password || url.includes("#")) {
    return { reason: `url "${url}" may not carry user info or a fragment`, transport: type };
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    return { reason: `url "${url}" must use https (http is only for localhost)`, transport: type };
  }
  const headers = stringRecord(entry.headers);
  if (!headers) return { reason: "headers must map names to strings", transport: type };
  const lowered = Object.keys(headers).map((key) => key.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    return { reason: "headers repeat a name (case-insensitively)", transport: type };
  }
  return {
    server: {
      ...base,
      transport: type === "sse" ? "sse" : "streamable-http",
      url,
      // Never expanded, per the spec.
      headers,
    },
  };
}

function readMcpConfig(
  files: Map<string, Buffer>,
  pluginName: string,
  directories: PluginDirectories,
  summary: McpImportSummary,
  warnings: string[],
): ImportableMcpServer[] {
  const raw = files.get("mcp.json");
  if (!raw) return [];
  let config: unknown;
  try {
    config = JSON.parse(raw.toString("utf8"));
  } catch (error: unknown) {
    warnings.push(`mcp.json is not valid JSON (${getErrorMessage(error)}) — no MCP servers imported`);
    return [];
  }
  if (!isPlainObject(config)) {
    warnings.push("mcp.json is not a JSON object — no MCP servers imported");
    return [];
  }
  if (schemaVersion(config.$schema, "mcp") !== AGENT_PLUGINS_VERSION) {
    warnings.push(
      `mcp.json $schema ${JSON.stringify(config.$schema)} must be "${SCHEMA_BASE}/${AGENT_PLUGINS_VERSION}/mcp.schema.json" (plugin.json's version) — no MCP servers imported`,
    );
    return [];
  }
  if (!isPlainObject(config.mcpServers)) {
    warnings.push("mcp.json mcpServers is not an object — no MCP servers imported");
    return [];
  }
  for (const key of Object.keys(config)) {
    if (key !== "$schema" && key !== "mcpServers") warnings.push(`mcp.json: unknown field "${key}" ignored`);
  }

  const servers: ImportableMcpServer[] = [];
  for (const [serverId, entry] of Object.entries(config.mcpServers).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const validated = validateServer(pluginName, serverId, entry, directories);
    if ("server" in validated) servers.push(validated.server);
    else recordSkippedServer(summary, serverId, validated.reason, validated.transport ?? null);
  }
  return servers;
}

// ── skills/ ───────────────────────────────────────────────────

async function importPluginSkills(
  files: ZipFile[],
  pluginName: string,
  scope: PluginImportScope,
  profileId: string,
  summary: SkillImportSummary,
  warnings: string[],
  dryRun: boolean,
): Promise<void> {
  if (files.some((file) => file.path === "skills")) {
    warnings.push("skills is a file, not a directory — no skills imported");
    return;
  }
  const skillDirectories = [
    ...new Set(
      files
        .map((file) => /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path)?.[1])
        .filter((directory): directory is string => !!directory),
    ),
  ].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
  if (skillDirectories.length === 0) return;

  const { default: SkillService, resolveSkillCaller } = await import("#src/services/SkillService");
  // Plugin skills serve every persona in the importer's project/user/profile.
  const caller = resolveSkillCaller({
    project: scope.project,
    username: scope.username,
    profileId,
    agent: null,
  });
  const source = `plugin:${pluginName}`;

  for (const directory of skillDirectories) {
    const prefix = `skills/${directory}/`;
    const folder = files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ path: file.path.slice(prefix.length), content: file.content }));
    const skillFile = folder.find((file) => file.path === SKILL_FILE_NAME)!;
    const { frontmatter, body, error } = parseSkillMarkdown(skillFile.content.toString("utf8"));
    const base = {
      name: directory,
      description: frontmatterText(frontmatter.description),
      allowedTools: allowedToolsOf(frontmatter),
      files: folder.map((file) => file.path).sort(),
    };
    const invalid =
      error ??
      validateAgentSkill(frontmatter, directory) ??
      (body ? null : "empty skill body") ??
      (folder.length > SKILL_FOLDER_LIMITS.maxFiles
        ? `more than ${SKILL_FOLDER_LIMITS.maxFiles} files`
        : null) ??
      (folder.reduce((total, file) => total + file.content.length, 0) > SKILL_FOLDER_LIMITS.maxTotalBytes
        ? `more than ${SKILL_FOLDER_LIMITS.maxTotalBytes} bytes`
        : null);
    if (invalid) {
      recordSkippedSkill(summary, base, invalid);
      continue;
    }

    const item = { ...base, name: `${pluginName}:${frontmatterText(frontmatter.name)}` };
    const result = await SkillService.upsertImported(
      {
        name: item.name,
        description: item.description,
        body,
        source,
        allowedTools: item.allowedTools,
        files: folder,
      },
      caller,
      { dryRun },
    );
    recordSkillResult(summary, item, result);
  }
}

// ── Extraction (a zip with stdio servers) ─────────────────────

async function extractPlugin(files: ZipFile[], root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  for (const file of files) {
    const normalized = normalizeSkillFilePath(file.path);
    if ("error" in normalized) throw new Error(normalized.error);
    const target = path.join(root, ...normalized.path.split("/"));
    if (!isWithin(root, target) || target === root) throw new Error(`"${file.path}" leaves the plugin root`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, { flag: "wx" });
    if (file.mode) await fs.chmod(target, file.mode & 0o755);
  }
}

const AgentPluginImportService = {
  async importPlugin(
    source: PluginSource,
    scope: PluginImportScope,
    { dryRun = false }: { dryRun?: boolean } = {},
  ): Promise<PluginImportSummary | { error: string }> {
    const read = await readSource(source);
    if ("error" in read) return read;
    const byPath = new Map(read.files.map((file) => [file.path, file.content]));

    const manifestRaw = byPath.get("plugin.json");
    if (!manifestRaw) return { error: "No plugin.json at the plugin root — not an Agent Plugins plugin." };
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw.toString("utf8"));
    } catch (error: unknown) {
      return { error: `plugin.json is not valid JSON: ${getErrorMessage(error)}` };
    }
    const validated = validatePluginManifest(manifestJson);
    if ("error" in validated) return validated;
    const { manifest } = validated;
    const warnings = [...validated.warnings, ...read.warnings];

    const profileId = normalizeProfileId(scope.profileId ?? getRequestContext().profileId);
    const home = path.join(pluginsDirectory(), ownerKey(scope.username, profileId), manifest.name);
    const directories: PluginDirectories = {
      root: read.root ?? path.join(home, "root"),
      data: path.join(home, "data"),
    };

    const skills = emptySkillSummary();
    await importPluginSkills(read.files, manifest.name, scope, profileId, skills, warnings, dryRun);

    const mcpServers = emptyMcpSummary();
    const servers = readMcpConfig(byPath, manifest.name, directories, mcpServers, warnings);
    const needsFolder = servers.some((server) => server.transport === "stdio");
    if (needsFolder && !dryRun) {
      if (!read.root) await extractPlugin(read.files, directories.root);
      await fs.mkdir(directories.data, { recursive: true });
    }
    await importMcpServerConfigs(
      servers,
      { project: scope.project, username: scope.username, profileId },
      `plugin:${manifest.name}`,
      mcpServers,
      { dryRun },
    );

    const summary: PluginImportSummary = {
      dryRun,
      source: source.kind,
      plugin: manifest,
      pluginRoot: read.root ?? (needsFolder ? directories.root : null),
      pluginData: needsFolder ? directories.data : null,
      warnings,
      skills,
      mcpServers,
    };
    logger.info(
      `[AgentPluginImport] ${dryRun ? "(dry run) " : ""}${manifest.name}@${manifest.version ?? "?"} from ${source.kind === "zip" ? (source.name ?? "an upload") : source.path}: ` +
        `skills +${skills.created}/~${skills.updated}/=${skills.unchanged} (${skills.skipped.length} skipped), ` +
        `mcp +${mcpServers.imported}/=${mcpServers.unchanged} (${mcpServers.skipped.length} skipped), ${warnings.length} warnings`,
    );
    return summary;
  },
};

export default AgentPluginImportService;

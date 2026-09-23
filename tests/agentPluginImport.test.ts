/**
 * Agent Plugins 1.0 import (prompt 19, Landing 2) on the fixture plugin
 * `tests/fixtures/plugins/release-kit`: from a path inside a registered
 * workspace and from an uploaded zip. Skills register as `plugin:skill`
 * with their folders stored; mcp.json servers land DISABLED with
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expanded where the spec says (args,
 * env values, cwd — never command or headers); invalid pieces are skipped
 * and named, invalid manifests refused.
 *
 * Mongo is the in-memory mock; SkillService, the folder store (filesystem
 * backend) and the importer run for real in temp directories.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockCollection } from "./mongoMock.ts";
import { writeZip, zipDirectory } from "./fixtures/zipWriter.ts";

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    createClient: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn(),
  },
}));

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue(null) },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const registered = vi.hoisted(() => ({ roots: [] as string[] }));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: { getWorkspaceRoots: () => registered.roots },
}));

import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { requestContext } from "#src/utils/RequestContext";
import AgentPluginImportService from "#src/services/skills/AgentPluginImportService";
import SkillFolderStore from "#src/services/skills/SkillFolderStore";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "plugins", "release-kit");
const SCOPE = { project: "prism-chat", username: "alice", agent: null };

let sandbox: string;
let workspace: string;
let pluginPath: string;
let pluginsDirectory: string;
const saved: Record<string, string | undefined> = {};

function importAs<T>(work: () => Promise<T>, profileId = "default"): Promise<T> {
  return requestContext.run(
    { project: SCOPE.project, username: SCOPE.username, profileId, clientIp: null, agent: null },
    work,
  );
}

async function copyDirectory(from: string, to: string) {
  await fs.cp(from, to, { recursive: true });
}

beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-import-"));
  workspace = path.join(sandbox, "workspace");
  pluginPath = path.join(workspace, "plugins", "release-kit");
  pluginsDirectory = path.join(sandbox, "plugins-home");
  await copyDirectory(FIXTURE, pluginPath);
  for (const name of ["PRISM_SKILL_FOLDERS_DIRECTORY", "PRISM_PLUGINS_DIRECTORY"]) {
    saved[name] = process.env[name];
  }
  process.env.PRISM_SKILL_FOLDERS_DIRECTORY = path.join(sandbox, "skill-folders");
  process.env.PRISM_PLUGINS_DIRECTORY = pluginsDirectory;
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

let skills: ReturnType<typeof createMockCollection>;
let servers: ReturnType<typeof createMockCollection>;

beforeEach(() => {
  registered.roots = [workspace];
  skills = createMockCollection([]);
  servers = createMockCollection([]);
  vi.mocked(MongoWrapper.getCollection).mockImplementation(
    (_database: string, name: string) =>
      (name === COLLECTIONS.AGENT_SKILLS
        ? skills
        : name === COLLECTIONS.MCP_SERVERS
          ? servers
          : null) as any,
  );
});

const rows = (collection: ReturnType<typeof createMockCollection>) =>
  [...collection._docs.values()] as Array<Record<string, any>>;

function expectReleaseKitSkills() {
  const stored = rows(skills).sort((left, right) => (left.name < right.name ? -1 : 1));
  expect(stored.map((skill) => skill.name)).toEqual([
    "release-kit:lint-changelog",
    "release-kit:release-notes",
  ]);
  const [lint, notes] = stored;
  expect(notes).toMatchObject({
    description: "Write release notes for a tagged version from the commit log.",
    allowedTools: ["read_file", "execute_command"],
    source: "plugin:release-kit",
    project: "prism-chat",
    username: "alice",
    profileId: "default",
    agent: null,
    enabled: true,
  });
  expect(notes.content).toContain("Read `references/template.md` with read_skill_file");
  expect(notes.content).not.toContain("allowed-tools");
  expect(notes.folderRef).toMatch(/^file:/);
  expect(notes.resources.map((resource: { path: string }) => resource.path)).toEqual([
    "SKILL.md",
    "references/template.md",
    "scripts/collect.sh",
  ]);
  expect(lint.allowedTools).toEqual(["read_file", "grep_search"]);
  return { lint, notes };
}

describe("AgentPluginImportService — from a workspace path", () => {
  it("registers plugin:skill skills with their folders; invalid ones are skipped and named", async () => {
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);

    expect(summary.plugin).toEqual({
      name: "release-kit",
      version: "1.2.0",
      description: "Release notes and a changelog linter",
    });
    expect(summary.skills).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    expect(summary.skills.skipped).toEqual([
      { name: "Bad_Name", reason: expect.stringMatching(/lowercase/) },
    ]);
    expect(summary.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/homepageUrl/)]),
    );

    const { notes } = expectReleaseKitSkills();
    const template = await SkillFolderStore.read(notes.folderRef, "references/template.md");
    expect(template.toString("utf8")).toContain("WILLOW-7");
  });

  it("imports mcp.json servers disabled, with PLUGIN_ROOT / PLUGIN_DATA expanded where the spec says", async () => {
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);

    const pluginRoot = await fs.realpath(pluginPath);
    const pluginData = summary.pluginData!;
    expect(summary.pluginRoot).toBe(pluginRoot);
    expect(pluginData.startsWith(pluginsDirectory)).toBe(true);
    expect((await fs.stat(pluginData)).isDirectory()).toBe(true);

    expect(summary.mcpServers.imported).toBe(2);
    expect(summary.mcpServers.skipped.map((skipped) => skipped.name).sort()).toEqual([
      "escape-cwd",
      "plain-http",
      "sneaky-env",
      "websocket",
    ]);

    const byName = new Map(rows(servers).map((server) => [server.name, server]));
    expect(byName.get("release-kit-changelog-validator")).toMatchObject({
      transport: "stdio",
      enabled: false,
      importedFrom: "plugin:release-kit",
      username: "alice",
      profileId: "default",
      // command: resolved against the root, never placeholder-expanded
      command: path.join(pluginRoot, "bin", "validator"),
      args: ["--data", `${pluginData}/validator`, `--root=${pluginRoot}`, "${HOME}"],
      env: {
        CONFIG: `${pluginRoot}/config.json`,
        PLUGIN_ROOT: pluginRoot,
        PLUGIN_DATA: pluginData,
      },
      cwd: pluginRoot,
    });
    expect(byName.get("release-kit-release-api")).toMatchObject({
      transport: "streamable-http",
      enabled: false,
      url: "https://release.example.com/mcp",
      // headers are never expanded
      headers: { "X-Tenant": "tenant-${PLUGIN_ROOT}" },
    });
  });

  it("is idempotent — a second import changes nothing", async () => {
    await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
    );
    const firstRefs = rows(skills).map((skill) => skill.folderRef).sort();
    const second = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
    );
    if ("error" in second) throw new Error(second.error);
    expect(second.skills).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(second.mcpServers).toMatchObject({ imported: 0, unchanged: 2 });
    expect(rows(skills)).toHaveLength(2);
    expect(rows(servers)).toHaveLength(2);
    expect(rows(skills).map((skill) => skill.folderRef).sort()).toEqual(firstRefs);
  });

  it("never enables or rewrites a server the user already has under that name", async () => {
    await servers.insertOne({
      _id: "mine",
      username: "alice",
      profileId: "default",
      name: "release-kit-release-api",
      transport: "streamable-http",
      url: "https://mine.example.com/mcp",
      enabled: true,
    });
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);
    expect(summary.mcpServers).toMatchObject({ imported: 1, unchanged: 1 });
    expect(rows(servers).find((server) => server._id === "mine")).toMatchObject({
      url: "https://mine.example.com/mcp",
      enabled: true,
    });
  });

  it("a dry run previews everything and writes nothing", async () => {
    const preview = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE, {
        dryRun: true,
      }),
    );
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.dryRun).toBe(true);
    // Folder order (bytes): "Bad_Name" sorts before the lowercase names.
    expect(preview.skills.items.map((item) => [item.name, item.status])).toEqual([
      ["Bad_Name", "skipped"],
      ["release-kit:lint-changelog", "created"],
      ["release-kit:release-notes", "created"],
    ]);
    expect(
      preview.skills.items.find((item) => item.name === "release-kit:release-notes")!.files,
    ).toEqual(["SKILL.md", "references/template.md", "scripts/collect.sh"]);
    expect(preview.mcpServers.items.filter((item) => item.status === "imported")).toHaveLength(2);
    expect(rows(skills)).toHaveLength(0);
    expect(rows(servers)).toHaveLength(0);
  });

  it("refuses a path outside every registered workspace", async () => {
    registered.roots = [path.join(sandbox, "some-other-workspace")];
    const result = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
    );
    expect(result).toEqual({ error: expect.stringMatching(/registered workspace/) });
    expect(rows(skills)).toHaveLength(0);
  });

  it("refuses a symlink that climbs out of the registered workspace", async () => {
    const outside = path.join(sandbox, "outside-plugin");
    await copyDirectory(FIXTURE, outside);
    const link = path.join(workspace, "linked-plugin");
    await fs.symlink(outside, link);
    try {
      const result = await importAs(() =>
        AgentPluginImportService.importPlugin({ kind: "workspace", path: link }, SCOPE),
      );
      expect(result).toEqual({ error: expect.stringMatching(/registered workspace/) });
    } finally {
      await fs.rm(link, { force: true });
    }
  });

  it("does not follow a symlink inside the plugin out of it", async () => {
    const secret = path.join(sandbox, "secret.txt");
    await fs.writeFile(secret, "TOP SECRET");
    const planted = path.join(pluginPath, "skills", "release-notes", "references", "leak.md");
    await fs.symlink(secret, planted);
    try {
      const summary = await importAs(() =>
        AgentPluginImportService.importPlugin({ kind: "workspace", path: pluginPath }, SCOPE),
      );
      if ("error" in summary) throw new Error(summary.error);
      const notes = rows(skills).find((skill) => skill.name === "release-kit:release-notes")!;
      expect(notes.resources.map((resource: { path: string }) => resource.path)).not.toContain(
        "references/leak.md",
      );
      expect(summary.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/leak\.md.*symbolic link/)]),
      );
    } finally {
      await fs.rm(planted, { force: true });
    }
  });
});

describe("AgentPluginImportService — from an uploaded zip", () => {
  it("imports the same plugin from an archive wrapped in its folder", async () => {
    const archive = await zipDirectory(FIXTURE, "release-kit/");
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "zip", archive, name: "release-kit.zip" }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);
    expect(summary.skills).toMatchObject({ created: 2 });
    expectReleaseKitSkills();

    // A zip has no directory of its own: stdio servers need one, so the
    // plugin is extracted under PRISM_PLUGINS_DIRECTORY and runs from there.
    const pluginRoot = summary.pluginRoot!;
    expect(pluginRoot.startsWith(pluginsDirectory)).toBe(true);
    expect(await fs.readFile(path.join(pluginRoot, "bin", "validator"), "utf8")).toContain(
      "validator",
    );
    const validator = rows(servers).find((server) => server.name === "release-kit-changelog-validator")!;
    expect(validator.command).toBe(path.join(pluginRoot, "bin", "validator"));
    expect(validator.enabled).toBe(false);
  });

  it("a plugin without stdio servers is not extracted anywhere", async () => {
    const archive = writeZip([
      {
        name: "plugin.json",
        content: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "tiny",
        }),
      },
      { name: "skills/hello/SKILL.md", content: "---\nname: hello\ndescription: Say hi\n---\nSay hi." },
    ]);
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "zip", archive }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);
    expect(summary.pluginRoot).toBeNull();
    expect(rows(skills).map((skill) => skill.name)).toEqual(["tiny:hello"]);
  });

  it("refuses an archive with an entry that climbs out (zip slip)", async () => {
    const archive = writeZip([
      { name: "release-kit/plugin.json", content: await fs.readFile(path.join(FIXTURE, "plugin.json")) },
      { name: "release-kit/../../evil.sh", content: "rm -rf /" },
    ]);
    const result = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "zip", archive }, SCOPE),
    );
    expect(result).toEqual({ error: expect.stringMatching(/unsafe entry/) });
  });
});

describe("plugin.json validation", () => {
  const manifestCases: Array<[string, unknown, RegExp]> = [
    ["a missing $schema", { name: "x" }, /\$schema/],
    [
      "an unsupported schema version",
      { $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", name: "x" },
      /\$schema/,
    ],
    [
      "a name with uppercase",
      { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Release_Kit" },
      /name/,
    ],
    [
      "a name with '--'",
      { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "a--b" },
      /name/,
    ],
    [
      "a missing name",
      { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" },
      /name/,
    ],
    [
      "an author with an unknown field",
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "x",
        author: { name: "a", twitter: "@a" },
      },
      /author/,
    ],
    [
      "keywords that are not strings",
      { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "x", keywords: [1] },
      /keywords/,
    ],
  ];

  it.each(manifestCases)("refuses %s", async (_label, manifest, message) => {
    const archive = writeZip([{ name: "plugin.json", content: JSON.stringify(manifest) }]);
    const result = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "zip", archive }, SCOPE),
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(message);
  });

  it("refuses a plugin without plugin.json, or with invalid JSON", async () => {
    for (const archive of [
      writeZip([{ name: "skills/a/SKILL.md", content: "x" }]),
      writeZip([{ name: "plugin.json", content: "{ not json" }]),
    ]) {
      const result = await importAs(() =>
        AgentPluginImportService.importPlugin({ kind: "zip", archive }, SCOPE),
      );
      expect(result).toEqual({ error: expect.stringMatching(/plugin\.json/) });
    }
  });

  it("reports and ignores a non-object extensions field", async () => {
    const archive = writeZip([
      {
        name: "plugin.json",
        content: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "x",
          extensions: "nope",
        }),
      },
    ]);
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "zip", archive }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);
    expect(summary.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/extensions/)]));
  });

  it("an mcp.json whose schema version is not the plugin's is invalid; skills still load", async () => {
    const archive = writeZip([
      {
        name: "plugin.json",
        content: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "mixed",
        }),
      },
      {
        name: "mcp.json",
        content: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
          mcpServers: { api: { type: "streamable-http", url: "https://x.example.com/mcp" } },
        }),
      },
      { name: "skills/hello/SKILL.md", content: "---\nname: hello\ndescription: Say hi\n---\nSay hi." },
    ]);
    const summary = await importAs(() =>
      AgentPluginImportService.importPlugin({ kind: "zip", archive }, SCOPE),
    );
    if ("error" in summary) throw new Error(summary.error);
    expect(summary.skills.created).toBe(1);
    expect(summary.mcpServers.imported).toBe(0);
    expect(summary.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/mcp\.json/)]));
  });
});

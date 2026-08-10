import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ────────────────────────────────────────────────────────────
// ClaudeConfigImportService — .claude config inheritance.
// A fixture workspace is materialized in a temp directory
// (CLAUDE.md + two skills + .mcp.json + settings.json with
// mcpServers AND hooks); Mongo and ProjectInstructionsService
// storage are in-memory doubles, SkillService runs for real.
// ────────────────────────────────────────────────────────────

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── In-memory Mongo double (agent_skills + mcp_servers) ─────

interface FakeRow {
  [key: string]: unknown;
}

const store = vi.hoisted(() => ({
  collections: new Map<string, FakeRow[]>(),
}));

function matches(row: FakeRow, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: (_databaseName: string, collectionName: string) => {
      if (!store.collections.has(collectionName)) {
        store.collections.set(collectionName, []);
      }
      const rows = store.collections.get(collectionName)!;
      return {
        findOne: async (filter: Record<string, unknown>) =>
          rows.find((row) => matches(row, filter)) ?? null,
        insertOne: async (document: FakeRow) => {
          rows.push(structuredClone(document));
          return { insertedId: rows.length };
        },
        updateOne: async (
          filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown> },
        ) => {
          const found = rows.find((row) => matches(row, filter));
          if (found && update.$set) Object.assign(found, update.$set);
          return { matchedCount: found ? 1 : 0 };
        },
      };
    },
    getDb: () => ({}),
  },
}));

// ── ProjectInstructionsService double (real section merging) ─

const instructionsStore = vi.hoisted(() => ({
  current: null as { content: string; version: number } | null,
}));

vi.mock("#src/services/ProjectInstructionsService", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("#src/services/ProjectInstructionsService")
    >();
  return {
    ...actual,
    default: {
      ...actual.default,
      getDatabase: () => ({}),
      resolveWriteScope: async (_db: unknown, scope: unknown) => scope,
      getExactCurrent: async () => instructionsStore.current,
      appendSection: async (
        _db: unknown,
        _scope: unknown,
        heading: string,
        body: string,
      ) => {
        const nextContent = actual.upsertMarkdownSection(
          instructionsStore.current?.content ?? "",
          heading,
          body,
        );
        if (
          instructionsStore.current &&
          nextContent === instructionsStore.current.content
        ) {
          return instructionsStore.current;
        }
        instructionsStore.current = {
          content: nextContent,
          version: (instructionsStore.current?.version ?? 0) + 1,
        };
        return instructionsStore.current;
      },
    },
  };
});

const { default: ClaudeConfigImportService, parseFrontmatter } =
  await import("#src/services/ClaudeConfigImportService");
const { COLLECTIONS } = await import("#src/constants");

// ── Fixture workspace ───────────────────────────────────────

let workspaceRoot: string;

const SCOPE = { project: "test-project", username: "test-user", agent: null };

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-config-fixture-"),
  );

  await fs.writeFile(
    path.join(workspaceRoot, "CLAUDE.md"),
    "# Test Project\n\nAlways use tabs. Never push to main.\n",
  );

  await fs.mkdir(path.join(workspaceRoot, ".claude", "skills", "deploy"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspaceRoot, ".claude", "skills", "deploy", "SKILL.md"),
    [
      "---",
      "name: deploy-app",
      "description: Deploy the app to staging",
      "---",
      "",
      "Run the deploy pipeline, then smoke-test staging.",
    ].join("\n"),
  );

  await fs.mkdir(path.join(workspaceRoot, ".claude", "skills", "review"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(workspaceRoot, ".claude", "skills", "review", "SKILL.md"),
    "Review the current diff for correctness bugs.\n",
  );

  await fs.writeFile(
    path.join(workspaceRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { LOG_LEVEL: "info" },
        },
      },
    }),
  );

  await fs.writeFile(
    path.join(workspaceRoot, ".claude", "settings.json"),
    JSON.stringify({
      mcpServers: {
        "remote-api": { url: "https://example.com/mcp", type: "http" },
      },
      hooks: {
        PostToolUse: [{ matcher: "Bash", command: "echo hi" }],
        Stop: [{ command: "notify-send done" }],
      },
    }),
  );
});

afterAll(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store.collections.clear();
  instructionsStore.current = null;
});

describe("parseFrontmatter", () => {
  it("parses flat frontmatter and returns the body", () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nname: x\ndescription: "y z"\n---\n\nbody text',
    );
    expect(frontmatter).toEqual({ name: "x", description: "y z" });
    expect(body).toBe("body text");
  });

  it("treats files without frontmatter as all body", () => {
    const { frontmatter, body } = parseFrontmatter("just a prompt");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just a prompt");
  });
});

describe("importFromWorkspace", () => {
  it("imports CLAUDE.md, both skills, and mcp servers; skips hooks", async () => {
    const summary = await ClaudeConfigImportService.importFromWorkspace(
      workspaceRoot,
      SCOPE,
    );
    expect(summary).not.toHaveProperty("error");
    if ("error" in summary) return;

    expect(summary.projectInstructions).toMatchObject({
      imported: true,
      unchanged: false,
    });
    expect(instructionsStore.current?.content).toContain(
      "## Imported from CLAUDE.md",
    );
    expect(instructionsStore.current?.content).toContain("Never push to main.");
    // Headings are demoted so the CLAUDE.md body nests inside the section.
    expect(instructionsStore.current?.content).toContain("### Test Project");

    expect(summary.skills).toMatchObject({
      created: 2,
      updated: 0,
      unchanged: 0,
    });
    const skills = store.collections.get(COLLECTIONS.AGENT_SKILLS)!;
    expect(skills.map((skill) => skill.skillId).sort()).toEqual([
      "deploy_app",
      "review",
    ]);
    expect(
      skills.every((skill) => (skill.source as string).endsWith(workspaceRoot)),
    ).toBe(true);

    expect(summary.mcpServers).toMatchObject({ imported: 2, unchanged: 0 });
    const mcpServers = store.collections.get(COLLECTIONS.MCP_SERVERS)!;
    const filesystem = mcpServers.find(
      (server) => server.name === "filesystem",
    )!;
    const remote = mcpServers.find((server) => server.name === "remote-api")!;
    expect(filesystem).toMatchObject({
      transport: "stdio",
      command: "npx",
      enabled: false,
    });
    expect(remote).toMatchObject({
      transport: "streamable-http",
      url: "https://example.com/mcp",
      enabled: false,
    });

    expect(summary.hooks.skippedCount).toBe(2);
    expect(summary.hooks.note).toContain("never imported");
  });

  it("is idempotent — importing twice creates no duplicates", async () => {
    await ClaudeConfigImportService.importFromWorkspace(workspaceRoot, SCOPE);
    const second = await ClaudeConfigImportService.importFromWorkspace(
      workspaceRoot,
      SCOPE,
    );
    expect(second).not.toHaveProperty("error");
    if ("error" in second) return;

    expect(second.projectInstructions).toMatchObject({
      imported: true,
      unchanged: true,
    });
    expect(second.skills).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
    });
    expect(second.mcpServers).toMatchObject({ imported: 0, unchanged: 2 });

    expect(store.collections.get(COLLECTIONS.AGENT_SKILLS)).toHaveLength(2);
    expect(store.collections.get(COLLECTIONS.MCP_SERVERS)).toHaveLength(2);
    expect(instructionsStore.current?.version).toBe(1);
  });

  it("never clobbers a user-created skill with the same name", async () => {
    store.collections.set(COLLECTIONS.AGENT_SKILLS, [
      {
        skillId: "deploy_app",
        name: "deploy-app",
        prompt: "the user's own deploy skill",
        description: "hands off",
      },
    ]);

    const summary = await ClaudeConfigImportService.importFromWorkspace(
      workspaceRoot,
      SCOPE,
    );
    if ("error" in summary) throw new Error(summary.error);

    expect(summary.skills.created).toBe(1); // only "review"
    expect(summary.skills.skipped).toHaveLength(1);
    expect(summary.skills.skipped[0]).toMatchObject({ name: "deploy-app" });

    const userSkill = store.collections
      .get(COLLECTIONS.AGENT_SKILLS)!
      .find((skill) => skill.skillId === "deploy_app")!;
    expect(userSkill.prompt).toBe("the user's own deploy skill");
  });

  it("never enables an mcp server the user already configured", async () => {
    store.collections.set(COLLECTIONS.MCP_SERVERS, [
      {
        project: SCOPE.project,
        username: SCOPE.username,
        name: "filesystem",
        enabled: true,
        transport: "stdio",
        command: "my-own-command",
      },
    ]);

    const summary = await ClaudeConfigImportService.importFromWorkspace(
      workspaceRoot,
      SCOPE,
    );
    if ("error" in summary) throw new Error(summary.error);

    expect(summary.mcpServers).toMatchObject({ imported: 1, unchanged: 1 });
    const existing = store.collections
      .get(COLLECTIONS.MCP_SERVERS)!
      .find((server) => server.name === "filesystem")!;
    expect(existing).toMatchObject({
      enabled: true,
      command: "my-own-command",
    });
  });

  it("errors on a missing workspace path", async () => {
    const result = await ClaudeConfigImportService.importFromWorkspace(
      path.join(workspaceRoot, "does-not-exist"),
      SCOPE,
    );
    expect(result).toHaveProperty("error");
  });
});

/**
 * The import endpoints the client's Import page drives (prompt 19,
 * Landing 2): `POST /plugins/import` from an uploaded zip or a workspace
 * path, `POST /claude-config-import`, each with a dry-run preview.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import supertest from "supertest";
import { app } from "./setup.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";
import { zipDirectory } from "./fixtures/zipWriter.ts";

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue(null) },
}));

const registered = vi.hoisted(() => ({ roots: [] as string[] }));
vi.mock("#src/services/ToolOrchestratorService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/services/ToolOrchestratorService")>();
  const service = actual.default as unknown as Record<string, unknown>;
  return {
    ...actual,
    default: new Proxy(service, {
      get: (target, property) =>
        property === "getWorkspaceRoots" ? () => registered.roots : Reflect.get(target, property),
    }),
  };
});

const { default: pluginsRouter } = await import("#src/routes/PluginsRoutes");
const { default: claudeConfigImportRouter } = await import("#src/routes/ClaudeConfigImportRoutes");
app.use("/plugins", pluginsRouter);
app.use("/claude-config-import", claudeConfigImportRouter);

const FIXTURE = path.join(import.meta.dirname, "fixtures", "plugins", "release-kit");

describe("import routes", () => {
  const agent = supertest(app);
  const as = (request: any) =>
    request.set("x-project", "prism-chat").set("x-username", "alice");

  let sandbox: string;
  let workspace: string;
  let skills: ReturnType<typeof createMockCollection>;
  let servers: ReturnType<typeof createMockCollection>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "plugins-routes-"));
    workspace = path.join(sandbox, "workspace");
    await fs.cp(FIXTURE, path.join(workspace, "release-kit"), { recursive: true });
    for (const name of ["PRISM_SKILL_FOLDERS_DIRECTORY", "PRISM_PLUGINS_DIRECTORY"]) {
      saved[name] = process.env[name];
    }
    process.env.PRISM_SKILL_FOLDERS_DIRECTORY = path.join(sandbox, "folders");
    process.env.PRISM_PLUGINS_DIRECTORY = path.join(sandbox, "plugins");
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    registered.roots = [workspace];
    skills = createMockCollection([]);
    servers = createMockCollection([]);
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: (name: string) => (name === COLLECTIONS.MCP_SERVERS ? servers : skills),
    } as any);
    vi.mocked(MongoWrapper.getCollection).mockImplementation(
      (_database: string, name: string) =>
        (name === COLLECTIONS.AGENT_SKILLS
          ? skills
          : name === COLLECTIONS.MCP_SERVERS
            ? servers
            : null) as any,
    );
  });

  it("POST /plugins/import previews an uploaded zip without writing", async () => {
    const archive = await zipDirectory(FIXTURE, "release-kit/");
    const response = await as(agent.post("/plugins/import"))
      .send({ archiveBase64: archive.toString("base64"), archiveName: "release-kit.zip", dryRun: true })
      .expect(200);

    expect(response.body).toMatchObject({
      dryRun: true,
      source: "zip",
      plugin: { name: "release-kit", version: "1.2.0" },
      skills: { created: 2 },
      mcpServers: { imported: 2 },
    });
    expect(skills._docs.size).toBe(0);
    expect(servers._docs.size).toBe(0);
  });

  it("POST /plugins/import imports from a workspace path", async () => {
    const response = await as(agent.post("/plugins/import"))
      .send({ workspacePath: path.join(workspace, "release-kit") })
      .expect(200);
    expect(response.body).toMatchObject({ dryRun: false, source: "workspace", skills: { created: 2 } });
    expect(skills._docs.size).toBe(2);
    expect([...servers._docs.values()].every((server: any) => server.enabled === false)).toBe(true);
  });

  it("POST /plugins/import needs exactly one source", async () => {
    await as(agent.post("/plugins/import")).send({}).expect(400);
    await as(agent.post("/plugins/import"))
      .send({ workspacePath: workspace, archiveBase64: "UEsFBg==" })
      .expect(400);
  });

  it("POST /plugins/import refuses a non-zip upload and a path outside the workspaces", async () => {
    const notZip = await as(agent.post("/plugins/import"))
      .send({ archiveBase64: Buffer.from("hello").toString("base64") })
      .expect(400);
    expect(notZip.body.error).toMatch(/zip/);

    const outside = await as(agent.post("/plugins/import"))
      .send({ workspacePath: os.tmpdir() })
      .expect(400);
    expect(outside.body.error).toMatch(/registered workspace/);
  });

  it("POST /claude-config-import takes dryRun and refuses an unregistered path", async () => {
    const preview = await as(agent.post("/claude-config-import"))
      .send({ workspacePath: workspace, dryRun: true })
      .expect(200);
    expect(preview.body.dryRun).toBe(true);

    const refused = await as(agent.post("/claude-config-import"))
      .send({ workspacePath: os.tmpdir() })
      .expect(400);
    expect(refused.body.error).toMatch(/registered workspace/);
  });
});

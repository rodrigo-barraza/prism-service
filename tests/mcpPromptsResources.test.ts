import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A read-only token for the seeded GitHub server, before config.ts reads it.
vi.hoisted(() => {
  process.env.GITHUB_MCP_TOKEN = "github_pat_readonly_test";
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import MCPClientService, { type MCPServerConfig } from "#src/services/MCPClientService";
import mcpServersRouter from "#src/routes/McpServersRoutes";
import {
  GITHUB_MCP_SERVER,
  resolveEnvHeaders,
  seedBuiltinMcpServers,
} from "#src/services/mcp/McpBuiltinServers";
import { COLLECTIONS } from "#src/constants";
import { app } from "./setup.ts";
import { createMemoryDb } from "./fixtures/mcp/memoryDb.ts";

// MCP prompts (the composer's slash commands) and resources (its
// @-mentions), through the service and the routes, against a real server.
// Plus the optional GitHub MCP seed.

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/mcp/trust-server.mjs",
);
const OWNER = { "x-username": "owner", "x-project": "prism-client" };
const SCOPE = { username: "owner", profileId: "default" };

app.use("/mcp-servers-composer-test", mcpServersRouter);

function fixtureConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "trust",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    ...SCOPE,
    ...overrides,
  };
}

describe("MCP prompts and resources", () => {
  beforeEach(() => {
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue(createMemoryDb().db);
  });
  afterEach(async () => {
    await MCPClientService.disconnectAll();
    vi.restoreAllMocks();
  });

  it("lists prompts as commands with their arguments, and fills one", async () => {
    await MCPClientService.connect(fixtureConfig());

    const listed = await request(app).get("/mcp-servers-composer-test/prompts").set(OWNER).expect(200);
    expect(listed.body.prompts).toEqual([
      {
        server: "trust",
        name: "summarize_topic",
        title: "Summarize a topic",
        description: "Summarize a topic in a given tone.",
        arguments: [
          { name: "topic", description: null, required: true },
          { name: "tone", description: null, required: false },
        ],
      },
    ]);

    const filled = await request(app)
      .post("/mcp-servers-composer-test/prompts/get")
      .set(OWNER)
      .send({ server: "trust", name: "summarize_topic", arguments: { topic: "MCP", tone: "terse" } })
      .expect(200);
    expect(filled.body).toMatchObject({
      server: "trust",
      name: "summarize_topic",
      text: "Summarize MCP in a terse tone.",
      messages: [{ role: "user", text: "Summarize MCP in a terse tone." }],
    });
  });

  it("lists resources for @-mentions and reads one", async () => {
    await MCPClientService.connect(fixtureConfig());

    const listed = await request(app).get("/mcp-servers-composer-test/resources").set(OWNER).expect(200);
    expect(listed.body.resources).toEqual([
      expect.objectContaining({ server: "trust", uri: "notes://today", name: "today", mimeType: "text/plain" }),
    ]);

    const read = await request(app)
      .post("/mcp-servers-composer-test/resources/read")
      .set(OWNER)
      .send({ server: "trust", uri: "notes://today" })
      .expect(200);
    expect(read.body).toMatchObject({ uri: "notes://today", content: "Shipped the MCP client." });
  });

  it("shows another profile none of them", async () => {
    await MCPClientService.connect(fixtureConfig());
    const other = { ...OWNER, "x-profile-id": "work" };
    expect((await request(app).get("/mcp-servers-composer-test/prompts").set(other)).body.prompts).toEqual([]);
    expect((await request(app).get("/mcp-servers-composer-test/resources").set(other)).body.resources).toEqual([]);
    await request(app)
      .post("/mcp-servers-composer-test/prompts/get")
      .set(other)
      .send({ server: "trust", name: "summarize_topic" })
      .expect(502);
  });
});

describe("GitHub MCP seed", () => {
  it("seeds the read-only remote server, enabled only with a token, without storing the token", async () => {
    const memory = createMemoryDb();
    await seedBuiltinMcpServers(memory.db, "coding");
    const [doc] = memory.docs(COLLECTIONS.MCP_SERVERS);
    expect(doc).toMatchObject({
      name: "github",
      url: "https://api.githubcopilot.com/mcp/readonly",
      transport: "streamable-http",
      shared: true,
      enabled: true,
      headers: {},
    });
    expect(JSON.stringify(doc)).not.toContain("github_pat_readonly_test");
  });

  it("resolves env-referenced headers for shared servers only", () => {
    expect(resolveEnvHeaders({ shared: true, envHeaders: GITHUB_MCP_SERVER.envHeaders })).toEqual({
      Authorization: "Bearer github_pat_readonly_test",
    });
    // A user's own server can't pull a secret out of Prism's environment.
    expect(resolveEnvHeaders({ shared: false, envHeaders: { Authorization: { env: "MONGO_URI" } } })).toEqual({});
  });
});

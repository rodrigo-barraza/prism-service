/**
 * Prompt 17, Landing 2 — the custom-agents routes accept the definition
 * fields (validated, normalised) and report the file-defined agents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import "./setup.ts";

vi.mock("#src/services/CustomAgentService", () => ({
  default: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(async (data: Record<string, unknown>) => ({ ...data, agentId: "CUSTOM_SCOUT", _id: "id-1" })),
    update: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({ ...updates, agentId: "CUSTOM_SCOUT", _id: "id-1" })),
    delete: vi.fn(),
  },
}));

import customAgentsRouter from "#src/routes/CustomAgentsRoutes";
import CustomAgentService from "#src/services/CustomAgentService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";

const app = express();
app.use(express.json());
app.use("/custom-agents", customAgentsRouter);

describe("custom-agents routes — definition fields", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-routes-"));
    vi.mocked(CustomAgentService.create).mockClear();
    vi.mocked(CustomAgentService.update).mockClear();
  });

  afterEach(() => {
    AgentPersonaRegistry.useAgentDefinitionFiles(() => []);
    AgentPersonaRegistry.unregister("CUSTOM_SCOUT");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("POST stores the pins normalised and registers them", async () => {
    const response = await request(app)
      .post("/custom-agents")
      .send({ name: "Scout", description: "Scouts.", tools: "WebSearch, Read", model: "sonnet", effort: "Low", maxTurns: 6, permissionMode: "plan" })
      .expect(201);
    expect(CustomAgentService.create).toHaveBeenCalledWith({
      name: "Scout",
      description: "Scouts.",
      availableTools: ["search_web", "read_file"],
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "low",
      maxTurns: 6,
      permissionMode: "plan",
    });
    expect(response.body.agentId).toBe("CUSTOM_SCOUT");
    expect(AgentPersonaRegistry.get("CUSTOM_SCOUT")).toMatchObject({
      model: "claude-sonnet-5",
      provider: "anthropic",
      effort: "low",
      maxTurns: 6,
      permissionMode: "plan",
      source: "database",
    });
  });

  it("POST and PUT refuse an invalid field with a 400 that names it", async () => {
    const created = await request(app)
      .post("/custom-agents")
      .send({ name: "Scout", effort: "extreme", maxTurns: 500 })
      .expect(400);
    expect(created.body.error).toMatch(/effort must be one of .*; maxTurns must be an integer from 1 to 100/);
    expect(CustomAgentService.create).not.toHaveBeenCalled();

    const updated = await request(app)
      .put("/custom-agents/507f1f77bcf86cd799439011")
      .send({ permissionMode: "yolo" })
      .expect(400);
    expect(updated.body.error).toMatch(/permissionMode must be one of/);
    expect(CustomAgentService.update).not.toHaveBeenCalled();
  });

  it("GET /files lists the file agents, the rejected files and why", async () => {
    fs.mkdirSync(path.join(root, ".prism/agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".prism/agents/scout.md"), "---\nname: scout\ndescription: Scouts.\nmodel: haiku\n---\nScout.\n");
    fs.writeFileSync(path.join(root, ".prism/agents/broken.md"), "---\nname: broken\n---\n");
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);

    const response = await request(app).get("/custom-agents/files?refresh=true").expect(200);
    expect(response.body).toEqual({
      agents: [
        {
          agentId: "CUSTOM_SCOUT",
          name: "scout",
          description: "Scouts.",
          path: path.join(root, ".prism/agents/scout.md"),
          model: "claude-haiku-4-5-20251001",
          provider: "anthropic",
        },
      ],
      errors: [{ path: path.join(root, ".prism/agents/broken.md"), error: expect.stringContaining("description is required") }],
      shadowed: [],
    });
  });
});

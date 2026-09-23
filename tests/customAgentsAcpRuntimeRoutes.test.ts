/**
 * Prompt 24, Landing 3 — an external ACP agent is a custom agent stored with
 * `runtime: "acp"` and a launch configuration (command, args, env
 * allowlist). It starts a process on the prism-service host, so writing one
 * is owner-only (PRISM_ACP_AGENT_OWNERS), the writer is stamped as its
 * owner, and the configuration is validated. Going back to Prism's own
 * runtime narrows, so anyone may.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import "./setup.ts";

vi.mock("#src/services/CustomAgentService", () => ({
  default: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(async (data: Record<string, unknown>) => ({ ...data, agentId: "CUSTOM_CLAUDE_CODE", _id: "id-1" })),
    update: vi.fn(async (_id: string, updates: Record<string, unknown>) => ({
      name: "Claude Code",
      ...updates,
      agentId: "CUSTOM_CLAUDE_CODE",
      _id: "id-1",
    })),
    delete: vi.fn(),
  },
}));

import customAgentsRouter from "#src/routes/CustomAgentsRoutes";
import CustomAgentService from "#src/services/CustomAgentService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import { ACP_AGENT_OWNERS_ENV_VAR } from "#src/services/agents/AgentRuntime";

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.username = req.header("x-username") ?? undefined;
  next();
});
app.use("/custom-agents", customAgentsRouter);

const OWNER = "rodrigo";
const LAUNCH = { command: "npx", args: ["-y", "@zed-industries/claude-code-acp"], envAllowlist: ["ANTHROPIC_API_KEY"] };
const STORED_ID = "507f1f77bcf86cd799439011";

describe("custom-agents routes — the acp runtime", () => {
  beforeEach(() => {
    process.env[ACP_AGENT_OWNERS_ENV_VAR] = OWNER;
    vi.mocked(CustomAgentService.create).mockClear();
    vi.mocked(CustomAgentService.update).mockClear();
    vi.mocked(CustomAgentService.get).mockResolvedValue({
      _id: STORED_ID,
      name: "Claude Code",
      agentId: "CUSTOM_CLAUDE_CODE",
      runtime: "acp",
      acp: { ...LAUNCH, owner: OWNER },
    } as never);
  });

  afterEach(() => {
    delete process.env[ACP_AGENT_OWNERS_ENV_VAR];
    AgentPersonaRegistry.unregister("CUSTOM_CLAUDE_CODE");
  });

  it("an owner creates one: validated, stamped with the writer as owner, registered with its runtime", async () => {
    await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", description: "Claude Code over ACP.", runtime: "acp", acp: { ...LAUNCH, owner: "someone-else" } })
      .expect(201);
    expect(CustomAgentService.create).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "acp", acp: { ...LAUNCH, owner: OWNER } }),
    );
    expect(AgentPersonaRegistry.get("CUSTOM_CLAUDE_CODE")).toMatchObject({
      runtime: "acp",
      acp: { ...LAUNCH, owner: OWNER },
      source: "database",
    });
  });

  it("anyone else is refused with a 403 that says why", async () => {
    const refused = await request(app)
      .post("/custom-agents")
      .set("x-username", "mallory")
      .send({ name: "Claude Code", runtime: "acp", acp: LAUNCH })
      .expect(403);
    expect(refused.body.error).toMatch(/owner-only.*"mallory" is not in PRISM_ACP_AGENT_OWNERS/);
    expect(CustomAgentService.create).not.toHaveBeenCalled();

    // A launch configuration alone is gated the same way.
    await request(app).put(`/custom-agents/${STORED_ID}`).set("x-username", "mallory").send({ acp: LAUNCH }).expect(403);
    expect(CustomAgentService.update).not.toHaveBeenCalled();
  });

  it("nobody may when no owner is configured", async () => {
    delete process.env[ACP_AGENT_OWNERS_ENV_VAR];
    await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", runtime: "acp", acp: LAUNCH })
      .expect(403);
  });

  it("an invalid launch configuration is a 400 that names the field", async () => {
    const missing = await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", runtime: "acp" })
      .expect(400);
    expect(missing.body.error).toMatch(/needs an `acp` object/);

    const values = await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", runtime: "acp", acp: { command: "npx", envAllowlist: ["TOKEN=abc"] } })
      .expect(400);
    expect(values.body.error).toMatch(/envAllowlist must be a list of environment variable NAMES/);

    const zedStyle = await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", runtime: "acp", acp: { command: "npx", env: { TOKEN: "abc" } } })
      .expect(400);
    expect(zedStyle.body.error).toMatch(/acp.env is not a field/);

    const multiline = await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", runtime: "acp", acp: { command: "npx\nrm -rf /" } })
      .expect(400);
    expect(multiline.body.error).toMatch(/acp.command must be one line/);

    const runtime = await request(app)
      .post("/custom-agents")
      .set("x-username", OWNER)
      .send({ name: "Claude Code", runtime: "codex-app-server" })
      .expect(400);
    expect(runtime.body.error).toMatch(/runtime must be one of prism, acp/);
    expect(CustomAgentService.create).not.toHaveBeenCalled();
  });

  it("an update that sets runtime acp alone checks the stored launch configuration and re-stamps it", async () => {
    await request(app).put(`/custom-agents/${STORED_ID}`).set("x-username", OWNER).send({ runtime: "acp" }).expect(200);
    expect(CustomAgentService.update).toHaveBeenCalledWith(
      STORED_ID,
      expect.objectContaining({ runtime: "acp", acp: { ...LAUNCH, owner: OWNER } }),
    );
  });

  it("an update that touches neither leaves the stored runtime alone — anyone may edit the rest", async () => {
    await request(app)
      .put(`/custom-agents/${STORED_ID}`)
      .set("x-username", "mallory")
      .send({ description: "Now with a better description." })
      .expect(200);
    const [, updates] = vi.mocked(CustomAgentService.update).mock.calls[0];
    expect(updates).not.toHaveProperty("runtime");
    expect(updates).not.toHaveProperty("acp");
  });

  it("going back to Prism's own runtime narrows, so anyone may", async () => {
    await request(app)
      .put(`/custom-agents/${STORED_ID}`)
      .set("x-username", "mallory")
      .send({ runtime: "prism" })
      .expect(200);
    expect(CustomAgentService.update).toHaveBeenCalledWith(STORED_ID, expect.objectContaining({ runtime: "prism" }));
    expect(AgentPersonaRegistry.get("CUSTOM_CLAUDE_CODE")?.runtime).toBeUndefined();
  });
});

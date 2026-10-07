/**
 * Machine access is a signed-in user's alone (ServiceTurnLimits): on the
 * turn routes a service's `workspaceRoot` (body or header) and `autoApprove`
 * are dropped and its turn gets no workspace tools; a user's are kept. Every
 * agentic loop a service's request starts applies the same limits, whatever
 * its entry point.
 */
import { describe, it, expect, vi } from "vitest";
import supertest from "supertest";

// The routes' hand-off: answer with the params the turn would run with.
vi.mock("#src/utils/SseUtilities", () => ({
  handleSseRequest: vi.fn(),
  handleJsonRequest: vi.fn(async (_request: unknown, response: { json: (body: unknown) => void }, _next: unknown, params: unknown) =>
    response.json({ params }),
  ),
}));

import { app } from "./setup.ts";
import { serviceHeaders, userHeaders, runAs } from "./helpers/auth.ts";
import {
  limitServiceTurn,
  narrowServiceTurnScope,
  OWNER_ONLY_TURN_FIELDS,
  SERVICE_TURN_DENIED_CAPABILITIES,
  serviceTurnScope,
} from "#src/utils/ServiceTurnLimits";
import {
  CapabilityScopeHandle,
  currentScope,
  type CapabilityScope,
} from "#src/services/permissions/CapabilityScope";
import { LuposPersona } from "#src/services/personas/LuposPersona";

const { default: agentRouter } = await import("#src/routes/AgentRoutes");
const { default: conversationRouter } = await import("#src/routes/ConversationExecutionRoute");
const { default: AgenticLoopService } = await import("#src/services/AgenticLoopService");

app.use("/agent", agentRouter);
app.use("/conversation", conversationRouter);
const http = supertest(app);

const MACHINE_ACCESS = { workspaceRoot: "/home/rodrigo/repo", autoApprove: true };
const MESSAGES = [{ role: "user", content: "hi" }];

describe("turn routes: workspaceRoot and autoApprove are a signed-in user's alone", () => {
  for (const [route, body] of [
    ["/agent?stream=false", { provider: "google", messages: MESSAGES }],
    ["/conversation?stream=false", { provider: "google", messages: MESSAGES, agent: "CODING" }],
    ["/conversation?stream=false", { provider: "google", messages: MESSAGES }],
    ["/chat?stream=false", { provider: "google", messages: MESSAGES }],
  ] as const) {
    const label = `POST ${route}${"agent" in body ? " (agent)" : ""}`;

    it(`${label}: a service's are dropped, its workspace tools switched off`, async () => {
      const response = await http
        .post(route)
        .set(serviceHeaders("visitor"))
        .set("x-workspace-root", "/home/rodrigo")
        .send({ ...body, ...MACHINE_ACCESS })
        .expect(200);
      const { params } = response.body;
      expect(params).not.toHaveProperty("workspaceRoot");
      expect(params).not.toHaveProperty("autoApprove");
      expect(params.workspaceEnabled).toBe(false);
      expect(params.username).toBe("visitor");
    });

    it(`${label}: a user's are honoured`, async () => {
      const response = await http
        .post(route)
        .set(userHeaders("rodrigo"))
        .send({ ...body, ...MACHINE_ACCESS })
        .expect(200);
      const { params } = response.body;
      expect(params).toMatchObject({ workspaceRoot: "/home/rodrigo/repo", autoApprove: true, username: "rodrigo" });
      expect(params.workspaceEnabled).not.toBe(false);
    });
  }

  it("a user's x-workspace-root header is honoured on /agent", async () => {
    const response = await http
      .post("/agent?stream=false")
      .set(userHeaders("rodrigo"))
      .set("x-workspace-root", "/home/rodrigo/selected")
      .send({ provider: "google", messages: MESSAGES })
      .expect(200);
    expect(response.body.params.workspaceRoot).toBe("/home/rodrigo/selected");
  });
});

describe("limitServiceTurn", () => {
  it("leaves a user's params alone, and strips a service's", () => {
    const user = { ...MACHINE_ACCESS };
    expect(limitServiceTurn("user", user, "test")).toEqual([]);
    expect(user).toEqual(MACHINE_ACCESS);

    const service: Record<string, unknown> = { ...MACHINE_ACCESS, workspaceEnabled: true };
    expect(limitServiceTurn("service", service, "test")).toEqual([...OWNER_ONLY_TURN_FIELDS]);
    expect(service).toEqual({ workspaceEnabled: false });
  });
});

/** A loop that stops right after its entry checks (an unknown runtime), so its context can be read. */
async function enterLoop(
  kind: "user" | "service",
  { agent, options = {} }: { agent?: string; options?: Record<string, unknown> } = {},
) {
  const context = {
    options: { runtime: "no-such-runtime", autoApprove: true, workspaceEnabled: true, ...options },
    workspaceRoot: "/home/rodrigo/repo",
    conversationId: `limits-${kind}`,
    agentConversationId: `limits-${kind}`,
    project: "coding",
    username: "rodrigo",
    ...(agent && { agent }),
    messages: [],
    emit: () => {},
  } as never as Parameters<typeof AgenticLoopService.runAgenticLoop>[0];
  await expect(runAs(kind, "rodrigo", () => AgenticLoopService.runAgenticLoop(context))).rejects.toThrow(
    /Unknown agent runtime/,
  );
  return context as unknown as { workspaceRoot: string | null; options: Record<string, unknown> };
}

/** The scope a loop entered with, as `{ denied }` (null: nothing taken away). */
function scopeOf(context: { options: Record<string, unknown> }) {
  return currentScope(context.options._capabilityScope as CapabilityScope | null | undefined);
}

describe("every loop a service's request starts gets the same limits", () => {
  it("a service's loop — a scheduled task, a timer, a wake, a sub-agent alike — has no workspace and no full auto", async () => {
    const context = await enterLoop("service");
    expect(context.workspaceRoot).toBeNull();
    expect(context.options.workspaceEnabled).toBe(false);
    expect(context.options).not.toHaveProperty("autoApprove");
  });

  it("a user's loop keeps them", async () => {
    const context = await enterLoop("user");
    expect(context.workspaceRoot).toBe("/home/rodrigo/repo");
    expect(context.options).toMatchObject({ workspaceEnabled: true, autoApprove: true });
  });
});

describe("a service's turn runs under a capability scope", () => {
  const DEFAULT_DENIED = ["fs_write", "shell", "mcp", "external_side_effect"];

  it("by default: no shell, no file writes, no outside actions, no MCP", () => {
    expect([...SERVICE_TURN_DENIED_CAPABILITIES].sort()).toEqual([...DEFAULT_DENIED].sort());
    expect(serviceTurnScope(null)).toEqual({ denied: DEFAULT_DENIED });
    expect(serviceTurnScope({})).toEqual({ denied: DEFAULT_DENIED });
  });

  it("an agent's serviceCapabilities keep a default denial (true) or take one more away (false)", () => {
    expect(serviceTurnScope({ serviceCapabilities: { shell: true } })).toEqual({
      denied: ["fs_write", "mcp", "external_side_effect"],
    });
    expect(serviceTurnScope({ serviceCapabilities: { network: false } })).toEqual({
      denied: ["fs_write", "shell", "network", "mcp", "external_side_effect"],
    });
  });

  it("LUPOS keeps his sandboxes and Discord actions, and nothing else: only MCP is taken away", () => {
    expect(LuposPersona.serviceCapabilities).toEqual({ shell: true, fs_write: true, external_side_effect: true });
    expect(serviceTurnScope(LuposPersona)).toEqual({ denied: ["mcp"] });
  });

  it("is the scope every loop a service's request starts enters with — and a user's has none", async () => {
    expect(scopeOf(await enterLoop("service"))).toEqual({ denied: DEFAULT_DENIED });
    expect(scopeOf(await enterLoop("service", { agent: "CODING" }))).toEqual({ denied: DEFAULT_DENIED });
    expect(scopeOf(await enterLoop("service", { agent: "LUPOS" }))).toEqual({ denied: ["mcp"] });
    expect((await enterLoop("user")).options._capabilityScope).toBeUndefined();
  });

  it("only narrows the scope a run arrived with: a sub-agent of a service's turn keeps its parent's denials", async () => {
    // A LUPOS sub-agent of a default service turn: his keeps cannot undo what the parent denies.
    const child = await enterLoop("service", {
      agent: "LUPOS",
      options: { isSubAgent: true, _capabilityScope: { denied: [...DEFAULT_DENIED, "network"] } },
    });
    expect(scopeOf(child)).toEqual({ denied: ["fs_write", "shell", "network", "mcp", "external_side_effect"] });
  });

  it("nothing a request sends widens it", async () => {
    const asked = await enterLoop("service", {
      options: { _capabilityScope: { shell: true, fs_write: true, external_side_effect: true, mcp: true } },
    });
    expect(scopeOf(asked)).toEqual({ denied: DEFAULT_DENIED });
  });

  it("narrowServiceTurnScope reads a live handle's current narrowing", () => {
    const handle = new CapabilityScopeHandle({ denied: ["network"] });
    handle.narrow("goal", { denied: ["subagent"] });
    expect(narrowServiceTurnScope(handle, LuposPersona)).toEqual({ denied: ["network", "mcp", "subagent"] });
  });
});

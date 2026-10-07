/**
 * Powers no server needs are a signed-in user's alone (AuthMiddleware
 * requireSignedInUser): answering or approving a pending decision (a tool
 * call, a plan, a question, a budget pause, a proposed goal), changing the
 * workspaces, importing what brings MCP servers that run commands, and
 * changing or running benchmarks (their scorers run commands). A
 * service's request — any service, not only a relay — gets a 403 that says
 * so; a user's token goes through to the route.
 */
import { describe, it, expect } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import { serviceHeaders, userHeaders } from "./helpers/auth.ts";

const { default: agentRouter } = await import("#src/routes/AgentRoutes");
const { default: conversationExecutionRouter } = await import("#src/routes/ConversationExecutionRoute");
const { default: conversationsRouter } = await import("#src/routes/ConversationsRoutes");
const { default: workspacesRouter } = await import("#src/routes/WorkspacesRoutes");
const { default: pluginsRouter } = await import("#src/routes/PluginsRoutes");
const { default: claudeConfigImportRouter } = await import("#src/routes/ClaudeConfigImportRoutes");
const { default: benchmarkRouter } = await import("#src/routes/BenchmarkRoutes");

app.use("/user-only/agent", agentRouter);
app.use("/user-only/conversation", conversationExecutionRouter);
app.use("/user-only/conversations", conversationsRouter);
app.use("/user-only/workspaces", workspacesRouter);
app.use("/user-only/plugins", pluginsRouter);
app.use("/user-only/claude-config-import", claudeConfigImportRouter);
app.use("/user-only/benchmark", benchmarkRouter);
const http = supertest(app);

type Method = "post" | "put" | "patch" | "delete";

/**
 * Each guarded route, with a body that stops a user's request in the route's
 * own validation or lookup (a 400 or 404 — never a call that changes
 * anything). `userGoesThrough: false`: the route has nothing to validate
 * first, so only the refusal is checked.
 */
const GUARDED: Array<{
  method: Method;
  path: string;
  body: Record<string, unknown>;
  action: RegExp;
  userGoesThrough?: false;
}> = [
  { method: "post", path: "/agent/approve", body: { conversationId: "c1" }, action: /approve a tool call/ },
  { method: "post", path: "/agent/answer", body: { conversationId: "c1" }, action: /answer a question/ },
  { method: "post", path: "/conversation/approve", body: { conversationId: "c1" }, action: /approve a tool call/ },
  { method: "post", path: "/conversation/answer", body: { conversationId: "c1" }, action: /answer a question/ },
  { method: "patch", path: "/conversations/c1/budget", body: { maxCostDollars: 5 }, action: /raise a budget/ },
  { method: "patch", path: "/conversations/c1/goal", body: { budget: { maxCostDollars: 5 } }, action: /change a goal's budget/ },
  { method: "post", path: "/conversations/c1/goal/proposal/approve", body: {}, action: /approve a goal/ },
  { method: "post", path: "/conversations/c1/goal/proposal/decline", body: {}, action: /decline a goal/ },
  { method: "put", path: "/workspaces", body: { roots: "not-a-list" }, action: /change the workspaces/ },
  { method: "post", path: "/workspaces/validate", body: {}, action: /change the workspaces/ },
  {
    method: "delete",
    path: "/workspaces/agents/agent-1",
    body: {},
    action: /change the workspaces/,
    userGoesThrough: false,
  },
  { method: "post", path: "/plugins/import", body: {}, action: /import a plugin/ },
  { method: "post", path: "/claude-config-import", body: {}, action: /import Claude Code configuration/ },
  // A suite's command scorers run on this host. For a user, a run with no
  // contestants and a suite with no name stop at validation.
  { method: "post", path: "/benchmark/runs", body: {}, action: /change or run benchmarks/ },
  { method: "post", path: "/benchmark/suites", body: {}, action: /change or run benchmarks/ },
];

describe("a service's request is refused what only a signed-in user may do", () => {
  for (const { method, path, body, action, userGoesThrough } of GUARDED) {
    it(`${method.toUpperCase()} ${path}: 403 for a service, through for a user`, async () => {
      const refused = await http[method](`/user-only${path}`).set(serviceHeaders("rodrigo")).send(body);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("FORBIDDEN");
      expect(refused.body.error).toMatch(action);
      expect(refused.body.error).toMatch(/Only a signed-in user can .*; a service's request cannot\./);
      if (userGoesThrough === false) return;

      const allowed = await http[method](`/user-only${path}`).set(userHeaders("rodrigo")).send(body);
      expect(allowed.status, JSON.stringify(allowed.body)).not.toBe(403);
    });
  }

  it("a relay is still told it is external input (ExternalAuthority runs first)", async () => {
    const relayed = await http
      .post("/user-only/agent/approve")
      .set(serviceHeaders("discord-member"))
      .set("x-project", "lupos")
      .send({ conversationId: "c1" });
    expect(relayed.status).toBe(403);
    expect(relayed.body.reason).toBe("external_input");
  });

  it("a goal change that touches no budget, and every workspace read, stay open to a service", async () => {
    const goal = await http
      .patch("/user-only/conversations/c1/goal")
      .set(serviceHeaders("rodrigo"))
      .send({ status: "paused" });
    expect(goal.status).not.toBe(403);
    const tree = await http.get("/user-only/workspaces").set(serviceHeaders("rodrigo"));
    expect(tree.status).not.toBe(403);
  });
});

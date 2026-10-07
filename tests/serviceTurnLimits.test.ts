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
import { limitServiceTurn, OWNER_ONLY_TURN_FIELDS } from "#src/utils/ServiceTurnLimits";

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

describe("every loop a service's request starts gets the same limits", () => {
  /** A loop that stops right after its entry checks (an unknown runtime), so its context can be read. */
  async function enterLoop(kind: "user" | "service") {
    const context = {
      options: { runtime: "no-such-runtime", autoApprove: true, workspaceEnabled: true },
      workspaceRoot: "/home/rodrigo/repo",
      conversationId: `limits-${kind}`,
      agentConversationId: `limits-${kind}`,
      project: "coding",
      username: "rodrigo",
      messages: [],
      emit: () => {},
    } as never as Parameters<typeof AgenticLoopService.runAgenticLoop>[0];
    await expect(runAs(kind, "rodrigo", () => AgenticLoopService.runAgenticLoop(context))).rejects.toThrow(
      /Unknown agent runtime/,
    );
    return context as unknown as { workspaceRoot: string | null; options: Record<string, unknown> };
  }

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

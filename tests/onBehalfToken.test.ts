/**
 * The on-behalf token round trip: tools-service hands the token prism-service
 * sent it back as `Authorization: Bearer` on its callbacks, so a scheduled
 * task the agent creates through tools-service during the owner's turn is
 * the owner's (stamped `user`), not a service's.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import { serviceHeaders, runAs } from "./helpers/auth.ts";
import {
  ON_BEHALF_TOKEN_HEADER,
  TOOLS_SERVICE_API_SECRET_ENV_VAR,
  _clearOnBehalfTokens,
  toolsServiceAuthHeaders,
} from "#src/utils/ToolsServiceAuth";

const { default: scheduledTasksRouter } = await import("#src/routes/ScheduledTasksRoutes");
app.use("/on-behalf-scheduled-tasks", scheduledTasksRouter);
const http = supertest(app);

const TASK = {
  name: "Nightly digest",
  prompt: "Summarize the day",
  agent: "CODING",
  provider: "google",
  model: "gemini-3.5-flash",
  scheduleType: "daily",
  scheduleTime: "07:00",
};

describe("tools-service's callback with the on-behalf token", () => {
  beforeEach(() => {
    process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR] = "test-tools-service-secret";
    _clearOnBehalfTokens();
  });
  afterEach(() => {
    delete process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
  });

  it("a task scheduled during the owner's turn is the owner's: stamped user", async () => {
    // What prism-service sent tools-service from inside the owner's turn…
    const onBehalf = runAs("user", "rodrigo", () => toolsServiceAuthHeaders())[ON_BEHALF_TOKEN_HEADER];
    expect(onBehalf).toBeTruthy();
    // …comes back as the bearer of tools-service's callback (beside its own secret).
    const response = await http
      .post("/on-behalf-scheduled-tasks")
      .set(serviceHeaders("rodrigo"))
      .set("authorization", `Bearer ${onBehalf}`)
      .set("x-project", "coding")
      .send(TASK)
      .expect(201);
    expect(response.body).toMatchObject({ username: "rodrigo", authKind: "user" });
  });

  it("the same callback with only the service secret is a service's: stamped service", async () => {
    const response = await http
      .post("/on-behalf-scheduled-tasks")
      .set(serviceHeaders("rodrigo"))
      .set("x-project", "coding")
      .send(TASK)
      .expect(201);
    expect(response.body).toMatchObject({ username: "rodrigo", authKind: "service" });
  });
});

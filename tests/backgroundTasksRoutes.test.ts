import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";

const watcher = vi.hoisted(() => ({ list: vi.fn(), stop: vi.fn() }));
vi.mock("#src/services/background-tasks/BackgroundTaskWatcher", () => ({
  default: {
    list: (...callArguments: unknown[]) => watcher.list(...callArguments),
    stop: (...callArguments: unknown[]) => watcher.stop(...callArguments),
  },
}));

import backgroundTasksRouter from "#src/routes/BackgroundTasksRoutes";

app.use(backgroundTasksRouter);

/** GET /conversations/:id/tasks and POST /tasks/:taskId/stop, scoped to the requester. */
describe("background task routes", () => {
  const agent = supertest(app);
  const headers = { "x-project": "coding", "x-username": "rod" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists the conversation's tasks for the requesting user", async () => {
    const task = {
      taskId: "monitor-ab12cd34",
      taskType: "monitor",
      status: "running",
      description: "deploy events",
      eventCount: 2,
      startedAt: "2026-10-06T17:00:00.000Z",
    };
    watcher.list.mockResolvedValue([task]);
    const response = await agent.get("/conversations/conv-1/tasks").set(headers).expect(200);
    expect(response.body).toEqual({ tasks: [task] });
    expect(watcher.list).toHaveBeenCalledWith({ conversationId: "conv-1", project: "coding", username: "rod" });
  });

  it("stops the requester's task through the watcher, as the user", async () => {
    watcher.stop.mockResolvedValue({ found: true, stopped: true, status: "killed", task: {} });
    const response = await agent.post("/tasks/monitor-ab12cd34/stop").set(headers).expect(200);
    expect(response.body).toEqual({ stopped: true, status: "killed" });
    expect(watcher.stop).toHaveBeenCalledWith("monitor-ab12cd34", { username: "rod", project: "coding" }, "user");
  });

  it("says how an ended task ended", async () => {
    watcher.stop.mockResolvedValue({ found: true, stopped: false, status: "completed", task: {} });
    const response = await agent.post("/tasks/shell-ab12cd34/stop").set(headers).expect(200);
    expect(response.body).toEqual({ stopped: false, status: "completed" });
  });

  it("404s a task that is not the requester's, or not a background task at all", async () => {
    watcher.stop.mockResolvedValue({ found: false });
    await agent.post("/tasks/monitor-ab12cd34/stop").set(headers).expect(404);
    await agent.post("/tasks/task-1-abcd/stop").set(headers).expect(404);
    expect(watcher.stop).toHaveBeenCalledTimes(1);
  });

  it("refuses a stop an external input asks for", async () => {
    await agent
      .post("/tasks/monitor-ab12cd34/stop")
      .set({ ...headers, "x-prism-external-source": "webhook" })
      .expect(403);
    expect(watcher.stop).not.toHaveBeenCalled();
  });
});

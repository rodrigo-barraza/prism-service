import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * BackgroundTaskWatcher against a fake tools-service: a real HTTP server
 * that serves `GET /agentic/tasks/:id/events?after=` as SSE and
 * `POST /agentic/tasks/:id/stop`, with the detached_work collection in the
 * shared Mongo mock.
 */

const shared = vi.hoisted(() => ({
  baseUrl: "",
  collections: new Map<string, any>(),
}));

vi.mock("#config", () => ({
  get TOOLS_SERVICE_URL() {
    return shared.baseUrl;
  },
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

vi.mock("#src/wrappers/MongoWrapper", async () => {
  const { createMockCollection } = await import("../../../../tests/mongoMock.ts");
  const collection = (name: string) => {
    if (!shared.collections.has(name)) shared.collections.set(name, createMockCollection());
    return shared.collections.get(name)!;
  };
  return {
    default: {
      getDb: () => ({ collection }),
      getCollection: (_database: string, name: string) => collection(name),
    },
  };
});

const delivered = vi.hoisted(() => ({ notices: [] as Array<Record<string, any>> }));
vi.mock("#src/services/background-tasks/TaskNotificationDelivery", () => ({
  default: {
    deliver: vi.fn(async (notice: Record<string, any>) => {
      delivered.notices.push(notice);
      return "mailbox";
    }),
  },
}));

const viewerEvents = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("#src/websocket/WebSocketConnectionRegistry", () => ({
  default: {
    getEmitFunction: () => (event: Record<string, any>) => viewerEvents.push(event),
  },
}));

import BackgroundTaskWatcher from "#src/services/background-tasks/BackgroundTaskWatcher";
import DetachedWorkStore from "#src/services/DetachedWorkStore";
import { runAs } from "../../../../tests/helpers/auth.ts";

// ── The fake tools-service ────────────────────────────────────────────

type Frame = { method: "task.event" | "task.exit"; params: Record<string, unknown> };

interface FakeTask {
  /** What each connection to the event stream is served, in order of connections. */
  connections: Array<(response: http.ServerResponse, after: number) => void>;
  afterSeen: number[];
  stops: number;
  heldStream?: http.ServerResponse;
}

const fakeTasks = new Map<string, FakeTask>();
let server: http.Server;

function send(response: http.ServerResponse, frame: Frame): void {
  response.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function openStream(response: http.ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(": ping\n\n");
}

const event = (seq: number, lines: string[]): Frame => ({
  method: "task.event",
  params: { taskId: "", seq, lines, at: new Date().toISOString() },
});
const exit = (seq: number, params: Record<string, unknown>): Frame => ({
  method: "task.exit",
  params: { taskId: "", seq, at: new Date().toISOString(), ...params },
});

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const eventsMatch = /^\/agentic\/tasks\/([^/]+)\/events$/.exec(url.pathname);
    const stopMatch = /^\/agentic\/tasks\/([^/]+)\/stop$/.exec(url.pathname);
    const taskId = decodeURIComponent((eventsMatch ?? stopMatch)?.[1] ?? "");
    const task = fakeTasks.get(taskId);
    if (!task) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: `Unknown task ${taskId}` }));
      return;
    }
    if (eventsMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      task.afterSeen.push(after);
      const serve = task.connections.shift();
      if (!serve) {
        response.writeHead(500);
        response.end();
        return;
      }
      serve(response, after);
      return;
    }
    // stop: the exit follows on the stream being held open
    task.stops++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ stopped: true, status: "killed" }));
    if (task.heldStream) {
      send(task.heldStream, exit(99, { status: "killed", exitCode: null, signal: "SIGTERM", eventCount: 0 }));
      task.heldStream.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  shared.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  BackgroundTaskWatcher._reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  BackgroundTaskWatcher._reset();
  fakeTasks.clear();
  shared.collections.clear();
  delivered.notices.length = 0;
  viewerEvents.length = 0;
});

const owner = {
  conversationId: "conv-1",
  agentConversationId: "agent-conv-1",
  project: "coding",
  username: "rod",
  workspaceRoot: "/repo",
  isSubAgent: false,
};

function detachedWork() {
  return [...shared.collections.get("detached_work")._docs.values()] as Array<Record<string, any>>;
}

describe("BackgroundTaskWatcher", () => {
  it("replays after the last seq it handled, never delivers a frame twice, and settles the record on exit", async () => {
    fakeTasks.set("monitor-aaaa1111", {
      afterSeen: [],
      stops: 0,
      connections: [
        // First connection: one batch, then the connection drops.
        (response) => {
          openStream(response);
          send(response, event(1, ["Rod: build a tower here", "Rod: and a well"]));
          setTimeout(() => response.destroy(), 20);
        },
        // Second: tools-service replays from the start anyway — seq 1 must be skipped.
        (response) => {
          openStream(response);
          send(response, event(1, ["Rod: build a tower here", "Rod: and a well"]));
          send(response, event(2, ["Rod: done"]));
          send(response, exit(3, { kind: "monitor", status: "exited", exitCode: 0, eventCount: 3, outputFile: "/tmp/prism-1000/tasks/monitor-aaaa1111.output" }));
          response.end();
        },
      ],
    });

    await BackgroundTaskWatcher.watch({
      taskId: "monitor-aaaa1111",
      taskType: "monitor",
      description: "owner's in-game chat",
      command: "tail -f chat.log",
      outputFile: "/tmp/prism-1000/tasks/monitor-aaaa1111.output",
      timeoutMs: 300000,
      owner,
    });

    await vi.waitFor(() => expect(delivered.notices).toHaveLength(3), { timeout: 5000 });
    expect(fakeTasks.get("monitor-aaaa1111")!.afterSeen).toEqual([0, 1]);
    expect(delivered.notices.map((notice) => notice.text)).toEqual([
      [
        "<task-notification>",
        "<task-id>monitor-aaaa1111</task-id>",
        "<task-type>monitor</task-type>",
        "<description>owner's in-game chat</description>",
        "<event>",
        "Rod: build a tower here",
        "Rod: and a well",
        "</event>",
        "</task-notification>",
      ].join("\n"),
      expect.stringContaining("<event>\nRod: done\n</event>"),
      expect.stringContaining('<summary>Monitor "owner\'s in-game chat" exited (exit code 0) with 3 events.</summary>'),
    ]);
    // Delivered as the agent's own output, to its turn.
    expect(delivered.notices[0]).toMatchObject({
      loopKey: "conv-1",
      conversationId: "conv-1",
      kind: "task_notification",
      isSubAgent: false,
      meta: { _notificationSource: "workspace_task", _notificationId: "workspace_task:monitor-aaaa1111:1", taskId: "monitor-aaaa1111" },
    });

    await vi.waitFor(() => expect(detachedWork()[0].status).toBe("delivered"));
    expect(detachedWork()[0]).toMatchObject({
      kind: "workspace_task",
      itemId: "monitor-aaaa1111",
      loopKey: "conv-1",
      deliveredVia: "mailbox",
      task: { type: "monitor", status: "exited", lastSeq: 3, eventCount: 3, exitCode: 0 },
    });

    // The live viewers saw it start, each batch, and its end.
    expect(viewerEvents.map((event) => [event.type, event.status, event.eventCount])).toEqual([
      ["background_task", "running", 0],
      ["background_task", "running", 2],
      ["background_task", "running", 3],
      ["background_task", "exited", 3],
    ]);
    expect(viewerEvents.at(-1)).toMatchObject({ conversationId: "conv-1", taskId: "monitor-aaaa1111", taskType: "monitor", exitCode: 0 });
    expect(BackgroundTaskWatcher.get("monitor-aaaa1111")).toBeNull();
  });

  it("reports a task tools-service no longer knows (404) as lost", async () => {
    await BackgroundTaskWatcher.watch({
      taskId: "shell-gone0000",
      taskType: "shell",
      description: "Build the client",
      command: "npm run build",
      outputFile: "/tmp/prism-1000/tasks/shell-gone0000.output",
      owner,
    });
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(1));
    expect(delivered.notices[0].text).toContain("<status>lost</status>");
    expect(delivered.notices[0].text).toContain(
      '<summary>Background command "Build the client" was lost: its workspace went away before it finished.</summary>',
    );
    await vi.waitFor(() => expect(detachedWork()[0].task.status).toBe("lost"));
  });

  it("a shell's exit carries its output tail", async () => {
    fakeTasks.set("shell-bbbb2222", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response) => {
          openStream(response);
          send(response, exit(1, { kind: "shell", status: "failed", exitCode: 2, eventCount: 0, outputTail: "Error: tests failed\n" }));
          response.end();
        },
      ],
    });
    await BackgroundTaskWatcher.watch({
      taskId: "shell-bbbb2222",
      taskType: "shell",
      description: "Run the tests",
      command: "npm test",
      outputFile: "/tmp/prism-1000/tasks/shell-bbbb2222.output",
      owner,
    });
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(1));
    expect(delivered.notices[0].text).toContain(
      '<summary>Background command "Run the tests" failed (exit code 2).</summary>\n<output-tail>\nError: tests failed\n</output-tail>',
    );
  });

  it("a task stopped through prism ends without telling the agent; only its owner may stop it", async () => {
    fakeTasks.set("monitor-cccc3333", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response) => {
          openStream(response);
          fakeTasks.get("monitor-cccc3333")!.heldStream = response;
        },
      ],
    });
    await BackgroundTaskWatcher.watch({
      taskId: "monitor-cccc3333",
      taskType: "monitor",
      description: "errors in deploy.log",
      command: "tail -f deploy.log",
      owner,
    });
    await vi.waitFor(() => expect(fakeTasks.get("monitor-cccc3333")!.heldStream).toBeDefined());

    expect(await BackgroundTaskWatcher.stop("monitor-cccc3333", { username: "someone-else" }, "user")).toEqual({ found: false });
    const outcome = await BackgroundTaskWatcher.stop("monitor-cccc3333", { username: "rod", project: "coding" }, "user");
    expect(outcome).toMatchObject({ found: true, stopped: true, status: "killed", task: { taskId: "monitor-cccc3333" } });

    await vi.waitFor(() => expect(detachedWork()[0].status).toBe("delivered"));
    expect(detachedWork()[0]).toMatchObject({ deliveredVia: "stopped", task: { status: "killed" } });
    expect(delivered.notices).toHaveLength(0);
    expect(viewerEvents.at(-1)).toMatchObject({ status: "killed", exitCode: null });

    // Ended: a second stop says how it ended.
    expect(await BackgroundTaskWatcher.stop("monitor-cccc3333", { username: "rod" }, "agent")).toMatchObject({
      found: true,
      stopped: false,
      status: "killed",
    });
  });

  it("stops a sub-agent's monitors when its run ends", async () => {
    fakeTasks.set("monitor-dddd4444", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response) => {
          openStream(response);
          fakeTasks.get("monitor-dddd4444")!.heldStream = response;
        },
      ],
    });
    await BackgroundTaskWatcher.watch({
      taskId: "monitor-dddd4444",
      taskType: "monitor",
      description: "sub-agent watch",
      command: "tail -f x.log",
      owner: { ...owner, conversationId: "sub-conv-1", agentConversationId: "sub-conv-1", isSubAgent: true },
    });
    await vi.waitFor(() => expect(fakeTasks.get("monitor-dddd4444")!.heldStream).toBeDefined());
    expect(BackgroundTaskWatcher.stopMonitorsOf("other-loop")).toBe(0);
    expect(BackgroundTaskWatcher.stopMonitorsOf("sub-conv-1")).toBe(1);
    await vi.waitFor(() => expect(fakeTasks.get("monitor-dddd4444")!.stops).toBe(1));
    await vi.waitFor(() => expect(detachedWork()[0].deliveredVia).toBe("stopped"));
    expect(delivered.notices).toHaveLength(0);
  });

  it("a task keeps the auth of the turn that started it — on its notices, its record, and a re-attach", async () => {
    fakeTasks.set("shell-auth0001", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response) => {
          openStream(response);
          send(response, exit(1, { kind: "shell", status: "completed", exitCode: 0, eventCount: 0 }));
          response.end();
        },
      ],
    });
    // Started from inside a signed-in user's turn (the tool runs in it).
    await runAs("user", "rod", () =>
      BackgroundTaskWatcher.watch({ taskId: "shell-auth0001", taskType: "shell", description: "build", owner }),
    );
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(1));
    expect(delivered.notices[0].authKind).toBe("user");
    expect(detachedWork()[0].authKind).toBe("user");

    // A service's task, picked up again after a restart, wakes nothing with owner powers.
    await DetachedWorkStore.started({
      id: "workspace_task:conv-1:shell-auth0002",
      itemId: "shell-auth0002",
      kind: "workspace_task",
      loopKey: "conv-1",
      conversationId: "conv-1",
      agentConversationId: "agent-conv-1",
      project: "coding",
      username: "rod",
      authKind: "service",
      task: { type: "shell", description: "lint", status: "running", lastSeq: 0, eventCount: 0, startedAt: new Date().toISOString() },
    });
    fakeTasks.set("shell-auth0002", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response) => {
          openStream(response);
          send(response, exit(1, { kind: "shell", status: "completed", exitCode: 0, eventCount: 0 }));
          response.end();
        },
      ],
    });
    await expect(BackgroundTaskWatcher.reattach()).resolves.toBe(1);
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(2));
    expect(delivered.notices[1].authKind).toBe("service");
  });

  it("re-attaches at boot from the last seq on record", async () => {
    await DetachedWorkStore.started({
      id: "workspace_task:conv-1:shell-eeee5555",
      itemId: "shell-eeee5555",
      kind: "workspace_task",
      loopKey: "conv-1",
      conversationId: "conv-1",
      agentConversationId: "agent-conv-1",
      project: "coding",
      username: "rod",
      task: {
        type: "shell",
        description: "Long build",
        command: "make all",
        outputFile: "/tmp/prism-1000/tasks/shell-eeee5555.output",
        status: "running",
        lastSeq: 5,
        eventCount: 0,
        startedAt: new Date().toISOString(),
      },
    });
    fakeTasks.set("shell-eeee5555", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response, after) => {
          openStream(response);
          send(response, exit(after + 1, { kind: "shell", status: "completed", exitCode: 0, eventCount: 0, outputTail: "done\n" }));
          response.end();
        },
      ],
    });

    await expect(BackgroundTaskWatcher.reattach()).resolves.toBe(1);
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(1));
    expect(fakeTasks.get("shell-eeee5555")!.afterSeen).toEqual([5]);
    expect(delivered.notices[0].text).toContain('<summary>Background command "Long build" completed (exit code 0).</summary>');
    await vi.waitFor(() => expect(detachedWork()[0].task.lastSeq).toBe(6));
    // Nothing left to re-attach.
    await expect(BackgroundTaskWatcher.reattach()).resolves.toBe(0);
  });

  it("lists a conversation's tasks, the live state over the record", async () => {
    fakeTasks.set("monitor-ffff6666", {
      afterSeen: [],
      stops: 0,
      connections: [
        (response) => {
          openStream(response);
          send(response, event(1, ["one"]));
          fakeTasks.get("monitor-ffff6666")!.heldStream = response;
        },
      ],
    });
    await BackgroundTaskWatcher.watch({
      taskId: "monitor-ffff6666",
      taskType: "monitor",
      description: "events",
      command: "./emit.sh",
      outputFile: "/tmp/prism-1000/tasks/monitor-ffff6666.output",
      owner,
    });
    await vi.waitFor(() => expect(delivered.notices).toHaveLength(1));
    const [task] = await BackgroundTaskWatcher.list({ conversationId: "conv-1", project: "coding", username: "rod" });
    expect(task).toMatchObject({
      taskId: "monitor-ffff6666",
      taskType: "monitor",
      status: "running",
      description: "events",
      command: "./emit.sh",
      eventCount: 1,
    });
    expect(await BackgroundTaskWatcher.list({ conversationId: "conv-1", username: "someone-else" })).toEqual([]);
    expect(await BackgroundTaskWatcher.list({ conversationId: "conv-2", username: "rod" })).toEqual([]);
  });
});

describe("DetachedWorkStore and workspace tasks", () => {
  it("leaves workspace tasks out of the restart's undelivered work (the watcher re-attaches them)", async () => {
    const base = {
      loopKey: "conv-1",
      conversationId: "conv-1",
      agentConversationId: "agent-conv-1",
      project: "coding",
      username: "rod",
    };
    await DetachedWorkStore.started({ ...base, id: "async_task:agent-conv-1:task-1-abcd", itemId: "task-1-abcd", kind: "async_task" });
    await DetachedWorkStore.started({
      ...base,
      id: "workspace_task:conv-1:shell-12345678",
      itemId: "shell-12345678",
      kind: "workspace_task",
      task: { type: "shell", description: "x", status: "running", lastSeq: 0, eventCount: 0, startedAt: new Date().toISOString() },
    });
    expect((await DetachedWorkStore.listUndelivered()).map((record) => record.itemId)).toEqual(["task-1-abcd"]);
    expect((await DetachedWorkStore.listUnsettledWorkspaceTasks()).map((record) => record.itemId)).toEqual(["shell-12345678"]);
  });
});

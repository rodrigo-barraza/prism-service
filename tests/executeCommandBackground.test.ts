import "./setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

/**
 * execute_command the way Claude Code's Bash behaves:
 *   - `run_in_background` answers at once with the task, which the watcher
 *     follows so its exit reaches the agent, and the model reads Claude's line;
 *   - a foreground command is waited for its own timeout plus 30 s — not the
 *     65 s proxy timeout — by the fetch and by the loop's per-tool timeout.
 */

const watched = vi.hoisted(() => ({ requests: [] as Array<Record<string, any>> }));
vi.mock("#src/services/background-tasks/BackgroundTaskWatcher", () => ({
  default: {
    watch: vi.fn(async (request: Record<string, any>) => {
      watched.requests.push(request);
    }),
  },
}));

vi.mock("#src/services/OrchestratorService", () => ({
  default: {
    isSubAgentConversation: vi.fn(() => false),
    stopAgent: vi.fn(),
  },
}));

import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { resolveToolTimeout } from "#src/services/harnesses/lifecycle/ToolExecutor";

const EXECUTE_COMMAND_SCHEMA = {
  name: "execute_command",
  description: "Run a shell command",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  domain: "Core Workspace Tools",
  endpoint: { method: "POST", path: "/agentic/command/run", bodyParams: ["command", "cwd", "timeout", "run_in_background"] },
};

const context = {
  project: "coding",
  username: "rod",
  conversationId: "conv-1",
  agentConversationId: "agent-conv-1",
  workspaceRoot: "/repo",
};

function respondWith(handler: (url: string, init?: RequestInit) => unknown) {
  vi.mocked(global.fetch).mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.includes("/admin/tool-schemas")) {
      return { ok: true, status: 200, statusText: "OK", json: async () => [EXECUTE_COMMAND_SCHEMA] } as Response;
    }
    return handler(target, init as RequestInit) as Response;
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  watched.requests.length = 0;
  respondWith(() => ({ ok: false, status: 500, statusText: "unexpected", json: async () => ({}) }));
  await ToolOrchestratorService.refreshSchemas();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("execute_command with run_in_background", () => {
  it("starts the task through the JSON route, watches it, and gives the model Claude Code's line", async () => {
    const requested: string[] = [];
    respondWith((url) => {
      requested.push(url);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          success: true,
          backgrounded: true,
          taskId: "shell-ab12cd34",
          outputFile: "/tmp/prism-1000/tasks/shell-ab12cd34.output",
          pid: 4242,
          stdout: "",
          stderr: "",
          exitCode: null,
          message: "Command running in background with ID: shell-ab12cd34. Output is being written to: /tmp/prism-1000/tasks/shell-ab12cd34.output",
        }),
      };
    });

    const result = (await ToolOrchestratorService.executeToolStreaming(
      TOOL_NAMES.RUN_COMMAND,
      { command: "npm run build", description: "Build the client", cwd: "/repo", run_in_background: true },
      vi.fn(),
      context,
    )) as Record<string, unknown>;

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/agentic/command/run");
    expect(result).toMatchObject({
      backgrounded: true,
      taskId: "shell-ab12cd34",
      message:
        "Command running in background with ID: shell-ab12cd34. Output is being written to: /tmp/prism-1000/tasks/shell-ab12cd34.output",
    });
    expect(watched.requests).toEqual([
      {
        taskId: "shell-ab12cd34",
        taskType: "shell",
        description: "Build the client",
        command: "npm run build",
        outputFile: "/tmp/prism-1000/tasks/shell-ab12cd34.output",
        owner: {
          conversationId: "conv-1",
          agentConversationId: "agent-conv-1",
          project: "coding",
          username: "rod",
          workspaceRoot: "/repo",
          isSubAgent: false,
        },
      },
    ]);
  });

  it("names a call without a description by its command", async () => {
    respondWith(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ success: true, backgrounded: true, taskId: "shell-11111111", outputFile: "/tmp/o" }),
    }));
    await ToolOrchestratorService.executeTool(
      TOOL_NAMES.RUN_COMMAND,
      { command: "until curl -s localhost:3000; do sleep 1; done\necho ready", run_in_background: true },
      context,
    );
    expect(watched.requests[0].description).toBe("until curl -s localhost:3000; do sleep 1; done");
  });

  it("leaves a foreground result alone", async () => {
    respondWith(() => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ success: true, stdout: "ok\n", stderr: "", exitCode: 0 }),
    }));
    const result = await ToolOrchestratorService.executeTool(TOOL_NAMES.RUN_COMMAND, { command: "ls" }, context);
    expect(result).toEqual({ success: true, stdout: "ok\n", stderr: "", exitCode: 0 });
    expect(watched.requests).toHaveLength(0);
  });
});

describe("a foreground execute_command's deadline", () => {
  /** A stream that sends nothing until `finish` (or errors when its fetch is aborted). */
  function hangingStream() {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    respondWith((_url, init) => {
      signal = init?.signal ?? undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"event":"start"}\n'));
          signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          finish = () => {
            controller.enqueue(encoder.encode('data: {"event":"exit","success":true,"exitCode":0}\n'));
            controller.close();
          };
        },
      });
      return { ok: true, status: 200, statusText: "OK", body, headers: new Headers() };
    });
    return { finish: () => finish(), aborted: () => signal?.aborted === true };
  }

  it("outlives the 65 s proxy timeout while the command's own timeout runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = hangingStream();
    const pending = ToolOrchestratorService.executeToolStreaming(
      TOOL_NAMES.RUN_COMMAND,
      { command: "npm test", timeout: 600_000 },
      null,
      context,
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stream.aborted()).toBe(false);
    stream.finish();
    await expect(pending).resolves.toMatchObject({ success: true, exitCode: 0 });
  });

  it("gives up the command's timeout plus 30 s in — on the whole run, not only its start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = hangingStream();
    const pending = ToolOrchestratorService.executeToolStreaming(
      TOOL_NAMES.RUN_COMMAND,
      { command: "sleep 999", timeout: 5_000 },
      null,
      context,
    );
    await vi.advanceTimersByTimeAsync(34_999);
    expect(stream.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toEqual({
      error: "No answer from tools-service within 35000 ms (the command's timeout plus 30000 ms)",
    });
  });

  it("the loop's per-tool timeout covers the command's own deadline", () => {
    const loop = { options: {} } as never;
    expect(resolveToolTimeout(TOOL_NAMES.RUN_COMMAND, loop, { command: "x", timeout: 600_000 })).toBe(630_000);
    expect(resolveToolTimeout(TOOL_NAMES.RUN_COMMAND, loop, { command: "x" })).toBe(600_000);
    expect(resolveToolTimeout(TOOL_NAMES.RUN_COMMAND, loop, { command: "x", run_in_background: true })).toBe(600_000);
    const configured = { options: { toolTimeoutMilliseconds: 60_000 } } as never;
    expect(resolveToolTimeout(TOOL_NAMES.RUN_COMMAND, configured, { command: "x" })).toBe(150_000);
    expect(resolveToolTimeout("read_file", configured, {})).toBe(60_000);
    const disabled = { options: { toolTimeoutMilliseconds: 0 } } as never;
    expect(resolveToolTimeout(TOOL_NAMES.RUN_COMMAND, disabled, { command: "x" })).toBe(0);
  });
});

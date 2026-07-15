import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Logger ───────────────────────────────────────────────────────
vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ── Mock PromptLocaleService ──────────────────────────────────────────
// Return a deterministic string based on the key so assertions are stable
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    get: (_locale: string, key: string, variables?: Record<string, string>) => {
      // Simulate the actual locale file strings for assertion clarity
      const localeStrings: Record<string, string> = {
        "internal-tools-runtime.run_async_task.noConversation":
          "Cannot dispatch async task: no conversation context available.",
        "internal-tools-runtime.run_async_task.noToolName":
          "Missing required parameter 'toolName'. Specify which tool to run asynchronously.",
        "internal-tools-runtime.run_async_task.disallowedTool":
          `Tool "${variables?.toolName || ""}" cannot be dispatched asynchronously.`,
        "internal-tools-runtime.run_async_task.concurrencyLimit":
          `Maximum concurrent async tasks (${variables?.max || ""}) reached for this conversation.`,
        "internal-tools-runtime.list_async_tasks.noConversation":
          "Cannot list async tasks: no conversation context available.",
        "internal-tools-runtime.cancel_async_task.noTaskId":
          "Missing required parameter 'taskId'. Use list_async_tasks to find the task ID.",
        "internal-tools-runtime.cancel_async_task.notFound":
          `Task "${variables?.taskId || ""}" not found.`,
        "internal-tools-runtime.cancel_async_task.alreadyTerminal":
          `Task "${variables?.taskId || ""}" is already in "${variables?.status || ""}" state.`,
        "internal-tools-runtime.cancel_async_task.success":
          `Task "${variables?.taskId || ""}" has been cancelled.`,
      };
      return localeStrings[key] || `[MISSING: ${key}]`;
    },
  },
}));

// ── Mock AsyncTaskRegistry ────────────────────────────────────────────
const mockDispatch = vi.fn();
const mockListTasks = vi.fn();
const mockCancelTask = vi.fn();
const mockGetTask = vi.fn();

vi.mock("#src/services/AsyncTaskRegistry", () => ({
  default: {
    dispatch: (...arguments_: any[]) => mockDispatch(...arguments_),
    listTasks: (...arguments_: any[]) => mockListTasks(...arguments_),
    cancelTask: (...arguments_: any[]) => mockCancelTask(...arguments_),
    getTask: (...arguments_: any[]) => mockGetTask(...arguments_),
  },
}));

// ── Mock ToolOrchestratorService ──────────────────────────────────────
const mockIsStreamable = vi.fn().mockReturnValue(false);
const mockExecuteTool = vi.fn().mockResolvedValue({ success: true });
const mockExecuteToolStreaming = vi.fn().mockResolvedValue({ success: true });

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    isStreamable: (...arguments_: any[]) => mockIsStreamable(...arguments_),
    executeTool: (...arguments_: any[]) => mockExecuteTool(...arguments_),
    executeToolStreaming: (...arguments_: any[]) => mockExecuteToolStreaming(...arguments_),
  },
}));

// ── Mock WebSocketConnectionRegistry ──────────────────────────────────
vi.mock("#src/websocket/WebSocketConnectionRegistry", () => ({
  default: {
    getEmitFunction: vi.fn().mockReturnValue(null),
  },
}));

// ── Mock ConversationService ──────────────────────────────────────────
vi.mock("#src/services/ConversationService", () => ({
  default: {
    appendMessages: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Mock MongoWrapper ─────────────────────────────────────────────────
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () => ({ collection: () => ({}) }),
    getCollection: () => ({
      findOne: vi.fn().mockResolvedValue(null),
    }),
  },
}));

// ── Mock ChatRoutes ───────────────────────────────────────────────────
vi.mock("#src/routes/ChatRoutes", () => ({
  handleAgent: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock CleanupRegistry ──────────────────────────────────────────────
vi.mock("#src/utils/CleanupRegistry", () => ({
  registerCleanup: vi.fn(),
}));

// ── Mock AbortController ──────────────────────────────────────────────
vi.mock("#src/utils/AbortController", () => ({
  createAbortController: () => new AbortController(),
}));

// ── Mock EmbeddingService (needed by InternalToolRegistry loading) ────
vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue([0.1, 0.2]) },
}));

// ── Mock AgenticLoopService ───────────────────────────────────────────
vi.mock("#src/services/AgenticLoopService", () => ({
  default: { _setPendingQuestion: vi.fn() },
}));

// ── Mock MCPClientService ─────────────────────────────────────────────
vi.mock("#src/services/MCPClientService", () => ({
  default: {
    listResources: vi.fn(),
    getConnectedServers: vi.fn().mockReturnValue([]),
    readResource: vi.fn(),
    authenticate: vi.fn(),
  },
}));

// ── Mock ConversationTimerService ─────────────────────────────────────
vi.mock("#src/services/ConversationTimerService", () => ({
  default: {
    createTimer: vi.fn(),
    listActiveTimers: vi.fn(),
    cancelTimer: vi.fn(),
  },
}));

// ── Mock SkillService ─────────────────────────────────────────────────
vi.mock("#src/services/SkillService", () => ({
  default: {
    create: vi.fn(),
    prepare: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
}));

// ── Mock ToolOrchestratorService (for InternalToolRegistry) ───────────
vi.mock("#src/types/GlobalToolOrchestratorRegistry", () => ({
  getGlobalToolOrchestratorService: () => ({
    getClientToolSchemas: () => [],
    executeTool: vi.fn(),
  }),
}));

import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import { ASYNC_TASK_TOOL_NAMES, MAXIMUM_CONCURRENT_ASYNC_TASKS } from "#src/services/AsyncTaskConstants";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function buildContext(overrides: Record<string, unknown> = {}) {
  return {
    agentConversationId: "conv-async-test",
    project: "test-project",
    username: "test-user",
    ...overrides,
  };
}

const FIXED_TASK_STATE = {
  taskId: "task-1-abcd",
  toolName: "execute_command",
  status: "running",
  startedAt: Date.now(),
  completedAt: null,
  durationMilliseconds: null,
};

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("AsyncTaskTools Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Registration ────────────────────────────────────────────
  describe("tool registration", () => {
    it("should register all three async task tools in InternalToolRegistry", () => {
      expect(InternalToolRegistry.has(ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK)).toBe(true);
      expect(InternalToolRegistry.has(ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS)).toBe(true);
      expect(InternalToolRegistry.has(ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK)).toBe(true);
    });
  });

  // ── run_async_task ──────────────────────────────────────────
  describe("run_async_task", () => {
    it("should dispatch a tool and return NON_BLOCKING_DISPATCH directive", async () => {
      mockDispatch.mockReturnValue({ ...FIXED_TASK_STATE });

      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "execute_command", toolArguments: { command: "ls -la" } },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          _directive: "NON_BLOCKING_DISPATCH",
          task: expect.objectContaining({
            taskId: "task-1-abcd",
            toolName: "execute_command",
            status: "running",
          }),
        }),
      );
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    it("should return error when agentConversationId is missing", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "execute_command", toolArguments: {} },
        { project: "test-project" }, // No agentConversationId
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("no conversation context"),
        }),
      );
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("should return error when toolName is missing", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolArguments: { command: "ls" } }, // No toolName
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("toolName"),
        }),
      );
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("should return error when toolName is empty string", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "   ", toolArguments: {} },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("toolName"),
        }),
      );
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("should reject disallowed tools (recursive dispatch)", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK, toolArguments: {} },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("cannot be dispatched asynchronously"),
        }),
      );
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("should reject disallowed interactive tools like ask_user", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "ask_user", toolArguments: {} },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("cannot be dispatched asynchronously"),
        }),
      );
    });

    it("should return concurrency limit error when AsyncTaskRegistry indicates limit reached", async () => {
      mockDispatch.mockReturnValue({
        error: `Maximum concurrent async tasks (${MAXIMUM_CONCURRENT_ASYNC_TASKS}) reached.`,
      });

      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "search_web", toolArguments: { query: "test" } },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("concurrent async tasks"),
        }),
      );
    });

    it("should default toolArguments to empty object when not provided", async () => {
      mockDispatch.mockReturnValue({ ...FIXED_TASK_STATE, toolName: "search_web" });

      await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "search_web" }, // No toolArguments key
        buildContext(),
      );

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      // The second argument passed to dispatch is the inner tool arguments
      const dispatchedToolArguments = mockDispatch.mock.calls[0][1];
      expect(dispatchedToolArguments).toEqual({});
    });
  });

  // ── list_async_tasks ────────────────────────────────────────
  describe("list_async_tasks", () => {
    it("should list tasks for the current conversation", async () => {
      const completedTimestamp = Date.now();
      mockListTasks.mockReturnValue([
        {
          ...FIXED_TASK_STATE,
          status: "completed",
          completedAt: completedTimestamp,
          durationMilliseconds: 1500,
          result: { output: "file listing" },
        },
        {
          ...FIXED_TASK_STATE,
          taskId: "task-2-efgh",
          toolName: "search_web",
          status: "running",
        },
      ]);

      const result = (await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
        {},
        buildContext(),
      )) as Record<string, unknown>;

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          count: 2,
          running: 1,
          tasks: expect.arrayContaining([
            expect.objectContaining({
              taskId: "task-1-abcd",
              status: "completed",
              result: { output: "file listing" },
            }),
            expect.objectContaining({
              taskId: "task-2-efgh",
              status: "running",
            }),
          ]),
        }),
      );
      expect(mockListTasks).toHaveBeenCalledWith("conv-async-test");
    });

    it("should return empty list when no tasks exist", async () => {
      mockListTasks.mockReturnValue([]);

      const result = (await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
        {},
        buildContext(),
      )) as Record<string, unknown>;

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          count: 0,
          running: 0,
          tasks: [],
        }),
      );
    });

    it("should return error when agentConversationId is missing", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
        {},
        { project: "test-project" },
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("no conversation context"),
        }),
      );
      expect(mockListTasks).not.toHaveBeenCalled();
    });

    it("should include error field for failed tasks", async () => {
      mockListTasks.mockReturnValue([
        {
          ...FIXED_TASK_STATE,
          status: "failed",
          completedAt: Date.now(),
          durationMilliseconds: 500,
          error: "Command timed out",
        },
      ]);

      const result = (await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
        {},
        buildContext(),
      )) as Record<string, unknown>;

      const tasks = result.tasks as Array<Record<string, unknown>>;
      expect(tasks[0]).toEqual(
        expect.objectContaining({
          status: "failed",
          error: "Command timed out",
        }),
      );
      // Failed tasks should NOT include a result field
      expect(tasks[0]).not.toHaveProperty("result");
    });
  });

  // ── cancel_async_task ───────────────────────────────────────
  describe("cancel_async_task", () => {
    it("should successfully cancel a running task", async () => {
      mockCancelTask.mockReturnValue(true);

      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
        { taskId: "task-1-abcd" },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          message: expect.stringContaining("has been cancelled"),
        }),
      );
      expect(mockCancelTask).toHaveBeenCalledWith("task-1-abcd");
    });

    it("should return error when taskId is missing", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
        {}, // No taskId
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("taskId"),
        }),
      );
      expect(mockCancelTask).not.toHaveBeenCalled();
    });

    it("should return error when taskId is empty string", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
        { taskId: "   " },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("taskId"),
        }),
      );
      expect(mockCancelTask).not.toHaveBeenCalled();
    });

    it("should report when task is already in terminal state", async () => {
      mockCancelTask.mockReturnValue(false);
      mockGetTask.mockReturnValue({
        ...FIXED_TASK_STATE,
        taskId: "task-done-xyz",
        status: "completed",
      });

      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
        { taskId: "task-done-xyz" },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining("already in"),
        }),
      );
    });

    it("should report when task is not found", async () => {
      mockCancelTask.mockReturnValue(false);
      mockGetTask.mockReturnValue(null);

      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
        { taskId: "task-nonexistent" },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining("not found"),
        }),
      );
    });
  });

  // ── Adversarial edge cases ──────────────────────────────────
  describe("adversarial edge cases", () => {
    it("should reject all disallowed sub-agent orchestration tools", async () => {
      const disallowedOrchestratorTools = [
        "create_subagent",
        "create_subagents",
        "send_subagent_message",
        "stop_subagent",
        "get_subagent_output",
        "delete_subagents",
        "resume_subagent",
      ];

      for (const toolName of disallowedOrchestratorTools) {
        const result = (await InternalToolRegistry.execute(
          ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
          { toolName, toolArguments: {} },
          buildContext(),
        )) as Record<string, unknown>;

        expect(result.error).toBeDefined();
        expect(result.error).toContain("cannot be dispatched asynchronously");
      }

      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("should reject all disallowed timer tools", async () => {
      const disallowedTimerTools = [
        "set_timer",
        "list_timers",
        "cancel_timer",
      ];

      for (const toolName of disallowedTimerTools) {
        const result = (await InternalToolRegistry.execute(
          ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
          { toolName, toolArguments: {} },
          buildContext(),
        )) as Record<string, unknown>;

        expect(result.error).toBeDefined();
        expect(result.error).toContain("cannot be dispatched asynchronously");
      }
    });

    it("should reject all disallowed tool-management tools", async () => {
      const disallowedToolManagementTools = [
        "enable_tools",
        "disable_tools",
        "discover_and_enable_tools",
        "search_tools",
      ];

      for (const toolName of disallowedToolManagementTools) {
        const result = (await InternalToolRegistry.execute(
          ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
          { toolName, toolArguments: {} },
          buildContext(),
        )) as Record<string, unknown>;

        expect(result.error).toBeDefined();
        expect(result.error).toContain("cannot be dispatched asynchronously");
      }
    });

    it("should accept legitimate non-disallowed tools", async () => {
      const allowedTools = ["execute_command", "search_web", "read_url", "write_file"];

      for (const toolName of allowedTools) {
        mockDispatch.mockReturnValue({ ...FIXED_TASK_STATE, toolName });

        const result = (await InternalToolRegistry.execute(
          ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
          { toolName, toolArguments: {} },
          buildContext(),
        )) as Record<string, unknown>;

        expect(result._directive).toBe("NON_BLOCKING_DISPATCH");
      }

      expect(mockDispatch).toHaveBeenCalledTimes(allowedTools.length);
    });

    it("should handle non-string toolName gracefully", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: 12345, toolArguments: {} },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("toolName"),
        }),
      );
    });

    it("should handle non-object toolArguments gracefully", async () => {
      mockDispatch.mockReturnValue({ ...FIXED_TASK_STATE });

      await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
        { toolName: "execute_command", toolArguments: "not-an-object" },
        buildContext(),
      );

      // Should fall back to empty object
      const dispatchedToolArguments = mockDispatch.mock.calls[0][1];
      expect(dispatchedToolArguments).toEqual({});
    });

    it("should handle non-string taskId in cancel gracefully", async () => {
      const result = await InternalToolRegistry.execute(
        ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
        { taskId: 99999 },
        buildContext(),
      );

      expect(result).toEqual(
        expect.objectContaining({
          error: expect.stringContaining("taskId"),
        }),
      );
    });
  });
});

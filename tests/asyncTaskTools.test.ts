import { describe, it, expect, beforeEach, vi } from "vitest";

// ────────────────────────────────────────────────────────────
// Mock dependencies
// ────────────────────────────────────────────────────────────

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../src/utils/AbortController.ts", () => ({
  createAbortController: () => new AbortController(),
}));

vi.mock("../src/utils/CleanupRegistry.ts", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../src/utils/ErrorHelpers.ts", () => ({
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

// Mock ToolOrchestratorService
const mockExecuteTool = vi.fn();
const mockExecuteToolStreaming = vi.fn();
const mockIsStreamable = vi.fn(() => false);

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    executeTool: mockExecuteTool,
    executeToolStreaming: mockExecuteToolStreaming,
    isStreamable: mockIsStreamable,
  },
}));

// Mock WebSocketConnectionRegistry
vi.mock("../src/websocket/WebSocketConnectionRegistry.ts", () => ({
  default: {
    getEmitFunction: vi.fn(() => null),
  },
}));

// Mock ConversationService
vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    appendMessages: vi.fn(() => Promise.resolve()),
  },
}));

// Mock MongoWrapper
vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn(() => null),
    getCollection: vi.fn(() => null),
  },
}));

// Mock config
vi.mock("../../config.ts", () => ({
  MONGO_DB_NAME: "test-db",
}));

vi.mock("../src/constants.ts", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    COLLECTIONS: {
      ...actual.COLLECTIONS,
      AGENT_CONVERSATIONS: "agent_conversations",
    },
  };
});

// Mock ChatRoutes
vi.mock("../src/routes/ChatRoutes.ts", () => ({
  handleAgent: vi.fn(() => Promise.resolve()),
}));

// ────────────────────────────────────────────────────────────
// Imports
// ────────────────────────────────────────────────────────────

import asyncTaskTools from "../src/services/local-tools/AsyncTaskTools.ts";
import AsyncTaskRegistry from "../src/services/AsyncTaskRegistry.ts";
import { ASYNC_TASK_TOOL_NAMES } from "../src/services/AsyncTaskConstants.ts";

// Extract individual tools
const [runAsyncTask, listAsyncTasks, cancelAsyncTask] = asyncTaskTools;

const createContext = (overrides = {}) => ({
  agentConversationId: "test-session-123",
  project: "test-project",
  username: "test-user",
  ...overrides,
});

describe("AsyncTaskTools", () => {
  beforeEach(() => {
    AsyncTaskRegistry.clear();
    vi.clearAllMocks();
    mockIsStreamable.mockReturnValue(false);
  });

  // ── Tool Schema Validation ──────────────────────────────

  describe("Schema validation", () => {
    it("should export exactly 3 tools", () => {
      expect(asyncTaskTools).toHaveLength(3);
    });

    it("should use correct tool names from constants", () => {
      expect(runAsyncTask.name).toBe(ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK);
      expect(listAsyncTasks.name).toBe(ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS);
      expect(cancelAsyncTask.name).toBe(ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK);
    });

    it("should have emoji arrays on all schemas", () => {
      for (const tool of asyncTaskTools) {
        expect(tool.schema.emoji).toBeDefined();
        expect(Array.isArray(tool.schema.emoji)).toBe(true);
        expect(tool.schema.emoji!.length).toBeGreaterThan(0);
      }
    });

    it("should have descriptions on all schemas", () => {
      for (const tool of asyncTaskTools) {
        expect(tool.schema.description).toBeDefined();
        expect(typeof tool.schema.description).toBe("string");
        expect(tool.schema.description!.length).toBeGreaterThan(20);
      }
    });

    it("should require toolName and toolArguments for run_async_task", () => {
      const requiredParameters = runAsyncTask.schema.parameters?.required;
      expect(requiredParameters).toContain("toolName");
      expect(requiredParameters).toContain("toolArguments");
    });

    it("should require taskId for cancel_async_task", () => {
      const requiredParameters = cancelAsyncTask.schema.parameters?.required;
      expect(requiredParameters).toContain("taskId");
    });
  });

  // ── run_async_task ──────────────────────────────────────

  describe("run_async_task", () => {
    it("should dispatch a task and return NON_BLOCKING_DISPATCH directive", async () => {
      mockExecuteTool.mockResolvedValue({ output: "command result" });

      const result = await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "ls -la" } },
        createContext(),
      );

      expect(result).toHaveProperty("_directive", "NON_BLOCKING_DISPATCH");
      expect(result).toHaveProperty("task");
      const typedResult = result as { task: { taskId: string; toolName: string; status: string } };
      expect(typedResult.task.taskId).toMatch(/^task-/);
      expect(typedResult.task.toolName).toBe("execute_command");
      expect(typedResult.task.status).toBe("running");
    });

    it("should return error when toolName is missing", async () => {
      const result = await runAsyncTask.execute(
        { toolArguments: { command: "ls" } },
        createContext(),
      );

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("toolName");
    });

    it("should return error when agentConversationId is missing", async () => {
      const result = await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {} },
        createContext({ agentConversationId: undefined }),
      );

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("conversation");
    });

    it("should reject disallowed tools (recursive async dispatch)", async () => {
      const result = await runAsyncTask.execute(
        { toolName: "run_async_task", toolArguments: {} },
        createContext(),
      );

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("cannot be dispatched asynchronously");
    });

    it("should reject orchestrator tools", async () => {
      const result = await runAsyncTask.execute(
        { toolName: "create_subagents", toolArguments: {} },
        createContext(),
      );

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("cannot be dispatched asynchronously");
    });

    it("should reject interactive tools", async () => {
      const result = await runAsyncTask.execute(
        { toolName: "ask_user", toolArguments: {} },
        createContext(),
      );

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("cannot be dispatched asynchronously");
    });

    it("should handle empty toolName gracefully", async () => {
      const result = await runAsyncTask.execute(
        { toolName: "  ", toolArguments: {} },
        createContext(),
      );

      expect(result).toHaveProperty("error");
    });

    it("should use executeToolStreaming for streamable tools", async () => {
      mockIsStreamable.mockReturnValue(true);
      mockExecuteToolStreaming.mockResolvedValue({ output: "streamed" });

      const result = await runAsyncTask.execute(
        { toolName: "read_url", toolArguments: { url: "https://example.com" } },
        createContext(),
      );

      expect(result).toHaveProperty("_directive", "NON_BLOCKING_DISPATCH");

      // Wait for the background executor to finish
      await vi.waitFor(() => {
        const tasks = AsyncTaskRegistry.listTasks("test-session-123");
        return tasks.some((taskState) => taskState.status === "completed");
      });

      expect(mockExecuteToolStreaming).toHaveBeenCalled();
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("should use executeTool for non-streamable tools", async () => {
      mockIsStreamable.mockReturnValue(false);
      mockExecuteTool.mockResolvedValue({ output: "non-streamed" });

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "echo hi" } },
        createContext(),
      );

      // Wait for the background executor to finish
      await vi.waitFor(() => {
        const tasks = AsyncTaskRegistry.listTasks("test-session-123");
        return tasks.some((taskState) => taskState.status === "completed");
      });

      expect(mockExecuteTool).toHaveBeenCalled();
      expect(mockExecuteToolStreaming).not.toHaveBeenCalled();
    });
  });

  // ── list_async_tasks ────────────────────────────────────

  describe("list_async_tasks", () => {
    it("should list tasks for the current conversation", async () => {
      // Dispatch two tasks
      mockExecuteTool.mockResolvedValue({ output: "result" });
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "ls" } },
        createContext(),
      );
      await runAsyncTask.execute(
        { toolName: "search_web", toolArguments: { query: "test" } },
        createContext(),
      );

      const result = await listAsyncTasks.execute({}, createContext());

      expect(result).toHaveProperty("success", true);
      const typedResult = result as { tasks: unknown[]; count: number; running: number };
      expect(typedResult.count).toBe(2);
      expect(typedResult.tasks).toHaveLength(2);
    });

    it("should return empty list when no tasks exist", async () => {
      const result = await listAsyncTasks.execute({}, createContext());

      expect(result).toHaveProperty("success", true);
      const typedResult = result as { tasks: unknown[]; count: number };
      expect(typedResult.count).toBe(0);
      expect(typedResult.tasks).toHaveLength(0);
    });

    it("should return error when conversation context is missing", async () => {
      const result = await listAsyncTasks.execute(
        {},
        createContext({ agentConversationId: undefined }),
      );

      expect(result).toHaveProperty("error");
    });

    it("should include result for completed tasks and error for failed tasks", async () => {
      // Dispatch a task that will complete
      mockExecuteTool.mockResolvedValueOnce({ output: "success" });
      await runAsyncTask.execute(
        { toolName: "search_web", toolArguments: { query: "good" } },
        createContext(),
      );

      // Dispatch a task that will fail
      mockExecuteTool.mockRejectedValueOnce(new Error("network error"));
      await runAsyncTask.execute(
        { toolName: "read_url", toolArguments: { url: "bad" } },
        createContext(),
      );

      // Wait for both to settle
      await vi.waitFor(() => {
        const tasks = AsyncTaskRegistry.listTasks("test-session-123");
        return tasks.every((taskState) => taskState.status !== "running");
      });

      const result = await listAsyncTasks.execute({}, createContext());
      const typedResult = result as { tasks: Array<{ status: string; result?: unknown; error?: string }> };

      const completedTask = typedResult.tasks.find(
        (taskState) => taskState.status === "completed",
      );
      const failedTask = typedResult.tasks.find(
        (taskState) => taskState.status === "failed",
      );

      expect(completedTask?.result).toBeDefined();
      expect(failedTask?.error).toBe("network error");
    });
  });

  // ── cancel_async_task ───────────────────────────────────

  describe("cancel_async_task", () => {
    it("should cancel a running task", async () => {
      // Dispatch a long-running task
      mockExecuteTool.mockReturnValue(
        new Promise(() => {}), // Never resolves
      );

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "sleep 100" } },
        createContext(),
      );

      const allTasks = AsyncTaskRegistry.listTasks("test-session-123");
      expect(allTasks).toHaveLength(1);
      const taskId = allTasks[0].taskId;

      const result = await cancelAsyncTask.execute(
        { taskId },
        createContext(),
      );

      expect(result).toHaveProperty("success", true);
      expect((result as { message: string }).message).toContain("cancelled");

      // Verify the task is now cancelled in the registry
      const cancelledTask = AsyncTaskRegistry.getTask(taskId);
      expect(cancelledTask?.status).toBe("cancelled");
    });

    it("should return error when taskId is missing", async () => {
      const result = await cancelAsyncTask.execute({}, createContext());

      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("taskId");
    });

    it("should return failure for nonexistent task", async () => {
      const result = await cancelAsyncTask.execute(
        { taskId: "nonexistent-task" },
        createContext(),
      );

      expect(result).toHaveProperty("success", false);
      expect((result as { message: string }).message).toContain("not found");
    });

    it("should return failure for already-completed task", async () => {
      mockExecuteTool.mockResolvedValue({ output: "done" });

      await runAsyncTask.execute(
        { toolName: "search_web", toolArguments: { query: "quick" } },
        createContext(),
      );

      // Wait for completion
      await vi.waitFor(() => {
        const tasks = AsyncTaskRegistry.listTasks("test-session-123");
        return tasks.some((taskState) => taskState.status === "completed");
      });

      const completedTask = AsyncTaskRegistry.listTasks("test-session-123")[0];
      const result = await cancelAsyncTask.execute(
        { taskId: completedTask.taskId },
        createContext(),
      );

      expect(result).toHaveProperty("success", false);
      expect((result as { message: string }).message).toContain("completed");
    });
  });

  // ── Disallowed Tool Coverage ────────────────────────────

  describe("Disallowed tool validation", () => {
    const disallowedToolNames = [
      "run_async_task",
      "list_async_tasks",
      "cancel_async_task",
      "create_subagents",
      "send_subagent_message",
      "stop_subagent",
      "get_subagent_output",
      "delete_subagents",
      "resume_subagent",
      "ask_user",
      "enter_plan_mode",
      "exit_plan_mode",
      "set_timer",
      "list_timers",
      "cancel_timer",
      "enable_tools",
      "disable_tools",
      "discover_and_enable_tools",
      "search_tools",
    ];

    for (const disallowedToolName of disallowedToolNames) {
      it(`should reject "${disallowedToolName}" as an async dispatch target`, async () => {
        const result = await runAsyncTask.execute(
          { toolName: disallowedToolName, toolArguments: {} },
          createContext(),
        );

        expect(result).toHaveProperty("error");
        expect((result as { error: string }).error).toContain("cannot be dispatched asynchronously");
      });
    }
  });

  // ── Context Propagation ─────────────────────────────────

  describe("Context propagation", () => {
    it("should propagate project and username to the executor", async () => {
      mockExecuteTool.mockResolvedValue({ output: "ok" });

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "whoami" } },
        createContext({ project: "my-project", username: "rodrigo" }),
      );

      // Wait for execution
      await vi.waitFor(() => {
        const tasks = AsyncTaskRegistry.listTasks("test-session-123");
        return tasks.some((taskState) => taskState.status === "completed");
      });

      expect(mockExecuteTool).toHaveBeenCalledWith(
        "execute_command",
        { command: "whoami" },
        expect.objectContaining({
          project: "my-project",
          username: "rodrigo",
          agentConversationId: "test-session-123",
        }),
      );
    });

    it("should store context on the task state", async () => {
      mockExecuteTool.mockReturnValue(new Promise(() => {}));

      await runAsyncTask.execute(
        { toolName: "search_web", toolArguments: { query: "test" } },
        createContext({ project: "proj", username: "user" }),
      );

      const tasks = AsyncTaskRegistry.listTasks("test-session-123");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].project).toBe("proj");
      expect(tasks[0].username).toBe("user");
      expect(tasks[0].agentConversationId).toBe("test-session-123");
    });
  });
});

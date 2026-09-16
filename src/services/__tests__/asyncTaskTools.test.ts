import { describe, it, expect, beforeEach, vi } from "vitest";

// ────────────────────────────────────────────────────────────
// Mock dependencies
// ────────────────────────────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("#src/utils/AbortController", () => ({
  createAbortController: () => new AbortController(),
}));

vi.mock("#src/utils/CleanupRegistry", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("@rodrigo-barraza/utilities-library", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

// Mock ToolOrchestratorService
const mockExecuteTool = vi.fn();
const mockExecuteToolStreaming = vi.fn();
const mockIsStreamable = vi.fn(() => false);

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    executeTool: mockExecuteTool,
    executeToolStreaming: mockExecuteToolStreaming,
    isStreamable: mockIsStreamable,
  },
}));

// Mock WebSocketConnectionRegistry
vi.mock("#src/websocket/WebSocketConnectionRegistry", () => ({
  default: {
    getEmitFunction: vi.fn(() => null),
  },
}));

// Mock ConversationService
vi.mock("#src/services/ConversationService", () => ({
  default: {
    appendMessages: vi.fn(() => Promise.resolve()),
  },
}));

// Mock MongoWrapper
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(() => null),
    getCollection: vi.fn(() => null),
  },
}));

// Mock config
vi.mock("#src/config", () => ({
  MONGO_DB_NAME: "test-db",
}));

vi.mock("#src/constants", async (importOriginal) => {
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
const mockHandleAgent = vi.fn(() => Promise.resolve());
vi.mock("#src/routes/ChatRoutes", () => ({
  handleAgent: (...callArguments: unknown[]) => mockHandleAgent(...(callArguments as [])),
}));

// Mock the counter service the auto-response path pays back
const mockAdjustPendingBackgroundTasks = vi.fn(() => Promise.resolve());
vi.mock("#src/services/conversation/ConversationService", () => ({
  default: {
    adjustPendingBackgroundTasks: (...callArguments: unknown[]) =>
      mockAdjustPendingBackgroundTasks(...(callArguments as [])),
  },
}));

// Mock OrchestratorService (lazily imported by the completion path and by
// wait_for_tasks for sub-agent waits)
const mockIsSubAgentConversation = vi.fn(() => false);
const mockWaitForAgents = vi.fn(async () => [] as unknown[]);
vi.mock("#src/services/OrchestratorService", () => ({
  default: {
    isSubAgentConversation: (...callArguments: unknown[]) =>
      mockIsSubAgentConversation(...(callArguments as [])),
    waitForAgents: (...callArguments: unknown[]) => mockWaitForAgents(...(callArguments as [])),
  },
}));

// ────────────────────────────────────────────────────────────
// Imports
// ────────────────────────────────────────────────────────────

import asyncTaskTools from "#src/services/tool-definitions/AsyncTaskTools";
import AsyncTaskRegistry from "#src/services/AsyncTaskRegistry";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { ASYNC_TASK_TOOL_NAMES } from "#src/services/AsyncTaskConstants";
import { AGENT_DIRECTIVES, NOTIFICATION_SOURCES } from "#src/constants";

// Extract individual tools
const [runAsyncTask, listAsyncTasks, cancelAsyncTask, waitForTasksTool] = asyncTaskTools;

const createContext = (overrides = {}) => ({
  agentConversationId: "test-session-123",
  conversationId: "test-session-123",
  project: "test-project",
  username: "test-user",
  ...overrides,
});

/** A deferred executor result so a test controls when the task settles. */
function deferExecution() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  mockExecuteTool.mockReturnValueOnce(promise);
  return { resolve, reject };
}

async function settle(): Promise<void> {
  // Let the registry's .then and the detached delivery promise run.
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
}

describe("AsyncTaskTools", () => {
  beforeEach(() => {
    AsyncTaskRegistry.clear();
    TurnInputMailbox._clearAll();
    vi.clearAllMocks();
    mockIsStreamable.mockReturnValue(false);
    mockIsSubAgentConversation.mockReturnValue(false);
    mockWaitForAgents.mockResolvedValue([]);
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue(null as any);
  });

  // ── Tool Schema Validation ──────────────────────────────

  describe("Schema validation", () => {
    it("should export exactly 4 tools", () => {
      expect(asyncTaskTools).toHaveLength(4);
    });

    it("should use correct tool names from constants", () => {
      expect(runAsyncTask.name).toBe(ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK);
      expect(listAsyncTasks.name).toBe(ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS);
      expect(cancelAsyncTask.name).toBe(ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK);
      expect(waitForTasksTool.name).toBe(ASYNC_TASK_TOOL_NAMES.WAIT_FOR_TASKS);
    });

    it("should expose the optional continueWorking flag on run_async_task", () => {
      const properties = runAsyncTask.parameters?.properties as Record<string, { type: string }>;
      expect(properties.continueWorking?.type).toBe("boolean");
      expect(runAsyncTask.parameters?.required).not.toContain("continueWorking");
    });

    it("should make every wait_for_tasks parameter optional", () => {
      const properties = waitForTasksTool.parameters?.properties as Record<string, { type: string }>;
      expect(properties.taskIds?.type).toBe("array");
      expect(properties.agentIds?.type).toBe("array");
      expect(properties.timeoutSeconds?.type).toBe("number");
      expect(waitForTasksTool.parameters?.required).toEqual([]);
    });

    it("should have emoji arrays on all schemas", () => {
      for (const tool of asyncTaskTools) {
        expect(tool.emoji).toBeDefined();
        expect(Array.isArray(tool.emoji)).toBe(true);
        expect(tool.emoji!.length).toBeGreaterThan(0);
      }
    });

    it("should have descriptions on all schemas", () => {
      for (const tool of asyncTaskTools) {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe("string");
        expect(tool.description!.length).toBeGreaterThan(20);
      }
    });

    it("should require toolName and toolArguments for run_async_task", () => {
      const requiredParameters = runAsyncTask.parameters?.required;
      expect(requiredParameters).toContain("toolName");
      expect(requiredParameters).toContain("toolArguments");
    });

    it("should require taskId for cancel_async_task", () => {
      const requiredParameters = cancelAsyncTask.parameters?.required;
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
      "wait_for_tasks",
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

  // ── continueWorking ─────────────────────────────────────

  describe("run_async_task with continueWorking", () => {
    it("should return DETACHED_WORK instead of NON_BLOCKING_DISPATCH", async () => {
      deferExecution();

      const result = await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "make" }, continueWorking: true },
        createContext(),
      );

      expect(result).toHaveProperty("_directive", AGENT_DIRECTIVES.DETACHED_WORK);
      expect((result as { _directive: string })._directive).not.toBe(AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH);
      const typed = result as { task: { taskId: string; status: string; startedAt: string }; instruction: string };
      expect(typed.task.taskId).toMatch(/^task-/);
      expect(typed.task.status).toBe("running");
      expect(typed.instruction).toContain("wait_for_tasks");
      expect(typed.instruction).toContain("task-notification");
      expect(typed.instruction).not.toContain("END YOUR TURN");
    });

    it("should keep the default NON_BLOCKING_DISPATCH contract when continueWorking is absent or false", async () => {
      deferExecution();
      deferExecution();

      const absent = await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {} },
        createContext(),
      );
      const explicitFalse = await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: false },
        createContext(),
      );

      expect(absent).toHaveProperty("_directive", AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH);
      expect(explicitFalse).toHaveProperty("_directive", AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH);
      expect((absent as { instruction: string }).instruction).toContain("END YOUR TURN NOW");
    });

    it("should record the client conversationId on the task for mailbox routing", async () => {
      deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext({ conversationId: "client-conv-9" }),
      );
      expect(AsyncTaskRegistry.listTasks("test-session-123")[0].conversationId).toBe("client-conv-9");
    });

    it("should deliver the completion to the OPEN turn through the mailbox and leave the counter alone", async () => {
      TurnInputMailbox.open("test-session-123");
      const { resolve } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: { command: "make" }, continueWorking: true },
        createContext(),
      );
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      expect(TurnInputMailbox.pendingCount("test-session-123")).toBe(0);

      resolve({ output: "build ok" });
      await settle();

      expect(TurnInputMailbox.pendingCount("test-session-123")).toBe(1);
      const [entry] = TurnInputMailbox.drain("test-session-123");
      expect(entry.kind).toBe("task_completion");
      expect(entry.text).toContain("<task-notification>");
      expect(entry.text).toContain("[ASYNC TASK COMPLETED]");
      expect(entry.text).toContain("build ok");
      expect(entry.text).toContain(taskState.taskId);
      expect(entry.meta).toEqual(
        expect.objectContaining({
          _notificationSource: NOTIFICATION_SOURCES.ASYNC_TASK,
          _notificationId: expect.stringMatching(new RegExp(`^async-task:${taskState.taskId}:`)),
          taskId: taskState.taskId,
        }),
      );
      expect(taskState.deliveredVia).toBe("mailbox");

      // No new turn, no counter change.
      expect(mockHandleAgent).not.toHaveBeenCalled();
      expect(mockAdjustPendingBackgroundTasks).not.toHaveBeenCalled();
    });

    it("should deliver a FAILED completion through the mailbox with the error in the block", async () => {
      TurnInputMailbox.open("test-session-123");
      const { reject } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext(),
      );
      reject(new Error("disk full"));
      await settle();

      const [entry] = TurnInputMailbox.drain("test-session-123");
      expect(entry.text).toContain("❌ failed");
      expect(entry.text).toContain("disk full");
    });

    it("should wake a new turn and pay back the counter when the turn has already ended", async () => {
      // No mailbox open: the dispatching turn ended with the task running,
      // so the harness bumped pendingBackgroundTasks; the auto-response
      // must decrement it after handleAgent.
      const findOne = vi.fn().mockResolvedValue({
        id: "test-session-123",
        project: "test-project",
        username: "test-user",
        isGenerating: false,
        messages: [{ role: "user", content: "go" }],
        settings: { provider: "google", model: "gemini" },
      });
      vi.mocked(MongoWrapper.getDb).mockReturnValue({} as any);
      vi.mocked(MongoWrapper.getCollection).mockReturnValue({ findOne } as any);

      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext(),
      );
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");

      resolve({ output: "late result" });
      await vi.waitFor(() => {
        expect(mockHandleAgent).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(mockAdjustPendingBackgroundTasks).toHaveBeenCalledTimes(1);
      });

      expect(taskState.deliveredVia).toBe("auto_response");
      expect(TurnInputMailbox.openCount).toBe(0);
      const [agentParameters] = (mockHandleAgent.mock.calls[0] as unknown as [Record<string, unknown>]);
      expect(agentParameters.conversationId).toBe("test-session-123");
      const lastMessage = (agentParameters.messages as Array<Record<string, unknown>>).at(-1);
      // The reloaded conversation is what handleAgent sees; the notification
      // itself was persisted through appendMessages.
      expect(lastMessage).toBeDefined();
      expect(mockAdjustPendingBackgroundTasks).toHaveBeenCalledWith(
        "test-session-123",
        "test-project",
        "test-user",
        -1,
        expect.objectContaining({ collection: expect.any(String) }),
      );
    });

    it("should pay back the counter even when the auto-response turn throws", async () => {
      const findOne = vi.fn().mockResolvedValue({
        id: "test-session-123",
        project: "test-project",
        username: "test-user",
        isGenerating: false,
        messages: [],
        settings: { provider: "google", model: "gemini" },
      });
      vi.mocked(MongoWrapper.getDb).mockReturnValue({} as any);
      vi.mocked(MongoWrapper.getCollection).mockReturnValue({ findOne } as any);
      mockHandleAgent.mockRejectedValueOnce(new Error("provider down") as never);

      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext(),
      );
      resolve({ output: "x" });

      await vi.waitFor(() => {
        expect(mockAdjustPendingBackgroundTasks).toHaveBeenCalledTimes(1);
      });
    });

    it("should NOT use the mailbox for a default (non-continueWorking) dispatch even when the turn is open", async () => {
      TurnInputMailbox.open("test-session-123");
      const { resolve } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {} },
        createContext(),
      );
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      resolve({ output: "done" });
      await settle();

      // The loop broke on NON_BLOCKING_DISPATCH; a mailbox post would never
      // be drained. The completion takes the wake-a-new-turn path (which
      // bails here because the mocked database is disconnected).
      expect(TurnInputMailbox.pendingCount("test-session-123")).toBe(0);
      expect(taskState.deliveredVia).toBe("auto_response");
    });
  });

  // ── Sub-agent delivery ──────────────────────────────────

  describe("sub-agent completion delivery", () => {
    it("should post to the sub-agent's own open turn (keyed by its conversationId)", async () => {
      TurnInputMailbox.open("sub-agent-conv-1");
      const { resolve } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext({
          agentConversationId: "sub-agent-conv-1",
          conversationId: "sub-agent-conv-1",
          isSubAgent: true,
        }),
      );
      resolve({ output: "sub result" });
      await settle();

      expect(TurnInputMailbox.pendingCount("sub-agent-conv-1")).toBe(1);
      const [taskState] = AsyncTaskRegistry.listTasks("sub-agent-conv-1");
      expect(taskState.deliveredVia).toBe("mailbox");
      expect(mockHandleAgent).not.toHaveBeenCalled();
    });

    it("should deliver a sub-agent's DEFAULT dispatch through the mailbox too (no auto-response for sub-agents)", async () => {
      TurnInputMailbox.open("sub-agent-conv-2");
      const { resolve } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {} },
        createContext({
          agentConversationId: "sub-agent-conv-2",
          conversationId: "sub-agent-conv-2",
          isSubAgent: true,
        }),
      );
      resolve({ output: "sub result" });
      await settle();

      expect(TurnInputMailbox.pendingCount("sub-agent-conv-2")).toBe(1);
      expect(mockHandleAgent).not.toHaveBeenCalled();
    });

    it("should log and drop when the sub-agent's turn is closed — never an auto-response", async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValue({} as any);
      const findOne = vi.fn().mockResolvedValue({
        id: "sub-agent-conv-3",
        isGenerating: false,
        messages: [],
        settings: { provider: "google", model: "gemini" },
      });
      vi.mocked(MongoWrapper.getCollection).mockReturnValue({ findOne } as any);
      const { resolve } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext({
          agentConversationId: "sub-agent-conv-3",
          conversationId: "sub-agent-conv-3",
          isSubAgent: true,
        }),
      );
      resolve({ output: "lost" });
      await settle();

      const [taskState] = AsyncTaskRegistry.listTasks("sub-agent-conv-3");
      expect(taskState.deliveredVia).toBeUndefined();
      expect(mockHandleAgent).not.toHaveBeenCalled();
      expect(mockAdjustPendingBackgroundTasks).not.toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
    });

    it("should recognise a sub-agent through the orchestrator when the context does not say", async () => {
      mockIsSubAgentConversation.mockReturnValue(true);
      vi.mocked(MongoWrapper.getDb).mockReturnValue({} as any);
      const findOne = vi.fn().mockResolvedValue(null);
      vi.mocked(MongoWrapper.getCollection).mockReturnValue({ findOne } as any);
      const { resolve } = deferExecution();

      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext({ agentConversationId: "sub-agent-conv-4", conversationId: "sub-agent-conv-4" }),
      );
      resolve({ output: "x" });
      await settle();

      expect(mockIsSubAgentConversation).toHaveBeenCalledWith("sub-agent-conv-4");
      expect(findOne).not.toHaveBeenCalled();
      expect(mockHandleAgent).not.toHaveBeenCalled();
    });
  });

  // ── wait_for_tasks ──────────────────────────────────────

  describe("wait_for_tasks", () => {
    it("should return error when conversation context is missing", async () => {
      const result = await waitForTasksTool.execute({}, createContext({ agentConversationId: undefined }));
      expect(result).toHaveProperty("error");
    });

    it("should return the result of a task that completes during the wait", async () => {
      TurnInputMailbox.open("test-session-123");
      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext(),
      );
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");

      const waitPromise = waitForTasksTool.execute(
        { taskIds: [taskState.taskId], timeoutSeconds: 5 },
        createContext(),
      );
      await settle();
      expect(taskState.awaitedBy).toBe("test-session-123");

      resolve({ output: "the answer" });
      const result = (await waitPromise) as {
        tasks: Array<Record<string, unknown>>;
        timedOut: boolean;
        stillRunning: string[];
      };

      expect(result.timedOut).toBe(false);
      expect(result.stillRunning).toEqual([]);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]).toEqual(
        expect.objectContaining({
          taskId: taskState.taskId,
          kind: "async_task",
          status: "completed",
          result: expect.stringContaining("the answer"),
        }),
      );
      expect(typeof result.tasks[0].durationMilliseconds).toBe("number");
    });

    it("should suppress the mailbox / auto-response delivery for an awaited task (waiter returns it)", async () => {
      TurnInputMailbox.open("test-session-123");
      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext(),
      );
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");

      const waitPromise = waitForTasksTool.execute({ taskIds: [taskState.taskId] }, createContext());
      await settle();
      resolve({ output: "once only" });
      await waitPromise;
      await settle();

      expect(TurnInputMailbox.pendingCount("test-session-123")).toBe(0);
      expect(mockHandleAgent).not.toHaveBeenCalled();
      expect(taskState.deliveredVia).toBe("wait");
    });

    it("should time out, clear awaitedBy, and let a later completion be delivered normally", async () => {
      TurnInputMailbox.open("test-session-123");
      const { resolve } = deferExecution();
      await runAsyncTask.execute(
        { toolName: "execute_command", toolArguments: {}, continueWorking: true },
        createContext(),
      );
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");

      const result = (await waitForTasksTool.execute(
        { taskIds: [taskState.taskId], timeoutSeconds: 0.05 },
        createContext(),
      )) as { tasks: Array<Record<string, unknown>>; timedOut: boolean; stillRunning: string[] };

      expect(result.timedOut).toBe(true);
      expect(result.stillRunning).toEqual([taskState.taskId]);
      expect(result.tasks[0]).toEqual(expect.objectContaining({ status: "running" }));
      expect(taskState.awaitedBy).toBeUndefined();

      // Completion after the wait gave up → normal mailbox delivery.
      resolve({ output: "eventually" });
      await settle();
      expect(TurnInputMailbox.pendingCount("test-session-123")).toBe(1);
      expect(taskState.deliveredVia).toBe("mailbox");
    });

    it("should return immediately for a task that already settled", async () => {
      mockExecuteTool.mockResolvedValueOnce({ output: "instant" });
      await runAsyncTask.execute({ toolName: "search_web", toolArguments: {} }, createContext());
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      await vi.waitFor(() => expect(taskState.status).toBe("completed"));

      const started = Date.now();
      const result = (await waitForTasksTool.execute(
        { taskIds: [taskState.taskId], timeoutSeconds: 60 },
        createContext(),
      )) as { tasks: Array<Record<string, unknown>>; timedOut: boolean };

      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.timedOut).toBe(false);
      expect(result.tasks[0]).toEqual(expect.objectContaining({ status: "completed", result: expect.stringContaining("instant") }));
    });

    it("should report a failed task's error instead of a result", async () => {
      const { reject } = deferExecution();
      await runAsyncTask.execute({ toolName: "search_web", toolArguments: {} }, createContext());
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      const waitPromise = waitForTasksTool.execute({ taskIds: [taskState.taskId] }, createContext());
      await settle();
      reject(new Error("boom"));
      const result = (await waitPromise) as { tasks: Array<Record<string, unknown>> };
      expect(result.tasks[0]).toEqual(expect.objectContaining({ status: "failed", error: "boom" }));
      expect(result.tasks[0]).not.toHaveProperty("result");
    });

    it("should wait on every running task of the conversation when no ids are given", async () => {
      const first = deferExecution();
      const second = deferExecution();
      await runAsyncTask.execute({ toolName: "execute_command", toolArguments: { n: 1 }, continueWorking: true }, createContext());
      await runAsyncTask.execute({ toolName: "execute_command", toolArguments: { n: 2 }, continueWorking: true }, createContext());
      // A task of ANOTHER conversation must not be included.
      deferExecution();
      await runAsyncTask.execute({ toolName: "execute_command", toolArguments: {} }, createContext({ agentConversationId: "other-session", conversationId: "other-session" }));

      const waitPromise = waitForTasksTool.execute({ timeoutSeconds: 5 }, createContext());
      await settle();
      first.resolve({ output: "one" });
      second.resolve({ output: "two" });
      const result = (await waitPromise) as { tasks: Array<Record<string, unknown>>; timedOut: boolean };

      expect(result.timedOut).toBe(false);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks.every((entry) => entry.status === "completed")).toBe(true);
      expect(mockWaitForAgents).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ parentAgentConversationId: "test-session-123" }),
      );
    });

    it("should say so when there is nothing to wait for", async () => {
      const result = (await waitForTasksTool.execute({}, createContext())) as Record<string, unknown>;
      expect(result.tasks).toEqual([]);
      expect(result.timedOut).toBe(false);
      expect(result.message).toContain("Nothing to wait for");
    });

    it("should return immediately with what settled when the loop's signal aborts", async () => {
      deferExecution();
      await runAsyncTask.execute({ toolName: "execute_command", toolArguments: {}, continueWorking: true }, createContext());
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      const abortController = new AbortController();

      const waitPromise = waitForTasksTool.execute(
        { taskIds: [taskState.taskId], timeoutSeconds: 60 },
        createContext({ signal: abortController.signal }),
      );
      await settle();
      abortController.abort();
      const result = (await waitPromise) as { timedOut: boolean; aborted?: boolean; stillRunning: string[] };

      expect(result.aborted).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.stillRunning).toEqual([taskState.taskId]);
      expect(taskState.awaitedBy).toBeUndefined();
    });

    it("should report unknown task ids as not_found without waiting", async () => {
      const result = (await waitForTasksTool.execute(
        { taskIds: ["task-nope"], timeoutSeconds: 60 },
        createContext(),
      )) as { tasks: Array<Record<string, unknown>>; timedOut: boolean };
      expect(result.tasks[0]).toEqual({ taskId: "task-nope", kind: "async_task", status: "not_found" });
      expect(result.timedOut).toBe(false);
    });

    it("should truncate oversized results", async () => {
      const { resolve } = deferExecution();
      await runAsyncTask.execute({ toolName: "execute_command", toolArguments: {} }, createContext());
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      const waitPromise = waitForTasksTool.execute({ taskIds: [taskState.taskId] }, createContext());
      await settle();
      resolve("x".repeat(10_000));
      const result = (await waitPromise) as { tasks: Array<{ result: string }> };
      expect(result.tasks[0].result.length).toBeLessThan(10_000);
      expect(result.tasks[0].result).toContain("(truncated)");
    });

    it("should clamp timeoutSeconds to the maximum", async () => {
      // The clamp is observable through the registry wait: a 0-second
      // request must not wait; a huge request must still be finite.
      deferExecution();
      await runAsyncTask.execute({ toolName: "execute_command", toolArguments: {}, continueWorking: true }, createContext());
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      const started = Date.now();
      const result = (await waitForTasksTool.execute(
        { taskIds: [taskState.taskId], timeoutSeconds: 0 },
        createContext(),
      )) as { timedOut: boolean };
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it("should wait on sub-agents through the orchestrator and map their results", async () => {
      mockWaitForAgents.mockResolvedValueOnce([
        {
          agentId: "agent-1",
          running: false,
          result: {
            agent_id: "agent-1",
            description: "Researcher",
            status: "completed",
            summary: "done",
            result: "findings",
            toolUses: 3,
            iterations: 2,
            durationMilliseconds: 1200,
            messages: [],
          },
        },
        {
          agentId: "agent-2",
          running: true,
          result: {
            agent_id: "agent-2",
            description: "Slow one",
            status: "running",
            summary: "",
            result: null,
            toolUses: 0,
            iterations: 0,
            durationMilliseconds: 50,
            messages: [],
          },
        },
        { agentId: "agent-3", running: false, result: null },
      ]);

      const result = (await waitForTasksTool.execute(
        { agentIds: ["agent-1", "agent-2", "agent-3"], timeoutSeconds: 1 },
        createContext(),
      )) as { tasks: Array<Record<string, unknown>>; timedOut: boolean; stillRunning: string[] };

      expect(mockWaitForAgents).toHaveBeenCalledWith(
        ["agent-1", "agent-2", "agent-3"],
        expect.objectContaining({ timeoutMilliseconds: 1000, parentAgentConversationId: "test-session-123" }),
      );
      expect(result.tasks).toEqual([
        expect.objectContaining({ agentId: "agent-1", kind: "subagent", status: "completed", result: "findings", toolUses: 3 }),
        expect.objectContaining({ agentId: "agent-2", kind: "subagent", status: "running" }),
        { agentId: "agent-3", kind: "subagent", status: "not_found" },
      ]);
      expect(result.tasks[1]).not.toHaveProperty("result");
      expect(result.stillRunning).toEqual(["agent-2"]);
      expect(result.timedOut).toBe(true);
    });

    it("should not touch the orchestrator when only task ids are given", async () => {
      mockExecuteTool.mockResolvedValueOnce({ output: "x" });
      await runAsyncTask.execute({ toolName: "search_web", toolArguments: {} }, createContext());
      const [taskState] = AsyncTaskRegistry.listTasks("test-session-123");
      await waitForTasksTool.execute({ taskIds: [taskState.taskId] }, createContext());
      expect(mockWaitForAgents).not.toHaveBeenCalled();
    });

    it("should never return NON_BLOCKING_DISPATCH", async () => {
      const result = (await waitForTasksTool.execute({ taskIds: ["task-x"] }, createContext())) as Record<string, unknown>;
      expect(result._directive).toBeUndefined();
    });
  });
});

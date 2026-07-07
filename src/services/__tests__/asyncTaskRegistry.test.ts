import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ────────────────────────────────────────────────────────────
// Mock dependencies before any imports
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

// ────────────────────────────────────────────────────────────
// Import under test
// ────────────────────────────────────────────────────────────

import AsyncTaskRegistry from "#src/services/AsyncTaskRegistry";
import type { AsyncTaskState } from "#src/services/AsyncTaskRegistry";

describe("AsyncTaskRegistry", () => {
  beforeEach(() => {
    AsyncTaskRegistry.clear();
  });

  afterEach(() => {
    AsyncTaskRegistry.clear();
  });

  // ── Dispatch & Immediate Status ─────────────────────────

  it("should dispatch a task and return running status immediately", () => {
    const executor = vi.fn(
      () => new Promise<unknown>((resolve) => setTimeout(() => resolve({ data: "result" }), 100)),
    );

    const result = AsyncTaskRegistry.dispatch(
      "execute_command",
      { command: "ls -la" },
      { agentConversationId: "session-1" },
      executor,
    );

    expect("error" in result && typeof (result as { error: string }).error === "string").toBe(false);
    const taskState = result as AsyncTaskState;
    expect(taskState.taskId).toMatch(/^task-/);
    expect(taskState.toolName).toBe("execute_command");
    expect(taskState.status).toBe("running");
    expect(taskState.result).toBeNull();
    expect(taskState.error).toBeNull();
    expect(taskState.startedAt).toBeGreaterThan(0);
    expect(taskState.completedAt).toBeNull();
    expect(taskState.agentConversationId).toBe("session-1");

    // Executor should have been called
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      "execute_command",
      { command: "ls -la" },
      expect.any(Object), // AbortSignal
    );
  });

  // ── Task Completion ─────────────────────────────────────

  it("should update task state to completed when executor resolves", async () => {
    let resolveExecutor: (value: unknown) => void;
    const executorPromise = new Promise<unknown>((resolve) => {
      resolveExecutor = resolve;
    });
    const executor = vi.fn(() => executorPromise);

    const taskState = AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "test" },
      { agentConversationId: "session-2" },
      executor,
    ) as AsyncTaskState;

    expect(taskState.status).toBe("running");

    // Resolve the executor
    resolveExecutor!({ results: ["item1", "item2"] });
    await vi.waitFor(() => {
      expect(taskState.status).toBe("completed");
    });

    expect(taskState.result).toEqual({ results: ["item1", "item2"] });
    expect(taskState.error).toBeNull();
    expect(taskState.completedAt).toBeGreaterThan(0);
    expect(taskState.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  // ── Task Failure ────────────────────────────────────────

  it("should update task state to failed when executor rejects", async () => {
    const executor = vi.fn(() => Promise.reject(new Error("Tool execution failed")));

    const taskState = AsyncTaskRegistry.dispatch(
      "read_url",
      { url: "https://example.com" },
      { agentConversationId: "session-3" },
      executor,
    ) as AsyncTaskState;

    await vi.waitFor(() => {
      expect(taskState.status).toBe("failed");
    });

    expect(taskState.result).toBeNull();
    expect(taskState.error).toBe("Tool execution failed");
    expect(taskState.completedAt).toBeGreaterThan(0);
    expect(taskState.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  // ── Task Cancellation via AbortController ───────────────

  it("should cancel a running task and mark it as cancelled", () => {
    const executor = vi.fn(
      () => new Promise<unknown>((resolve) => setTimeout(resolve, 10_000)),
    );

    const taskState = AsyncTaskRegistry.dispatch(
      "execute_command",
      { command: "sleep 10" },
      { agentConversationId: "session-4" },
      executor,
    ) as AsyncTaskState;

    expect(taskState.status).toBe("running");

    const wasCancelled = AsyncTaskRegistry.cancelTask(taskState.taskId);
    expect(wasCancelled).toBe(true);
    expect(taskState.status).toBe("cancelled");
    expect(taskState.completedAt).toBeGreaterThan(0);
    expect(taskState.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  it("should return false when cancelling a non-existent task", () => {
    const wasCancelled = AsyncTaskRegistry.cancelTask("nonexistent-task-id");
    expect(wasCancelled).toBe(false);
  });

  it("should return false when cancelling an already-completed task", async () => {
    const executor = vi.fn(() => Promise.resolve({ done: true }));

    const taskState = AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "test" },
      { agentConversationId: "session-5" },
      executor,
    ) as AsyncTaskState;

    await vi.waitFor(() => {
      expect(taskState.status).toBe("completed");
    });

    const wasCancelled = AsyncTaskRegistry.cancelTask(taskState.taskId);
    expect(wasCancelled).toBe(false);
  });

  // ── AbortError Treatment ────────────────────────────────

  it("should treat AbortError as cancellation, not failure", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const executor = vi.fn(() => Promise.reject(abortError));

    const taskState = AsyncTaskRegistry.dispatch(
      "execute_command",
      { command: "long-run" },
      { agentConversationId: "session-6" },
      executor,
    ) as AsyncTaskState;

    await vi.waitFor(() => {
      expect(taskState.status).toBe("cancelled");
    });

    expect(taskState.error).toBeNull();
  });

  // ── Concurrency Limit ───────────────────────────────────

  it("should enforce per-conversation concurrency limit", () => {
    const neverResolve = vi.fn(
      () => new Promise<unknown>(() => {}),
    );

    // Dispatch 10 tasks (the maximum)
    for (let taskIndex = 0; taskIndex < 10; taskIndex++) {
      const result = AsyncTaskRegistry.dispatch(
        "execute_command",
        { command: `task-${taskIndex}` },
        { agentConversationId: "session-limit" },
        neverResolve,
      );
      expect("error" in result && typeof (result as { error: string }).error === "string").toBe(false);
    }

    // The 11th should be rejected
    const overflowResult = AsyncTaskRegistry.dispatch(
      "execute_command",
      { command: "overflow" },
      { agentConversationId: "session-limit" },
      neverResolve,
    );

    expect("error" in overflowResult).toBe(true);
    expect((overflowResult as { error: string }).error).toContain("Maximum concurrent async tasks");
  });

  it("should allow tasks in different conversations independently", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    const resultForConversationA = AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "a" },
      { agentConversationId: "conversation-alpha" },
      neverResolve,
    );

    const resultForConversationB = AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "b" },
      { agentConversationId: "conversation-beta" },
      neverResolve,
    );

    expect("error" in resultForConversationA && typeof (resultForConversationA as { error: string }).error === "string").toBe(false);
    expect("error" in resultForConversationB && typeof (resultForConversationB as { error: string }).error === "string").toBe(false);
  });

  // ── Per-Conversation Scoping ────────────────────────────

  it("should scope task listing by agentConversationId", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    AsyncTaskRegistry.dispatch("tool-a", {}, { agentConversationId: "session-a" }, neverResolve);
    AsyncTaskRegistry.dispatch("tool-b", {}, { agentConversationId: "session-a" }, neverResolve);
    AsyncTaskRegistry.dispatch("tool-c", {}, { agentConversationId: "session-b" }, neverResolve);

    const tasksForSessionA = AsyncTaskRegistry.listTasks("session-a");
    const tasksForSessionB = AsyncTaskRegistry.listTasks("session-b");
    const tasksForUnknown = AsyncTaskRegistry.listTasks("session-unknown");

    expect(tasksForSessionA).toHaveLength(2);
    expect(tasksForSessionB).toHaveLength(1);
    expect(tasksForUnknown).toHaveLength(0);

    expect(tasksForSessionA.map((taskState) => taskState.toolName)).toEqual(["tool-a", "tool-b"]);
    expect(tasksForSessionB[0].toolName).toBe("tool-c");
  });

  // ── getTask ─────────────────────────────────────────────

  it("should retrieve a task by ID", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    const taskState = AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "test" },
      { agentConversationId: "session-get" },
      neverResolve,
    ) as AsyncTaskState;

    const retrieved = AsyncTaskRegistry.getTask(taskState.taskId);
    expect(retrieved).toBe(taskState);
    expect(retrieved?.toolName).toBe("search_web");
  });

  it("should return null for nonexistent task ID", () => {
    expect(AsyncTaskRegistry.getTask("nonexistent")).toBeNull();
  });

  // ── Cleanup ─────────────────────────────────────────────

  it("should clean up all tasks for a conversation and abort running ones", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    AsyncTaskRegistry.dispatch("tool-1", {}, { agentConversationId: "cleanup-session" }, neverResolve);
    AsyncTaskRegistry.dispatch("tool-2", {}, { agentConversationId: "cleanup-session" }, neverResolve);
    AsyncTaskRegistry.dispatch("tool-3", {}, { agentConversationId: "other-session" }, neverResolve);

    expect(AsyncTaskRegistry.listTasks("cleanup-session")).toHaveLength(2);
    expect(AsyncTaskRegistry.size).toBe(3);

    AsyncTaskRegistry.cleanup("cleanup-session");

    expect(AsyncTaskRegistry.listTasks("cleanup-session")).toHaveLength(0);
    expect(AsyncTaskRegistry.listTasks("other-session")).toHaveLength(1);
    expect(AsyncTaskRegistry.size).toBe(1);
  });

  // ── TTL Pruning ─────────────────────────────────────────

  it("should prune expired completed tasks", async () => {
    const executor = vi.fn(() => Promise.resolve({ done: true }));

    const taskState = AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "test" },
      { agentConversationId: "prune-session" },
      executor,
    ) as AsyncTaskState;

    await vi.waitFor(() => {
      expect(taskState.status).toBe("completed");
    });

    // Manually backdate the completedAt to simulate expiry
    taskState.completedAt = Date.now() - 15 * 60 * 1000; // 15 minutes ago

    AsyncTaskRegistry._pruneExpiredTasks();

    expect(AsyncTaskRegistry.getTask(taskState.taskId)).toBeNull();
  });

  it("should NOT prune running tasks", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    const taskState = AsyncTaskRegistry.dispatch(
      "execute_command",
      { command: "long" },
      { agentConversationId: "prune-running" },
      neverResolve,
    ) as AsyncTaskState;

    // Even if we backdate startedAt, running tasks should survive pruning
    AsyncTaskRegistry._pruneExpiredTasks();

    expect(AsyncTaskRegistry.getTask(taskState.taskId)).not.toBeNull();
  });

  // ── size & clear ────────────────────────────────────────

  it("should track total size across all conversations", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    expect(AsyncTaskRegistry.size).toBe(0);

    AsyncTaskRegistry.dispatch("a", {}, { agentConversationId: "s1" }, neverResolve);
    AsyncTaskRegistry.dispatch("b", {}, { agentConversationId: "s2" }, neverResolve);

    expect(AsyncTaskRegistry.size).toBe(2);

    AsyncTaskRegistry.clear();

    expect(AsyncTaskRegistry.size).toBe(0);
  });

  // ── Completion Callback ─────────────────────────────────

  it("should fire onComplete callback when task completes", async () => {
    const onComplete = vi.fn();
    const executor = vi.fn(() => Promise.resolve({ data: "result" }));

    AsyncTaskRegistry.dispatch(
      "search_web",
      { query: "callback-test" },
      { agentConversationId: "callback-session" },
      executor,
      onComplete,
    );

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });

    const completedTask = onComplete.mock.calls[0][0] as AsyncTaskState;
    expect(completedTask.status).toBe("completed");
    expect(completedTask.result).toEqual({ data: "result" });
  });

  it("should fire onComplete callback when task fails", async () => {
    const onComplete = vi.fn();
    const executor = vi.fn(() => Promise.reject(new Error("boom")));

    AsyncTaskRegistry.dispatch(
      "read_url",
      { url: "bad" },
      { agentConversationId: "fail-callback" },
      executor,
      onComplete,
    );

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });

    const failedTask = onComplete.mock.calls[0][0] as AsyncTaskState;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.error).toBe("boom");
  });

  // ── hasActiveTask ───────────────────────────────────────

  it("should report active status for running tasks only", async () => {
    const executor = vi.fn(() => Promise.resolve("done"));

    const taskState = AsyncTaskRegistry.dispatch(
      "tool-x",
      {},
      { agentConversationId: "active-check" },
      executor,
    ) as AsyncTaskState;

    expect(AsyncTaskRegistry.hasActiveTask(taskState.taskId)).toBe(true);

    await vi.waitFor(() => {
      expect(taskState.status).toBe("completed");
    });

    expect(AsyncTaskRegistry.hasActiveTask(taskState.taskId)).toBe(false);
    expect(AsyncTaskRegistry.hasActiveTask("nonexistent")).toBe(false);
  });

  // ── Sequential Task IDs ─────────────────────────────────

  it("should generate sequential task IDs scoped per conversation", () => {
    const neverResolve = vi.fn(() => new Promise<unknown>(() => {}));

    const task1 = AsyncTaskRegistry.dispatch("a", {}, { agentConversationId: "seq-test" }, neverResolve) as AsyncTaskState;
    const task2 = AsyncTaskRegistry.dispatch("b", {}, { agentConversationId: "seq-test" }, neverResolve) as AsyncTaskState;
    const task3 = AsyncTaskRegistry.dispatch("c", {}, { agentConversationId: "other-seq" }, neverResolve) as AsyncTaskState;

    // task1 and task2 are in the same conversation — sequential counter
    expect(task1.taskId).toMatch(/^task-1-/);
    expect(task2.taskId).toMatch(/^task-2-/);

    // task3 is in a different conversation — resets to 1
    expect(task3.taskId).toMatch(/^task-1-/);
  });

  // ── Cancelled task ignores late resolve ──────────────────

  it("should not overwrite cancelled state when executor resolves late", async () => {
    let resolveExecutor: (value: unknown) => void;
    const executor = vi.fn(
      () => new Promise<unknown>((resolve) => { resolveExecutor = resolve; }),
    );

    const taskState = AsyncTaskRegistry.dispatch(
      "slow-tool",
      {},
      { agentConversationId: "cancel-race" },
      executor,
    ) as AsyncTaskState;

    // Cancel the task first
    AsyncTaskRegistry.cancelTask(taskState.taskId);
    expect(taskState.status).toBe("cancelled");

    // Now resolve the executor — should NOT overwrite cancelled state
    resolveExecutor!({ late: "result" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(taskState.status).toBe("cancelled");
    expect(taskState.result).toBeNull();
  });
});

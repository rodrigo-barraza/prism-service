import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import {
  MAXIMUM_CONCURRENT_ASYNC_TASKS,
  COMPLETED_TASK_TIME_TO_LIVE_MILLISECONDS,
  TASK_PRUNING_INTERVAL_MILLISECONDS,
} from "./AsyncTaskConstants.ts";
import { SYSTEM_STATUSES } from "../constants.ts";

// ────────────────────────────────────────────────────────────
// AsyncTaskRegistry — General-Purpose Background Task Tracking
// ────────────────────────────────────────────────────────────
// In-memory singleton that tracks background task promises for
// any tool dispatched via run_async_task. Analogous to
// OrchestratorService's activeSubAgents map but generic — any
// tool (execute_command, search_web, etc.) can go non-blocking.
//
// Lifecycle:
//   1. LLM calls run_async_task(toolName, args)
//   2. AsyncTaskTools.execute() calls dispatch() here
//   3. dispatch() registers a task state, launches a detached
//      promise, and returns immediately
//   4. When the promise settles, task state updates to
//      completed/failed
//   5. LLM queries via list_async_tasks or polls via set_timer
//   6. Stale completed tasks are pruned after TTL
// ────────────────────────────────────────────────────────────

export interface AsyncTaskState {
  taskId: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  status: (typeof SYSTEM_STATUSES)[keyof typeof SYSTEM_STATUSES];
  result: unknown;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMilliseconds: number | null;
  conversationId: string | null;
  agentConversationId: string | null;
  project: string | null;
  username: string | null;
  abortController: AbortController | null;
}

export type AsyncTaskExecutor = (
  toolName: string,
  toolArguments: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface AsyncTaskDispatchContext {
  conversationId?: string | null;
  agentConversationId?: string | null;
  project?: string | null;
  username?: string | null;
}

/** Per-conversation counter for generating sequential task IDs */
const taskCountersByConversation = new Map<string, number>();

/** Active task states keyed by taskId */
const activeTasks = new Map<string, AsyncTaskState>();

/** Background pruning interval reference */
let pruningIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Generate a short, human-readable task ID scoped to the conversation.
 * Format: task-{base36Counter}-{uuid4Prefix}
 */
function generateTaskId(conversationKey: string): string {
  const currentCount = (taskCountersByConversation.get(conversationKey) || 0) + 1;
  taskCountersByConversation.set(conversationKey, currentCount);
  return `task-${currentCount.toString(36)}-${crypto.randomUUID().slice(0, 4)}`;
}

/**
 * Prune completed/failed/cancelled tasks older than the configured TTL.
 * Runs periodically to prevent unbounded memory growth.
 */
function pruneExpiredTasks(): void {
  const expirationThreshold = Date.now() - COMPLETED_TASK_TIME_TO_LIVE_MILLISECONDS;
  let pruneCount = 0;

  for (const [taskId, taskState] of activeTasks) {
    if (
      taskState.status !== SYSTEM_STATUSES.RUNNING &&
      taskState.completedAt !== null &&
      taskState.completedAt < expirationThreshold
    ) {
      activeTasks.delete(taskId);
      pruneCount++;
    }
  }

  if (pruneCount > 0) {
    logger.debug(
      `[AsyncTaskRegistry] Pruned ${pruneCount} expired task(s) (${activeTasks.size} remaining)`,
    );
  }
}

// Start the background pruning interval
function startPruningInterval(): void {
  if (pruningIntervalHandle) return;
  pruningIntervalHandle = setInterval(
    pruneExpiredTasks,
    TASK_PRUNING_INTERVAL_MILLISECONDS,
  );
  // Unref so the interval doesn't prevent process exit
  if (pruningIntervalHandle && typeof pruningIntervalHandle === "object" && "unref" in pruningIntervalHandle) {
    pruningIntervalHandle.unref();
  }
}

startPruningInterval();

// Register shutdown cleanup — abort all running tasks
registerCleanup(async () => {
  const runningTasks = [...activeTasks.values()].filter(
    (taskState) => taskState.status === SYSTEM_STATUSES.RUNNING,
  );
  if (runningTasks.length === 0) return;

  logger.info(
    `[AsyncTaskRegistry] Shutdown: aborting ${runningTasks.length} running task(s)…`,
  );
  for (const taskState of runningTasks) {
    taskState.abortController?.abort();
    taskState.status = SYSTEM_STATUSES.CANCELLED;
    taskState.completedAt = Date.now();
    taskState.durationMilliseconds = taskState.completedAt - taskState.startedAt;
  }

  if (pruningIntervalHandle) {
    clearInterval(pruningIntervalHandle);
    pruningIntervalHandle = null;
  }
});

export default class AsyncTaskRegistry {
  /**
   * Dispatch a tool to run asynchronously in the background.
   *
   * Returns the initial task state immediately (status: SYSTEM_STATUSES.RUNNING).
   * The task promise runs detached — when it settles, the task state
   * updates in-place.
   *
   * @param toolName - The tool to execute
   * @param toolArguments - Arguments to pass to the tool
   * @param context - Conversation/session context for scoping
   * @param executor - The function that actually executes the tool
   * @param onComplete - Optional callback fired when the task completes/fails
   */
  static dispatch(
    toolName: string,
    toolArguments: Record<string, unknown>,
    context: AsyncTaskDispatchContext,
    executor: AsyncTaskExecutor,
    onComplete?: (taskState: AsyncTaskState) => void,
  ): AsyncTaskState | { error: string } {
    const conversationKey = context.agentConversationId || context.conversationId || "global";

    // Enforce per-conversation concurrency limit
    const runningTaskCount = AsyncTaskRegistry.countRunningTasks(conversationKey);
    if (runningTaskCount >= MAXIMUM_CONCURRENT_ASYNC_TASKS) {
      return {
        error: `Maximum concurrent async tasks (${MAXIMUM_CONCURRENT_ASYNC_TASKS}) reached for this conversation. Wait for a task to complete or cancel one.`,
      };
    }

    const taskId = generateTaskId(conversationKey);
    const taskAbortController = createAbortController();

    const taskState: AsyncTaskState = {
      taskId,
      toolName,
      toolArguments,
      status: SYSTEM_STATUSES.RUNNING,
      result: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      durationMilliseconds: null,
      conversationId: context.conversationId || null,
      agentConversationId: context.agentConversationId || null,
      project: context.project || null,
      username: context.username || null,
      abortController: taskAbortController,
    };

    activeTasks.set(taskId, taskState);

    logger.info(
      `[AsyncTaskRegistry] Dispatched task ${taskId}: tool="${toolName}" for conversation ${conversationKey}`,
    );

    // Fire-and-forget — the promise runs detached
    executor(toolName, toolArguments, taskAbortController.signal)
      .then((executionResult) => {
        // Guard against cancelled tasks — if the task was cancelled while
        // the executor was still running, don't overwrite the cancelled state
        if (taskState.status === SYSTEM_STATUSES.CANCELLED) return;

        taskState.status = SYSTEM_STATUSES.COMPLETED;
        taskState.result = executionResult;
        taskState.completedAt = Date.now();
        taskState.durationMilliseconds = taskState.completedAt - taskState.startedAt;

        logger.info(
          `[AsyncTaskRegistry] Task ${taskId} completed: tool="${toolName}" durationMilliseconds=${taskState.durationMilliseconds}`,
        );

        onComplete?.(taskState);
      })
      .catch((executionError: Error) => {
        if (taskState.status === SYSTEM_STATUSES.CANCELLED) return;

        const isAbortError =
          executionError instanceof Error && executionError.name === "AbortError";

        if (isAbortError) {
          taskState.status = SYSTEM_STATUSES.CANCELLED;
          logger.info(`[AsyncTaskRegistry] Task ${taskId} aborted`);
        } else {
          taskState.status = SYSTEM_STATUSES.FAILED;
          taskState.error = getErrorMessage(executionError);
          logger.warn(
            `[AsyncTaskRegistry] Task ${taskId} failed: ${taskState.error}`,
          );
        }

        taskState.completedAt = Date.now();
        taskState.durationMilliseconds = taskState.completedAt - taskState.startedAt;

        onComplete?.(taskState);
      });

    return taskState;
  }

  /**
   * Retrieve a task by its ID.
   */
  static getTask(taskId: string): AsyncTaskState | null {
    return activeTasks.get(taskId) || null;
  }

  /**
   * List all tasks for a given conversation session.
   * Returns tasks in creation order (oldest first).
   */
  static listTasks(agentConversationId: string): AsyncTaskState[] {
    const conversationTasks: AsyncTaskState[] = [];
    for (const taskState of activeTasks.values()) {
      if (taskState.agentConversationId === agentConversationId) {
        conversationTasks.push(taskState);
      }
    }
    return conversationTasks;
  }

  /**
   * Cancel a running task by ID.
   * Returns true if the task was found and cancelled.
   */
  static cancelTask(taskId: string): boolean {
    const taskState = activeTasks.get(taskId);
    if (!taskState) return false;
    if (taskState.status !== SYSTEM_STATUSES.RUNNING) return false;

    taskState.abortController?.abort();
    taskState.status = SYSTEM_STATUSES.CANCELLED;
    taskState.completedAt = Date.now();
    taskState.durationMilliseconds = taskState.completedAt - taskState.startedAt;

    logger.info(`[AsyncTaskRegistry] Cancelled task ${taskId}: tool="${taskState.toolName}"`);
    return true;
  }

  /**
   * Count running tasks for a conversation key.
   */
  static countRunningTasks(agentConversationId: string): number {
    let runningCount = 0;
    for (const taskState of activeTasks.values()) {
      if (
        taskState.agentConversationId === agentConversationId &&
        taskState.status === SYSTEM_STATUSES.RUNNING
      ) {
        runningCount++;
      }
    }
    return runningCount;
  }

  /**
   * Check if a specific task has a given status.
   */
  static hasActiveTask(taskId: string): boolean {
    const taskState = activeTasks.get(taskId);
    return taskState?.status === SYSTEM_STATUSES.RUNNING || false;
  }

  /**
   * Clean up all tasks for a conversation session.
   * Called when the agentic loop ends to prevent memory leaks.
   */
  static cleanup(agentConversationId: string): void {
    const taskIdsToRemove: string[] = [];
    for (const [taskId, taskState] of activeTasks) {
      if (taskState.agentConversationId === agentConversationId) {
        // Abort any still-running tasks
        if (taskState.status === SYSTEM_STATUSES.RUNNING) {
          taskState.abortController?.abort();
          taskState.status = SYSTEM_STATUSES.CANCELLED;
          taskState.completedAt = Date.now();
          taskState.durationMilliseconds = taskState.completedAt - taskState.startedAt;
        }
        taskIdsToRemove.push(taskId);
      }
    }

    for (const taskId of taskIdsToRemove) {
      activeTasks.delete(taskId);
    }

    // Clean up the conversation counter
    taskCountersByConversation.delete(agentConversationId);

    if (taskIdsToRemove.length > 0) {
      logger.debug(
        `[AsyncTaskRegistry] Cleaned up ${taskIdsToRemove.length} task(s) for session ${agentConversationId}`,
      );
    }
  }

  /** Total number of tracked tasks (all states, all conversations) */
  static get size(): number {
    return activeTasks.size;
  }

  /** Clear all tasks and counters — used in tests */
  static clear(): void {
    for (const taskState of activeTasks.values()) {
      if (taskState.status === SYSTEM_STATUSES.RUNNING) {
        taskState.abortController?.abort();
      }
    }
    activeTasks.clear();
    taskCountersByConversation.clear();
  }

  /** Force a pruning sweep — exposed for testing */
  static _pruneExpiredTasks(): void {
    pruneExpiredTasks();
  }

  /** Direct access to the map — for testing assertions only */
  static _getActiveTasks(): Map<string, AsyncTaskState> {
    return activeTasks;
  }
}

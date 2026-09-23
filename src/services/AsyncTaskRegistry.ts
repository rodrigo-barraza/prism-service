import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { createAbortController } from "#src/utils/AbortController";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import {
  MAXIMUM_CONCURRENT_ASYNC_TASKS,
  COMPLETED_TASK_TIME_TO_LIVE_MILLISECONDS,
  TASK_PRUNING_INTERVAL_MILLISECONDS,
} from "./AsyncTaskConstants.ts";
import { ORCHESTRATOR, SYSTEM_STATUSES } from "#src/constants";
import type DetachedWorkStoreModule from "./DetachedWorkStore.ts";

// ────────────────────────────────────────────────────────────
// AsyncTaskRegistry — General-Purpose Background Task Tracking
// ────────────────────────────────────────────────────────────
// Durable shadow (prompt 13): every task is also a DetachedWorkStore
// record — started, settled, delivered — so a restart that kills a
// running task tells its parent once that the outcome is UNCERTAIN
// (never re-running it), and a finished task whose result had not been
// delivered yet is still delivered (TurnResumeService).
//
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
  /**
   * Resolves once the task leaves `running` (completed / failed / cancelled),
   * AFTER the state fields are updated and BEFORE `onComplete` fires. Never
   * rejects — inspect `status` to learn how it settled.
   */
  settled: Promise<void>;
  /**
   * How the completion reached the parent: through the running turn's
   * TurnInputMailbox, by waking a new turn (auto-response), or returned
   * directly by a `wait_for_tasks` call; `restart` when a restart settled
   * it, `dropped` for a sub-agent's task whose turn had already ended.
   * Unset while running.
   */
  deliveredVia?: "mailbox" | "auto_response" | "wait" | "restart" | "dropped";
  /**
   * The agentConversationId of a `wait_for_tasks` call currently blocked on
   * this task. While set, the completion callback must NOT deliver the
   * result (the waiter returns it itself). Cleared by the waiter when its
   * wait times out or is aborted, so a later completion is still delivered.
   */
  awaitedBy?: string;
  /**
   * The turn that dispatched this task ended while it was still running and
   * bumped the conversation's pendingBackgroundTasks (+1, once per turn).
   * Whichever delivery path consumes the completion pays that back and
   * clears the flag on the task's siblings (the +1 was per turn, not per
   * task). See `markRunningAsCounted` / `clearCountedAsPending`.
   */
  countedAsPending?: boolean;
  /**
   * Dispatched by a native async call (OpenAI async tools): the provider call
   * id the completion is returned on, as that call's output.
   */
  nativeCallId?: string;
}

export interface AsyncTaskWaitOptions {
  timeoutMilliseconds?: number;
  signal?: AbortSignal;
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

/** Resolvers for each task's `settled` promise, keyed by taskId */
const settleResolvers = new Map<string, () => void>();

/** Write a task's record through to DetachedWorkStore — lazily, and never in the task's way. */
function persist(
  taskState: Pick<AsyncTaskState, "taskId" | "agentConversationId">,
  operation: (store: typeof DetachedWorkStoreModule, recordId: string) => Promise<void>,
): void {
  void import("./DetachedWorkStore.ts")
    .then(({ default: store, detachedWorkId }) =>
      operation(store, detachedWorkId("async_task", taskState.agentConversationId, taskState.taskId)),
    )
    .catch(() => {
      /* best-effort: the task itself is unaffected */
    });
}

/** A task's result as its completion notification carries it. */
function resultTextOf(result: unknown): string {
  let text: string;
  if (typeof result === "string") text = result;
  else if (result === undefined || result === null) text = "";
  else {
    try {
      text = JSON.stringify(result);
    } catch {
      text = String(result);
    }
  }
  return text.length > ORCHESTRATOR.ASYNC_TASK_RESULT_TRUNCATION_LIMIT
    ? text.slice(0, ORCHESTRATOR.ASYNC_TASK_RESULT_TRUNCATION_LIMIT) + "\n... (truncated)"
    : text;
}

/** Resolve (once) the `settled` promise of a task. Idempotent. */
function markSettled(taskId: string): void {
  const resolve = settleResolvers.get(taskId);
  if (!resolve) return;
  settleResolvers.delete(taskId);
  resolve();
}

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
    markSettled(taskState.taskId);
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

    let resolveSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    settleResolvers.set(taskId, resolveSettled);

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
      settled,
    };

    activeTasks.set(taskId, taskState);
    persist(taskState, (store, recordId) =>
      store.started({
        id: recordId,
        itemId: taskId,
        kind: "async_task",
        loopKey: context.conversationId || context.agentConversationId || "",
        conversationId: context.conversationId || null,
        agentConversationId: context.agentConversationId || null,
        project: context.project || null,
        username: context.username || null,
        toolName,
        toolArguments,
      }),
    );

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
        persist(taskState, (store, recordId) =>
          store.settled(recordId, {
            outcome: SYSTEM_STATUSES.COMPLETED,
            resultText: resultTextOf(executionResult),
            durationMilliseconds: taskState.durationMilliseconds ?? 0,
          }),
        );

        // Settle BEFORE onComplete: a wait_for_tasks waiter has already
        // stamped `awaitedBy`, and the (synchronous) callback below reads
        // it to decide whether delivery is the waiter's job.
        markSettled(taskId);
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
        persist(taskState, (store, recordId) =>
          store.settled(recordId, {
            outcome: taskState.status,
            error: taskState.error,
            durationMilliseconds: taskState.durationMilliseconds ?? 0,
          }),
        );

        markSettled(taskId);
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
    markSettled(taskId);
    // Whoever cancelled it knows: there is no outcome left to deliver.
    persist(taskState, (store, recordId) => store.delivered(recordId, "cancelled"));

    logger.info(`[AsyncTaskRegistry] Cancelled task ${taskId}: tool="${taskState.toolName}"`);
    return true;
  }

  /** The task's outcome reached its parent, by `via` — exactly once. */
  static markDelivered(
    taskState: AsyncTaskState,
    via: NonNullable<AsyncTaskState["deliveredVia"]>,
  ): void {
    if (taskState.deliveredVia) return;
    taskState.deliveredVia = via;
    persist(taskState, (store, recordId) => store.delivered(recordId, via));
  }

  /**
   * A task a previous process ran, as its record left it — so the tools
   * (list, wait, cancel) still know it after a restart. A task that was
   * running comes back UNCERTAIN: it may have partly happened, and it is
   * not run again. Already settled; never delivered from here.
   */
  static restore(record: {
    itemId: string;
    toolName?: string;
    toolArguments?: Record<string, unknown>;
    conversationId: string | null;
    agentConversationId: string | null;
    project: string | null;
    username: string | null;
    status: string;
    outcome?: string;
    resultText?: string;
    error?: string | null;
    durationMilliseconds?: number;
    createdAt: string;
  }): AsyncTaskState {
    const startedAt = Date.parse(record.createdAt) || Date.now();
    const status = (record.status === "running"
      ? SYSTEM_STATUSES.UNCERTAIN
      : record.outcome || SYSTEM_STATUSES.COMPLETED) as AsyncTaskState["status"];
    const taskState: AsyncTaskState = {
      taskId: record.itemId,
      toolName: record.toolName || "",
      toolArguments: record.toolArguments || {},
      status,
      result: record.resultText ?? null,
      error:
        status === SYSTEM_STATUSES.UNCERTAIN
          ? "The server restarted while this task was running; it may have partly run and was not run again."
          : (record.error ?? null),
      startedAt,
      completedAt: Date.now(),
      durationMilliseconds: record.durationMilliseconds ?? null,
      conversationId: record.conversationId,
      agentConversationId: record.agentConversationId,
      project: record.project,
      username: record.username,
      abortController: null,
      settled: Promise.resolve(),
      deliveredVia: "restart",
    };
    activeTasks.set(record.itemId, taskState);
    return taskState;
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
   * Called by the harness when a turn ends with detached work still running
   * and it has bumped pendingBackgroundTasks for it: every running task of
   * the conversation remembers that the count exists. Returns how many
   * tasks were marked.
   */
  static markRunningAsCounted(agentConversationId: string): number {
    let marked = 0;
    for (const taskState of activeTasks.values()) {
      if (
        taskState.agentConversationId === agentConversationId &&
        taskState.status === SYSTEM_STATUSES.RUNNING
      ) {
        taskState.countedAsPending = true;
        marked++;
      }
    }
    return marked;
  }

  /**
   * The per-turn +1 has been paid back by one completion: clear the flag on
   * every task of the conversation so no sibling pays it again.
   */
  static clearCountedAsPending(agentConversationId: string | null): void {
    if (!agentConversationId) return;
    for (const taskState of activeTasks.values()) {
      if (taskState.agentConversationId === agentConversationId) {
        taskState.countedAsPending = false;
      }
    }
  }

  /**
   * Check if a specific task has a given status.
   */
  static hasActiveTask(taskId: string): boolean {
    const taskState = activeTasks.get(taskId);
    return taskState?.status === SYSTEM_STATUSES.RUNNING || false;
  }

  /**
   * Wait for one task to settle (completed / failed / cancelled).
   *
   * Resolves with the task's state as soon as it settles, or when the
   * timeout elapses or `signal` aborts — in those two cases the returned
   * state is still `running`, so callers read `status` to tell the
   * outcomes apart. Resolves `null` for an unknown taskId. Never rejects.
   *
   * Does NOT touch `awaitedBy` — the tool that owns the duplicate
   * suppression sets and clears it around this call.
   */
  static async waitForTask(
    taskId: string,
    { timeoutMilliseconds, signal }: AsyncTaskWaitOptions = {},
  ): Promise<AsyncTaskState | null> {
    const taskState = activeTasks.get(taskId);
    if (!taskState) return null;
    if (taskState.status !== SYSTEM_STATUSES.RUNNING) return taskState;
    if (signal?.aborted) return taskState;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let abortListener: (() => void) | null = null;

    const timeoutPromise = new Promise<void>((resolve) => {
      if (typeof timeoutMilliseconds === "number" && timeoutMilliseconds >= 0) {
        timeoutHandle = setTimeout(resolve, timeoutMilliseconds);
      }
    });
    const abortPromise = new Promise<void>((resolve) => {
      if (signal) {
        abortListener = () => resolve();
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    try {
      await Promise.race([taskState.settled, timeoutPromise, abortPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    }
    return taskState;
  }

  /**
   * Wait for several tasks under ONE shared deadline / signal. Returns the
   * states aligned with `taskIds` (`null` for an unknown id).
   */
  static async waitForTasks(
    taskIds: string[],
    options: AsyncTaskWaitOptions = {},
  ): Promise<Array<AsyncTaskState | null>> {
    return Promise.all(
      taskIds.map((taskId) => AsyncTaskRegistry.waitForTask(taskId, options)),
    );
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
        markSettled(taskId);
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
      markSettled(taskState.taskId);
    }
    activeTasks.clear();
    taskCountersByConversation.clear();
    settleResolvers.clear();
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

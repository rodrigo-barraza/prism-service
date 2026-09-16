// ────────────────────────────────────────────────────────────
// AsyncTaskConstants — Tool Names for General-Purpose Async Tasks
// ────────────────────────────────────────────────────────────
// Defined locally until they're added to the utilities-library taxonomy.
// Once added, replace these imports with the canonical TOOL_NAMES entries.
// ────────────────────────────────────────────────────────────

export const ASYNC_TASK_TOOL_NAMES = {
  RUN_ASYNC_TASK: "run_async_task",
  LIST_ASYNC_TASKS: "list_async_tasks",
  CANCEL_ASYNC_TASK: "cancel_async_task",
  WAIT_FOR_TASKS: "wait_for_tasks",
} as const;

export type AsyncTaskToolName =
  (typeof ASYNC_TASK_TOOL_NAMES)[keyof typeof ASYNC_TASK_TOOL_NAMES];

/** Maximum concurrent async tasks per conversation (prevents runaway spawning) */
export const MAXIMUM_CONCURRENT_ASYNC_TASKS = 10;

/** Time-to-live for completed/failed/cancelled tasks before automatic pruning (ms) */
export const COMPLETED_TASK_TIME_TO_LIVE_MILLISECONDS = 10 * 60 * 1000; // 10 minutes

/** Pruning interval — how often the background sweep runs (ms) */
export const TASK_PRUNING_INTERVAL_MILLISECONDS = 60 * 1000; // 1 minute

/** wait_for_tasks — default wait when the caller gives no timeout (seconds) */
export const WAIT_FOR_TASKS_DEFAULT_TIMEOUT_SECONDS = 60;

/** wait_for_tasks — hard ceiling on a single wait (seconds) */
export const WAIT_FOR_TASKS_MAXIMUM_TIMEOUT_SECONDS = 300;

/** wait_for_tasks — how often a sub-agent wait re-checks the registry (ms) */
export const WAIT_FOR_AGENTS_POLL_INTERVAL_MILLISECONDS = 250;

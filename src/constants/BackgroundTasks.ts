// ─── Background tasks: monitors, background commands, task_stop ───────────
// A background `execute_command` and a `monitor` run on the workspace (the
// bridge, or tools-service itself) as tasks; prism watches each one
// (BackgroundTaskWatcher) and hands its notifications to the agent
// (TaskNotificationDelivery) — into the running turn, or by waking a new
// one, the way Claude Code re-invokes a session.

/** Prism-local tool names (the shared taxonomy's TOOL_NAMES does not carry them yet). */
export const BACKGROUND_TASK_TOOL_NAMES = {
  MONITOR: "monitor",
  TASK_STOP: "task_stop",
} as const;

/** `_notificationSource` of a background task's notification: the agent's own command output. */
export const WORKSPACE_TASK_NOTIFICATION_SOURCE = "workspace_task";

/** The workspace's task kinds (tools-service `task.start`). */
export const WORKSPACE_TASK_TYPES = ["shell", "monitor"] as const;
export type WorkspaceTaskType = (typeof WORKSPACE_TASK_TYPES)[number];

/** How a workspace task ended (`task.exit` status), plus prism's own `lost`. */
export const WORKSPACE_TASK_EXIT_STATUSES = [
  "completed",
  "failed",
  "killed",
  "timeout",
  "too_many_events",
  "closed",
  "exited",
  "lost",
] as const;
export type WorkspaceTaskExitStatus = (typeof WORKSPACE_TASK_EXIT_STATUSES)[number];
export type WorkspaceTaskStatus = "running" | WorkspaceTaskExitStatus;

/** Task ids of the workspace's tasks: `shell-<8 base36>`, `monitor-<8 base36>`. */
export const WORKSPACE_TASK_ID_PATTERN = /^(shell|monitor)-[a-z0-9]+$/;

// ── execute_command ──────────────────────────────────────────────

/** A foreground command's `timeout` when the call names none (ms) — Claude Code's Bash. */
export const COMMAND_DEFAULT_TIMEOUT_MILLISECONDS = 120_000;
/** The longest a foreground command may run (ms). */
export const COMMAND_MAXIMUM_TIMEOUT_MILLISECONDS = 600_000;
/** The shortest `timeout` tools-service takes (ms). */
export const COMMAND_MINIMUM_TIMEOUT_MILLISECONDS = 1_000;
/**
 * How much longer than the command's own timeout prism waits for tools-service
 * to answer: it kills the command at its timeout and replies with what it
 * printed, so the margin only covers the reply.
 */
export const COMMAND_REPLY_MARGIN_MILLISECONDS = 30_000;

// ── monitor ──────────────────────────────────────────────────────

/** `timeout_ms` when the call names none — Claude Code's Monitor. */
export const MONITOR_DEFAULT_TIMEOUT_MILLISECONDS = 300_000;
/** The schema's floor and ceiling for `timeout_ms`. */
export const MONITOR_MINIMUM_TIMEOUT_MILLISECONDS = 1_000;
export const MONITOR_SCHEMA_MAXIMUM_TIMEOUT_MILLISECONDS = 3_600_000;
/** Deadlines above this are capped to it. */
export const MONITOR_MAXIMUM_TIMEOUT_MILLISECONDS = 1_800_000;

// ── Notifications ────────────────────────────────────────────────

/** A background command's exit notification quotes at most this many lines of its output. */
export const NOTIFICATION_OUTPUT_TAIL_LINES = 20;

// ── Watching (BackgroundTaskWatcher) ─────────────────────────────

/** First reconnect delay of a task's event stream (ms); doubled per failure. */
export const TASK_EVENTS_RECONNECT_INITIAL_MILLISECONDS = 1_000;
/** The longest wait between two reconnects (ms). */
export const TASK_EVENTS_RECONNECT_MAXIMUM_MILLISECONDS = 30_000;
/**
 * A task's event stream that sends nothing for this long — not even the
 * `: ping` tools-service writes every 15 s — is dead: it is dropped and
 * opened again after the last event handled.
 */
export const TASK_EVENTS_IDLE_TIMEOUT_MILLISECONDS = 45_000;
/** tools-service calls other than the event stream (start, stop) (ms). */
export const TASK_REQUEST_TIMEOUT_MILLISECONDS = 20_000;

// ── Delivery (TaskNotificationDelivery) ──────────────────────────

/**
 * How often a wake looks again while another turn of the conversation holds
 * it (a user's turn that has not opened its mailbox yet, or one finishing):
 * the notifications go into that turn's mailbox once it opens, or wake a new
 * turn once it ends (ms).
 */
export const TASK_DELIVERY_TURN_POLL_MILLISECONDS = 250;
/** The `clientIp` a woken turn runs with — what its request logs show. */
export const TASK_NOTIFICATION_CLIENT_IP = "task-notification";

import {
  NOTIFICATION_OUTPUT_TAIL_LINES,
  type WorkspaceTaskExitStatus,
  type WorkspaceTaskType,
} from "#src/constants/BackgroundTasks";

// ────────────────────────────────────────────────────────────
// TaskNotificationFormatter — what a background task tells the agent
// ────────────────────────────────────────────────────────────
// Claude Code's <task-notification> blocks, for a background command
// (`execute_command` with run_in_background) and a monitor:
//
//   a monitor's batch of events   task-id, task-type, description, event
//   a task's end                  task-id, task-type, status, exit-code |
//                                 close-code, description, output-file,
//                                 summary, and a command's output-tail
//
// Several that arrive before the model next looks are delivered as one
// message: the blocks, one after the other (joinTaskNotifications).
// ────────────────────────────────────────────────────────────

export interface MonitorEventNotice {
  taskId: string;
  description: string;
  /** The batch's stdout lines (a ws monitor's frames, multi-line ones whole). */
  lines: string[];
}

export interface TaskExitNotice {
  taskId: string;
  taskType: WorkspaceTaskType;
  description: string;
  status: WorkspaceTaskExitStatus;
  exitCode?: number | null;
  signal?: string | null;
  closeCode?: number | null;
  closeReason?: string | null;
  /** Event lines the task delivered (a monitor's). */
  eventCount?: number;
  outputFile?: string | null;
  /** The last ≤ 4 KB of its output file, as the workspace sent it. */
  outputTail?: string | null;
  /** A monitor's deadline (ms) — what `timeout` names. */
  timeoutMs?: number | null;
  durationMs?: number | null;
}

/** A monitor's batch of events. */
export function formatMonitorEvent(notice: MonitorEventNotice): string {
  return [
    "<task-notification>",
    `<task-id>${notice.taskId}</task-id>`,
    "<task-type>monitor</task-type>",
    `<description>${notice.description}</description>`,
    "<event>",
    notice.lines.join("\n"),
    "</event>",
    "</task-notification>",
  ].join("\n");
}

/** A background command's or a monitor's end. */
export function formatTaskExit(notice: TaskExitNotice): string {
  const tail = notice.taskType === "shell" ? lastLines(notice.outputTail ?? "") : "";
  return [
    "<task-notification>",
    `<task-id>${notice.taskId}</task-id>`,
    `<task-type>${notice.taskType}</task-type>`,
    `<status>${notice.status}</status>`,
    ...(typeof notice.exitCode === "number" ? [`<exit-code>${notice.exitCode}</exit-code>`] : []),
    ...(notice.status === "closed" && typeof notice.closeCode === "number"
      ? [`<close-code>${notice.closeCode}</close-code>`]
      : []),
    `<description>${notice.description}</description>`,
    ...(notice.outputFile ? [`<output-file>${notice.outputFile}</output-file>`] : []),
    `<summary>${summarizeTaskExit(notice)}</summary>`,
    ...(tail ? ["<output-tail>", tail, "</output-tail>"] : []),
    "</task-notification>",
  ].join("\n");
}

/** Notifications that reach the model together: one message, the blocks in order. */
export function joinTaskNotifications(blocks: string[]): string {
  return blocks.join("\n");
}

/** The one-line account of how a task ended. */
export function summarizeTaskExit(notice: TaskExitNotice): string {
  const description = notice.description;
  if (notice.taskType === "shell") {
    switch (notice.status) {
      case "completed":
        return `Background command "${description}" completed (exit code ${notice.exitCode ?? 0}).`;
      case "failed":
        if (typeof notice.exitCode === "number") {
          return `Background command "${description}" failed (exit code ${notice.exitCode}).`;
        }
        return notice.signal
          ? `Background command "${description}" failed (killed by ${notice.signal}).`
          : `Background command "${description}" failed.`;
      case "killed":
        return `Background command "${description}" was stopped.`;
      case "lost":
        return `Background command "${description}" was lost: its workspace went away before it finished.`;
      default:
        return `Background command "${description}" ended (${notice.status}).`;
    }
  }
  const events = eventsPhrase(notice.eventCount ?? 0);
  switch (notice.status) {
    case "exited":
      return typeof notice.exitCode === "number"
        ? `Monitor "${description}" exited (exit code ${notice.exitCode}) with ${events}.`
        : `Monitor "${description}" exited with ${events}.`;
    case "timeout":
      return `Monitor "${description}" expired after ${notice.timeoutMs ?? notice.durationMs ?? 0} ms with ${events}. Re-arm it if you still need the watch.`;
    case "too_many_events":
      return `Monitor "${description}" was stopped: too many events. Re-arm it with a tighter filter.`;
    case "killed":
      return `Monitor "${description}" was stopped.`;
    case "closed": {
      const code = typeof notice.closeCode === "number" ? ` (code ${notice.closeCode}${notice.closeReason ? `: ${notice.closeReason}` : ""})` : "";
      return `Monitor "${description}" ended: the WebSocket closed${code} with ${events}.`;
    }
    case "lost":
      return `Monitor "${description}" was lost: its workspace went away before it ended.`;
    default:
      return `Monitor "${description}" ended (${notice.status}) with ${events}.`;
  }
}

function eventsPhrase(count: number): string {
  return `${count} ${count === 1 ? "event" : "events"}`;
}

/** The last NOTIFICATION_OUTPUT_TAIL_LINES lines of a command's output, trailing blank lines dropped. */
function lastLines(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-NOTIFICATION_OUTPUT_TAIL_LINES).join("\n");
}

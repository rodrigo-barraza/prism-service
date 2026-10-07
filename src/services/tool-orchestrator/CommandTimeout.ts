import {
  COMMAND_DEFAULT_TIMEOUT_MILLISECONDS,
  COMMAND_MAXIMUM_TIMEOUT_MILLISECONDS,
  COMMAND_MINIMUM_TIMEOUT_MILLISECONDS,
  COMMAND_REPLY_MARGIN_MILLISECONDS,
} from "#src/constants/BackgroundTasks";

// ────────────────────────────────────────────────────────────
// CommandTimeout — how long a foreground execute_command may take
// ────────────────────────────────────────────────────────────
// Claude Code's Bash: `timeout` in milliseconds, default 120000, at most
// 600000; past it the command is killed and the call returns what it
// printed. tools-service does the killing. Prism waits for its reply that
// long plus a margin — never the generic proxy timeout (65 s), which cut
// every longer command off before tools-service could answer.
// ────────────────────────────────────────────────────────────

const DURATION = /^(\d+)\s*(ms|s|sec|secs|m|min|mins)?$/;

/**
 * A command's `timeout` as tools-service reads it: milliseconds (or "60s",
 * "2m"), the default when absent or unreadable, clamped to its bounds.
 */
export function commandTimeoutMilliseconds(value: unknown): number {
  let milliseconds: number | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    milliseconds = value;
  } else if (typeof value === "string") {
    const match = DURATION.exec(value.trim().toLowerCase());
    if (match) {
      const amount = Number(match[1]);
      const unit = match[2] ?? "ms";
      milliseconds = unit === "ms" ? amount : unit.startsWith("m") ? amount * 60_000 : amount * 1000;
    }
  }
  if (milliseconds === null) return COMMAND_DEFAULT_TIMEOUT_MILLISECONDS;
  return Math.min(
    Math.max(Math.round(milliseconds), COMMAND_MINIMUM_TIMEOUT_MILLISECONDS),
    COMMAND_MAXIMUM_TIMEOUT_MILLISECONDS,
  );
}

/** How long prism waits for tools-service to answer an execute_command call. */
export function commandReplyDeadlineMilliseconds(args: Record<string, unknown> | null | undefined): number {
  return commandTimeoutMilliseconds(args?.timeout) + COMMAND_REPLY_MARGIN_MILLISECONDS;
}

/** An execute_command call that runs detached (a background task) rather than to its end. */
export function runsInBackground(args: Record<string, unknown> | null | undefined): boolean {
  return args?.run_in_background === true || args?.run_in_background === "true";
}

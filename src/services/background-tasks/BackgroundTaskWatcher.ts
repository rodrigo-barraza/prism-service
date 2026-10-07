import DetachedWorkStore, {
  detachedWorkId,
  type DetachedWorkRecord,
  type WorkspaceTaskFields,
} from "#src/services/DetachedWorkStore";
import {
  TASK_EVENTS_RECONNECT_INITIAL_MILLISECONDS,
  TASK_EVENTS_RECONNECT_MAXIMUM_MILLISECONDS,
  WORKSPACE_TASK_EXIT_STATUSES,
  WORKSPACE_TASK_NOTIFICATION_SOURCE,
  type WorkspaceTaskExitStatus,
  type WorkspaceTaskStatus,
  type WorkspaceTaskType,
} from "#src/constants/BackgroundTasks";
import { PROTOCOL_EVENT_TYPES } from "#src/protocol/events";
import WebSocketConnectionRegistry from "#src/websocket/WebSocketConnectionRegistry";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import { currentAuthKind, type AuthKind } from "#src/utils/RequestContext";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import WorkspaceTaskClient, {
  type TaskExitParams,
  type TaskFrame,
  type TaskOwnerIdentity,
} from "./WorkspaceTaskClient.ts";
import TaskNotificationDelivery, { type DeliveryOutcome, type TaskNotice } from "./TaskNotificationDelivery.ts";
import { formatMonitorEvent, formatTaskExit } from "./TaskNotificationFormatter.ts";

// ────────────────────────────────────────────────────────────
// BackgroundTaskWatcher — the agent's background commands and monitors
// ────────────────────────────────────────────────────────────
// A background `execute_command` and a `monitor` run on the workspace as
// tasks (tools-service's task engine, on the bridge or in tools-service).
// For each one the watcher:
//
//   - keeps a durable record (DetachedWorkStore, kind `workspace_task`)
//     with the last event it handled (`task.lastSeq`);
//   - follows its event stream (`GET /agentic/tasks/:id/events?after=`),
//     reconnecting with backoff — the stream replays everything after the
//     seq it is given, so nothing is lost or delivered twice; a task
//     tools-service no longer knows (404) is `lost`;
//   - delivers each frame to the owner (TaskNotificationDelivery): a
//     monitor's batch of events as one notification, the exit as another;
//   - settles the record once the exit has been delivered, and tells the
//     conversation's live viewers (`background_task`) when the task starts,
//     as a monitor's events arrive, and when it ends.
//
// A restart does not end a task (it runs on the workspace): at boot every
// record still running is followed again from its `lastSeq` (reattach).
// A task prism stopped itself — task_stop, the stop route, the end of a
// sub-agent's run — is not announced to the agent when it ends: whoever
// stopped it knows. A sub-agent's monitors stop when its run ends
// (stopMonitorsOf); a sub-agent's notification after that is dropped.
// ────────────────────────────────────────────────────────────

export interface TaskOwner extends TaskOwnerIdentity {
  /** The owner is a sub-agent: never woken, and its monitors end with its run. */
  isSubAgent: boolean;
  /**
   * How the turn that started the task authenticated (its own when unset:
   * `watch` runs inside that turn). The wake its notification causes runs
   * with it — owner powers only for a signed-in user's task.
   */
  authKind?: AuthKind | null;
}

export interface WatchRequest {
  taskId: string;
  taskType: WorkspaceTaskType;
  description: string;
  command?: string;
  wsUrl?: string;
  outputFile?: string;
  timeoutMs?: number | null;
  startedAt?: string;
  owner: TaskOwner;
}

/** A task as GET /conversations/:id/tasks and `background_task` show it. */
export interface WatchedTaskSummary {
  taskId: string;
  taskType: WorkspaceTaskType;
  status: WorkspaceTaskStatus;
  description: string;
  command?: string;
  wsUrl?: string;
  outputFile?: string;
  eventCount: number;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
}

/** Who asked prism to stop a task. */
export type StopInitiator = "agent" | "user" | "run_end";

export type StopOutcome =
  | { found: false }
  | { found: true; stopped: boolean; status?: string; error?: string; task: WatchedTaskSummary };

interface WatchedTask {
  recordId: string;
  taskId: string;
  taskType: WorkspaceTaskType;
  description: string;
  command?: string;
  wsUrl?: string;
  outputFile?: string;
  timeoutMs: number | null;
  owner: TaskOwner;
  status: WorkspaceTaskStatus;
  lastSeq: number;
  eventCount: number;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
  /** Prism stopped it: its end is recorded, not announced to the agent. */
  stoppedBy?: StopInitiator;
  /** Ends the following (a shutdown) — never the task itself. */
  following: AbortController;
}

const EXIT_STATUSES = new Set<string>(WORKSPACE_TASK_EXIT_STATUSES);

/** Tasks being followed, by task id. An ended task leaves the map (its record stays). */
const watchedTasks = new Map<string, WatchedTask>();

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function summaryOf(task: WatchedTask): WatchedTaskSummary {
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    status: task.status,
    description: task.description,
    ...(task.command !== undefined ? { command: task.command } : {}),
    ...(task.wsUrl !== undefined ? { wsUrl: task.wsUrl } : {}),
    ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
    eventCount: task.eventCount,
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    startedAt: task.startedAt,
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
  };
}

function summaryOfRecord(record: DetachedWorkRecord): WatchedTaskSummary | null {
  const fields = record.task;
  if (!fields) return null;
  return {
    taskId: record.itemId,
    taskType: fields.type,
    status: fields.status,
    description: fields.description,
    ...(fields.command !== undefined ? { command: fields.command } : {}),
    ...(fields.wsUrl !== undefined ? { wsUrl: fields.wsUrl } : {}),
    ...(fields.outputFile !== undefined ? { outputFile: fields.outputFile } : {}),
    eventCount: fields.eventCount ?? 0,
    ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
    startedAt: fields.startedAt,
    ...(fields.endedAt ? { endedAt: fields.endedAt } : {}),
  };
}

function taskFromRecord(record: DetachedWorkRecord): WatchedTask | null {
  const fields = record.task;
  if (!fields) return null;
  return {
    recordId: record.id,
    taskId: record.itemId,
    taskType: fields.type,
    description: fields.description,
    ...(fields.command !== undefined ? { command: fields.command } : {}),
    ...(fields.wsUrl !== undefined ? { wsUrl: fields.wsUrl } : {}),
    ...(fields.outputFile !== undefined ? { outputFile: fields.outputFile } : {}),
    timeoutMs: fields.timeoutMs ?? null,
    owner: {
      conversationId: record.loopKey,
      agentConversationId: record.agentConversationId,
      project: record.project,
      username: record.username,
      workspaceRoot: fields.workspaceRoot ?? null,
      isSubAgent: fields.isSubAgent === true,
      authKind: record.authKind ?? null,
    },
    status: "running",
    lastSeq: fields.lastSeq ?? 0,
    eventCount: fields.eventCount ?? 0,
    startedAt: fields.startedAt,
    following: new AbortController(),
  };
}

/** Tell the owner's live viewers how the task stands (`background_task`). */
function announce(task: WatchedTask): void {
  emitBackgroundTaskEvent({
    type: PROTOCOL_EVENT_TYPES.BACKGROUND_TASK,
    conversationId: task.owner.conversationId,
    taskId: task.taskId,
    taskType: task.taskType,
    status: task.status,
    description: task.description,
    ...(task.command !== undefined ? { command: task.command } : {}),
    ...(task.wsUrl !== undefined ? { wsUrl: task.wsUrl } : {}),
    ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
    ...(task.taskType === "monitor" ? { eventCount: task.eventCount } : {}),
    ...(task.status !== "running" ? { exitCode: task.exitCode ?? null } : {}),
    at: new Date().toISOString(),
  });
}

function emitBackgroundTaskEvent(event: { type: string; conversationId: string; [key: string]: unknown }): void {
  try {
    WebSocketConnectionRegistry.getEmitFunction(event.conversationId)?.(event);
  } catch {
    // Viewer fan-out is best-effort.
  }
}

/** The notice of one notification of `task`, to its owner. */
function noticeOf(task: WatchedTask, text: string, seq: number): TaskNotice {
  return {
    loopKey: task.owner.conversationId,
    conversationId: task.owner.isSubAgent ? null : task.owner.conversationId,
    agentConversationId: task.owner.agentConversationId,
    project: task.owner.project,
    username: task.owner.username,
    isSubAgent: task.owner.isSubAgent,
    authKind: task.owner.authKind ?? null,
    kind: "task_notification",
    text,
    timestamp: new Date().toISOString(),
    workspaceRoot: task.owner.workspaceRoot ?? null,
    meta: {
      _notificationSource: WORKSPACE_TASK_NOTIFICATION_SOURCE,
      _notificationId: `${WORKSPACE_TASK_NOTIFICATION_SOURCE}:${task.taskId}:${seq}`,
      taskId: task.taskId,
    },
  };
}

async function deliver(task: WatchedTask, text: string, seq: number): Promise<DeliveryOutcome> {
  try {
    return await TaskNotificationDelivery.deliver(noticeOf(task, text, seq));
  } catch (error: unknown) {
    logger.warn(`[BackgroundTaskWatcher] Could not deliver ${task.taskId}#${seq}: ${getErrorMessage(error)}`);
    return "failed";
  }
}

async function handleEvent(task: WatchedTask, seq: number, lines: string[]): Promise<void> {
  task.eventCount += lines.length;
  if (lines.length > 0) {
    await deliver(task, formatMonitorEvent({ taskId: task.taskId, description: task.description, lines }), seq);
  }
  task.lastSeq = seq;
  await DetachedWorkStore.progressed(task.recordId, { lastSeq: seq, eventCount: task.eventCount });
  announce(task);
}

async function handleExit(task: WatchedTask, exit: TaskExitParams): Promise<void> {
  const status: WorkspaceTaskExitStatus = EXIT_STATUSES.has(exit.status) ? exit.status : "failed";
  task.status = status;
  task.exitCode = typeof exit.exitCode === "number" ? exit.exitCode : null;
  task.eventCount = typeof exit.eventCount === "number" ? exit.eventCount : task.eventCount;
  task.outputFile = exit.outputFile || task.outputFile;
  task.endedAt = exit.at || new Date().toISOString();
  task.lastSeq = exit.seq;

  let via: string;
  if (status === "killed" && task.stoppedBy) {
    via = "stopped";
    logger.info(`[BackgroundTaskWatcher] ${task.taskId} stopped (${task.stoppedBy}) — its end is not announced to the agent`);
  } else {
    via = await deliver(
      task,
      formatTaskExit({
        taskId: task.taskId,
        taskType: task.taskType,
        description: task.description,
        status,
        exitCode: task.exitCode,
        signal: exit.signal ?? null,
        closeCode: exit.closeCode ?? null,
        closeReason: exit.closeReason ?? null,
        eventCount: task.eventCount,
        outputFile: task.outputFile ?? null,
        outputTail: exit.outputTail ?? null,
        timeoutMs: task.timeoutMs,
        durationMs: exit.durationMs ?? null,
      }),
      exit.seq,
    );
  }
  await DetachedWorkStore.workspaceTaskEnded(
    task.recordId,
    {
      status,
      lastSeq: exit.seq,
      eventCount: task.eventCount,
      exitCode: task.exitCode,
      endedAt: task.endedAt,
      ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
    },
    via,
  );
  watchedTasks.delete(task.taskId);
  announce(task);
  logger.info(`[BackgroundTaskWatcher] ${task.taskId} ended (${status}) — delivered via ${via}`);
}

async function handleFrame(task: WatchedTask, frame: TaskFrame): Promise<void> {
  // A replay after a reconnect starts at the seq the stream was given; one
  // already handled is skipped all the same.
  if (frame.params.seq <= task.lastSeq) return;
  if (frame.method === "task.event") {
    const lines = Array.isArray(frame.params.lines)
      ? frame.params.lines.filter((line): line is string => typeof line === "string")
      : [];
    await handleEvent(task, frame.params.seq, lines);
    return;
  }
  await handleExit(task, frame.params);
}

/** Follow a task's event stream until its exit has been handled (or the process shuts down). */
async function follow(task: WatchedTask): Promise<void> {
  const signal = task.following.signal;
  let delay = TASK_EVENTS_RECONNECT_INITIAL_MILLISECONDS;
  while (task.status === "running" && !signal.aborted) {
    const stream = await WorkspaceTaskClient.events(task.taskId, task.lastSeq, task.owner, signal);
    if (signal.aborted) return;
    if (stream.status === "not_found") {
      logger.warn(`[BackgroundTaskWatcher] tools-service no longer knows ${task.taskId} — reporting it lost`);
      await handleExit(task, {
        taskId: task.taskId,
        seq: task.lastSeq + 1,
        status: "lost",
        exitCode: null,
        eventCount: task.eventCount,
        at: new Date().toISOString(),
      });
      return;
    }
    if (stream.status === "open") {
      try {
        for await (const frame of stream.frames) {
          await handleFrame(task, frame);
          delay = TASK_EVENTS_RECONNECT_INITIAL_MILLISECONDS;
          if (task.status !== "running") return;
        }
      } catch (error: unknown) {
        if (signal.aborted) return;
        logger.debug(`[BackgroundTaskWatcher] ${task.taskId} event stream broke: ${getErrorMessage(error)}`);
      }
    } else {
      logger.warn(`[BackgroundTaskWatcher] ${task.taskId} event stream: ${stream.error}`);
    }
    if (task.status !== "running" || signal.aborted) return;
    await sleep(delay, signal);
    delay = Math.min(delay * 2, TASK_EVENTS_RECONNECT_MAXIMUM_MILLISECONDS);
  }
}

function startFollowing(task: WatchedTask): void {
  watchedTasks.set(task.taskId, task);
  void follow(task).catch((error: unknown) => {
    logger.error(`[BackgroundTaskWatcher] Following ${task.taskId} failed: ${getErrorMessage(error)}`);
  });
}

/** Whether `requester` may see and stop a task of `owner` (same user, same project when both say). */
function owns(
  requester: { username?: string | null; project?: string | null } | null,
  owner: { username: string | null; project: string | null },
): boolean {
  if (!requester) return true;
  if (requester.username && owner.username && requester.username !== owner.username) return false;
  if (requester.project && owner.project && requester.project !== owner.project) return false;
  return true;
}

// The tasks run on: a shutdown only stops following them (the next boot
// picks them up from their records).
registerCleanup(async () => {
  for (const task of watchedTasks.values()) task.following.abort();
});

const BackgroundTaskWatcher = {
  /** Watch a task that just started: record it, announce it, follow its events. */
  async watch(request: WatchRequest): Promise<void> {
    if (watchedTasks.has(request.taskId)) return;
    const startedAt = request.startedAt ?? new Date().toISOString();
    // Called from the turn that started the task: its auth is the owner's.
    const owner: TaskOwner = { ...request.owner, authKind: request.owner.authKind ?? currentAuthKind() };
    const task: WatchedTask = {
      recordId: detachedWorkId("workspace_task", request.owner.conversationId, request.taskId),
      taskId: request.taskId,
      taskType: request.taskType,
      description: request.description,
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.wsUrl !== undefined ? { wsUrl: request.wsUrl } : {}),
      ...(request.outputFile !== undefined ? { outputFile: request.outputFile } : {}),
      timeoutMs: request.timeoutMs ?? null,
      owner,
      status: "running",
      lastSeq: 0,
      eventCount: 0,
      startedAt,
      following: new AbortController(),
    };
    const fields: WorkspaceTaskFields = {
      type: task.taskType,
      description: task.description,
      ...(task.command !== undefined ? { command: task.command } : {}),
      ...(task.wsUrl !== undefined ? { wsUrl: task.wsUrl } : {}),
      ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
      timeoutMs: task.timeoutMs,
      workspaceRoot: task.owner.workspaceRoot ?? null,
      isSubAgent: task.owner.isSubAgent,
      status: "running",
      lastSeq: 0,
      eventCount: 0,
      startedAt,
    };
    // In the map before the first await: a stop or a list right after the
    // tool returned finds it.
    watchedTasks.set(task.taskId, task);
    await DetachedWorkStore.started({
      id: task.recordId,
      itemId: task.taskId,
      kind: "workspace_task",
      loopKey: task.owner.conversationId,
      conversationId: task.owner.conversationId,
      agentConversationId: task.owner.agentConversationId,
      project: task.owner.project,
      username: task.owner.username,
      authKind: task.owner.authKind ?? null,
      task: fields,
    });
    announce(task);
    logger.info(`[BackgroundTaskWatcher] Watching ${task.taskId} (${task.taskType}) for ${task.owner.conversationId}`);
    startFollowing(task);
  },

  /**
   * At boot: follow again every task the last process was watching, from
   * the last event it handled. A sub-agent's monitor is stopped — its run
   * ended with that process. Returns how many were picked up.
   */
  async reattach(): Promise<number> {
    let count = 0;
    for (const record of await DetachedWorkStore.listUnsettledWorkspaceTasks()) {
      if (watchedTasks.has(record.itemId)) continue;
      const task = taskFromRecord(record);
      if (!task) continue;
      startFollowing(task);
      count++;
      if (task.owner.isSubAgent && task.taskType === "monitor") {
        void BackgroundTaskWatcher.stop(task.taskId, null, "run_end");
      }
    }
    if (count > 0) logger.info(`[BackgroundTaskWatcher] Following ${count} background task(s) again after the restart`);
    return count;
  },

  /**
   * Stop a task through tools-service. `requester` (a user, an agent) must
   * own it; null skips the check (prism's own stops). Its exit (`killed`)
   * arrives on the event stream and is recorded, not announced to the agent.
   */
  async stop(
    taskId: string,
    requester: { username?: string | null; project?: string | null } | null,
    initiator: StopInitiator,
  ): Promise<StopOutcome> {
    const task = watchedTasks.get(taskId);
    if (!task) {
      // Ended already (its record says how), or not this process's to stop.
      const record = await DetachedWorkStore.findWorkspaceTask(taskId);
      const summary = record ? summaryOfRecord(record) : null;
      if (!record || !summary || !owns(requester, record)) return { found: false };
      return { found: true, stopped: false, status: summary.status, task: summary };
    }
    if (!owns(requester, task.owner)) return { found: false };
    if (task.status !== "running") {
      return { found: true, stopped: false, status: task.status, task: summaryOf(task) };
    }
    task.stoppedBy = initiator;
    const result = await WorkspaceTaskClient.stop(taskId, task.owner);
    // Not stopped (it had just ended, or tools-service refused): an exit of
    // its own is the agent's to hear.
    if (!result.stopped) task.stoppedBy = undefined;
    logger.info(
      `[BackgroundTaskWatcher] Stop of ${taskId} (${initiator}): ${result.stopped ? "stopped" : `not stopped${result.error ? ` — ${result.error}` : ""}`}`,
    );
    return {
      found: true,
      stopped: result.stopped,
      ...(result.status ? { status: result.status } : {}),
      ...(result.error ? { error: result.error } : {}),
      task: summaryOf(task),
    };
  },

  /** A sub-agent's run ended: the monitors it armed end with it. Returns how many it stopped. */
  stopMonitorsOf(loopKey: string): number {
    let count = 0;
    for (const task of watchedTasks.values()) {
      if (task.owner.conversationId !== loopKey || task.taskType !== "monitor" || task.status !== "running") continue;
      count++;
      void BackgroundTaskWatcher.stop(task.taskId, null, "run_end");
    }
    if (count > 0) logger.info(`[BackgroundTaskWatcher] ${loopKey}'s run ended — stopping its ${count} monitor(s)`);
    return count;
  },

  /** A task being followed, as the tools and routes show it. */
  get(taskId: string): WatchedTaskSummary | null {
    const task = watchedTasks.get(taskId);
    return task ? summaryOf(task) : null;
  },

  /** A conversation's tasks, running and ended, oldest first. */
  async list(owner: {
    conversationId: string;
    project?: string | null;
    username?: string | null;
  }): Promise<WatchedTaskSummary[]> {
    const byId = new Map<string, WatchedTaskSummary>();
    for (const record of await DetachedWorkStore.listWorkspaceTasks(owner)) {
      const summary = summaryOfRecord(record);
      if (summary) byId.set(summary.taskId, summary);
    }
    // What is followed in this process is the latest word on it.
    for (const task of watchedTasks.values()) {
      if (task.owner.conversationId === owner.conversationId && owns(owner, task.owner)) {
        byId.set(task.taskId, summaryOf(task));
      }
    }
    return [...byId.values()].sort((left, right) => (left.startedAt < right.startedAt ? -1 : 1));
  },

  /** Test helper — stop following everything and forget it. */
  _reset(): void {
    for (const task of watchedTasks.values()) task.following.abort();
    watchedTasks.clear();
  },
};

export default BackgroundTaskWatcher;

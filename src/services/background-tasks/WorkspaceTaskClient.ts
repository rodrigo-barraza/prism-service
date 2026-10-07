import { TOOLS_SERVICE_URL } from "#config";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/service";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  TASK_EVENTS_IDLE_TIMEOUT_MILLISECONDS,
  TASK_REQUEST_TIMEOUT_MILLISECONDS,
  type WorkspaceTaskExitStatus,
  type WorkspaceTaskType,
} from "#src/constants/BackgroundTasks";

// ────────────────────────────────────────────────────────────
// WorkspaceTaskClient — tools-service's task API, as prism calls it
// ────────────────────────────────────────────────────────────
//   POST /agentic/tasks                         start a task (a monitor)
//   GET  /agentic/tasks/:id/events?after=<seq>  its notifications, as SSE:
//                                               the replay after `seq`, then
//                                               live, ending after the exit
//   POST /agentic/tasks/:id/stop                stop it
// A background command is started by execute_command itself (the same
// task engine); prism only watches and stops it.
// ────────────────────────────────────────────────────────────

/** Who a task belongs to — sent with every call, and on the task itself. */
export interface TaskOwnerIdentity {
  conversationId: string;
  agentConversationId: string | null;
  project: string | null;
  username: string | null;
  workspaceRoot?: string | null;
}

export interface StartTaskRequest {
  kind: WorkspaceTaskType;
  command?: string;
  ws?: { url: string; protocols?: string[] };
  cwd: string;
  description: string;
  timeoutMs?: number;
}

export interface StartedTask {
  taskId: string;
  kind: WorkspaceTaskType;
  pid: number | null;
  outputFile: string;
  startedAt: string;
  timeoutMs: number | null;
  location?: string;
}

export interface TaskEventParams {
  taskId: string;
  seq: number;
  lines: string[];
  at?: string;
}

export interface TaskExitParams {
  taskId: string;
  seq: number;
  kind?: WorkspaceTaskType;
  status: WorkspaceTaskExitStatus;
  exitCode?: number | null;
  signal?: string | null;
  closeCode?: number;
  closeReason?: string;
  eventCount?: number;
  durationMs?: number;
  outputFile?: string;
  outputTail?: string;
  at?: string;
}

export type TaskFrame =
  | { method: "task.event"; params: TaskEventParams }
  | { method: "task.exit"; params: TaskExitParams };

export type TaskEventStream =
  | { status: "open"; frames: AsyncGenerator<TaskFrame> }
  | { status: "not_found" }
  | { status: "error"; error: string };

export interface StopTaskResult {
  stopped: boolean;
  status?: string;
  error?: string;
}

function headersFor(owner: TaskOwnerIdentity, json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(owner.project ? { [IDENTITY_HEADERS.project]: owner.project } : {}),
    ...(owner.username ? { [IDENTITY_HEADERS.username]: owner.username } : {}),
    [IDENTITY_HEADERS.conversationId]: owner.conversationId,
    ...(owner.agentConversationId ? { "X-Agent-Conversation-Id": owner.agentConversationId } : {}),
    ...(owner.workspaceRoot ? { [IDENTITY_HEADERS.workspaceRoot]: owner.workspaceRoot } : {}),
  };
}

async function errorOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const message = body.error ?? body.message;
    if (typeof message === "string" && message) return message;
  } catch {
    /* not JSON */
  }
  return `tools-service returned ${response.status}${response.statusText ? `: ${response.statusText}` : ""}`;
}

function isFrame(value: unknown): value is TaskFrame {
  const frame = value as { method?: unknown; params?: { seq?: unknown } } | null;
  return (
    !!frame &&
    (frame.method === "task.event" || frame.method === "task.exit") &&
    typeof frame.params === "object" &&
    frame.params !== null &&
    typeof frame.params.seq === "number"
  );
}

/**
 * The frames of an SSE body: `data:` lines up to a blank line are one
 * frame (JSON); comment lines (`: ping`) only show the stream is alive.
 * `onActivity` runs for every chunk read — the caller's idle watchdog.
 */
async function* readFrames(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncGenerator<TaskFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let data: string[] = [];
  const flush = (): TaskFrame | null => {
    if (data.length === 0) return null;
    const payload = data.join("\n");
    data = [];
    try {
      const parsed: unknown = JSON.parse(payload);
      return isFrame(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onActivity();
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
        }
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.startsWith("data:")) data.push(buffered.slice(buffered.startsWith("data: ") ? 6 : 5));
    const frame = flush();
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

const WorkspaceTaskClient = {
  /** Start a task on the workspace that serves `cwd` (or in tools-service). */
  async start(
    request: StartTaskRequest,
    owner: TaskOwnerIdentity,
  ): Promise<StartedTask | { error: string }> {
    try {
      const response = await fetch(`${TOOLS_SERVICE_URL}/agentic/tasks`, {
        method: "POST",
        headers: headersFor(owner, true),
        body: JSON.stringify({
          ...request,
          owner: {
            conversationId: owner.conversationId,
            agentConversationId: owner.agentConversationId,
            project: owner.project,
            username: owner.username,
          },
        }),
        signal: AbortSignal.timeout(TASK_REQUEST_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) return { error: await errorOf(response) };
      const started = (await response.json()) as StartedTask;
      if (!started || typeof started.taskId !== "string") {
        return { error: "tools-service started no task (its reply carried no taskId)" };
      }
      return started;
    } catch (error: unknown) {
      return { error: `Could not reach tools-service: ${getErrorMessage(error)}` };
    }
  },

  /** Stop a running task: its exit (`killed`) follows on its event stream. */
  async stop(taskId: string, owner: TaskOwnerIdentity): Promise<StopTaskResult> {
    try {
      const response = await fetch(`${TOOLS_SERVICE_URL}/agentic/tasks/${encodeURIComponent(taskId)}/stop`, {
        method: "POST",
        headers: headersFor(owner, true),
        body: "{}",
        signal: AbortSignal.timeout(TASK_REQUEST_TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) return { stopped: false, error: await errorOf(response) };
      const result = (await response.json()) as StopTaskResult;
      return { stopped: result?.stopped === true, ...(result?.status ? { status: result.status } : {}), ...(result?.error ? { error: result.error } : {}) };
    } catch (error: unknown) {
      return { stopped: false, error: `Could not reach tools-service: ${getErrorMessage(error)}` };
    }
  },

  /**
   * Open a task's event stream after `afterSeq`. A stream that sends nothing
   * — not even a ping — for TASK_EVENTS_IDLE_TIMEOUT_MILLISECONDS is cut, so
   * its frames end and the caller opens it again. `signal` ends it for good.
   */
  async events(
    taskId: string,
    afterSeq: number,
    owner: TaskOwnerIdentity,
    signal: AbortSignal,
  ): Promise<TaskEventStream> {
    const connection = new AbortController();
    const abortConnection = () => connection.abort();
    signal.addEventListener("abort", abortConnection, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(abortConnection, TASK_EVENTS_IDLE_TIMEOUT_MILLISECONDS);
    };
    const release = () => {
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", abortConnection);
    };
    try {
      touch();
      const response = await fetch(
        `${TOOLS_SERVICE_URL}/agentic/tasks/${encodeURIComponent(taskId)}/events?after=${afterSeq}`,
        { headers: { ...headersFor(owner), Accept: "text/event-stream" }, signal: connection.signal },
      );
      if (response.status === 404) {
        release();
        return { status: "not_found" };
      }
      if (!response.ok || !response.body) {
        const error = response.ok ? "the event stream has no body" : await errorOf(response);
        release();
        return { status: "error", error };
      }
      const body = response.body;
      async function* frames(): AsyncGenerator<TaskFrame> {
        try {
          yield* readFrames(body, touch);
        } finally {
          release();
          connection.abort();
        }
      }
      return { status: "open", frames: frames() };
    } catch (error: unknown) {
      release();
      return { status: "error", error: getErrorMessage(error) };
    }
  },
};

export default WorkspaceTaskClient;

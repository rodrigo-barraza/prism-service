import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import {
  BACKGROUND_TASK_TOOL_NAMES,
  MONITOR_DEFAULT_TIMEOUT_MILLISECONDS,
  MONITOR_MAXIMUM_TIMEOUT_MILLISECONDS,
  MONITOR_MINIMUM_TIMEOUT_MILLISECONDS,
  MONITOR_SCHEMA_MAXIMUM_TIMEOUT_MILLISECONDS,
  WORKSPACE_TASK_ID_PATTERN,
} from "#src/constants/BackgroundTasks";
import { SYSTEM_STATUSES } from "#src/constants";
import { resolveLoopKey } from "#src/services/LoopKey";
import logger from "#src/utils/logger";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

/** What the harness spreads into a tool's context beyond InternalToolContext. */
type RuntimeToolContext = InternalToolContext & { workspaceRoot?: string | null };

// ────────────────────────────────────────────────────────────
// BackgroundTaskTools — Claude Code's Monitor and TaskStop
// ────────────────────────────────────────────────────────────
//   - monitor    a background script (or a WebSocket) whose every stdout
//                line (text frame) reaches the agent as a notification —
//                into the running turn, or waking a new one
//                (background-tasks/BackgroundTaskWatcher)
//   - task_stop  stop a background task by id: a background command or a
//                monitor (tools-service), an async task
//                (AsyncTaskRegistry), or a sub-agent (OrchestratorService)
// A background command is execute_command's own `run_in_background`
// (ToolOrchestratorService registers it with the watcher).
// ────────────────────────────────────────────────────────────

/** Claude Code's Monitor description — the tool names are Prism's. */
export const MONITOR_DESCRIPTION = `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **execute_command with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. You get a single completion notification when it exits.
- **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use execute_command \`run_in_background\` with an \`until\` loop instead (one notification, ends in seconds). Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. \`head\` cannot flush at all — \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via read_file) but does not trigger notifications — for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"

For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as execute_command. Exit ends the watch (exit code is reported). Every monitor expires after \`timeout_ms\` (default 5 minutes, at most 30 minutes): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use task_stop to cancel early.
**ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.

  monitor({
    ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
    description: 'deploy events',
  })

Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as the command source — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.

Prefer this over \`command: 'websocat wss://…'\` — it avoids the extra process and line-buffering pitfalls. Use a command when you need to transform or filter frames with shell tools before they become events.`;

export const TASK_STOP_DESCRIPTION = [
  "- Stops a running background task by its ID",
  "- Takes a task_id parameter identifying the task to stop (a background command, a monitor, an async task, or a sub-agent)",
  "- Returns a success or failure status",
  "- Use this tool when you need to terminate a long-running task",
].join("\n");

/** `timeout_ms` as the monitor runs it: the default, the schema's bounds, the cap. */
export function resolveMonitorTimeout(value: unknown): { timeoutMs: number } | { error: string } {
  if (value === undefined || value === null || value === "") {
    return { timeoutMs: MONITOR_DEFAULT_TIMEOUT_MILLISECONDS };
  }
  const requested = typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return { error: "timeout_ms must be a number of milliseconds." };
  }
  if (requested < MONITOR_MINIMUM_TIMEOUT_MILLISECONDS) {
    return { error: `timeout_ms must be at least ${MONITOR_MINIMUM_TIMEOUT_MILLISECONDS} (milliseconds).` };
  }
  if (requested > MONITOR_SCHEMA_MAXIMUM_TIMEOUT_MILLISECONDS) {
    return { error: `timeout_ms must be at most ${MONITOR_SCHEMA_MAXIMUM_TIMEOUT_MILLISECONDS} (milliseconds).` };
  }
  return { timeoutMs: Math.min(Math.round(requested), MONITOR_MAXIMUM_TIMEOUT_MILLISECONDS) };
}

/** A `ws` source: a ws:// or wss:// url and its subprotocols; an error string when it is not one. */
function parseWebSocketSource(value: unknown): { url: string; protocols?: string[] } | string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "ws must be an object: {url, protocols?}.";
  const source = value as { url?: unknown; protocols?: unknown };
  const url = typeof source.url === "string" ? source.url.trim() : "";
  if (!/^wss?:\/\//i.test(url)) return "ws.url must be a ws:// or wss:// URL.";
  const protocols =
    typeof source.protocols === "string"
      ? [source.protocols]
      : Array.isArray(source.protocols)
        ? source.protocols.filter((protocol): protocol is string => typeof protocol === "string" && protocol !== "")
        : [];
  return { url, ...(protocols.length > 0 ? { protocols } : {}) };
}

/** Whether the calling loop is a sub-agent's (the harness does not always say). */
async function isSubAgentRun(context: InternalToolContext): Promise<boolean> {
  if (typeof context.isSubAgent === "boolean") return context.isSubAgent;
  const loopKey = resolveLoopKey(context);
  if (!loopKey) return false;
  try {
    const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
    return OrchestratorService.isSubAgentConversation(loopKey);
  } catch {
    return false;
  }
}

/** Where the turn works: its worktree, else its workspace root, else the primary root. */
async function effectiveWorkspaceRoot(context: RuntimeToolContext): Promise<string | null> {
  const { default: ToolOrchestratorService } = await import("#src/services/ToolOrchestratorService");
  return (
    ToolOrchestratorService.getWorktreeState(context.agentConversationId)?.worktreePath ||
    context.workspaceRoot ||
    ToolOrchestratorService.getWorkspaceRoot() ||
    null
  );
}

// ── monitor ────────────────────────────────────────────────
const monitor = {
  name: BACKGROUND_TASK_TOOL_NAMES.MONITOR,
  // The script runs in the shell execute_command uses; a ws source reads
  // the network.
  capabilities: ["shell", "fs_write", "network"] as const,
  emoji: INTERNAL_TOOL_EMOJIS[BACKGROUND_TASK_TOOL_NAMES.MONITOR],
  description: MONITOR_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command or script. Each stdout line is an event; exit ends the watch.",
      },
      ws: {
        type: "object",
        description:
          "WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
        properties: {
          url: { type: "string" },
          // RFC 6455 subprotocol tokens.
          protocols: { type: "array", items: { type: "string", pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" } },
        },
        required: ["url"],
        additionalProperties: false,
      },
      description: {
        type: "string",
        description: "Short human-readable description of what you are monitoring (shown in notifications).",
      },
      timeout_ms: {
        type: "number",
        description:
          "Kill the monitor after this deadline. Default 300000ms. Deadlines above 1800000ms are capped to 1800000ms. You are notified at expiry and can re-arm.",
        default: MONITOR_DEFAULT_TIMEOUT_MILLISECONDS,
        minimum: MONITOR_MINIMUM_TIMEOUT_MILLISECONDS,
        maximum: MONITOR_SCHEMA_MAXIMUM_TIMEOUT_MILLISECONDS,
      },
    },
    required: ["description", "timeout_ms"],
  },
  display: {
    activeVerb: "Starting monitor",
    completedVerb: "Started monitor",
    subjectParam: "description",
    subjectFormat: "quoted" as const,
  },
  labels: ["background", "monitor", "task", "shell"],
  domain: DOMAINS.CORE_WORKSPACE.displayName,

  async execute(toolArguments: Record<string, unknown>, context: InternalToolContext) {
    const loopKey = resolveLoopKey(context);
    if (!loopKey) {
      return { error: "monitor needs a conversation to deliver its events to." };
    }
    const description = typeof toolArguments.description === "string" ? toolArguments.description.trim() : "";
    if (!description) {
      return { error: "Missing required parameter 'description': say what you are monitoring — it is shown in every notification." };
    }
    const command = typeof toolArguments.command === "string" ? toolArguments.command.trim() : "";
    const ws = parseWebSocketSource(toolArguments.ws);
    if (typeof ws === "string") return { error: ws };
    if (command && ws) return { error: "Pass either command or ws, not both." };
    if (!command && !ws) {
      return { error: "Pass a command (each stdout line is an event) or ws: {url} (each text frame is an event)." };
    }
    const timeout = resolveMonitorTimeout(toolArguments.timeout_ms);
    if ("error" in timeout) return { error: timeout.error };

    const cwd = await effectiveWorkspaceRoot(context as RuntimeToolContext);
    if (!cwd) {
      return { error: "monitor has no workspace to run in: no workspace root is configured for this conversation." };
    }
    const owner = {
      conversationId: loopKey,
      agentConversationId: context.agentConversationId ?? null,
      project: context.project ?? null,
      username: context.username ?? null,
      workspaceRoot: cwd,
      isSubAgent: await isSubAgentRun(context),
    };

    try {
      const { default: WorkspaceTaskClient } = await import("#src/services/background-tasks/WorkspaceTaskClient");
      const { default: BackgroundTaskWatcher } = await import("#src/services/background-tasks/BackgroundTaskWatcher");
      const started = await WorkspaceTaskClient.start(
        {
          kind: "monitor",
          ...(command ? { command } : { ws: ws! }),
          cwd,
          description,
          timeoutMs: timeout.timeoutMs,
        },
        owner,
      );
      if ("error" in started) return { error: `Monitor could not start: ${started.error}` };
      const timeoutMs = started.timeoutMs ?? timeout.timeoutMs;
      await BackgroundTaskWatcher.watch({
        taskId: started.taskId,
        taskType: "monitor",
        description,
        ...(command ? { command } : { wsUrl: ws!.url }),
        outputFile: started.outputFile,
        timeoutMs,
        startedAt: started.startedAt,
        owner,
      });
      logger.info(`[BackgroundTaskTools] Monitor ${started.taskId} started for ${loopKey}: "${description}"`);
      return command
        ? `Monitor started (task id: ${started.taskId}, timeout ${timeoutMs} ms). Each stdout line will arrive as a notification; stderr goes to ${started.outputFile}. Use task_stop to cancel.`
        : `Monitor started (task id: ${started.taskId}, timeout ${timeoutMs} ms). Each text frame will arrive as a notification; its log is ${started.outputFile}. Use task_stop to cancel.`;
    } catch (error: unknown) {
      return { error: `Monitor could not start: ${getErrorMessage(error)}` };
    }
  },
};

// ── task_stop ──────────────────────────────────────────────
const taskStop = {
  name: BACKGROUND_TASK_TOOL_NAMES.TASK_STOP,
  // It only ends work this conversation started.
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[BACKGROUND_TASK_TOOL_NAMES.TASK_STOP],
  description: TASK_STOP_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The ID of the background task to stop" },
      shell_id: { type: "string", description: "Deprecated: use task_id instead" },
    },
    required: [],
  },
  display: {
    activeVerb: "Stopping task",
    completedVerb: "Stopped task",
    subjectParam: "task_id",
    subjectFormat: "quoted" as const,
  },
  labels: ["background", "task", "monitor", "async", "subagent"],
  domain: DOMAINS.CORE_HARNESS.displayName,

  async execute(toolArguments: Record<string, unknown>, context: InternalToolContext) {
    const raw = typeof toolArguments.task_id === "string" && toolArguments.task_id.trim()
      ? toolArguments.task_id
      : toolArguments.shell_id;
    const taskId = typeof raw === "string" ? raw.trim() : "";
    if (!taskId) return { success: false, error: "Missing required parameter 'task_id'." };
    const notFound = { success: false, error: `No task found with ID: ${taskId}` };
    const notRunning = (status: string) => ({
      success: false,
      error: `Task ${taskId} is not running (status: ${status})`,
    });
    const stopped = (taskType: string, label: string) => ({
      success: true,
      message: `Successfully stopped task: ${taskId} (${label})`,
      task_id: taskId,
      task_type: taskType,
    });

    try {
      // A background command or a monitor: tools-service stops it.
      if (WORKSPACE_TASK_ID_PATTERN.test(taskId)) {
        const { default: BackgroundTaskWatcher } = await import("#src/services/background-tasks/BackgroundTaskWatcher");
        const outcome = await BackgroundTaskWatcher.stop(
          taskId,
          { username: context.username ?? null, project: context.project ?? null },
          "agent",
        );
        if (!outcome.found) return notFound;
        if (!outcome.stopped) {
          return outcome.error ? { success: false, error: outcome.error } : notRunning(outcome.status ?? "unknown");
        }
        return stopped(outcome.task.taskType, outcome.task.command ?? outcome.task.wsUrl ?? outcome.task.description);
      }

      // An async task (run_async_task).
      if (taskId.startsWith("task-")) {
        const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
        const task = AsyncTaskRegistry.getTask(taskId);
        if (!task || (task.username && context.username && task.username !== context.username)) return notFound;
        if (task.status !== SYSTEM_STATUSES.RUNNING || !AsyncTaskRegistry.cancelTask(taskId)) {
          return notRunning(task.status);
        }
        return stopped("async_task", task.toolName);
      }

      // A sub-agent: the per-agent stop, owner-checked.
      const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
      const subAgent = await OrchestratorService.stopAgentForUser(taskId, context.username);
      if ("error" in subAgent) {
        return subAgent.error === "not_running" ? notRunning(subAgent.status) : notFound;
      }
      return stopped("subagent", "sub-agent");
    } catch (error: unknown) {
      return { success: false, error: `Could not stop ${taskId}: ${getErrorMessage(error)}` };
    }
  },
};

export default [monitor, taskStop];

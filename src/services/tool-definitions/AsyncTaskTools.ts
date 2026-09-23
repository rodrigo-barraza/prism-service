import logger from "#src/utils/logger";
import { DOMAINS, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  ASYNC_TASK_TOOL_NAMES,
  MAXIMUM_CONCURRENT_ASYNC_TASKS,
  WAIT_FOR_TASKS_DEFAULT_TIMEOUT_SECONDS,
  WAIT_FOR_TASKS_MAXIMUM_TIMEOUT_SECONDS,
} from "#src/services/AsyncTaskConstants";
import {
  ORCHESTRATOR,
  NOTIFICATION_SOURCES,
  AGENT_DIRECTIVES,
  SYSTEM_STATUSES,
  COLLECTIONS,
} from "#src/constants";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { resolveLoopKey } from "#src/services/LoopKey";
import type { InternalToolContext } from "./InternalToolRegistry.ts";
import PromptLocaleService from "#src/services/PromptLocaleService";

type AsyncTaskState = import("../AsyncTaskRegistry.ts").AsyncTaskState;
type SubAgentResult = import("#src/types/orchestrator").SubAgentResult;

/**
 * Fields the harness spreads into the tool context at runtime (see
 * ToolExecutor → ToolOrchestratorService.executeTool → InternalToolRegistry)
 * beyond the declared InternalToolContext: the loop's abort signal and the
 * client-facing conversation id.
 */
type RuntimeToolContext = InternalToolContext & {
  signal?: AbortSignal;
  requestId?: string;
};


// ────────────────────────────────────────────────────────────
// AsyncTaskTools — General-Purpose Non-Blocking Task Dispatch
// ────────────────────────────────────────────────────────────
// Four LLM-facing tools that allow any tool to run in the
// background, with status querying, cancellation and waiting.
//
// Mirrors Antigravity's manage_task pattern:
//   - run_async_task    → dispatch a tool to run non-blocking
//                         (`continueWorking` keeps the parent's turn alive)
//   - list_async_tasks  → list all tasks for this conversation
//   - cancel_async_task → abort a running task
//   - wait_for_tasks    → block on async tasks and/or sub-agents and
//                         return their results in place
//
// Completion delivery (see deliverTaskCompletion):
//   awaited by wait_for_tasks → the waiter returns it, nothing else fires
//   parent turn still open    → TurnInputMailbox (continueWorking / sub-agents)
//   parent turn ended         → auto-response wakes a new turn (root only)
// ────────────────────────────────────────────────────────────

// Tools that should NOT be dispatched asynchronously because they
// are inherently synchronous, interactive, or manage async state themselves
const DISALLOWED_ASYNC_TOOL_NAMES = new Set<string>([
  // Async task tools (prevent recursive dispatch)
  ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
  ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
  ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
  // Waiting inside an async task would block a background slot on
  // other background work — and the waiter would have no turn to
  // return the results into.
  ASYNC_TASK_TOOL_NAMES.WAIT_FOR_TASKS,

  // Orchestrator tools (already have their own non-blocking dispatch)
  TOOL_NAMES.CREATE_SUBAGENT,
  TOOL_NAMES.CREATE_SUBAGENTS,
  TOOL_NAMES.SEND_SUBAGENT_MESSAGE,
  TOOL_NAMES.STOP_SUBAGENT,
  TOOL_NAMES.GET_SUBAGENT_OUTPUT,
  TOOL_NAMES.DELETE_SUBAGENTS,
  TOOL_NAMES.RESUME_SUBAGENT,

  // Interactive tools that block on user input
  TOOL_NAMES.ASK_USER,
  TOOL_NAMES.ENTER_PLAN_MODE,
  TOOL_NAMES.EXIT_PLAN_MODE,

  // Timer tools (already async by nature)
  TOOL_NAMES.SET_TIMER,
  TOOL_NAMES.LIST_TIMERS,
  TOOL_NAMES.CANCEL_TIMER,

  // Tool management (instant, no benefit from async)
  TOOL_NAMES.ENABLE_TOOLS,
  TOOL_NAMES.DISABLE_TOOLS,
  TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS,
  TOOL_NAMES.SEARCH_TOOLS,
]);

// ── run_async_task ─────────────────────────────────────────
const runAsyncTask = {
  name: ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
  capabilities: ["subagent"] as const,
  emoji: INTERNAL_TOOL_EMOJIS[ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK],
  description:
    "Dispatch a tool to run asynchronously in the background. " +
    "Returns immediately with a task ID — the tool executes in the background while you continue other work. " +
    "Use this for long-running operations like shell commands, web scraping, file operations, or API calls " +
    "when you don't need to wait for the result before proceeding. " +
    "Query task status with list_async_tasks. Cancel with cancel_async_task. " +
    "You will be automatically notified when the task completes. " +
    "By default dispatching ends your turn and the completion wakes you in a new turn; " +
    "pass continueWorking=true to keep working on independent steps while it runs — " +
    "the completion then arrives as a <task-notification> message at your next step, " +
    "and wait_for_tasks blocks on it when you actually need the result.",
  parameters: {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description:
          "The name of the tool to execute asynchronously (e.g., 'execute_command', 'search_web', 'read_url').",
      },
      toolArguments: {
        type: "object",
        description:
          "The arguments to pass to the tool, exactly as you would pass them in a direct tool call.",
      },
      continueWorking: {
        type: "boolean",
        description:
          "When true, keep your turn going after dispatching: continue with steps that do not depend on the result. " +
          "The completion is delivered to you mid-turn (or as the next turn if this one has ended). " +
          "Default false: end your turn now and be woken when the task completes.",
      },
    },
    required: ["toolName", "toolArguments"],
  },
  display: {
    activeVerb: "Dispatching async task",
    completedVerb: "Dispatched async task",
    subjectParam: "toolName",
    subjectFormat: "quoted" as const,
  },
  labels: ["async", "background", "task"],
  domain: DOMAINS.CORE_HARNESS.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const toolName =
      typeof toolArguments.toolName === "string"
        ? toolArguments.toolName.trim()
        : undefined;
    const innerToolArguments =
      toolArguments.toolArguments &&
      typeof toolArguments.toolArguments === "object"
        ? (toolArguments.toolArguments as Record<string, unknown>)
        : {};

    const continueWorking = toolArguments.continueWorking === true;

    const agentConversationId = context.agentConversationId;

    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.run_async_task.noConversation",
        ),
      };
    }

    if (!toolName) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.run_async_task.noToolName",
        ),
      };
    }

    // Prevent recursive or nonsensical async dispatch
    if (DISALLOWED_ASYNC_TOOL_NAMES.has(toolName)) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.run_async_task.disallowedTool",
          { toolName },
        ),
      };
    }

    try {
      const { default: AsyncTaskRegistry } =
        await import("#src/services/AsyncTaskRegistry");
      const { default: ToolOrchestratorService } =
        await import("#src/services/ToolOrchestratorService");

      // Build the executor that runs the tool through ToolOrchestratorService
      const taskExecutor = async (
        dispatchedToolName: string,
        dispatchedToolArguments: Record<string, unknown>,
        abortSignal: AbortSignal,
      ): Promise<unknown> => {
        // Use the streaming variant for streamable tools, non-streaming for others
        if (ToolOrchestratorService.isStreamable(dispatchedToolName)) {
          return ToolOrchestratorService.executeToolStreaming(
            dispatchedToolName,
            dispatchedToolArguments,
            null, // No live chunk handler for background tasks
            {
              project: context.project || undefined,
              username: context.username || undefined,
              agentConversationId: context.agentConversationId || undefined,
              signal: abortSignal,
            },
          );
        }

        return ToolOrchestratorService.executeTool(
          dispatchedToolName,
          dispatchedToolArguments,
          {
            project: context.project || undefined,
            username: context.username || undefined,
            agentConversationId: context.agentConversationId || undefined,
            signal: abortSignal,
          },
        );
      };

      // Build the completion callback that delivers the result to the
      // parent — through the running turn's mailbox, or by waking a new
      // turn (same pattern as OrchestratorService._triggerParentAutoResponse).
      const completionCallback = buildCompletionCallback(context, { continueWorking });

      const dispatchResult = AsyncTaskRegistry.dispatch(
        toolName,
        innerToolArguments,
        {
          // The client-facing conversationId is the TurnInputMailbox key
          // (for a root turn it equals agentConversationId; for a sub-agent
          // it is the sub-agent's own id). Kept on the task so the
          // completion can find the turn without a database round-trip.
          conversationId: context.conversationId || null,
          agentConversationId,
          project: context.project || null,
          username: context.username || null,
        },
        taskExecutor,
        completionCallback,
      );

      // Check for concurrency limit error
      if ("error" in dispatchResult && typeof dispatchResult.error === "string") {
        return {
          error: PromptLocaleService.get(
            PromptLocaleService.getDefaultLocale(),
            "internal-tools-runtime.run_async_task.concurrencyLimit",
            { max: MAXIMUM_CONCURRENT_ASYNC_TASKS.toString() },
          ),
        };
      }

      const dispatchedTask = dispatchResult as AsyncTaskState;

      logger.info(
        `[AsyncTaskTools] Dispatched async task ${dispatchedTask.taskId}: tool="${toolName}"${continueWorking ? " (continueWorking)" : ""}`,
      );

      if (continueWorking) {
        // DETACHED_WORK: the harness keeps the loop going and only records
        // the flag; if the turn ends while this task is still running it
        // bumps pendingBackgroundTasks so the completion can wake a new turn.
        return {
          _directive: AGENT_DIRECTIVES.DETACHED_WORK,
          task: {
            taskId: dispatchedTask.taskId,
            toolName: dispatchedTask.toolName,
            status: dispatchedTask.status,
            startedAt: new Date(dispatchedTask.startedAt).toISOString(),
          },
          instruction:
            "The task is running in the background while you keep working. Continue with the steps that do not depend on its result. " +
            "Its completion arrives as a <task-notification> message at your next step — or as the next turn if this one has ended. " +
            "Call wait_for_tasks when you actually need the result; do not poll with list_async_tasks.",
        };
      }

      return {
        _directive: AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH,
        instruction:
          "An async task has been dispatched in the background. You will be automatically notified with a [ASYNC TASK COMPLETED] message when it finishes. " +
          "END YOUR TURN NOW — do not poll or loop. Simply inform the user that the task has been dispatched and you will report back when it completes.",
        task: {
          taskId: dispatchedTask.taskId,
          toolName: dispatchedTask.toolName,
          status: dispatchedTask.status,
          startedAt: new Date(dispatchedTask.startedAt).toISOString(),
        },
      };
    } catch (error: unknown) {
      return {
        error: `Failed to dispatch async task: ${getErrorMessage(error)}`,
      };
    }
  },
};

// ── list_async_tasks ───────────────────────────────────────
const listAsyncTasks = {
  name: ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS],
  description:
    "List all async background tasks dispatched in this conversation. " +
    "Shows task ID, tool name, status, duration, and results for completed tasks. " +
    "Use this to check on the progress of tasks dispatched with run_async_task.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  display: {
    activeVerb: "Listing async tasks",
    completedVerb: "Listed async tasks",
    subjectParam: "",
    subjectFormat: "truncate" as const,
  },
  labels: ["async", "background", "task"],
  domain: DOMAINS.CORE_HARNESS.displayName,

  async execute(
    _toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const agentConversationId = context.agentConversationId;

    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.list_async_tasks.noConversation",
        ),
      };
    }

    try {
      const { default: AsyncTaskRegistry } =
        await import("#src/services/AsyncTaskRegistry");
      const conversationTasks = AsyncTaskRegistry.listTasks(agentConversationId);

      return {
        success: true,
        tasks: conversationTasks.map((taskState) => ({
          taskId: taskState.taskId,
          toolName: taskState.toolName,
          status: taskState.status,
          startedAt: new Date(taskState.startedAt).toISOString(),
          ...(taskState.completedAt && {
            completedAt: new Date(taskState.completedAt).toISOString(),
          }),
          ...(taskState.durationMilliseconds !== null && {
            durationMilliseconds: taskState.durationMilliseconds,
          }),
          ...(taskState.status === "completed" && {
            result: taskState.result,
          }),
          ...(taskState.status === "failed" && {
            error: taskState.error,
          }),
        })),
        count: conversationTasks.length,
        running: conversationTasks.filter(
          (taskState) => taskState.status === "running",
        ).length,
      };
    } catch (error: unknown) {
      return {
        error: `Failed to list async tasks: ${getErrorMessage(error)}`,
      };
    }
  },
};

// ── cancel_async_task ──────────────────────────────────────
const cancelAsyncTask = {
  name: ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK],
  description:
    "Cancel a running async background task. " +
    "The task's abort signal will be triggered, stopping execution if the tool supports cancellation. " +
    "Use list_async_tasks to find the task ID.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The unique ID of the async task to cancel.",
      },
    },
    required: ["taskId"],
  },
  display: {
    activeVerb: "Cancelling async task",
    completedVerb: "Cancelled async task",
    subjectParam: "taskId",
    subjectFormat: "quoted" as const,
  },
  labels: ["async", "background", "task"],
  domain: DOMAINS.CORE_HARNESS.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    _context: InternalToolContext,
  ) {
    const taskId =
      typeof toolArguments.taskId === "string"
        ? toolArguments.taskId.trim()
        : undefined;

    if (!taskId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.cancel_async_task.noTaskId",
        ),
      };
    }

    try {
      const { default: AsyncTaskRegistry } =
        await import("#src/services/AsyncTaskRegistry");

      const wasCancelled = AsyncTaskRegistry.cancelTask(taskId);

      if (!wasCancelled) {
        const taskState = AsyncTaskRegistry.getTask(taskId);
        if (taskState) {
          return {
            success: false,
            message: PromptLocaleService.get(
              PromptLocaleService.getDefaultLocale(),
              "internal-tools-runtime.cancel_async_task.alreadyTerminal",
              { taskId, status: taskState.status },
            ),
          };
        }
        return {
          success: false,
          message: PromptLocaleService.get(
            PromptLocaleService.getDefaultLocale(),
            "internal-tools-runtime.cancel_async_task.notFound",
            { taskId },
          ),
        };
      }

      logger.info(`[AsyncTaskTools] Cancelled async task ${taskId}`);

      return {
        success: true,
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.cancel_async_task.success",
          { taskId },
        ),
      };
    } catch (error: unknown) {
      return {
        error: `Failed to cancel async task: ${getErrorMessage(error)}`,
      };
    }
  },
};

// ── wait_for_tasks ─────────────────────────────────────────
const waitForTasks = {
  name: ASYNC_TASK_TOOL_NAMES.WAIT_FOR_TASKS,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[ASYNC_TASK_TOOL_NAMES.WAIT_FOR_TASKS],
  description:
    "Block until background work finishes and return its results in place. " +
    "Waits on async tasks (from run_async_task) and/or sub-agents (from create_subagent / create_subagents). " +
    "With no ids it waits on every running async task and sub-agent of this conversation. " +
    "Returns each item's status and result (or error); items still running when the timeout elapses are listed in stillRunning. " +
    "Use this when you actually need a result to continue — do not poll with list_async_tasks.",
  parameters: {
    type: "object",
    properties: {
      taskIds: {
        type: "array",
        items: { type: "string" },
        description: "Async task ids to wait for (from run_async_task).",
      },
      agentIds: {
        type: "array",
        items: { type: "string" },
        description: "Sub-agent ids to wait for (from create_subagent / create_subagents).",
      },
      timeoutSeconds: {
        type: "number",
        description: `Maximum seconds to wait (default ${WAIT_FOR_TASKS_DEFAULT_TIMEOUT_SECONDS}, max ${WAIT_FOR_TASKS_MAXIMUM_TIMEOUT_SECONDS}). On timeout you get what has settled so far.`,
      },
    },
    required: [],
  },
  display: {
    activeVerb: "Waiting for background work",
    completedVerb: "Waited for background work",
    subjectParam: "",
    subjectFormat: "truncate" as const,
  },
  labels: ["async", "background", "task", "subagent"],
  domain: DOMAINS.CORE_HARNESS.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.wait_for_tasks.noConversation",
        ),
      };
    }

    const requestedTaskIds = toStringArray(toolArguments.taskIds);
    const requestedAgentIds = toStringArray(toolArguments.agentIds);
    const waitOnEverything = requestedTaskIds.length === 0 && requestedAgentIds.length === 0;

    const requestedTimeout =
      typeof toolArguments.timeoutSeconds === "number" && Number.isFinite(toolArguments.timeoutSeconds)
        ? toolArguments.timeoutSeconds
        : WAIT_FOR_TASKS_DEFAULT_TIMEOUT_SECONDS;
    const timeoutSeconds = Math.min(
      WAIT_FOR_TASKS_MAXIMUM_TIMEOUT_SECONDS,
      Math.max(0, requestedTimeout),
    );
    const timeoutMilliseconds = Math.round(timeoutSeconds * 1000);
    const signal = (context as RuntimeToolContext).signal;

    try {
      const { default: AsyncTaskRegistry } =
        await import("#src/services/AsyncTaskRegistry");

      const taskIds = waitOnEverything
        ? AsyncTaskRegistry.listTasks(agentConversationId)
            .filter((taskState) => taskState.status === SYSTEM_STATUSES.RUNNING)
            .map((taskState) => taskState.taskId)
        : requestedTaskIds;

      // Duplicate suppression: while we are blocked on a task, its completion
      // callback must not also post to the mailbox / wake a turn — we return
      // the result ourselves. Cleared below for anything still running when
      // the wait ends, so a later completion is delivered normally.
      for (const taskId of taskIds) {
        const taskState = AsyncTaskRegistry.getTask(taskId);
        if (taskState && taskState.status === SYSTEM_STATUSES.RUNNING) {
          taskState.awaitedBy = agentConversationId;
        }
      }

      const shouldWaitOnAgents = waitOnEverything || requestedAgentIds.length > 0;

      const [taskStates, agentEntries] = await Promise.all([
        AsyncTaskRegistry.waitForTasks(taskIds, { timeoutMilliseconds, signal }),
        shouldWaitOnAgents
          ? waitForSubAgents(requestedAgentIds, {
              timeoutMilliseconds,
              signal,
              parentAgentConversationId: agentConversationId,
            })
          : Promise.resolve([] as SubAgentWaitEntry[]),
      ]);

      const stillRunning: string[] = [];
      const entries: Array<Record<string, unknown>> = [];

      taskIds.forEach((taskId, index) => {
        const taskState = taskStates[index];
        if (!taskState) {
          entries.push({ taskId, kind: "async_task", status: "not_found" });
          return;
        }
        if (taskState.status === SYSTEM_STATUSES.RUNNING) {
          // Timed out / aborted while running: hand delivery back to the
          // completion callback.
          if (taskState.awaitedBy === agentConversationId) delete taskState.awaitedBy;
          stillRunning.push(taskId);
          entries.push({
            taskId,
            kind: "async_task",
            toolName: taskState.toolName,
            status: taskState.status,
            durationMilliseconds: Date.now() - taskState.startedAt,
          });
          return;
        }
        if (!taskState.deliveredVia) taskState.deliveredVia = "wait";
        entries.push({
          taskId,
          kind: "async_task",
          toolName: taskState.toolName,
          status: taskState.status,
          durationMilliseconds: taskState.durationMilliseconds ?? 0,
          ...(taskState.status === SYSTEM_STATUSES.COMPLETED
            ? { result: truncateForNotification(stringifyResult(taskState.result)) }
            : { error: taskState.error || `Task ${taskState.status}` }),
        });
      });

      for (const agentEntry of agentEntries) {
        if (!agentEntry.result) {
          entries.push({ agentId: agentEntry.agentId, kind: "subagent", status: "not_found" });
          continue;
        }
        if (agentEntry.running) stillRunning.push(agentEntry.agentId);
        const agentResult = agentEntry.result;
        entries.push({
          agentId: agentEntry.agentId,
          kind: "subagent",
          description: agentResult.description,
          status: agentResult.status,
          durationMilliseconds: agentResult.durationMilliseconds,
          toolUses: agentResult.toolUses,
          ...(agentEntry.running
            ? {}
            : agentResult.error
              ? { error: agentResult.error }
              : { result: truncateForNotification(stringifyResult(agentResult.result)) }),
          // Stopped at its turn cap: say so, and how to continue it.
          ...(!agentEntry.running && agentResult.partial && { partial: true, resume: agentResult.summary }),
        });
      }

      const aborted = signal?.aborted === true;
      const timedOut = stillRunning.length > 0 && !aborted;

      if (entries.length === 0) {
        return {
          tasks: [],
          timedOut: false,
          stillRunning: [],
          message: "Nothing to wait for — no running async tasks or sub-agents in this conversation.",
        };
      }

      logger.info(
        `[AsyncTaskTools] wait_for_tasks for ${agentConversationId}: ${entries.length} item(s), ${stillRunning.length} still running${timedOut ? " (timed out)" : ""}${aborted ? " (aborted)" : ""}`,
      );

      return {
        tasks: entries,
        timedOut,
        stillRunning,
        ...(aborted ? { aborted: true } : {}),
      };
    } catch (error: unknown) {
      return {
        error: `Failed to wait for tasks: ${getErrorMessage(error)}`,
      };
    }
  },
};

interface SubAgentWaitEntry {
  agentId: string;
  running: boolean;
  result: SubAgentResult | null;
}

/**
 * Wait on sub-agents through OrchestratorService. Loaded lazily — the
 * orchestrator imports the tool orchestrator, which registers this file.
 */
async function waitForSubAgents(
  agentIds: string[],
  options: { timeoutMilliseconds: number; signal?: AbortSignal; parentAgentConversationId: string },
): Promise<SubAgentWaitEntry[]> {
  try {
    const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
    return await OrchestratorService.waitForAgents(agentIds, options);
  } catch (error: unknown) {
    logger.warn(
      `[AsyncTaskTools] wait_for_tasks could not wait on sub-agents: ${getErrorMessage(error)}`,
    );
    return agentIds.map((agentId) => ({ agentId, running: false, result: null }));
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function truncateForNotification(text: string): string {
  return text.length > ORCHESTRATOR.ASYNC_TASK_RESULT_TRUNCATION_LIMIT
    ? text.slice(0, ORCHESTRATOR.ASYNC_TASK_RESULT_TRUNCATION_LIMIT) + "\n... (truncated)"
    : text;
}

// ── Completion Notification ────────────────────────────────
// One formatter for every delivery path (mailbox, auto-response), so the
// model sees the same <task-notification> block however it arrives.

export interface TaskCompletionNotification {
  content: string;
  notificationId: string;
  timestamp: string;
}

export function formatTaskCompletionNotification(
  taskState: AsyncTaskState,
): TaskCompletionNotification {
  const taskStatusEmoji = taskState.status === SYSTEM_STATUSES.COMPLETED ? "✅" : "❌";
  const resultSummary =
    taskState.status === SYSTEM_STATUSES.COMPLETED
      ? stringifyResult(taskState.result)
      : taskState.error || "Unknown error";

  const timestamp = new Date().toISOString();
  return {
    content: [
      `<task-notification>`,
      `<status>${taskStatusEmoji} ${taskState.status}</status>`,
      `<summary>[ASYNC TASK COMPLETED] Tool "${taskState.toolName}" (task ${taskState.taskId}) has ${taskState.status}.</summary>`,
      `<duration_ms>${taskState.durationMilliseconds || 0}</duration_ms>`,
      `<result>`,
      truncateForNotification(resultSummary),
      `</result>`,
      `</task-notification>`,
    ].join("\n"),
    notificationId: `${NOTIFICATION_SOURCES.ASYNC_TASK}:${taskState.taskId}:${timestamp}`,
    timestamp,
  };
}

// ── Completion Delivery ────────────────────────────────────
// When an async task settles, get its <task-notification> to the parent:
//   1. a wait_for_tasks call is blocked on it → the waiter returns it
//   2. the parent's turn is open → TurnInputMailbox (drained at the next
//      boundary) — for continueWorking dispatches and for sub-agents
//   3. otherwise → wake a new turn through handleAgent (root only;
//      sub-agents are the orchestrator's to wake, so their completion is
//      logged and dropped)

interface CompletionDeliveryOptions {
  continueWorking: boolean;
}

function buildCompletionCallback(
  context: InternalToolContext,
  options: CompletionDeliveryOptions = { continueWorking: false },
): ((taskState: AsyncTaskState) => void) | undefined {
  if (!context.agentConversationId) {
    return undefined;
  }

  return (taskState) => {
    // Fire as a detached promise — don't block the registry
    deliverTaskCompletion(taskState, context, options).catch(
      (deliveryError: Error) => {
        logger.warn(
          `[AsyncTaskTools] Completion delivery failed for task ${taskState.taskId}: ${getErrorMessage(deliveryError)}`,
        );
      },
    );
  };
}

/** Whether this agentConversationId belongs to a live sub-agent. */
async function isSubAgentConversation(
  context: InternalToolContext,
  agentConversationId: string | null,
): Promise<boolean> {
  if (context.isSubAgent === true) return true;
  if (context.isSubAgent === false || !agentConversationId) return false;
  // The harness does not forward `isSubAgent` into the tool context; ask
  // the orchestrator, which owns every live sub-agent.
  try {
    const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
    return OrchestratorService.isSubAgentConversation(agentConversationId);
  } catch {
    return false;
  }
}

export async function deliverTaskCompletion(
  taskState: AsyncTaskState,
  context: InternalToolContext,
  { continueWorking }: CompletionDeliveryOptions,
): Promise<void> {
  // 1. A wait_for_tasks call owns this result.
  if (taskState.awaitedBy) {
    taskState.deliveredVia = "wait";
    logger.info(
      `[AsyncTaskTools] Task ${taskState.taskId} is awaited by ${taskState.awaitedBy} — delivery left to the waiter`,
    );
    await payBackCountedPending(taskState);
    return;
  }

  const isSubAgent = await isSubAgentConversation(context, taskState.agentConversationId);

  // 2. The parent's turn is still open → hand it in through the mailbox.
  //    Only for continueWorking dispatches and sub-agents: a default
  //    (NON_BLOCKING_DISPATCH) root dispatch has already broken its loop,
  //    and a post there would sit in a mailbox nobody drains again.
  if (continueWorking || isSubAgent) {
    const mailboxKey = resolveLoopKey({
      conversationId: taskState.conversationId || context.conversationId,
      agentConversationId: taskState.agentConversationId,
    });
    if (mailboxKey && TurnInputMailbox.isOpen(mailboxKey)) {
      const notification = formatTaskCompletionNotification(taskState);
      const posted = TurnInputMailbox.post(mailboxKey, {
        kind: "task_completion",
        text: notification.content,
        meta: {
          _notificationSource: NOTIFICATION_SOURCES.ASYNC_TASK,
          _notificationId: notification.notificationId,
          taskId: taskState.taskId,
        },
      });
      if (posted.accepted) {
        // pendingBackgroundTasks: the harness bumps the counter only for
        // detached work STILL running when its turn ends, and marks those
        // tasks `countedAsPending`. A task that completes while the
        // dispatching turn is still open carries no mark → nothing to pay
        // back. A task dispatched in turn N that completes during a LATER
        // open turn carries the mark → pay the +1 back here.
        //
        // Residual window, documented rather than closed: the harness
        // drains right before finalize; a post that lands between that
        // drain and TurnInputMailbox.close is returned by close() and
        // dropped (microseconds — the loop has already decided to end).
        // `deliveredVia` records the intent for a later audit.
        taskState.deliveredVia = "mailbox";
        await payBackCountedPending(taskState);
        logger.info(
          `[AsyncTaskTools] Task ${taskState.taskId} delivered to the running turn ${mailboxKey} (${posted.id})`,
        );
        return;
      }
      logger.warn(
        `[AsyncTaskTools] Mailbox for ${mailboxKey} refused task ${taskState.taskId} (${posted.reason}) — falling back`,
      );
    }
  }

  // 3. Sub-agents never wake a turn on their own.
  if (isSubAgent) {
    logger.info(
      `[AsyncTaskTools] Task ${taskState.taskId} completed for sub-agent ${taskState.agentConversationId} after its turn ended — dropped (the orchestrator owns sub-agent wake-ups)`,
    );
    return;
  }

  // 4. Root conversation, turn already ended → wake a new turn.
  taskState.deliveredVia = "auto_response";
  await triggerAsyncTaskAutoResponse(taskState, context);
}

async function triggerAsyncTaskAutoResponse(
  taskState: AsyncTaskState,
  context: InternalToolContext,
): Promise<void> {
  // Lazy imports to avoid circular dependencies
  const { default: WebSocketConnectionRegistry } =
    await import("#src/websocket/WebSocketConnectionRegistry");
  const ConversationServiceModule = await import("#src/services/ConversationService");
  const ConversationService = ConversationServiceModule.default;
  const MongoWrapper = (await import("#src/wrappers/MongoWrapper")).default;
  const { MONGO_DB_NAME: databaseName } = await import("../../../config.ts");
  const { handleAgent } = await import("#src/routes/ChatRoutes");
  const collectionNames = COLLECTIONS;

  // Find the parent conversation that dispatched this task.
  // The agentConversationId on the task points to the agentic loop session,
  // but we need the client-facing conversationId for persistence and emit lookup.
  const database = MongoWrapper.getDb(databaseName);
  if (!database) {
    logger.warn(
      `[AsyncTaskTools] Cannot trigger auto-response for task ${taskState.taskId}: database not connected`,
    );
    return;
  }

  const conversationCollection = MongoWrapper.getCollection(
    databaseName,
    collectionNames.AGENT_CONVERSATIONS,
  );
  if (!conversationCollection) return;

  // Look up the conversation by agentConversationId
  const conversation = await conversationCollection.findOne({
    agentConversationId: taskState.agentConversationId,
    ...(context.project && { project: context.project }),
    ...(context.username && { username: context.username }),
  });

  if (!conversation) {
    logger.warn(
      `[AsyncTaskTools] Cannot trigger auto-response for task ${taskState.taskId}: conversation not found for session ${taskState.agentConversationId}`,
    );
    return;
  }

  const conversationId = conversation.id as string;
  const project = (conversation.project || context.project) as string;
  const username = (conversation.username || context.username) as string;

  // Wait if the conversation is currently generating
  const { AUTO_RESPONSE_GENERATION_WAIT_MAXIMUM_RETRIES, AUTO_RESPONSE_GENERATION_WAIT_DELAY_MILLISECONDS } = ORCHESTRATOR;

  if (conversation.isGenerating) {
    logger.info(
      `[AsyncTaskTools] Conversation ${conversationId} is generating — waiting before auto-response for task ${taskState.taskId}`,
    );

    let conversationBecameIdle = false;
    for (let waitAttempt = 0; waitAttempt < AUTO_RESPONSE_GENERATION_WAIT_MAXIMUM_RETRIES; waitAttempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, AUTO_RESPONSE_GENERATION_WAIT_DELAY_MILLISECONDS),
      );

      const refreshedConversation = await conversationCollection.findOne({
        id: conversationId,
        project,
        username,
      });

      if (!refreshedConversation) return;

      if (!refreshedConversation.isGenerating) {
        conversationBecameIdle = true;
        break;
      }
    }

    if (!conversationBecameIdle) {
      logger.warn(
        `[AsyncTaskTools] Conversation ${conversationId} never became idle — skipping auto-response for task ${taskState.taskId}`,
      );
      return;
    }
  }

  // Build the completion notification message
  const notification = formatTaskCompletionNotification(taskState);
  const completionMessage = {
    role: "user" as const,
    content: notification.content,
    timestamp: notification.timestamp,
    _alreadyPersisted: true,
    _notificationSource: NOTIFICATION_SOURCES.ASYNC_TASK,
    _notificationId: notification.notificationId,
  };

  // Persist the completion message
  await ConversationService.appendMessages(
    conversationId,
    project,
    username,
    [completionMessage],
    null,
    { collection: collectionNames.AGENT_CONVERSATIONS },
  );

  // Reload the conversation from DB (source of truth) to get the freshest
  // message array, including any messages added concurrently.
  const updatedConversation = await conversationCollection.findOne({
    id: conversationId,
    project,
    username,
  });

  if (!updatedConversation) return;

  // Reconstruct transient _alreadyPersisted flag: every message loaded
  // from MongoDB is by definition already persisted. Without this, the
  // Finalizer re-persists the completion message (it's the last message
  // in the array, so AgenticLoopService's [0..n-2] marking skips it).
  const freshMessages = (updatedConversation.messages || []) as Array<Record<string, unknown>>;
  for (const message of freshMessages) {
    message._alreadyPersisted = true;
  }

  // Resolve emit from WebSocketConnectionRegistry
  const registeredEmit = WebSocketConnectionRegistry.getEmitFunction(conversationId);
  const autoResponseEmit = registeredEmit || ((event: {
    type: string;
    [key: string]: unknown;
  }) => {
    logger.debug(
      `[AsyncTaskTools][AutoResponse][${conversationId}][Event] type=${event.type}`,
    );
  });

  if (registeredEmit) {
    logger.info(
      `[AsyncTaskTools] Auto-response will stream to live WebSocket for task ${taskState.taskId}`,
    );
  }

  // Resolve provider/model from conversation settings
  const settings = (updatedConversation.settings || {}) as Record<string, unknown>;
  const providerName = settings.provider as string;
  const resolvedModel = settings.model as string;
  const agent = settings.agent as string | null;
  const workspaceRoot = settings.workspaceRoot as string | null;

  if (!providerName || !resolvedModel) {
    logger.warn(
      `[AsyncTaskTools] Cannot trigger auto-response for task ${taskState.taskId}: missing provider/model in conversation settings`,
    );
    return;
  }

  logger.info(
    `[AsyncTaskTools] Triggering auto-response for task ${taskState.taskId} in conversation ${conversationId}`,
  );

  try {
    await handleAgent(
      {
        provider: providerName,
        model: resolvedModel,
        messages: freshMessages,
        conversationId,
        agent,
        project,
        username,
        clientIp: "async-task-auto-response",
        agenticLoopEnabled: true,
        functionCallingEnabled: true,
        autoApprove: true,
        planFirst: false,
        minContextLength: 120_000,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(typeof settings.toolConfig === "object" &&
        settings.toolConfig !== null
          ? {
              disabledTools: (settings.toolConfig as Record<string, unknown>)
                .disabledTools as string[] | undefined,
            }
          : {}),
      },
      autoResponseEmit as unknown as (event: import("../../types/SseTypes.ts").SseEvent) => void,
    );

    logger.success(
      `[AsyncTaskTools] Auto-response completed for task ${taskState.taskId} in conversation ${conversationId}`,
    );
  } catch (autoResponseError: unknown) {
    logger.error(
      `[AsyncTaskTools] Auto-response error for task ${taskState.taskId}: ${getErrorMessage(autoResponseError)}`,
    );
  } finally {
    // The turn that dispatched this task ended with it still running, so
    // the harness bumped pendingBackgroundTasks (+1) to keep the
    // conversation "active" until the completion woke a new turn. That
    // turn has now run (or failed) — pay the counter back, mirroring
    // OrchestratorService._triggerParentAutoResponse.
    const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
    AsyncTaskRegistry.clearCountedAsPending(taskState.agentConversationId);
    await decrementPendingBackgroundTasks(conversationId, project, username, taskState.taskId);
  }
}

/**
 * A completion consumed by the mailbox or a waiter pays back the per-turn
 * +1 the harness recorded when the dispatching turn ended with this task
 * still running. Once per turn: the flag is cleared on every sibling.
 */
async function payBackCountedPending(taskState: AsyncTaskState): Promise<void> {
  if (!taskState.countedAsPending) return;
  const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
  AsyncTaskRegistry.clearCountedAsPending(taskState.agentConversationId);
  const conversationId = taskState.conversationId || taskState.agentConversationId;
  if (!conversationId || !taskState.project || !taskState.username) return;
  await decrementPendingBackgroundTasks(conversationId, taskState.project, taskState.username, taskState.taskId);
}

async function decrementPendingBackgroundTasks(
  conversationId: string,
  project: string,
  username: string,
  taskId: string,
): Promise<void> {
  try {
    const { default: ConversationService } =
      await import("#src/services/conversation/ConversationService");
    await ConversationService.adjustPendingBackgroundTasks(
      conversationId,
      project,
      username,
      -1,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );
    logger.info(
      `[AsyncTaskTools] Decremented pendingBackgroundTasks on conversation ${conversationId} for task ${taskId}`,
    );

    // Patch the client's in-memory conversation entry — it only refreshes
    // the counter on a list fetch otherwise.
    try {
      const { default: WebSocketConnectionRegistry } =
        await import("#src/websocket/WebSocketConnectionRegistry");
      const emitFunction = WebSocketConnectionRegistry.getEmitFunction(conversationId);
      if (emitFunction) {
        const MongoWrapper = (await import("#src/wrappers/MongoWrapper")).default;
        const { MONGO_DB_NAME: databaseName } = await import("../../../config.ts");
        const { SERVER_SENT_EVENT_TYPES } =
          await import("@rodrigo-barraza/utilities-library/taxonomy");
        const freshConversation = await MongoWrapper.getDb(databaseName)
          ?.collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .findOne(
            { id: conversationId, project, username },
            { projection: { pendingBackgroundTasks: 1, isActive: 1 } },
          );
        emitFunction({
          type: SERVER_SENT_EVENT_TYPES.CONVERSATION_STATE_UPDATE,
          pendingBackgroundTasks: (freshConversation?.pendingBackgroundTasks as number) ?? 0,
          isActive: freshConversation?.isActive ?? false,
        });
      }
    } catch (emitError: unknown) {
      logger.debug(
        `[AsyncTaskTools] Failed to emit conversation_state_update: ${getErrorMessage(emitError)}`,
      );
    }
  } catch (clearError: unknown) {
    logger.warn(
      `[AsyncTaskTools] Failed to decrement pendingBackgroundTasks on ${conversationId}: ${getErrorMessage(clearError)}`,
    );
  }
}

export default [runAsyncTask, listAsyncTasks, cancelAsyncTask, waitForTasks];

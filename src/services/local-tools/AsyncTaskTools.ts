import logger from "#src/utils/logger";
import { DOMAINS, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { getErrorMessage } from "#src/utils/ErrorHelpers";
import { ASYNC_TASK_TOOL_NAMES, MAXIMUM_CONCURRENT_ASYNC_TASKS } from "#src/services/AsyncTaskConstants";
import { ORCHESTRATOR, NOTIFICATION_SOURCES } from "#src/constants";
import type { InternalToolContext } from "./InternalToolRegistry.ts";
import PromptLocaleService from "#src/services/PromptLocaleService";


// ────────────────────────────────────────────────────────────
// AsyncTaskTools — General-Purpose Non-Blocking Task Dispatch
// ────────────────────────────────────────────────────────────
// Three LLM-facing tools that allow any tool to run in the
// background, with status querying and cancellation support.
//
// Mirrors Antigravity's manage_task pattern:
//   - run_async_task   → dispatch a tool to run non-blocking
//   - list_async_tasks → list all tasks for this conversation
//   - cancel_async_task → abort a running task
// ────────────────────────────────────────────────────────────

// Tools that should NOT be dispatched asynchronously because they
// are inherently synchronous, interactive, or manage async state themselves
const DISALLOWED_ASYNC_TOOL_NAMES = new Set<string>([
  // Async task tools (prevent recursive dispatch)
  ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
  ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
  ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,

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
  schema: {
    name: ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
    emoji: INTERNAL_TOOL_EMOJIS[ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK],
    description:
      "Dispatch a tool to run asynchronously in the background. " +
      "Returns immediately with a task ID — the tool executes in the background while you continue other work. " +
      "Use this for long-running operations like shell commands, web scraping, file operations, or API calls " +
      "when you don't need to wait for the result before proceeding. " +
      "Query task status with list_async_tasks. Cancel with cancel_async_task. " +
      "You will be automatically notified when the task completes.",
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
      },
      required: ["toolName", "toolArguments"],
    },
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

      // Build an optional auto-response callback that notifies the parent
      // conversation when the task completes — follows the same pattern as
      // OrchestratorService._triggerParentAutoResponse
      const completionCallback = buildCompletionCallback(context);

      const dispatchResult = AsyncTaskRegistry.dispatch(
        toolName,
        innerToolArguments,
        {
          conversationId: null, // Async tasks don't need the client-facing conversationId
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

      const dispatchedTask = dispatchResult as import("../AsyncTaskRegistry.ts").AsyncTaskState;

      logger.info(
        `[AsyncTaskTools] Dispatched async task ${dispatchedTask.taskId}: tool="${toolName}"`,
      );

      return {
        _directive: "NON_BLOCKING_DISPATCH",
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
  schema: {
    name: ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
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
  schema: {
    name: ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
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

// ── Auto-Response Completion Callback ──────────────────────
// When an async task completes, build a <task-notification> message
// and trigger the parent auto-response pipeline so the LLM wakes up
// and processes the result — same pattern as sub-agent completion.

function buildCompletionCallback(
  context: InternalToolContext,
): ((taskState: import("../AsyncTaskRegistry.ts").AsyncTaskState) => void) | undefined {
  // Only fire auto-response for non-sub-agent sessions that have
  // a conversation context (sub-agents are managed by the orchestrator)
  if (context.isSubAgent || !context.agentConversationId) {
    return undefined;
  }

  return (taskState) => {
    // Fire as a detached promise — don't block the registry
    triggerAsyncTaskAutoResponse(taskState, context).catch(
      (autoResponseError: Error) => {
        logger.warn(
          `[AsyncTaskTools] Auto-response failed for task ${taskState.taskId}: ${getErrorMessage(autoResponseError)}`,
        );
      },
    );
  };
}

async function triggerAsyncTaskAutoResponse(
  taskState: import("../AsyncTaskRegistry.ts").AsyncTaskState,
  context: InternalToolContext,
): Promise<void> {
  // Lazy imports to avoid circular dependencies
  const { default: WebSocketConnectionRegistry } =
    await import("#src/websocket/WebSocketConnectionRegistry");
  const ConversationServiceModule = await import("#src/services/ConversationService");
  const ConversationService = ConversationServiceModule.default;
  const MongoWrapper = (await import("#src/wrappers/MongoWrapper")).default;
  const { MONGO_DB_NAME: databaseName } = await import("../../../config.js");
  const { COLLECTIONS: collectionNames } = await import("#src/constants");
  const { handleAgent } = await import("#src/routes/ChatRoutes");

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
  const taskStatusEmoji = taskState.status === "completed" ? "✅" : "❌";
  const resultSummary =
    taskState.status === "completed"
      ? typeof taskState.result === "string"
        ? taskState.result
        : JSON.stringify(taskState.result)
      : taskState.error || "Unknown error";

  const truncatedResult =
    resultSummary.length > ORCHESTRATOR.ASYNC_TASK_RESULT_TRUNCATION_LIMIT
      ? resultSummary.slice(0, ORCHESTRATOR.ASYNC_TASK_RESULT_TRUNCATION_LIMIT) + "\n... (truncated)"
      : resultSummary;

  const notificationTimestamp = new Date().toISOString();
  const completionMessage = {
    role: "user" as const,
    content: [
      `<task-notification>`,
      `<status>${taskStatusEmoji} ${taskState.status}</status>`,
      `<summary>[ASYNC TASK COMPLETED] Tool "${taskState.toolName}" (task ${taskState.taskId}) has ${taskState.status}.</summary>`,
      `<duration_ms>${taskState.durationMilliseconds || 0}</duration_ms>`,
      `<result>`,
      truncatedResult,
      `</result>`,
      `</task-notification>`,
    ].join("\n"),
    timestamp: notificationTimestamp,
    _alreadyPersisted: true,
    _notificationSource: NOTIFICATION_SOURCES.ASYNC_TASK,
    _notificationId: `async-task:${taskState.taskId}:${notificationTimestamp}`,
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
              enabledTools: (settings.toolConfig as Record<string, unknown>)
                .enabledTools as string[] | undefined,
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
  }
}

export default [runAsyncTask, listAsyncTasks, cancelAsyncTask];

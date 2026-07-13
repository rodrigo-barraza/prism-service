import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import ToolContext from "#src/services/ToolContext";
import logger from "#src/utils/logger";
import {
  SERVER_SENT_EVENT_TYPES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { HARNESS } from "#src/constants";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type AgentHooks from "#src/services/AgentHooks";
import type {
  ToolCall,
  ToolResult,
  AgenticContext,
  ResolvedTools,
} from "#src/services/harnesses/types";

/**
 * ToolExecutor — parallel and single tool execution extracted from
 * ReActHarness. Handles custom tools, streaming tools,
 * and standard tools-api dispatch.
 *
 * Reusable by any harness implementation.
 */

/**
 * Tools exempt from the default per-tool timeout: they legitimately block on
 * user input, timers, or long-running sub-agent trees that enforce their own
 * iteration/depth/budget bounds.
 */
const TOOL_TIMEOUT_EXEMPT = new Set<string>([
  TOOL_NAMES.ASK_USER,
  TOOL_NAMES.SLEEP,
  TOOL_NAMES.CREATE_SUBAGENT,
  TOOL_NAMES.CREATE_SUBAGENTS,
  TOOL_NAMES.SEND_SUBAGENT_MESSAGE,
  TOOL_NAMES.RESUME_SUBAGENT,
  TOOL_NAMES.GET_SUBAGENT_OUTPUT,
]);

/** Resolve the per-tool timeout for a call. 0 disables the timeout. */
function resolveToolTimeout(
  toolName: string,
  context: AgenticContext,
): number {
  if (TOOL_TIMEOUT_EXEMPT.has(toolName)) return 0;
  const configured = context.options?.toolTimeoutMilliseconds;
  if (typeof configured === "number") return Math.max(0, configured);
  return HARNESS.DEFAULT_TOOL_TIMEOUT_MILLISECONDS;
}

/**
 * Race a tool execution against a wall-clock timeout. On timeout the
 * turn continues with a structured error result instead of hanging forever;
 * the combined abort signal gives cooperating tools a chance to cancel the
 * underlying work.
 */
async function runWithTimeout<T>(
  execute: () => Promise<T>,
  timeoutMilliseconds: number,
  toolName: string,
): Promise<T | { error: string; message: string }> {
  if (!timeoutMilliseconds) return execute();

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      execute(),
      new Promise<{ error: string; message: string }>((resolve) => {
        timeoutId = setTimeout(() => {
          logger.warn(
            `[ToolExecutor] Tool "${toolName}" timed out after ${timeoutMilliseconds}ms`,
          );
          resolve({
            error: "TOOL_TIMEOUT",
            message: `Tool "${toolName}" exceeded the ${Math.round(timeoutMilliseconds / 1000)}s execution timeout and was abandoned. Its side effects may have partially completed.`,
          });
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Combine the loop's abort signal with the per-tool timeout signal. */
function buildToolSignal(
  context: AgenticContext,
  timeoutMilliseconds: number,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (context.signal) signals.push(context.signal);
  if (timeoutMilliseconds) signals.push(AbortSignal.timeout(timeoutMilliseconds));
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** Execute a batch of tool calls in parallel. */
export async function executeToolBatch(
  toolCalls: ToolCall[],
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: AgentHooks,
  state: AgenticLoopState,
): Promise<ToolResult[]> {
  const {
    project,
    username,
    agent,
    agentConversationId,
    conversationId,
    traceId,
    providerName,
    resolvedModel,
    workspaceRoot,
    emit,
  } = context;

  const resolvedAgentConversationId = agentConversationId || "";

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      // Malformed tool-call JSON (flagged by the provider) — never execute
      // with silently-empty args. Return a synthetic error telling the model
      // its own JSON was broken so it can re-emit the call.
      if (toolCall._argsParseError) {
        return {
          name: toolCall.name,
          id: toolCall.id,
          result: {
            success: false,
            error: "MALFORMED_TOOL_CALL_JSON",
            message:
              `The JSON arguments for your "${toolCall.name}" call could not be parsed ` +
              `(likely truncated or invalid). Re-emit the tool call with complete, valid JSON arguments.` +
              (toolCall._rawArgs
                ? `\nUnparseable argument text (excerpt): ${toolCall._rawArgs}`
                : ""),
          },
        };
      }

      // Honor decide-hook verdicts (CriticGate, AutoApprovalEngine, custom
      // guardrails). AgentHooks.run short-circuits internally on a deny, but
      // the block only holds if the caller acts on the returned result —
      // discarding it here made every `decide` hook a silent no-op.
      const hookResult = await hooks.run("beforeToolCall", toolCall, context);
      if (hookResult && hookResult.isApproved === false) {
        const blockReason =
          typeof hookResult.reason === "string"
            ? hookResult.reason
            : "denied by safety hook";
        logger.warn(
          `[ToolExecutor] Tool "${toolCall.name}" blocked before execution: ${blockReason}`,
        );
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: `Tool "${toolCall.name}" blocked: ${blockReason}`,
        });
        return {
          name: toolCall.name,
          id: toolCall.id,
          result: {
            success: false,
            error: "BLOCKED_BY_SAFETY_HOOK",
            message: `Tool execution was blocked before running: ${blockReason}`,
          },
        };
      }

      const timeoutMilliseconds = resolveToolTimeout(toolCall.name, context);
      const toolSignal = buildToolSignal(context, timeoutMilliseconds);

      if (ToolOrchestratorService.isStreamable(toolCall.name)) {
        const startTime = Date.now();
        const result = await runWithTimeout(
          () =>
            ToolOrchestratorService.executeToolStreaming(
              toolCall.name,
              toolCall.args as Record<string, unknown>,
              (
                event: string,
                data: string | null,
                meta?: Record<string, unknown>,
              ) => {
                emit({
                  type: SERVER_SENT_EVENT_TYPES.TOOL_OUTPUT,
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  event,
                  data: data || undefined,
                  meta: meta || undefined,
                });
              },
              {
                project,
                username,
                agent,
                requestId: context.requestId,
                agentConversationId: resolvedAgentConversationId,
                conversationId,
                iteration: state.iterations,
                workspaceRoot,
                signal: toolSignal,
                _toolState: ToolContext.getStore(resolvedAgentConversationId),
                _workspaceEnabled: context.options?.workspaceEnabled as boolean | undefined,
              },
            ),
          timeoutMilliseconds,
          toolCall.name,
        );
        const durationMilliseconds = Date.now() - startTime;
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result, durationMilliseconds };
      }

      const startTime = Date.now();
      const result = await runWithTimeout(
        () =>
          ToolOrchestratorService.executeTool(
            toolCall.name,
            toolCall.args as Record<string, unknown>,
            {
              messages: context._currentMessages || context.messages,
              project,
              username,
              agent: agent || null,
              traceId: traceId || null,
              agentConversationId: resolvedAgentConversationId,
              conversationId,
              clientIp: context.clientIp || null,
              requestId: context.requestId,
              iteration: state.iterations,
              signal: toolSignal,
              _providerName: providerName,
              _resolvedModel: resolvedModel,
              _emit: emit,
              _maxSubAgentIterations: context.options?.maxSubAgentIterations,
              _minContextLength: context.options?.minContextLength,
              workspaceRoot,
              _toolState: ToolContext.getStore(resolvedAgentConversationId),
              enabledTools: tools.finalTools.map((toolSchema) => toolSchema.name),
              _topology:
                typeof context.options?.topology === "string"
                  ? context.options.topology
                  : undefined,
              _recursionDepth:
                typeof context._recursionDepth === "number"
                  ? context._recursionDepth
                  : undefined,
              _maxRecursionDepth:
                typeof context._maxRecursionDepth === "number"
                  ? context._maxRecursionDepth
                  : typeof context.options?.maxRecursionDepth === "number"
                    ? context.options.maxRecursionDepth
                    : undefined,
              _thinkingEnabled: context.options?.thinkingEnabled,
              _reasoningEffort: context.options?.reasoningEffort,
              _thinkingBudget: context.options?.thinkingBudget,
              _workspaceEnabled: context.options?.workspaceEnabled as boolean | undefined,
              // Approval + budget propagation for sub-agent spawning tools.
              // Sub-agents must inherit the parent's approval mode, policies,
              // critic settings, and cost budget — a hardcoded autoApprove in
              // the spawn path let delegated work bypass every safety gate.
              _autoApprove: context.options?.autoApprove === true,
              _policies: context.options?.policies,
              _enableCriticGate: context.options?.enableCriticGate,
              _criticModel: context.options?.criticModel,
              _maxCostDollars: context.options?.maxCostDollars,
              _sharedCostBudget: context.options?._sharedCostBudget,
            },
          ),
        timeoutMilliseconds,
        toolCall.name,
      );
      const durationMilliseconds = Date.now() - startTime;
      await hooks.run("afterToolCall", toolCall, result, context);
      return { name: toolCall.name, id: toolCall.id, result, durationMilliseconds };
    }),
  );

  return results;
}

/** Execute a single tool call (for one-at-a-time execution). */
export async function executeToolSingle(
  toolCall: ToolCall,
  context: AgenticContext,
  tools: ResolvedTools,
  hooks: AgentHooks,
  state: AgenticLoopState,
): Promise<ToolResult> {
  const [result] = await executeToolBatch(
    [toolCall],
    context,
    tools,
    hooks,
    state,
  );
  return result;
}

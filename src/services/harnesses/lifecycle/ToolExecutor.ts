import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import ToolContext from "../../ToolContext.ts";
import { SSE_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type AgentHooks from "../../AgentHooks.ts";
import type {
  ToolCall,
  ToolResult,
  AgenticContext,
  ResolvedTools,
} from "../types.ts";

/**
 * ToolExecutor — parallel and single tool execution extracted from
 * ReActHarness. Handles custom tools, streaming tools,
 * and standard tools-api dispatch.
 *
 * Reusable by any harness implementation.
 */

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
    agentSessionId,
    conversationId,
    traceId,
    providerName,
    resolvedModel,
    workspaceRoot,
    emit,
  } = context;

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      await hooks.run("beforeToolCall", toolCall, context);

      const customDefinition = tools.customToolMap.get(toolCall.name);
      if (customDefinition) {
        const startTime = Date.now();
        const result = await ToolOrchestratorService.executeCustomTool(
          customDefinition,
          toolCall.args as Record<string, unknown>,
        );
        const durationMs = Date.now() - startTime;
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result, durationMs };
      }

      if (ToolOrchestratorService.isStreamable(toolCall.name)) {
        const startTime = Date.now();
        const result = await ToolOrchestratorService.executeToolStreaming(
          toolCall.name,
          toolCall.args as Record<string, unknown>,
          (event: string, data: string | null, meta?: Record<string, unknown>) => {
            emit({
              type: SSE_EVENT_TYPES.TOOL_OUTPUT,
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
            agentSessionId,
            conversationId,
            iteration: state.iterations,
            workspaceRoot,
            _toolState: ToolContext.getStore(agentSessionId),
          },
        );
        const durationMs = Date.now() - startTime;
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result, durationMs };
      }

      const startTime = Date.now();
      const result = await ToolOrchestratorService.executeTool(
        toolCall.name,
        toolCall.args as Record<string, unknown>,
        {
          messages: context._currentMessages || context.messages,
          project,
          username,
          agent: agent || null,
          traceId: traceId || null,
          agentSessionId,
          conversationId,
          clientIp: context.clientIp || null,
          requestId: context.requestId,
          agenticIteration: state.iterations,
          iteration: state.iterations,
          _providerName: providerName,
          _resolvedModel: resolvedModel,
          _emit: emit,
          _maxSubAgentIterations: context.options?.maxSubAgentIterations,
          _minContextLength: context.options?.minContextLength,
          workspaceRoot,
          _toolState: ToolContext.getStore(agentSessionId),
          enabledTools: tools.finalTools.map((toolSchema) => toolSchema.name),
          _topology: context.options?.topology,
        },
      );
      const durationMs = Date.now() - startTime;
      await hooks.run("afterToolCall", toolCall, result, context);
      return { name: toolCall.name, id: toolCall.id, result, durationMs };
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

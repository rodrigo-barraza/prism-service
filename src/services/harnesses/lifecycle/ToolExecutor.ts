import ToolOrchestratorService from "../../ToolOrchestratorService.ts";

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
    traceId,
    providerName,
    resolvedModel,
    workspaceRoot,
    emit,
  } = context;

  const results = await Promise.all(
    toolCalls.map(async (toolCall) => {
      // @ts-ignore - TODO: strict typing
      await hooks.run("beforeToolCall", toolCall, context);

      const customDefinition = tools.customToolMap.get(toolCall.name);
      if (customDefinition) {
        const result = await ToolOrchestratorService.executeCustomTool(
          customDefinition,
          toolCall.args,
        );
        // @ts-ignore - TODO: strict typing
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result };
      }

      // @ts-ignore - TODO: strict typing
      if (ToolOrchestratorService.isStreamable(toolCall.name)) {
        const result = await ToolOrchestratorService.executeToolStreaming(
          toolCall.name,
          toolCall.args,
          // @ts-ignore - TODO: strict typing
          (event: string, data: unknown, meta: unknown) => {
            emit({
              type: "tool_output",
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
            iteration: state.iterations,
            workspaceRoot,
          },
        );
        // @ts-ignore - TODO: strict typing
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result };
      }

      const result = await ToolOrchestratorService.executeTool(
        toolCall.name,
        toolCall.args,
        {
          messages: context._currentMessages || context.messages,
          project,
          username,
          agent: agent || null,
          traceId: traceId || null,
          agentSessionId,
          clientIp: context.clientIp || null,
          requestId: context.requestId,
          agenticIteration: state.iterations,
          iteration: state.iterations,
          _providerName: providerName,
          _resolvedModel: resolvedModel,
          _emit: emit,
          _maxWorkerIterations: context.options?.maxWorkerIterations,
          _minContextLength: context.options?.minContextLength,
          workspaceRoot,
        },
      );
      // @ts-ignore - TODO: strict typing
      await hooks.run("afterToolCall", toolCall, result, context);
      return { name: toolCall.name, id: toolCall.id, result };
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

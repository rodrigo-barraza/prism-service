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
    toolCalls.map(async (toolCall: any) => {
            await hooks.run(("beforeToolCall" as any), (toolCall as any), context);

      const customDefinition = tools.customToolMap.get((toolCall as any).name);
      if (customDefinition) {
        const result = await ToolOrchestratorService.executeCustomTool(
          customDefinition,
          (toolCall as any).args,
        );
                await hooks.run(("afterToolCall" as any), (toolCall as any), result, context);
        return { name: (toolCall as any).name, id: (toolCall as any).id, result };
      }

            if (ToolOrchestratorService.isStreamable((toolCall as any).name)) {
        const result = await ToolOrchestratorService.executeToolStreaming(
          (toolCall as any).name,
          (toolCall as any).args,
                    (event: string, data: any, meta: any) => {
            emit({
              type: "tool_output",
              toolCallId: (toolCall as any).id,
              name: (toolCall as any).name,
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
                await hooks.run(("afterToolCall" as any), (toolCall as any), result, context);
        return { name: (toolCall as any).name, id: (toolCall as any).id, result };
      }

      const result = await ToolOrchestratorService.executeTool(
        (toolCall as any).name,
        (toolCall as any).args,
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
            await hooks.run(("afterToolCall" as any), (toolCall as any), result, context);
      return { name: (toolCall as any).name, id: (toolCall as any).id, result };
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

import logger from "../../../utils/logger.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { ToolCall, ToolResult, PassState, EmitFn } from "../types.ts";

/**
 * PostExecutionEmitter — status notifications emitted after tool execution.
 *
 * Checks tool calls for specific side-effect patterns (tasks, workers,
 * memories, custom tools) and emits appropriate status events to the
 * frontend so the UI can refresh relevant panels.
 *
 * Extracted from ReActHarness to be reusable across harnesses.
 */

/** Emit status notifications based on which tools were executed. */
export function emitPostExecutionStatus(
  toolCalls: ToolCall[],
  emit: EmitFn,
): void {
  if (toolCalls.some((toolCall) => toolCall.name.startsWith("task_"))) {
    emit({ type: "status", message: "tasks_updated" });
  }

  if (
    toolCalls.some(
      (toolCall) => toolCall.name === "team_create" || toolCall.name === "stop_agent",
    )
  ) {
    emit({ type: "status", message: "workers_updated" });
  }

  if (toolCalls.some((toolCall) => toolCall.name === "upsert_memory")) {
    emit({ type: "status", message: "memories_updated" });
  }
}

/** Process tool results for image/screenshot side-effects. */
export function processToolResultMedia(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  pass: PassState,
  emit: EmitFn,
): void {
  for (const toolCall of toolCalls) {
    const res = results.find(
      (r) => r.id === toolCall.id || (!r.id && r.name === toolCall.name),
    );
    const resultObj = res?.result as Record<string, unknown> | null;
    const hasError = !!resultObj?.error;

    emit({
      type: "tool_execution",
      tool: {
        name: toolCall.name,
        args: toolCall.args || {},
        id: toolCall.id,
        responsesItemId: toolCall.responsesItemId,
        result: resultObj,
      },
      status: hasError ? "error" : "done",
    });

    if (resultObj?.screenshotRef) {
      state.streamedImages.push(resultObj.screenshotRef as string);
      pass.streamedImages.push(resultObj.screenshotRef as string);
    }

    const imageResult = resultObj?.image as Record<string, string> | undefined;
    if (imageResult?.data) {
      const toolImgRef =
        imageResult.minioRef || `data:${imageResult.mimeType};base64,${imageResult.data}`;
      state.streamedImages.push(toolImgRef);
      pass.streamedImages.push(toolImgRef);
      emit({
        type: "image",
        data: imageResult.data,
        mimeType: imageResult.mimeType,
        minioRef: imageResult.minioRef,
      });
      if (resultObj) delete resultObj.image;
    }
  }
}

/** Track consecutive tool errors and log/emit when a tool hits the limit. */
export function trackToolErrors(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  maxConsecutiveErrors: number,
  emit: EmitFn,
): void {
  for (const toolCall of toolCalls) {
    const res = results.find(
      (r) => r.id === toolCall.id || (!r.id && r.name === toolCall.name),
    );
    const hasError = !!(res?.result as Record<string, unknown>)?.error;

    if (hasError) {
      const count = (state.toolErrorCounts.get(toolCall.name) || 0) + 1;
      state.toolErrorCounts.set(toolCall.name, count);
      if (count >= maxConsecutiveErrors) {
        logger.warn(
          `[AgenticLoop] Tool "${toolCall.name}" hit error limit (${count}), skipping in future iterations`,
        );
        emit({
          type: "status",
          message: `Tool "${toolCall.name}" failed ${count} times consecutively — skipping`,
        });
      }
    } else {
      state.toolErrorCounts.delete(toolCall.name);
    }
  }
}

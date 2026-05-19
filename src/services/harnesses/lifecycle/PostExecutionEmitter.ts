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
  if (toolCalls.some((tc) => tc.name.startsWith("task_"))) {
    emit({ type: "status", message: "tasks_updated" });
  }

  if (
    toolCalls.some(
      (tc) => tc.name === "team_create" || tc.name === "stop_agent",
    )
  ) {
    emit({ type: "status", message: "workers_updated" });
  }

  if (toolCalls.some((tc) => tc.name === "upsert_memory")) {
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
  for (const tc of toolCalls) {
    const res = results.find(
      (r) => r.id === tc.id || (!r.id && r.name === tc.name),
    );
    const resultObj = res?.result as Record<string, any> | null;
    const hasError = !!resultObj?.error;

    emit({
      type: "tool_execution",
      tool: {
        name: tc.name,
        args: tc.args || {},
        id: tc.id,
        responsesItemId: tc.responsesItemId,
        result: resultObj,
      },
      status: hasError ? "error" : "done",
    });

    if (resultObj?.screenshotRef) {
      state.streamedImages.push(resultObj.screenshotRef);
      pass.streamedImages.push(resultObj.screenshotRef);
    }

    if (resultObj?.image?.data) {
      const image = resultObj.image;
      const toolImgRef =
        image.minioRef || `data:${image.mimeType};base64,${image.data}`;
      state.streamedImages.push(toolImgRef);
      pass.streamedImages.push(toolImgRef);
      emit({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
        minioRef: image.minioRef,
      });
      delete resultObj.image;
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
  for (const tc of toolCalls) {
    const res = results.find(
      (r) => r.id === tc.id || (!r.id && r.name === tc.name),
    );
    const hasError = !!(res?.result as Record<string, any>)?.error;

    if (hasError) {
      const count = (state.toolErrorCounts.get(tc.name) || 0) + 1;
      state.toolErrorCounts.set(tc.name, count);
      if (count >= maxConsecutiveErrors) {
        logger.warn(
          `[AgenticLoop] Tool "${tc.name}" hit error limit (${count}), skipping in future iterations`,
        );
        emit({
          type: "status",
          message: `Tool "${tc.name}" failed ${count} times consecutively — skipping`,
        });
      }
    } else {
      state.toolErrorCounts.delete(tc.name);
    }
  }
}

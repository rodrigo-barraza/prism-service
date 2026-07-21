import logger from "#src/utils/logger";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ToolCall,
  ToolResult,
  PassState,
  EmitFunction,
  AgenticContext,
} from "#src/services/harnesses/types";
import FileService from "#src/services/FileService";
import WebhookEventBus from "#src/services/WebhookEventBus";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { FILE_CATEGORIES } from "#src/constants";

interface ToolResultPayload {
  error?: string;
  screenshotRef?: string;
  audioRef?: string;
  audio?: { data: string; mimeType?: string };
  image?: { data: string; mimeType?: string; minioRef?: string };
  display?: ToolResultDisplay;
  [key: string]: unknown;
}

/**
 * Self-describing display metadata on visual tool results. Tools-service
 * emits this for embed/image/video/audio tools; for tools whose media is
 * produced as raw base64 (generate_image, TTS/audio tools, browser
 * screenshots) it is stamped here after the MinIO upload, so every visual
 * result reaches the client with a uniform `display` the UI can render
 * without per-tool knowledge.
 */
interface ToolResultDisplay {
  kind: "embed" | "image" | "video" | "audio";
  url: string;
  height?: number;
  title?: string;
  /** Poster image shown before a video plays (video only). */
  poster?: string;
}

/**
 * PostExecutionEmitter — status notifications emitted after tool execution.
 *
 * Checks tool calls for specific side-effect patterns (tasks, sub-agents,
 * memories, custom tools) and emits appropriate status events to the
 * frontend so the UI can refresh relevant panels.
 *
 * Extracted from ReActHarness to be reusable across harnesses.
 */

/** Emit status notifications based on which tools were executed. */
export function emitPostExecutionStatus(
  toolCalls: ToolCall[],
  emit: EmitFunction,
): void {
  if (toolCalls.some((toolCall) => toolCall.name.includes("_task"))) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.TASKS_UPDATED,
    });
  }

  if (
    toolCalls.some(
      (toolCall) =>
        toolCall.name === TOOL_NAMES.CREATE_SUBAGENT ||
        toolCall.name === TOOL_NAMES.CREATE_SUBAGENTS ||
        toolCall.name === TOOL_NAMES.STOP_SUBAGENT,
    )
  ) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
    });
  }

  if (toolCalls.some((toolCall) => toolCall.name === TOOL_NAMES.SAVE_MEMORY)) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.MEMORIES_UPDATED,
    });
  }
}

/** Process tool results for image/screenshot side-effects. */
export async function processToolResultMedia(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  pass: PassState,
  emit: EmitFunction,
  context?: AgenticContext,
): Promise<void> {
  for (const toolCall of toolCalls) {
    const toolResult = results.find(
      (result) =>
        result.id === toolCall.id ||
        (!result.id && result.name === toolCall.name),
    );
    const resultObject = toolResult?.result as ToolResultPayload | null;
    const hasError = !!resultObject?.error;

    // Check if result has raw audio data, upload it if so
    const audioResult = resultObject?.audio;
    if (resultObject && audioResult?.data) {
      const mimeType = audioResult.mimeType || "audio/wav";
      // Tools-service already hosts audio it produced and stamps
      // display{kind:"audio",url}. Reuse that URL as the canonical
      // audioRef instead of re-uploading a second copy — audioRef,
      // display.url, the streamed audio event, and the message.audio
      // refs prepareDisplayMessages extracts must all share ONE URL
      // space or the client's media dedup can't match them.
      const hostedDisplayUrl =
        resultObject.display?.kind === "audio" &&
        typeof resultObject.display.url === "string" &&
        resultObject.display.url
          ? resultObject.display.url
          : null;
      if (hostedDisplayUrl) {
        resultObject.audioRef = hostedDisplayUrl;
        delete resultObject.audio;
        emit({
          type: SERVER_SENT_EVENT_TYPES.AUDIO,
          data: hostedDisplayUrl,
          mimeType,
        });
      } else {
        const dataUrl = `data:${mimeType};base64,${audioResult.data}`;
        try {
          const uploadResult = await FileService.uploadFile(
            dataUrl,
            FILE_CATEGORIES.GENERATIONS,
          );
          // The model reads this result and reuses audioRef as a handle in
          // later tool calls (e.g. generate_audio sampleSource), so it must
          // be a fetchable public URL — never the internal minio:// ref.
          const publicAudioUrl =
            FileService.getPublicUrl(uploadResult.ref) ?? uploadResult.ref;
          resultObject.audioRef = publicAudioUrl;
          delete resultObject.audio;
          // Stamp display so audio results render an inline player via
          // the generic display path (same convention as image/embed).
          resultObject.display ??= {
            kind: "audio",
            url: publicAudioUrl,
            title: "Audio",
          };
          emit({
            type: SERVER_SENT_EVENT_TYPES.AUDIO,
            data: publicAudioUrl,
            mimeType,
            minioRef: uploadResult.ref,
          });
        } catch (uploadError) {
          logger.error(
            `[PostExecutionEmitter] Failed to upload audio:`,
            uploadError,
          );
        }
      }
    }

    // Promote raw image payloads to refs + display BEFORE emitting the
    // tool_execution event, so the event carries `display` instead of base64.
    if (resultObject?.screenshotRef) {
      resultObject.display ??= {
        kind: "image",
        url: resultObject.screenshotRef,
        title: "Screenshot",
      };
      state.streamedImages.push(resultObject.screenshotRef);
      pass.streamedImages.push(resultObject.screenshotRef);
    }

    const imageResult = resultObject?.image;
    if (resultObject && imageResult?.data) {
      // Upload raw image payloads that arrived without a ref (e.g. MCP
      // image content blocks) so the display URL and the stored result
      // stay lightweight — generate_image is uploaded upstream in
      // ToolOrchestratorService and already carries minioRef.
      if (!imageResult.minioRef) {
        try {
          const uploadResult = await FileService.uploadFile(
            `data:${imageResult.mimeType || "image/png"};base64,${imageResult.data}`,
            FILE_CATEGORIES.GENERATIONS,
          );
          imageResult.minioRef = uploadResult.ref;
        } catch (uploadError) {
          logger.error(
            `[PostExecutionEmitter] Failed to upload image:`,
            uploadError,
          );
        }
      }
      const toolImgRef =
        imageResult.minioRef ||
        `data:${imageResult.mimeType};base64,${imageResult.data}`;
      state.streamedImages.push(toolImgRef);
      pass.streamedImages.push(toolImgRef);
      resultObject.display = {
        kind: "image",
        url: toolImgRef,
        title: "Generated Image",
      };
      emit({
        type: SERVER_SENT_EVENT_TYPES.IMAGE,
        data: imageResult.data,
        mimeType: imageResult.mimeType,
        minioRef: imageResult.minioRef,
      });
      delete resultObject.image;
    }

    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
      tool: {
        name: toolCall.name,
        args: toolCall.args || {},
        id: toolCall.id,
        responsesItemId: toolCall.responsesItemId,
        result: resultObject,
        durationMilliseconds: toolResult?.durationMilliseconds,
        durationMs: toolResult?.durationMilliseconds,
      },
      toolEmoji: ToolOrchestratorService.getToolEmoji(toolCall.name),
      toolLabel: ToolOrchestratorService.getToolLabel(
        toolCall.name,
        toolCall.args || {},
        false,
      ),
      status: hasError ? "error" : "done",
    });

    WebhookEventBus.emit("request.tool_call.completed", {
      requestId: context?.requestId || null,
      toolName: toolCall.name,
      toolEmoji: ToolOrchestratorService.getToolEmoji(toolCall.name),
      toolCallId: toolCall.id,
      toolResult: resultObject,
      durationMilliseconds: toolResult?.durationMilliseconds || null,
      status: hasError ? "error" : "done",
      agent: context?.agent || null,
      conversationId: context?.conversationId || null,
      agentConversationId: context?.agentConversationId || null,
      project: context?.project || null,
      username: context?.username || null,
      provider: context?.providerName || null,
      model: context?.resolvedModel || null,
    });
  }
}

/** Track consecutive tool errors and log/emit when a tool hits the limit. */
export function trackToolErrors(
  toolCalls: ToolCall[],
  results: ToolResult[],
  state: AgenticLoopState,
  maxConsecutiveErrors: number,
  emit: EmitFunction,
): void {
  for (const toolCall of toolCalls) {
    const toolResult = results.find(
      (result) =>
        result.id === toolCall.id ||
        (!result.id && result.name === toolCall.name),
    );
    const hasError = !!(toolResult?.result as ToolResultPayload)?.error;

    if (hasError) {
      const count = (state.toolErrorCounts.get(toolCall.name) || 0) + 1;
      state.toolErrorCounts.set(toolCall.name, count);
      if (count >= maxConsecutiveErrors) {
        logger.warn(
          `[AgenticLoop] Tool "${toolCall.name}" hit error limit (${count}), skipping in future iterations`,
        );
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: `Tool "${toolCall.name}" failed ${count} times consecutively — skipping`,
        });
      }
    } else {
      state.toolErrorCounts.delete(toolCall.name);
    }
  }
}

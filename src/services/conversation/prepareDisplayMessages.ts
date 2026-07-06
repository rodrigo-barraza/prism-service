import type { ChatMessage } from "../../types/admin.ts";
import type { ToolCallPayload } from "./types.ts";

/**
 * Server-side display message serializer.
 *
 * Transforms the canonical persisted message array (assistant + separate
 * tool-role messages) into a display-ready array by:
 *
 * 1. Collecting tool results from role:"tool" messages keyed by tool_call_id
 * 2. Merging those results back into the assistant's toolCalls
 * 3. Extracting audio references from tool results into the message audio field
 * 4. Filtering out tool-role messages and empty assistant stubs
 * 5. Preserving soft-deleted messages with their `deleted` flag
 *
 * The output is consumed directly by the frontend without further processing.
 */
export function prepareDisplayMessages(
  rawMessages: ChatMessage[],
): ChatMessage[] {
  if (!rawMessages || rawMessages.length === 0) return [];

  // Pass 1: collect tool results and durations keyed by tool_call_id
  const toolResults: Record<string, string> = {};
  const toolDurations: Record<string, number> = {};

  for (const message of rawMessages) {
    if (message.role === "tool" && message.tool_call_id) {
      toolResults[message.tool_call_id] = (message.content as string) || "";
      const persistedDuration = (
        message as unknown as Record<string, unknown>
      ).durationMilliseconds as number | undefined;
      if (persistedDuration != null) {
        toolDurations[message.tool_call_id] = persistedDuration;
      }
    }
  }

  const hasToolResults = Object.keys(toolResults).length > 0;
  const hasToolDurations = Object.keys(toolDurations).length > 0;

  // Pass 2: filter and enrich
  const displayMessages: ChatMessage[] = [];

  for (const message of rawMessages) {
    // Remove tool-role messages — their content is merged into toolCalls
    if (message.role === "tool") continue;

    // Filter empty assistant stubs (no content, no tools, no media, no errors)
    if (
      message.role === "assistant" &&
      !message.content?.toString().trim() &&
      !message.toolCalls?.length &&
      !message.images?.length &&
      !message.audio &&
      !(message as Record<string, unknown>).error &&
      !message.thinking
    ) {
      continue;
    }

    // Enrich assistant tool calls with results and durations
    let enrichedToolCalls = message.toolCalls;
    const hasToolCallDurations =
      message.toolCalls?.some(
        (toolCall) =>
          (toolCall as unknown as Record<string, unknown>)
            .durationMilliseconds != null,
      ) ?? false;
    if (
      message.toolCalls &&
      message.toolCalls.length > 0 &&
      (hasToolResults || hasToolDurations || hasToolCallDurations)
    ) {
      enrichedToolCalls = message.toolCalls.map((toolCall) => {
        const toolCallId = toolCall.id || "";
        const resolvedDurationMilliseconds =
          toolDurations[toolCallId] ??
          (toolCall as unknown as Record<string, unknown>).durationMilliseconds as
            | number
            | undefined;
        return {
          ...toolCall,
          result: toolCall.result || toolResults[toolCallId] || null,
          ...(resolvedDurationMilliseconds != null && {
            durationMilliseconds: resolvedDurationMilliseconds,
            durationMs: resolvedDurationMilliseconds,
          }),
        };
      });
    }

    // Extract audio references from tool call results
    let updatedAudio = message.audio;
    if (enrichedToolCalls && enrichedToolCalls.length > 0) {
      const audioSources: string[] = [];
      for (const toolCall of enrichedToolCalls) {
        if (!toolCall.result) continue;

        let parsedResult: Record<string, unknown> | null = null;
        if (typeof toolCall.result === "object" && toolCall.result !== null) {
          parsedResult = toolCall.result as Record<string, unknown>;
        } else if (typeof toolCall.result === "string") {
          try {
            parsedResult = JSON.parse(toolCall.result) as Record<
              string,
              unknown
            >;
          } catch {
            // Non-JSON result string — skip audio extraction
          }
        }

        if (parsedResult) {
          if (typeof parsedResult.audioRef === "string") {
            audioSources.push(parsedResult.audioRef);
          } else if (
            parsedResult.audio &&
            typeof parsedResult.audio === "object"
          ) {
            const audioData = parsedResult.audio as {
              data?: string;
              mimeType?: string;
            };
            if (audioData.data) {
              const mimeType = audioData.mimeType || "audio/wav";
              audioSources.push(
                `data:${mimeType};base64,${audioData.data}`,
              );
            }
          }
        }
      }

      if (audioSources.length > 0) {
        const existingAudio = Array.isArray(message.audio)
          ? message.audio
          : message.audio
            ? [message.audio]
            : [];
        const mergedAudio = [...existingAudio];
        for (const audioSource of audioSources) {
          if (!mergedAudio.includes(audioSource)) {
            mergedAudio.push(audioSource);
          }
        }
        if (mergedAudio.length > 0) {
          updatedAudio = mergedAudio;
        }
      }
    }

    // Build the display message — only clone if we modified something
    if (
      enrichedToolCalls !== message.toolCalls ||
      updatedAudio !== message.audio
    ) {
      displayMessages.push({
        ...message,
        toolCalls: enrichedToolCalls as ToolCallPayload[],
        audio: updatedAudio,
      });
    } else {
      displayMessages.push(message);
    }
  }

  return displayMessages;
}

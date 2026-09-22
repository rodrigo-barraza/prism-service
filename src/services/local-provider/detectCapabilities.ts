import { MODALITY_TYPES } from "#src/config";
import { type SglangReportedCapabilities } from "./types.ts";
import {
  THINKING_PATTERNS,
  FUNCTION_CALL_PATTERNS,
  VISION_PATTERNS,
  VIDEO_PATTERNS,
  AUDIO_PATTERNS,
} from "./constants.ts";

/** Check if a lowercased model name matches any pattern in a list. */
export function matchesAny(
  nameLower: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => nameLower.includes(pattern));
}

export function detectCapabilities(
  modelKey: string | null | undefined,
  providerMeta: { capabilities?: Record<string, unknown> } = {},
) {
  const nameLower = (modelKey || "").toLowerCase();
  const capabilities = providerMeta.capabilities || {};

  // Thinking / reasoning
  const hasReasoningCapability = !!capabilities.reasoning;
  const supportsThinking =
    hasReasoningCapability || matchesAny(nameLower, THINKING_PATTERNS);

  // Function calling / tool use
  const supportsFunctionCalling =
    !!capabilities.trained_for_tool_use ||
    matchesAny(nameLower, FUNCTION_CALL_PATTERNS);

  // Vision (images)
  const supportsVision =
    !!capabilities.vision || matchesAny(nameLower, VISION_PATTERNS);

  // Video
  const supportsVideo = matchesAny(nameLower, VIDEO_PATTERNS);

  // Audio
  const supportsAudio = matchesAny(nameLower, AUDIO_PATTERNS);

  // Build tools list
  const tools: string[] = [];
  if (supportsThinking) tools.push("Thinking");
  if (supportsFunctionCalling) tools.push("Tool Calling");

  // Build input types
  const inputTypes = [MODALITY_TYPES.TEXT];
  if (supportsVision) inputTypes.push(MODALITY_TYPES.IMAGE);
  if (supportsVideo) inputTypes.push(MODALITY_TYPES.VIDEO);
  if (supportsAudio) inputTypes.push(MODALITY_TYPES.AUDIO);

  return {
    thinking: supportsThinking,
    functionCalling: supportsFunctionCalling,
    vision: supportsVision,
    video: supportsVideo,
    audio: supportsAudio,
    tools,
    inputTypes,
    outputTypes: [MODALITY_TYPES.TEXT],
  };
}

/**
 * Ollama variant: the server reports what each model's template supports on
 * /api/show ("tools", "thinking", "vision", …). When it does, that list is
 * authoritative — a name match must not label "Tool Calling" on a model
 * whose template has none (Ollama answers tools with 400 "does not support
 * tools"), nor withhold it from one that has them. An older server reports
 * nothing and the name patterns stay the fallback. Video and audio are not
 * reported by Ollama and still come from the name.
 */
export function detectOllamaCapabilities(
  modelKey: string | null | undefined,
  reportedCapabilities: readonly string[] | null | undefined,
) {
  const detected = detectCapabilities(modelKey);
  if (!Array.isArray(reportedCapabilities) || reportedCapabilities.length === 0) {
    return detected;
  }
  const reports = (capability: string) =>
    reportedCapabilities.includes(capability);

  const tools: string[] = [];
  if (reports("thinking")) tools.push("Thinking");
  if (reports("tools")) tools.push("Tool Calling");

  const inputTypes = [MODALITY_TYPES.TEXT];
  if (reports("vision")) inputTypes.push(MODALITY_TYPES.IMAGE);
  if (detected.video) inputTypes.push(MODALITY_TYPES.VIDEO);
  if (detected.audio) inputTypes.push(MODALITY_TYPES.AUDIO);

  return {
    ...detected,
    thinking: reports("thinking"),
    functionCalling: reports("tools"),
    vision: reports("vision"),
    tools,
    inputTypes,
  };
}

/**
 * SGLang variant: tool calls exist only when the server was launched with a
 * --tool-call-parser (without one SGLang returns them as plain text), so the
 * server's report decides "Tool Calling", not the model's name. A configured
 * --reasoning-parser adds "Thinking"; its absence proves nothing, because an
 * unparsed model still emits <think> tags inline. /model_info decides image
 * and audio input, and video follows image. Anything the server did not
 * report stays with the name patterns.
 */
export function detectSglangCapabilities(
  modelKey: string | null | undefined,
  reported: SglangReportedCapabilities | null | undefined,
) {
  const detected = detectCapabilities(modelKey);
  if (!reported) return detected;

  const functionCalling =
    reported.toolCallParser === undefined
      ? detected.functionCalling
      : !!reported.toolCallParser;
  const thinking = !!reported.reasoningParser || detected.thinking;
  const vision = reported.imageUnderstanding ?? detected.vision;
  const video = vision && detected.video;
  const audio = reported.audioUnderstanding ?? detected.audio;

  const tools: string[] = [];
  if (thinking) tools.push("Thinking");
  if (functionCalling) tools.push("Tool Calling");

  const inputTypes = [MODALITY_TYPES.TEXT];
  if (vision) inputTypes.push(MODALITY_TYPES.IMAGE);
  if (video) inputTypes.push(MODALITY_TYPES.VIDEO);
  if (audio) inputTypes.push(MODALITY_TYPES.AUDIO);

  return {
    ...detected,
    thinking,
    functionCalling,
    vision,
    video,
    audio,
    tools,
    inputTypes,
  };
}

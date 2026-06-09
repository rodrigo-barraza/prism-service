import SettingsService from "../services/SettingsService.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

/**
 * Resolves tool names that should be excluded from the system prompt
 * and tool count because their prerequisite settings models are not configured.
 *
 * This is the server-side equivalent of the client's `lockedOffTools` useMemo
 * in ChatSessionComponent, ensuring both the system prompt "Enabled Tools (N)"
 * count and the sidebar tool count agree.
 *
 * Checks: memory models, image/vision models, TTS/STT models.
 * Does NOT check workspace availability — that's a dynamic runtime concern.
 */
export async function resolveLockedOffToolNames(): Promise<Set<string>> {
  const lockedOff = new Set<string>();

  const memorySettings = await SettingsService.getSection("memory");
  const creativeSettings = await SettingsService.getSection("creative");

  const hasExtraction = Boolean(memorySettings?.extractionProvider && memorySettings?.extractionModel);
  const hasConsolidation = Boolean(memorySettings?.consolidationProvider && memorySettings?.consolidationModel);
  const hasEmbedding = Boolean(memorySettings?.embeddingProvider && memorySettings?.embeddingModel);
  const hasAllMemoryModels = hasExtraction && hasConsolidation && hasEmbedding;

  if (!hasAllMemoryModels) lockedOff.add(TOOL_NAMES.UPSERT_MEMORY);
  if (!hasExtraction) lockedOff.add(TOOL_NAMES.EXTRACT_MEMORIES);
  if (!hasConsolidation) lockedOff.add(TOOL_NAMES.CONSOLIDATE_MEMORIES);
  if (!hasEmbedding) lockedOff.add(TOOL_NAMES.SEARCH_MEMORIES);

  const hasImageModel = Boolean(creativeSettings?.imageProvider && creativeSettings?.imageModel);
  const hasVisionModel = Boolean(creativeSettings?.visionProvider && creativeSettings?.visionModel);
  const hasTextToSpeech = Boolean(creativeSettings?.textToSpeechProvider && creativeSettings?.textToSpeechModel);
  const hasSpeechToText = Boolean(creativeSettings?.speechToTextProvider && creativeSettings?.speechToTextModel);

  if (!hasImageModel) lockedOff.add(TOOL_NAMES.GENERATE_IMAGE);
  if (!hasVisionModel) lockedOff.add(TOOL_NAMES.DESCRIBE_IMAGE);
  if (!hasTextToSpeech) lockedOff.add(TOOL_NAMES.SYNTHESIZE_SPEECH);
  if (!hasSpeechToText) lockedOff.add(TOOL_NAMES.TRANSCRIBE_AUDIO);

  return lockedOff;
}

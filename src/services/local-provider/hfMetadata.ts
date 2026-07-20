import { formatBytes } from "@rodrigo-barraza/utilities-library";
import { MODALITY_TYPES } from "#src/config";
import { type HuggingFaceMetadata, type ModelEntry } from "./types.ts";
import { formatParams } from "./nameParsers.ts";
import { LOCAL_PROVIDER } from "#src/constants";

const _hfCache = new Map<
  string,
  { data: HuggingFaceMetadata | null; timestamp: number }
>();
const HUGGING_FACE_CACHE_TIME_TO_LIVE_MILLISECONDS = LOCAL_PROVIDER.HUGGING_FACE_CACHE_TIME_TO_LIVE_MILLISECONDS;

/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
export async function fetchHuggingFaceMetadata(
  modelId: string,
): Promise<HuggingFaceMetadata | null> {
  const cached = _hfCache.get(modelId);
  if (cached && Date.now() - cached.timestamp < HUGGING_FACE_CACHE_TIME_TO_LIVE_MILLISECONDS) {
    return cached.data;
  }

  try {
    const response = await fetch(
      `https://huggingface.co/api/models/${modelId}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      _hfCache.set(modelId, { data: null, timestamp: Date.now() });
      return null;
    }
    const data = (await response.json()) as Record<string, unknown>;
    const config = (data.config as Record<string, unknown>) || {};
    const safetensors = (data.safetensors as Record<string, unknown>) || {};
    const meta: HuggingFaceMetadata = {
      architectures: (config.architectures as string[]) || [],
      modelType: (config.model_type as string) || null,
      pipelineTag: (data.pipeline_tag as string) || null,
      tags: (data.tags as string[]) || [],
      author: (data.author as string) || null,
      totalParams: (safetensors.total as number) || null,
      totalSize: (data.usedStorage as number) || null,
      paramsByDtype: (safetensors.parameters as Record<string, number>) || null,
    };
    _hfCache.set(modelId, { data: meta, timestamp: Date.now() });
    return meta;
  } catch {
    _hfCache.set(modelId, { data: null, timestamp: Date.now() });
    return null;
  }
}

/**
 * Enrich a model entry with HuggingFace metadata if the model ID
 * looks like a HF model path (has a slash: "org/model-name").
 */
export async function enrichWithHuggingFace(
  entry: ModelEntry,
  modelKey: string,
): Promise<ModelEntry> {
  if (!modelKey.includes("/")) return entry;

  const huggingFaceMeta = await fetchHuggingFaceMetadata(modelKey).catch(
    () => null,
  );
  if (!huggingFaceMeta) return entry;

  // Vision/video/audio override from HF tags
  if (
    huggingFaceMeta.pipelineTag === "image-text-to-text" ||
    huggingFaceMeta.tags.includes("multimodal") ||
    huggingFaceMeta.tags.includes("vision")
  ) {
    entry.vision = true;
    if (!entry.inputTypes.includes(MODALITY_TYPES.IMAGE)) {
      entry.inputTypes.push(MODALITY_TYPES.IMAGE);
    }
  }
  if (
    huggingFaceMeta.pipelineTag === "video-text-to-text" ||
    huggingFaceMeta.tags.includes("video")
  ) {
    if (!entry.inputTypes.includes(MODALITY_TYPES.VIDEO)) {
      entry.inputTypes.push(MODALITY_TYPES.VIDEO);
    }
  }
  if (
    huggingFaceMeta.pipelineTag === "audio-text-to-text" ||
    huggingFaceMeta.tags.includes("audio")
  ) {
    if (!entry.inputTypes.includes(MODALITY_TYPES.AUDIO)) {
      entry.inputTypes.push(MODALITY_TYPES.AUDIO);
    }
  }

  // Metadata overrides
  if (huggingFaceMeta.totalParams)
    entry.params = formatParams(huggingFaceMeta.totalParams) || undefined;
  if (huggingFaceMeta.totalSize)
    entry.size = formatBytes(huggingFaceMeta.totalSize);
  if (huggingFaceMeta.architectures?.length > 0)
    entry.architecture = huggingFaceMeta.architectures[0];
  if (huggingFaceMeta.author) entry.publisher = huggingFaceMeta.author;

  return entry;
}

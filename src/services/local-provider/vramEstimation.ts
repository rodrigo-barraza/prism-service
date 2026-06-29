import { resolveArchParams, estimateMemory } from "../../utils/gguf-arch.ts";
import { getProvider } from "../../providers/index.ts";
import { LmStudioRawModel, GenericProvider, TransformedVramEstimate } from "./types.ts";
import { LOCAL_PROVIDER } from "../../constants.ts";

/**
 * Estimate VRAM usage for a GGUF model served by a local provider.
 * Primarily useful for LM Studio models that report GGUF metadata.
 */
export function estimateVRAM(
  modelData: LmStudioRawModel | null | undefined,
  options: {
    gpuLayers?: number;
    contextLength?: number;
    offloadKvCache?: boolean;
    flashAttention?: boolean;
    gpuTotalGiB?: number;
    gpuBaselineGiB?: number;
  } = {},
): TransformedVramEstimate | null {
  if (!modelData) return null;

  const sizeBytes = modelData.size_bytes || 0;
  if (!sizeBytes) return null;

  const bitsPerWeight = modelData.quantization?.bits_per_weight || 4;
  const archParams = resolveArchParams(
    modelData.architecture || "",
    modelData.params_string || "",
    sizeBytes,
    bitsPerWeight,
  );
  const totalLayers = archParams.layers;

  const memory = estimateMemory({
    sizeBytes,
    archParams,
    gpuLayers: options.gpuLayers ?? totalLayers,
    contextLength: options.contextLength ?? LOCAL_PROVIDER.DEFAULT_CONTEXT_LENGTH,
    offloadKvCache: options.offloadKvCache ?? true,
    flashAttention: options.flashAttention ?? true,
    vision: !!modelData.capabilities?.vision,
    gpuTotalGiB: options.gpuTotalGiB,
    gpuBaselineGiB: options.gpuBaselineGiB || 0,
  });

  return {
    ...memory,
    archParams,
    totalLayers,
  };
}

/**
 * Estimate VRAM for a model by its key on a specific instance.
 * Fetches model metadata from the provider, then runs estimateVRAM.
 */
export async function estimateVRAMForModel(
  instanceId: string,
  modelKey: string,
  options: {
    gpuLayers?: number;
    contextLength?: number;
    offloadKvCache?: boolean;
    flashAttention?: boolean;
    gpuTotalGiB?: number;
    gpuBaselineGiB?: number;
  } = {},
): Promise<TransformedVramEstimate | null> {
  const provider = getProvider(instanceId) as GenericProvider | undefined;
  if (!provider?.listModels) return null;

  const result = await provider.listModels();
  const allModels = result?.data || result?.models || [];
  const modelData = allModels.find(
    (modelEntry: { id?: string; path?: string; key?: string }) =>
      modelEntry.id === modelKey ||
      modelEntry.path === modelKey ||
      modelEntry.key === modelKey,
  ) as LmStudioRawModel | undefined;

  if (!modelData) return null;
  return estimateVRAM(modelData, options);
}

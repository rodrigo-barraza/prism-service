// ─── Legacy Facade for Unified Gateway for Local Model Providers ──────────────
// This file delegates everything to the decomposed module in `./local-provider/`
// to maintain backward compatibility with imports throughout the project.

import gateway from "./local-provider/index.ts";

export default gateway;

// Named exports for capability detection patterns (shared with config.js)
export {
  // Provider type sets
  LOCAL_PROVIDER_TYPES,
  NATIVE_MCP_TYPES,
  DEFAULT_THINKING_TYPES,
  MODEL_MANAGEMENT_TYPES,
  // Capability detection patterns
  THINKING_PATTERNS,
  FC_PATTERNS,
  VISION_PATTERNS,
  VIDEO_PATTERNS,
  AUDIO_PATTERNS,
} from "./local-provider/constants.ts";

export {
  matchesAny,
  detectCapabilities,
} from "./local-provider/detectCapabilities.ts";

export {
  formatParams,
  parseParamsFromName,
  parseQuantFromName,
  parsePublisherFromName,
} from "./local-provider/nameParsers.ts";

export {
  fetchHuggingFaceMetadata,
  enrichWithHuggingFace,
} from "./local-provider/hfMetadata.ts";

export {
  normalizeLmStudioModel,
  normalizeOllamaModel,
  normalizeOpenAICompatModel,
  normalizeVllmModel,
  NORMALIZER_BY_TYPE,
  HF_ENRICHED_TYPES,
} from "./local-provider/normalizers.ts";

export { formatBytes } from "@rodrigo-barraza/utilities-library";
export { LocalProviderGateway } from "./local-provider/index.ts";
export type { ModelEntry } from "./local-provider/types.ts";

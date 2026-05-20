// ─── Unified Gateway for Local Model Providers ──────────────

import logger from "../utils/logger.ts";
import {
  formatBytes,
  withTimeoutFallback,
} from "@rodrigo-barraza/utilities-library";
import { getProvider } from "../providers/index.ts";
import {
  listInstances,
  getInstancesByType,
  isInstance,
  getInstance,
  getInstanceType,
  listInstanceTypes,
} from "../providers/instance-registry.ts";
import { TYPES } from "../config.ts";
import { resolveArchParams, estimateMemory } from "../utils/gguf-arch.ts";
import { InstanceEntry } from "../types/ProviderTypes.ts";

interface ListModelsResponse {
  models?: any[];
  data?: any[];
}

// ─── PROVIDER TYPE CONSTANTS ────────────────────────────────
// Canonical provider type identifiers used across the system.

/** All recognized local provider types. */
const LOCAL_PROVIDER_TYPES = new Set([
  "lm-studio",
  "vllm",
  "ollama",
  "llama-cpp",
]);

/**
 * Providers that use native MCP tool execution (the provider's own
 * internal loop handles multi-step tool calling via native events).
 * These providers only need tools on the first pass — subsequent
 * passes should omit tools to force an eventual text response.
 */
const NATIVE_MCP_TYPES = new Set(["lm-studio", "ollama"]);

/**
 * Providers that emit thinking tokens (<think> tags) by default.
 * When the client doesn't explicitly set thinkingEnabled, these
 * providers default to thinkingEnabled=true.
 */
const DEFAULT_THINKING_TYPES = new Set(["lm-studio", "llama-cpp"]);

/**
 * Providers that support model management (load/unload/ensure).
 * Only applicable to servers that can hot-swap models.
 */
const MODEL_MANAGEMENT_TYPES = new Set(["lm-studio"]);

// ─── MODEL CAPABILITY DETECTION ─────────────────────────────
// Centralized pattern-matching for inferring model capabilities
// from their names. These patterns are the canonical source —
// config.js and other consumers should import from here.

/**
 * Models that support extended thinking / chain-of-thought reasoning.
 * Matched against the lowercased model key.
 */
const THINKING_PATTERNS = [
  "qwen3",
  "deepseek-r1",
  "deepseek-v3",
  "gpt-oss",
  "gemma-4",
  "minimax",
];

/**
 * Models trained for function calling / tool use.
 * Matched against the lowercased model key.
 */
const FC_PATTERNS = [
  "qwen",
  "deepseek",
  "llama",
  "mistral",
  "gemma",
  "phi",
  "command",
  "hermes",
  "functionary",
  "gpt-oss",
  "nemotron",
  "minimax",
];

/**
 * Models that support image/vision input.
 * Matched against the lowercased model key.
 */
const VISION_PATTERNS = [
  "vl",
  "vision",
  "llava",
  "pixtral",
  "minicpm-v",
  "internvl",
  "cogvlm",
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "molmo",
  "paligemma",
  "llama-3.2-vision",
  "llama-vision",
  "idefics",
  "phi-3-vision",
  "phi-3.5-vision",
  "phi-4-vision",
  "phi4mm",
  "minicpmv",
  "ovis",
  "deepseek-vl",
  "gemma-4",
];

/**
 * Models that support video input.
 * Matched against the lowercased model key.
 */
const VIDEO_PATTERNS = [
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "llava-next-video",
  "llava-onevision",
  "internvl",
  "phi4mm",
  "gemma-4",
];

/**
 * Models that support audio input.
 * Matched against the lowercased model key.
 */
const AUDIO_PATTERNS = [
  "qwen2-audio",
  "qwen-audio",
  "salmonn",
  "ultravox",
  "phi4mm",
  "minicpmo",
  "whisper",
  "granite-speech",
  "kimi-audio",
  "qwen2.5-omni",
  "qwen3-omni",
  "gemma-4-e2b",
  "gemma-4-e4b",
];

/** Check if a lowercased model name matches any pattern in a list. */
function matchesAny(nameLower: any, patterns: any) {
    return (patterns as any).some((p: any) => (nameLower as any).includes(p));
}

/**
 * Detect capabilities for a model based on its name and provider metadata.


 */
function detectCapabilities(modelKey: any, providerMeta: any = {}) {
    const nameLower = (modelKey || "").toLowerCase();

  // Thinking / reasoning
    const hasReasoningCapability = !!(providerMeta.capabilities as any)?.reasoning;
  const supportsThinking =
        hasReasoningCapability || matchesAny(nameLower, (THINKING_PATTERNS as any));

  // Function calling / tool use
  const supportsFunctionCalling =
        !!(providerMeta.capabilities as any)?.trained_for_tool_use ||
        matchesAny(nameLower, (FC_PATTERNS as any));

  // Vision (images)
  const supportsVision =
        !!(providerMeta.capabilities as any)?.vision ||
        matchesAny(nameLower, (VISION_PATTERNS as any));

  // Video
    const supportsVideo = matchesAny(nameLower, (VIDEO_PATTERNS as any));

  // Audio
    const supportsAudio = matchesAny(nameLower, (AUDIO_PATTERNS as any));

  // Build tools list
  const tools: any[] = [];
    if (supportsThinking) tools.push(("Thinking" as any));
    if (supportsFunctionCalling) tools.push(("Tool Calling" as any));

  // Build input types
  const inputTypes = [TYPES.TEXT];
  if (supportsVision) inputTypes.push(TYPES.IMAGE);
  if (supportsVideo) inputTypes.push(TYPES.VIDEO);
  if (supportsAudio) inputTypes.push(TYPES.AUDIO);

  return {
    thinking: supportsThinking,
    functionCalling: supportsFunctionCalling,
    vision: supportsVision,
    video: supportsVideo,
    audio: supportsAudio,
    tools,
    inputTypes,
    outputTypes: [TYPES.TEXT],
  };
}

/** Format a total parameter count into a human-readable string. */
function formatParams(totalParams: any) {
  if (!totalParams) return null;
    if (totalParams >= 1_000_000_000) {
        const billions = totalParams / 1_000_000_000;
    return billions % 1 === 0 ? `${billions}B` : `${billions.toFixed(1)}B`;
  }
    if (totalParams >= 1_000_000) {
        return `${(totalParams / 1_000_000).toFixed(0)}M`;
  }
  return `${totalParams}`;
}

/** Extract parameter count from model name (e.g. "qwen3-8b" → "8B"). */
function parseParamsFromName(name: string) {
  const match = name.match(/[-_](\d+(?:\.\d+)?[bB])\b/);
  if (match) return match[1].toUpperCase();
  const moeMatch = name.match(/[-_](\d+x\d+(?:\.\d+)?[bB])\b/);
  if (moeMatch) return moeMatch[1].toUpperCase();
  return null;
}

/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
function parseQuantFromName(name: string) {
  const quantPatterns = [
    /[-_](AWQ)\b/i,
    /[-_](GPTQ)\b/i,
    /[-_](GGUF)\b/i,
    /[-_](EXL2)\b/i,
    /[-_](FP8)\b/i,
    /[-_](FP16)\b/i,
    /[-_](BF16)\b/i,
    /[-_](INT8)\b/i,
    /[-_](INT4)\b/i,
    /[@](q\d+_k(?:_[sml])?)\b/i,
  ];
    for ( const pattern of quantPatterns) {
    const match = name.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
function parsePublisherFromName(name: string) {
  if (name.includes("/")) return name.split("/")[0];
  return null;
}

// ─── HUGGINGFACE HUB METADATA CACHE ─────────────────────────

const _hfCache = new Map();
const HF_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
async function fetchHuggingFaceMetadata(modelId: any) {
  const cached = _hfCache.get(modelId);
  if (cached && Date.now() - cached.timestamp < HF_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const response = await fetch(`https://huggingface.co/api/models/${modelId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      _hfCache.set(modelId, { data: null, timestamp: Date.now() });
      return null;
    }
    const data = await response.json();
    const meta = {
            architectures: (data as any).config?.architectures || [],
            modelType: (data as any).config?.model_type || null,
            pipelineTag: (data as any).pipeline_tag || null,
            tags: (data as any).tags || [],
            author: (data as any).author || null,
            totalParams: (data as any).safetensors?.total || null,
            totalSize: (data as any).usedStorage || null,
            paramsByDtype: (data as any).safetensors?.parameters || null,
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
async function enrichWithHuggingFace(entry: any, modelKey: any) {
    if (!(modelKey as any).includes("/")) return entry;

  const hf = await fetchHuggingFaceMetadata(modelKey).catch(() => null);
  if (!hf) return entry;

  // Vision/video/audio override from HF tags
  if (
    hf.pipelineTag === "image-text-to-text" ||
    hf.tags.includes("multimodal") ||
    hf.tags.includes("vision")
  ) {
    entry.vision = true;
        if (!(entry as any).inputTypes.includes(TYPES.IMAGE)) {
            (entry as any).inputTypes.push(TYPES.IMAGE);
    }
  }
  if (hf.pipelineTag === "video-text-to-text" || hf.tags.includes("video")) {
        if (!(entry as any).inputTypes.includes(TYPES.VIDEO)) {
            (entry as any).inputTypes.push(TYPES.VIDEO);
    }
  }
  if (hf.pipelineTag === "audio-text-to-text" || hf.tags.includes("audio")) {
        if (!(entry as any).inputTypes.includes(TYPES.AUDIO)) {
            (entry as any).inputTypes.push(TYPES.AUDIO);
    }
  }

  // Metadata overrides
  if (hf.totalParams) entry.params = formatParams(hf.totalParams);
  if (hf.totalSize) entry.size = formatBytes(hf.totalSize);
  if (hf.architectures?.length > 0) entry.architecture = hf.architectures[0];
  if (hf.author) entry.publisher = hf.author;

  return entry;
}

// ─── Per-provider Raw → Canonical Entry ─────────────────────
// Each normalizer takes raw provider model data and converts it
// into the canonical model entry format used by the config API.

/**
 * Normalize an LM Studio model into a canonical model entry.
 * LM Studio's /api/v1/models returns rich metadata including
 * type, capabilities, quantization, architecture, and load state.
 */
function normalizeLmStudioModel(raw: any) {
  const modelKey = raw.key;
    const capabilities = detectCapabilities((modelKey as any), raw);

  let label = raw.display_name || modelKey;
    if ((raw.quantization as any)?.name) {
        label += ` (${(raw.quantization as any).name})`;
  }

  const isEmbedding = raw.type === "embedding";

  const entry = {
    name: modelKey,
    label,
    modelType: isEmbedding ? "embed" : "conversation",
    inputTypes: isEmbedding ? [TYPES.TEXT] : capabilities.inputTypes,
    outputTypes: isEmbedding ? [TYPES.EMBEDDING] : capabilities.outputTypes,
    supportsSystemPrompt: !isEmbedding,
    streaming: !isEmbedding,
    defaultTemperature: isEmbedding ? undefined : 0.7,
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  };

  // Capability flags (LLM only)
  if (!isEmbedding) {
        if (capabilities.tools.length > 0) (entry as any).tools = capabilities.tools;
        if (capabilities.thinking) (entry as any).thinking = true;
        if (capabilities.vision) (entry as any).vision = true;
  }

  // Metadata from LM Studio API
    if (raw.max_context_length) (entry as any).contextLength = raw.max_context_length;
    if (raw.size_bytes) (entry as any).size = formatBytes((raw.size_bytes as any));
    if (raw.params_string) (entry as any).params = raw.params_string;
    if ((raw.quantization as any)?.name) (entry as any).quantization = (raw as any).quantization.name;
    if ((raw.quantization as any)?.bits_per_weight != null)
        (entry as any).bitsPerWeight = (raw as any).quantization.bits_per_weight;
    if (raw.architecture) (entry as any).architecture = raw.architecture;
    if (raw.publisher) (entry as any).publisher = raw.publisher;
    if ((raw.loaded_instances as any)?.length > 0) (entry as any).loaded = true;

  // Preserve raw for VRAM estimation
    (entry as any)._raw = raw;

  return entry;
}

/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
function normalizeOllamaModel(raw: any) {
  const name = raw.model || raw.name;
    const capabilities = detectCapabilities((name as any));
  const details = raw.details || {};

  const entry = {
    name,
    label: raw.name || name,
    modelType: "conversation",
    inputTypes: capabilities.inputTypes,
    outputTypes: capabilities.outputTypes,
    supportsSystemPrompt: true,
    streaming: true,
    defaultTemperature: 0.7,
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  };

    if (capabilities.tools.length > 0) (entry as any).tools = capabilities.tools;
    if (capabilities.thinking) (entry as any).thinking = true;
    if ((details as any).parameter_size) (entry as any).params = (details as any).parameter_size;
    if ((details as any).family) (entry as any).architecture = (details as any).family;
    if (raw.size) (entry as any).size = formatBytes((raw.size as any));

  return entry;
}

/**
 * Normalize a vLLM or llama.cpp model into a canonical model entry.
 * Both use the OpenAI-compatible /v1/models which returns { id, object, owned_by }.
 * Enriches with name-parsed attributes; HF enrichment is done separately.
 */
function normalizeOpenAICompatModel(raw: any) {
  const modelKey = raw.key || raw.id;
    const capabilities = detectCapabilities((modelKey as any));

    const parsedParams = parseParamsFromName((modelKey as any));
    const parsedQuant = parseQuantFromName((modelKey as any));
    const parsedPublisher = parsePublisherFromName((modelKey as any));

  let label = raw.display_name || modelKey;
  if (parsedQuant) label += ` (${parsedQuant})`;

  const entry = {
    name: modelKey,
    label,
    modelType: "conversation",
    inputTypes: capabilities.inputTypes,
    outputTypes: capabilities.outputTypes,
    supportsSystemPrompt: true,
    streaming: true,
    defaultTemperature: 0.7,
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
  };

    if (capabilities.tools.length > 0) (entry as any).tools = capabilities.tools;
    if (capabilities.thinking) (entry as any).thinking = true;
    if (capabilities.vision) (entry as any).vision = true;
    if (parsedParams) (entry as any).params = parsedParams;
    if (parsedQuant) (entry as any).quantization = parsedQuant;
    if (parsedPublisher) (entry as any).publisher = parsedPublisher;

  return entry;
}

/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
function normalizeVllmModel(raw: any) {
  const entry = normalizeOpenAICompatModel(raw);

  // Ensure Tool Calling is always present for vLLM models
    if (!(entry as any).tools) (entry as any).tools = [];
    if (!(entry as any).tools.includes("Tool Calling")) {
        (entry as any).tools.push("Tool Calling");
  }

  return entry;
}

/** Select the normalizer function for a provider type. */
const NORMALIZER_BY_TYPE = {
  "lm-studio": normalizeLmStudioModel,
  ollama: normalizeOllamaModel,
  vllm: normalizeVllmModel,
  "llama-cpp": normalizeOpenAICompatModel,
};

/** Provider types that should get HuggingFace metadata enrichment. */
const HF_ENRICHED_TYPES = new Set(["vllm", "llama-cpp"]);

// ─── GATEWAY CLASS ──────────────────────────────────────────

class LocalProviderGateway {
  constructor() {
    logger.info("[LocalProviderGateway] Initialized");
  }

  // ── Provider Classification ─────────────────────────────────
  // Centralized methods for determining provider characteristics.
  // These replace scattered hardcoded checks throughout the codebase.

  /**
   * Check whether a provider/instance ID represents a local provider.
   * Handles both base types ("lm-studio") and multi-instance IDs ("lm-studio-2").


   */
  isLocal(providerOrInstanceId: any) {
        if (LOCAL_PROVIDER_TYPES.has((providerOrInstanceId as any))) return true;
        return isInstance((providerOrInstanceId as any));
  }

  /**
   * Check whether a provider uses native MCP tool execution.
   * These providers handle multi-step tool calling internally — the
   * agentic loop should only feed tools on the first pass.


   */
  isNativeMCP(providerOrInstanceId: any) {
    const type =
      this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        return NATIVE_MCP_TYPES.has((type as any));
  }

  /**
   * Check whether a provider should default thinkingEnabled=true
   * when the client doesn't explicitly set it.


   */
  defaultsThinkingEnabled(providerOrInstanceId: any) {
    const type =
      this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        return DEFAULT_THINKING_TYPES.has((type as any));
  }

  /**
   * Check whether a provider supports model management (load/unload).


   */
  supportsModelManagement(providerOrInstanceId: any) {
    const type =
      this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        return MODEL_MANAGEMENT_TYPES.has((type as any));
  }

  /**
   * Resolve the base provider type from any instance ID.
   * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
   * Returns null for non-local providers.


   */
  getProviderType(providerOrInstanceId: any) {
        if (LOCAL_PROVIDER_TYPES.has((providerOrInstanceId as any)))
      return providerOrInstanceId;
        return getInstanceType((providerOrInstanceId as any));
  }

  // ── Instance Enumeration ────────────────────────────────────

  /**
   * Get all registered local provider instances.
   */
  getInstances() {
    return listInstances().map((inst: InstanceEntry) => ({
      id: inst.id,
      type: inst.type,
      instanceNumber: inst.instanceNumber,
      concurrency: inst.concurrency,
    }));
  }

  /**
   * Get instances of a specific provider type.


   */
  getInstancesByType(type: any) {
        return getInstancesByType((type as any));
  }

  /**
   * Get all unique provider types that have at least one registered instance.

   */
  getRegisteredTypes() {
    return listInstanceTypes();
  }

  /**
   * Get total concurrency capacity across all local instances.
   */
  getConcurrencyCapacity() {
    const instances = listInstances();
    const byType: any = {};
    const byInstance: any = {};
    let total = 0;

        for ( const inst of instances) {
      total += inst.concurrency;
            byType[inst.type] = (byType[inst.type] || 0) + inst.concurrency;
            byInstance[inst.id] = inst.concurrency;
    }

    return { total, byType, byInstance };
  }

  // ── Model Discovery ─────────────────────────────────────────

  /**
   * Discover all models across all local provider instances.
   * Results are normalized into a canonical format and enriched
   * with capability detection and (optionally) HuggingFace metadata.
   */
  async discoverModels({ timeoutMs = 3000, enrich = true }: any = {}) {
    const instances = listInstances();
    const models: any = {};

    const results = await Promise.allSettled(
            instances.map(async (inst: any) => {
        const fetched = await this._fetchModelsForInstance(
          inst,
                    (timeoutMs as any),
          (enrich as any),
        );
        return {
          id: inst.id,
          type: inst.type,
          instanceNumber: inst.instanceNumber,
          models: fetched,
        };
      }),
    );

        for ( const result of results) {
      if (result.status === "fulfilled" && result.value.models.length > 0) {
        const {
          id,
          type,
          instanceNumber,
          models: providerModels,
        } = result.value;
        // Tag each model with its instance metadata
                for ( const model of providerModels) {
          model.instanceNumber = instanceNumber;
          model.providerType = type;
        }
                models[(id as string)] = providerModels;
      }
    }

    return models;
  }

  /**
   * Discover models for a single instance.


   */
  async discoverModelsForInstance(
    instanceId: any,
    { timeoutMs = 3000, enrich = true }: any = {},
  ) {
        const inst = getInstance((instanceId as any));
    if (!inst) {
      logger.warn(`[LocalProviderGateway] Unknown instance: ${instanceId}`);
      return [];
    }
        return this._fetchModelsForInstance((inst as any), (timeoutMs as any), (enrich as any));
  }

  /**
   * Internal: Fetch, normalize, and optionally enrich models for an instance.
   * @private
   */
  async _fetchModelsForInstance(inst: any, timeoutMs: any, enrich: any) {
    try {
            const provider = getProvider((inst.id as any));
      if (!provider?.listModels) return [];

      const rawResult = (await withTimeoutFallback(
        provider.listModels(),
                (timeoutMs as any),
        { models: [] },
      )) as ListModelsResponse | null | undefined;

      const rawModels = rawResult?.models || rawResult?.data || [];
      if (!Array.isArray(rawModels) || rawModels.length === 0) return [];

            const normalize = (NORMALIZER_BY_TYPE as any)[((inst as string) as any).type];
      if (!normalize) return [];

      // Normalize all models
      let normalized = rawModels.map((raw: any) => normalize(raw));

      // HuggingFace enrichment for vLLM/llama.cpp (their model IDs are HF-style)
            if (enrich && HF_ENRICHED_TYPES.has((inst.type as any))) {
        const enriched = await Promise.allSettled(
          normalized.map((entry: any) =>
                        enrichWithHuggingFace(entry, (entry.name as any)),
          ),
        );
        normalized = enriched.map((r: any, i: number) =>
          r.status === "fulfilled" ? r.value : normalized[i],
        );
      }

      return normalized;
    } catch (error: any) {
      logger.warn(
                `[LocalProviderGateway] Failed to discover models for ${inst.id}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  // ── Model Search & Filter ───────────────────────────────────

  /**
   * Search for models across all local providers matching a capability filter.
   */
  async searchModels(filter: any = {}) {
    const allModels = await this.discoverModels();
    const results: any[] = [];

        for ( const [instanceId, models] of Object.entries(allModels)) {
            for ( const model of (models as any)) {
        if (!this._matchesFilter(model, filter)) continue;
        results.push({ instanceId, model });
      }
    }

    return results;
  }

  /**
   * Check if a model entry matches the given filter criteria.
   * @private
   */
  _matchesFilter(model: any, filter: any) {
    if (filter.thinking && !model.thinking) return false;
        if (filter.functionCalling && !(model.tools as any)?.includes("Tool Calling"))
      return false;
    if (filter.vision && !model.vision) return false;
        if (filter.video && !(model.inputTypes as any)?.includes(TYPES.VIDEO)) return false;
        if (filter.audio && !(model.inputTypes as any)?.includes(TYPES.AUDIO)) return false;
    if (filter.modelType && model.modelType !== filter.modelType) return false;
    if (filter.loaded === true && !model.loaded) return false;
    if (filter.loaded === false && model.loaded) return false;
    if (filter.query) {
            const searchQuery = (filter.query as any).toLowerCase();
            const nameMatch = (model.name as any)?.toLowerCase().includes(searchQuery);
            const labelMatch = (model.label as any)?.toLowerCase().includes(searchQuery);
      if (!nameMatch && !labelMatch) return false;
    }
    return true;
  }

  // ── Aggregate Statistics ────────────────────────────────────

  /**
   * Get aggregate statistics across all local providers.

   */
  async getStats() {
    const allModels = await this.discoverModels({ enrich: false });
    const instances = listInstances();

    let totalModels = 0;
    let loadedModels = 0;
    let embeddingModels = 0;
    let conversationModels = 0;
    const modelsByInstance: any = {};
    const modelsByType: any = {};
    const capabilityDistribution = {
      thinking: 0,
      functionCalling: 0,
      vision: 0,
      video: 0,
      audio: 0,
    };

        for ( const [instanceId, models] of Object.entries(allModels)) {
            modelsByInstance[instanceId] = (models as any).length;
      const inst = getInstance(instanceId);
      const type = inst?.type || "any";
            modelsByType[type] = (modelsByType[type] || 0) + (models as any).length;

            for ( const model of (models as any)) {
        totalModels++;
        if (model.loaded) loadedModels++;
        if (model.modelType === "embed") embeddingModels++;
        else conversationModels++;
        if (model.thinking) capabilityDistribution.thinking++;
        if (model.tools?.includes("Tool Calling"))
          capabilityDistribution.functionCalling++;
        if (model.vision) capabilityDistribution.vision++;
        if (model.inputTypes?.includes(TYPES.VIDEO))
          capabilityDistribution.video++;
        if (model.inputTypes?.includes(TYPES.AUDIO))
          capabilityDistribution.audio++;
      }
    }

    return {
      instances: instances.length,
      totalModels,
      loadedModels,
      conversationModels,
      embeddingModels,
      modelsByInstance,
      modelsByType,
      capabilityDistribution,
      concurrency: this.getConcurrencyCapacity(),
    };
  }

  // ── Model Routing ───────────────────────────────────────────

  /**
   * Resolve which provider instance serves a given model.
   * Queries each instance's model list and returns the first match.
   */
  async resolveProvider(modelName: any, { timeoutMs = 3000 }: any = {}) {
    const instances = listInstances();

    const checks = await Promise.allSettled(
            instances.map(async (inst: any) => {
                const provider = getProvider((inst.id as any));
        if (!provider?.listModels) return null;

        const result = (await withTimeoutFallback(
          provider.listModels(),
                    (timeoutMs as any),
          { models: [] },
        )) as ListModelsResponse | null | undefined;
        const models = result?.models || result?.data || [];
        const found = models.some((m: any) => {
          const key = m.key || m.id || m.model || m.name;
          return key === modelName;
        });
        return found ? inst : null;
      }),
    );

        for ( const result of checks) {
      if (result.status === "fulfilled" && result.value) {
        const inst = result.value;
        return {
          instanceId: inst.id,
          type: inst.type,
                    provider: getProvider((inst.id as any)),
        };
      }
    }

    return null;
  }

  // ── Health Monitoring ───────────────────────────────────────

  /**
   * Check health of all local provider instances.
   * Returns a map of instance ID → health status.
   *
   * For providers that expose checkHealth() (llama.cpp), uses that.
   * For others, performs a lightweight listModels() probe.
   */
    async checkHealth(timeoutMs: any = 3000) {
    const instances = listInstances();
    const health: any = {};

    const results = await Promise.allSettled(
            instances.map(async (inst: any) => {
                const provider = getProvider((inst.id as any));

        // Prefer native health check if available
        if (provider?.checkHealth) {
          const result = await withTimeoutFallback(
            provider.checkHealth(),
                        (timeoutMs as any),
            { ok: false, status: "timeout" },
          );
          return {
            id: inst.id,
            type: inst.type,
            ...result,
          };
        }

        // Fallback: probe via listModels
        if (provider?.listModels) {
          try {
            const result = (await withTimeoutFallback(
              provider.listModels(),
                            (timeoutMs as any),
              null,
            )) as ListModelsResponse | null | undefined;
            if (!result) {
              return {
                id: inst.id,
                type: inst.type,
                ok: false,
                status: "timeout",
              };
            }
            const models = result.models || result.data || [];
            return {
              id: inst.id,
              type: inst.type,
              ok: true,
              status: "ok",
              models: models.length,
            };
          } catch (error: any) {
            return {
              id: inst.id,
              type: inst.type,
              ok: false,
              status: "unreachable",
                            error: (error as Error).message,
            };
          }
        }

        return { id: inst.id, type: inst.type, ok: false, status: "no_probe" };
      }),
    );

        for ( const result of results) {
      if (result.status === "fulfilled") {
        const { id, ...status } = result.value;
                health[(id as string)] = status;
      }
    }

    return health;
  }

  // ── VRAM Estimation ─────────────────────────────────────────

  /**
   * Estimate VRAM usage for a GGUF model served by a local provider.
   * Primarily useful for LM Studio models that report GGUF metadata.
   */
  estimateVRAM(modelData: any, options: any = {}) {
    if (!modelData) return null;

    const sizeBytes = modelData.size_bytes || 0;
    if (!sizeBytes) return null;

        const bpw = (modelData.quantization as any)?.bits_per_weight || 4;
    const archParams = resolveArchParams(
            (modelData.architecture as any),
      (modelData.params_string as any),
      (sizeBytes as any),
      bpw,
    );
    const totalLayers = archParams.layers;

    const memory = estimateMemory({
      sizeBytes,
      archParams,
            gpuLayers: options.gpuLayers ?? totalLayers,
            contextLength: options.contextLength ?? 4096,
            offloadKvCache: options.offloadKvCache ?? true,
            flashAttention: options.flashAttention ?? true,
            vision: (modelData.capabilities as any)?.vision || false,
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
  async estimateVRAMForModel(instanceId: any, modelKey: any, options: any = {}) {
    const provider = getProvider(instanceId);
    if (!provider?.listModels) return null;

    const result = await provider.listModels();
    const allModels = result?.data || result?.models || [];
    const modelData = allModels.find(
      (m: any) =>
        m.id === modelKey || m.path === modelKey || m.key === modelKey,
    );

    if (!modelData) return null;
    return this.estimateVRAM(modelData, options);
  }

  // ── Model Management ────────────────────────────────────────

  /**
   * Load a model on a specific instance.
   * Only supported by providers that expose loadModel (LM Studio).
   */
  async loadModel(instanceId: any, modelKey: any, options: any = {}, signal: any) {
    const provider = getProvider(instanceId);
    if (!provider?.loadModel) {
      throw new Error(`Provider ${instanceId} does not support model loading`);
    }
    return provider.loadModel(modelKey, options, signal);
  }

  /**
   * Ensure a specific model is loaded on a specific instance.
   * Handles unloading of other models if necessary (single-model enforcement).
   */
  async ensureModelLoaded(
    instanceId: any,
    modelKey: any,
    options: any = {},
    signal: any,
    onStatus: any,
  ) {
    const provider = getProvider(instanceId);
    if (!provider?.ensureModelLoaded) {
      throw new Error(
        `Provider ${instanceId} does not support model management`,
      );
    }
    return provider.ensureModelLoaded(modelKey, options, signal, onStatus);
  }

  /**
   * Unload a model from a specific instance.
   */
  async unloadModel(instanceId: any, modelInstanceId: any) {
    const provider = getProvider(instanceId);
    if (!provider?.unloadModel) {
      throw new Error(
        `Provider ${instanceId} does not support model unloading`,
      );
    }
    return provider.unloadModel(modelInstanceId);
  }

  // ── Options Normalization ───────────────────────────────────
  // Centralizes provider-specific options behavior that was
  // previously scattered across chat.js and AgenticLoopService.

  /**
   * Apply local provider defaults to the options object.
   * This handles the "thinking enabled by default" behavior
   * and any other provider-specific option normalization.
   *
   * Call this during request preparation (prepareGenerationContext).
   */
  applyLocalDefaults(providerName: any, options: any, clientParams: any = {}) {
    if (!this.isLocal(providerName)) return options;

    // Default thinkingEnabled=true for providers that emit <think> tags,
    // but only when the client didn't explicitly send a value.
        if (
      this.defaultsThinkingEnabled(providerName) &&
            clientParams.thinkingEnabled === undefined
    ) {
      options.thinkingEnabled = true;
    }

    return options;
  }

  // ── Generation Delegation ───────────────────────────────────
  // These methods auto-route by model name when no instanceId is
  // explicitly provided. The canonical options format is used —
  // the individual provider adapters handle their own normalization.

  /**
   * Generate text (non-streaming) via a local provider.
   * Auto-resolves the provider if only a model name is given.
   */
  async generateText(messages: any, model: any, options: any = {}, instanceId: any) {
    const provider = await this._getProviderForModel(model, instanceId);
    return provider.generateText(messages, model, options);
  }

  /**
   * Generate text (streaming) via a local provider.
   * Auto-resolves the provider if only a model name is given.
   */
  async *generateTextStream(
    messages: any,
    model: any,
    options: any = {},
    instanceId: any,
  ) {
    const provider = await this._getProviderForModel(model, instanceId);
    yield* provider.generateTextStream(messages, model, options);
  }

  /**
   * Generate an embedding via a local provider.
   */
  async generateEmbedding(
    content: string,
    model: any,
    options: any = {},
    instanceId: any,
  ) {
    const provider = await this._getProviderForModel(model, instanceId);
    if (!provider.generateEmbedding) {
      throw new Error(`Provider does not support embeddings`);
    }
    return provider.generateEmbedding(content, model, options);
  }

  /**
   * Caption an image via a local provider.
   */
  async captionImage(
    images: any,
    prompt: any,
    model: any,
    systemPrompt: any,
    instanceId: any,
  ) {
    const provider = await this._getProviderForModel(model, instanceId);
    if (!provider.captionImage) {
      throw new Error(`Provider does not support image captioning`);
    }
    return provider.captionImage(images, prompt, model, systemPrompt);
  }

  // ── Internal Helpers ────────────────────────────────────────

  /**
   * Get the provider for a model, either by explicit instance or auto-routing.
   * @private
   */
  async _getProviderForModel(model: any, instanceId: any) {
    if (instanceId) {
      return getProvider(instanceId);
    }

    const resolved = await this.resolveProvider(model);
    if (!resolved) {
      throw new Error(
        `No local provider found serving model "${model}". ` +
          `Available instances: ${listInstances()
            .map((i: InstanceEntry) => i.id)
            .join(", ")}`,
      );
    }

    logger.info(
      `[LocalProviderGateway] Auto-routed model "${model}" → ${resolved.instanceId} (${resolved.type})`,
    );
    return resolved.provider;
  }
}

// ── Singleton Export ─────────────────────────────────────────────

const gateway = new LocalProviderGateway();

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
  // Functions
  matchesAny,
  detectCapabilities,
  // Formatting helpers
  formatBytes,
  formatParams,
  parseParamsFromName,
  parseQuantFromName,
  parsePublisherFromName,
  // HuggingFace enrichment
  fetchHuggingFaceMetadata,
  enrichWithHuggingFace,
  // Model normalizers (for direct use by config.js during migration)
  normalizeLmStudioModel,
  normalizeOllamaModel,
  normalizeOpenAICompatModel,
  normalizeVllmModel,
  NORMALIZER_BY_TYPE,
  HF_ENRICHED_TYPES,
};

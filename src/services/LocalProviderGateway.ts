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

export interface ModelEntry {
  name: string;
  label: string;
  modelType: string;
  inputTypes: string[];
  outputTypes: string[];
  supportsSystemPrompt: boolean;
  streaming: boolean;
  defaultTemperature?: number;
  pricing: { inputPerMillion: number; outputPerMillion: number };
  tools?: string[];
  thinking?: boolean;
  vision?: boolean;
  contextLength?: number;
  size?: string;
  params?: string;
  quantization?: string;
  bitsPerWeight?: number;
  architecture?: string;
  publisher?: string;
  loaded?: boolean;
  instanceNumber?: number;
  providerType?: string;
  _raw?: unknown;
}

export interface ListModelsResponse {
  models?: Record<string, unknown>[];
  data?: Record<string, unknown>[];
}

export interface LmStudioRawModel {
  key: string;
  display_name?: string;
  type?: string;
  quantization?: {
    name?: string;
    bits_per_weight?: number;
  };
  max_context_length?: number;
  size_bytes?: number;
  params_string?: string;
  architecture?: string;
  publisher?: string;
  loaded_instances?: unknown[];
  capabilities?: Record<string, unknown>;
}

export interface OllamaRawModel {
  model?: string;
  name?: string;
  size?: number;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

export interface OpenAICompatRawModel {
  key?: string;
  id?: string;
  display_name?: string;
}

export interface GenericProvider {
  listModels?: () => Promise<ListModelsResponse>;
  checkHealth?: () => Promise<{ ok: boolean; status: string; [key: string]: unknown }>;
  loadModel?: (modelKey: string, options?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  unloadModel?: (modelInstanceId: string) => Promise<unknown>;
  ensureModelLoaded?: (
    modelKey: string,
    options?: Record<string, unknown>,
    signal?: AbortSignal,
    onStatus?: (status: unknown) => void
  ) => Promise<unknown>;
  generateText?: (messages: unknown, model: string, options?: Record<string, unknown>) => Promise<unknown>;
  generateTextStream?: (messages: unknown, model: string, options?: Record<string, unknown>) => AsyncGenerator<unknown>;
  generateEmbedding?: (content: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
  captionImage?: (images: unknown, prompt: unknown, model: string, systemPrompt?: unknown) => Promise<unknown>;
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
] as const;

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
] as const;

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
] as const;

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
] as const;

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
] as const;

/** Check if a lowercased model name matches any pattern in a list. */
function matchesAny(nameLower: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => nameLower.includes(p));
}

function detectCapabilities(modelKey: string | null | undefined, providerMeta: { capabilities?: Record<string, unknown> } = {}) {
  const nameLower = (modelKey || "").toLowerCase();
  const capabilities = providerMeta.capabilities || {};

  // Thinking / reasoning
  const hasReasoningCapability = !!capabilities.reasoning;
  const supportsThinking =
    hasReasoningCapability || matchesAny(nameLower, THINKING_PATTERNS);

  // Function calling / tool use
  const supportsFunctionCalling =
    !!capabilities.trained_for_tool_use ||
    matchesAny(nameLower, FC_PATTERNS);

  // Vision (images)
  const supportsVision =
    !!capabilities.vision ||
    matchesAny(nameLower, VISION_PATTERNS);

  // Video
  const supportsVideo = matchesAny(nameLower, VIDEO_PATTERNS);

  // Audio
  const supportsAudio = matchesAny(nameLower, AUDIO_PATTERNS);

  // Build tools list
  const tools: string[] = [];
  if (supportsThinking) tools.push("Thinking");
  if (supportsFunctionCalling) tools.push("Tool Calling");

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
function formatParams(totalParams: number | null | undefined): string | null {
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
function parseParamsFromName(name: string): string | null {
  const match = name.match(/[-_](\d+(?:\.\d+)?[bB])\b/);
  if (match) return match[1].toUpperCase();
  const moeMatch = name.match(/[-_](\d+x\d+(?:\.\d+)?[bB])\b/);
  if (moeMatch) return moeMatch[1].toUpperCase();
  return null;
}

/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
function parseQuantFromName(name: string): string | null {
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
  for (const pattern of quantPatterns) {
    const match = name.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
function parsePublisherFromName(name: string): string | null {
  if (name.includes("/")) return name.split("/")[0];
  return null;
}

// ─── HUGGINGFACE HUB METADATA CACHE ─────────────────────────

export interface HuggingFaceMetadata {
  architectures: string[];
  modelType: string | null;
  pipelineTag: string | null;
  tags: string[];
  author: string | null;
  totalParams: number | null;
  totalSize: number | null;
  paramsByDtype: Record<string, number> | null;
}

const _hfCache = new Map<string, { data: HuggingFaceMetadata | null; timestamp: number }>();
const HF_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
async function fetchHuggingFaceMetadata(modelId: string): Promise<HuggingFaceMetadata | null> {
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
async function enrichWithHuggingFace(entry: ModelEntry, modelKey: string): Promise<ModelEntry> {
  if (!modelKey.includes("/")) return entry;

  const hf = await fetchHuggingFaceMetadata(modelKey).catch(() => null);
  if (!hf) return entry;

  // Vision/video/audio override from HF tags
  if (
    hf.pipelineTag === "image-text-to-text" ||
    hf.tags.includes("multimodal") ||
    hf.tags.includes("vision")
  ) {
    entry.vision = true;
    if (!entry.inputTypes.includes(TYPES.IMAGE)) {
      entry.inputTypes.push(TYPES.IMAGE);
    }
  }
  if (hf.pipelineTag === "video-text-to-text" || hf.tags.includes("video")) {
    if (!entry.inputTypes.includes(TYPES.VIDEO)) {
      entry.inputTypes.push(TYPES.VIDEO);
    }
  }
  if (hf.pipelineTag === "audio-text-to-text" || hf.tags.includes("audio")) {
    if (!entry.inputTypes.includes(TYPES.AUDIO)) {
      entry.inputTypes.push(TYPES.AUDIO);
    }
  }

  // Metadata overrides
  if (hf.totalParams) entry.params = formatParams(hf.totalParams) || undefined;
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
function normalizeLmStudioModel(raw: LmStudioRawModel): ModelEntry {
  const modelKey = raw.key;
  const capabilities = detectCapabilities(modelKey, raw);

  let label = raw.display_name || modelKey;
  if (raw.quantization?.name) {
    label += ` (${raw.quantization.name})`;
  }

  const isEmbedding = raw.type === "embedding";

  const entry: ModelEntry = {
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
    if (capabilities.tools.length > 0) entry.tools = capabilities.tools;
    if (capabilities.thinking) entry.thinking = true;
    if (capabilities.vision) entry.vision = true;
  }

  // Metadata from LM Studio API
  if (raw.max_context_length) entry.contextLength = raw.max_context_length;
  if (raw.size_bytes) entry.size = formatBytes(raw.size_bytes);
  if (raw.params_string) entry.params = raw.params_string;
  if (raw.quantization?.name) entry.quantization = raw.quantization.name;
  if (raw.quantization?.bits_per_weight != null)
    entry.bitsPerWeight = raw.quantization.bits_per_weight;
  if (raw.architecture) entry.architecture = raw.architecture;
  if (raw.publisher) entry.publisher = raw.publisher;
  if (raw.loaded_instances && raw.loaded_instances.length > 0) entry.loaded = true;

  // Preserve raw for VRAM estimation
  entry._raw = raw;

  return entry;
}

/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
function normalizeOllamaModel(raw: OllamaRawModel): ModelEntry {
  const name = raw.model || raw.name || "";
  const capabilities = detectCapabilities(name);
  const details = raw.details || {};

  const entry: ModelEntry = {
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

  if (capabilities.tools.length > 0) entry.tools = capabilities.tools;
  if (capabilities.thinking) entry.thinking = true;
  if (details.parameter_size) entry.params = details.parameter_size;
  if (details.family) entry.architecture = details.family;
  if (raw.size) entry.size = formatBytes(raw.size);

  return entry;
}

/**
 * Normalize a vLLM or llama.cpp model into a canonical model entry.
 * Both use the OpenAI-compatible /v1/models which returns { id, object, owned_by }.
 * Enriches with name-parsed attributes; HF enrichment is done separately.
 */
function normalizeOpenAICompatModel(raw: OpenAICompatRawModel): ModelEntry {
  const modelKey = raw.key || raw.id || "";
  const capabilities = detectCapabilities(modelKey);

  const parsedParams = parseParamsFromName(modelKey);
  const parsedQuant = parseQuantFromName(modelKey);
  const parsedPublisher = parsePublisherFromName(modelKey);

  let label = raw.display_name || modelKey;
  if (parsedQuant) label += ` (${parsedQuant})`;

  const entry: ModelEntry = {
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

  if (capabilities.tools.length > 0) entry.tools = capabilities.tools;
  if (capabilities.thinking) entry.thinking = true;
  if (capabilities.vision) entry.vision = true;
  if (parsedParams) entry.params = parsedParams;
  if (parsedQuant) entry.quantization = parsedQuant;
  if (parsedPublisher) entry.publisher = parsedPublisher;

  return entry;
}

/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
function normalizeVllmModel(raw: OpenAICompatRawModel): ModelEntry {
  const entry = normalizeOpenAICompatModel(raw);

  // Ensure Tool Calling is always present for vLLM models
  if (!entry.tools) entry.tools = [];
  if (!entry.tools.includes("Tool Calling")) {
    entry.tools.push("Tool Calling");
  }

  return entry;
}

/** Select the normalizer function for a provider type. */
type NormalizerFn = (raw: LmStudioRawModel & OllamaRawModel & OpenAICompatRawModel) => ModelEntry;

const NORMALIZER_BY_TYPE: Record<string, NormalizerFn> = {
  "lm-studio": normalizeLmStudioModel as NormalizerFn,
  ollama: normalizeOllamaModel as NormalizerFn,
  vllm: normalizeVllmModel as NormalizerFn,
  "llama-cpp": normalizeOpenAICompatModel as NormalizerFn,
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
  isLocal(providerOrInstanceId: string | null | undefined): boolean {
    if (!providerOrInstanceId) return false;
    if (LOCAL_PROVIDER_TYPES.has(providerOrInstanceId)) return true;
    return isInstance(providerOrInstanceId);
  }

  /**
   * Check whether a provider uses native MCP tool execution.
   * These providers handle multi-step tool calling internally — the
   * agentic loop should only feed tools on the first pass.
   */
  isNativeMCP(providerOrInstanceId: string | null | undefined): boolean {
    if (!providerOrInstanceId) return false;
    const type =
      this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
    return NATIVE_MCP_TYPES.has(type);
  }

  /**
   * Check whether a provider should default thinkingEnabled=true
   * when the client doesn't explicitly set it.
   */
  defaultsThinkingEnabled(providerOrInstanceId: string | null | undefined): boolean {
    if (!providerOrInstanceId) return false;
    const type =
      this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
    return DEFAULT_THINKING_TYPES.has(type);
  }

  supportsModelManagement(providerOrInstanceId: string | null | undefined): boolean {
    if (!providerOrInstanceId) return false;
    const type =
      this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
    return MODEL_MANAGEMENT_TYPES.has(type);
  }

  /**
   * Resolve the base provider type from any instance ID.
   * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
   * Returns null for non-local providers.
   */
  getProviderType(providerOrInstanceId: string | null | undefined): string | null {
    if (!providerOrInstanceId) return null;
    if (LOCAL_PROVIDER_TYPES.has(providerOrInstanceId))
      return providerOrInstanceId;
    return getInstanceType(providerOrInstanceId);
  }

  // ── Instance Enumeration ────────────────────────────────────
  getInstances(): Array<{ id: string; type: string; instanceNumber: number; concurrency: number }> {
    return listInstances().map((instance: InstanceEntry) => ({
      id: instance.id,
      type: instance.type,
      instanceNumber: instance.instanceNumber,
      concurrency: instance.concurrency,
    }));
  }

  getInstancesByType(type: string): InstanceEntry[] {
    return getInstancesByType(type);
  }

  getRegisteredTypes(): string[] {
    return listInstanceTypes();
  }

  getConcurrencyCapacity(): {
    total: number;
    byType: Record<string, number>;
    byInstance: Record<string, number>;
  } {
    const instances = listInstances();
    const byType: Record<string, number> = {};
    const byInstance: Record<string, number> = {};
    let total = 0;

    for (const instance of instances) {
      total += instance.concurrency;
      byType[instance.type] = (byType[instance.type] || 0) + instance.concurrency;
      byInstance[instance.id] = instance.concurrency;
    }

    return { total, byType, byInstance };
  }

  // ── Model Discovery ─────────────────────────────────────────

  /**
   * Discover all models across all local provider instances.
   * Results are normalized into a canonical format and enriched
   * with capability detection and (optionally) HuggingFace metadata.
   */
  async discoverModels({ timeoutMs = 3000, enrich = true }: { timeoutMs?: number; enrich?: boolean } = {}): Promise<Record<string, ModelEntry[]>> {
    const instances = listInstances();
    const models: Record<string, ModelEntry[]> = {};

    const results = await Promise.allSettled(
      instances.map(async (instance: InstanceEntry) => {
        const fetched = await this._fetchModelsForInstance(
          instance,
          timeoutMs,
          enrich,
        );
        return {
          id: instance.id,
          type: instance.type,
          instanceNumber: instance.instanceNumber,
          models: fetched,
        };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.models.length > 0) {
        const {
          id,
          type,
          instanceNumber,
          models: providerModels,
        } = result.value;
        // Tag each model with its instance metadata
        for (const model of providerModels) {
          model.instanceNumber = instanceNumber;
          model.providerType = type;
        }
        models[id] = providerModels;
      }
    }

    return models;
  }

  async discoverModelsForInstance(
    instanceId: string,
    { timeoutMs = 3000, enrich = true }: { timeoutMs?: number; enrich?: boolean } = {},
  ): Promise<ModelEntry[]> {
    const instance = getInstance(instanceId);
    if (!instance) {
      logger.warn(`[LocalProviderGateway] Unknown instance: ${instanceId}`);
      return [];
    }
    return this._fetchModelsForInstance(instance as InstanceEntry, timeoutMs, enrich);
  }

  /**
   * Internal: Fetch, normalize, and optionally enrich models for an instance.
   * @private
   */
  async _fetchModelsForInstance(instance: InstanceEntry, timeoutMs: number, enrich: boolean): Promise<ModelEntry[]> {
    try {
      const provider = getProvider(instance.id) as GenericProvider | undefined;
      if (!provider?.listModels) return [];

      const rawResult = (await withTimeoutFallback(
        provider.listModels(),
        timeoutMs,
        { models: [] },
      )) as ListModelsResponse | null | undefined;

      const rawModels = rawResult?.models || rawResult?.data || [];
      if (!Array.isArray(rawModels) || rawModels.length === 0) return [];

      const normalize = NORMALIZER_BY_TYPE[instance.type];
      if (!normalize) return [];

      // Normalize all models
      let normalized = rawModels.map((raw) => normalize(raw as never));

      // HuggingFace enrichment for vLLM/llama.cpp (their model IDs are HF-style)
      if (enrich && HF_ENRICHED_TYPES.has(instance.type)) {
        const enriched = await Promise.allSettled(
          normalized.map((entry) =>
            enrichWithHuggingFace(entry, entry.name),
          ),
        );
        normalized = enriched.map((r, i) =>
          r.status === "fulfilled" ? r.value : normalized[i],
        );
      }

      return normalized;
    } catch (error: unknown) {
      logger.warn(
        `[LocalProviderGateway] Failed to discover models for ${instance.id}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  // ── Model Search & Filter ───────────────────────────────────
  async searchModels(filter: {
    thinking?: boolean;
    functionCalling?: boolean;
    vision?: boolean;
    video?: boolean;
    audio?: boolean;
    modelType?: string;
    loaded?: boolean;
    query?: string;
  } = {}): Promise<Array<{ instanceId: string; model: ModelEntry }>> {
    const allModels = await this.discoverModels();
    const results: Array<{ instanceId: string; model: ModelEntry }> = [];

    for (const [instanceId, models] of Object.entries(allModels)) {
      for (const model of models) {
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
  _matchesFilter(
    model: ModelEntry,
    filter: {
      thinking?: boolean;
      functionCalling?: boolean;
      vision?: boolean;
      video?: boolean;
      audio?: boolean;
      modelType?: string;
      loaded?: boolean;
      query?: string;
    }
  ): boolean {
    if (filter.thinking && !model.thinking) return false;
    if (filter.functionCalling && !model.tools?.includes("Tool Calling"))
      return false;
    if (filter.vision && !model.vision) return false;
    if (filter.video && !model.inputTypes?.includes(TYPES.VIDEO)) return false;
    if (filter.audio && !model.inputTypes?.includes(TYPES.AUDIO)) return false;
    if (filter.modelType && model.modelType !== filter.modelType) return false;
    if (filter.loaded === true && !model.loaded) return false;
    if (filter.loaded === false && model.loaded) return false;
    if (filter.query) {
      const searchQuery = filter.query.toLowerCase();
      const nameMatch = model.name?.toLowerCase().includes(searchQuery);
      const labelMatch = model.label?.toLowerCase().includes(searchQuery);
      if (!nameMatch && !labelMatch) return false;
    }
    return true;
  }

  // ── Aggregate Statistics ────────────────────────────────────
  async getStats(): Promise<{
    instances: number;
    totalModels: number;
    loadedModels: number;
    conversationModels: number;
    embeddingModels: number;
    modelsByInstance: Record<string, number>;
    modelsByType: Record<string, number>;
    capabilityDistribution: {
      thinking: number;
      functionCalling: number;
      vision: number;
      video: number;
      audio: number;
    };
    concurrency: {
      total: number;
      byType: Record<string, number>;
      byInstance: Record<string, number>;
    };
  }> {
    const allModels = await this.discoverModels({ enrich: false });
    const instances = listInstances();

    let totalModels = 0;
    let loadedModels = 0;
    let embeddingModels = 0;
    let conversationModels = 0;
    const modelsByInstance: Record<string, number> = {};
    const modelsByType: Record<string, number> = {};
    const capabilityDistribution = {
      thinking: 0,
      functionCalling: 0,
      vision: 0,
      video: 0,
      audio: 0,
    };

    for (const [instanceId, models] of Object.entries(allModels)) {
      modelsByInstance[instanceId] = models.length;
      const instance = getInstance(instanceId);
      const type = instance?.type || "any";
      modelsByType[type] = (modelsByType[type] || 0) + models.length;

      for (const model of models) {
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
  async resolveProvider(
    modelName: string,
    { timeoutMs = 3000 }: { timeoutMs?: number } = {}
  ): Promise<{
    instanceId: string;
    type: string;
    provider: GenericProvider;
  } | null> {
    const instances = listInstances();

    const checks = await Promise.allSettled(
      instances.map(async (instance: InstanceEntry) => {
        const provider = getProvider(instance.id) as GenericProvider | undefined;
        if (!provider?.listModels) return null;

        const result = (await withTimeoutFallback(
          provider.listModels(),
          timeoutMs,
          { models: [] },
        )) as ListModelsResponse | null | undefined;
        const models = result?.models || result?.data || [];
        const found = models.some((m: Record<string, unknown>) => {
          const key = (m.key || m.id || m.model || m.name) as string | undefined;
          return key === modelName;
        });
        return found ? instance : null;
      }),
    );

    for (const result of checks) {
      if (result.status === "fulfilled" && result.value) {
        const instance = result.value;
        return {
          instanceId: instance.id,
          type: instance.type,
          provider: getProvider(instance.id) as GenericProvider,
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
  async checkHealth(timeoutMs: number = 3000): Promise<Record<string, unknown>> {
    const instances = listInstances();
    const health: Record<string, unknown> = {};

    const results = await Promise.allSettled(
      instances.map(async (instance: InstanceEntry) => {
        const provider = getProvider(instance.id) as GenericProvider | undefined;

        // Prefer native health check if available
        if (provider?.checkHealth) {
          const result = await withTimeoutFallback(
            provider.checkHealth(),
            timeoutMs,
            { ok: false, status: "timeout" },
          );
          return {
            id: instance.id,
            type: instance.type,
            ...result,
          };
        }

        // Fallback: probe via listModels
        if (provider?.listModels) {
          try {
            const result = (await withTimeoutFallback(
              provider.listModels(),
              timeoutMs,
              null,
            )) as ListModelsResponse | null | undefined;
            if (!result) {
              return {
                id: instance.id,
                type: instance.type,
                ok: false,
                status: "timeout",
              };
            }
            const models = result.models || result.data || [];
            return {
              id: instance.id,
              type: instance.type,
              ok: true,
              status: "ok",
              models: models.length,
            };
          } catch (error: unknown) {
            return {
              id: instance.id,
              type: instance.type,
              ok: false,
              status: "unreachable",
              error: (error as Error).message,
            };
          }
        }

        return { id: instance.id, type: instance.type, ok: false, status: "no_probe" };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { id, ...status } = result.value;
        health[id] = status;
      }
    }

    return health;
  }

  // ── VRAM Estimation ─────────────────────────────────────────

  /**
   * Estimate VRAM usage for a GGUF model served by a local provider.
   * Primarily useful for LM Studio models that report GGUF metadata.
   */
  estimateVRAM(modelData: LmStudioRawModel | null | undefined, options: {
    gpuLayers?: number;
    contextLength?: number;
    offloadKvCache?: boolean;
    flashAttention?: boolean;
    gpuTotalGiB?: number;
    gpuBaselineGiB?: number;
  } = {}): Record<string, unknown> | null {
    if (!modelData) return null;

    const sizeBytes = modelData.size_bytes || 0;
    if (!sizeBytes) return null;

    const bpw = modelData.quantization?.bits_per_weight || 4;
    const archParams = resolveArchParams(
      modelData.architecture || "",
      modelData.params_string || "",
      sizeBytes,
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
  async estimateVRAMForModel(instanceId: string, modelKey: string, options: {
    gpuLayers?: number;
    contextLength?: number;
    offloadKvCache?: boolean;
    flashAttention?: boolean;
    gpuTotalGiB?: number;
    gpuBaselineGiB?: number;
  } = {}): Promise<Record<string, unknown> | null> {
    const provider = getProvider(instanceId) as GenericProvider | undefined;
    if (!provider?.listModels) return null;

    const result = await provider.listModels();
    const allModels = result?.data || result?.models || [];
    const modelData = allModels.find(
      (m: Record<string, unknown>) =>
        m.id === modelKey || m.path === modelKey || m.key === modelKey,
    ) as LmStudioRawModel | undefined;

    if (!modelData) return null;
    return this.estimateVRAM(modelData, options);
  }

  // ── Model Management ────────────────────────────────────────

  /**
   * Load a model on a specific instance.
   * Only supported by providers that expose loadModel (LM Studio).
   */
  async loadModel(
    instanceId: string,
    modelKey: string,
    options: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    const provider = getProvider(instanceId) as GenericProvider | undefined;
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
    instanceId: string,
    modelKey: string,
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
    onStatus?: (status: unknown) => void
  ): Promise<unknown> {
    const provider = getProvider(instanceId) as GenericProvider | undefined;
    if (!provider?.ensureModelLoaded) {
      throw new Error(
        `Provider ${instanceId} does not support model management`,
      );
    }
    return provider.ensureModelLoaded(modelKey, options, signal, onStatus);
  }

  async unloadModel(instanceId: string, modelInstanceId: string): Promise<unknown> {
    const provider = getProvider(instanceId) as GenericProvider | undefined;
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
  applyLocalDefaults(
    providerName: string,
    options: Record<string, unknown>,
    clientParams: Record<string, unknown> = {}
  ): Record<string, unknown> {
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
  async generateText(
    messages: unknown,
    model: string,
    options: Record<string, unknown> = {},
    instanceId?: string
  ): Promise<unknown> {
    const provider = await this._getProviderForModel(model, instanceId);
    if (!provider.generateText) {
      throw new Error(`Provider does not support text generation`);
    }
    return provider.generateText(messages, model, options);
  }

  /**
   * Generate text (streaming) via a local provider.
   * Auto-resolves the provider if only a model name is given.
   */
  async *generateTextStream(
    messages: unknown,
    model: string,
    options: Record<string, unknown> = {},
    instanceId?: string
  ): AsyncGenerator<unknown> {
    const provider = await this._getProviderForModel(model, instanceId);
    if (!provider.generateTextStream) {
      throw new Error(`Provider does not support streaming text generation`);
    }
    yield* provider.generateTextStream(messages, model, options);
  }

  async generateEmbedding(
    content: string,
    model: string,
    options: Record<string, unknown> = {},
    instanceId?: string
  ): Promise<unknown> {
    const provider = await this._getProviderForModel(model, instanceId);
    if (!provider.generateEmbedding) {
      throw new Error(`Provider does not support embeddings`);
    }
    return provider.generateEmbedding(content, model, options);
  }

  async captionImage(
    images: unknown,
    prompt: unknown,
    model: string,
    systemPrompt?: unknown,
    instanceId?: string
  ): Promise<unknown> {
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
  async _getProviderForModel(model: string, instanceId?: string): Promise<GenericProvider> {
    if (instanceId) {
      const provider = getProvider(instanceId) as GenericProvider | undefined;
      if (!provider) {
        throw new Error(`No provider found for instance "${instanceId}"`);
      }
      return provider;
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

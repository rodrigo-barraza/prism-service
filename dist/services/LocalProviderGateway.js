// ─── Unified Gateway for Local Model Providers ──────────────
import logger from "../utils/logger.js";
// @ts-ignore
import { formatBytes, withTimeoutFallback,
// @ts-ignore
 } from "@rodrigo-barraza/utilities-library";
import { getProvider } from "../providers/index.js";
import { listInstances, getInstancesByType, isInstance, getInstance, getInstanceType, listInstanceTypes, } from "../providers/instance-registry.js";
import { TYPES } from "../config.js";
import { resolveArchParams, estimateMemory } from "../utils/gguf-arch.js";
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
function matchesAny(nameLower, patterns) {
    // @ts-ignore - TODO: strict typing
    return patterns.some((p) => nameLower.includes(p));
}
/**
 * Detect capabilities for a model based on its name and provider metadata.


 * @returns {object} Detected capabilities
 */
function detectCapabilities(modelKey, providerMeta = {}) {
    // @ts-ignore - TODO: strict typing
    const nameLower = (modelKey || "").toLowerCase();
    // Thinking / reasoning
    // @ts-ignore
    const hasReasoningCapability = !!providerMeta.capabilities?.reasoning;
    const supportsThinking = 
    // @ts-ignore - TODO: strict typing
    hasReasoningCapability || matchesAny(nameLower, THINKING_PATTERNS);
    // Function calling / tool use
    const supportsFunctionCalling = 
    // @ts-ignore
    !!providerMeta.capabilities?.trained_for_tool_use ||
        // @ts-ignore - TODO: strict typing
        matchesAny(nameLower, FC_PATTERNS);
    // Vision (images)
    const supportsVision = 
    // @ts-ignore
    !!providerMeta.capabilities?.vision ||
        // @ts-ignore - TODO: strict typing
        matchesAny(nameLower, VISION_PATTERNS);
    // Video
    // @ts-ignore - TODO: strict typing
    const supportsVideo = matchesAny(nameLower, VIDEO_PATTERNS);
    // Audio
    // @ts-ignore - TODO: strict typing
    const supportsAudio = matchesAny(nameLower, AUDIO_PATTERNS);
    // Build tools list
    const tools = [];
    // @ts-ignore - TODO: strict typing
    if (supportsThinking)
        tools.push("Thinking");
    // @ts-ignore - TODO: strict typing
    if (supportsFunctionCalling)
        tools.push("Tool Calling");
    // Build input types
    const inputTypes = [TYPES.TEXT];
    if (supportsVision)
        inputTypes.push(TYPES.IMAGE);
    if (supportsVideo)
        inputTypes.push(TYPES.VIDEO);
    if (supportsAudio)
        inputTypes.push(TYPES.AUDIO);
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
function formatParams(totalParams) {
    if (!totalParams)
        return null;
    // @ts-ignore - TODO: strict typing
    if (totalParams >= 1_000_000_000) {
        // @ts-ignore - TODO: strict typing
        const billions = totalParams / 1_000_000_000;
        return billions % 1 === 0 ? `${billions}B` : `${billions.toFixed(1)}B`;
    }
    // @ts-ignore - TODO: strict typing
    if (totalParams >= 1_000_000) {
        // @ts-ignore - TODO: strict typing
        return `${(totalParams / 1_000_000).toFixed(0)}M`;
    }
    return `${totalParams}`;
}
/** Extract parameter count from model name (e.g. "qwen3-8b" → "8B"). */
function parseParamsFromName(name) {
    const match = name.match(/[-_](\d+(?:\.\d+)?[bB])\b/);
    if (match)
        return match[1].toUpperCase();
    const moeMatch = name.match(/[-_](\d+x\d+(?:\.\d+)?[bB])\b/);
    if (moeMatch)
        return moeMatch[1].toUpperCase();
    return null;
}
/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
function parseQuantFromName(name) {
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
    // @ts-ignore
    for (const pattern of quantPatterns) {
        const match = name.match(pattern);
        if (match)
            return match[1].toUpperCase();
    }
    return null;
}
/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
function parsePublisherFromName(name) {
    if (name.includes("/"))
        return name.split("/")[0];
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
async function fetchHuggingFaceMetadata(modelId) {
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
            // @ts-ignore
            architectures: data.config?.architectures || [],
            // @ts-ignore
            modelType: data.config?.model_type || null,
            // @ts-ignore
            pipelineTag: data.pipeline_tag || null,
            // @ts-ignore
            tags: data.tags || [],
            // @ts-ignore
            author: data.author || null,
            // @ts-ignore
            totalParams: data.safetensors?.total || null,
            // @ts-ignore
            totalSize: data.usedStorage || null,
            // @ts-ignore
            paramsByDtype: data.safetensors?.parameters || null,
        };
        _hfCache.set(modelId, { data: meta, timestamp: Date.now() });
        return meta;
    }
    catch {
        _hfCache.set(modelId, { data: null, timestamp: Date.now() });
        return null;
    }
}
/**
 * Enrich a model entry with HuggingFace metadata if the model ID
 * looks like a HF model path (has a slash: "org/model-name").
 */
async function enrichWithHuggingFace(entry, modelKey) {
    // @ts-ignore - TODO: strict typing
    if (!modelKey.includes("/"))
        return entry;
    const hf = await fetchHuggingFaceMetadata(modelKey).catch(() => null);
    if (!hf)
        return entry;
    // Vision/video/audio override from HF tags
    if (hf.pipelineTag === "image-text-to-text" ||
        hf.tags.includes("multimodal") ||
        hf.tags.includes("vision")) {
        entry.vision = true;
        // @ts-ignore - TODO: strict typing
        if (!entry.inputTypes.includes(TYPES.IMAGE)) {
            // @ts-ignore - TODO: strict typing
            entry.inputTypes.push(TYPES.IMAGE);
        }
    }
    if (hf.pipelineTag === "video-text-to-text" || hf.tags.includes("video")) {
        // @ts-ignore - TODO: strict typing
        if (!entry.inputTypes.includes(TYPES.VIDEO)) {
            // @ts-ignore - TODO: strict typing
            entry.inputTypes.push(TYPES.VIDEO);
        }
    }
    if (hf.pipelineTag === "audio-text-to-text" || hf.tags.includes("audio")) {
        // @ts-ignore - TODO: strict typing
        if (!entry.inputTypes.includes(TYPES.AUDIO)) {
            // @ts-ignore - TODO: strict typing
            entry.inputTypes.push(TYPES.AUDIO);
        }
    }
    // Metadata overrides
    if (hf.totalParams)
        entry.params = formatParams(hf.totalParams);
    if (hf.totalSize)
        entry.size = formatBytes(hf.totalSize);
    if (hf.architectures?.length > 0)
        entry.architecture = hf.architectures[0];
    if (hf.author)
        entry.publisher = hf.author;
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
function normalizeLmStudioModel(raw) {
    const modelKey = raw.key;
    // @ts-ignore - TODO: strict typing
    const capabilities = detectCapabilities(modelKey, raw);
    let label = raw.display_name || modelKey;
    // @ts-ignore - TODO: strict typing
    if (raw.quantization?.name) {
        // @ts-ignore - TODO: strict typing
        label += ` (${raw.quantization.name})`;
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
        // @ts-ignore
        if (capabilities.tools.length > 0)
            entry.tools = capabilities.tools;
        // @ts-ignore
        if (capabilities.thinking)
            entry.thinking = true;
        // @ts-ignore
        if (capabilities.vision)
            entry.vision = true;
    }
    // Metadata from LM Studio API
    // @ts-ignore
    if (raw.max_context_length)
        entry.contextLength = raw.max_context_length;
    // @ts-ignore
    if (raw.size_bytes)
        entry.size = formatBytes(raw.size_bytes);
    // @ts-ignore
    if (raw.params_string)
        entry.params = raw.params_string;
    // @ts-ignore
    if (raw.quantization?.name)
        entry.quantization = raw.quantization.name;
    // @ts-ignore
    if (raw.quantization?.bits_per_weight != null)
        // @ts-ignore
        entry.bitsPerWeight = raw.quantization.bits_per_weight;
    // @ts-ignore
    if (raw.architecture)
        entry.architecture = raw.architecture;
    // @ts-ignore
    if (raw.publisher)
        entry.publisher = raw.publisher;
    // @ts-ignore
    if (raw.loaded_instances?.length > 0)
        entry.loaded = true;
    // Preserve raw for VRAM estimation
    // @ts-ignore
    entry._raw = raw;
    return entry;
}
/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
function normalizeOllamaModel(raw) {
    const name = raw.model || raw.name;
    // @ts-ignore - TODO: strict typing
    const capabilities = detectCapabilities(name);
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
    // @ts-ignore
    if (capabilities.tools.length > 0)
        entry.tools = capabilities.tools;
    // @ts-ignore
    if (capabilities.thinking)
        entry.thinking = true;
    // @ts-ignore
    if (details.parameter_size)
        entry.params = details.parameter_size;
    // @ts-ignore
    if (details.family)
        entry.architecture = details.family;
    // @ts-ignore
    if (raw.size)
        entry.size = formatBytes(raw.size);
    return entry;
}
/**
 * Normalize a vLLM or llama.cpp model into a canonical model entry.
 * Both use the OpenAI-compatible /v1/models which returns { id, object, owned_by }.
 * Enriches with name-parsed attributes; HF enrichment is done separately.
 */
function normalizeOpenAICompatModel(raw) {
    const modelKey = raw.key || raw.id;
    // @ts-ignore - TODO: strict typing
    const capabilities = detectCapabilities(modelKey);
    // @ts-ignore - TODO: strict typing
    const parsedParams = parseParamsFromName(modelKey);
    // @ts-ignore - TODO: strict typing
    const parsedQuant = parseQuantFromName(modelKey);
    // @ts-ignore - TODO: strict typing
    const parsedPublisher = parsePublisherFromName(modelKey);
    let label = raw.display_name || modelKey;
    if (parsedQuant)
        label += ` (${parsedQuant})`;
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
    // @ts-ignore
    if (capabilities.tools.length > 0)
        entry.tools = capabilities.tools;
    // @ts-ignore
    if (capabilities.thinking)
        entry.thinking = true;
    // @ts-ignore
    if (capabilities.vision)
        entry.vision = true;
    // @ts-ignore
    if (parsedParams)
        entry.params = parsedParams;
    // @ts-ignore
    if (parsedQuant)
        entry.quantization = parsedQuant;
    // @ts-ignore
    if (parsedPublisher)
        entry.publisher = parsedPublisher;
    return entry;
}
/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
function normalizeVllmModel(raw) {
    const entry = normalizeOpenAICompatModel(raw);
    // Ensure Tool Calling is always present for vLLM models
    // @ts-ignore
    if (!entry.tools)
        entry.tools = [];
    // @ts-ignore
    if (!entry.tools.includes("Tool Calling")) {
        // @ts-ignore
        entry.tools.push("Tool Calling");
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
    isLocal(providerOrInstanceId) {
        // @ts-ignore - TODO: strict typing
        if (LOCAL_PROVIDER_TYPES.has(providerOrInstanceId))
            return true;
        // @ts-ignore - TODO: strict typing
        return isInstance(providerOrInstanceId);
    }
    /**
     * Check whether a provider uses native MCP tool execution.
     * These providers handle multi-step tool calling internally — the
     * agentic loop should only feed tools on the first pass.
  
  
     */
    isNativeMCP(providerOrInstanceId) {
        const type = this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        // @ts-ignore - TODO: strict typing
        return NATIVE_MCP_TYPES.has(type);
    }
    /**
     * Check whether a provider should default thinkingEnabled=true
     * when the client doesn't explicitly set it.
  
  
     */
    defaultsThinkingEnabled(providerOrInstanceId) {
        const type = this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        // @ts-ignore - TODO: strict typing
        return DEFAULT_THINKING_TYPES.has(type);
    }
    /**
     * Check whether a provider supports model management (load/unload).
  
  
     */
    supportsModelManagement(providerOrInstanceId) {
        const type = this.getProviderType(providerOrInstanceId) || providerOrInstanceId;
        // @ts-ignore - TODO: strict typing
        return MODEL_MANAGEMENT_TYPES.has(type);
    }
    /**
     * Resolve the base provider type from any instance ID.
     * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
     * Returns null for non-local providers.
  
  
     */
    getProviderType(providerOrInstanceId) {
        // @ts-ignore - TODO: strict typing
        if (LOCAL_PROVIDER_TYPES.has(providerOrInstanceId))
            return providerOrInstanceId;
        // @ts-ignore - TODO: strict typing
        return getInstanceType(providerOrInstanceId);
    }
    // ── Instance Enumeration ────────────────────────────────────
    /**
     * Get all registered local provider instances.
     * @returns {Array<{ id: string, type: string, instanceNumber: number, concurrency: number }>}
     */
    getInstances() {
        return listInstances().map(
        // @ts-ignore - TODO: strict typing
        ({ id, type, instanceNumber, concurrency }) => ({
            id,
            type,
            instanceNumber,
            concurrency,
        }));
    }
    /**
     * Get instances of a specific provider type.
  
  
     */
    getInstancesByType(type) {
        // @ts-ignore - TODO: strict typing
        return getInstancesByType(type);
    }
    /**
     * Get all unique provider types that have at least one registered instance.
  
     */
    getRegisteredTypes() {
        return listInstanceTypes();
    }
    /**
     * Get total concurrency capacity across all local instances.
     * @returns {{ total: number, byType: { [type: string]: number }, byInstance: { [id: string]: number } }}
     */
    getConcurrencyCapacity() {
        const instances = listInstances();
        const byType = {};
        const byInstance = {};
        let total = 0;
        // @ts-ignore
        for (const inst of instances) {
            total += inst.concurrency;
            // @ts-ignore
            byType[inst.type] = (byType[inst.type] || 0) + inst.concurrency;
            // @ts-ignore
            byInstance[inst.id] = inst.concurrency;
        }
        return { total, byType, byInstance };
    }
    // ── Model Discovery ─────────────────────────────────────────
    /**
     * Discover all models across all local provider instances.
     * Results are normalized into a canonical format and enriched
     * with capability detection and (optionally) HuggingFace metadata.
     *
  
  
     * @returns {Promise<{ [instanceId: string]: object[] }>} Normalized models grouped by instance
     */
    async discoverModels({ timeoutMs = 3000, enrich = true } = {}) {
        const instances = listInstances();
        const models = {};
        const results = await Promise.allSettled(
        // @ts-ignore - TODO: strict typing
        instances.map(async (inst) => {
            const fetched = await this._fetchModelsForInstance(inst, 
            // @ts-ignore - TODO: strict typing
            timeoutMs, enrich);
            return {
                id: inst.id,
                type: inst.type,
                instanceNumber: inst.instanceNumber,
                models: fetched,
            };
        }));
        // @ts-ignore
        for (const result of results) {
            if (result.status === "fulfilled" && result.value.models.length > 0) {
                const { id, type, instanceNumber, models: providerModels, } = result.value;
                // Tag each model with its instance metadata
                // @ts-ignore
                for (const model of providerModels) {
                    model.instanceNumber = instanceNumber;
                    model.providerType = type;
                }
                // @ts-ignore
                models[id] = providerModels;
            }
        }
        return models;
    }
    /**
     * Discover models for a single instance.
  
  
     * @returns {Promise<object[]>} Normalized model entries
     */
    async discoverModelsForInstance(instanceId, { timeoutMs = 3000, enrich = true } = {}) {
        // @ts-ignore - TODO: strict typing
        const inst = getInstance(instanceId);
        if (!inst) {
            logger.warn(`[LocalProviderGateway] Unknown instance: ${instanceId}`);
            return [];
        }
        // @ts-ignore - TODO: strict typing
        return this._fetchModelsForInstance(inst, timeoutMs, enrich);
    }
    /**
     * Internal: Fetch, normalize, and optionally enrich models for an instance.
     * @private
     */
    async _fetchModelsForInstance(inst, timeoutMs, enrich) {
        try {
            // @ts-ignore - TODO: strict typing
            const provider = getProvider(inst.id);
            if (!provider?.listModels)
                return [];
            const rawResult = (await withTimeoutFallback(provider.listModels(), 
            // @ts-ignore - TODO: strict typing
            timeoutMs, { models: [] }));
            const rawModels = rawResult?.models || rawResult?.data || [];
            if (!Array.isArray(rawModels) || rawModels.length === 0)
                return [];
            // @ts-ignore
            const normalize = NORMALIZER_BY_TYPE[inst.type];
            if (!normalize)
                return [];
            // Normalize all models
            let normalized = rawModels.map((raw) => normalize(raw));
            // HuggingFace enrichment for vLLM/llama.cpp (their model IDs are HF-style)
            // @ts-ignore - TODO: strict typing
            if (enrich && HF_ENRICHED_TYPES.has(inst.type)) {
                const enriched = await Promise.allSettled(normalized.map((entry) => 
                // @ts-ignore - TODO: strict typing
                enrichWithHuggingFace(entry, entry.name)));
                // @ts-ignore - TODO: strict typing
                normalized = enriched.map((r, i) => 
                // @ts-ignore - TODO: strict typing
                r.status === "fulfilled" ? r.value : normalized[i]);
            }
            return normalized;
        }
        catch (error) {
            logger.warn(
            // @ts-ignore - TODO: strict typing
            `[LocalProviderGateway] Failed to discover models for ${inst.id}: ${error.message}`);
            return [];
        }
    }
    // ── Model Search & Filter ───────────────────────────────────
    /**
     * Search for models across all local providers matching a capability filter.
     *
  
  
     * @returns {Promise<Array<{ instanceId: string, model: object }>>}
     */
    async searchModels(filter = {}) {
        const allModels = await this.discoverModels();
        const results = [];
        // @ts-ignore
        for (const [instanceId, models] of Object.entries(allModels)) {
            // @ts-ignore
            for (const model of models) {
                if (!this._matchesFilter(model, filter))
                    continue;
                results.push({ instanceId, model });
            }
        }
        return results;
    }
    /**
     * Check if a model entry matches the given filter criteria.
     * @private
     */
    _matchesFilter(model, filter) {
        if (filter.thinking && !model.thinking)
            return false;
        // @ts-ignore - TODO: strict typing
        if (filter.functionCalling && !model.tools?.includes("Tool Calling"))
            return false;
        if (filter.vision && !model.vision)
            return false;
        // @ts-ignore - TODO: strict typing
        if (filter.video && !model.inputTypes?.includes(TYPES.VIDEO))
            return false;
        // @ts-ignore - TODO: strict typing
        if (filter.audio && !model.inputTypes?.includes(TYPES.AUDIO))
            return false;
        if (filter.modelType && model.modelType !== filter.modelType)
            return false;
        if (filter.loaded === true && !model.loaded)
            return false;
        if (filter.loaded === false && model.loaded)
            return false;
        if (filter.query) {
            // @ts-ignore - TODO: strict typing
            const searchQuery = filter.query.toLowerCase();
            // @ts-ignore - TODO: strict typing
            const nameMatch = model.name?.toLowerCase().includes(searchQuery);
            // @ts-ignore - TODO: strict typing
            const labelMatch = model.label?.toLowerCase().includes(searchQuery);
            if (!nameMatch && !labelMatch)
                return false;
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
        const modelsByInstance = {};
        const modelsByType = {};
        const capabilityDistribution = {
            thinking: 0,
            functionCalling: 0,
            vision: 0,
            video: 0,
            audio: 0,
        };
        // @ts-ignore
        for (const [instanceId, models] of Object.entries(allModels)) {
            // @ts-ignore
            modelsByInstance[instanceId] = models.length;
            const inst = getInstance(instanceId);
            const type = inst?.type || "unknown";
            // @ts-ignore
            modelsByType[type] = (modelsByType[type] || 0) + models.length;
            // @ts-ignore
            for (const model of models) {
                totalModels++;
                if (model.loaded)
                    loadedModels++;
                if (model.modelType === "embed")
                    embeddingModels++;
                else
                    conversationModels++;
                if (model.thinking)
                    capabilityDistribution.thinking++;
                if (model.tools?.includes("Tool Calling"))
                    capabilityDistribution.functionCalling++;
                if (model.vision)
                    capabilityDistribution.vision++;
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
     *
  
  
     * @returns {Promise<{ instanceId: string, type: string, provider: object } | null>}
     */
    async resolveProvider(modelName, { timeoutMs = 3000 } = {}) {
        const instances = listInstances();
        const checks = await Promise.allSettled(
        // @ts-ignore - TODO: strict typing
        instances.map(async (inst) => {
            // @ts-ignore - TODO: strict typing
            const provider = getProvider(inst.id);
            if (!provider?.listModels)
                return null;
            const result = (await withTimeoutFallback(provider.listModels(), 
            // @ts-ignore - TODO: strict typing
            timeoutMs, { models: [] }));
            const models = result?.models || result?.data || [];
            const found = models.some((m) => {
                const key = m.key || m.id || m.model || m.name;
                return key === modelName;
            });
            return found ? inst : null;
        }));
        // @ts-ignore
        for (const result of checks) {
            if (result.status === "fulfilled" && result.value) {
                const inst = result.value;
                return {
                    instanceId: inst.id,
                    type: inst.type,
                    // @ts-ignore - TODO: strict typing
                    provider: getProvider(inst.id),
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
     *
  
     * @returns {Promise<{ [instanceId: string]: { ok: boolean, status: string, type: string, models?: number } }>}
     */
    // @ts-ignore - TODO: strict typing
    async checkHealth(timeoutMs = 3000) {
        const instances = listInstances();
        const health = {};
        const results = await Promise.allSettled(
        // @ts-ignore - TODO: strict typing
        instances.map(async (inst) => {
            // @ts-ignore - TODO: strict typing
            const provider = getProvider(inst.id);
            // Prefer native health check if available
            if (provider?.checkHealth) {
                const result = await withTimeoutFallback(provider.checkHealth(), 
                // @ts-ignore - TODO: strict typing
                timeoutMs, { ok: false, status: "timeout" });
                return {
                    id: inst.id,
                    type: inst.type,
                    ...result,
                };
            }
            // Fallback: probe via listModels
            if (provider?.listModels) {
                try {
                    const result = (await withTimeoutFallback(provider.listModels(), 
                    // @ts-ignore - TODO: strict typing
                    timeoutMs, null));
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
                }
                catch (error) {
                    return {
                        id: inst.id,
                        type: inst.type,
                        ok: false,
                        status: "unreachable",
                        // @ts-ignore - TODO: strict typing
                        error: error.message,
                    };
                }
            }
            return { id: inst.id, type: inst.type, ok: false, status: "no_probe" };
        }));
        // @ts-ignore
        for (const result of results) {
            if (result.status === "fulfilled") {
                const { id, ...status } = result.value;
                // @ts-ignore
                health[id] = status;
            }
        }
        return health;
    }
    // ── VRAM Estimation ─────────────────────────────────────────
    /**
     * Estimate VRAM usage for a GGUF model served by a local provider.
     * Primarily useful for LM Studio models that report GGUF metadata.
     *
  
  
     * @returns {{ gpuGiB: number, totalGiB: number, cpuOffloaded: boolean, archParams: object, totalLayers: number } | null}
     */
    estimateVRAM(modelData, options = {}) {
        if (!modelData)
            return null;
        const sizeBytes = modelData.size_bytes || 0;
        if (!sizeBytes)
            return null;
        // @ts-ignore - TODO: strict typing
        const bpw = modelData.quantization?.bits_per_weight || 4;
        const archParams = resolveArchParams(
        // @ts-ignore - TODO: strict typing
        modelData.architecture, modelData.params_string, sizeBytes, bpw);
        const totalLayers = archParams.layers;
        const memory = estimateMemory({
            sizeBytes,
            archParams,
            // @ts-ignore
            gpuLayers: options.gpuLayers ?? totalLayers,
            // @ts-ignore
            contextLength: options.contextLength ?? 4096,
            // @ts-ignore
            offloadKvCache: options.offloadKvCache ?? true,
            // @ts-ignore
            flashAttention: options.flashAttention ?? true,
            // @ts-ignore - TODO: strict typing
            vision: modelData.capabilities?.vision || false,
            // @ts-ignore
            gpuTotalGiB: options.gpuTotalGiB,
            // @ts-ignore
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
     *
  
  
     */
    async estimateVRAMForModel(instanceId, modelKey, options = {}) {
        const provider = getProvider(instanceId);
        if (!provider?.listModels)
            return null;
        const result = await provider.listModels();
        const allModels = result?.data || result?.models || [];
        const modelData = allModels.find((m) => m.id === modelKey || m.path === modelKey || m.key === modelKey);
        if (!modelData)
            return null;
        return this.estimateVRAM(modelData, options);
    }
    // ── Model Management ────────────────────────────────────────
    /**
     * Load a model on a specific instance.
     * Only supported by providers that expose loadModel (LM Studio).
     *
  
  
     */
    async loadModel(instanceId, modelKey, options = {}, signal) {
        const provider = getProvider(instanceId);
        if (!provider?.loadModel) {
            throw new Error(`Provider ${instanceId} does not support model loading`);
        }
        return provider.loadModel(modelKey, options, signal);
    }
    /**
     * Ensure a specific model is loaded on a specific instance.
     * Handles unloading of other models if necessary (single-model enforcement).
     *
  
  
     * @returns {Promise<{ alreadyLoaded: boolean, contextLength: number|null }>}
     */
    async ensureModelLoaded(instanceId, modelKey, options = {}, signal, onStatus) {
        const provider = getProvider(instanceId);
        if (!provider?.ensureModelLoaded) {
            throw new Error(`Provider ${instanceId} does not support model management`);
        }
        return provider.ensureModelLoaded(modelKey, options, signal, onStatus);
    }
    /**
     * Unload a model from a specific instance.
     *
  
  
     */
    async unloadModel(instanceId, modelInstanceId) {
        const provider = getProvider(instanceId);
        if (!provider?.unloadModel) {
            throw new Error(`Provider ${instanceId} does not support model unloading`);
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
     *
  
  
     * @returns {object} The mutated options object (for chaining)
     */
    applyLocalDefaults(providerName, options, clientParams = {}) {
        if (!this.isLocal(providerName))
            return options;
        // Default thinkingEnabled=true for providers that emit <think> tags,
        // but only when the client didn't explicitly send a value.
        // @ts-ignore
        if (this.defaultsThinkingEnabled(providerName) &&
            // @ts-ignore
            clientParams.thinkingEnabled === undefined) {
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
     *
  
  
     * @returns {Promise<{ text: string, thinking: string|null, usage: object }>}
     */
    async generateText(messages, model, options = {}, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        return provider.generateText(messages, model, options);
    }
    /**
     * Generate text (streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
  
  
     */
    async *generateTextStream(messages, model, options = {}, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        yield* provider.generateTextStream(messages, model, options);
    }
    /**
     * Generate an embedding via a local provider.
     *
  
  
     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    async generateEmbedding(content, model, options = {}, instanceId) {
        const provider = await this._getProviderForModel(model, instanceId);
        if (!provider.generateEmbedding) {
            throw new Error(`Provider does not support embeddings`);
        }
        return provider.generateEmbedding(content, model, options);
    }
    /**
     * Caption an image via a local provider.
     *
  
  
     * @returns {Promise<{ text: string, usage: object }>}
     */
    async captionImage(images, prompt, model, systemPrompt, instanceId) {
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
    async _getProviderForModel(model, instanceId) {
        if (instanceId) {
            return getProvider(instanceId);
        }
        const resolved = await this.resolveProvider(model);
        if (!resolved) {
            throw new Error(`No local provider found serving model "${model}". ` +
                `Available instances: ${listInstances()
                    // @ts-ignore - TODO: strict typing
                    .map((i) => i.id)
                    .join(", ")}`);
        }
        logger.info(`[LocalProviderGateway] Auto-routed model "${model}" → ${resolved.instanceId} (${resolved.type})`);
        return resolved.provider;
    }
}
// ── Singleton Export ─────────────────────────────────────────────
const gateway = new LocalProviderGateway();
export default gateway;
// Named exports for capability detection patterns (shared with config.js)
export { 
// Provider type sets
LOCAL_PROVIDER_TYPES, NATIVE_MCP_TYPES, DEFAULT_THINKING_TYPES, MODEL_MANAGEMENT_TYPES, 
// Capability detection patterns
THINKING_PATTERNS, FC_PATTERNS, VISION_PATTERNS, VIDEO_PATTERNS, AUDIO_PATTERNS, 
// Functions
matchesAny, detectCapabilities, 
// Formatting helpers
formatBytes, formatParams, parseParamsFromName, parseQuantFromName, parsePublisherFromName, 
// HuggingFace enrichment
fetchHuggingFaceMetadata, enrichWithHuggingFace, 
// Model normalizers (for direct use by config.js during migration)
normalizeLmStudioModel, normalizeOllamaModel, normalizeOpenAICompatModel, normalizeVllmModel, NORMALIZER_BY_TYPE, HF_ENRICHED_TYPES, };
//# sourceMappingURL=LocalProviderGateway.js.map
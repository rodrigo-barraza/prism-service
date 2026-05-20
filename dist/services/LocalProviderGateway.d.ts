import { formatBytes } from "@rodrigo-barraza/utilities-library";
import { InstanceEntry } from "../types/ProviderTypes.ts";
/** All recognized local provider types. */
declare const LOCAL_PROVIDER_TYPES: Set<string>;
/**
 * Providers that use native MCP tool execution (the provider's own
 * internal loop handles multi-step tool calling via native events).
 * These providers only need tools on the first pass — subsequent
 * passes should omit tools to force an eventual text response.
 */
declare const NATIVE_MCP_TYPES: Set<string>;
/**
 * Providers that emit thinking tokens (<think> tags) by default.
 * When the client doesn't explicitly set thinkingEnabled, these
 * providers default to thinkingEnabled=true.
 */
declare const DEFAULT_THINKING_TYPES: Set<string>;
/**
 * Providers that support model management (load/unload/ensure).
 * Only applicable to servers that can hot-swap models.
 */
declare const MODEL_MANAGEMENT_TYPES: Set<string>;
/**
 * Models that support extended thinking / chain-of-thought reasoning.
 * Matched against the lowercased model key.
 */
declare const THINKING_PATTERNS: string[];
/**
 * Models trained for function calling / tool use.
 * Matched against the lowercased model key.
 */
declare const FC_PATTERNS: string[];
/**
 * Models that support image/vision input.
 * Matched against the lowercased model key.
 */
declare const VISION_PATTERNS: string[];
/**
 * Models that support video input.
 * Matched against the lowercased model key.
 */
declare const VIDEO_PATTERNS: string[];
/**
 * Models that support audio input.
 * Matched against the lowercased model key.
 */
declare const AUDIO_PATTERNS: string[];
/** Check if a lowercased model name matches any pattern in a list. */
declare function matchesAny(nameLower: any, patterns: any): any;
/**
 * Detect capabilities for a model based on its name and provider metadata.


 * @returns {object} Detected capabilities
 */
declare function detectCapabilities(modelKey: any, providerMeta?: any): {
    thinking: any;
    functionCalling: any;
    vision: any;
    video: any;
    audio: any;
    tools: any[];
    inputTypes: string[];
    outputTypes: string[];
};
/** Format a total parameter count into a human-readable string. */
declare function formatParams(totalParams: any): string | null;
/** Extract parameter count from model name (e.g. "qwen3-8b" → "8B"). */
declare function parseParamsFromName(name: string): string | null;
/** Extract quantization from model name (e.g. "model-AWQ" → "AWQ"). */
declare function parseQuantFromName(name: string): string | null;
/** Extract publisher/org from a namespaced model ID (e.g. "Qwen/Qwen3-8B" → "Qwen"). */
declare function parsePublisherFromName(name: string): string | null;
/**
 * Fetch model metadata from HuggingFace Hub API.
 * Returns null on any failure (gated models, network errors, etc.).
 * Results are cached in-memory with a 30-minute TTL.
 */
declare function fetchHuggingFaceMetadata(modelId: any): Promise<any>;
/**
 * Enrich a model entry with HuggingFace metadata if the model ID
 * looks like a HF model path (has a slash: "org/model-name").
 */
declare function enrichWithHuggingFace(entry: any, modelKey: any): Promise<any>;
/**
 * Normalize an LM Studio model into a canonical model entry.
 * LM Studio's /api/v1/models returns rich metadata including
 * type, capabilities, quantization, architecture, and load state.
 */
declare function normalizeLmStudioModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number | undefined;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/**
 * Normalize an Ollama model into a canonical model entry.
 * Ollama's /api/tags returns { name, model, size, details: { family, parameter_size, ... } }.
 */
declare function normalizeOllamaModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/**
 * Normalize a vLLM or llama.cpp model into a canonical model entry.
 * Both use the OpenAI-compatible /v1/models which returns { id, object, owned_by }.
 * Enriches with name-parsed attributes; HF enrichment is done separately.
 */
declare function normalizeOpenAICompatModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/**
 * vLLM-specific normalizer.
 * vLLM containers are launched with --enable-auto-tool-choice and a
 * --tool-call-parser, so every served model supports tool calling at
 * the server level regardless of name. Force "Tool Calling" onto all
 * vLLM models, then delegate the rest to the shared normalizer.
 */
declare function normalizeVllmModel(raw: any): {
    name: any;
    label: any;
    modelType: string;
    inputTypes: string[];
    outputTypes: string[];
    supportsSystemPrompt: boolean;
    streaming: boolean;
    defaultTemperature: number;
    pricing: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
};
/** Select the normalizer function for a provider type. */
declare const NORMALIZER_BY_TYPE: {
    "lm-studio": typeof normalizeLmStudioModel;
    ollama: typeof normalizeOllamaModel;
    vllm: typeof normalizeVllmModel;
    "llama-cpp": typeof normalizeOpenAICompatModel;
};
/** Provider types that should get HuggingFace metadata enrichment. */
declare const HF_ENRICHED_TYPES: Set<string>;
declare class LocalProviderGateway {
    constructor();
    /**
     * Check whether a provider/instance ID represents a local provider.
     * Handles both base types ("lm-studio") and multi-instance IDs ("lm-studio-2").
  
  
     */
    isLocal(providerOrInstanceId: any): boolean;
    /**
     * Check whether a provider uses native MCP tool execution.
     * These providers handle multi-step tool calling internally — the
     * agentic loop should only feed tools on the first pass.
  
  
     */
    isNativeMCP(providerOrInstanceId: any): boolean;
    /**
     * Check whether a provider should default thinkingEnabled=true
     * when the client doesn't explicitly set it.
  
  
     */
    defaultsThinkingEnabled(providerOrInstanceId: any): boolean;
    /**
     * Check whether a provider supports model management (load/unload).
  
  
     */
    supportsModelManagement(providerOrInstanceId: any): boolean;
    /**
     * Resolve the base provider type from any instance ID.
     * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
     * Returns null for non-local providers.
  
  
     */
    getProviderType(providerOrInstanceId: any): any;
    /**
     * Get all registered local provider instances.
     * @returns {Array<{ id: string, type: string, instanceNumber: number, concurrency: number }>}
     */
    getInstances(): {
        id: string;
        type: string;
        instanceNumber: number;
        concurrency: number;
    }[];
    /**
     * Get instances of a specific provider type.
  
  
     */
    getInstancesByType(type: any): InstanceEntry[];
    /**
     * Get all unique provider types that have at least one registered instance.
  
     */
    getRegisteredTypes(): string[];
    /**
     * Get total concurrency capacity across all local instances.
     * @returns {{ total: number, byType: { [type: string]: number }, byInstance: { [id: string]: number } }}
     */
    getConcurrencyCapacity(): {
        total: number;
        byType: any;
        byInstance: any;
    };
    /**
     * Discover all models across all local provider instances.
     * Results are normalized into a canonical format and enriched
     * with capability detection and (optionally) HuggingFace metadata.
     *
  
  
     * @returns {Promise<{ [instanceId: string]: object[] }>} Normalized models grouped by instance
     */
    discoverModels({ timeoutMs, enrich }?: any): Promise<any>;
    /**
     * Discover models for a single instance.
  
  
     * @returns {Promise<object[]>} Normalized model entries
     */
    discoverModelsForInstance(instanceId: any, { timeoutMs, enrich }?: any): Promise<any[]>;
    /**
     * Internal: Fetch, normalize, and optionally enrich models for an instance.
     * @private
     */
    _fetchModelsForInstance(inst: any, timeoutMs: any, enrich: any): Promise<any[]>;
    /**
     * Search for models across all local providers matching a capability filter.
     *
  
  
     * @returns {Promise<Array<{ instanceId: string, model: object }>>}
     */
    searchModels(filter?: any): Promise<any[]>;
    /**
     * Check if a model entry matches the given filter criteria.
     * @private
     */
    _matchesFilter(model: any, filter: any): boolean;
    /**
     * Get aggregate statistics across all local providers.
  
     */
    getStats(): Promise<{
        instances: number;
        totalModels: number;
        loadedModels: number;
        conversationModels: number;
        embeddingModels: number;
        modelsByInstance: any;
        modelsByType: any;
        capabilityDistribution: {
            thinking: number;
            functionCalling: number;
            vision: number;
            video: number;
            audio: number;
        };
        concurrency: {
            total: number;
            byType: any;
            byInstance: any;
        };
    }>;
    /**
     * Resolve which provider instance serves a given model.
     * Queries each instance's model list and returns the first match.
     *
  
  
     * @returns {Promise<{ instanceId: string, type: string, provider: object } | null>}
     */
    resolveProvider(modelName: any, { timeoutMs }?: any): Promise<{
        instanceId: any;
        type: any;
        provider: any;
    } | null>;
    /**
     * Check health of all local provider instances.
     * Returns a map of instance ID → health status.
     *
     * For providers that expose checkHealth() (llama.cpp), uses that.
     * For others, performs a lightweight listModels() probe.
     *
  
     * @returns {Promise<{ [instanceId: string]: { ok: boolean, status: string, type: string, models?: number } }>}
     */
    checkHealth(timeoutMs?: any): Promise<any>;
    /**
     * Estimate VRAM usage for a GGUF model served by a local provider.
     * Primarily useful for LM Studio models that report GGUF metadata.
     *
  
  
     * @returns {{ gpuGiB: number, totalGiB: number, cpuOffloaded: boolean, archParams: object, totalLayers: number } | null}
     */
    estimateVRAM(modelData: any, options?: any): {
        archParams: {
            layers: any;
            kvHeads: any;
            headDim: any;
            attnRatio: any;
            isKnown: boolean;
        };
        totalLayers: any;
        gpuGiB: number;
        totalGiB: number;
        cpuOffloaded: boolean;
    } | null;
    /**
     * Estimate VRAM for a model by its key on a specific instance.
     * Fetches model metadata from the provider, then runs estimateVRAM.
     *
  
  
     */
    estimateVRAMForModel(instanceId: any, modelKey: any, options?: any): Promise<{
        archParams: {
            layers: any;
            kvHeads: any;
            headDim: any;
            attnRatio: any;
            isKnown: boolean;
        };
        totalLayers: any;
        gpuGiB: number;
        totalGiB: number;
        cpuOffloaded: boolean;
    } | null>;
    /**
     * Load a model on a specific instance.
     * Only supported by providers that expose loadModel (LM Studio).
     *
  
  
     */
    loadModel(instanceId: any, modelKey: any, options: any | undefined, signal: any): Promise<any>;
    /**
     * Ensure a specific model is loaded on a specific instance.
     * Handles unloading of other models if necessary (single-model enforcement).
     *
  
  
     * @returns {Promise<{ alreadyLoaded: boolean, contextLength: number|null }>}
     */
    ensureModelLoaded(instanceId: any, modelKey: any, options: any | undefined, signal: any, onStatus: any): Promise<any>;
    /**
     * Unload a model from a specific instance.
     *
  
  
     */
    unloadModel(instanceId: any, modelInstanceId: any): Promise<any>;
    /**
     * Apply local provider defaults to the options object.
     * This handles the "thinking enabled by default" behavior
     * and any other provider-specific option normalization.
     *
     * Call this during request preparation (prepareGenerationContext).
     *
  
  
     * @returns {object} The mutated options object (for chaining)
     */
    applyLocalDefaults(providerName: any, options: any, clientParams?: any): any;
    /**
     * Generate text (non-streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
  
  
     * @returns {Promise<{ text: string, thinking: string|null, usage: object }>}
     */
    generateText(messages: any, model: any, options: any | undefined, instanceId: any): Promise<any>;
    /**
     * Generate text (streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
  
  
     */
    generateTextStream(messages: any, model: any, options: any | undefined, instanceId: any): AsyncGenerator<any, void, any>;
    /**
     * Generate an embedding via a local provider.
     *
  
  
     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    generateEmbedding(content: string, model: any, options: any | undefined, instanceId: any): Promise<any>;
    /**
     * Caption an image via a local provider.
     *
  
  
     * @returns {Promise<{ text: string, usage: object }>}
     */
    captionImage(images: any, prompt: any, model: any, systemPrompt: any, instanceId: any): Promise<any>;
    /**
     * Get the provider for a model, either by explicit instance or auto-routing.
     * @private
     */
    _getProviderForModel(model: any, instanceId: any): Promise<any>;
}
declare const gateway: LocalProviderGateway;
export default gateway;
export { LOCAL_PROVIDER_TYPES, NATIVE_MCP_TYPES, DEFAULT_THINKING_TYPES, MODEL_MANAGEMENT_TYPES, THINKING_PATTERNS, FC_PATTERNS, VISION_PATTERNS, VIDEO_PATTERNS, AUDIO_PATTERNS, matchesAny, detectCapabilities, formatBytes, formatParams, parseParamsFromName, parseQuantFromName, parsePublisherFromName, fetchHuggingFaceMetadata, enrichWithHuggingFace, normalizeLmStudioModel, normalizeOllamaModel, normalizeOpenAICompatModel, normalizeVllmModel, NORMALIZER_BY_TYPE, HF_ENRICHED_TYPES, };
//# sourceMappingURL=LocalProviderGateway.d.ts.map
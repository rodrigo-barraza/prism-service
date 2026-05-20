import { formatBytes } from "@rodrigo-barraza/utilities-library";
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
declare function matchesAny(nameLower: Record<string, unknown>, patterns: Record<string, unknown>): any;
/**
 * Detect capabilities for a model based on its name and provider metadata.


 * @returns {object} Detected capabilities
 */
declare function detectCapabilities(modelKey: Record<string, unknown>, providerMeta?: Record<string, unknown>): {
    thinking: any;
    functionCalling: any;
    vision: any;
    video: any;
    audio: any;
    tools: Record<string, unknown>[];
    inputTypes: string[];
    outputTypes: string[];
};
/** Format a total parameter count into a human-readable string. */
declare function formatParams(totalParams: Record<string, unknown>): string | null;
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
declare function fetchHuggingFaceMetadata(modelId: Record<string, unknown>): Promise<any>;
/**
 * Enrich a model entry with HuggingFace metadata if the model ID
 * looks like a HF model path (has a slash: "org/model-name").
 */
declare function enrichWithHuggingFace(entry: Record<string, unknown>, modelKey: Record<string, unknown>): Promise<Record<string, unknown>>;
/**
 * Normalize an LM Studio model into a canonical model entry.
 * LM Studio's /api/v1/models returns rich metadata including
 * type, capabilities, quantization, architecture, and load state.
 */
declare function normalizeLmStudioModel(raw: Record<string, unknown>): {
    name: unknown;
    label: unknown;
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
declare function normalizeOllamaModel(raw: Record<string, unknown>): {
    name: unknown;
    label: unknown;
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
declare function normalizeOpenAICompatModel(raw: Record<string, unknown>): {
    name: unknown;
    label: unknown;
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
declare function normalizeVllmModel(raw: Record<string, unknown>): {
    name: unknown;
    label: unknown;
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
    isLocal(providerOrInstanceId: Record<string, unknown>): boolean;
    /**
     * Check whether a provider uses native MCP tool execution.
     * These providers handle multi-step tool calling internally — the
     * agentic loop should only feed tools on the first pass.
  
  
     */
    isNativeMCP(providerOrInstanceId: Record<string, unknown>): boolean;
    /**
     * Check whether a provider should default thinkingEnabled=true
     * when the client doesn't explicitly set it.
  
  
     */
    defaultsThinkingEnabled(providerOrInstanceId: Record<string, unknown>): boolean;
    /**
     * Check whether a provider supports model management (load/unload).
  
  
     */
    supportsModelManagement(providerOrInstanceId: Record<string, unknown>): boolean;
    /**
     * Resolve the base provider type from any instance ID.
     * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
     * Returns null for non-local providers.
  
  
     */
    getProviderType(providerOrInstanceId: Record<string, unknown>): string | Record<string, unknown> | null;
    /**
     * Get all registered local provider instances.
     * @returns {Array<{ id: string, type: string, instanceNumber: number, concurrency: number }>}
     */
    getInstances(): {
        id: unknown;
        type: unknown;
        instanceNumber: unknown;
        concurrency: unknown;
    }[];
    /**
     * Get instances of a specific provider type.
  
  
     */
    getInstancesByType(type: Record<string, unknown>): import("../types/ProviderTypes.ts").InstanceEntry[];
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
        byType: {};
        byInstance: {};
    };
    /**
     * Discover all models across all local provider instances.
     * Results are normalized into a canonical format and enriched
     * with capability detection and (optionally) HuggingFace metadata.
     *
  
  
     * @returns {Promise<{ [instanceId: string]: object[] }>} Normalized models grouped by instance
     */
    discoverModels({ timeoutMs, enrich }?: Record<string, unknown>): Promise<{}>;
    /**
     * Discover models for a single instance.
  
  
     * @returns {Promise<object[]>} Normalized model entries
     */
    discoverModelsForInstance(instanceId: Record<string, unknown>, { timeoutMs, enrich }?: Record<string, unknown>): Promise<any[]>;
    /**
     * Internal: Fetch, normalize, and optionally enrich models for an instance.
     * @private
     */
    _fetchModelsForInstance(inst: Record<string, unknown>, timeoutMs: Record<string, unknown>, enrich: Record<string, unknown>): Promise<any[]>;
    /**
     * Search for models across all local providers matching a capability filter.
     *
  
  
     * @returns {Promise<Array<{ instanceId: string, model: object }>>}
     */
    searchModels(filter?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
    /**
     * Check if a model entry matches the given filter criteria.
     * @private
     */
    _matchesFilter(model: Record<string, unknown>, filter: Record<string, unknown>): boolean;
    /**
     * Get aggregate statistics across all local providers.
  
     */
    getStats(): Promise<{
        instances: number;
        totalModels: number;
        loadedModels: number;
        conversationModels: number;
        embeddingModels: number;
        modelsByInstance: {};
        modelsByType: {};
        capabilityDistribution: {
            thinking: number;
            functionCalling: number;
            vision: number;
            video: number;
            audio: number;
        };
        concurrency: {
            total: number;
            byType: {};
            byInstance: {};
        };
    }>;
    /**
     * Resolve which provider instance serves a given model.
     * Queries each instance's model list and returns the first match.
     *
  
  
     * @returns {Promise<{ instanceId: string, type: string, provider: object } | null>}
     */
    resolveProvider(modelName: Record<string, unknown>, { timeoutMs }?: Record<string, unknown>): Promise<{
        instanceId: unknown;
        type: unknown;
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
    checkHealth(timeoutMs?: Record<string, unknown>): Promise<{}>;
    /**
     * Estimate VRAM usage for a GGUF model served by a local provider.
     * Primarily useful for LM Studio models that report GGUF metadata.
     *
  
  
     * @returns {{ gpuGiB: number, totalGiB: number, cpuOffloaded: boolean, archParams: object, totalLayers: number } | null}
     */
    estimateVRAM(modelData: Record<string, unknown>, options?: Record<string, unknown>): {
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
    estimateVRAMForModel(instanceId: Record<string, unknown>, modelKey: Record<string, unknown>, options?: Record<string, unknown>): Promise<{
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
    loadModel(instanceId: Record<string, unknown>, modelKey: Record<string, unknown>, options: Record<string, unknown> | undefined, signal: Record<string, unknown>): Promise<any>;
    /**
     * Ensure a specific model is loaded on a specific instance.
     * Handles unloading of other models if necessary (single-model enforcement).
     *
  
  
     * @returns {Promise<{ alreadyLoaded: boolean, contextLength: number|null }>}
     */
    ensureModelLoaded(instanceId: Record<string, unknown>, modelKey: Record<string, unknown>, options: Record<string, unknown> | undefined, signal: Record<string, unknown>, onStatus: Record<string, unknown>): Promise<any>;
    /**
     * Unload a model from a specific instance.
     *
  
  
     */
    unloadModel(instanceId: Record<string, unknown>, modelInstanceId: Record<string, unknown>): Promise<any>;
    /**
     * Apply local provider defaults to the options object.
     * This handles the "thinking enabled by default" behavior
     * and any other provider-specific option normalization.
     *
     * Call this during request preparation (prepareGenerationContext).
     *
  
  
     * @returns {object} The mutated options object (for chaining)
     */
    applyLocalDefaults(providerName: Record<string, unknown>, options: Record<string, unknown>, clientParams?: Record<string, unknown>): Record<string, unknown>;
    /**
     * Generate text (non-streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
  
  
     * @returns {Promise<{ text: string, thinking: string|null, usage: object }>}
     */
    generateText(messages: Record<string, unknown>, model: Record<string, unknown>, options: Record<string, unknown> | undefined, instanceId: Record<string, unknown>): Promise<any>;
    /**
     * Generate text (streaming) via a local provider.
     * Auto-resolves the provider if only a model name is given.
     *
  
  
     */
    generateTextStream(messages: Record<string, unknown>, model: Record<string, unknown>, options: Record<string, unknown> | undefined, instanceId: Record<string, unknown>): AsyncGenerator<any, void, any>;
    /**
     * Generate an embedding via a local provider.
     *
  
  
     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    generateEmbedding(content: string, model: Record<string, unknown>, options: Record<string, unknown> | undefined, instanceId: Record<string, unknown>): Promise<any>;
    /**
     * Caption an image via a local provider.
     *
  
  
     * @returns {Promise<{ text: string, usage: object }>}
     */
    captionImage(images: Record<string, unknown>, prompt: Record<string, unknown>, model: Record<string, unknown>, systemPrompt: Record<string, unknown>, instanceId: Record<string, unknown>): Promise<any>;
    /**
     * Get the provider for a model, either by explicit instance or auto-routing.
     * @private
     */
    _getProviderForModel(model: Record<string, unknown>, instanceId: Record<string, unknown>): Promise<any>;
}
declare const gateway: LocalProviderGateway;
export default gateway;
export { LOCAL_PROVIDER_TYPES, NATIVE_MCP_TYPES, DEFAULT_THINKING_TYPES, MODEL_MANAGEMENT_TYPES, THINKING_PATTERNS, FC_PATTERNS, VISION_PATTERNS, VIDEO_PATTERNS, AUDIO_PATTERNS, matchesAny, detectCapabilities, formatBytes, formatParams, parseParamsFromName, parseQuantFromName, parsePublisherFromName, fetchHuggingFaceMetadata, enrichWithHuggingFace, normalizeLmStudioModel, normalizeOllamaModel, normalizeOpenAICompatModel, normalizeVllmModel, NORMALIZER_BY_TYPE, HF_ENRICHED_TYPES, };
//# sourceMappingURL=LocalProviderGateway.d.ts.map
/**
 * Extract the base model name from a GGUF model key by stripping the
 * quantization suffix. Handles both path-style and flat-style keys.
 *
 * Examples:
 *   "qwen3-32b@q4_k_m" → { base: "qwen3-32b", quant: "Q4_K_M" }
 *   "lmstudio-community/qwen3-32b-GGUF/qwen3-32b-Q8_0.gguf"
 *     → { base: "lmstudio-community/qwen3-32b-GGUF/qwen3-32b", quant: "Q8_0" }
 *

 * @returns {{ base: string, quant: string|null }}
 */
export declare function parseModelQuant(modelKey: any): {
    base: any;
    quant: any;
};
/**
 * Find the best available variant of a model among the available models
 * on a specific instance. Ranks by `size_bytes` (file size on disk) —
 * the largest file is the highest-quality quantization.
 *

 * @param {Array<{key?: string, id?: string, size_bytes?: number}>} availableModels - Models on the instance
 * @returns {string|null} The best available model key (by file size), or null
 */
export declare function findBestQuantFallback(targetModel: any, availableModels: any): any;
/**
 * Resolve model availability across multiple provider instances.
 * Returns only the instances where the model (or a quant variant) exists,
 * along with per-instance model overrides when a quant fallback is used.
 *
 * This is the same logic the CoordinatorService uses for worker agents.
 *

 * @param {Array<{id: string, concurrency: number}>} siblings - All instances of this provider type
 * @returns {Promise<{ usable: Array<{id: string, concurrency: number}>, modelOverrides: Map<string, string> }>}
 */
export declare function resolveModelForInstances(modelKey: any, siblings: any): Promise<{
    usable: any;
    modelOverrides: Map<any, any>;
}>;
//# sourceMappingURL=ModelResolution.d.ts.map
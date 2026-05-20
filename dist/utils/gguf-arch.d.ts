/**
 * Resolve architecture parameters for a GGUF model.
 *
 * @param {string|null} architecture — GGUF architecture name (e.g. "qwen3", "granitehybrid")
 * @param {string|null} paramsString — e.g. "9B", "26B-A4B"
 * @param {number} sizeBytes — file size in bytes
 * @param {number} [bitsPerWeight=4] — quantization bits per weight
 * @returns {{ layers: number, kvHeads: number, headDim: number, attnRatio: number, isKnown: boolean }}
 */
export declare function resolveArchParams(architecture: any, paramsString: any, sizeBytes: any, bitsPerWeight?: any): {
    layers: any;
    kvHeads: any;
    headDim: any;
    attnRatio: any;
    isKnown: boolean;
};
/**
 * Estimate VRAM usage for a GGUF model.
 *
 * Overhead constants calibrated against real RTX 4090 benchmark data
 * (38 models, flash_attention=true, offload_kv_cache=true, 4096 ctx).
 *
 * Key findings from calibration (2026-04-03):
 *   - CUDA context + compute buffers ≈ 0.8 GiB (was 0.5)
 *   - Small models (<3GB file) have ~0.4 GiB extra proportional overhead
 *   - Vision models carry an encoder surcharge (~0.7–1.0 GiB)
 *   - Models near VRAM limits get partially CPU-offloaded by LM Studio
 *     silently, so raw estimate can exceed actual usage by 1–3 GiB
 *

 * @param {number} opts.sizeBytes — model file size in bytes
 * @param {object} opts.archParams — resolved architecture params { layers, kvHeads, headDim, attnRatio }
 * @param {number} opts.gpuLayers — number of layers offloaded to GPU
 * @param {number} opts.contextLength — context length in tokens
 * @param {boolean} [opts.offloadKvCache=true] — whether KV cache is on GPU
 * @param {boolean} [opts.flashAttention=true] — flash attention enabled (Q8_0 KV vs FP32)
 * @param {boolean} [opts.vision=false] — model includes a vision encoder
 * @param {number} [opts.gpuTotalGiB] — total GPU VRAM in GiB (for auto-offload clamping)
 * @param {number} [opts.gpuBaselineGiB=0] — VRAM already used (displays, desktop, etc.)
 * @returns {{ gpuGiB: number, totalGiB: number, cpuOffloaded: boolean }}
 */
export declare function estimateMemory({ sizeBytes, archParams, gpuLayers, contextLength, offloadKvCache, flashAttention, vision, gpuTotalGiB, gpuBaselineGiB, }: any): {
    gpuGiB: number;
    totalGiB: number;
    cpuOffloaded: boolean;
};
//# sourceMappingURL=gguf-arch.d.ts.map
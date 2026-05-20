// ─────────────────────────────────────────────────────────────
// Model Resolution Utilities
// ─────────────────────────────────────────────────────────────
// Shared by the /chat route load balancer and CoordinatorService.
// Handles GGUF quantization-aware model matching across instances.

import logger from "./logger.ts";
import { getProvider } from "../providers/index.ts";

/**
 * Regex to match GGUF quantization suffixes.
 * Captures the quant tag (e.g. "Q8_0", "IQ4_XS", "F16", "BF16").
 */
const GGUF_QUANT_SUFFIX_RE =
  /[-_]((?:I?Q[0-9]+(?:_[A-Z0-9]+)*|[BF](?:16|32)))(?:\.gguf)?$/i;

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
export function parseModelQuant(modelKey: any) {
  // Handle @quant suffix (e.g. "qwen3-32b@q4_k_m")
    if ((modelKey as any).includes("@")) {
        const [base, quant] = (modelKey as any).split("@");
    return { base, quant: quant.toUpperCase() };
  }

  // Handle GGUF path-style keys — strip .gguf, then match the quant suffix via regex
    const stripped = (modelKey as any).replace(/\.gguf$/i, "");
  const match = stripped.match(GGUF_QUANT_SUFFIX_RE);
  if (match) {
    const quant = match[1].toUpperCase();
    const base = stripped.slice(0, match.index);
    return { base, quant };
  }

  return { base: modelKey, quant: null };
}

/**
 * Find the best available variant of a model among the available models
 * on a specific instance. Ranks by `size_bytes` (file size on disk) —
 * the largest file is the highest-quality quantization.
 *

 * @param {Array<{key?: string, id?: string, size_bytes?: number}>} availableModels - Models on the instance
 * @returns {string|null} The best available model key (by file size), or null
 */
export function findBestQuantFallback(targetModel: any, availableModels: any) {
  const { base: targetBase, quant: targetQuant } = parseModelQuant(targetModel);

  // Find all available models that share the same base name (any quant variant)
  const candidates: any[] = [];
    for ( const m of availableModels) {
    const mKey = m.key || m.id;
    const { base, quant } = parseModelQuant(mKey);

    // Compare bases case-insensitively.
    // GGUF paths have long bases like "lmstudio-community/Qwen3.6-27B-GGUF/Qwen3.6-27B"
    // while @quant syntax produces short bases like "qwen3.6-27b". When a direct
    // comparison fails, try matching just the last path segment (actual model name).
    const baseLower = base.toLowerCase();
    const targetBaseLower = targetBase.toLowerCase();
    if (baseLower !== targetBaseLower) {
      const baseLeaf = baseLower.split("/").pop();
      const targetLeaf = targetBaseLower.split("/").pop();
      if (baseLeaf !== targetLeaf) continue;
    }

    // Skip exact same key (already checked before calling this)
    if (mKey === targetModel) continue;
    // Skip identical quant (both could be null for no-quant keys)
    if (quant === targetQuant) continue;

    candidates.push({ key: mKey, quant, sizeBytes: m.size_bytes || 0 });
  }

  if (candidates.length === 0) return null;

  // Sort by file size descending — largest file = highest quality quant
    candidates.sort((a: any, b: any) => (b as any).sizeBytes - (a as any).sizeBytes);
  return candidates[0].key;
}

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
export async function resolveModelForInstances(modelKey: any, siblings: any) {
  /** @type {Map<string, string>} Per-instance model override (when quant fallback is used) */
  const modelOverrides = new Map();

  try {
    const checks = await Promise.allSettled(
            (siblings as any).map(async (inst: any) => {
                const provider = getProvider((inst.id as any));
        if (!provider?.listModels) return { exact: false, fallback: null };
        const result = await Promise.race([
          provider.listModels(),
                    new Promise(((_: any, rej: any) =>
                                            setTimeout(() => rej(new Error("timeout")), 3000) as any as (resolve: (value: any) => void, reject: (reason?: any) => void) => void),
          ),
        ]);
        const models = result?.models || result?.data || [];
        const modelKeys = models.map((m: any) => m.key || m.id);
        const exactMatch = modelKeys.includes(modelKey);
        if (exactMatch) return { exact: true, fallback: null };

        // No exact key match — find the best variant with the same base name
        logger.info(
          `[ModelResolution] ${inst.id}: no exact match for "${modelKey}" — available: [${modelKeys.join(", ")}]`,
        );
        const fallback = findBestQuantFallback(modelKey, models);
        return { exact: false, fallback };
      }),
    );

    // Build usable instances list
    const usable: any[] = [];
        for (let i = 0; i < (siblings as any).length; i++) {
      if (checks[i].status !== "fulfilled") continue;
            const { exact, fallback } = checks[i].value;

      if (exact) {
                usable.push((siblings[i] as any));
      } else if (fallback) {
                modelOverrides.set((siblings as any)[i].id, fallback);
                usable.push((siblings[i] as any));
      }
    }

    const summary = usable
      .map((s: any) => {
        const override = modelOverrides.get(s.id);
        return override ? `${s.id}→"${override}"` : `${s.id} (exact)`;
      })
      .join(", ");
    logger.info(
      `[ModelResolution] Model "${modelKey}": ${usable.length}/${siblings.length} instances usable [${summary}]`,
    );

    return { usable, modelOverrides };
  } catch (error: any) {
    logger.warn(
            `[ModelResolution] Model availability check failed: ${(error as Error).message}`,
    );
    return { usable: siblings, modelOverrides };
  }
}

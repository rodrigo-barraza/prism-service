// @ts-ignore
export { cosineSimilarity } from "@rodrigo-barraza/utilities-library";

/** Cap — anything above this is a measurement artifact */
const MAX_TOKENS_PER_SEC = 10_000;

/**
 * Calculate tokens-per-second throughput (tok/s).
 *
 * Centralised formula used by every request logger in the codebase.
 * Pass a provider-reported value in `opts.providerReported` to prefer
 * it over manual computation, and `opts.fallbackSec` to use totalSec
 * when generationSec is unavailable.
 *


 * @returns {number|null} Rounded to 1 decimal, or null if not computable
 */
export function calculateTokensPerSec(tokens: Record<string, unknown>, sec: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  // 1. Provider-reported value takes priority
  // @ts-ignore
  if (opts.providerReported != null && opts.providerReported > 0) {
    // @ts-ignore
    const value = parseFloat(opts.providerReported.toFixed(1));
    return value > MAX_TOKENS_PER_SEC ? null : value;
  }

  // 2. Determine effective duration
  const effectiveSec =
    // @ts-ignore
    sec && sec > 0.001
      ? sec
      // @ts-ignore
      : opts.fallbackSec && opts.fallbackSec > 0
        // @ts-ignore
        ? opts.fallbackSec
        : null;

  // @ts-ignore - TODO: strict typing
  if (!effectiveSec || !tokens || tokens <= 0) return null;

  // @ts-ignore - TODO: strict typing
  const value = parseFloat((tokens / effectiveSec).toFixed(1));
  return value > MAX_TOKENS_PER_SEC ? null : value;
}

export { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
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
export declare function calculateTokensPerSec(tokens: any, sec: any, opts?: any): number | null;
//# sourceMappingURL=math.d.ts.map
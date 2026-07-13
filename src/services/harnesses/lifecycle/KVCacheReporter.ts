import logger from "#src/utils/logger";
import type { UsageAccumulator } from "#src/services/harnesses/types";

/**
 * KVCacheReporter — per-iteration KV cache hit rate diagnostics.
 *
 * Logs the breakdown of input tokens vs cached (KV cache hit) tokens
 * after each LLM call, enabling operators to diagnose whether the
 * append-only prefix property is being preserved across iterations.
 *
 * A high cache hit rate (>80%) indicates the provider is reusing
 * the KV cache from previous iterations. A low rate suggests prefix
 * mutation (e.g., unconditional micro-compaction) is invalidating
 * the cache and forcing expensive full re-prefills.
 *
 * Extracted from ReActHarness (lines 376–389) for cross-harness reuse.
 */

/**
 * Log KV cache hit rate for the current iteration.
 *
 * Only emits a log line when there is meaningful cache data to report
 * (iteration > 1 or cached tokens > 0), avoiding noise on first pass.
 */
export function logKVCacheHitRate(
  passUsage: UsageAccumulator,
  iteration: number,
  harnessLabel: string,
): void {
  const finalInputTokens = passUsage.inputTokens || passUsage.promptTokens || 0;
  const cachedInputTokens = passUsage.cacheReadInputTokens || 0;
  const totalPromptTokens = finalInputTokens + cachedInputTokens;

  if (iteration > 1 || cachedInputTokens > 0) {
    const cacheHitPercentage =
      totalPromptTokens > 0
        ? ((cachedInputTokens / totalPromptTokens) * 100).toFixed(1)
        : "0.0";
    logger.info(
      `[${harnessLabel}] Iteration ${iteration} KV cache: ` +
        `input=${finalInputTokens}, cached=${cachedInputTokens}, ` +
        `total=${totalPromptTokens}, hit=${cacheHitPercentage}%`,
    );
  }

  // Wasted-write signature: from iteration 2 on, a large cache WRITE with a
  // ZERO cache read means the previous iteration's cache write was thrown
  // away (prefix mutated — e.g. a mid-loop tool-set change) and the full
  // prefix is being re-prefilled at the cache-write premium.
  const cacheWriteTokens = passUsage.cacheCreationInputTokens || 0;
  if (iteration >= 2 && cacheWriteTokens > 0 && cachedInputTokens === 0) {
    logger.warn(
      `[${harnessLabel}] Iteration ${iteration} re-wrote ${cacheWriteTokens} ` +
        `prefix tokens with ZERO cache reads — the previous iteration's cache ` +
        `write was wasted (prefix mutation: tool-set change, system-prompt ` +
        `edit, or history rewrite).`,
    );
  }
}

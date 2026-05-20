/**
 * Estimate token count from a text string using the ~4 chars/token heuristic.
 * Accurate enough for budget enforcement without requiring a real tokenizer.
 *


 */
export declare function estimateTokens(text: Record<string, unknown>): number;
/**
 * Get the total input token count from a usage object.
 * Providers like Anthropic and Google split prompt tokens into
 * new + cache_read + cache_write. This aggregates all three.
 *
 * @param {{ inputTokens?: number, cacheReadInputTokens?: number, cacheCreationInputTokens?: number }} usage

 */
export declare function getTotalInputTokens(usage: Record<string, unknown>): any;
/**
 * Create a fresh usage accumulator object with all token fields zeroed.
 * @returns {{ inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, reasoningOutputTokens: number }}
 */
export declare function createUsageAccumulator(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens: number;
};
/**
 * Merge a provider-reported usage chunk into an accumulator (mutates target).
 * Centralises the `target.X += source.X || 0` pattern that was duplicated
 * across AgenticLoopService, chat.js, and StreamChunkDispatcher.
 *


 * @returns {object} The target accumulator (for chaining)
 */
export declare function mergeUsage(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown>;
/**
 * Calculate the estimated cost for a text-to-text request.
 * Supports Anthropic prompt caching: cache reads at reduced rate,
 * cache writes at premium rate.
 *
 * @param {{ inputTokens: number, outputTokens: number, cacheReadInputTokens?: number, cacheCreationInputTokens?: number }} usage
 * @param {{ inputPerMillion: number, outputPerMillion: number, cachedInputPerMillion?: number, cacheWriteInputPerMillion?: number }} pricing
 * @returns {number|null} Cost in USD, or null if pricing is unavailable.
 */
export declare function calculateTextCost(usage: Record<string, unknown>, pricing: Record<string, unknown>): number | null;
/**
 * Calculate the estimated cost for an audio-to-text request.
 * Supports two strategies — per-minute pricing takes priority.
 *
 * @param {{ durationSeconds?: number, inputTokens?: number, outputTokens?: number }} usage
 * @param {{ perMinute?: number, audioInputPerMillion?: number, outputPerMillion?: number }} pricing
 * @returns {number|null} Cost in USD, or null if pricing is unavailable.
 */
export declare function calculateAudioCost(usage: Record<string, unknown>, pricing: Record<string, unknown>): number | null;
/**
 * Calculate the estimated cost for a Live API session turn.
 * The Live API streams audio in and out, so input tokens should
 * use audioInputPerMillion and output tokens should use
 * audioOutputPerMillion when available.
 *
 * @param {{ inputTokens: number, outputTokens: number }} usage
 * @param {{ inputPerMillion?: number, audioInputPerMillion?: number, outputPerMillion?: number, audioOutputPerMillion?: number }} pricing
 * @returns {number|null} Cost in USD, or null if pricing is unavailable.
 */
export declare function calculateLiveCost(usage: Record<string, unknown>, pricing: Record<string, unknown>): number | null;
/**
 * Calculate the estimated cost for a text-to-image request.
 * Estimates input tokens from prompt length (~4 chars per token).
 * Output image tokens vary by provider and resolution:
 *   - Google 512px ≈ 747 tokens, 1024px ≈ 1120 tokens, 2048px ≈ 1680 tokens, 4096px ≈ 2520 tokens
 *   - OpenAI 1024×1024 high-quality ≈ 1056 tokens
 *

 * @param {{ inputPerMillion?: number, outputPerMillion?: number, imageOutputPerMillion?: number, imageInputPerMillion?: number }} pricing


 * @returns {number|null} Cost in USD, or null if pricing is unavailable.
 */
export declare function calculateImageCost(prompt: Record<string, unknown>, pricing: Record<string, unknown>, inputImages?: Record<string, unknown>, outputImageTokens?: Record<string, unknown>): number | null;
//# sourceMappingURL=CostCalculator.d.ts.map
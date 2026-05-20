/**
 * RateLimitStore — In-memory cache of latest provider rate-limit data.
 *
 * Updated dynamically from each OpenAI/Anthropic API response.
 * Rate limits are per-model (both OpenAI and Anthropic enforce limits
 * separately for each model). Google uses static tier limits.
 *
 * Call `.update(providerName, model, rateLimits)` after every API response.
 * Call `.getAll()` to get a snapshot of all providers/models.
 */
declare class RateLimitStore {
    constructor();
    /**
     * Update the stored rate-limit snapshot for a provider + model.
     * Called after every API response that contains rate-limit headers.
     *
  
  
     */
    update(providerName: Record<string, unknown>, model: Record<string, unknown>, rateLimits: Record<string, unknown>): void;
    /**
     * Get a snapshot of all provider rate limits, grouped by provider.
     *
     * Returns:
     * {
     *   openai: { dynamic: true, models: { "gpt-5": { rateLimits, updatedAt }, ... } },
     *   anthropic: { dynamic: true, models: { "claude-opus-4": { ... }, ... } },
     *   google: { dynamic: false, note: "...", models: { "gemini-3-flash": { rpm, tpm, rpd }, ... } },
     * }
     */
    getAll(): {};
}
declare const rateLimitStore: RateLimitStore;
export default rateLimitStore;
//# sourceMappingURL=RateLimitStore.d.ts.map
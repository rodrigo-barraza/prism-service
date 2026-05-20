declare const SessionGenerationTracker: {
    /**
     * Register a new LLM request for tracking.
     *
  
  
     * @param {string} meta.provider
     * @param {string} meta.model
  
  
     */
    register(agentSessionId: Record<string, unknown>, requestId: Record<string, unknown>, { provider, model, source, workerId }?: Record<string, unknown>): void;
    /**
     * Update a tracked request with new token data.
     * Called on each chunk/thinking event or on usage completion.
     *
  
  
     */
    update(requestId: Record<string, unknown>, { outputTokens, inputTokens, ttft }?: Record<string, unknown>): void;
    /**
     * Record chunk timing, increment the chunk counter, and accumulate
     * output characters for token estimation.
     *
     * The character count provides a much more accurate token estimate
     * than raw chunk count: Anthropic sends large thinking deltas
     * (50-200+ chars) as a single chunk, so chunkCount severely
     * undercounts tokens. Using `outputCharacters / 4` (~4 chars/token
     * for English) gives a reliable cross-provider heuristic.
     *
  
  
     */
    recordChunkTiming(requestId: Record<string, unknown>, charCount?: Record<string, unknown>): void;
    /**
     * Mark a request as complete and remove it from active tracking.
     * Rolls the request's final token counts and computed tok/s into
     * the session accumulator so cumulative totals remain monotonically
     * non-decreasing.
     *
  
     */
    complete(requestId: Record<string, unknown>): void;
    /**
     * Compute aggregate stats for all active requests in a session.
     *
     * Rate computation uses a warm-up guard: tok/s is only reported once
     * a request has accumulated at least MIN_TOKENS_FOR_RATE tokens over
     * at least MIN_ELAPSED_SEC seconds. This prevents anomalous spikes
     * from single large chunks arriving in near-zero elapsed time.
     *
  
     * @returns {{
     *   tokPerSec: number|null,
     *   activeRequests: number,
     *   totalOutputTokens: number,
     *   totalInputTokens: number,
     *   totalTokens: number,
     *   avgTtft: number|null,
     * }}
     */
    getSessionStats(agentSessionId: Record<string, unknown>): {
        tokPerSec: number | null;
        activeRequests: any;
        totalOutputTokens: any;
        totalInputTokens: any;
        totalTokens: any;
        avgTtft: number | null;
    };
    /**
     * Clean up all tracking data for a session.
     *
  
     */
    cleanup(agentSessionId: Record<string, unknown>): void;
    /**
     * Check if a session has Record<string, unknown> active requests.
     *
  
  
     */
    hasActiveRequests(agentSessionId: Record<string, unknown>): boolean;
    /** Total active requests across all sessions (for diagnostics). */
    readonly totalActiveRequests: number;
};
export default SessionGenerationTracker;
//# sourceMappingURL=SessionGenerationTracker.d.ts.map
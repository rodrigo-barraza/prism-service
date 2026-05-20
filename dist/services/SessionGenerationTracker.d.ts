declare const SessionGenerationTracker: {
    /**
     * Register a new LLM request for tracking.
     *
  
  
     * @param {string} meta.provider
     * @param {string} meta.model
  
  
     */
    register(agentSessionId: any, requestId: any, { provider, model, source, workerId }?: any): void;
    /**
     * Update a tracked request with new token data.
     * Called on each chunk/thinking event or on usage completion.
     *
  
  
     */
    update(requestId: any, { outputTokens, inputTokens, ttft }?: any): void;
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
    recordChunkTiming(requestId: any, charCount?: any): void;
    /**
     * Mark a request as complete and remove it from active tracking.
     * Rolls the request's final token counts and computed tok/s into
     * the session accumulator so cumulative totals remain monotonically
     * non-decreasing.
     *
  
     */
    complete(requestId: any): void;
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
    getSessionStats(agentSessionId: any): {
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
    cleanup(agentSessionId: any): void;
    /**
     * Check if a session has any active requests.
     *
  
  
     */
    hasActiveRequests(agentSessionId: any): boolean;
    /** Total active requests across all sessions (for diagnostics). */
    readonly totalActiveRequests: number;
};
export default SessionGenerationTracker;
//# sourceMappingURL=SessionGenerationTracker.d.ts.map
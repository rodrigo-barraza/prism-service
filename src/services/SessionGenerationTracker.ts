// ─────────────────────────────────────────────────────────────
// SessionGenerationTracker
// ─────────────────────────────────────────────────────────────
// Per-session in-memory tracker for active LLM requests.
// Tracks token throughput at the source (backend provider level)
// so the frontend receives authoritative tok/s data instead of
// computing rates from SSE chunk inter-arrival times.
//
// Each active LLM request registers itself here with timing and
// token data. The aggregate session tok/s is computed on demand
// from all active requests — covering the coordinator, workers,
// and tool sub-requests (e.g. generate_image → Prism /chat).
//
// Tracked metrics per request:
//   - outputTokens  (incremental, per chunk/thinking)
//   - inputTokens   (set once, from provider usage report)
//   - ttft          (time to first token, seconds)
//
// Session-level accumulators persist across request completions
// so cumulative counts never decrease.
// ─────────────────────────────────────────────────────────────

// ── Rate computation guards ─────────────────────────────────
// Prevent anomalous spikes from single large chunks or very
// short elapsed windows. Rate is only reported once enough
// samples have accumulated to produce a statistically meaningful
// average. The token estimate (~4 chars/token) can massively
// overcount on large thinking deltas, so we need a generous
// window to let the rate stabilize before reporting.
const MIN_ELAPSED_SEC = 0.5; // 500ms minimum sample window
const MIN_TOKENS_FOR_RATE = 10; // minimum tokens before reporting rate

/**
 * @typedef {object} ActiveRequest
 * @property {string} requestId
 * @property {string} agentSessionId
 * @property {number} startTime        - performance.now() when request began
 * @property {number} firstTokenTime   - performance.now() of first token (null until first token)
 * @property {number} lastTokenTime    - performance.now() of most recent token
 * @property {number} outputTokens     - running output token count (per-iteration)
 * @property {number} chunkCount       - running count of streamed chunks
 * @property {number} outputCharacters - cumulative output character count (used for token estimation)
 * @property {number} inputTokens      - input token count (set from provider usage)
 * @property {number|null} ttft        - time to first token in seconds (null until first token)
 * @property {string} provider
 * @property {string} model
 * @property {string} source           - "orchestrator" | "worker" | "tool-sub-request"
 * @property {string|null} workerId    - worker agent ID (null for orchestrator/sub-requests)
 */

/** @type {Map<string, ActiveRequest>} requestId → ActiveRequest */
const activeRequests = new Map();

/** @type {Map<string, Set<string>>} agentSessionId → Set<requestId> */
const sessionIndex = new Map();

/**
 * @typedef {object} SessionAccumulator
 * @property {number} completedOutputTokens   - cumulative output tokens from completed requests
 * @property {number} completedInputTokens    - cumulative input tokens from completed requests
 * @property {number[]} ttftSamples           - TTFT values (seconds) from each completed request
 * @property {number[]} completedTokPerSecSamples - tok/s from each completed request
 */

/** @type {Map<string, SessionAccumulator>} agentSessionId → cumulative session counters */
const sessionAccumulators = new Map();

const SessionGenerationTracker = ({
  /**
   * Register a new LLM request for tracking.
   *


   * @param {string} meta.provider
   * @param {string} meta.model


   */
    register(
    agentSessionId: any,
    requestId: any,
        { provider, model, source = "orchestrator", workerId = null }: any = {},
  ) {
    if (!agentSessionId || !requestId) return;

    const entry = {
      requestId,
      agentSessionId,
      startTime: performance.now(),
      firstTokenTime: null,
      lastTokenTime: null,
      outputTokens: 0,
      chunkCount: 0,
      outputCharacters: 0,
      inputTokens: 0,
      ttft: null,
      provider: provider || "any",
      model: model || "any",
      source,
      workerId,
    };

    activeRequests.set(requestId, entry);

    // Maintain session → requests index
    if (!sessionIndex.has(agentSessionId)) {
      sessionIndex.set(agentSessionId, new Set());
    }
    sessionIndex.get(agentSessionId).add(requestId);

    // Initialize session accumulator (idempotent — preserves across iterations)
    if (!sessionAccumulators.has(agentSessionId)) {
      sessionAccumulators.set(agentSessionId, {
        completedOutputTokens: 0,
        completedInputTokens: 0,
        ttftSamples: [],
        completedTokPerSecSamples: [],
      });
    }
  },

  /**
   * Update a tracked request with new token data.
   * Called on each chunk/thinking event or on usage completion.
   *


   */
    update(requestId: any, { outputTokens, inputTokens, ttft }: any = {}) {
    const entry = activeRequests.get(requestId);
    if (!entry) return;

    const now = performance.now();
    if (!entry.firstTokenTime) entry.firstTokenTime = now;
    entry.lastTokenTime = now;

    if (outputTokens != null) {
      entry.outputTokens = outputTokens;
    }
    if (inputTokens != null) {
      entry.inputTokens = inputTokens;
    }
    if (ttft != null) {
      entry.ttft = ttft;
    }
  },

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
    recordChunkTiming(requestId: any, charCount: any = 0) {
    const entry = activeRequests.get(requestId);
    if (!entry) return;
    const now = performance.now();
    if (!entry.firstTokenTime) entry.firstTokenTime = now;
    entry.lastTokenTime = now;
    entry.chunkCount++;
    entry.outputCharacters += charCount;
  },

  /**
   * Mark a request as complete and remove it from active tracking.
   * Rolls the request's final token counts and computed tok/s into
   * the session accumulator so cumulative totals remain monotonically
   * non-decreasing.
   *

   */
  complete(requestId: any) {
    const entry = activeRequests.get(requestId);
    if (!entry) return;

    // Use provider-reported output tokens when available (authoritative).
    // Fall back to chars/4 estimation when the provider didn't report usage
    // (e.g. OpenAI response.completed event intermittently missing).
    const effectiveOutputTokens =
      entry.outputTokens > 0
        ? entry.outputTokens
        : entry.outputCharacters > 0
          ? Math.ceil(entry.outputCharacters / 4)
          : 0;

    // Compute this request's tok/s from the effective token count and
    // the timing window captured during streaming.
    let requestTokPerSec = null;
    if (
      effectiveOutputTokens > 0 &&
      entry.firstTokenTime &&
      entry.lastTokenTime
    ) {
      const elapsed = (entry.lastTokenTime - entry.firstTokenTime) / 1000;
      if (elapsed >= MIN_ELAPSED_SEC) {
        requestTokPerSec = effectiveOutputTokens / elapsed;
      }
    }

    // Roll completed metrics into the session accumulator
    const acc = sessionAccumulators.get(entry.agentSessionId);
    if (acc) {
      acc.completedOutputTokens += effectiveOutputTokens;
      acc.completedInputTokens += entry.inputTokens;
      if (entry.ttft != null) {
        acc.ttftSamples.push(entry.ttft);
      }
      // Persist tok/s so it survives across iteration boundaries
      if (requestTokPerSec != null) {
        acc.completedTokPerSecSamples.push(requestTokPerSec);
      }
    }

    activeRequests.delete(requestId);

    const sessionSet = sessionIndex.get(entry.agentSessionId);
    if (sessionSet) {
      sessionSet.delete(requestId);
      if (sessionSet.size === 0) sessionIndex.delete(entry.agentSessionId);
    }
  },

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
  getSessionStats(agentSessionId: any) {
    const requestIds = sessionIndex.get(agentSessionId);
    const acc = sessionAccumulators.get(agentSessionId);
    const completedOutputTokens = acc?.completedOutputTokens || 0;
    const completedInputTokens = acc?.completedInputTokens || 0;
    const ttftSamples = acc?.ttftSamples || [];

    if (!requestIds || requestIds.size === 0) {
      const totalOut = completedOutputTokens;
      const totalIn = completedInputTokens;
      const avgTtft =
        ttftSamples.length > 0
                    ? ttftSamples.reduce((a: any, b: any) => a + b, 0) /
            ttftSamples.length
          : null;
      // Use the most recent completed tok/s (last iteration's rate)
      const completedSamples = acc?.completedTokPerSecSamples || [];
      const lastTokPerSec =
        completedSamples.length > 0
          ? parseFloat(completedSamples[completedSamples.length - 1].toFixed(1))
          : null;
      return {
        tokPerSec: lastTokPerSec,
        activeRequests: 0,
        totalOutputTokens: totalOut,
        totalInputTokens: totalIn,
        totalTokens: totalIn + totalOut,
        avgTtft,
      };
    }

    let totalTokPerSec = 0;
    let generatingCount = 0;
    let activeOutputTokens = 0;
    let activeInputTokens = 0;
    let activeTtftSum = 0;
    let activeTtftCount = 0;

        for ( const rid of requestIds) {
      const req = activeRequests.get(rid);
      if (!req) continue;

      activeOutputTokens += req.outputTokens;
      activeInputTokens += req.inputTokens;

      if (req.ttft != null) {
        activeTtftSum += req.ttft;
        activeTtftCount++;
      }

      // Only compute tok/s for requests that have warmed up:
      // - firstTokenTime and lastTokenTime must exist
      // - enough tokens/chunks to be statistically meaningful
      // - enough elapsed time to avoid early-burst spikes
      //
      // Use provider-reported outputTokens when available (authoritative,
      // set at stream end). During streaming, estimate from cumulative
      // output characters using ~4 chars/token heuristic. This is far
      // more accurate than raw chunkCount for providers like Anthropic
      // that send large thinking deltas as single chunks.
      const estimatedFromChars =
        req.outputCharacters > 0
          ? Math.ceil(req.outputCharacters / 4)
          : req.chunkCount;
      const effectiveTokens =
        req.outputTokens > 0 ? req.outputTokens : estimatedFromChars;
      if (
        req.firstTokenTime &&
        req.lastTokenTime &&
        effectiveTokens >= MIN_TOKENS_FOR_RATE
      ) {
        const elapsed = (req.lastTokenTime - req.firstTokenTime) / 1000;
        if (elapsed >= MIN_ELAPSED_SEC) {
          totalTokPerSec += effectiveTokens / elapsed;
          generatingCount++;
        }
      }
    }

    const totalOut = completedOutputTokens + activeOutputTokens;
    const totalIn = completedInputTokens + activeInputTokens;

    // Average TTFT across completed + active samples
    const allTtftSum =
            ttftSamples.reduce((a: any, b: any) => a + b, 0) + activeTtftSum;
    const allTtftCount = ttftSamples.length + activeTtftCount;
    const avgTtft = allTtftCount > 0 ? allTtftSum / allTtftCount : null;

    // Tok/s: aggregate throughput across all active requests (sum, not average).
    // When multiple workers generate in parallel, the session-level rate
    // reflects total tokens/sec being produced across the entire session.
    let tokPerSec = null;
    if (generatingCount > 0) {
      tokPerSec = parseFloat(totalTokPerSec.toFixed(1));
    } else {
      const completedSamples = acc?.completedTokPerSecSamples || [];
      if (completedSamples.length > 0) {
        tokPerSec = parseFloat(
          completedSamples[completedSamples.length - 1].toFixed(1),
        );
      }
    }

    return {
      tokPerSec,
      activeRequests: requestIds.size,
      // Cumulative: completed requests + in-flight requests
      totalOutputTokens: totalOut,
      totalInputTokens: totalIn,
      totalTokens: totalIn + totalOut,
      avgTtft: avgTtft != null ? parseFloat(avgTtft.toFixed(3)) : null,
    };
  },

  /**
   * Clean up all tracking data for a session.
   *

   */
  cleanup(agentSessionId: any) {
    const requestIds = sessionIndex.get(agentSessionId);
    if (requestIds) {
            for ( const rid of requestIds) {
        activeRequests.delete(rid);
      }
      sessionIndex.delete(agentSessionId);
    }
    sessionAccumulators.delete(agentSessionId);
  },

  /**
   * Check if a session has any active requests.
   *


   */
  hasActiveRequests(agentSessionId: any) {
    const requestIds = sessionIndex.get(agentSessionId);
    return !!(requestIds && requestIds.size > 0);
  },

  /** Total active requests across all sessions (for diagnostics). */
  get totalActiveRequests() {
    return activeRequests.size;
  },
} as any);

export default SessionGenerationTracker;

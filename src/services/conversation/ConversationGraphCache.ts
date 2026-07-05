/**
 * ConversationGraphCache — In-memory TTL cache for computed graph data.
 *
 * During active generation, multiple clients or rapid SSE-driven rebuilds
 * can trigger the same graph computation (MongoDB queries + Kahn's
 * topological sort + layout) many times per second. This cache stores
 * the computed GraphData for a short TTL, keyed by a composite key of
 * conversationId + requestCount + canvas dimensions — so the cache
 * naturally invalidates when new requests arrive.
 */

import type { GraphData } from "@rodrigo-barraza/utilities-library/graph";

/** TTL for cached graph data. Short enough to reflect changes quickly,
 *  long enough to absorb bursts of identical requests. */
export const GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS = 500;

/** Maximum number of conversations to cache simultaneously.
 *  Prevents unbounded memory growth in long-running processes. */
const GRAPH_CACHE_MAXIMUM_ENTRIES = 100;

interface GraphCacheEntry {
  graphData: GraphData;
  cachedAtTimestamp: number;
}

const graphCache = new Map<string, GraphCacheEntry>();

/**
 * Build a composite cache key from the parameters that affect
 * the graph output. If any of these change, the cache misses
 * and a fresh computation runs.
 */
export function buildGraphCacheKey(
  conversationId: string,
  requestCount: number,
  canvasWidth: number,
  canvasHeight: number,
): string {
  return `${conversationId}:${requestCount}:${canvasWidth}x${canvasHeight}`;
}

/**
 * Retrieve cached graph data if it exists and hasn't expired.
 * Returns `null` on miss or expiration.
 */
export function getGraphFromCache(cacheKey: string): GraphData | null {
  const entry = graphCache.get(cacheKey);
  if (!entry) return null;

  const ageMilliseconds = Date.now() - entry.cachedAtTimestamp;
  if (ageMilliseconds > GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS) {
    graphCache.delete(cacheKey);
    return null;
  }

  return entry.graphData;
}

/**
 * Store computed graph data in the cache. Performs eviction of the
 * oldest entry when the cache exceeds the maximum size.
 */
export function setGraphInCache(cacheKey: string, graphData: GraphData): void {
  // Evict oldest entry if at capacity
  if (graphCache.size >= GRAPH_CACHE_MAXIMUM_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of graphCache) {
      if (entry.cachedAtTimestamp < oldestTimestamp) {
        oldestTimestamp = entry.cachedAtTimestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) graphCache.delete(oldestKey);
  }

  graphCache.set(cacheKey, {
    graphData,
    cachedAtTimestamp: Date.now(),
  });
}

/**
 * Invalidate all cached graphs for a specific conversation.
 * Call this when a conversation is deleted or significantly mutated.
 */
export function invalidateGraphCacheForConversation(conversationId: string): void {
  for (const key of graphCache.keys()) {
    if (key.startsWith(`${conversationId}:`)) {
      graphCache.delete(key);
    }
  }
}

/**
 * Clear the entire graph cache. Useful for tests or memory pressure.
 */
export function clearGraphCache(): void {
  graphCache.clear();
}

/**
 * Return the current cache size (for monitoring/tests).
 */
export function getGraphCacheSize(): number {
  return graphCache.size;
}

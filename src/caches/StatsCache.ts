import ChangeStreamService from "#src/services/ChangeStreamService";
import { COLLECTIONS } from "#src/constants";

/** Time-to-live for stats cache entries (30 seconds).
 * Change stream invalidation handles real-time freshness; this TTL
 * is only a fallback when change streams are unavailable. */
const CACHE_TIME_TO_LIVE_MILLISECONDS = 30_000;

interface CacheEntry<T> {
  resultData: T;
  cachedAtTimestamp: number;
}

class StatsCacheManager {
  private cacheStore = new Map<string, CacheEntry<unknown>>();
  private activePromisesStore = new Map<string, Promise<unknown>>();
  /**
   * Bumped by every clear(). A computation that started before a change
   * finishes with pre-change data: it must neither be cached nor be joined by
   * a caller that arrived after the change.
   */
  private generation = 0;

  constructor() {
    // Invalidate the cache immediately when any MongoDB change event occurs
    // on requests, conversations, or workflows collections.
    ChangeStreamService.subscribe((changePayload) => {
      if (
        changePayload.collection === COLLECTIONS.REQUESTS ||
        changePayload.collection === COLLECTIONS.MODEL_CONVERSATIONS ||
        changePayload.collection === COLLECTIONS.AGENT_CONVERSATIONS ||
        changePayload.collection === COLLECTIONS.WORKFLOWS
      ) {
        this.clear();
      }
    });
  }

  /**
   * Get an entry from the cache or run the fetcher function to retrieve it.
   * Deduplicates concurrent identical requests (Promise Coalescing).
   */
  public async getOrFetch<T>(
    cacheKey: string,
    fetcherFunction: () => Promise<T>,
  ): Promise<T> {
    const cachedEntry = this.cacheStore.get(cacheKey) as CacheEntry<T> | undefined;
    const currentTimestamp = Date.now();

    if (
      cachedEntry &&
      currentTimestamp - cachedEntry.cachedAtTimestamp < CACHE_TIME_TO_LIVE_MILLISECONDS
    ) {
      return cachedEntry.resultData;
    }

    // Coalesce duplicate requests currently in-flight
    let activePromise = this.activePromisesStore.get(cacheKey) as Promise<T> | undefined;
    if (!activePromise) {
      const startedGeneration = this.generation;
      const settle = () => {
        if (this.activePromisesStore.get(cacheKey) === activePromise) {
          this.activePromisesStore.delete(cacheKey);
        }
      };
      activePromise = fetcherFunction()
        .then((resultData) => {
          if (this.generation === startedGeneration) {
            this.cacheStore.set(cacheKey, {
              resultData,
              cachedAtTimestamp: Date.now(),
            });
          }
          settle();
          return resultData;
        })
        .catch((error: unknown) => {
          settle();
          throw error;
        });
      this.activePromisesStore.set(cacheKey, activePromise);
    }

    return activePromise;
  }

  /**
   * Helper to build a unique cache key based on query parameters.
   */
  public buildCacheKey(endpointPath: string, queryParameters: Record<string, unknown>): string {
    const sortedQueryParameters = Object.keys(queryParameters)
      .sort()
      .reduce((accumulator, parameterName) => {
        accumulator[parameterName] = queryParameters[parameterName];
        return accumulator;
      }, {} as Record<string, unknown>);

    return `${endpointPath}:${JSON.stringify(sortedQueryParameters)}`;
  }

  /**
   * Clear the entire cache store.
   */
  public clear(): void {
    this.generation++;
    this.cacheStore.clear();
    this.activePromisesStore.clear();
  }
}

export const StatsCache = new StatsCacheManager();

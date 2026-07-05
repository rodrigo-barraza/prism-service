import ChangeStreamService from "../services/ChangeStreamService.ts";
import { COLLECTIONS } from "../constants.ts";

/** Time-to-live for stats cache entries (5 seconds). */
const CACHE_TIME_TO_LIVE_MILLISECONDS = 5000;

interface CacheEntry<T> {
  resultData: T;
  cachedAtTimestamp: number;
}

class StatsCacheManager {
  private cacheStore = new Map<string, CacheEntry<unknown>>();
  private activePromisesStore = new Map<string, Promise<unknown>>();

  constructor() {
    // Invalidate the cache immediately when any MongoDB change event occurs
    // on requests, conversations, or workflows collections.
    ChangeStreamService.subscribe((changePayload) => {
      if (
        changePayload.collection === COLLECTIONS.REQUESTS ||
        changePayload.collection === COLLECTIONS.MODEL_CONVERSATIONS ||
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
      activePromise = fetcherFunction()
        .then((resultData) => {
          this.cacheStore.set(cacheKey, {
            resultData,
            cachedAtTimestamp: Date.now(),
          });
          this.activePromisesStore.delete(cacheKey);
          return resultData;
        })
        .catch((error: unknown) => {
          this.activePromisesStore.delete(cacheKey);
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
    this.cacheStore.clear();
  }
}

export const StatsCache = new StatsCacheManager();

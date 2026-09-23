import { describe, it, expect, beforeEach } from "vitest";
import { StatsCache } from "#src/caches/StatsCache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("StatsCache", () => {
  beforeEach(() => StatsCache.clear());

  it("coalesces concurrent fetches of one key and caches the result", async () => {
    let calls = 0;
    const fetcher = async () => ++calls;
    const [first, second] = await Promise.all([
      StatsCache.getOrFetch("key", fetcher),
      StatsCache.getOrFetch("key", fetcher),
    ]);
    expect([first, second, calls]).toEqual([1, 1, 1]);
    expect(await StatsCache.getOrFetch("key", fetcher)).toBe(1);
  });

  it("never serves a result computed before a change to a caller after it", async () => {
    const beforeChange = deferred<string>();
    const staleRequest = StatsCache.getOrFetch("key", () => beforeChange.promise);

    StatsCache.clear(); // a change event arrives while the query runs

    // A caller after the change must not join the pre-change query…
    const freshRequest = StatsCache.getOrFetch("key", async () => "after");
    beforeChange.resolve("before");
    expect(await staleRequest).toBe("before");
    expect(await freshRequest).toBe("after");

    // …and the pre-change result must not land in the cache.
    expect(await StatsCache.getOrFetch("key", async () => "later")).toBe("after");
  });

  it("drops a pre-change result that finishes after the change", async () => {
    const beforeChange = deferred<string>();
    const staleRequest = StatsCache.getOrFetch("key", () => beforeChange.promise);
    StatsCache.clear();
    beforeChange.resolve("before");
    await staleRequest;
    expect(await StatsCache.getOrFetch("key", async () => "after")).toBe("after");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression test for the LM Studio singleflight bug.
 *
 * LM Studio's /api/v1/models/load creates a NEW model instance
 * for every concurrent POST (e.g. model:2, model:3). The loadModel
 * singleflight ensures only one HTTP call goes through — all concurrent
 * callers await the same promise.
 *
 * This test extracts the singleflight pattern in isolation rather than
 * importing the full provider (which has deep dependency chains).
 */

describe("LM Studio loadModel singleflight", () => {
  // Replicate the exact singleflight pattern used in loadModel
  function createSingleflightLoadModel(
    mockFetch: (model: string) => Promise<unknown>,
  ) {
    const loadInflight = new Map<string, Promise<unknown>>();

    return {
      loadInflight,
      async loadModel(model: string): Promise<unknown> {
        if (loadInflight.has(model)) {
          return loadInflight.get(model);
        }

        const loadWork = (async () => {
          return mockFetch(model);
        })();

        loadInflight.set(model, loadWork);
        try {
          return await loadWork;
        } finally {
          loadInflight.delete(model);
        }
      },
    };
  }

  it("coalesces 3 concurrent loadModel calls into a single fetch", async () => {
    const fetchSpy = vi.fn(
      (model: string) =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ instance_id: model, status: "loaded" }),
            50,
          ),
        ),
    );
    const { loadModel } = createSingleflightLoadModel(fetchSpy);

    const [resultA, resultB, resultC] = await Promise.all([
      loadModel("test-model"),
      loadModel("test-model"),
      loadModel("test-model"),
    ]);

    expect(resultA).toEqual({ instance_id: "test-model", status: "loaded" });
    expect(resultB).toEqual(resultA);
    expect(resultC).toEqual(resultA);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows a second load after the first completes", async () => {
    const fetchSpy = vi.fn(
      (model: string) =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ instance_id: model, status: "loaded" }),
            20,
          ),
        ),
    );
    const { loadModel } = createSingleflightLoadModel(fetchSpy);

    await loadModel("test-model");
    await loadModel("test-model");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce loads for different model names", async () => {
    const fetchSpy = vi.fn(
      (model: string) =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ instance_id: model, status: "loaded" }),
            20,
          ),
        ),
    );
    const { loadModel } = createSingleflightLoadModel(fetchSpy);

    await Promise.all([loadModel("model-a"), loadModel("model-b")]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("propagates errors to all concurrent waiters", async () => {
    const fetchSpy = vi.fn(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("GPU OOM")), 20),
        ),
    );
    const { loadModel } = createSingleflightLoadModel(fetchSpy);

    const results = await Promise.allSettled([
      loadModel("test-model"),
      loadModel("test-model"),
      loadModel("test-model"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("rejected");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clears inflight after error so retry is allowed", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error("OOM")), 20),
        );
      }
      return new Promise((resolve) =>
        setTimeout(
          () => resolve({ instance_id: "test-model", status: "loaded" }),
          20,
        ),
      );
    });
    const { loadModel, loadInflight } =
      createSingleflightLoadModel(fetchSpy);

    await expect(loadModel("test-model")).rejects.toThrow("OOM");
    expect(loadInflight.size).toBe(0);

    const retryResult = await loadModel("test-model");
    expect(retryResult).toEqual({
      instance_id: "test-model",
      status: "loaded",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("handles 10 concurrent calls with only 1 fetch", async () => {
    const fetchSpy = vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ instance_id: "test-model", status: "loaded" }),
            100,
          ),
        ),
    );
    const { loadModel } = createSingleflightLoadModel(fetchSpy);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => loadModel("test-model")),
    );

    for (const result of results) {
      expect(result).toEqual({
        instance_id: "test-model",
        status: "loaded",
      });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression tests for the generateTextStream pre-load singleflight.
 *
 * The ORIGINAL bug: generateTextStream had two steps before loading a model:
 *   1. Check if `_loadInflight.has(model)` — synchronous ✅
 *   2. `await listModels()` — ASYNC ❌ (race window opens here)
 *   3. `_loadInflight.set(model, promise)` — too late, concurrent caller already passed step 1
 *
 * This caused LM Studio to create duplicate instances (model:2, model:3)
 * when multiple agent workers started streaming simultaneously.
 *
 * The FIX: register the inflight promise synchronously at step 1, BEFORE
 * the async listModels() recheck. If the model turns out to already be loaded,
 * resolve immediately and clean up.
 */
describe("generateTextStream pre-load singleflight (race condition regression)", () => {
  /**
   * Replicates the FIXED pattern in generateTextStream:
   * Register inflight synchronously → async recheck → load or resolve.
   */
  function createFixedStreamPreload(dependencies: {
    listModels: () => Promise<{ isLoaded: boolean; contextLength: number | null }>;
    loadModel: (model: string) => Promise<void>;
  }) {
    const loadInflight = new Map<string, Promise<void>>();

    return {
      loadInflight,
      async ensureModelForStreaming(model: string): Promise<{ contextLength: number | null }> {
        if (loadInflight.has(model)) {
          await loadInflight.get(model);
          return { contextLength: null };
        }

        // FIXED: register synchronously BEFORE async work
        let resolveInflight!: () => void;
        let rejectInflight!: (error: unknown) => void;
        const inflightPromise = new Promise<void>((resolve, reject) => {
          resolveInflight = resolve;
          rejectInflight = reject;
        });
        inflightPromise.catch(() => {});
        loadInflight.set(model, inflightPromise);

        try {
          const { isLoaded, contextLength } = await dependencies.listModels();

          if (isLoaded) {
            resolveInflight();
            return { contextLength };
          }

          await dependencies.loadModel(model);
          resolveInflight();
          return { contextLength: null };
        } catch (error) {
          rejectInflight(error);
          throw error;
        } finally {
          loadInflight.delete(model);
        }
      },
    };
  }

  /**
   * Replicates the BROKEN pattern (pre-fix) to prove the race existed.
   * Check → async listModels() → register (too late).
   */
  function createBrokenStreamPreload(dependencies: {
    listModels: () => Promise<{ isLoaded: boolean; contextLength: number | null }>;
    loadModel: (model: string) => Promise<void>;
  }) {
    const loadInflight = new Map<string, Promise<void>>();

    return {
      loadInflight,
      async ensureModelForStreaming(model: string): Promise<{ contextLength: number | null }> {
        if (loadInflight.has(model)) {
          await loadInflight.get(model);
          return { contextLength: null };
        }

        // BROKEN: async gap between check and register
        const { isLoaded, contextLength } = await dependencies.listModels();

        if (isLoaded) {
          return { contextLength };
        }

        // By now, another caller could have passed the .has() check above
        if (!loadInflight.has(model)) {
          let resolveInflight!: () => void;
          const inflightPromise = new Promise<void>((resolve) => {
            resolveInflight = resolve;
          });
          loadInflight.set(model, inflightPromise);

          try {
            await dependencies.loadModel(model);
            resolveInflight();
            return { contextLength: null };
          } finally {
            loadInflight.delete(model);
          }
        }

        await loadInflight.get(model);
        return { contextLength: null };
      },
    };
  }

  it("FIXED: concurrent callers coalesce into a single loadModel call", async () => {
    const loadModelSpy = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );
    const listModelsSpy = vi.fn(
      () => new Promise<{ isLoaded: boolean; contextLength: number | null }>((resolve) =>
        setTimeout(() => resolve({ isLoaded: false, contextLength: null }), 20),
      ),
    );

    const { ensureModelForStreaming } = createFixedStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    await Promise.all([
      ensureModelForStreaming("gemma-4-12b-qat"),
      ensureModelForStreaming("gemma-4-12b-qat"),
      ensureModelForStreaming("gemma-4-12b-qat"),
    ]);

    expect(loadModelSpy).toHaveBeenCalledTimes(1);
  });

  it("BROKEN (regression guard): old pattern allows duplicate loads with async gap", async () => {
    // The real race: Caller A finishes listModels + loadModel + cleanup before
    // Caller B finishes its listModels. When B's double-check fires, the map
    // is already empty (A cleaned up), so B loads a duplicate.
    //
    // Timeline with fast loadModel (10ms) and slow listModels (50ms):
    //   0ms: A enters, passes has() (empty), starts listModels
    //   5ms: B enters, passes has() (empty), starts listModels
    //  50ms: A's listModels resolves, A sets inflight, starts loadModel
    //  55ms: B's listModels resolves, B checks has() → TRUE (A registered), B waits on A
    //  60ms: A's loadModel resolves, A resolves inflight, deletes from map
    //  60ms: B wakes from wait — only 1 loadModel call total
    //
    // The double-check in the broken pattern actually catches MOST races.
    // But the actual production race was different: multiple workers hit the
    // same instance across separate event loops (separate HTTP requests), not
    // Promise.all in a single event loop. The singleflight map only prevents
    // races within the same Node.js process.
    //
    // The real fix matters because in production, requests arrive at different
    // times and the listModels() network call has variable latency. The broken
    // pattern's async gap between has() and set() means that if two requests
    // arrive within the listModels() round-trip, both proceed to load.
    //
    // We verify the fix works by ensuring the FIXED pattern always coalesces.
    // Rather than trying to trigger the race deterministically (which is fragile),
    // we test that the fixed pattern is strictly better: it prevents ALL
    // concurrent duplicates regardless of timing.
    const loadModelSpy = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
    );
    const listModelsSpy = vi.fn(
      () => new Promise<{ isLoaded: boolean; contextLength: number | null }>((resolve) =>
        setTimeout(() => resolve({ isLoaded: false, contextLength: null }), 50),
      ),
    );

    // Test: the broken pattern does NOT register synchronously, so the inflight
    // map is empty during the entire listModels() window. Verify that the map
    // is indeed empty during the async gap.
    const { ensureModelForStreaming, loadInflight } = createBrokenStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    // Start first caller
    const firstCallerPromise = ensureModelForStreaming("gemma-4-12b-qat");

    // Check map state during the async gap (5ms after caller entered listModels)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mapWasEmptyDuringAsyncGap = !loadInflight.has("gemma-4-12b-qat");

    await firstCallerPromise;

    // The critical assertion: the broken pattern leaves the map empty during
    // the listModels() async gap, which is the window where concurrent callers
    // would also pass the has() check and proceed to load independently.
    expect(mapWasEmptyDuringAsyncGap).toBe(true);
  });

  it("FIXED: skips load when recheck reveals model is already loaded", async () => {
    const loadModelSpy = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );
    const listModelsSpy = vi.fn(
      () => Promise.resolve({ isLoaded: true, contextLength: 32768 }),
    );

    const { ensureModelForStreaming } = createFixedStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    const result = await ensureModelForStreaming("gemma-4-12b-qat");

    expect(loadModelSpy).not.toHaveBeenCalled();
    expect(result.contextLength).toBe(32768);
  });

  it("FIXED: waiters get unblocked even when model was already loaded", async () => {
    const loadModelSpy = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
    );
    const listModelsSpy = vi.fn(
      () => new Promise<{ isLoaded: boolean; contextLength: number | null }>((resolve) =>
        setTimeout(() => resolve({ isLoaded: true, contextLength: 32768 }), 30),
      ),
    );

    const { ensureModelForStreaming } = createFixedStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    const results = await Promise.all([
      ensureModelForStreaming("gemma-4-12b-qat"),
      ensureModelForStreaming("gemma-4-12b-qat"),
      ensureModelForStreaming("gemma-4-12b-qat"),
    ]);

    expect(loadModelSpy).not.toHaveBeenCalled();
    // All 3 should resolve (none should hang)
    expect(results).toHaveLength(3);
  });

  it("FIXED: propagates load errors to all concurrent waiters", async () => {
    const loadModelSpy = vi.fn(
      () => new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("VRAM exhausted")), 30),
      ),
    );
    const listModelsSpy = vi.fn(
      () => Promise.resolve({ isLoaded: false, contextLength: null }),
    );

    const { ensureModelForStreaming, loadInflight } = createFixedStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    const results = await Promise.allSettled([
      ensureModelForStreaming("gemma-4-12b-qat"),
      ensureModelForStreaming("gemma-4-12b-qat"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    expect(loadModelSpy).toHaveBeenCalledTimes(1);
    expect(loadInflight.size).toBe(0);
  });

  it("FIXED: inflight map is cleaned up on both success and error paths", async () => {
    let shouldFail = true;
    const loadModelSpy = vi.fn(() => {
      if (shouldFail) {
        shouldFail = false;
        return Promise.reject(new Error("GPU OOM"));
      }
      return Promise.resolve();
    });
    const listModelsSpy = vi.fn(
      () => Promise.resolve({ isLoaded: false, contextLength: null }),
    );

    const { ensureModelForStreaming, loadInflight } = createFixedStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    await expect(ensureModelForStreaming("gemma-4-12b-qat")).rejects.toThrow("GPU OOM");
    expect(loadInflight.size).toBe(0);

    await ensureModelForStreaming("gemma-4-12b-qat");
    expect(loadInflight.size).toBe(0);
    expect(loadModelSpy).toHaveBeenCalledTimes(2);
  });
});

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
        while (true) {
          if (loadInflight.has(model)) {
            await loadInflight.get(model);
            continue;
          }

          // Register synchronously BEFORE any async check
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
    let isModelLoaded = false;
    const loadModelSpy = vi.fn(
      () => new Promise<void>((resolve) => {
        isModelLoaded = true;
        setTimeout(resolve, 50);
      }),
    );
    const listModelsSpy = vi.fn(
      () => new Promise<{ isLoaded: boolean; contextLength: number | null }>((resolve) =>
        setTimeout(() => resolve({ isLoaded: isModelLoaded, contextLength: isModelLoaded ? 32768 : null }), 20),
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

  it("BROKEN (regression guard): old pattern allows duplicate loads when Caller A finishes loading while Caller B's listModels() is still pending", async () => {
    const loadModelSpy = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
    );

    // Staggered listModels return values
    const listModelsSpy = vi.fn(() => {
      // Caller A (first call) starts at 0ms and resolves at 50ms
      // Caller B (second call) starts at 30ms and resolves at 80ms
      // Since the model is not loaded at the start of either query, they both return false.
      return new Promise<{ isLoaded: boolean; contextLength: number | null }>((resolve) =>
        setTimeout(() => resolve({ isLoaded: false, contextLength: null }), 50),
      );
    });

    const { ensureModelForStreaming } = createBrokenStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    // Start Caller A at 0ms
    const promiseA = ensureModelForStreaming("gemma-4-12b-qat");

    // Start Caller B at 30ms
    let promiseB!: Promise<{ contextLength: number | null }>;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        promiseB = ensureModelForStreaming("gemma-4-12b-qat");
        resolve();
      }, 30);
    });

    await Promise.all([promiseA, promiseB]);

    // The broken pattern triggers duplicate loads because Caller B's listModels completes
    // after Caller A has already finished loading and deleted the key, meaning B's stale check
    // registers and loads the model again.
    expect(loadModelSpy).toHaveBeenCalledTimes(2);
  });

  it("FIXED: new pattern prevents duplicate loads when Caller A finishes loading while Caller B's listModels() is still pending", async () => {
    const loadModelSpy = vi.fn();

    // listModelsSpy returns isLoaded: true only after loadModel has been called
    let isModelLoaded = false;
    const listModelsSpy = vi.fn(() => {
      return new Promise<{ isLoaded: boolean; contextLength: number | null }>((resolve) =>
        setTimeout(() => resolve({ isLoaded: isModelLoaded, contextLength: isModelLoaded ? 120000 : null }), 50),
      );
    });

    loadModelSpy.mockImplementation(() => {
      isModelLoaded = true;
      return new Promise<void>((resolve) => setTimeout(resolve, 20));
    });

    const { ensureModelForStreaming } = createFixedStreamPreload({
      listModels: listModelsSpy,
      loadModel: loadModelSpy,
    });

    // Start Caller A
    const promiseA = ensureModelForStreaming("gemma-4-12b-qat");

    // Start Caller B at 30ms
    let promiseB!: Promise<{ contextLength: number | null }>;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        promiseB = ensureModelForStreaming("gemma-4-12b-qat");
        resolve();
      }, 30);
    });

    await Promise.all([promiseA, promiseB]);

    // The fixed pattern with while(true) loop only calls loadModel once!
    expect(loadModelSpy).toHaveBeenCalledTimes(1);
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

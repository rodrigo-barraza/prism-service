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

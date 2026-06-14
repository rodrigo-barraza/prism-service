import { describe, it, expect, vi } from "vitest";

/**
 * Regression tests for the LM Studio "reload every iteration" bug.
 *
 * ROOT CAUSE: On each agentic iteration, `generateTextStream` re-enters
 * the model loading gate with a FRESH `options` object (spread from passOptions).
 * If the model was loaded at a context length LOWER than `options.minContextLength`
 * (e.g. due to GPU fallback from 120k → 65k), the `needsReload` check fires
 * EVERY TIME:
 *
 *   loadedContext=65k < minContextLength=120k → needsReload=true
 *   → unload → load at 120k → GPU OOM → fallback to 65k
 *   → next iteration → 65k < 120k → needsReload=true → loop forever
 *
 * The `alreadyAtMax` guard was supposed to prevent this, but it only checked
 * `max_context_length` (model's theoretical max = 120k), NOT the GPU's practical
 * limit. So the guard never fired because 65k < 120k.
 *
 * FIX: `_gpuConstrainedContextLength` map at the provider instance level records
 * the fallback context ceiling. `alreadyAtMax` now uses `effectiveMaxContext =
 * min(modelMax, gpuCeiling)`, so 65k >= 65k → true → skip reload.
 */

interface MockModelEntry {
  key: string;
  max_context_length: number;
  loaded_instances: Array<{
    id: string;
    config: { context_length: number };
  }>;
}

interface MockProviderOptions {
  minContextLength?: number;
  _loadedContextLength?: number;
  signal?: AbortSignal;
}

interface LoadCallRecord {
  model: string;
  contextLength: number | undefined;
}

/**
 * Faithful replica of the FIXED generateTextStream model loading gate.
 * Includes the `_gpuConstrainedContextLength` tracking that prevents
 * the infinite reload loop after a GPU-constrained fallback.
 */
function createFixedModelLoadingGate(dependencies: {
  listModels: () => Promise<{ models: MockModelEntry[] }>;
  loadModel: (model: string, options: { context_length?: number }) => Promise<void>;
  unloadModel: (instanceId: string) => Promise<void>;
}) {
  const loadInflight = new Map<string, Promise<void>>();
  const activeRequestsCount = new Map<string, number>();
  const gpuConstrainedContextLength = new Map<string, number>();
  const loadCalls: LoadCallRecord[] = [];
  const unloadCalls: string[] = [];

  return {
    loadInflight,
    activeRequestsCount,
    gpuConstrainedContextLength,
    loadCalls,
    unloadCalls,

    async runModelLoadingGate(
      model: string,
      options: MockProviderOptions,
    ): Promise<{ loaded: boolean; contextLength: number | null }> {
      while (true) {
        if (loadInflight.has(model)) {
          try {
            await loadInflight.get(model);
          } catch {
            /* ignore, retry */
          }
          continue;
        }

        let resolveInflight!: () => void;
        let rejectInflight!: (error: unknown) => void;
        let isPromiseSettled = false;
        const inflightPromise = new Promise<void>((resolve, reject) => {
          resolveInflight = () => {
            isPromiseSettled = true;
            resolve();
          };
          rejectInflight = (error) => {
            isPromiseSettled = true;
            reject(error);
          };
        });
        inflightPromise.catch(() => {});
        loadInflight.set(model, inflightPromise);

        try {
          const refreshed = await dependencies.listModels();
          const entry = refreshed.models.find(
            (modelItem) => modelItem.key === model,
          );
          const isLoaded = (entry?.loaded_instances?.length ?? 0) > 0;

          if (isLoaded) {
            const loadedContext = entry?.loaded_instances?.[0]?.config;
            if (loadedContext?.context_length) {
              options._loadedContextLength = loadedContext.context_length;
            }
          }

          // ── THE FIX: effectiveMaxContext uses GPU ceiling ──
          const modelMaximumContext = entry?.max_context_length || 0;
          const gpuCeiling = gpuConstrainedContextLength.get(model);
          const effectiveMaxContext = gpuCeiling
            ? Math.min(modelMaximumContext || Infinity, gpuCeiling)
            : modelMaximumContext;
          const alreadyAtMax =
            effectiveMaxContext > 0 &&
            ((options._loadedContextLength as number) || 0) >= effectiveMaxContext;

          const isActive = (activeRequestsCount.get(model) || 0) > 0;
          const needsReload =
            isLoaded &&
            !!options.minContextLength &&
            !!options._loadedContextLength &&
            options._loadedContextLength < options.minContextLength &&
            !alreadyAtMax &&
            !isActive;

          if (isLoaded && !needsReload) {
            resolveInflight();
            return { loaded: true, contextLength: options._loadedContextLength || null };
          }

          if (needsReload && entry) {
            for (const instance of entry.loaded_instances || []) {
              unloadCalls.push(instance.id);
              await dependencies.unloadModel(instance.id);
            }
          } else if (!isLoaded) {
            // Unload other models (single-model enforcement)
            for (const modelEntry of refreshed.models) {
              for (const instance of modelEntry.loaded_instances || []) {
                if ((activeRequestsCount.get(modelEntry.key) || 0) > 0) continue;
                unloadCalls.push(instance.id);
                await dependencies.unloadModel(instance.id);
              }
            }
          }

          const loadOptions: { context_length?: number } = {};
          if (options.minContextLength) {
            const maxContextLength = entry?.max_context_length || 120000;
            loadOptions.context_length = Math.min(
              options.minContextLength,
              maxContextLength,
            );
          }

          let loadError: unknown = null;
          try {
            loadCalls.push({ model, contextLength: loadOptions.context_length });
            await dependencies.loadModel(model, loadOptions);
          } catch (error: unknown) {
            loadError = error;
          }

          // Context fallback with GPU ceiling recording
          if (loadError && loadOptions.context_length) {
            const requestedContextLength = loadOptions.context_length;
            const contextFallbackTiers = [65000];

            for (const fallbackContextLength of contextFallbackTiers) {
              if (fallbackContextLength >= requestedContextLength) continue;
              try {
                loadOptions.context_length = fallbackContextLength;
                loadCalls.push({ model, contextLength: fallbackContextLength });
                await dependencies.loadModel(model, loadOptions);
                loadError = null;
                // ── THE FIX: record GPU ceiling ──
                gpuConstrainedContextLength.set(model, fallbackContextLength);
                break;
              } catch {
                /* fallback also failed */
              }
            }
          }

          if (loadError) {
            rejectInflight(loadError);
            throw loadError;
          }

          // Refresh after load
          try {
            const refreshedAfterLoad = await dependencies.listModels();
            const entryAfterLoad = refreshedAfterLoad.models.find(
              (modelItem) => modelItem.key === model,
            );
            const context = entryAfterLoad?.loaded_instances?.[0]?.config;
            if (context?.context_length) {
              options._loadedContextLength = context.context_length;
            }
          } catch {
            /* ignore */
          }

          resolveInflight();
          return { loaded: true, contextLength: options._loadedContextLength || null };
        } catch (error) {
          rejectInflight(error);
          throw error;
        } finally {
          if (!isPromiseSettled) {
            rejectInflight(new Error("Load aborted or cancelled"));
          }
          loadInflight.delete(model);
        }
      }
    },
  };
}

/**
 * Replica of the BROKEN (pre-fix) logic — no GPU ceiling tracking.
 * Used to prove the bug existed.
 */
function createBrokenModelLoadingGate(dependencies: {
  listModels: () => Promise<{ models: MockModelEntry[] }>;
  loadModel: (model: string, options: { context_length?: number }) => Promise<void>;
  unloadModel: (instanceId: string) => Promise<void>;
}) {
  const loadInflight = new Map<string, Promise<void>>();
  const activeRequestsCount = new Map<string, number>();
  const loadCalls: LoadCallRecord[] = [];
  const unloadCalls: string[] = [];

  return {
    loadInflight,
    activeRequestsCount,
    loadCalls,
    unloadCalls,

    async runModelLoadingGate(
      model: string,
      options: MockProviderOptions,
    ): Promise<{ loaded: boolean; contextLength: number | null }> {
      while (true) {
        if (loadInflight.has(model)) {
          try {
            await loadInflight.get(model);
          } catch {
            /* ignore */
          }
          continue;
        }

        let resolveInflight!: () => void;
        let rejectInflight!: (error: unknown) => void;
        let isPromiseSettled = false;
        const inflightPromise = new Promise<void>((resolve, reject) => {
          resolveInflight = () => { isPromiseSettled = true; resolve(); };
          rejectInflight = (error) => { isPromiseSettled = true; reject(error); };
        });
        inflightPromise.catch(() => {});
        loadInflight.set(model, inflightPromise);

        try {
          const refreshed = await dependencies.listModels();
          const entry = refreshed.models.find(
            (modelItem) => modelItem.key === model,
          );
          const isLoaded = (entry?.loaded_instances?.length ?? 0) > 0;

          if (isLoaded) {
            const loadedContext = entry?.loaded_instances?.[0]?.config;
            if (loadedContext?.context_length) {
              options._loadedContextLength = loadedContext.context_length;
            }
          }

          // BROKEN: no GPU ceiling — uses raw modelMaximumContext only
          const modelMaximumContext = entry?.max_context_length || 0;
          const alreadyAtMax =
            modelMaximumContext > 0 &&
            ((options._loadedContextLength as number) || 0) >= modelMaximumContext;

          const isActive = (activeRequestsCount.get(model) || 0) > 0;
          const needsReload =
            isLoaded &&
            !!options.minContextLength &&
            !!options._loadedContextLength &&
            options._loadedContextLength < options.minContextLength &&
            !alreadyAtMax &&
            !isActive;

          if (isLoaded && !needsReload) {
            resolveInflight();
            return { loaded: true, contextLength: options._loadedContextLength || null };
          }

          if (needsReload && entry) {
            for (const instance of entry.loaded_instances || []) {
              unloadCalls.push(instance.id);
              await dependencies.unloadModel(instance.id);
            }
          }

          const loadOptions: { context_length?: number } = {};
          if (options.minContextLength) {
            const maxContextLength = entry?.max_context_length || 120000;
            loadOptions.context_length = Math.min(
              options.minContextLength,
              maxContextLength,
            );
          }

          let loadError: unknown = null;
          try {
            loadCalls.push({ model, contextLength: loadOptions.context_length });
            await dependencies.loadModel(model, loadOptions);
          } catch (error: unknown) {
            loadError = error;
          }

          if (loadError && loadOptions.context_length) {
            const requestedContextLength = loadOptions.context_length;
            const contextFallbackTiers = [65000];
            for (const fallbackContextLength of contextFallbackTiers) {
              if (fallbackContextLength >= requestedContextLength) continue;
              try {
                loadOptions.context_length = fallbackContextLength;
                loadCalls.push({ model, contextLength: fallbackContextLength });
                await dependencies.loadModel(model, loadOptions);
                loadError = null;
                // BROKEN: no GPU ceiling recorded here
                break;
              } catch {
                /* fallback also failed */
              }
            }
          }

          if (loadError) {
            rejectInflight(loadError);
            throw loadError;
          }

          try {
            const refreshedAfterLoad = await dependencies.listModels();
            const entryAfterLoad = refreshedAfterLoad.models.find(
              (modelItem) => modelItem.key === model,
            );
            const context = entryAfterLoad?.loaded_instances?.[0]?.config;
            if (context?.context_length) {
              options._loadedContextLength = context.context_length;
            }
          } catch {
            /* ignore */
          }

          resolveInflight();
          return { loaded: true, contextLength: options._loadedContextLength || null };
        } catch (error) {
          rejectInflight(error);
          throw error;
        } finally {
          if (!isPromiseSettled) {
            rejectInflight(new Error("Load aborted or cancelled"));
          }
          loadInflight.delete(model);
        }
      }
    },
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_KEY = "gemma-4-27b-it";
const GPU_PRACTICAL_MAX_CONTEXT = 65000;
const MODEL_THEORETICAL_MAX_CONTEXT = 120000;
const REQUESTED_MIN_CONTEXT = 120000;

function createGpuConstrainedMocks(initialLoadedContext: number) {
  let currentLoadedContext = initialLoadedContext;

  const listModelsMock = vi.fn(() =>
    Promise.resolve({
      models: [
        {
          key: MODEL_KEY,
          max_context_length: MODEL_THEORETICAL_MAX_CONTEXT,
          loaded_instances:
            currentLoadedContext > 0
              ? [
                  {
                    id: `${MODEL_KEY}:1`,
                    config: { context_length: currentLoadedContext },
                  },
                ]
              : [],
        },
      ],
    }),
  );

  const loadModelMock = vi.fn(
    (_model: string, options: { context_length?: number }) => {
      if (
        options.context_length &&
        options.context_length > GPU_PRACTICAL_MAX_CONTEXT
      ) {
        return Promise.reject(new Error("GPU OOM: insufficient VRAM"));
      }
      currentLoadedContext = options.context_length || GPU_PRACTICAL_MAX_CONTEXT;
      return Promise.resolve();
    },
  );

  const unloadModelMock = vi.fn(() => {
    currentLoadedContext = 0;
    return Promise.resolve();
  });

  return { listModelsMock, loadModelMock, unloadModelMock };
}


// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("LM Studio reload loop regression (GPU fallback → infinite reload)", () => {

  it("BROKEN (regression guard): old pattern reloads on EVERY agentic iteration when GPU caps context below theoretical max", async () => {
    const { listModelsMock, loadModelMock, unloadModelMock } =
      createGpuConstrainedMocks(GPU_PRACTICAL_MAX_CONTEXT);

    const gate = createBrokenModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    // Simulate 5 agentic iterations — each gets a FRESH options spread
    for (let iteration = 0; iteration < 5; iteration++) {
      const iterationOptions: MockProviderOptions = {
        minContextLength: REQUESTED_MIN_CONTEXT,
      };
      await gate.runModelLoadingGate(MODEL_KEY, iterationOptions);
    }

    // Each iteration: needsReload=true → unload → load@120k fails → fallback@65k
    // = 2 loadModel calls + 1 unload per iteration = 10 loads, 5 unloads
    expect(loadModelMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(unloadModelMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("FIXED: model loads ONCE with fallback, then skips reload on all subsequent iterations", async () => {
    const { listModelsMock, loadModelMock, unloadModelMock } =
      createGpuConstrainedMocks(0); // start unloaded

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    // Iteration 1: model not loaded → load@120k fails → fallback@65k → records GPU ceiling
    const firstIterationOptions: MockProviderOptions = {
      minContextLength: REQUESTED_MIN_CONTEXT,
    };
    const result1 = await gate.runModelLoadingGate(MODEL_KEY, firstIterationOptions);
    expect(result1.loaded).toBe(true);

    const loadCallsAfterIteration1 = loadModelMock.mock.calls.length;
    expect(loadCallsAfterIteration1).toBe(2); // 1 failed at 120k + 1 succeeded at 65k

    // Iterations 2-5: model IS loaded at 65k
    // alreadyAtMax = 65k >= min(120k, 65k=gpuCeiling) = 65k >= 65k = TRUE
    // needsReload = false → skip reload → break immediately
    for (let iteration = 2; iteration <= 5; iteration++) {
      const iterationOptions: MockProviderOptions = {
        minContextLength: REQUESTED_MIN_CONTEXT,
      };
      const result = await gate.runModelLoadingGate(MODEL_KEY, iterationOptions);
      expect(result.loaded).toBe(true);
      expect(result.contextLength).toBe(GPU_PRACTICAL_MAX_CONTEXT);
    }

    // loadModel was ONLY called during iteration 1
    expect(loadModelMock.mock.calls.length).toBe(loadCallsAfterIteration1);
    // No unloads after the initial load
    expect(unloadModelMock.mock.calls.length).toBe(0);
  });

  it("FIXED: GPU ceiling is recorded per model — different models get independent ceilings", async () => {
    const modelA = "model-a";
    const modelB = "model-b";
    let loadedModelKey: string | null = null;
    let loadedContextLength = 0;

    const listModelsMock = vi.fn(() =>
      Promise.resolve({
        models: [
          {
            key: modelA,
            max_context_length: 120000,
            loaded_instances:
              loadedModelKey === modelA
                ? [{ id: `${modelA}:1`, config: { context_length: loadedContextLength } }]
                : [],
          },
          {
            key: modelB,
            max_context_length: 80000,
            loaded_instances:
              loadedModelKey === modelB
                ? [{ id: `${modelB}:1`, config: { context_length: loadedContextLength } }]
                : [],
          },
        ],
      }),
    );

    const loadModelMock = vi.fn(
      (model: string, options: { context_length?: number }) => {
        const gpuMax = model === modelA ? 65000 : 40000;
        if (options.context_length && options.context_length > gpuMax) {
          return Promise.reject(new Error("GPU OOM"));
        }
        loadedModelKey = model;
        loadedContextLength = options.context_length || gpuMax;
        return Promise.resolve();
      },
    );

    const unloadModelMock = vi.fn(() => {
      loadedModelKey = null;
      loadedContextLength = 0;
      return Promise.resolve();
    });

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    // Load model A — falls back to 65k
    await gate.runModelLoadingGate(modelA, { minContextLength: 120000 });
    expect(gate.gpuConstrainedContextLength.get(modelA)).toBe(65000);
    expect(gate.gpuConstrainedContextLength.has(modelB)).toBe(false);

    const loadCallsAfterModelA = loadModelMock.mock.calls.length;

    // Subsequent iterations for model A should NOT reload
    await gate.runModelLoadingGate(modelA, { minContextLength: 120000 });
    await gate.runModelLoadingGate(modelA, { minContextLength: 120000 });
    expect(loadModelMock.mock.calls.length).toBe(loadCallsAfterModelA);
  });

  it("FIXED: no reload loop when minContextLength is not set", async () => {
    const { listModelsMock, loadModelMock, unloadModelMock } =
      createGpuConstrainedMocks(GPU_PRACTICAL_MAX_CONTEXT);

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    for (let iteration = 0; iteration < 5; iteration++) {
      const iterationOptions: MockProviderOptions = {};
      await gate.runModelLoadingGate(MODEL_KEY, iterationOptions);
    }

    expect(loadModelMock).not.toHaveBeenCalled();
    expect(unloadModelMock).not.toHaveBeenCalled();
  });

  it("FIXED: concurrent calls during loading coalesce into single load", async () => {
    let currentLoadedContext = 0;

    const listModelsMock = vi.fn(
      () =>
        new Promise<{ models: MockModelEntry[] }>((resolve) => {
          setTimeout(
            () =>
              resolve({
                models: [
                  {
                    key: MODEL_KEY,
                    max_context_length: MODEL_THEORETICAL_MAX_CONTEXT,
                    loaded_instances:
                      currentLoadedContext > 0
                        ? [{ id: `${MODEL_KEY}:1`, config: { context_length: currentLoadedContext } }]
                        : [],
                  },
                ],
              }),
            20,
          );
        }),
    );

    const loadModelMock = vi.fn(
      (_model: string, options: { context_length?: number }) =>
        new Promise<void>((resolve) => {
          currentLoadedContext = options.context_length || GPU_PRACTICAL_MAX_CONTEXT;
          setTimeout(resolve, 50);
        }),
    );

    const unloadModelMock = vi.fn(() => Promise.resolve());

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    const results = await Promise.all([
      gate.runModelLoadingGate(MODEL_KEY, {}),
      gate.runModelLoadingGate(MODEL_KEY, {}),
      gate.runModelLoadingGate(MODEL_KEY, {}),
    ]);

    for (const result of results) {
      expect(result.loaded).toBe(true);
    }

    expect(loadModelMock).toHaveBeenCalledTimes(1);
  });

  it("FIXED: when model context DOES fit (no fallback), minContextLength reload works correctly once", async () => {
    let currentLoadedContext = 32000; // loaded at low context

    const listModelsMock = vi.fn(() =>
      Promise.resolve({
        models: [
          {
            key: MODEL_KEY,
            max_context_length: MODEL_THEORETICAL_MAX_CONTEXT,
            loaded_instances: [
              {
                id: `${MODEL_KEY}:1`,
                config: { context_length: currentLoadedContext },
              },
            ],
          },
        ],
      }),
    );

    const loadModelMock = vi.fn(
      (_model: string, options: { context_length?: number }) => {
        // GPU can fit the full 120k — no fallback needed
        currentLoadedContext = options.context_length || MODEL_THEORETICAL_MAX_CONTEXT;
        return Promise.resolve();
      },
    );

    const unloadModelMock = vi.fn(() => {
      currentLoadedContext = 0;
      return Promise.resolve();
    });

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    // Iteration 1: loaded at 32k, min=120k → needsReload=true → reload at 120k succeeds
    await gate.runModelLoadingGate(MODEL_KEY, { minContextLength: REQUESTED_MIN_CONTEXT });
    expect(loadModelMock).toHaveBeenCalledTimes(1);
    expect(unloadModelMock).toHaveBeenCalledTimes(1);

    const loadCallsAfterReload = loadModelMock.mock.calls.length;

    // Iteration 2-5: loaded at 120k, alreadyAtMax=true → no reload
    for (let iteration = 2; iteration <= 5; iteration++) {
      await gate.runModelLoadingGate(MODEL_KEY, { minContextLength: REQUESTED_MIN_CONTEXT });
    }
    expect(loadModelMock.mock.calls.length).toBe(loadCallsAfterReload);
  });

  it("FIXED: inflight map is always cleaned up, even on error", async () => {
    const listModelsMock = vi.fn(() =>
      Promise.resolve({
        models: [
          {
            key: MODEL_KEY,
            max_context_length: MODEL_THEORETICAL_MAX_CONTEXT,
            loaded_instances: [],
          },
        ],
      }),
    );

    const loadModelMock = vi.fn(
      () => Promise.reject(new Error("Total GPU failure")),
    );

    const unloadModelMock = vi.fn(() => Promise.resolve());

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    await expect(
      gate.runModelLoadingGate(MODEL_KEY, { minContextLength: 120000 }),
    ).rejects.toThrow("Total GPU failure");

    expect(gate.loadInflight.size).toBe(0);
  });

  it("FIXED: 10 sequential agentic iterations with GPU constraint — zero reloads after first", async () => {
    const { listModelsMock, loadModelMock, unloadModelMock } =
      createGpuConstrainedMocks(0);

    const gate = createFixedModelLoadingGate({
      listModels: listModelsMock,
      loadModel: loadModelMock,
      unloadModel: unloadModelMock,
    });

    // Iteration 1
    await gate.runModelLoadingGate(MODEL_KEY, { minContextLength: REQUESTED_MIN_CONTEXT });
    const loadCallsAfterFirst = loadModelMock.mock.calls.length;
    expect(loadCallsAfterFirst).toBe(2); // 120k fail + 65k success

    // Iterations 2-10: zero additional loads
    for (let iteration = 2; iteration <= 10; iteration++) {
      await gate.runModelLoadingGate(MODEL_KEY, { minContextLength: REQUESTED_MIN_CONTEXT });
    }

    expect(loadModelMock.mock.calls.length).toBe(loadCallsAfterFirst);
    expect(gate.gpuConstrainedContextLength.get(MODEL_KEY)).toBe(GPU_PRACTICAL_MAX_CONTEXT);
  });
});

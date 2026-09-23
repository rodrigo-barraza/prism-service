/**
 * Sweeps and scheduled regression runs, end to end below the HTTP layer:
 * the matrix a sweep builds, the request fields each cell's settings become
 * (through the real BenchmarkExecutor into a scripted handleAgent), what is
 * stored, the Pareto frontier, and the scheduler's tick running a
 * benchmark task, comparing it with the previous sweep and alerting.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleAgent } from "#src/routes/ChatRoutes";
import WebhookEventBus from "#src/services/WebhookEventBus";
import ScheduledTaskService from "#src/services/ScheduledTaskService";
import DatasetStore from "#src/services/benchmark/DatasetStore";
import {
  buildSweepMatrix,
  markPareto,
  runSweep,
  sweepStats,
  validateSweepAxes,
} from "#src/services/benchmark/SweepRunner";
import { compareSweeps } from "#src/services/benchmark/BenchmarkRegression";
import { harnessSettingParams } from "#src/services/benchmark/BenchmarkExecutor";
import type {
  BenchmarkDataset,
  BenchmarkSweep,
  DatasetRun,
  ReliabilitySummary,
  SweepCellResult,
} from "#src/types/benchmark";

vi.mock("#src/routes/ChatRoutes", () => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
}));

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
  PRISM_PUSH_NTFY_TOPIC: undefined,
  PRISM_CLIENT_PUBLIC_URL: undefined,
}));

// ── In-memory Mongo (equality, $ne, sort, $set) ─────────────
const { collections } = vi.hoisted(() => ({ collections: new Map<string, any[]>() }));
vi.mock("#src/wrappers/MongoWrapper", () => {
  const matches = (document: any, query: any) =>
    Object.entries(query ?? {}).every(([key, value]) =>
      value && typeof value === "object" && "$ne" in (value as object)
        ? document[key] !== (value as any).$ne
        : document[key] === value,
    );
  const collection = (name: string) => {
    if (!collections.has(name)) collections.set(name, []);
    const documents = collections.get(name)!;
    const apply = (document: any, update: any) => Object.assign(document, update.$set ?? {});
    return {
      insertOne: async (document: any) => {
        documents.push(structuredClone(document));
        return { acknowledged: true };
      },
      findOne: async (query: any) => documents.find((document) => matches(document, query)) ?? null,
      find: (query: any) => {
        let sort: [string, number] | null = null;
        const cursor = {
          sort: (criteria: Record<string, number>) => {
            sort = Object.entries(criteria)[0] as [string, number];
            return cursor;
          },
          toArray: async () => {
            const found = documents.filter((document) => matches(document, query));
            if (sort) {
              const [field, direction] = sort;
              found.sort((first, second) =>
                first[field] < second[field] ? -direction : first[field] > second[field] ? direction : 0,
              );
            }
            return found;
          },
        };
        return cursor;
      },
      updateOne: async (filter: any, update: any) => {
        const document = documents.find((candidate) => matches(candidate, filter));
        if (document) apply(document, update);
        return { matchedCount: document ? 1 : 0 };
      },
      findOneAndUpdate: async (filter: any, update: any) => {
        const document = documents.find((candidate) => matches(candidate, filter));
        if (!document) return null;
        const before = { ...document };
        apply(document, update);
        return before;
      },
      deleteOne: async (filter: any) => {
        const index = documents.findIndex((document) => matches(document, filter));
        if (index >= 0) documents.splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      },
      deleteMany: async (filter: any) => {
        const kept = documents.filter((document) => !matches(document, filter));
        documents.splice(0, documents.length, ...kept);
        return { deletedCount: 0 };
      },
    };
  };
  return { default: { getDb: () => ({ collection }) } };
});

const docs = (name: string) => collections.get(name) ?? [];

// ── A scripted agent: effort high answers everything, low misses the hard case ──
const COSTS: Record<string, number> = { "gemini-3.5-flash-lite": 0.001, "gemini-3.5-flash": 0.004 };
function scriptAgent(answer?: (parameters: any) => string) {
  (handleAgent as any).mockImplementation(async (parameters: any, emit: any) => {
    const prompt: string = parameters.messages.at(-1).content;
    const text =
      answer?.(parameters) ??
      (parameters.reasoningEffort === "low" && prompt.includes("hard") ? "It is 41." : "It is 42.");
    emit({ type: "chunk", content: text });
    emit({
      type: "done",
      usage: { inputTokens: 100, outputTokens: 10 },
      estimatedCost: (COSTS[parameters.model] ?? 0.001) * (parameters.reasoningEffort === "high" ? 2 : 1),
    });
  });
}

const DATASET: BenchmarkDataset = {
  id: "dataset-1",
  project: "bench",
  username: "tester",
  name: "Arithmetic",
  agent: "CODING",
  k: 3,
  temperature: 0,
  cases: [
    { id: "easy", prompt: "What is 6 × 7?", graders: [{ type: "regex", pattern: "\\b42\\b" }] },
    { id: "hard", prompt: "A hard one: what is 6 × 7?", graders: [{ type: "regex", pattern: "\\b42\\b" }] },
  ],
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
};

const LITE = { provider: "google", model: "gemini-3.5-flash-lite" };
const FLASH = { provider: "google", model: "gemini-3.5-flash" };

beforeEach(() => {
  vi.clearAllMocks();
  collections.clear();
  scriptAgent();
});

describe("the sweep matrix", () => {
  it("is the cartesian product of the axes given, each cell keyed by its configuration", () => {
    const cells = buildSweepMatrix({
      models: [LITE, FLASH],
      effort: ["low", "high"],
      compactionThreshold: [32_000],
      toolDiscovery: ["preflight", "off"],
      topology: ["hierarchical"],
    });
    expect(cells).toHaveLength(8);
    expect(cells[0]).toMatchObject({
      key: "google:gemini-3.5-flash-lite|effort=low|window=32000|discovery=preflight|topology=hierarchical",
      label: "gemini-3.5-flash-lite · effort low · window 32K · discovery preflight · topology hierarchical",
      config: {
        target: LITE,
        settings: { effort: "low", compactionThreshold: 32_000, toolDiscovery: "preflight", topology: "hierarchical" },
      },
    });
    expect(new Set(cells.map((cell) => cell.key)).size).toBe(8);
  });

  it("an axis left out is not pinned; duplicates collapse", () => {
    const cells = buildSweepMatrix({ models: [LITE, LITE], effort: ["high", "high"] });
    expect(cells.map((cell) => cell.key)).toEqual(["google:gemini-3.5-flash-lite|effort=high"]);
    expect(cells[0].config.settings).toEqual({ effort: "high" });
  });

  it("validation", () => {
    expect(validateSweepAxes({ models: [] })).toMatch(/at least one target/);
    expect(validateSweepAxes({ models: [{ provider: "google" }] })).toMatch(/provider and a model/);
    expect(validateSweepAxes({ models: [LITE], compactionThreshold: [1_000] })).toMatch(/at least 8192/);
    expect(validateSweepAxes({ models: [LITE], toolDiscovery: ["sometimes"] })).toMatch(/preflight, on_demand, off/);
    expect(validateSweepAxes({ models: [LITE], topology: ["no-such-topology"] })).toMatch(/Unknown topology/);
    expect(
      validateSweepAxes({ models: [LITE, FLASH], effort: ["low", "medium", "high"], toolDiscovery: ["preflight", "on_demand", "off"], compactionThreshold: [16_000, 32_000] }),
    ).toMatch(/36 configurations/);
    expect(validateSweepAxes({ models: [LITE], effort: ["low"] })).toBeNull();
  });

  it("each harness setting becomes the request field a client would send", () => {
    expect(harnessSettingParams({ effort: "high", compactionThreshold: 16_384, toolDiscovery: "off", topology: "sequential" })).toEqual({
      thinkingEnabled: true,
      reasoningEffort: "high",
      contextWindowLimit: 16_384,
      toolDiscovery: "off",
      topology: "sequential",
    });
    expect(harnessSettingParams({ effort: "none" })).toMatchObject({ thinkingEnabled: false });
    expect(harnessSettingParams({})).toEqual({});
  });
});

describe("the Pareto frontier (cost ↓, latency ↓, pass^k ↑)", () => {
  const summary = (meanCostPerTrial: number, meanLatency: number, passHatK: number) =>
    ({ meanCostPerTrial, meanLatency, passHatK } as ReliabilitySummary);
  const cell = (key: string, value: ReliabilitySummary | null): SweepCellResult =>
    ({ key, label: key, config: { target: LITE, settings: {} }, runId: null, summary: value, pareto: false });

  it("keeps the cells nothing beats on all three at once", () => {
    const cells = markPareto([
      cell("cheap", summary(0.001, 2, 0.5)),
      cell("reliable", summary(0.002, 2, 1)),
      cell("dominated", summary(0.004, 3, 0.5)),
      cell("fast", summary(0.003, 1, 0.4)),
      cell("tied", summary(0.001, 2, 0.5)),
      cell("failed", null),
    ]);
    expect(Object.fromEntries(cells.map((each) => [each.key, each.pareto]))).toEqual({
      cheap: true,
      reliable: true,
      dominated: false,
      fast: true,
      tied: true,
      failed: false,
    });
  });
});

describe("runSweep", () => {
  it("runs the dataset once per cell, k times per case, and stores every run", async () => {
    const sweep = await runSweep({
      dataset: DATASET,
      axes: { models: [LITE, FLASH], effort: ["low", "high"] },
      project: "bench",
      username: "tester",
    });
    expect(sweep.status).toBe("complete");
    expect(sweep.cells).toHaveLength(4);
    // 4 cells × 2 cases × k = 3
    expect(handleAgent).toHaveBeenCalledTimes(24);
    const lowCall = (handleAgent as any).mock.calls.find(
      ([parameters]: any[]) => parameters.model === "gemini-3.5-flash" && parameters.reasoningEffort === "low",
    )[0];
    expect(lowCall).toMatchObject({ agent: "CODING", thinkingEnabled: true, reasoningEffort: "low", unattended: true });

    const byKey = Object.fromEntries(sweep.cells.map((cell) => [cell.key, cell.summary]));
    expect(byKey["google:gemini-3.5-flash-lite|effort=high"]).toMatchObject({ passRate: 1, passAtK: 1, passHatK: 1, trials: 6 });
    expect(byKey["google:gemini-3.5-flash-lite|effort=low"]).toMatchObject({ passRate: 0.5, passAtK: 0.5, passHatK: 0.5 });
    expect(byKey["google:gemini-3.5-flash|effort=high"]).toMatchObject({ meanCostPerTrial: 0.008, totalCost: 0.048 });

    const stored = docs("benchmark_sweeps");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: sweep.id, status: "complete", totalCost: sweep.totalCost });
    const runs = docs("benchmark_dataset_runs") as DatasetRun[];
    expect(runs).toHaveLength(4);
    for (const cell of sweep.cells) {
      const run = runs.find((candidate) => candidate.id === cell.runId)!;
      expect(run).toMatchObject({ configKey: cell.key, sweepId: sweep.id, k: 3 });
      expect(run.trials).toHaveLength(6);
    }
    // The client's cost-vs-accuracy chart reads these.
    expect(sweepStats(sweep)[0]).toMatchObject({ provider: "google", total: 6, runCount: 6 });
  });

  it("a stop ends the sweep where it is, kept as aborted", async () => {
    const stop = new AbortController();
    const sweep = await runSweep({
      dataset: DATASET,
      axes: { models: [LITE], effort: ["low", "high"] },
      project: "bench",
      username: "tester",
      signal: stop.signal,
      onCellComplete: () => stop.abort(),
    });
    expect(sweep.status).toBe("aborted");
    expect(sweep.cells.filter((cell) => cell.runId)).toHaveLength(1);
    expect(docs("benchmark_sweeps")[0].status).toBe("aborted");
  });
});

describe("compareSweeps", () => {
  const sweepWith = (id: string, passHatK: number, runId: string): BenchmarkSweep =>
    ({
      id,
      k: 3,
      status: "complete",
      cells: [
        {
          key: "google:gemini-3.5-flash-lite|effort=high",
          label: "lite · effort high",
          config: { target: LITE, settings: { effort: "high" } },
          runId,
          summary: { passHatK, passAtK: 1, passRate: passHatK } as ReliabilitySummary,
          pareto: true,
        },
      ],
    }) as unknown as BenchmarkSweep;
  const runWith = (id: string, hardPassed: number) =>
    ({
      id,
      cases: [
        { caseId: "easy", trials: 3, passed: 3, errored: 0, passAtK: 1, passHatK: 1 },
        { caseId: "hard", trials: 3, passed: hardPassed, errored: 0, passAtK: 1, passHatK: hardPassed === 3 ? 1 : 0 },
      ],
    }) as unknown as DatasetRun;

  it("a drop beyond the threshold regresses, naming the cases lost", () => {
    const runs = new Map([
      ["run-before", runWith("run-before", 3)],
      ["run-now", runWith("run-now", 1)],
    ]);
    const report = compareSweeps(sweepWith("before", 1, "run-before"), sweepWith("now", 0.5, "run-now"), runs, "passHatK", 0.1);
    expect(report).toMatchObject({
      regressed: true,
      baselineSweepId: "before",
      cells: [{ baseline: 1, current: 0.5, drop: 0.5, casesLost: ["hard"] }],
    });
  });

  it("a drop at (or under) the threshold is not a regression; nor is a first run", () => {
    const runs = new Map<string, DatasetRun>();
    expect(compareSweeps(sweepWith("before", 0.8, "a"), sweepWith("now", 0.7, "b"), runs, "passHatK", 0.1).regressed).toBe(false);
    expect(compareSweeps(sweepWith("before", 0.8, "a"), sweepWith("now", 0.69, "b"), runs, "passHatK", 0.1).regressed).toBe(true);
    expect(compareSweeps(null, sweepWith("now", 0, "b"), runs).regressed).toBe(false);
  });
});

describe("the scheduler runs a benchmark task and alerts on a regression", () => {
  const minuteKey = "never-ran";
  const seedSchedule = (overrides: Record<string, unknown> = {}) => {
    collections.set("benchmark_datasets", [structuredClone(DATASET)]);
    collections.set("scheduled_tasks", [
      {
        id: "schedule-1",
        name: "Nightly arithmetic",
        project: "bench",
        username: "tester",
        prompt: 'Benchmark regression sweep of "Arithmetic"',
        agent: null,
        provider: "google",
        model: "gemini-3.5-flash-lite",
        scheduleType: "cron",
        cronExpression: "* * * * *",
        enabled: true,
        lastRunMinute: minuteKey,
        kind: "benchmark",
        benchmark: {
          datasetId: DATASET.id,
          axes: { models: [LITE], effort: ["high"] },
          k: 2,
          threshold: 0.1,
          alert: { ntfyTopic: "prism-bench" },
        },
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
        ...overrides,
      },
    ]);
  };

  async function tickAndWait(expectedSweeps: number) {
    await ScheduledTaskService.tick();
    await vi.waitFor(
      () => {
        const sweeps = docs("benchmark_sweeps");
        expect(sweeps).toHaveLength(expectedSweeps);
        expect(sweeps.every((sweep) => sweep.regression !== undefined && sweep.regression !== null)).toBe(true);
      },
      { timeout: 5_000 },
    );
    return docs("benchmark_sweeps").at(-1) as BenchmarkSweep;
  }

  it("a sweep that got worse emits benchmark.regression and pushes to ntfy", async () => {
    const emitted = vi.spyOn(WebhookEventBus, "emit");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    seedSchedule();

    // First run: everything passes — the baseline.
    const first = await tickAndWait(1);
    expect(first).toMatchObject({ scheduleId: "schedule-1", status: "complete", regression: { regressed: false, baselineSweepId: null } });
    expect(emitted).not.toHaveBeenCalledWith("benchmark.regression", expect.anything());

    // Second run: the hard case starts failing.
    docs("scheduled_tasks")[0].lastRunMinute = minuteKey;
    scriptAgent((parameters) => (parameters.messages.at(-1).content.includes("hard") ? "It is 41." : "It is 42."));
    const second = await tickAndWait(2);
    expect(second.regression).toMatchObject({
      regressed: true,
      baselineSweepId: first.id,
      metric: "passHatK",
      cells: [{ baseline: 1, current: 0.5, casesLost: ["hard"] }],
      alerted: { webhook: true, ntfy: true },
    });
    expect(emitted).toHaveBeenCalledWith(
      "benchmark.regression",
      expect.objectContaining({ scheduleId: "schedule-1", sweepId: second.id, datasetName: "Arithmetic" }),
    );
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(url).toBe("http://tools.test/communication/push");
    expect(JSON.parse(String(init.body))).toMatchObject({
      topic: "prism-bench",
      title: "Benchmark regression · Arithmetic",
      priority: "high",
    });
    expect(JSON.parse(String(init.body)).message).toMatch(/pass\^2 1\.00 → 0\.50 \(lost hard\)/);
    vi.unstubAllGlobals();
  });

  it("webhook: false and no topic — the regression is recorded, nothing is sent", async () => {
    const emitted = vi.spyOn(WebhookEventBus, "emit");
    seedSchedule({
      benchmark: { datasetId: DATASET.id, axes: { models: [LITE], effort: ["high"] }, k: 2, alert: { webhook: false } },
    });
    await tickAndWait(1);
    docs("scheduled_tasks")[0].lastRunMinute = minuteKey;
    scriptAgent(() => "It is 41.");
    const second = await tickAndWait(2);
    expect(second.regression).toMatchObject({ regressed: true, alerted: { webhook: false, ntfy: false } });
    expect(emitted).not.toHaveBeenCalledWith("benchmark.regression", expect.anything());
  });

  it("a misconfigured schedule fails its run without touching the store", async () => {
    seedSchedule({ benchmark: { datasetId: "missing", axes: { models: [LITE] } } });
    await expect(
      ScheduledTaskService.executeTask(docs("scheduled_tasks")[0], undefined, { username: "tester" }),
    ).rejects.toThrow(/dataset missing not found/);
    expect(docs("benchmark_sweeps")).toHaveLength(0);
  });

  it("the store finds the previous finished sweep of a schedule", async () => {
    collections.set("benchmark_sweeps", [
      { id: "old", scheduleId: "s", project: "p", status: "complete", startedAt: "2026-09-21T00:00:00.000Z" },
      { id: "aborted", scheduleId: "s", project: "p", status: "aborted", startedAt: "2026-09-22T00:00:00.000Z" },
      { id: "current", scheduleId: "s", project: "p", status: "complete", startedAt: "2026-09-23T00:00:00.000Z" },
    ]);
    expect((await DatasetStore.previousScheduledSweep("s", "p", "current"))?.id).toBe("old");
  });
});

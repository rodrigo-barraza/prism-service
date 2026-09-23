/**
 * Benchmark datasets, sweeps and scheduled regression runs — mounted on
 * /benchmark ahead of BenchmarkRoutes (whose `/:id` would take these paths).
 *
 *   GET    /benchmark/datasets                    list
 *   POST   /benchmark/datasets                    create
 *   GET    /benchmark/datasets/:datasetId         one dataset
 *   PUT    /benchmark/datasets/:datasetId         update
 *   DELETE /benchmark/datasets/:datasetId         delete (with its runs and sweeps)
 *   POST   /benchmark/datasets/:datasetId/run     one configuration, k runs per case
 *   POST   /benchmark/datasets/:datasetId/sweeps  a settings matrix
 *   POST   /benchmark/datasets/:datasetId/schedule  a scheduled regression sweep
 *   GET    /benchmark/datasets/:datasetId/runs    its runs (without trial detail)
 *   GET    /benchmark/dataset-runs/:runId         one run, every trial
 *   GET    /benchmark/sweeps                      sweeps (?datasetId= / ?scheduleId=)
 *   GET    /benchmark/sweeps/:sweepId             one sweep + its per-config stats
 *
 * Runs and sweeps stream progress as SSE (`trial_complete`, `cell_start`,
 * `cell_complete`, then `run_complete` / `sweep_complete`); `?stream=false`
 * answers once with the result instead. A client that disconnects stops
 * the run; what finished is kept.
 */
import express, { type Request, type Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import { BENCHMARK } from "#src/constants";
import { resolveScope } from "#src/utils/ProfileScope";
import DatasetStore, { validateDatasetWrite } from "#src/services/benchmark/DatasetStore";
import { runDataset } from "#src/services/benchmark/DatasetRunner";
import {
  buildSweepMatrix,
  runSweep,
  sweepStats,
  validateSweepAxes,
} from "#src/services/benchmark/SweepRunner";
import { validateScheduledBenchmark } from "#src/services/benchmark/BenchmarkRegression";
import ScheduledTaskService from "#src/services/ScheduledTaskService";
import type {
  BenchmarkModelTarget,
  HarnessSettings,
  ScheduledBenchmarkConfig,
  SweepAxes,
} from "#src/types/benchmark";

const router = express.Router();

const SCHEDULE_TYPES = new Set(["hourly", "daily", "weekly", "cron", "once", "custom"]);

const projectOf = (req: Request) => req.project || null;
const usernameOf = (req: Request) => req.username || DEFAULT_USERNAME;

/**
 * A long run's response: SSE with a keepalive (default), or one JSON answer
 * (`?stream=false`). Either way the run is aborted if the client goes away.
 */
function openRunResponse(req: Request, res: Response) {
  const streaming = req.query.stream !== "false";
  const abortController = new AbortController();
  req.setTimeout(0);
  req.socket?.setTimeout(0);
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });
  let keepalive: ReturnType<typeof setInterval> | null = null;
  if (streaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(":keepalive\n\n");
    }, 15_000);
  }
  const send = (type: string, data: Record<string, unknown>) => {
    if (!streaming || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  const finish = (type: string, result: Record<string, unknown>) => {
    if (keepalive) clearInterval(keepalive);
    if (res.writableEnded) return;
    if (streaming) {
      send(type, result);
      res.end();
    } else {
      res.json(result);
    }
  };
  const fail = (error: unknown) => {
    if (keepalive) clearInterval(keepalive);
    if (res.writableEnded) return;
    if (streaming) {
      res.write(`data: ${JSON.stringify({ type: "error", message: getErrorMessage(error) })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: getErrorMessage(error) });
    }
  };
  return { signal: abortController.signal, send, finish, fail };
}

// ── Datasets ────────────────────────────────────────────────

router.get(
  "/datasets",
  asyncHandler(async (req: Request, res: Response) => {
    const datasets = await DatasetStore.list(projectOf(req));
    res.json({ datasets, count: datasets.length });
  }),
);

router.post(
  "/datasets",
  asyncHandler(async (req: Request, res: Response) => {
    const invalid = validateDatasetWrite(req.body ?? {}, true);
    if (invalid) return res.status(400).json({ error: invalid });
    const dataset = await DatasetStore.create(req.body, projectOf(req), usernameOf(req));
    res.status(201).json(dataset);
  }),
);

router.get(
  "/datasets/:datasetId",
  asyncHandler(async (req: Request, res: Response) => {
    const dataset = await DatasetStore.get(String(req.params.datasetId), projectOf(req));
    if (!dataset) return res.status(404).json({ error: "Dataset not found" });
    res.json(dataset);
  }),
);

router.put(
  "/datasets/:datasetId",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.datasetId);
    const existing = await DatasetStore.get(id, projectOf(req));
    if (!existing) return res.status(404).json({ error: "Dataset not found" });
    const invalid = validateDatasetWrite(req.body ?? {}, false);
    if (invalid) return res.status(400).json({ error: invalid });
    res.json(await DatasetStore.update(id, req.body, projectOf(req)));
  }),
);

router.delete(
  "/datasets/:datasetId",
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.datasetId);
    const existing = await DatasetStore.get(id, projectOf(req));
    if (!existing) return res.status(404).json({ error: "Dataset not found" });
    await DatasetStore.remove(id, projectOf(req));
    res.json({ deleted: true, id });
  }),
);

// ── Runs ────────────────────────────────────────────────────

/** A single configuration as the axes of a one-cell sweep (same validation). */
function axesOfConfiguration(target: BenchmarkModelTarget, settings: HarnessSettings = {}): SweepAxes {
  return {
    models: [target],
    ...(settings.effort !== undefined && { effort: [settings.effort] }),
    ...(settings.compactionThreshold !== undefined && {
      compactionThreshold: [settings.compactionThreshold],
    }),
    ...(settings.toolDiscovery !== undefined && { toolDiscovery: [settings.toolDiscovery] }),
    ...(settings.topology !== undefined && { topology: [settings.topology] }),
  };
}

function validateK(k: unknown): string | null {
  if (k === undefined) return null;
  const value = Number(k);
  return Number.isInteger(value) && value >= 1 && value <= BENCHMARK.MAX_K
    ? null
    : `k must be an integer between 1 and ${BENCHMARK.MAX_K}`;
}

router.post(
  "/datasets/:datasetId/run",
  asyncHandler(async (req: Request, res: Response) => {
    const dataset = await DatasetStore.get(String(req.params.datasetId), projectOf(req));
    if (!dataset) return res.status(404).json({ error: "Dataset not found" });
    const { target, settings, k } = req.body ?? {};
    const axes = axesOfConfiguration(target, settings && typeof settings === "object" ? settings : {});
    const invalid = validateSweepAxes(axes) ?? validateK(k);
    if (invalid) return res.status(400).json({ error: invalid });
    const [cell] = buildSweepMatrix(axes);

    const response = openRunResponse(req, res);
    try {
      const run = await runDataset({
        dataset,
        config: cell.config,
        k: k !== undefined ? Number(k) : dataset.k,
        project: projectOf(req),
        username: usernameOf(req),
        signal: response.signal,
        configKey: cell.key,
        onTrial: (trial) => response.send("trial_complete", { trial }),
      });
      response.finish("run_complete", { run });
    } catch (error: unknown) {
      logger.error(`POST /benchmark/datasets/:id/run error: ${getErrorMessage(error)}`);
      response.fail(error);
    }
  }),
);

router.post(
  "/datasets/:datasetId/sweeps",
  asyncHandler(async (req: Request, res: Response) => {
    const dataset = await DatasetStore.get(String(req.params.datasetId), projectOf(req));
    if (!dataset) return res.status(404).json({ error: "Dataset not found" });
    const { axes, k, name } = req.body ?? {};
    const invalid = validateSweepAxes(axes) ?? validateK(k);
    if (invalid) return res.status(400).json({ error: invalid });

    const response = openRunResponse(req, res);
    try {
      const sweep = await runSweep({
        dataset,
        axes,
        k: k !== undefined ? Number(k) : dataset.k,
        name: typeof name === "string" ? name : undefined,
        project: projectOf(req),
        username: usernameOf(req),
        signal: response.signal,
        onCellStart: (cell, index, total) =>
          response.send("cell_start", { key: cell.key, label: cell.label, index, total }),
        onCellComplete: (cell, index, total) =>
          response.send("cell_complete", { cell, index, total }),
        onTrial: (trial, cell) => response.send("trial_complete", { key: cell.key, trial }),
      });
      response.finish("sweep_complete", { sweep, stats: sweepStats(sweep) });
    } catch (error: unknown) {
      logger.error(`POST /benchmark/datasets/:id/sweeps error: ${getErrorMessage(error)}`);
      response.fail(error);
    }
  }),
);

router.post(
  "/datasets/:datasetId/schedule",
  asyncHandler(async (req: Request, res: Response) => {
    const dataset = await DatasetStore.get(String(req.params.datasetId), projectOf(req));
    if (!dataset) return res.status(404).json({ error: "Dataset not found" });
    const {
      name,
      scheduleType,
      scheduleTime,
      scheduleDay,
      scheduleDate,
      cronExpression,
      recurrenceRule,
      axes,
      k,
      metric,
      threshold,
      alert,
    } = req.body ?? {};
    const benchmark: ScheduledBenchmarkConfig = {
      datasetId: dataset.id,
      axes,
      ...(k !== undefined && { k: Number(k) }),
      ...(metric !== undefined && { metric }),
      ...(threshold !== undefined && { threshold }),
      ...(alert !== undefined && { alert }),
    };
    const invalid = validateScheduledBenchmark(benchmark);
    if (invalid) return res.status(400).json({ error: invalid });
    if (!SCHEDULE_TYPES.has(scheduleType)) {
      return res.status(400).json({ error: `scheduleType must be one of ${[...SCHEDULE_TYPES].join(", ")}` });
    }
    if (scheduleType === "cron" && typeof cronExpression !== "string") {
      return res.status(400).json({ error: "A cron schedule needs a cronExpression" });
    }
    if (scheduleType !== "cron" && scheduleType !== "hourly" && typeof scheduleTime !== "string") {
      return res.status(400).json({ error: `A ${scheduleType} schedule needs a scheduleTime (HH:MM)` });
    }
    const [firstTarget] = (axes as SweepAxes).models;
    const { profileId } = resolveScope(req);
    const task = await ScheduledTaskService.createTask({
      name: typeof name === "string" && name.trim() ? name.trim() : `Benchmark regression · ${dataset.name}`,
      prompt: `Benchmark regression sweep of "${dataset.name}"`,
      agent: null,
      provider: firstTarget.provider,
      model: firstTarget.model,
      scheduleType,
      scheduleTime,
      scheduleDay,
      scheduleDate,
      cronExpression,
      recurrenceRule,
      kind: "benchmark",
      benchmark,
      enabled: true,
      // The dataset's own scope: the run looks the dataset up with it.
      project: dataset.project as string,
      username: usernameOf(req),
      profileId,
    });
    res.status(201).json(task);
  }),
);

router.get(
  "/datasets/:datasetId/runs",
  asyncHandler(async (req: Request, res: Response) => {
    const runs = await DatasetStore.listRuns(String(req.params.datasetId), projectOf(req));
    // The list carries summaries; a run's trials come with GET /dataset-runs/:runId.
    const summaries = runs.map(({ trials: _trials, ...run }) => run);
    res.json({ runs: summaries, count: summaries.length });
  }),
);

router.get(
  "/dataset-runs/:runId",
  asyncHandler(async (req: Request, res: Response) => {
    const run = await DatasetStore.getRun(String(req.params.runId), projectOf(req));
    if (!run) return res.status(404).json({ error: "Run not found" });
    res.json(run);
  }),
);

// ── Sweeps ──────────────────────────────────────────────────

router.get(
  "/sweeps",
  asyncHandler(async (req: Request, res: Response) => {
    const filter = {
      ...(typeof req.query.datasetId === "string" && { datasetId: req.query.datasetId }),
      ...(typeof req.query.scheduleId === "string" && { scheduleId: req.query.scheduleId }),
    };
    const sweeps = await DatasetStore.listSweeps(filter, projectOf(req));
    res.json({ sweeps, count: sweeps.length });
  }),
);

router.get(
  "/sweeps/:sweepId",
  asyncHandler(async (req: Request, res: Response) => {
    const sweep = await DatasetStore.getSweep(String(req.params.sweepId), projectOf(req));
    if (!sweep) return res.status(404).json({ error: "Sweep not found" });
    res.json({ ...sweep, stats: sweepStats(sweep) });
  }),
);

export default router;

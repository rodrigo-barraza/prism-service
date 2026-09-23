/**
 * BenchmarkRegression — scheduled benchmark sweeps, and the alert when one
 * gets worse.
 *
 * A scheduled task of kind "benchmark" (ScheduledTaskService) runs its
 * dataset across its axes (SweepRunner) whenever the scheduler finds it due
 * or someone triggers it. Every cell is then compared with the same cell of
 * the schedule's previous finished sweep: a cell whose metric — pass^k
 * unless the schedule names another — fell by more than the threshold has
 * regressed. A regression is announced on the webhook bus
 * (`benchmark.regression`, delivered signed to every subscription that
 * listens for it) and, when a topic is known, on ntfy through tools-service.
 * The report is stored on the sweep either way.
 */
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PRISM_PUSH_NTFY_TOPIC } from "#config";
import { BENCHMARK } from "#src/constants";
import logger from "#src/utils/logger";
import WebhookEventBus, { BENCHMARK_WEBHOOK_EVENTS } from "#src/services/WebhookEventBus";
import { sendNtfyMessage } from "#src/services/push/PushNotifier";
import DatasetStore from "#src/services/benchmark/DatasetStore";
import { runSweep, validateSweepAxes } from "#src/services/benchmark/SweepRunner";
import type {
  BenchmarkDataset,
  BenchmarkSweep,
  CellRegression,
  DatasetRun,
  RegressionReport,
  ReliabilityMetric,
  ScheduledBenchmarkConfig,
} from "#src/types/benchmark";

export const RELIABILITY_METRICS: readonly ReliabilityMetric[] = ["passHatK", "passAtK", "passRate"];

/** The fields of a scheduled task this module reads. */
export interface ScheduledBenchmarkTask {
  id: string;
  name: string;
  project: string | null;
  benchmark?: ScheduledBenchmarkConfig;
}

const METRIC_NAMES: Record<ReliabilityMetric, (k: number) => string> = {
  passHatK: (k) => `pass^${k}`,
  passAtK: (k) => `pass@${k}`,
  passRate: () => "pass rate",
};

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** A scheduled benchmark's mistakes, or null. */
export function validateScheduledBenchmark(config: unknown): string | null {
  if (!config || typeof config !== "object") return "benchmark must be an object";
  const benchmark = config as Partial<ScheduledBenchmarkConfig>;
  if (typeof benchmark.datasetId !== "string" || !benchmark.datasetId) {
    return "benchmark.datasetId is required";
  }
  const axesError = validateSweepAxes(benchmark.axes);
  if (axesError) return axesError;
  if (benchmark.k !== undefined) {
    const k = Number(benchmark.k);
    if (!Number.isInteger(k) || k < 1 || k > BENCHMARK.MAX_K) {
      return `benchmark.k must be an integer between 1 and ${BENCHMARK.MAX_K}`;
    }
  }
  if (benchmark.metric !== undefined && !RELIABILITY_METRICS.includes(benchmark.metric)) {
    return `benchmark.metric must be one of ${RELIABILITY_METRICS.join(", ")}`;
  }
  if (
    benchmark.threshold !== undefined &&
    (typeof benchmark.threshold !== "number" || benchmark.threshold < 0 || benchmark.threshold > 1)
  ) {
    return "benchmark.threshold must be a number between 0 and 1";
  }
  if (benchmark.alert !== undefined) {
    const { webhook, ntfyTopic } = benchmark.alert ?? {};
    if (webhook !== undefined && typeof webhook !== "boolean") return "benchmark.alert.webhook must be a boolean";
    if (ntfyTopic !== undefined && ntfyTopic !== null && (typeof ntfyTopic !== "string" || !ntfyTopic.trim())) {
      return "benchmark.alert.ntfyTopic must be a topic name";
    }
  }
  return null;
}

/** Cases that passed every run of `baseline` and not every run of `current`. */
function casesLost(baseline: DatasetRun | undefined, current: DatasetRun | undefined): string[] {
  if (!baseline || !current) return [];
  return current.cases
    .filter((currentCase) => {
      const before = baseline.cases.find((baselineCase) => baselineCase.caseId === currentCase.caseId);
      return (
        before !== undefined &&
        before.trials > 0 &&
        before.passed === before.trials &&
        currentCase.passed < currentCase.trials
      );
    })
    .map((currentCase) => currentCase.caseId);
}

/**
 * Compare a sweep with the schedule's previous one, cell by cell (cells are
 * matched by their configuration key). Pure: `runs` holds the dataset runs
 * of both sweeps, for the cases each cell lost.
 */
export function compareSweeps(
  previous: BenchmarkSweep | null,
  current: BenchmarkSweep,
  runs: Map<string, DatasetRun>,
  metric: ReliabilityMetric = "passHatK",
  threshold: number = BENCHMARK.DEFAULT_REGRESSION_THRESHOLD,
): RegressionReport {
  const cells: CellRegression[] = [];
  for (const cell of current.cells) {
    const before = previous?.cells.find((candidate) => candidate.key === cell.key);
    if (!cell.summary || !before?.summary) continue;
    const baselineValue = before.summary[metric];
    const currentValue = cell.summary[metric];
    const drop = round(baselineValue - currentValue);
    if (drop <= threshold) continue;
    cells.push({
      key: cell.key,
      label: cell.label,
      baseline: baselineValue,
      current: currentValue,
      drop,
      casesLost: casesLost(
        before.runId ? runs.get(before.runId) : undefined,
        cell.runId ? runs.get(cell.runId) : undefined,
      ),
    });
  }
  return {
    metric,
    threshold,
    baselineSweepId: previous?.id ?? null,
    regressed: cells.length > 0,
    cells,
    alerted: { webhook: false, ntfy: false },
  };
}

/** Announce a regression on the webhook bus and ntfy. Resolves which channels carried it. */
export async function announceRegression({
  task,
  dataset,
  sweep,
  report,
}: {
  task: ScheduledBenchmarkTask;
  dataset: Pick<BenchmarkDataset, "id" | "name">;
  sweep: BenchmarkSweep;
  report: RegressionReport;
}): Promise<RegressionReport["alerted"]> {
  const alert = task.benchmark?.alert ?? {};
  const metricName = METRIC_NAMES[report.metric](sweep.k);
  const alerted = { webhook: false, ntfy: false };
  if (alert.webhook !== false) {
    WebhookEventBus.emit(BENCHMARK_WEBHOOK_EVENTS.REGRESSION, {
      scheduleId: task.id,
      scheduleName: task.name,
      project: task.project,
      datasetId: dataset.id,
      datasetName: dataset.name,
      sweepId: sweep.id,
      baselineSweepId: report.baselineSweepId,
      metric: report.metric,
      threshold: report.threshold,
      cells: report.cells,
    });
    alerted.webhook = true;
  }
  const topic = alert.ntfyTopic?.trim() || PRISM_PUSH_NTFY_TOPIC;
  if (topic) {
    const lines = report.cells
      .slice(0, 3)
      .map(
        (cell) =>
          `${cell.label}: ${metricName} ${cell.baseline.toFixed(2)} → ${cell.current.toFixed(2)}` +
          (cell.casesLost.length > 0 ? ` (lost ${cell.casesLost.slice(0, 3).join(", ")})` : ""),
      );
    if (report.cells.length > 3) lines.push(`…and ${report.cells.length - 3} more`);
    try {
      alerted.ntfy = await sendNtfyMessage({
        topic,
        title: `Benchmark regression · ${dataset.name}`,
        message: lines.join("\n"),
        priority: "high",
      });
    } catch (error: unknown) {
      logger.warn(`[BenchmarkRegression] ntfy alert failed: ${getErrorMessage(error)}`);
    }
  }
  return alerted;
}

/**
 * Run a scheduled benchmark: its sweep, the comparison with the previous
 * one, the alert. The scheduler's tick and a manual trigger both land here.
 */
export async function runScheduledBenchmark(
  task: ScheduledBenchmarkTask,
  { username }: { username: string },
): Promise<BenchmarkSweep> {
  const config = task.benchmark;
  const invalid = validateScheduledBenchmark(config);
  if (invalid || !config) {
    throw new Error(`Scheduled benchmark "${task.name}" is misconfigured: ${invalid}`);
  }
  const dataset = await DatasetStore.get(config.datasetId, task.project);
  if (!dataset) {
    throw new Error(`Scheduled benchmark "${task.name}": dataset ${config.datasetId} not found`);
  }
  logger.info(`[BenchmarkRegression] Running scheduled benchmark "${task.name}" (${dataset.name})`);
  const sweep = await runSweep({
    dataset,
    axes: config.axes,
    k: config.k ?? dataset.k,
    name: task.name,
    project: task.project,
    username,
    scheduleId: task.id,
  });
  const previous = await DatasetStore.previousScheduledSweep(task.id, task.project, sweep.id);
  const runIds = [...(previous?.cells ?? []), ...sweep.cells]
    .map((cell) => cell.runId)
    .filter((runId): runId is string => !!runId);
  const runs = (await Promise.all(runIds.map((runId) => DatasetStore.getRun(runId, task.project))))
    .filter((run): run is DatasetRun => !!run);
  const report = compareSweeps(
    previous,
    sweep,
    new Map(runs.map((run) => [run.id, run])),
    config.metric ?? "passHatK",
    config.threshold ?? BENCHMARK.DEFAULT_REGRESSION_THRESHOLD,
  );
  if (report.regressed) {
    report.alerted = await announceRegression({ task, dataset, sweep, report });
    logger.warn(
      `[BenchmarkRegression] "${task.name}" regressed in ${report.cells.length} configuration(s) — alerted ${JSON.stringify(report.alerted)}`,
    );
  }
  sweep.regression = report;
  await DatasetStore.updateSweep(sweep.id, { regression: report });
  return sweep;
}

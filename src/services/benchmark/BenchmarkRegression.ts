/**
 * BenchmarkRegression — comparing two runs, and scheduled runs that alert
 * when they get worse.
 *
 * Two runs are compared per suite they share and per contestant (by key)
 * they share, on the cases both evaluated: the paired difference head −
 * base with its interval and test (Statistics.pairedComparison), plus the
 * cases that improved and regressed. A scheduled run (a scheduled task of
 * kind "benchmark") is compared with the schedule's previous completed
 * run when it ends; a contestant whose suite score fell by more than the
 * threshold AND significantly has regressed — a drop inside the noise is
 * not an alert. Regressions go out on the webhook bus
 * (`benchmark.regression`) and ntfy, and are stored on the run.
 */
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { MONGO_DB_NAME, PRISM_PUSH_NTFY_TOPIC } from "#config";
import { BENCHMARK, COLLECTIONS } from "#src/constants";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import logger from "#src/utils/logger";
import WebhookEventBus, { BENCHMARK_WEBHOOK_EVENTS } from "#src/services/WebhookEventBus";
import { sendNtfyMessage } from "#src/services/push/PushNotifier";
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import { caseScoresOf } from "#src/services/benchmark/RunReport";
import { caseTask } from "#src/services/benchmark/Cases";
import { pairedComparison } from "#src/services/benchmark/Statistics";
import { prepareContestants } from "#src/services/benchmark/Contestants";
import type {
  BenchmarkRun,
  BenchmarkSample,
  Regression,
  RegressionReport,
  RunComparison,
  RunComparisonCase,
  ScheduledBenchmarkConfig,
} from "#src/types/benchmark";

const SIGNIFICANCE = 0.05;
const MAX_COMPARISON_CASES = 3000;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Compare `head` with `base` on everything they share. */
export function compareRuns(base: BenchmarkRun, head: BenchmarkRun, baseSamples: BenchmarkSample[], headSamples: BenchmarkSample[]): RunComparison {
  const deltas: RunComparison["deltas"] = [];
  const cases: RunComparisonCase[] = [];
  for (const headSuite of head.suites) {
    const baseSuite = base.suites.find((suite) => suite.id === headSuite.id);
    if (!baseSuite) continue;
    const caseText = new Map(headSuite.cases.map((datasetCase) => [datasetCase.id, caseTask(datasetCase)]));
    for (const contestant of head.contestants) {
      if (!base.contestants.some((other) => other.key === contestant.key)) continue;
      const before = caseScoresOf(baseSuite, baseSamples, contestant.key);
      const after = caseScoresOf(headSuite, headSamples, contestant.key);
      const shared = [...after.keys()].filter((caseId) => before.has(caseId));
      const baseScores = shared.map((caseId) => before.get(caseId)!.mean);
      const headScores = shared.map((caseId) => after.get(caseId)!.mean);
      const paired = pairedComparison(headScores, baseScores);
      let improved = 0;
      let regressed = 0;
      for (const caseId of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(caseId)?.mean ?? null;
        const current = after.get(caseId)?.mean ?? null;
        let change: RunComparisonCase["change"];
        if (previous === null) change = "new";
        else if (current === null) change = "missing";
        else if (current > previous + 1e-9) change = "improved";
        else if (current < previous - 1e-9) change = "regressed";
        else change = "unchanged";
        if (change === "improved") improved++;
        if (change === "regressed") regressed++;
        if (change !== "unchanged" && cases.length < MAX_COMPARISON_CASES) {
          const text = (caseText.get(caseId) ?? "").replace(/\s+/g, " ").trim();
          cases.push({
            suiteId: headSuite.id,
            caseId,
            input: text.length > 200 ? `${text.slice(0, 200)}…` : text,
            contestantKey: contestant.key,
            base: previous === null ? null : round(previous, 4),
            head: current === null ? null : round(current, 4),
            change,
          });
        }
      }
      const baseMean = baseScores.length > 0 ? baseScores.reduce((sum, value) => sum + value, 0) / baseScores.length : 0;
      const headMean = headScores.length > 0 ? headScores.reduce((sum, value) => sum + value, 0) / headScores.length : 0;
      deltas.push({
        suiteId: headSuite.id,
        suiteName: headSuite.name,
        contestantKey: contestant.key,
        label: contestant.label,
        base: round(baseMean),
        head: round(headMean),
        diff: round(paired.diff),
        ci: { low: round(paired.low), high: round(paired.high) },
        pValue: round(paired.pValue, 8),
        significant: paired.test !== "none" && paired.pValue < SIGNIFICANCE,
        improved,
        regressed,
      });
    }
  }
  return {
    base: { id: base.id, name: base.name, completedAt: base.completedAt ?? null },
    head: { id: head.id, name: head.name, completedAt: head.completedAt ?? null },
    deltas,
    cases,
  };
}

/** Regressions: significant drops beyond the threshold, with the cases lost. */
export function findRegressions(
  comparison: RunComparison,
  base: BenchmarkRun,
  head: BenchmarkRun,
  baseSamples: BenchmarkSample[],
  headSamples: BenchmarkSample[],
  threshold: number,
): Regression[] {
  const regressions: Regression[] = [];
  for (const delta of comparison.deltas) {
    if (!(delta.diff < -threshold && delta.significant)) continue;
    const baseSuite = base.suites.find((suite) => suite.id === delta.suiteId)!;
    const headSuite = head.suites.find((suite) => suite.id === delta.suiteId)!;
    const before = caseScoresOf(baseSuite, baseSamples, delta.contestantKey);
    const after = caseScoresOf(headSuite, headSamples, delta.contestantKey);
    const casesLost = [...before.entries()]
      .filter(([caseId, stats]) => stats.passes === stats.counted && after.has(caseId) && after.get(caseId)!.passes < after.get(caseId)!.counted)
      .map(([caseId]) => caseId);
    regressions.push({
      suiteId: delta.suiteId,
      suiteName: delta.suiteName,
      contestantKey: delta.contestantKey,
      label: delta.label,
      baseline: delta.base,
      current: delta.head,
      diff: delta.diff,
      ci: delta.ci,
      pValue: delta.pValue,
      casesLost,
    });
  }
  return regressions;
}

async function announce(run: BenchmarkRun, report: RegressionReport, config: ScheduledBenchmarkConfig | null): Promise<RegressionReport["alerted"]> {
  const alert = config?.alert ?? {};
  const alerted = { webhook: false, ntfy: false };
  if (alert.webhook !== false) {
    WebhookEventBus.emit(BENCHMARK_WEBHOOK_EVENTS.REGRESSION, {
      scheduleId: run.scheduleId,
      runId: run.id,
      runName: run.name,
      project: run.project,
      baselineRunId: report.baselineRunId,
      threshold: report.threshold,
      regressions: report.regressions,
    });
    alerted.webhook = true;
  }
  const topic = alert.ntfyTopic?.trim() || PRISM_PUSH_NTFY_TOPIC;
  if (topic) {
    const lines = report.regressions
      .slice(0, 4)
      .map(
        (regression) =>
          `${regression.label} · ${regression.suiteName}: ${Math.round(regression.baseline * 100)}% → ${Math.round(regression.current * 100)}%` +
          (regression.casesLost.length > 0 ? ` (lost ${regression.casesLost.slice(0, 3).join(", ")})` : ""),
      );
    if (report.regressions.length > 4) lines.push(`…and ${report.regressions.length - 4} more`);
    try {
      alerted.ntfy = await sendNtfyMessage({
        topic,
        title: `Benchmark regression · ${run.name}`,
        message: lines.join("\n"),
        priority: "high",
        clickPath: `/benchmarks/runs/${run.id}`,
      });
    } catch (error: unknown) {
      logger.warn(`[BenchmarkRegression] ntfy alert failed: ${getErrorMessage(error)}`);
    }
  }
  return alerted;
}

/** When a scheduled run completes: compare with the schedule's previous completed run and alert. */
export async function compareWithPreviousScheduledRun(run: BenchmarkRun): Promise<RegressionReport | null> {
  if (!run.scheduleId) return null;
  const previous = (await BenchmarkStore.listRuns(run.project, { scheduleId: run.scheduleId, limit: 20 })).find(
    (candidate) => candidate.id !== run.id && candidate.status === "completed" && candidate.createdAt < run.createdAt,
  );
  const task = (await MongoWrapper.getDb(MONGO_DB_NAME)
    ?.collection(COLLECTIONS.SCHEDULED_TASKS)
    .findOne({ id: run.scheduleId })
    .catch(() => null)) as { benchmark?: ScheduledBenchmarkConfig } | null;
  const threshold = task?.benchmark?.threshold ?? BENCHMARK.DEFAULT_REGRESSION_THRESHOLD;
  if (!previous) {
    const report: RegressionReport = { baselineRunId: null, threshold, regressed: false, regressions: [], alerted: { webhook: false, ntfy: false } };
    await BenchmarkStore.updateRun(run.id, { regression: report });
    return report;
  }
  const [baseSamples, headSamples] = await Promise.all([BenchmarkStore.listSamples(previous.id), BenchmarkStore.listSamples(run.id)]);
  const comparison = compareRuns(previous, run, baseSamples, headSamples);
  const regressions = findRegressions(comparison, previous, run, baseSamples, headSamples, threshold);
  const report: RegressionReport = {
    baselineRunId: previous.id,
    threshold,
    regressed: regressions.length > 0,
    regressions,
    alerted: { webhook: false, ntfy: false },
  };
  if (report.regressed) {
    report.alerted = await announce(run, report, task?.benchmark ?? null);
    logger.warn(`[BenchmarkRegression] "${run.name}" regressed for ${regressions.length} contestant/suite pair(s) — alerted ${JSON.stringify(report.alerted)}`);
  }
  await BenchmarkStore.updateRun(run.id, { regression: report, baselineRunId: previous.id });
  return report;
}

/** A scheduled benchmark's mistakes, or null. */
export function validateScheduledBenchmark(config: unknown): string | null {
  if (!config || typeof config !== "object") return "benchmark must be an object";
  const benchmark = config as Partial<ScheduledBenchmarkConfig>;
  if (!Array.isArray(benchmark.suiteIds) || benchmark.suiteIds.length === 0) return "benchmark.suiteIds needs at least one suite";
  const prepared = prepareContestants(benchmark.contestants);
  if ("error" in prepared) return `benchmark.contestants: ${prepared.error}`;
  if (benchmark.threshold != null && !(Number(benchmark.threshold) > 0 && Number(benchmark.threshold) < 1)) {
    return "benchmark.threshold must be between 0 and 1";
  }
  const topic = benchmark.alert?.ntfyTopic;
  if (topic != null && (typeof topic !== "string" || !topic.trim())) return "benchmark.alert.ntfyTopic must be a topic name";
  return null;
}

/** The fields of a scheduled task this module reads. */
export interface ScheduledBenchmarkTask {
  id: string;
  name: string;
  project: string | null;
  benchmark?: ScheduledBenchmarkConfig;
}

/** The scheduler's tick (or a manual trigger): start the schedule's run. It compares itself when it ends. */
export async function runScheduledBenchmark(task: ScheduledBenchmarkTask, { username }: { username: string }): Promise<BenchmarkRun> {
  const config = task.benchmark;
  const invalid = validateScheduledBenchmark(config);
  if (invalid || !config) throw new Error(`Scheduled benchmark "${task.name}" is misconfigured: ${invalid}`);
  const { startRun } = await import("#src/services/benchmark/Runs");
  logger.info(`[BenchmarkRegression] Starting scheduled benchmark "${task.name}"`);
  return startRun(
    {
      name: `${config.name || task.name} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      suiteIds: config.suiteIds,
      contestants: config.contestants,
      settings: config.settings,
      scheduleId: task.id,
    },
    { project: task.project, username },
  );
}

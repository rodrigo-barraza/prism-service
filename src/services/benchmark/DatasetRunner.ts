/**
 * DatasetRunner — a dataset under one configuration, k runs per case.
 *
 * Each run of a case is independent: its own request, its own scratch
 * workspace when the case seeds files or checks one (created before, removed
 * after), its own grading. An errored run counts as a failed one — the
 * summary keeps them apart (`erroredTrials`), but a turn that cannot finish
 * is a turn that did not pass. Runs go BENCHMARK.DATASET_CONCURRENCY at a
 * time; a stop ends the ones not started ("Aborted") and the run is kept,
 * marked aborted.
 */
import crypto from "crypto";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { BENCHMARK } from "#src/constants";
import logger from "#src/utils/logger";
import {
  executeBenchmarkPrompt,
  resolveEnabledTools,
} from "#src/services/benchmark/BenchmarkExecutor";
import { gradeCase } from "#src/services/benchmark/DatasetGraders";
import {
  createScratchWorkspace,
  removeScratchWorkspace,
  type ScratchWorkspace,
  type WorkspaceIdentity,
} from "#src/services/benchmark/ScratchWorkspace";
import { summarizeCases, summarizeReliability } from "#src/services/benchmark/ReliabilityMetrics";
import DatasetStore from "#src/services/benchmark/DatasetStore";
import type {
  BenchmarkDataset,
  BenchmarkRunConfig,
  CaseTrialResult,
  DatasetCase,
  DatasetRun,
} from "#src/types/benchmark";

export interface DatasetRunOptions {
  dataset: BenchmarkDataset;
  config: BenchmarkRunConfig;
  /** Runs per case (default: the dataset's k). */
  k?: number;
  project: string | null;
  username: string;
  signal?: AbortSignal;
  sweepId?: string | null;
  scheduleId?: string | null;
  /** The configuration's key in its sweep (default: derived from the config). */
  configKey?: string;
  concurrency?: number;
  onTrial?: (trial: CaseTrialResult) => void;
}

/** A stable id for a configuration: the same settings always spell the same key. */
export function configKeyOf(config: BenchmarkRunConfig): string {
  const { target, settings } = config;
  const parts = [
    `${target.provider}:${target.model}${target.agent ? `@${target.agent}` : ""}${target.thinkingEnabled ? "+thinking" : ""}`,
    settings.effort !== undefined ? `effort=${settings.effort}` : null,
    settings.compactionThreshold !== undefined ? `window=${settings.compactionThreshold}` : null,
    settings.toolDiscovery !== undefined ? `discovery=${settings.toolDiscovery}` : null,
    settings.topology !== undefined ? `topology=${settings.topology}` : null,
  ];
  return parts.filter(Boolean).join("|");
}

export function clampK(k: unknown): number {
  const value = Math.floor(Number(k));
  if (!Number.isFinite(value) || value < 1) return BENCHMARK.DEFAULT_K;
  return Math.min(value, BENCHMARK.MAX_K);
}

/** Run `jobs` with at most `limit` in flight, results in job order. */
async function runPool<Job, Result>(
  jobs: Job[],
  limit: number,
  run: (job: Job) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await run(jobs[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function needsWorkspace(datasetCase: DatasetCase): boolean {
  return (
    Object.keys(datasetCase.files ?? {}).length > 0 ||
    datasetCase.graders.some((grader) => grader.type === "file_exists")
  );
}

const roundSeconds = (seconds: number) => Math.round(seconds * 1000) / 1000;

async function runTrial({
  dataset,
  datasetCase,
  trial,
  config,
  runId,
  identity,
  signal,
}: {
  dataset: BenchmarkDataset;
  datasetCase: DatasetCase;
  trial: number;
  config: BenchmarkRunConfig;
  runId: string;
  identity: WorkspaceIdentity;
  signal?: AbortSignal;
}): Promise<CaseTrialResult> {
  const errored = (error: string, latency = 0): CaseTrialResult => ({
    caseId: datasetCase.id,
    trial,
    passed: false,
    graderResults: [],
    response: null,
    toolNames: [],
    turnCount: 0,
    latency: roundSeconds(latency),
    usage: null,
    cost: 0,
    error,
  });
  if (signal?.aborted) return errored("Aborted");

  let workspace: ScratchWorkspace | null = null;
  try {
    if (needsWorkspace(datasetCase)) {
      workspace = await createScratchWorkspace({
        baseRoot: dataset.workspaceRoot,
        runId,
        caseId: datasetCase.id,
        trial,
        files: datasetCase.files,
        identity,
      });
    }
  } catch (error: unknown) {
    return errored(`Scratch workspace: ${getErrorMessage(error)}`);
  }

  try {
    // The dataset's persona unless the configuration names its own.
    const target = {
      ...config.target,
      ...(!config.target.agent && dataset.agent && { agent: dataset.agent }),
    };
    const execution = await executeBenchmarkPrompt({
      prompt: datasetCase.prompt,
      systemPrompt: datasetCase.systemPrompt,
      target,
      enabledTools: resolveEnabledTools(dataset.enabledTools, target),
      constrainTools: !!(target.enabledTools?.length || dataset.enabledTools?.length),
      temperature: dataset.temperature,
      maxTokens: dataset.maxTokens,
      settings: config.settings,
      workspaceRoot: workspace?.root ?? null,
      project: identity.project,
      username: identity.username,
      signal,
    });
    if (execution.error) return errored(execution.error, execution.latency);
    const grade = await gradeCase(datasetCase.graders, execution, {
      datasetCase,
      workspace,
      identity,
      signal,
    });
    return {
      caseId: datasetCase.id,
      trial,
      passed: grade.passed,
      graderResults: grade.results,
      response: execution.response || null,
      toolNames: execution.toolNames,
      turnCount: execution.turnCount,
      latency: roundSeconds(execution.latency),
      usage: execution.usage,
      cost: (execution.estimatedCost ?? 0) + grade.judgeCost,
      ...(grade.judgeCost > 0 && { judgeCost: grade.judgeCost }),
      error: null,
    };
  } finally {
    if (workspace) await removeScratchWorkspace(workspace, identity);
  }
}

/** Run a dataset under one configuration and store the run. */
export async function runDataset(options: DatasetRunOptions): Promise<DatasetRun> {
  const { dataset, config, signal } = options;
  const k = clampK(options.k ?? dataset.k);
  const runId = crypto.randomUUID();
  const identity: WorkspaceIdentity = { project: options.project, username: options.username };
  const startedAt = new Date().toISOString();
  const jobs = dataset.cases.flatMap((datasetCase) =>
    Array.from({ length: k }, (_, index) => ({ datasetCase, trial: index + 1 })),
  );
  logger.info(
    `[benchmark] Dataset "${dataset.name}" × ${configKeyOf(config)}: ${dataset.cases.length} case(s) × k=${k}`,
  );
  const trials = await runPool(
    jobs,
    options.concurrency ?? BENCHMARK.DATASET_CONCURRENCY,
    async ({ datasetCase, trial }) => {
      const result = await runTrial({
        dataset,
        datasetCase,
        trial,
        config,
        runId,
        identity,
        signal,
      });
      try {
        options.onTrial?.(result);
      } catch {
        /* a listener never breaks a run */
      }
      return result;
    },
  );
  const cases = summarizeCases(dataset.cases, trials, k);
  const run: DatasetRun = {
    id: runId,
    datasetId: dataset.id,
    datasetName: dataset.name,
    project: options.project,
    config,
    configKey: options.configKey ?? configKeyOf(config),
    k,
    trials,
    cases,
    summary: summarizeReliability(cases, trials, k),
    aborted: !!signal?.aborted,
    sweepId: options.sweepId ?? null,
    scheduleId: options.scheduleId ?? null,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  await DatasetStore.saveRun(run);
  logger.info(
    `[benchmark] Dataset "${dataset.name}" × ${run.configKey}: pass rate ${run.summary.passRate}, ` +
      `pass@${k} ${run.summary.passAtK}, pass^${k} ${run.summary.passHatK}, $${run.summary.totalCost.toFixed(4)}`,
  );
  return run;
}

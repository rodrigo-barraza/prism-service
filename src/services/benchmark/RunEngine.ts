/**
 * RunEngine — runs a benchmark in the background and keeps it resumable.
 *
 * A run is a job, not a request: it keeps going when the page that started
 * it closes, streams its progress to whoever listens (RunEvents), and
 * persists every sample the moment it is graded. Samples are scheduled
 * case-major — every contestant answers case 1 (every epoch) before case 2
 * — so a run stopped half-way still compares everyone on the same cases.
 * At most `concurrency` samples run at once, and at most
 * `providerConcurrency` per provider (a local instance: its own limit).
 *
 * A sample that fails on the infrastructure (a 429, a dropped stream, a
 * timeout) is retried up to `maxAttempts` times with backoff; one that
 * fails on its own (a refusal, a context overflow) is not. Spend is
 * checked before every sample: at `budgetUsd` the run stops starting new
 * ones. A restart marks unfinished runs `interrupted`; resuming runs what
 * is left (pending, errored, cancelled samples) and nothing else.
 *
 * Pairwise judging (settings.pairwise) follows the samples: the answers of
 * two contestants to the same case and epoch, judged head to head, become
 * battles (Arena).
 */
import crypto from "crypto";
import { EventEmitter } from "node:events";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { BENCHMARK } from "#src/constants";
import logger from "#src/utils/logger";
import { getInstance, isInstance } from "#src/providers/instance-registry";
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import { executeSample, resolveTools, type Execution } from "#src/services/benchmark/BenchmarkExecutor";
import { gradeSample, needsWorkspace } from "#src/services/benchmark/Scorers";
import {
  createScratchWorkspace,
  removeScratchRun,
  removeScratchWorkspace,
  writeWorkspaceFiles,
  type ScratchWorkspace,
  type WorkspaceIdentity,
} from "#src/services/benchmark/ScratchWorkspace";
import { judgePairwise, panelWinner, resolveJudges } from "#src/services/benchmark/BenchmarkJudge";
import { battleStyle } from "#src/services/benchmark/Arena";
import { caseMessages, caseTask } from "#src/services/benchmark/Cases";
import { buildReport, resultsOf } from "#src/services/benchmark/RunReport";
import type {
  Battle,
  BenchmarkRun,
  BenchmarkSample,
  Contestant,
  RunProgress,
  RunStatus,
  RunSuite,
  SampleError,
  SampleOutput,
  SuiteCase,
} from "#src/types/benchmark";

// ── Live state ──────────────────────────────────────────────

/** What a listener receives (GET /benchmark/runs/:id/events). */
export type RunEvent =
  | { type: "status"; runId: string; status: RunStatus; statusReason?: string | null; progress: RunProgress }
  | { type: "progress"; runId: string; progress: RunProgress }
  | { type: "sample"; runId: string; sample: SampleSummary }
  | { type: "battle"; runId: string; battle: Pick<Battle, "id" | "suiteId" | "caseId" | "epoch" | "winner"> & { a: string; b: string } };

export type SampleSummary = Pick<
  BenchmarkSample,
  "id" | "suiteId" | "caseId" | "contestantKey" | "epoch" | "status" | "score" | "passed" | "cost" | "judgeCost" | "latencyMs" | "error"
>;

interface LiveRun {
  run: BenchmarkRun;
  controller: AbortController;
  emitter: EventEmitter;
  progress: RunProgress;
  stopReason: string | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

const liveRuns = new Map<string, LiveRun>();
let activeSamples = 0;

export const RunEvents = {
  /** Listen to a live run; returns the unsubscribe, or null when the run is not live here. */
  subscribe(runId: string, listener: (event: RunEvent) => void): (() => void) | null {
    const live = liveRuns.get(runId);
    if (!live) return null;
    live.emitter.on("event", listener);
    return () => live.emitter.off("event", listener);
  },
  isLive: (runId: string) => liveRuns.has(runId),
  progressOf: (runId: string) => liveRuns.get(runId)?.progress ?? null,
};

/** Benchmark samples generating right now (the admin's active-generation count). */
export const activeBenchmarkSamples = () => activeSamples;

function emit(live: LiveRun, event: RunEvent) {
  try {
    live.emitter.emit("event", event);
  } catch (error: unknown) {
    logger.warn(`[benchmark] A run listener threw: ${getErrorMessage(error)}`);
  }
}

/** Persist the progress at most once a second while samples stream in. */
function scheduleProgressPersist(live: LiveRun) {
  if (live.persistTimer) return;
  live.persistTimer = setTimeout(() => {
    live.persistTimer = null;
    BenchmarkStore.updateRun(live.run.id, { progress: { ...live.progress } }).catch((error: unknown) =>
      logger.warn(`[benchmark] Could not persist progress of ${live.run.id}: ${getErrorMessage(error)}`),
    );
  }, 1000);
}

async function setStatus(live: LiveRun, status: RunStatus, fields: Partial<BenchmarkRun> = {}) {
  live.run.status = status;
  Object.assign(live.run, fields);
  if (live.persistTimer) {
    clearTimeout(live.persistTimer);
    live.persistTimer = null;
  }
  await BenchmarkStore.updateRun(live.run.id, { status, progress: { ...live.progress }, ...fields });
  emit(live, { type: "status", runId: live.run.id, status, statusReason: live.run.statusReason ?? null, progress: { ...live.progress } });
}

// ── Building a run ──────────────────────────────────────────

export const emptyProgress = (total: number): RunProgress => ({
  total,
  done: 0,
  errored: 0,
  running: 0,
  cost: 0,
  judgeCost: 0,
  battlesTotal: 0,
  battlesDone: 0,
});

/** Every sample of a run, pending, in scheduling order. */
export function planSamples(run: Pick<BenchmarkRun, "id" | "project" | "suites" | "contestants" | "settings">): BenchmarkSample[] {
  const samples: BenchmarkSample[] = [];
  for (const suite of run.suites) {
    for (const datasetCase of suite.cases) {
      for (let epoch = 1; epoch <= run.settings.epochs; epoch++) {
        for (const contestant of run.contestants) {
          samples.push({
            id: crypto.randomUUID(),
            runId: run.id,
            project: run.project,
            suiteId: suite.id,
            caseId: datasetCase.id,
            contestantKey: contestant.key,
            epoch,
            status: "pending",
            output: null,
            scores: [],
            score: null,
            passed: null,
            usage: null,
            cost: 0,
            judgeCost: 0,
            latencyMs: null,
            ttftMs: null,
            tokensPerSecond: null,
            error: null,
            attempts: 0,
          });
        }
      }
    }
  }
  return samples;
}

// ── Scheduling ──────────────────────────────────────────────

interface Job {
  sample: BenchmarkSample;
  suite: RunSuite;
  suiteIndex: number;
  datasetCase: SuiteCase;
  caseIndex: number;
  contestant: Contestant;
  contestantIndex: number;
}

function buildJobs(run: BenchmarkRun, samples: BenchmarkSample[]): Job[] {
  const suiteIndex = new Map(run.suites.map((suite, index) => [suite.id, index]));
  const contestantIndex = new Map(run.contestants.map((contestant, index) => [contestant.key, index]));
  const jobs: Job[] = [];
  for (const sample of samples) {
    const suitePosition = suiteIndex.get(sample.suiteId);
    const contestantPosition = contestantIndex.get(sample.contestantKey);
    if (suitePosition === undefined || contestantPosition === undefined) continue;
    const suite = run.suites[suitePosition];
    const casePosition = suite.cases.findIndex((datasetCase) => datasetCase.id === sample.caseId);
    if (casePosition < 0) continue;
    jobs.push({
      sample,
      suite,
      suiteIndex: suitePosition,
      datasetCase: suite.cases[casePosition],
      caseIndex: casePosition,
      contestant: run.contestants[contestantPosition],
      contestantIndex: contestantPosition,
    });
  }
  return jobs.sort(
    (first, second) =>
      first.suiteIndex - second.suiteIndex ||
      first.caseIndex - second.caseIndex ||
      first.sample.epoch - second.sample.epoch ||
      first.contestantIndex - second.contestantIndex,
  );
}

function providerCapacity(provider: string, perProvider: number): number {
  if (isInstance(provider)) return Math.max(1, getInstance(provider)?.concurrency ?? 1);
  return Math.max(1, perProvider);
}

const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const truncate = (text: string | null | undefined, limit: number) =>
  text && text.length > limit ? `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]` : (text ?? "");

function storablePayload(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  let serialised: string;
  try {
    serialised = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialised = String(value);
  }
  if (serialised.length <= BENCHMARK.MAX_STORED_TOOL_PAYLOAD) return value;
  return `${serialised.slice(0, BENCHMARK.MAX_STORED_TOOL_PAYLOAD)}…[truncated]`;
}

function storableOutput(output: SampleOutput): SampleOutput {
  return {
    text: truncate(output.text, BENCHMARK.MAX_STORED_TEXT),
    thinking: output.thinking ? truncate(output.thinking, BENCHMARK.MAX_STORED_TEXT) : null,
    turns: output.turns,
    toolCalls: output.toolCalls.slice(0, 200).map((call) => ({
      ...call,
      args: storablePayload(call.args),
      result: storablePayload(call.result),
    })),
  };
}

const summarise = (sample: BenchmarkSample): SampleSummary => ({
  id: sample.id,
  suiteId: sample.suiteId,
  caseId: sample.caseId,
  contestantKey: sample.contestantKey,
  epoch: sample.epoch,
  status: sample.status,
  score: sample.score,
  passed: sample.passed,
  cost: sample.cost,
  judgeCost: sample.judgeCost,
  latencyMs: sample.latencyMs,
  error: sample.error,
});

function sampleTimeoutMs(run: BenchmarkRun, job: Job): number {
  const suiteLimit = job.suite.limits?.timeoutSeconds;
  const runLimit = run.settings.timeoutSeconds;
  const byKind =
    job.contestant.kind === "agent" || Array.isArray(job.contestant.tools)
      ? BENCHMARK.DEFAULT_AGENT_TIMEOUT_SECONDS
      : BENCHMARK.DEFAULT_MODEL_TIMEOUT_SECONDS;
  const seconds = [suiteLimit, runLimit].find((value): value is number => typeof value === "number" && value > 0) ?? byKind;
  return seconds * 1000;
}

const workspaceNeeded = (job: Job, scorers = job.datasetCase.scorers ?? job.suite.scorers) =>
  job.suite.workspace ||
  Object.keys(job.datasetCase.files ?? {}).length > 0 ||
  Object.keys(job.datasetCase.hiddenFiles ?? {}).length > 0 ||
  needsWorkspace(scorers);

// ── One sample ──────────────────────────────────────────────

async function runJob(live: LiveRun, job: Job): Promise<void> {
  const { run, controller } = live;
  const { sample, suite, datasetCase, contestant } = job;
  const identity: WorkspaceIdentity = { project: run.project, username: run.username };
  const scorers = datasetCase.scorers ?? suite.scorers;
  // A retried sample keeps what its earlier attempts cost.
  const previousCost = sample.cost ?? 0;
  const previousJudgeCost = sample.judgeCost ?? 0;
  const startedAt = new Date().toISOString();
  sample.status = "running";
  sample.startedAt = startedAt;
  sample.error = null;
  await BenchmarkStore.updateSample(sample.id, { status: "running", startedAt, error: null });

  const finish = async (fields: Partial<BenchmarkSample>) => {
    Object.assign(sample, fields, { completedAt: new Date().toISOString() });
    await BenchmarkStore.updateSample(sample.id, { ...fields, completedAt: sample.completedAt });
    if (sample.status === "done") live.progress.done++;
    else if (sample.status === "error") live.progress.errored++;
    live.progress.cost += (sample.cost ?? 0) - previousCost;
    live.progress.judgeCost += (sample.judgeCost ?? 0) - previousJudgeCost;
    emit(live, { type: "sample", runId: run.id, sample: summarise(sample) });
    emit(live, { type: "progress", runId: run.id, progress: { ...live.progress } });
    scheduleProgressPersist(live);
  };

  const useWorkspace = workspaceNeeded(job, scorers);
  const makeWorkspace = () =>
    createScratchWorkspace({
      baseRoot: null,
      runId: run.id,
      caseId: `${job.suiteIndex}-${datasetCase.id}-c${job.contestantIndex}`,
      trial: sample.epoch,
      files: datasetCase.files ?? undefined,
      identity,
    });
  let workspace: ScratchWorkspace | null = null;
  let execution: Execution | null = null;
  let spent = previousCost;
  let attempts = sample.attempts;
  const maxAttempts = Math.max(1, run.settings.maxAttempts);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts++;
      if (useWorkspace) {
        // A retried agent may have half-changed its workspace: start clean.
        if (workspace) await removeScratchWorkspace(workspace, identity);
        try {
          workspace = await makeWorkspace();
        } catch (error: unknown) {
          await finish({
            status: "error",
            attempts,
            error: { kind: "workspace", message: `Scratch workspace: ${getErrorMessage(error)}`, retryable: false },
          });
          return;
        }
      }
      activeSamples++;
      try {
        execution = await executeSample({
          contestant,
          systemPrompt: datasetCase.systemPrompt ?? suite.systemPrompt,
          messages: caseMessages(datasetCase),
          tools: resolveTools(contestant, suite.tools),
          maxIterations: suite.limits?.maxIterations,
          maxTokens: suite.limits?.maxTokens,
          workspaceRoot: workspace?.root ?? null,
          project: run.project,
          username: run.username,
          signal: controller.signal,
          timeoutMs: sampleTimeoutMs(run, job),
        });
      } finally {
        activeSamples = Math.max(0, activeSamples - 1);
      }
      spent += execution.cost ?? 0;
      if (!execution.error || !execution.error.retryable || controller.signal.aborted || attempt === maxAttempts) break;
      const backoff = Math.min(30_000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
      logger.info(`[benchmark] ${contestant.label} × ${datasetCase.id}: ${execution.error.message} — retrying in ${Math.round(backoff / 1000)} s`);
      await sleep(backoff, controller.signal);
    }
    if (!execution) return;
    const common = {
      attempts,
      output: storableOutput(execution.output),
      toolCallCount: execution.output.toolCalls.length,
      usage: execution.usage,
      cost: spent,
      latencyMs: execution.latencyMs,
      ttftMs: execution.ttftMs,
      tokensPerSecond: execution.tokensPerSecond,
    };
    if (execution.error) {
      const cancelled = execution.error.kind === "cancelled";
      const error: SampleError = cancelled && live.stopReason === "budget"
        ? { kind: "budget", message: "The run's budget was reached", retryable: false }
        : execution.error;
      await finish({ ...common, status: cancelled ? "cancelled" : "error", error, score: null, passed: null, scores: [] });
      return;
    }
    if (workspace && datasetCase.hiddenFiles) {
      try {
        await writeWorkspaceFiles(workspace, datasetCase.hiddenFiles, identity);
      } catch (error: unknown) {
        await finish({
          ...common,
          status: "error",
          error: { kind: "workspace", message: `Hidden files: ${getErrorMessage(error)}`, retryable: false },
        });
        return;
      }
    }
    const grade = await gradeSample(scorers, {
      datasetCase,
      task: caseTask(datasetCase),
      systemPrompt: datasetCase.systemPrompt ?? suite.systemPrompt,
      output: execution.output,
      cost: execution.cost,
      latencyMs: execution.latencyMs,
      workspace,
      identity,
      judges: run.settings.judges,
      signal: controller.signal,
    });
    await finish({
      ...common,
      status: "done",
      error: null,
      scores: grade.scores,
      score: grade.score,
      passed: grade.passed,
      judgeCost: grade.judgeCost,
    });
  } catch (error: unknown) {
    logger.error(`[benchmark] Sample ${sample.id} failed: ${getErrorMessage(error)}`);
    await finish({
      attempts,
      cost: spent,
      status: "error",
      error: { kind: "harness", message: getErrorMessage(error), retryable: false },
    });
  } finally {
    if (workspace) await removeScratchWorkspace(workspace, identity);
  }
}

// ── The run loop ────────────────────────────────────────────

const spentSoFar = (live: LiveRun) => live.progress.cost + live.progress.judgeCost;
const overBudget = (live: LiveRun) =>
  typeof live.run.settings.budgetUsd === "number" && live.run.settings.budgetUsd > 0 && spentSoFar(live) >= live.run.settings.budgetUsd;

async function runSamples(live: LiveRun, jobs: Job[]): Promise<void> {
  const { run, controller } = live;
  const limit = Math.max(1, Math.min(BENCHMARK.MAX_CONCURRENCY, run.settings.concurrency));
  const inFlight = new Set<Promise<void>>();
  const perProvider = new Map<string, number>();
  const queue = [...jobs];
  while (queue.length > 0 && !controller.signal.aborted) {
    if (overBudget(live)) {
      live.stopReason = "budget";
      break;
    }
    const nextIndex =
      inFlight.size < limit
        ? queue.findIndex(
            (job) =>
              (perProvider.get(job.contestant.provider) ?? 0) <
              providerCapacity(job.contestant.provider, run.settings.providerConcurrency),
          )
        : -1;
    if (nextIndex < 0) {
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
      continue;
    }
    const [job] = queue.splice(nextIndex, 1);
    const provider = job.contestant.provider;
    perProvider.set(provider, (perProvider.get(provider) ?? 0) + 1);
    live.progress.running++;
    const task = runJob(live, job)
      .catch((error: unknown) => logger.error(`[benchmark] Job failed: ${getErrorMessage(error)}`))
      .finally(() => {
        perProvider.set(provider, (perProvider.get(provider) ?? 1) - 1);
        live.progress.running = Math.max(0, live.progress.running - 1);
        inFlight.delete(task);
      });
    inFlight.add(task);
  }
  await Promise.all(inFlight);
  // Whatever never started ends cancelled (resume picks it up again).
  const error: SampleError =
    live.stopReason === "budget"
      ? { kind: "budget", message: "The run's budget was reached before this sample started", retryable: false }
      : { kind: "cancelled", message: "The run was stopped before this sample started", retryable: false };
  for (const job of queue) {
    if (job.sample.status !== "pending") continue;
    job.sample.status = "cancelled";
    job.sample.error = error;
    await BenchmarkStore.updateSample(job.sample.id, { status: "cancelled", error });
  }
}

// ── Pairwise judging ────────────────────────────────────────

interface PairJob {
  suite: RunSuite;
  datasetCase: SuiteCase;
  epoch: number;
  a: { contestant: Contestant; sample: BenchmarkSample };
  b: { contestant: Contestant; sample: BenchmarkSample };
}

function planPairs(run: BenchmarkRun, samples: BenchmarkSample[]): PairJob[] {
  const { mode, baselineKey } = run.settings.pairwise;
  if (mode === "off" || run.contestants.length < 2) return [];
  const byCell = new Map<string, Map<string, BenchmarkSample>>();
  for (const sample of samples) {
    if (sample.status !== "done" || !sample.output) continue;
    const cell = `${sample.suiteId}\u0000${sample.caseId}\u0000${sample.epoch}`;
    if (!byCell.has(cell)) byCell.set(cell, new Map());
    byCell.get(cell)!.set(sample.contestantKey, sample);
  }
  const pairs: Array<[Contestant, Contestant]> = [];
  if (mode === "vs_baseline") {
    const baseline = run.contestants.find((contestant) => contestant.key === baselineKey) ?? run.contestants[0];
    for (const contestant of run.contestants) if (contestant.key !== baseline.key) pairs.push([contestant, baseline]);
  } else {
    for (let first = 0; first < run.contestants.length; first++) {
      for (let second = first + 1; second < run.contestants.length; second++) {
        pairs.push([run.contestants[first], run.contestants[second]]);
      }
    }
  }
  const jobs: PairJob[] = [];
  for (const suite of run.suites) {
    for (const datasetCase of suite.cases) {
      for (let epoch = 1; epoch <= run.settings.epochs; epoch++) {
        const cell = byCell.get(`${suite.id}\u0000${datasetCase.id}\u0000${epoch}`);
        if (!cell) continue;
        for (const [first, second] of pairs) {
          const firstSample = cell.get(first.key);
          const secondSample = cell.get(second.key);
          if (!firstSample || !secondSample) continue;
          jobs.push({
            suite,
            datasetCase,
            epoch,
            a: { contestant: first, sample: firstSample },
            b: { contestant: second, sample: secondSample },
          });
        }
      }
    }
  }
  return jobs;
}

async function runPairwise(live: LiveRun): Promise<void> {
  const { run, controller } = live;
  const samples = await BenchmarkStore.listSamples(run.id, { withOutput: true });
  const existing = await BenchmarkStore.listBattles({ runId: run.id, source: "judge" });
  // A battle's sides are randomised, so a pair is the same pair either way round.
  const pairOf = (first: string | null | undefined, second: string | null | undefined) => [first ?? "", second ?? ""].sort().join("|");
  const judgedAlready = new Set(existing.map((battle) => pairOf(battle.a.sampleId, battle.b.sampleId)));
  const jobs = planPairs(run, samples).filter((job) => !judgedAlready.has(pairOf(job.a.sample.id, job.b.sample.id)));
  live.progress.battlesTotal = existing.length + jobs.length;
  live.progress.battlesDone = existing.length;
  if (jobs.length === 0) return;
  const judges = resolveJudges(run.settings.pairwise.judges?.length ? run.settings.pairwise.judges : run.settings.judges);
  if (judges.length === 0) {
    live.stopReason = "no judge model available for pairwise judging";
    return;
  }
  const limit = Math.max(1, Math.min(BENCHMARK.MAX_CONCURRENCY, run.settings.concurrency));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !controller.signal.aborted) {
      if (overBudget(live)) {
        live.stopReason = "budget";
        return;
      }
      const job = jobs[next++];
      // Randomise which answer the battle calls A, so no contestant is always first.
      const [left, right] = Math.random() < 0.5 ? [job.a, job.b] : [job.b, job.a];
      const votes = await judgePairwise(
        {
          task: caseTask(job.datasetCase),
          systemPrompt: job.datasetCase.systemPrompt ?? job.suite.systemPrompt,
          answerA: left.sample.output?.text ?? "",
          answerB: right.sample.output?.text ?? "",
          reference: typeof job.datasetCase.target === "string" ? job.datasetCase.target : null,
        },
        judges,
        { project: run.project, username: run.username, signal: controller.signal },
      );
      const cost = votes.reduce((sum, vote) => sum + (vote.cost ?? 0), 0);
      live.progress.judgeCost += cost;
      const winner = panelWinner(votes);
      live.progress.battlesDone++;
      if (winner) {
        const battle: Battle = {
          id: crypto.randomUUID(),
          project: run.project,
          username: run.username,
          source: "judge",
          runId: run.id,
          suiteId: job.suite.id,
          caseId: job.datasetCase.id,
          epoch: job.epoch,
          prompt: truncate(caseTask(job.datasetCase), 4000),
          a: { contestantKey: left.contestant.key, label: left.contestant.label, sampleId: left.sample.id, output: truncate(left.sample.output?.text, 20_000) },
          b: { contestantKey: right.contestant.key, label: right.contestant.label, sampleId: right.sample.id, output: truncate(right.sample.output?.text, 20_000) },
          winner,
          judge: {
            votes: votes.map((vote) => ({
              provider: vote.provider,
              model: vote.model,
              winner: vote.winner,
              consistent: vote.consistent,
              reasoning: vote.reasoning ?? null,
              cost: vote.cost,
              error: vote.error ?? null,
            })),
            consistent: votes.every((vote) => vote.consistent),
          },
          style: battleStyle(left.sample.output?.text ?? "", right.sample.output?.text ?? ""),
          category: job.datasetCase.tags?.[0] ?? null,
          createdAt: new Date().toISOString(),
        };
        await BenchmarkStore.insertBattle(battle);
        emit(live, {
          type: "battle",
          runId: run.id,
          battle: { id: battle.id, suiteId: battle.suiteId, caseId: battle.caseId, epoch: battle.epoch, winner, a: battle.a.contestantKey, b: battle.b.contestantKey },
        });
      }
      emit(live, { type: "progress", runId: run.id, progress: { ...live.progress } });
      scheduleProgressPersist(live);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

// ── Lifecycle ───────────────────────────────────────────────

/** Compute and store a run's headline numbers (run lists and the leaderboard read them). */
export async function storeResults(run: BenchmarkRun): Promise<void> {
  const [samples, battles] = await Promise.all([
    BenchmarkStore.listSamples(run.id),
    BenchmarkStore.listBattles({ runId: run.id }),
  ]);
  const results = resultsOf(buildReport(run, samples, battles));
  run.results = results;
  await BenchmarkStore.updateRun(run.id, { results });
}

/** Recount progress from the stored samples (a resumed run starts from them). */
async function recountProgress(run: BenchmarkRun): Promise<RunProgress> {
  const samples = await BenchmarkStore.listSamples(run.id);
  const progress = emptyProgress(samples.length);
  for (const sample of samples) {
    if (sample.status === "done") progress.done++;
    else if (sample.status === "error") progress.errored++;
    progress.cost += sample.cost ?? 0;
    progress.judgeCost += sample.judgeCost ?? 0;
  }
  const battles = await BenchmarkStore.listBattles({ runId: run.id, source: "judge" });
  progress.battlesDone = battles.length;
  progress.battlesTotal = battles.length;
  for (const battle of battles) progress.judgeCost += battle.judge?.votes.reduce((sum, vote) => sum + (vote.cost ?? 0), 0) ?? 0;
  return progress;
}

async function execute(live: LiveRun, { retryErrors }: { retryErrors: boolean }): Promise<void> {
  const { run } = live;
  const statuses = retryErrors ? (["pending", "running", "cancelled", "error"] as const) : (["pending", "running", "cancelled"] as const);
  const remaining = await BenchmarkStore.listSamplesByStatus(run.id, [...statuses]);
  // A sample left behind is back to pending; errored ones retried lose their error count.
  for (const sample of remaining) {
    if (sample.status === "error") live.progress.errored = Math.max(0, live.progress.errored - 1);
    sample.status = "pending";
  }
  const jobs = buildJobs(run, remaining);
  logger.info(`[benchmark] Run "${run.name}" (${run.id}): ${jobs.length} sample(s) to go, ${run.contestants.length} contestant(s)`);
  await runSamples(live, jobs);
  if (!live.controller.signal.aborted && !live.stopReason && run.settings.pairwise.mode !== "off") {
    await setStatus(live, "judging");
    await runPairwise(live);
  }
  if (run.suites.some((suite) => suite.workspace || suite.cases.some((datasetCase) => datasetCase.files || datasetCase.hiddenFiles))) {
    await removeScratchRun({ baseRoot: null, runId: run.id, identity: { project: run.project, username: run.username } });
  }
}

function startLive(run: BenchmarkRun, progress: RunProgress): LiveRun {
  const live: LiveRun = {
    run,
    controller: new AbortController(),
    emitter: new EventEmitter(),
    progress,
    stopReason: null,
    persistTimer: null,
  };
  live.emitter.setMaxListeners(100);
  liveRuns.set(run.id, live);
  return live;
}

async function drive(live: LiveRun, options: { retryErrors: boolean }): Promise<void> {
  const { run } = live;
  try {
    await setStatus(live, "running", { startedAt: run.startedAt ?? new Date().toISOString(), statusReason: null });
    await execute(live, options);
    const cancelled = live.controller.signal.aborted;
    const budget = live.stopReason === "budget";
    const status: RunStatus = cancelled || budget ? "cancelled" : "completed";
    const statusReason = budget
      ? `Stopped at the $${run.settings.budgetUsd} budget`
      : cancelled
        ? "Stopped"
        : live.stopReason;
    await setStatus(live, status, { completedAt: new Date().toISOString(), statusReason: statusReason ?? null });
    await storeResults(run);
    if (status === "completed" && run.scheduleId) {
      const { compareWithPreviousScheduledRun } = await import("#src/services/benchmark/BenchmarkRegression");
      await compareWithPreviousScheduledRun(run).catch((error: unknown) =>
        logger.warn(`[benchmark] Regression check of ${run.id} failed: ${getErrorMessage(error)}`),
      );
    }
    logger.info(
      `[benchmark] Run "${run.name}" ${status}: ${live.progress.done}/${live.progress.total} scored, ${live.progress.errored} errored, $${spentSoFar(live).toFixed(4)}`,
    );
  } catch (error: unknown) {
    logger.error(`[benchmark] Run ${run.id} failed: ${getErrorMessage(error)}`);
    await setStatus(live, "failed", { completedAt: new Date().toISOString(), statusReason: getErrorMessage(error) }).catch(() => {});
  } finally {
    liveRuns.delete(run.id);
    live.emitter.removeAllListeners();
  }
}

// ── Regrading ───────────────────────────────────────────────

/**
 * Score the stored answers again with `suites`' scorers — a fixed regex, a
 * new judge, an added checklist — without asking any contestant again.
 * Samples graded by their workspace (file / command scorers) are kept as
 * they were: the workspace is gone. code_tests re-runs from the reply.
 */
async function regradeSamples(live: LiveRun, suites: RunSuite[]): Promise<void> {
  const { run, controller } = live;
  const identity: WorkspaceIdentity = { project: run.project, username: run.username };
  const samples = (await BenchmarkStore.listSamples(run.id, { withOutput: true })).filter(
    (sample) => sample.status === "done" && sample.output,
  );
  const jobs = samples
    .map((sample) => {
      const suite = suites.find((candidate) => candidate.id === sample.suiteId);
      const datasetCase = suite?.cases.find((candidate) => candidate.id === sample.caseId);
      if (!suite || !datasetCase) return null;
      const scorers = datasetCase.scorers ?? suite.scorers;
      if (scorers.some((scorer) => scorer.type === "file" || scorer.type === "command")) return null;
      return { sample, suite, datasetCase, scorers };
    })
    .filter((job): job is NonNullable<typeof job> => job !== null);
  live.progress.regradeTotal = jobs.length;
  live.progress.regradeDone = 0;
  let next = 0;
  const limit = Math.max(1, Math.min(BENCHMARK.MAX_CONCURRENCY, run.settings.concurrency));
  const worker = async () => {
    while (next < jobs.length && !controller.signal.aborted) {
      if (overBudget(live)) {
        live.stopReason = "budget";
        return;
      }
      const { sample, suite, datasetCase, scorers } = jobs[next++];
      let workspace: ScratchWorkspace | null = null;
      try {
        if (needsWorkspace(scorers)) {
          workspace = await createScratchWorkspace({
            baseRoot: null,
            runId: `${run.id}-regrade`,
            caseId: `${sample.suiteId}-${sample.caseId}-${sample.contestantKey}`,
            trial: sample.epoch,
            files: datasetCase.files ?? undefined,
            identity,
          });
        }
        const grade = await gradeSample(scorers, {
          datasetCase,
          task: caseTask(datasetCase),
          systemPrompt: datasetCase.systemPrompt ?? suite.systemPrompt,
          output: sample.output!,
          cost: sample.cost,
          latencyMs: sample.latencyMs ?? 0,
          workspace,
          identity,
          judges: run.settings.judges,
          signal: controller.signal,
        });
        const judgeCost = (sample.judgeCost ?? 0) + grade.judgeCost;
        live.progress.judgeCost += grade.judgeCost;
        await BenchmarkStore.updateSample(sample.id, { scores: grade.scores, score: grade.score, passed: grade.passed, judgeCost });
      } catch (error: unknown) {
        logger.warn(`[benchmark] Regrading ${sample.id} failed: ${getErrorMessage(error)}`);
      } finally {
        if (workspace) await removeScratchWorkspace(workspace, identity);
      }
      live.progress.regradeDone = (live.progress.regradeDone ?? 0) + 1;
      emit(live, { type: "progress", runId: run.id, progress: { ...live.progress } });
      scheduleProgressPersist(live);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, jobs.length)) }, worker));
  run.suites = suites;
  await BenchmarkStore.updateRun(run.id, { suites });
  await removeScratchRun({ baseRoot: null, runId: `${run.id}-regrade`, identity });
}

/** Run a phase (regrade, pairwise judging) on a finished run, then restore its status. */
async function drivePhase(live: LiveRun, phase: () => Promise<void>): Promise<void> {
  const { run } = live;
  const finalStatus: RunStatus = run.status === "judging" || run.status === "running" ? "completed" : run.status;
  try {
    await setStatus(live, "judging", { statusReason: null });
    await phase();
    const statusReason =
      live.stopReason === "budget" ? `Stopped at the $${run.settings.budgetUsd} budget` : live.controller.signal.aborted ? "Stopped" : live.stopReason;
    await setStatus(live, finalStatus, { statusReason: statusReason ?? null });
    await storeResults(run);
  } catch (error: unknown) {
    logger.error(`[benchmark] Phase on ${run.id} failed: ${getErrorMessage(error)}`);
    await setStatus(live, finalStatus, { statusReason: getErrorMessage(error) }).catch(() => {});
  } finally {
    live.progress.regradeTotal = undefined;
    live.progress.regradeDone = undefined;
    await BenchmarkStore.updateRun(run.id, { progress: { ...live.progress } }).catch(() => {});
    liveRuns.delete(run.id);
    live.emitter.removeAllListeners();
  }
}

const RunEngine = {
  /** Re-score a finished run's stored answers with these suites' scorers (background). */
  async regrade(run: BenchmarkRun, suites: RunSuite[]): Promise<void> {
    if (liveRuns.has(run.id)) throw new Error("The run is busy");
    const live = startLive(run, await recountProgress(run));
    void drivePhase(live, () => regradeSamples(live, suites));
  },

  /** Judge a finished run's answers head to head (background). */
  async judgePairwise(run: BenchmarkRun, pairwise: BenchmarkRun["settings"]["pairwise"]): Promise<void> {
    if (liveRuns.has(run.id)) throw new Error("The run is busy");
    run.settings = { ...run.settings, pairwise };
    await BenchmarkStore.updateRun(run.id, { settings: run.settings });
    const live = startLive(run, await recountProgress(run));
    void drivePhase(live, () => runPairwise(live));
  },

  /** Store a new run with its pending samples and start it in the background. */
  async start(run: BenchmarkRun): Promise<BenchmarkRun> {
    const samples = planSamples(run);
    run.progress = emptyProgress(samples.length);
    await BenchmarkStore.insertRun(run);
    await BenchmarkStore.insertSamples(samples);
    const live = startLive(run, run.progress);
    void drive(live, { retryErrors: false });
    return run;
  },

  /**
   * Run what a stopped, interrupted or finished run left: pending and
   * cancelled samples, and errored ones too with `retryErrors`. A new
   * budget replaces the old one.
   */
  async resume(run: BenchmarkRun, { retryErrors = true, budgetUsd }: { retryErrors?: boolean; budgetUsd?: number | null } = {}) {
    if (liveRuns.has(run.id)) throw new Error("The run is already running");
    if (budgetUsd !== undefined) run.settings.budgetUsd = budgetUsd;
    const progress = await recountProgress(run);
    await BenchmarkStore.updateRun(run.id, { settings: run.settings, progress, completedAt: null });
    const live = startLive(run, progress);
    void drive(live, { retryErrors });
    return run;
  },

  /** Stop a live run: in-flight samples are cancelled, nothing new starts. */
  cancel(runId: string): boolean {
    const live = liveRuns.get(runId);
    if (!live) return false;
    live.controller.abort();
    return true;
  },

  /** At boot: runs a restart cut off are `interrupted` (resumable), not running. */
  async markInterrupted(): Promise<number> {
    const runs = await BenchmarkStore.listUnfinishedRuns();
    for (const run of runs) {
      if (liveRuns.has(run.id)) continue;
      await BenchmarkStore.updateRun(run.id, { status: "interrupted", statusReason: "The service restarted while this run was going" });
    }
    return runs.length;
  },

  /** Stop every live run (shutdown). */
  stopAll(): number {
    for (const live of liveRuns.values()) live.controller.abort();
    return liveRuns.size;
  },
};

export default RunEngine;

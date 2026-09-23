/**
 * /benchmark — suites, runs, reports, the arena, the leaderboard and
 * scheduled runs (docs/benchmarks.md).
 *
 * Runs are background jobs: POST /runs answers at once with the stored
 * run, GET /runs/:id/events streams its progress (and can be reopened at
 * any time), and a page that closes does not stop it — POST /runs/:id/cancel
 * does.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import logger from "#src/utils/logger";
import { BENCHMARK } from "#src/constants";
import { resolveScope } from "#src/utils/ProfileScope";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import ScheduledTaskService from "#src/services/ScheduledTaskService";
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import Suites, { type SuiteInput } from "#src/services/benchmark/Suites";
import { importCatalogSuite, listCatalog } from "#src/services/benchmark/SuiteCatalog";
import { estimateRun, prepareRun, startRun, type RunRequest } from "#src/services/benchmark/Runs";
import RunEngine, { RunEvents, emptyProgress, type RunEvent } from "#src/services/benchmark/RunEngine";
import { buildReport, type ErrorPolicy } from "#src/services/benchmark/RunReport";
import { compareRuns } from "#src/services/benchmark/BenchmarkRegression";
import { validateScheduledBenchmark } from "#src/services/benchmark/BenchmarkRegression";
import { buildLeaderboard } from "#src/services/benchmark/Leaderboard";
import { prepareContestants } from "#src/services/benchmark/Contestants";
import { defaultJudge } from "#src/services/benchmark/BenchmarkJudge";
import { describeScorer } from "#src/services/benchmark/Scorers";
import {
  arenaStandings,
  nextBlindPair,
  recordBlindVote,
  recordLiveVote,
  runLiveBattle,
} from "#src/services/benchmark/ArenaService";
import type {
  BenchmarkRun,
  BenchmarkSample,
  ContestantLineup,
  RunListItem,
  ScheduledBenchmarkConfig,
  SampleStatus,
} from "#src/types/benchmark";

const router = express.Router();

const projectOf = (req: Request) => req.project || null;
const usernameOf = (req: Request) => req.username || DEFAULT_USERNAME;
const identityOf = (req: Request) => ({ project: projectOf(req), username: usernameOf(req) });
const param = (req: Request, name: string) => String(req.params[name] ?? "");

const SCHEDULE_TYPES = new Set(["hourly", "daily", "weekly", "cron", "once", "custom"]);
const SAMPLE_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "done", "error", "cancelled"]);

/** Errors that carry a status (validation) answer with it; others go to the error handler. */
function handled(handler: (req: Request, res: Response) => Promise<unknown>) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (typeof status === "number" && status >= 400 && status < 500) {
        res.status(status).json({ error: getErrorMessage(error) });
        return;
      }
      logger.error(`[benchmark] ${req.method} ${req.originalUrl}: ${getErrorMessage(error)}`);
      next(error);
    }
  });
}

async function loadRun(req: Request, res: Response): Promise<BenchmarkRun | null> {
  const run = await BenchmarkStore.getRun(param(req, "runId"), projectOf(req));
  if (!run) res.status(404).json({ error: "Run not found" });
  return run;
}

/** A run for lists: suites without their cases, live progress when it is running here. */
function listItem(run: BenchmarkRun): RunListItem {
  return {
    ...run,
    progress: RunEvents.progressOf(run.id) ?? run.progress,
    suites: run.suites.map((suite) => ({
      id: suite.id,
      name: suite.name,
      version: suite.version,
      totalCases: suite.totalCases,
      caseCount: suite.cases.length,
    })),
  };
}

// ── Options & catalog ───────────────────────────────────────

router.get(
  "/options",
  handled(async (_req, res) => {
    const judge = defaultJudge();
    res.json({
      agents: AgentPersonaRegistry.list(),
      defaultJudge: judge ? `${judge.provider}:${judge.model}` : null,
      limits: {
        maxEpochs: BENCHMARK.MAX_EPOCHS,
        maxRunCases: BENCHMARK.MAX_RUN_CASES,
        maxRunSamples: BENCHMARK.MAX_RUN_SAMPLES,
        maxConcurrency: BENCHMARK.MAX_CONCURRENCY,
        defaultConcurrency: BENCHMARK.DEFAULT_CONCURRENCY,
        defaultProviderConcurrency: BENCHMARK.DEFAULT_PROVIDER_CONCURRENCY,
      },
    });
  }),
);

router.get(
  "/catalog",
  handled(async (_req, res) => {
    res.json({ entries: listCatalog() });
  }),
);

// ── Suites ──────────────────────────────────────────────────

router.get(
  "/suites",
  handled(async (req, res) => {
    const suites = await Suites.list(projectOf(req));
    res.json({ suites, count: suites.length });
  }),
);

router.post(
  "/suites",
  handled(async (req, res) => {
    const suite = await Suites.create((req.body ?? {}) as SuiteInput, identityOf(req));
    res.status(201).json(suite);
  }),
);

router.post(
  "/suites/import",
  handled(async (req, res) => {
    const { catalogId, limit, seed, name } = req.body ?? {};
    const suite = await importCatalogSuite(
      { catalogId: String(catalogId ?? ""), limit: limit == null ? null : Number(limit), seed: seed == null ? null : Number(seed), name },
      identityOf(req),
    );
    await Suites.save(suite);
    res.status(201).json(BenchmarkStore.summariseSuite(suite));
  }),
);

router.get(
  "/suites/:suiteId",
  handled(async (req, res) => {
    const suite = await Suites.get(param(req, "suiteId"), projectOf(req));
    if (!suite) return res.status(404).json({ error: "Suite not found" });
    res.json({ ...suite, scorerLabels: suite.scorers.map(describeScorer) });
  }),
);

router.put(
  "/suites/:suiteId",
  handled(async (req, res) => {
    const suite = await Suites.update(param(req, "suiteId"), (req.body ?? {}) as SuiteInput, projectOf(req));
    if (!suite) return res.status(404).json({ error: "Suite not found" });
    res.json(suite);
  }),
);

router.post(
  "/suites/:suiteId/duplicate",
  handled(async (req, res) => {
    const suite = await Suites.duplicate(param(req, "suiteId"), identityOf(req), req.body?.name);
    if (!suite) return res.status(404).json({ error: "Suite not found" });
    res.status(201).json(suite);
  }),
);

router.delete(
  "/suites/:suiteId",
  handled(async (req, res) => {
    const removed = await Suites.remove(param(req, "suiteId"), projectOf(req));
    if (!removed) return res.status(404).json({ error: "Suite not found" });
    res.json({ success: true });
  }),
);

// ── Lineups ─────────────────────────────────────────────────

router.get(
  "/lineups",
  handled(async (req, res) => {
    const lineups = await BenchmarkStore.listLineups(projectOf(req));
    res.json({ lineups, count: lineups.length });
  }),
);

router.post(
  "/lineups",
  handled(async (req, res) => {
    const { id, name, contestants } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "a lineup needs a name" });
    const prepared = prepareContestants(contestants);
    if ("error" in prepared) return res.status(400).json({ error: prepared.error });
    const now = new Date().toISOString();
    const existing = typeof id === "string" ? (await BenchmarkStore.listLineups(projectOf(req))).find((lineup) => lineup.id === id) : null;
    const lineup: ContestantLineup = {
      id: existing?.id ?? crypto.randomUUID(),
      project: projectOf(req),
      username: usernameOf(req),
      name: name.trim(),
      contestants,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await BenchmarkStore.saveLineup(lineup);
    res.status(existing ? 200 : 201).json(lineup);
  }),
);

router.delete(
  "/lineups/:lineupId",
  handled(async (req, res) => {
    const removed = await BenchmarkStore.deleteLineup(param(req, "lineupId"), projectOf(req));
    if (!removed) return res.status(404).json({ error: "Lineup not found" });
    res.json({ success: true });
  }),
);

// ── Runs ────────────────────────────────────────────────────

router.post(
  "/estimate",
  handled(async (req, res) => {
    const run = await prepareRun((req.body ?? {}) as RunRequest, identityOf(req));
    const estimate = await estimateRun(run);
    res.json({
      ...estimate,
      contestants: run.contestants.map(({ key, label }) => ({ key, label })),
      suites: run.suites.map((suite) => ({ id: suite.id, name: suite.name, cases: suite.cases.length, totalCases: suite.totalCases })),
      settings: run.settings,
    });
  }),
);

router.post(
  "/runs",
  handled(async (req, res) => {
    const run = await startRun((req.body ?? {}) as RunRequest, identityOf(req));
    res.status(201).json(listItem(run));
  }),
);

router.get(
  "/runs",
  handled(async (req, res) => {
    const scheduleId = typeof req.query.scheduleId === "string" ? req.query.scheduleId : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const runs = (await BenchmarkStore.listRuns(projectOf(req), { scheduleId, limit })).map(listItem);
    res.json({ runs, count: runs.length });
  }),
);

router.get(
  "/runs/:runId",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    res.json({ ...run, progress: RunEvents.progressOf(run.id) ?? run.progress, live: RunEvents.isLive(run.id) });
  }),
);

router.get(
  "/runs/:runId/report",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const errorPolicy: ErrorPolicy = req.query.errors === "exclude" ? "exclude" : "fail";
    const [samples, battles] = await Promise.all([
      BenchmarkStore.listSamples(run.id),
      BenchmarkStore.listBattles({ runId: run.id, source: "judge" }),
    ]);
    res.json(buildReport({ ...run, progress: RunEvents.progressOf(run.id) ?? run.progress }, samples, battles, { errorPolicy }));
  }),
);

router.get(
  "/runs/:runId/samples",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const query = req.query;
    const status = typeof query.status === "string" && SAMPLE_STATUSES.has(query.status) ? (query.status as SampleStatus) : undefined;
    const samples = await BenchmarkStore.listSamples(run.id, {
      withOutput: query.full === "1" || query.full === "true",
      filter: {
        ...(typeof query.suiteId === "string" && { suiteId: query.suiteId }),
        ...(typeof query.caseId === "string" && { caseId: query.caseId }),
        ...(typeof query.contestantKey === "string" && { contestantKey: query.contestantKey }),
        ...(status && { status }),
      },
    });
    res.json({ samples, count: samples.length });
  }),
);

router.get(
  "/runs/:runId/samples/:sampleId",
  handled(async (req, res) => {
    const sample = await BenchmarkStore.getSample(param(req, "runId"), param(req, "sampleId"));
    if (!sample || sample.project !== projectOf(req)) return res.status(404).json({ error: "Sample not found" });
    res.json(sample);
  }),
);

/** A person's verdict on a sample: `{override: {passed, note}}`, or `{override: null}` to clear it. */
router.patch(
  "/runs/:runId/samples/:sampleId",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const sample = await BenchmarkStore.getSample(run.id, param(req, "sampleId"));
    if (!sample) return res.status(404).json({ error: "Sample not found" });
    const override = req.body?.override;
    if (override !== null && typeof override?.passed !== "boolean") {
      return res.status(400).json({ error: "override must be {passed: boolean, note?} or null" });
    }
    const value = override === null
      ? null
      : { passed: override.passed, note: typeof override.note === "string" ? override.note.slice(0, 2000) : null, by: usernameOf(req), at: new Date().toISOString() };
    await BenchmarkStore.updateSample(sample.id, { override: value });
    if (!RunEvents.isLive(run.id)) {
      const { storeResults } = await import("#src/services/benchmark/RunEngine");
      await storeResults(run);
    }
    res.json({ ...sample, override: value });
  }),
);

/**
 * The run's progress as Server-Sent Events: a `snapshot` first (status and
 * progress), then `status` / `progress` / `sample` / `battle` while it is
 * live here, and `end` when it stops (or at once, when it is not running).
 */
router.get(
  "/runs/:runId/events",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    req.setTimeout(0);
    req.socket?.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const live = RunEvents.isLive(run.id);
    send({ type: "snapshot", runId: run.id, status: run.status, statusReason: run.statusReason ?? null, progress: RunEvents.progressOf(run.id) ?? run.progress, live });
    if (!live) {
      send({ type: "end", runId: run.id, status: run.status });
      res.end();
      return;
    }
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(":keepalive\n\n");
    }, 15_000);
    let unsubscribe: (() => void) | null = null;
    const close = () => {
      clearInterval(keepalive);
      unsubscribe?.();
      if (!res.writableEnded) res.end();
    };
    unsubscribe = RunEvents.subscribe(run.id, (event: RunEvent) => {
      send(event as unknown as Record<string, unknown>);
      if (event.type === "status" && !["running", "judging", "queued"].includes(event.status)) {
        send({ type: "end", runId: run.id, status: event.status });
        close();
      }
    });
    if (!unsubscribe) {
      send({ type: "end", runId: run.id, status: run.status });
      close();
      return;
    }
    res.on("close", close);
  }),
);

router.post(
  "/runs/:runId/cancel",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const cancelled = RunEngine.cancel(run.id);
    if (!cancelled && ["queued", "running", "judging"].includes(run.status)) {
      // Not live here (a restart): record it as stopped.
      await BenchmarkStore.updateRun(run.id, { status: "cancelled", statusReason: "Stopped" });
    }
    res.json({ success: true, live: cancelled });
  }),
);

router.post(
  "/runs/:runId/resume",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (RunEvents.isLive(run.id)) return res.status(409).json({ error: "The run is already going" });
    const budget = req.body?.budgetUsd;
    await RunEngine.resume(run, {
      retryErrors: req.body?.retryErrors !== false,
      ...(budget !== undefined && { budgetUsd: budget === null ? null : Number(budget) > 0 ? Number(budget) : null }),
    });
    res.json({ success: true });
  }),
);

/** Score the stored answers again with the suites' CURRENT scorers (or the run's own). */
router.post(
  "/runs/:runId/regrade",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (RunEvents.isLive(run.id)) return res.status(409).json({ error: "The run is busy" });
    const useCurrent = req.body?.useCurrentScorers !== false;
    const suites = await Promise.all(
      run.suites.map(async (snapshot) => {
        if (!useCurrent) return snapshot;
        const current = await Suites.get(snapshot.id, run.project);
        if (!current) return snapshot;
        const byId = new Map(current.cases.map((datasetCase) => [datasetCase.id, datasetCase]));
        return {
          ...snapshot,
          version: current.version,
          scorers: current.scorers,
          systemPrompt: current.systemPrompt ?? snapshot.systemPrompt,
          // Same cases as the run evaluated; their scorers and targets from the suite as it is now.
          cases: snapshot.cases.map((datasetCase) => {
            const now = byId.get(datasetCase.id);
            return now ? { ...datasetCase, scorers: now.scorers ?? null, target: now.target ?? null, metadata: now.metadata ?? datasetCase.metadata ?? null } : datasetCase;
          }),
        };
      }),
    );
    await RunEngine.regrade(run, suites);
    res.status(202).json({ success: true });
  }),
);

/** Judge a finished run's answers head to head: `{mode: "all_pairs" | "vs_baseline", baselineKey?, judges?}`. */
router.post(
  "/runs/:runId/pairwise",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    if (RunEvents.isLive(run.id)) return res.status(409).json({ error: "The run is busy" });
    const mode = req.body?.mode;
    if (mode !== "all_pairs" && mode !== "vs_baseline") return res.status(400).json({ error: 'mode must be "all_pairs" or "vs_baseline"' });
    const baselineKey = typeof req.body?.baselineKey === "string" && run.contestants.some((contestant) => contestant.key === req.body.baselineKey)
      ? req.body.baselineKey
      : run.contestants[0]?.key ?? null;
    const judges = Array.isArray(req.body?.judges) ? req.body.judges.filter((judge: unknown) => typeof judge === "string") : null;
    await RunEngine.judgePairwise(run, { mode, baselineKey: mode === "vs_baseline" ? baselineKey : null, judges: judges?.length ? judges : null });
    res.status(202).json({ success: true });
  }),
);

/** Run the same cases, contestants and settings again as a new run. */
router.post(
  "/runs/:runId/rerun",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const copy: BenchmarkRun = {
      ...structuredClone(run),
      id: crypto.randomUUID(),
      name: typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : `${run.name} (again)`,
      username: usernameOf(req),
      status: "queued",
      statusReason: null,
      progress: emptyProgress(0),
      scheduleId: null,
      baselineRunId: run.id,
      regression: null,
      results: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    const started = await RunEngine.start(copy);
    res.status(201).json(listItem(started));
  }),
);

router.delete(
  "/runs/:runId",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    RunEngine.cancel(run.id);
    await BenchmarkStore.deleteRun(run.id, projectOf(req));
    res.json({ success: true });
  }),
);

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get(
  "/runs/:runId/export",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const samples: BenchmarkSample[] = await BenchmarkStore.listSamples(run.id, { withOutput: true });
    const label = new Map(run.contestants.map((contestant) => [contestant.key, contestant.label]));
    const fileName = `benchmark-${run.id.slice(0, 8)}`;
    if (req.query.format === "csv") {
      const header = ["suite", "case", "contestant", "epoch", "status", "passed", "score", "cost_usd", "judge_cost_usd", "latency_ms", "input_tokens", "output_tokens", "error", "answer"];
      const rows = samples.map((sample) =>
        [
          sample.suiteId,
          sample.caseId,
          label.get(sample.contestantKey) ?? sample.contestantKey,
          sample.epoch,
          sample.status,
          sample.override ? sample.override.passed : sample.passed,
          sample.score,
          sample.cost,
          sample.judgeCost,
          sample.latencyMs,
          sample.usage?.inputTokens,
          sample.usage?.outputTokens,
          sample.error?.message,
          sample.output?.text,
        ]
          .map(csvCell)
          .join(","),
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}.csv"`);
      return res.send([header.join(","), ...rows].join("\n"));
    }
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}.json"`);
    res.json({ run, samples });
  }),
);

router.get(
  "/compare",
  handled(async (req, res) => {
    const baseId = typeof req.query.base === "string" ? req.query.base : "";
    const headId = typeof req.query.head === "string" ? req.query.head : "";
    const [base, head] = await Promise.all([BenchmarkStore.getRun(baseId, projectOf(req)), BenchmarkStore.getRun(headId, projectOf(req))]);
    if (!base || !head) return res.status(404).json({ error: "Run not found" });
    const [baseSamples, headSamples] = await Promise.all([BenchmarkStore.listSamples(base.id), BenchmarkStore.listSamples(head.id)]);
    res.json(compareRuns(base, head, baseSamples, headSamples));
  }),
);

// ── Leaderboard & arena ─────────────────────────────────────

router.get(
  "/leaderboard",
  handled(async (req, res) => {
    res.json(await buildLeaderboard(projectOf(req)));
  }),
);

router.get(
  "/arena",
  handled(async (req, res) => {
    const source = req.query.source === "judge" || req.query.source === "all" ? req.query.source : "human";
    res.json(
      await arenaStandings(projectOf(req), {
        source,
        runId: typeof req.query.runId === "string" ? req.query.runId : null,
        suiteId: typeof req.query.suiteId === "string" ? req.query.suiteId : null,
        styleControl: req.query.styleControl === "1" || req.query.styleControl === "true",
      }),
    );
  }),
);

router.get(
  "/arena/battles",
  handled(async (req, res) => {
    const query: Record<string, unknown> = { project: projectOf(req) };
    if (req.query.source === "human" || req.query.source === "judge") query.source = req.query.source;
    if (typeof req.query.runId === "string") query.runId = req.query.runId;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const battles = await BenchmarkStore.listBattles(query, limit);
    res.json({ battles, count: battles.length });
  }),
);

router.delete(
  "/arena/battles/:battleId",
  handled(async (req, res) => {
    const removed = await BenchmarkStore.deleteBattle(param(req, "battleId"), projectOf(req));
    if (!removed) return res.status(404).json({ error: "Battle not found" });
    res.json({ success: true });
  }),
);

/** The next blind pair of a run's answers to vote on (`{pair: null}` when every pair has a vote). */
router.get(
  "/runs/:runId/arena/next",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    res.json({ pair: await nextBlindPair(run) });
  }),
);

router.post(
  "/runs/:runId/arena/votes",
  handled(async (req, res) => {
    const run = await loadRun(req, res);
    if (!run) return;
    const battle = await recordBlindVote(run, req.body ?? {}, usernameOf(req));
    res.status(201).json({ battle, reveal: { a: battle.a.label, b: battle.b.label } });
  }),
);

/** Two contestants answer a prompt side by side, streamed; the vote follows with the token from `ready`. */
router.post(
  "/arena/live",
  handled(async (req, res) => {
    const abort = new AbortController();
    req.setTimeout(0);
    req.socket?.setTimeout(0);
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await runLiveBattle(
        { prompt: req.body?.prompt, systemPrompt: req.body?.systemPrompt ?? null, contestants: req.body?.contestants, ...identityOf(req), signal: abort.signal },
        send as (event: unknown) => void,
      );
    } catch (error: unknown) {
      send({ type: "error", message: getErrorMessage(error) });
    }
    if (!res.writableEnded) res.end();
  }),
);

router.post(
  "/arena/live/:token/vote",
  handled(async (req, res) => {
    const battle = await recordLiveVote(param(req, "token"), req.body?.winner, identityOf(req));
    res.status(201).json({ battle, reveal: { a: battle.a.label, b: battle.b.label } });
  }),
);

// ── Scheduled runs ──────────────────────────────────────────

router.get(
  "/schedules",
  handled(async (req, res) => {
    const { project, username, profileId } = resolveScope(req);
    const tasks = (await ScheduledTaskService.listTasks(project, username, profileId)).filter((task) => task.kind === "benchmark");
    res.json({ schedules: tasks, count: tasks.length });
  }),
);

router.post(
  "/schedules",
  handled(async (req, res) => {
    const { name, suiteIds, contestants, settings, threshold, alert, scheduleType, scheduleTime, scheduleDay, scheduleDate, cronExpression, recurrenceRule } =
      req.body ?? {};
    const benchmark: ScheduledBenchmarkConfig = {
      name: typeof name === "string" && name.trim() ? name.trim() : "Scheduled benchmark",
      suiteIds,
      contestants,
      settings: settings ?? {},
      ...(threshold != null && { threshold: Number(threshold) }),
      ...(alert != null && { alert }),
    };
    const invalid = validateScheduledBenchmark(benchmark);
    if (invalid) return res.status(400).json({ error: invalid });
    // Everything the run would refuse, refused now rather than at 3 a.m.
    await prepareRun({ suiteIds, contestants, settings }, identityOf(req));
    if (!SCHEDULE_TYPES.has(scheduleType)) {
      return res.status(400).json({ error: `scheduleType must be one of ${[...SCHEDULE_TYPES].join(", ")}` });
    }
    if (scheduleType === "cron" && typeof cronExpression !== "string") {
      return res.status(400).json({ error: "A cron schedule needs a cronExpression" });
    }
    if (scheduleType !== "cron" && scheduleType !== "hourly" && typeof scheduleTime !== "string") {
      return res.status(400).json({ error: `A ${scheduleType} schedule needs a scheduleTime (HH:MM)` });
    }
    const { profileId } = resolveScope(req);
    const [first] = contestants as Array<{ provider: string; model: string }>;
    const task = await ScheduledTaskService.createTask({
      name: benchmark.name,
      prompt: `Benchmark: ${benchmark.name}`,
      agent: null,
      provider: first.provider,
      model: first.model,
      scheduleType,
      scheduleTime,
      scheduleDay,
      scheduleDate,
      cronExpression,
      recurrenceRule,
      kind: "benchmark",
      benchmark,
      enabled: true,
      project: projectOf(req) as string,
      username: usernameOf(req),
      profileId,
    });
    res.status(201).json(task);
  }),
);

router.delete(
  "/schedules/:scheduleId",
  handled(async (req, res) => {
    const { project, username } = resolveScope(req);
    await ScheduledTaskService.deleteTask(param(req, "scheduleId"), project, username);
    res.json({ success: true });
  }),
);

export default router;

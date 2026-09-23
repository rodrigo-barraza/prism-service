/**
 * Runs — turning a request ("these suites, these contestants, these
 * settings") into a run: settings normalised, suites resolved and sampled
 * with a seed, snapshots taken, sizes checked — and what it will cost
 * before anyone pays for it.
 *
 * The estimate prices each contestant from its own history when it has
 * run before (mean cost of its recent samples), otherwise from the model's
 * catalog prices and the cases' length, with a wide low–high band (an
 * agent's persona prompt, its iterations and a reasoning model's thinking
 * are the unknowns). It also says what the run can detect: the smallest
 * paired difference its case count separates (Statistics).
 */
import crypto from "crypto";
import { getModelByName } from "#src/config";
import { BENCHMARK } from "#src/constants";
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import Suites from "#src/services/benchmark/Suites";
import RunEngine from "#src/services/benchmark/RunEngine";
import { prepareContestants } from "#src/services/benchmark/Contestants";
import { defaultJudge, parseJudge, type JudgeTarget } from "#src/services/benchmark/BenchmarkJudge";
import { mean, minimumDetectableDifference, shuffled } from "#src/services/benchmark/Statistics";
import {
  MODEL_GRADED_SCORERS,
  type BenchmarkRun,
  type Contestant,
  type ContestantSpec,
  type CostEstimate,
  type PairwiseMode,
  type RunSettings,
  type RunSuite,
} from "#src/types/benchmark";

export class RunRequestError extends Error {
  status = 400;
}

/** A pairwise setting as a request sends it: the baseline by key or by contestant index. */
export type PairwiseRequest = Partial<RunSettings["pairwise"]> & { baselineIndex?: number | null };

export interface RunRequest {
  name?: string | null;
  notes?: string | null;
  suiteIds: string[];
  contestants: ContestantSpec[];
  settings?: Partial<Omit<RunSettings, "pairwise">> & { pairwise?: PairwiseRequest };
  scheduleId?: string | null;
  baselineRunId?: string | null;
}

/** The catalog fields an estimate reads (the model union types them unevenly). */
const catalogEntry = (model: string) =>
  getModelByName(model) as { pricing?: Record<string, number>; thinking?: boolean } | null;

const clampInteger = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Math.floor(Number(value));
  if (value == null || value === "" || !Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/** Settings with every default filled in and every value in range. */
export function normaliseSettings(raw: RunRequest["settings"] = {}, contestants: Contestant[]): RunSettings {
  const judges = Array.isArray(raw.judges) ? [...new Set(raw.judges.filter((judge) => typeof judge === "string" && judge.trim()))] : [];
  for (const judge of judges) {
    if (!parseJudge(judge)) throw new RunRequestError(`judge "${judge}" is not available (use "provider:model" of a configured provider)`);
  }
  const pairwiseRaw: PairwiseRequest = raw.pairwise ?? {};
  const mode: PairwiseMode = pairwiseRaw.mode === "all_pairs" || pairwiseRaw.mode === "vs_baseline" ? pairwiseRaw.mode : "off";
  let baselineKey: string | null = null;
  if (mode === "vs_baseline") {
    const index = pairwiseRaw.baselineIndex;
    baselineKey =
      (typeof pairwiseRaw.baselineKey === "string" && contestants.some((contestant) => contestant.key === pairwiseRaw.baselineKey)
        ? pairwiseRaw.baselineKey
        : null) ??
      (typeof index === "number" && contestants[index] ? contestants[index].key : contestants[0]?.key ?? null);
  }
  const pairwiseJudges = Array.isArray(pairwiseRaw.judges) ? pairwiseRaw.judges.filter((judge) => typeof judge === "string" && judge.trim()) : [];
  for (const judge of pairwiseJudges) {
    if (!parseJudge(judge)) throw new RunRequestError(`judge "${judge}" is not available`);
  }
  const budget = Number(raw.budgetUsd);
  const timeout = Number(raw.timeoutSeconds);
  return {
    epochs: clampInteger(raw.epochs, 1, BENCHMARK.MAX_EPOCHS, 1),
    sampleLimit: raw.sampleLimit == null || raw.sampleLimit === 0 ? null : clampInteger(raw.sampleLimit, 1, BENCHMARK.MAX_SUITE_CASES, BENCHMARK.MAX_SUITE_CASES),
    sampleSeed: clampInteger(raw.sampleSeed, 0, 2 ** 31 - 1, 1),
    judges,
    concurrency: clampInteger(raw.concurrency, 1, BENCHMARK.MAX_CONCURRENCY, BENCHMARK.DEFAULT_CONCURRENCY),
    providerConcurrency: clampInteger(raw.providerConcurrency, 1, BENCHMARK.MAX_CONCURRENCY, BENCHMARK.DEFAULT_PROVIDER_CONCURRENCY),
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
    maxAttempts: clampInteger(raw.maxAttempts, 1, 5, BENCHMARK.DEFAULT_MAX_ATTEMPTS),
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.min(3600, Math.max(10, Math.floor(timeout))) : 0,
    pairwise: { mode, baselineKey, judges: pairwiseJudges.length > 0 ? pairwiseJudges : null },
  };
}

/** Resolve the suites, sample their cases with the seed, and snapshot them. */
async function snapshotSuites(suiteIds: unknown, settings: RunSettings, project: string | null): Promise<RunSuite[]> {
  if (!Array.isArray(suiteIds) || suiteIds.length === 0) throw new RunRequestError("pick at least one suite");
  const unique = [...new Set(suiteIds.filter((id): id is string => typeof id === "string"))];
  const suites: RunSuite[] = [];
  for (const id of unique) {
    const suite = await Suites.get(id, project);
    if (!suite) throw new RunRequestError(`suite ${id} not found`);
    let cases = suite.cases;
    if (settings.sampleLimit && cases.length > settings.sampleLimit) {
      const chosen = new Set(shuffled(cases.map((datasetCase) => datasetCase.id), settings.sampleSeed ?? 1).slice(0, settings.sampleLimit));
      cases = cases.filter((datasetCase) => chosen.has(datasetCase.id));
    }
    suites.push({
      id: suite.id,
      name: suite.name,
      version: suite.version,
      source: suite.source,
      scorers: suite.scorers,
      systemPrompt: suite.systemPrompt ?? null,
      tools: suite.tools,
      workspace: suite.workspace,
      limits: suite.limits ?? null,
      cases,
      totalCases: suite.cases.length,
    });
  }
  return suites;
}

/** A validated run, not stored and not started. */
export async function prepareRun(request: RunRequest, identity: { project: string | null; username: string }): Promise<BenchmarkRun> {
  const prepared = prepareContestants(request.contestants);
  if ("error" in prepared) throw new RunRequestError(prepared.error);
  const settings = normaliseSettings(request.settings, prepared.contestants);
  const suites = await snapshotSuites(request.suiteIds, settings, identity.project);
  const cases = suites.reduce((sum, suite) => sum + suite.cases.length, 0);
  if (cases > BENCHMARK.MAX_RUN_CASES) {
    throw new RunRequestError(`${cases} cases is more than ${BENCHMARK.MAX_RUN_CASES} per run — set a sample limit`);
  }
  const samples = cases * prepared.contestants.length * settings.epochs;
  if (samples > BENCHMARK.MAX_RUN_SAMPLES) {
    throw new RunRequestError(`${samples} samples is more than ${BENCHMARK.MAX_RUN_SAMPLES} per run — fewer cases, contestants or epochs`);
  }
  const suiteNames = suites.map((suite) => suite.name).join(" + ");
  return {
    id: crypto.randomUUID(),
    project: identity.project,
    username: identity.username,
    name: request.name?.trim() || `${suiteNames} · ${prepared.contestants.length} contestant${prepared.contestants.length === 1 ? "" : "s"}`,
    notes: request.notes?.trim() || null,
    status: "queued",
    statusReason: null,
    suites,
    contestants: prepared.contestants,
    settings,
    progress: { total: samples, done: 0, errored: 0, running: 0, cost: 0, judgeCost: 0, battlesTotal: 0, battlesDone: 0 },
    scheduleId: request.scheduleId ?? null,
    baselineRunId: request.baselineRunId ?? null,
    regression: null,
    results: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
}

/** Validate, store and start a run in the background. */
export async function startRun(request: RunRequest, identity: { project: string | null; username: string }): Promise<BenchmarkRun> {
  return RunEngine.start(await prepareRun(request, identity));
}

// ── Estimates ───────────────────────────────────────────────

const tokensOf = (text: string) => Math.ceil(text.length / 4);
/** An assembled agent system prompt (persona, tools, memory) is ~40K tokens (measured 2026-09-22). */
const AGENT_PROMPT_TOKENS = 40_000;

interface Prices {
  input: number;
  cachedInput: number;
  output: number;
}

function pricesOf(model: string): Prices | null {
  const pricing = catalogEntry(model)?.pricing;
  if (!pricing || typeof pricing.inputPerMillion !== "number") return null;
  return {
    input: pricing.inputPerMillion / 1e6,
    cachedInput: (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) / 1e6,
    output: (pricing.outputPerMillion ?? pricing.inputPerMillion) / 1e6,
  };
}

function judgePrices(settings: RunSettings): { targets: JudgeTarget[]; prices: Prices | null } {
  const targets = settings.judges.map(parseJudge).filter((target): target is JudgeTarget => !!target);
  const effective = targets.length > 0 ? targets : [defaultJudge()].filter((target): target is JudgeTarget => !!target);
  const known = effective.map((target) => pricesOf(target.model)).filter((prices): prices is Prices => !!prices);
  if (known.length === 0) return { targets: effective, prices: null };
  return {
    targets: effective,
    prices: {
      input: mean(known.map((price) => price.input)),
      cachedInput: mean(known.map((price) => price.cachedInput)),
      output: mean(known.map((price) => price.output)),
    },
  };
}

/** What a run would cost and take, and what it could detect. */
export async function estimateRun(run: BenchmarkRun): Promise<CostEstimate> {
  const { settings, contestants, suites } = run;
  const cases = suites.flatMap((suite) => suite.cases.map((datasetCase) => ({ suite, datasetCase })));
  const casesPerContestant = cases.length * settings.epochs;
  const warnings: string[] = [];
  const perContestant: CostEstimate["perContestant"] = {};
  const meanInputTokens = mean(
    cases.map(({ suite, datasetCase }) => tokensOf(`${datasetCase.systemPrompt ?? suite.systemPrompt ?? ""}${JSON.stringify(datasetCase.input)}`)),
  );
  const agentic = (contestant: Contestant) =>
    contestant.kind === "agent" || Array.isArray(contestant.tools) || suites.some((suite) => suite.tools.mode === "list");
  const latencies: number[] = [];
  for (const contestant of contestants) {
    const history = await BenchmarkStore.recentSamplesOf(contestant.key).catch(() => []);
    if (history.length >= 5) {
      const meanCost = mean(history.map((sample) => sample.cost ?? 0));
      latencies.push(mean(history.map((sample) => sample.latencyMs ?? 0)));
      perContestant[contestant.key] = {
        label: contestant.label,
        low: meanCost * casesPerContestant * 0.6,
        high: meanCost * casesPerContestant * 1.6,
        basis: "history",
      };
      continue;
    }
    const prices = pricesOf(contestant.model);
    const thinking = contestant.effort ? contestant.effort !== "none" : !!catalogEntry(contestant.model)?.thinking;
    const iterations = agentic(contestant) ? Math.min(8, contestant.harness?.maxIterations ?? 4) : 1;
    latencies.push(agentic(contestant) ? 45_000 : thinking ? 25_000 : 8_000);
    if (!prices) {
      perContestant[contestant.key] = { label: contestant.label, low: 0, high: 0, basis: "unknown" };
      continue;
    }
    const promptTokens = meanInputTokens + (contestant.kind === "agent" ? AGENT_PROMPT_TOKENS : agentic(contestant) ? 3_000 : 50);
    // Low: one pass, prompt mostly cached after the first sample. High: every iteration uncached-ish.
    const low =
      promptTokens * prices.cachedInput + (promptTokens * 0.1) * prices.input + (thinking ? 800 : 200) * prices.output;
    const high = promptTokens * iterations * prices.input + (thinking ? 8_000 : 1_500) * iterations * prices.output;
    perContestant[contestant.key] = {
      label: contestant.label,
      low: low * casesPerContestant,
      high: high * casesPerContestant,
      basis: "pricing",
    };
  }
  // Judges: every model-graded scorer of every sample, and every pairwise battle (two orders).
  const { targets: judges, prices: judgeCost } = judgePrices(settings);
  let judgeCalls = 0;
  for (const { suite, datasetCase } of cases) {
    for (const scorer of datasetCase.scorers ?? suite.scorers) {
      const judged = MODEL_GRADED_SCORERS.has(scorer.type) || (scorer.type === "math" && scorer.judgeFallback);
      if (!judged) continue;
      // A math fallback is judged only when the normaliser fails — about a third of the time.
      const share = scorer.type === "math" ? 0.3 : 1;
      judgeCalls += share * Math.max(1, scorer.judges?.length || judges.length);
    }
  }
  judgeCalls *= contestants.length * settings.epochs;
  const pairCount =
    settings.pairwise.mode === "all_pairs"
      ? (contestants.length * (contestants.length - 1)) / 2
      : settings.pairwise.mode === "vs_baseline"
        ? Math.max(0, contestants.length - 1)
        : 0;
  const battles = pairCount * cases.length * settings.epochs;
  const pairwiseJudges = settings.pairwise.judges?.length ?? judges.length;
  const battleCalls = battles * 2 * Math.max(1, pairwiseJudges);
  const perJudgeCall = judgeCost ? 1_800 * judgeCost.input + 150 * judgeCost.output : 0;
  const perBattleCall = judgeCost ? 3_000 * judgeCost.input + 150 * judgeCost.output : 0;
  const judge = {
    low: judgeCalls * perJudgeCall * 0.5 + battleCalls * perBattleCall * 0.6,
    high: judgeCalls * perJudgeCall * 1.5 + battleCalls * perBattleCall * 1.6,
  };
  const contestantLow = Object.values(perContestant).reduce((sum, entry) => sum + entry.low, 0);
  const contestantHigh = Object.values(perContestant).reduce((sum, entry) => sum + entry.high, 0);
  const samples = casesPerContestant * contestants.length;
  const parallel = Math.max(1, Math.min(settings.concurrency, samples));
  const meanLatency = mean(latencies);

  if (contestants.some((contestant) => contestant.kind === "agent")) {
    warnings.push("Agent samples carry the persona's assembled system prompt (~40K tokens) on every iteration — expect agents to cost far more than bare models.");
  }
  const judgeModels = new Set(judges.map((target) => target.model));
  const selfJudged = contestants.filter((contestant) => judgeModels.has(contestant.model));
  if (selfJudged.length > 0 && (judgeCalls > 0 || battles > 0)) {
    warnings.push(`${selfJudged.map((contestant) => contestant.label).join(", ")} ${selfJudged.length === 1 ? "is" : "are"} also a judge — judges favour their own answers; add a judge from another provider.`);
  }
  if (judgeCalls > 0 && !judgeCost && judges.length === 0) warnings.push("No judge model is available for the model-graded scorers.");
  const detectable = minimumDetectableDifference(cases.length, { epochs: settings.epochs });
  if (detectable !== null && contestants.length > 1 && detectable > 0.1) {
    warnings.push(
      `${cases.length} cases can only tell apart contestants about ${Math.round(detectable * 100)} points apart — add cases (or epochs) to resolve smaller gaps.`,
    );
  }
  if (suites.some((suite) => suite.tools.mode === "list") && contestants.some((contestant) => contestant.kind === "model")) {
    warnings.push("Model contestants run the tool suites with function calling on the suite's tools.");
  }
  if (suites.some((suite) => suite.workspace)) {
    warnings.push("Workspace suites create scratch directories under tools-service's first workspace root (removed afterwards).");
  }
  if (contestants.some((contestant) => perContestant[contestant.key]?.basis === "unknown")) {
    warnings.push("No price is known for some models (local or unlisted) — counted as free.");
  }
  const total = { low: contestantLow + judge.low, high: contestantHigh + judge.high };
  if (settings.budgetUsd && total.low > settings.budgetUsd) {
    warnings.push(`Even the low estimate ($${total.low.toFixed(2)}) exceeds the $${settings.budgetUsd} budget — the run will stop early.`);
  }
  return {
    samples,
    battles,
    cases: cases.length,
    perContestant,
    judge,
    total,
    detectableDifference: detectable,
    minutes: samples > 0 ? { low: (samples * meanLatency * 0.5) / parallel / 60_000, high: (samples * meanLatency * 2) / parallel / 60_000 } : null,
    warnings,
  };
}

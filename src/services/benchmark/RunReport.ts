/**
 * RunReport — a run's samples turned into the numbers that answer "which is
 * better, by how much, and are we sure?".
 *
 * Per suite, per contestant: the mean score with a 95 % interval clustered
 * by case (Statistics.estimateMean), pass rate, pass@k / pass^k when there
 * are several epochs, cost, latency, tokens and errors. Every pair of
 * contestants is compared on the cases both answered (paired test,
 * Holm-adjusted), which also gives each contestant the range of ranks the
 * data allow. Across suites the overall score is the macro average (every
 * suite weighs the same, whatever its size). The Pareto sets name the
 * contestants no other beats on both score and cost (or latency).
 *
 * An errored sample is a failed one by default ("fail": a contestant that
 * cannot answer did not answer); "exclude" leaves errors out, for telling
 * a flaky provider from a weak model.
 */
import {
  cohensKappa,
  estimateMean,
  holmAdjust,
  mean,
  pairedComparison,
  passAtK,
  passHatK,
  percentile,
  rankRanges,
  studentTCdf,
} from "#src/services/benchmark/Statistics";
import { buildArenaReport } from "#src/services/benchmark/Arena";
import { caseTask } from "#src/services/benchmark/Cases";
import {
  CONTESTANT_FAULTS,
  NOT_RUN,
  type Battle,
  type BenchmarkRun,
  type BenchmarkSample,
  type CaseRow,
  type Contestant,
  type ContestantSummary,
  type JudgeAgreement,
  type PairwiseComparison,
  type ResultCell,
  type RunReport,
  type RunResults,
  type RunSuite,
  type SampleErrorKind,
  type SuiteHealth,
  type SuiteReport,
  type TagBreakdown,
} from "#src/types/benchmark";

export type ErrorPolicy = "fail" | "exclude";

const SIGNIFICANCE = 0.05;
const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Whether an errored sample counts (as a 0): the contestant's own faults
 * always do, infrastructure faults only under "fail", a run that never
 * reached the sample never.
 */
function errorCounts(sample: BenchmarkSample, policy: ErrorPolicy): boolean {
  const kind = sample.error?.kind;
  if (!kind || NOT_RUN.has(kind)) return false;
  return CONTESTANT_FAULTS.has(kind) || policy === "fail";
}

/** The score a sample counts as (a person's override first), or null when it does not count. */
function countedScore(sample: BenchmarkSample, policy: ErrorPolicy): number | null {
  if (sample.override) return sample.override.passed ? 1 : 0;
  if (sample.status === "done" && typeof sample.score === "number") return sample.score;
  if (sample.status === "error" && errorCounts(sample, policy)) return 0;
  return null;
}

const countedPass = (sample: BenchmarkSample, policy: ErrorPolicy): boolean | null => {
  if (sample.override) return sample.override.passed;
  if (sample.status === "done" && typeof sample.passed === "boolean") return sample.passed;
  if (sample.status === "error" && errorCounts(sample, policy)) return false;
  return null;
};

interface CaseStats {
  scores: number[];
  passes: number;
  counted: number;
}

/** caseId → contestantKey → the case's epochs. */
function collectCases(suite: RunSuite, samples: BenchmarkSample[], policy: ErrorPolicy) {
  const byCase = new Map<string, Map<string, CaseStats>>();
  for (const datasetCase of suite.cases) byCase.set(datasetCase.id, new Map());
  for (const sample of samples) {
    if (sample.suiteId !== suite.id) continue;
    const cell = byCase.get(sample.caseId);
    if (!cell) continue;
    const score = countedScore(sample, policy);
    if (score === null) continue;
    const stats = cell.get(sample.contestantKey) ?? { scores: [], passes: 0, counted: 0 };
    stats.scores.push(score);
    stats.counted++;
    if (countedPass(sample, policy)) stats.passes++;
    cell.set(sample.contestantKey, stats);
  }
  return byCase;
}

/** caseId → a contestant's mean score and passes on that case (run comparisons, regressions). */
export function caseScoresOf(
  suite: RunSuite,
  samples: BenchmarkSample[],
  contestantKey: string,
  policy: ErrorPolicy = "fail",
): Map<string, { mean: number; passes: number; counted: number }> {
  const scores = new Map<string, { mean: number; passes: number; counted: number }>();
  for (const [caseId, cell] of collectCases(suite, samples, policy)) {
    const stats = cell.get(contestantKey);
    if (stats && stats.counted > 0) scores.set(caseId, { mean: mean(stats.scores), passes: stats.passes, counted: stats.counted });
  }
  return scores;
}

function summarise(
  contestant: Contestant,
  byCase: Map<string, Map<string, CaseStats>>,
  samples: BenchmarkSample[],
  epochs: number,
): Omit<ContestantSummary, "rank" | "rankRange"> {
  const caseMeans: number[] = [];
  const perCase: CaseStats[] = [];
  let consistent = 0;
  let flaky = 0;
  let passes = 0;
  let counted = 0;
  for (const cell of byCase.values()) {
    const stats = cell.get(contestant.key);
    if (!stats || stats.counted === 0) continue;
    caseMeans.push(mean(stats.scores));
    perCase.push(stats);
    passes += stats.passes;
    counted += stats.counted;
    if (stats.passes === 0 || stats.passes === stats.counted) consistent++;
    else flaky++;
  }
  // pass@k / pass^k need k samples of a case; cases with fewer epochs (a stopped run) are left out.
  const passCurve = Array.from({ length: Math.max(1, epochs) }, (_, index) => {
    const k = index + 1;
    const eligible = perCase.filter((stats) => stats.counted >= k);
    return {
      k,
      passAt: round(eligible.length > 0 ? mean(eligible.map((stats) => passAtK(stats.counted, stats.passes, k))) : 0),
      passHat: round(eligible.length > 0 ? mean(eligible.map((stats) => passHatK(stats.counted, stats.passes, k))) : 0),
    };
  });
  const atEpochs = passCurve[passCurve.length - 1];
  const own = samples.filter((sample) => sample.contestantKey === contestant.key);
  const ran = own.filter((sample) => sample.status === "done" || sample.status === "error");
  const done = own.filter((sample) => sample.status === "done");
  const errors: Partial<Record<SampleErrorKind, number>> = {};
  for (const sample of own) {
    if (sample.status === "error" && sample.error) errors[sample.error.kind] = (errors[sample.error.kind] ?? 0) + 1;
  }
  const cost = own.reduce((sum, sample) => sum + (sample.cost ?? 0), 0);
  const judge = own.reduce((sum, sample) => sum + (sample.judgeCost ?? 0), 0);
  const latencies = done.map((sample) => sample.latencyMs).filter((value): value is number => typeof value === "number");
  const ttfts = done.map((sample) => sample.ttftMs).filter((value): value is number => typeof value === "number");
  const rates = done.map((sample) => sample.tokensPerSecond).filter((value): value is number => typeof value === "number" && value > 0);
  const estimate = estimateMean(caseMeans);
  const passedSamples = passes;
  return {
    key: contestant.key,
    label: contestant.label,
    cases: caseMeans.length,
    samples: ran.length,
    errored: own.filter((sample) => sample.status === "error").length,
    mean: round(estimate.mean),
    se: round(estimate.se),
    ci: { low: round(estimate.low), high: round(estimate.high) },
    passRate: round(counted > 0 ? passes / counted : 0),
    passAtK: epochs > 1 && perCase.length > 0 ? atEpochs.passAt : null,
    passHatK: epochs > 1 && perCase.length > 0 ? atEpochs.passHat : null,
    passCurve: perCase.length > 0 ? passCurve : [],
    consistency: epochs > 1 && caseMeans.length > 0 ? round(consistent / caseMeans.length) : null,
    flakyCases: flaky,
    cost: {
      total: round(cost, 8),
      perSample: round(ran.length > 0 ? cost / ran.length : 0, 8),
      judge: round(judge, 8),
      perPass: passedSamples > 0 ? round(cost / passedSamples, 8) : null,
    },
    latency: {
      meanMs: Math.round(mean(latencies)),
      p50Ms: Math.round(percentile(latencies, 0.5)),
      p95Ms: Math.round(percentile(latencies, 0.95)),
    },
    ttftMs: ttfts.length > 0 ? Math.round(mean(ttfts)) : null,
    tokensPerSecond: rates.length > 0 ? round(mean(rates), 1) : null,
    tokens: {
      input: done.reduce((sum, sample) => sum + (sample.usage?.inputTokens ?? 0), 0),
      output: done.reduce((sum, sample) => sum + (sample.usage?.outputTokens ?? 0), 0),
      reasoning: done.reduce((sum, sample) => sum + (sample.usage?.reasoningTokens ?? 0), 0),
      cacheRead: done.reduce((sum, sample) => sum + (sample.usage?.cacheReadTokens ?? 0), 0),
    },
    meanTurns: round(mean(done.map((sample) => sample.output?.turns ?? 0)), 2),
    meanToolCalls: round(mean(done.map((sample) => sample.toolCallCount ?? sample.output?.toolCalls?.length ?? 0)), 2),
    errors,
  };
}

function comparePairs(contestants: Contestant[], byCase: Map<string, Map<string, CaseStats>>): PairwiseComparison[] {
  const comparisons: Array<Omit<PairwiseComparison, "pAdjusted" | "significant">> = [];
  for (let first = 0; first < contestants.length; first++) {
    for (let second = first + 1; second < contestants.length; second++) {
      const a = contestants[first].key;
      const b = contestants[second].key;
      const aScores: number[] = [];
      const bScores: number[] = [];
      for (const cell of byCase.values()) {
        const aStats = cell.get(a);
        const bStats = cell.get(b);
        if (!aStats?.counted || !bStats?.counted) continue;
        aScores.push(mean(aStats.scores));
        bScores.push(mean(bStats.scores));
      }
      const result = pairedComparison(aScores, bScores);
      comparisons.push({
        a,
        b,
        n: result.n,
        diff: round(result.diff),
        se: round(result.se),
        ci: { low: round(result.low), high: round(result.high) },
        pValue: round(result.pValue, 8),
        test: result.test,
        wins: result.wins,
        ties: result.ties,
        losses: result.losses,
        mde: round(result.mde),
        correlation: result.correlation === null ? null : round(result.correlation, 4),
      });
    }
  }
  const adjusted = holmAdjust(comparisons.map((comparison) => comparison.pValue));
  return comparisons.map((comparison, index) => ({
    ...comparison,
    pAdjusted: round(adjusted[index], 8),
    significant: comparison.test !== "none" && adjusted[index] < SIGNIFICANCE,
  }));
}

/** Rank by mean; the range from which pairs differ significantly. */
function rank<Summary extends { key: string; mean: number }>(
  summaries: Summary[],
  better: (winner: string, loser: string) => boolean,
): Array<Summary & { rank: number; rankRange: [number, number] }> {
  const ordered = [...summaries].sort((first, second) => second.mean - first.mean);
  const ranges = rankRanges(ordered.map((summary) => summary.key), better);
  return ordered.map((summary, index) => ({ ...summary, rank: index + 1, rankRange: ranges[summary.key] }));
}

function significance(pairs: PairwiseComparison[]) {
  return (winner: string, loser: string) =>
    pairs.some(
      (pair) =>
        pair.significant &&
        ((pair.a === winner && pair.b === loser && pair.diff > 0) || (pair.a === loser && pair.b === winner && pair.diff < 0)),
    );
}

function tagBreakdown(suite: RunSuite, contestants: Contestant[], byCase: Map<string, Map<string, CaseStats>>): TagBreakdown[] {
  const tags = new Map<string, string[]>();
  for (const datasetCase of suite.cases) {
    for (const tag of datasetCase.tags ?? []) {
      if (!tags.has(tag)) tags.set(tag, []);
      tags.get(tag)!.push(datasetCase.id);
    }
  }
  if (tags.size < 2) return [];
  return [...tags.entries()]
    .map(([tag, caseIds]) => {
      const means: Record<string, number> = {};
      for (const contestant of contestants) {
        const values = caseIds
          .map((caseId) => byCase.get(caseId)?.get(contestant.key))
          .filter((stats): stats is CaseStats => !!stats && stats.counted > 0)
          .map((stats) => mean(stats.scores));
        if (values.length > 0) means[contestant.key] = round(mean(values));
      }
      return { tag, cases: caseIds.length, means };
    })
    .sort((first, second) => second.cases - first.cases);
}

function caseRows(suite: RunSuite, contestants: Contestant[], byCase: Map<string, Map<string, CaseStats>>): CaseRow[] {
  return suite.cases.map((datasetCase) => {
    const cell = byCase.get(datasetCase.id) ?? new Map<string, CaseStats>();
    const scores: Record<string, number | null> = {};
    const passes: Record<string, [number, number]> = {};
    const values: number[] = [];
    for (const contestant of contestants) {
      const stats = cell.get(contestant.key);
      if (!stats || stats.counted === 0) {
        scores[contestant.key] = null;
        continue;
      }
      const value = round(mean(stats.scores), 4);
      scores[contestant.key] = value;
      passes[contestant.key] = [stats.passes, stats.counted];
      values.push(value);
    }
    const task = caseTask(datasetCase).replace(/\s+/g, " ").trim();
    return {
      caseId: datasetCase.id,
      tags: datasetCase.tags ?? [],
      input: task.length > 240 ? `${task.slice(0, 240)}…` : task,
      scores,
      passes,
      discrimination: values.length > 1 ? round(Math.max(...values) - Math.min(...values), 4) : 0,
    };
  });
}

function suiteHealth(rows: CaseRow[], summaries: ContestantSummary[]): SuiteHealth {
  let saturated = 0;
  let unsolved = 0;
  let discriminating = 0;
  for (const row of rows) {
    const tallies = Object.values(row.passes);
    if (tallies.length === 0) continue;
    if (tallies.every(([passed, counted]) => counted > 0 && passed === counted)) saturated++;
    if (tallies.every(([passed]) => passed === 0)) unsolved++;
    if (row.discrimination > 0) discriminating++;
  }
  const scored = summaries.filter((summary) => summary.cases > 1);
  const spread = scored.length > 1 ? Math.max(...scored.map((summary) => summary.mean)) - Math.min(...scored.map((summary) => summary.mean)) : 0;
  const noise = mean(scored.map((summary) => summary.se));
  return {
    saturated,
    unsolved,
    discriminating,
    signalToNoise: scored.length > 1 && noise > 0 ? round(spread / noise, 2) : null,
  };
}

/** How often a judge's pass matched the pass a person gave the same sample. */
function judgeAgreement(samples: BenchmarkSample[]): JudgeAgreement | null {
  const pairs: Array<[boolean, boolean]> = [];
  for (const sample of samples) {
    if (!sample.override) continue;
    const judged = sample.scores.filter((score) => score.judges && score.judges.length > 0 && !score.skipped && !score.error);
    if (judged.length === 0) continue;
    pairs.push([judged.every((score) => score.passed), sample.override.passed]);
  }
  if (pairs.length === 0) return null;
  const kappa = cohensKappa(pairs);
  return {
    compared: pairs.length,
    agreed: pairs.filter(([judge, person]) => judge === person).length,
    kappa: kappa === null ? null : round(kappa, 3),
  };
}

/** Keys on the frontier: no other contestant at least as good on both axes and better on one. */
export function paretoFrontier(points: Array<{ key: string; score: number; cost: number }>): string[] {
  return points
    .filter(
      (point) =>
        !points.some(
          (other) =>
            other.key !== point.key &&
            other.score >= point.score &&
            other.cost <= point.cost &&
            (other.score > point.score || other.cost < point.cost),
        ),
    )
    .map((point) => point.key);
}

/** Macro average over suites: each suite's mean weighs the same; the SE combines theirs. */
function overallSummaries(run: BenchmarkRun, suites: SuiteReport[]): ContestantSummary[] {
  if (suites.length === 1) return suites[0].summaries;
  const summaries = run.contestants.map((contestant) => {
    const own = suites
      .map((suite) => suite.summaries.find((summary) => summary.key === contestant.key))
      .filter((summary): summary is ContestantSummary => !!summary && summary.cases > 0);
    const first = own[0];
    const meanScore = mean(own.map((summary) => summary.mean));
    const se = own.length > 0 ? Math.sqrt(own.reduce((sum, summary) => sum + summary.se ** 2, 0)) / own.length : 0;
    const sum = (pick: (summary: ContestantSummary) => number) => own.reduce((total, summary) => total + pick(summary), 0);
    const samples = sum((summary) => summary.samples);
    const costTotal = sum((summary) => summary.cost.total);
    const passesTotal = sum((summary) => summary.passRate * summary.samples);
    return {
      ...(first ?? ({} as ContestantSummary)),
      key: contestant.key,
      label: contestant.label,
      cases: sum((summary) => summary.cases),
      samples,
      errored: sum((summary) => summary.errored),
      mean: round(meanScore),
      se: round(se),
      ci: { low: round(Math.max(0, meanScore - 1.96 * se)), high: round(Math.min(1, meanScore + 1.96 * se)) },
      passRate: round(samples > 0 ? passesTotal / samples : 0),
      passAtK: own.every((summary) => summary.passAtK !== null) && own.length > 0 ? round(mean(own.map((summary) => summary.passAtK!))) : null,
      passHatK: own.every((summary) => summary.passHatK !== null) && own.length > 0 ? round(mean(own.map((summary) => summary.passHatK!))) : null,
      passCurve:
        own.length > 0
          ? own[0].passCurve.map((point, index) => ({
              k: point.k,
              passAt: round(mean(own.map((summary) => summary.passCurve[index]?.passAt ?? 0))),
              passHat: round(mean(own.map((summary) => summary.passCurve[index]?.passHat ?? 0))),
            }))
          : [],
      consistency: own.every((summary) => summary.consistency !== null) && own.length > 0 ? round(mean(own.map((summary) => summary.consistency!))) : null,
      flakyCases: sum((summary) => summary.flakyCases),
      cost: {
        total: round(costTotal, 8),
        perSample: round(samples > 0 ? costTotal / samples : 0, 8),
        judge: round(sum((summary) => summary.cost.judge), 8),
        perPass: passesTotal > 0 ? round(costTotal / passesTotal, 8) : null,
      },
      latency: {
        meanMs: Math.round(mean(own.map((summary) => summary.latency.meanMs))),
        p50Ms: Math.round(mean(own.map((summary) => summary.latency.p50Ms))),
        p95Ms: Math.round(Math.max(0, ...own.map((summary) => summary.latency.p95Ms))),
      },
      ttftMs: own.some((summary) => summary.ttftMs !== null) ? Math.round(mean(own.map((summary) => summary.ttftMs ?? 0))) : null,
      tokensPerSecond: own.some((summary) => summary.tokensPerSecond !== null)
        ? round(mean(own.filter((summary) => summary.tokensPerSecond !== null).map((summary) => summary.tokensPerSecond!)), 1)
        : null,
      tokens: {
        input: sum((summary) => summary.tokens.input),
        output: sum((summary) => summary.tokens.output),
        reasoning: sum((summary) => summary.tokens.reasoning),
        cacheRead: sum((summary) => summary.tokens.cacheRead),
      },
      meanTurns: round(mean(own.map((summary) => summary.meanTurns)), 2),
      meanToolCalls: round(mean(own.map((summary) => summary.meanToolCalls)), 2),
      errors: own.reduce<Partial<Record<SampleErrorKind, number>>>((merged, summary) => {
        for (const [kind, count] of Object.entries(summary.errors)) {
          merged[kind as SampleErrorKind] = (merged[kind as SampleErrorKind] ?? 0) + (count ?? 0);
        }
        return merged;
      }, {}),
    };
  });
  // Overall significance: the macro difference over its combined SE (a z test), Holm-adjusted.
  const pairs: Array<{ winner: string; loser: string; p: number }> = [];
  for (const [index, first] of summaries.entries()) {
    for (const second of summaries.slice(index + 1)) {
      const diffs = suites
        .map((suite) => suite.pairwise.find((pair) => (pair.a === first.key && pair.b === second.key) || (pair.a === second.key && pair.b === first.key)))
        .filter((pair): pair is PairwiseComparison => !!pair && pair.n > 1)
        .map((pair) => ({ diff: pair.a === first.key ? pair.diff : -pair.diff, se: pair.se }));
      if (diffs.length === 0) continue;
      const diff = mean(diffs.map((entry) => entry.diff));
      const se = Math.sqrt(diffs.reduce((sum, entry) => sum + entry.se ** 2, 0)) / diffs.length;
      const p = se > 0 ? 2 * (1 - studentTCdf(Math.abs(diff / se), 1e6)) : diff === 0 ? 1 : 0;
      pairs.push({ winner: diff >= 0 ? first.key : second.key, loser: diff >= 0 ? second.key : first.key, p });
    }
  }
  const adjusted = holmAdjust(pairs.map((pair) => pair.p));
  const significant = pairs.filter((_, index) => adjusted[index] < SIGNIFICANCE);
  return rank(summaries, (winner, loser) => significant.some((pair) => pair.winner === winner && pair.loser === loser));
}

export function buildReport(
  run: BenchmarkRun,
  samples: BenchmarkSample[],
  battles: Battle[],
  { errorPolicy = "fail" }: { errorPolicy?: ErrorPolicy } = {},
): RunReport {
  const suites: SuiteReport[] = run.suites.map((suite) => {
    const byCase = collectCases(suite, samples, errorPolicy);
    const suiteSamples = samples.filter((sample) => sample.suiteId === suite.id);
    const pairwise = comparePairs(run.contestants, byCase);
    const summaries = rank(
      run.contestants.map((contestant) => summarise(contestant, byCase, suiteSamples, run.settings.epochs)),
      significance(pairwise),
    );
    const rows = caseRows(suite, run.contestants, byCase);
    return {
      suiteId: suite.id,
      name: suite.name,
      cases: suite.cases.length,
      summaries,
      pairwise,
      tags: tagBreakdown(suite, run.contestants, byCase),
      caseRows: rows,
      health: suiteHealth(rows, summaries),
    };
  });
  const overall = overallSummaries(run, suites);
  const scored = overall.filter((summary) => summary.cases > 0);
  const labels = Object.fromEntries(run.contestants.map((contestant) => [contestant.key, contestant.label]));
  const judgeCost =
    samples.reduce((sum, sample) => sum + (sample.judgeCost ?? 0), 0) +
    battles.reduce((sum, battle) => sum + (battle.judge?.votes.reduce((total, vote) => total + (vote.cost ?? 0), 0) ?? 0), 0);
  const contestantCost = samples.reduce((sum, sample) => sum + (sample.cost ?? 0), 0);
  return {
    runId: run.id,
    status: run.status,
    generatedAt: new Date().toISOString(),
    errorPolicy,
    overall,
    suites,
    pareto: {
      cost: paretoFrontier(scored.map((summary) => ({ key: summary.key, score: summary.mean, cost: summary.cost.perSample }))),
      latency: paretoFrontier(scored.map((summary) => ({ key: summary.key, score: summary.mean, cost: summary.latency.meanMs }))),
    },
    arena: battles.length > 0 ? buildArenaReport(battles, { labels, rounds: 100 }) : null,
    judgeAgreement: judgeAgreement(samples),
    judgeCost: round(judgeCost, 8),
    totalCost: round(judgeCost + contestantCost, 8),
  };
}

/** The headline numbers a run stores when it ends. */
export function resultsOf(report: RunReport): RunResults {
  const cell = (summary: ContestantSummary): ResultCell => ({
    label: summary.label,
    mean: summary.mean,
    low: summary.ci.low,
    high: summary.ci.high,
    cases: summary.cases,
    samples: summary.samples,
    cost: summary.cost.total,
    meanLatencyMs: summary.latency.meanMs,
  });
  const suites: RunResults["suites"] = {};
  for (const suite of report.suites) {
    suites[suite.suiteId] = Object.fromEntries(
      suite.summaries.filter((summary) => summary.cases > 0).map((summary) => [summary.key, cell(summary)]),
    );
  }
  const overall = Object.fromEntries(report.overall.filter((summary) => summary.cases > 0).map((summary) => [summary.key, cell(summary)]));
  const leader = report.overall.find((summary) => summary.cases > 0) ?? null;
  return {
    suites,
    overall,
    leader: leader ? { key: leader.key, label: leader.label, mean: leader.mean } : null,
  };
}

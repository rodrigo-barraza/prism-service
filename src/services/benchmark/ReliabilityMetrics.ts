/**
 * ReliabilityMetrics — pass@k and pass^k over repeated runs.
 *
 * A case runs n times and passes c of them.
 *   pass@k: the chance that at least one of k runs passes — the unbiased
 *           estimator 1 − C(n−c, k) / C(n, k) (Chen et al. 2021,
 *           "Evaluating Large Language Models Trained on Code",
 *           https://arxiv.org/abs/2107.03374).
 *   pass^k: the chance that all k runs pass — C(c, k) / C(n, k) (Yao et al.
 *           2024, "τ-bench", https://arxiv.org/abs/2406.12045). It is the
 *           reliability number: an agent that solves a task half the time has
 *           pass@3 = 0.875 and pass^3 = 0.125.
 * With n = k both reduce to their definitions: pass@k is 1 when any run
 * passed, pass^k is 1 when every run did. Both are computed as products, so
 * no binomial coefficient is ever formed. A dataset's figure is the mean
 * over its cases; per-step reliability decays over long runs
 * (arXiv 2609.01660), which is why the harness settings are swept against
 * it rather than against a single pass.
 */
import type {
  CaseReliability,
  CaseTrialResult,
  DatasetCase,
  ReliabilitySummary,
} from "#src/types/benchmark";

/** Unbiased pass@k from n runs with c passes (k clamped to n). */
export function passAtK(n: number, c: number, k: number): number {
  if (n <= 0) return 0;
  const draws = Math.min(Math.max(1, Math.floor(k)), n);
  const passes = Math.min(Math.max(0, c), n);
  if (n - passes < draws) return 1;
  let allFail = 1;
  for (let index = n - passes + 1; index <= n; index++) {
    allFail *= 1 - draws / index;
  }
  return 1 - allFail;
}

/** Unbiased pass^k from n runs with c passes (k clamped to n). */
export function passHatK(n: number, c: number, k: number): number {
  if (n <= 0) return 0;
  const draws = Math.min(Math.max(1, Math.floor(k)), n);
  const passes = Math.min(Math.max(0, c), n);
  if (passes < draws) return 0;
  let allPass = 1;
  for (let index = 0; index < draws; index++) {
    allPass *= (passes - index) / (n - index);
  }
  return allPass;
}

/** Nearest-rank percentile of a list (0 for an empty one). */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (value: number, digits = 6) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/** pass@k / pass^k of each case, in the dataset's order. */
export function summarizeCases(
  cases: Pick<DatasetCase, "id" | "name">[],
  trials: CaseTrialResult[],
  k: number,
): CaseReliability[] {
  return cases.map((datasetCase) => {
    const ofCase = trials.filter((trial) => trial.caseId === datasetCase.id);
    const passed = ofCase.filter((trial) => trial.passed).length;
    return {
      caseId: datasetCase.id,
      ...(datasetCase.name && { name: datasetCase.name }),
      trials: ofCase.length,
      passed,
      errored: ofCase.filter((trial) => trial.error).length,
      passAtK: round(passAtK(ofCase.length, passed, k)),
      passHatK: round(passHatK(ofCase.length, passed, k)),
    };
  });
}

/** A dataset run's reliability: per-run rates, per-case means, cost and latency. */
export function summarizeReliability(
  caseResults: CaseReliability[],
  trials: CaseTrialResult[],
  k: number,
): ReliabilitySummary {
  const measured = caseResults.filter((caseResult) => caseResult.trials > 0);
  const passedTrials = trials.filter((trial) => trial.passed).length;
  const totalCost = trials.reduce((sum, trial) => sum + (trial.cost || 0), 0);
  const latencies = trials.map((trial) => trial.latency || 0);
  const mean = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    k,
    cases: measured.length,
    trials: trials.length,
    passedTrials,
    erroredTrials: trials.filter((trial) => trial.error).length,
    passRate: round(trials.length > 0 ? passedTrials / trials.length : 0),
    passAtK: round(mean(measured.map((caseResult) => caseResult.passAtK))),
    passHatK: round(mean(measured.map((caseResult) => caseResult.passHatK))),
    totalCost: round(totalCost, 8),
    meanCostPerTrial: round(trials.length > 0 ? totalCost / trials.length : 0, 8),
    meanLatency: round(mean(latencies), 3),
    p50Latency: round(percentile(latencies, 0.5), 3),
    p95Latency: round(percentile(latencies, 0.95), 3),
  };
}

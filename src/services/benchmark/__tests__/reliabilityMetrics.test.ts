/**
 * pass@k and pass^k arithmetic. Both are unbiased estimators over n runs
 * with c passes: exactly the share of the C(n, k) ways to pick k of those
 * runs in which at least one (pass@k) / every one (pass^k) passed — the
 * brute-force check below enumerates the subsets to prove it.
 */
import { describe, it, expect } from "vitest";
import {
  passAtK,
  passHatK,
  percentile,
  summarizeCases,
  summarizeReliability,
} from "#src/services/benchmark/ReliabilityMetrics";
import type { CaseTrialResult } from "#src/types/benchmark";

/** Every k-subset of the indices 0..n-1. */
function* subsets(n: number, k: number, start = 0, picked: number[] = []): Generator<number[]> {
  if (picked.length === k) {
    yield picked;
    return;
  }
  for (let index = start; index < n; index++) yield* subsets(n, k, index + 1, [...picked, index]);
}

describe("pass@k (Chen et al. 2021) and pass^k (τ-bench)", () => {
  it("known values: 5 runs, 2 passed", () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 12);
    expect(passAtK(5, 2, 2)).toBeCloseTo(0.7, 12);
    expect(passAtK(5, 2, 3)).toBeCloseTo(0.9, 12);
    expect(passAtK(5, 2, 4)).toBe(1);
    expect(passHatK(5, 2, 1)).toBeCloseTo(0.4, 12);
    expect(passHatK(5, 2, 2)).toBeCloseTo(0.1, 12);
    expect(passHatK(5, 2, 3)).toBe(0);
    expect(passHatK(5, 4, 2)).toBeCloseTo(0.6, 12);
  });

  it("with n = k: pass@k is any-pass, pass^k is all-pass", () => {
    expect(passAtK(3, 0, 3)).toBe(0);
    expect(passAtK(3, 1, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
    expect(passHatK(3, 3, 3)).toBe(1);
  });

  it("k = 1 is the pass rate for both", () => {
    for (const [n, c] of [[7, 3], [10, 10], [4, 0]]) {
      expect(passAtK(n, c, 1)).toBeCloseTo(c / n, 12);
      expect(passHatK(n, c, 1)).toBeCloseTo(c / n, 12);
    }
  });

  it("equals the share of k-subsets with a pass / with no failure (brute force, n ≤ 7)", () => {
    for (let n = 1; n <= 7; n++) {
      for (let c = 0; c <= n; c++) {
        // The first c runs passed.
        for (let k = 1; k <= n; k++) {
          let total = 0;
          let anyPass = 0;
          let allPass = 0;
          for (const subset of subsets(n, k)) {
            total++;
            if (subset.some((index) => index < c)) anyPass++;
            if (subset.every((index) => index < c)) allPass++;
          }
          expect(passAtK(n, c, k)).toBeCloseTo(anyPass / total, 12);
          expect(passHatK(n, c, k)).toBeCloseTo(allPass / total, 12);
        }
      }
    }
  });

  it("k above n is read at n; no runs is 0", () => {
    expect(passAtK(2, 1, 3)).toBe(passAtK(2, 1, 2));
    expect(passHatK(2, 1, 3)).toBe(passHatK(2, 1, 2));
    expect(passAtK(0, 0, 3)).toBe(0);
    expect(passHatK(0, 0, 3)).toBe(0);
  });

  it("an agent that passes half the time: reliability collapses as k grows", () => {
    // pass@k climbs toward 1 while pass^k falls toward 0 (n = 10, c = 5).
    expect(passAtK(10, 5, 3)).toBeCloseTo(1 - (5 * 4 * 3) / (10 * 9 * 8), 12);
    expect(passHatK(10, 5, 3)).toBeCloseTo((5 * 4 * 3) / (10 * 9 * 8), 12);
    expect(passHatK(10, 5, 5)).toBeLessThan(passHatK(10, 5, 3));
  });
});

describe("percentile", () => {
  it("nearest rank", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
  });
});

describe("a dataset's summary", () => {
  const trial = (caseId: string, index: number, passed: boolean, extra: Partial<CaseTrialResult> = {}): CaseTrialResult => ({
    caseId,
    trial: index,
    passed,
    graderResults: [],
    response: passed ? "ok" : null,
    toolNames: [],
    turnCount: 1,
    latency: index,
    usage: null,
    cost: 0.01,
    error: null,
    ...extra,
  });

  it("per case, then the mean over cases; errored runs count as failures", () => {
    const trials = [
      trial("always", 1, true),
      trial("always", 2, true),
      trial("always", 3, true),
      trial("sometimes", 1, true),
      trial("sometimes", 2, false),
      trial("sometimes", 3, false, { error: "provider 500" }),
    ];
    const cases = summarizeCases([{ id: "always" }, { id: "sometimes", name: "Flaky" }], trials, 3);
    expect(cases).toEqual([
      { caseId: "always", trials: 3, passed: 3, errored: 0, passAtK: 1, passHatK: 1 },
      { caseId: "sometimes", name: "Flaky", trials: 3, passed: 1, errored: 1, passAtK: 1, passHatK: 0 },
    ]);
    const summary = summarizeReliability(cases, trials, 3);
    expect(summary).toMatchObject({
      k: 3,
      cases: 2,
      trials: 6,
      passedTrials: 4,
      erroredTrials: 1,
      passRate: 0.666667,
      passAtK: 1,
      passHatK: 0.5,
      totalCost: 0.06,
      meanCostPerTrial: 0.01,
      meanLatency: 2,
      p50Latency: 2,
      p95Latency: 3,
    });
  });

  it("a case with no runs (an aborted run) is left out of the means", () => {
    const trials = [trial("ran", 1, true)];
    const cases = summarizeCases([{ id: "ran" }, { id: "never" }], trials, 1);
    expect(summarizeReliability(cases, trials, 1)).toMatchObject({ cases: 1, passAtK: 1, passHatK: 1 });
  });
});

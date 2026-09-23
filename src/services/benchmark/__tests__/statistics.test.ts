import { describe, it, expect } from "vitest";
import {
  binomialTwoSided,
  bradleyTerryWithIntervals,
  cohensKappa,
  estimateMean,
  minimumDetectableDifference,
  signFlipPValue,
  fitBradleyTerry,
  holmAdjust,
  normalQuantile,
  pairedComparison,
  passAtK,
  passHatK,
  rankRanges,
  shuffled,
  studentTCdf,
  studentTQuantile,
  wilsonInterval,
  type Comparison,
} from "#src/services/benchmark/Statistics";

describe("distributions", () => {
  it("matches published t and normal quantiles", () => {
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228, 3);
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.706, 2);
    expect(studentTQuantile(0.975, 30)).toBeCloseTo(2.042, 3);
    expect(studentTQuantile(0.8, 20)).toBeCloseTo(0.86, 2);
    expect(normalQuantile(0.975)).toBeCloseTo(1.96, 3);
    expect(studentTCdf(0, 5)).toBeCloseTo(0.5, 10);
    expect(studentTCdf(2.571, 5)).toBeCloseTo(0.975, 3);
  });

  it("computes an exact two-sided sign test", () => {
    // 8 of 10: P(X ≤ 2) = 56/1024, doubled.
    expect(binomialTwoSided(8, 10)).toBeCloseTo((2 * 56) / 1024, 10);
    expect(binomialTwoSided(5, 10)).toBe(1);
    expect(binomialTwoSided(0, 0)).toBe(1);
  });
});

describe("intervals", () => {
  it("gives the Wilson interval for a proportion", () => {
    const interval = wilsonInterval(5, 10);
    expect(interval.low).toBeCloseTo(0.2366, 3);
    expect(interval.high).toBeCloseTo(0.7634, 3);
    expect(wilsonInterval(0, 10).low).toBe(0);
    expect(wilsonInterval(10, 10).high).toBe(1);
  });

  it("uses Wilson for binary case means and a clustered t interval otherwise", () => {
    const binary = estimateMean([1, 0, 1, 1, 0, 1, 1, 1, 0, 1]);
    expect(binary.mean).toBeCloseTo(0.7, 10);
    expect(binary.low).toBeCloseTo(wilsonInterval(7, 10).low, 10);

    // Case means averaged over epochs: the SE is sd(case means)/√n.
    const fractional = estimateMean([1, 2 / 3, 1 / 3, 1, 0, 2 / 3]);
    const sd = Math.sqrt(
      [1, 2 / 3, 1 / 3, 1, 0, 2 / 3].reduce((sum, value) => sum + (value - 0.6111111) ** 2, 0) / 5,
    );
    expect(fractional.se).toBeCloseTo(sd / Math.sqrt(6), 5);
    expect(fractional.mean - fractional.low).toBeCloseTo(studentTQuantile(0.975, 5) * fractional.se, 6);
    expect(fractional.high).toBeLessThanOrEqual(1);
  });
});

describe("paired comparisons", () => {
  it("uses McNemar on binary scores: only discordant cases count", () => {
    const first = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1];
    const second = [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1];
    const result = pairedComparison(first, second);
    expect(result.test).toBe("mcnemar");
    expect(result.wins).toBe(6);
    expect(result.losses).toBe(0);
    expect(result.ties).toBe(6);
    expect(result.diff).toBeCloseTo(0.5, 10);
    expect(result.pValue).toBeCloseTo(2 / 64, 10);
  });

  it("uses a sign-flip permutation test on fractional scores, and pairing narrows the interval", () => {
    // Hard and easy cases shared by both: a large per-case spread, a small consistent gap.
    const base = [0.1, 0.9, 0.2, 0.8, 0.3, 0.7, 0.4, 0.6, 0.5, 0.95];
    const better = base.map((value) => Math.min(1, value + 0.05 + (value * 1000) % 0.01));
    const result = pairedComparison(better, base);
    expect(result.test).toBe("permutation");
    expect(result.diff).toBeGreaterThan(0.04);
    // Every difference positive: exact p = 2 / 2^10.
    expect(result.pValue).toBeCloseTo(2 / 1024, 10);
    expect(result.correlation).toBeGreaterThan(0.99);
    // Two independent intervals would overlap; the paired one excludes zero.
    const independent = estimateMean(base);
    expect(independent.high).toBeGreaterThan(estimateMean(better).low);
    expect(result.low).toBeGreaterThan(0);
  });

  it("reports no test for fewer than two shared cases", () => {
    expect(pairedComparison([1], [0]).test).toBe("none");
  });

  it("gives a large permutation p-value to differences centred on zero", () => {
    const differences = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 0.3 : -0.3) + (index % 5) * 0.001);
    expect(signFlipPValue(differences)).toBeGreaterThan(0.5);
  });

  it("sizes the minimum detectable difference like Miller's table", () => {
    // n = 100, 70 % accuracy, ρ = .5, one epoch → 12.8 points; n = 500 → 5.7.
    expect(minimumDetectableDifference(100)).toBeCloseTo(0.128, 2);
    expect(minimumDetectableDifference(500)).toBeCloseTo(0.057, 2);
    expect(minimumDetectableDifference(100, { epochs: 4 })!).toBeLessThan(minimumDetectableDifference(100)!);
  });

  it("computes Cohen's kappa", () => {
    expect(cohensKappa([[true, true], [false, false], [true, true], [false, false]])).toBe(1);
    expect(cohensKappa([[true, false], [false, true]])).toBeLessThan(0);
    expect(cohensKappa([])).toBeNull();
  });

  it("Holm-adjusts p-values step-down, monotone", () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holmAdjust([0.5])).toEqual([0.5]);
  });

  it("derives rank ranges from significance", () => {
    const beats = new Set(["a>c", "b>c"]);
    const ranges = rankRanges(["a", "b", "c"], (winner, loser) => beats.has(`${winner}>${loser}`));
    expect(ranges).toEqual({ a: [1, 2], b: [1, 2], c: [3, 3] });
  });
});

describe("pass@k and pass^k", () => {
  it("matches the unbiased estimators", () => {
    expect(passAtK(3, 1, 3)).toBe(1);
    expect(passAtK(3, 0, 3)).toBe(0);
    expect(passAtK(10, 5, 3)).toBeCloseTo(1 - (10 * 9 * 8) / (10 * 9 * 8) * ((5 * 4 * 3) / (10 * 9 * 8)), 10);
    expect(passHatK(10, 5, 3)).toBeCloseTo((5 * 4 * 3) / (10 * 9 * 8), 10);
    expect(passHatK(3, 3, 3)).toBe(1);
    expect(passHatK(3, 2, 3)).toBe(0);
  });
});

describe("Bradley–Terry", () => {
  const battles = (strengths: number[], perPair: number, seed = 7): Comparison[] => {
    let state = seed;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const comparisons: Comparison[] = [];
    for (let a = 0; a < strengths.length; a++) {
      for (let b = a + 1; b < strengths.length; b++) {
        for (let round = 0; round < perPair; round++) {
          const probability = 1 / (1 + Math.exp(strengths[b] - strengths[a]));
          comparisons.push({ a, b, score: random() < probability ? 1 : 0 });
        }
      }
    }
    return comparisons;
  };

  it("recovers the order and scale of known strengths", () => {
    const truth = [1.2, 0.4, 0, -0.6];
    const fit = fitBradleyTerry(4, battles(truth, 400));
    expect(fit.converged).toBe(true);
    const order = fit.strengths.map((value, index) => ({ value, index })).sort((x, y) => y.value - x.value);
    expect(order.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(fit.strengths[0] - fit.strengths[3]).toBeCloseTo(1.8, 0);
  });

  it("keeps an undefeated player finite and gives ties half a win", () => {
    const fit = fitBradleyTerry(2, [
      { a: 0, b: 1, score: 1 },
      { a: 0, b: 1, score: 1 },
    ]);
    expect(Number.isFinite(fit.strengths[0])).toBe(true);
    const even = fitBradleyTerry(2, [
      { a: 0, b: 1, score: 0.5 },
      { a: 1, b: 0, score: 0.5 },
    ]);
    expect(even.strengths[0]).toBeCloseTo(0, 6);
  });

  it("bootstraps intervals that contain the rating", () => {
    const rated = bradleyTerryWithIntervals(3, battles([0.8, 0, -0.8], 60), { rounds: 60 });
    rated.ratings.forEach((rating, index) => {
      expect(rated.intervals[index].low).toBeLessThanOrEqual(rating + 1e-6);
      expect(rated.intervals[index].high).toBeGreaterThanOrEqual(rating - 1e-6);
    });
    expect(rated.ratings[0]).toBeGreaterThan(rated.ratings[2]);
  });

  it("separates a style effect from the players with covariates", () => {
    // Two equal players; whoever writes longer wins 80 % of the time.
    const comparisons: Comparison[] = [];
    let state = 3;
    for (let index = 0; index < 600; index++) {
      state = (state * 1103515245 + 12345) % 2147483648;
      const longer = index % 2 === 0 ? 1 : -1;
      const win = (state / 2147483648) < (longer > 0 ? 0.8 : 0.2) ? 1 : 0;
      comparisons.push({ a: index % 4 < 2 ? 0 : 1, b: index % 4 < 2 ? 1 : 0, score: win, covariates: [longer] });
    }
    const fit = fitBradleyTerry(2, comparisons);
    expect(Math.abs(fit.strengths[0] - fit.strengths[1])).toBeLessThan(0.3);
    expect(fit.styleCoefficients[0]).toBeGreaterThan(1);
  });
});

describe("sampling", () => {
  it("shuffles reproducibly by seed", () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(shuffled(items, 42)).toEqual(shuffled(items, 42));
    expect(shuffled(items, 42)).not.toEqual(shuffled(items, 43));
    expect([...shuffled(items, 42)].sort((a, b) => a - b)).toEqual(items);
  });
});

/**
 * Statistics — the numbers a benchmark report stands on.
 *
 * Evals are experiments on a sample of questions, so every mean comes with
 * an interval and every comparison with a test (Miller 2024, "Adding Error
 * Bars to Evals", https://arxiv.org/abs/2411.00640):
 *   - a contestant's score is the mean over CASES of its mean over epochs;
 *     repeating a case (epochs) shrinks the within-case noise, and the
 *     standard error is clustered by case — sd(case means) / √n;
 *   - two contestants are compared on the SAME cases, as a paired
 *     difference: the case-to-case difficulty cancels, so the interval is
 *     far narrower than two independent intervals suggest;
 *   - a binary score on one epoch gets a Wilson interval (the normal one
 *     fails at small n and near 0 or 1), and a binary paired comparison an
 *     exact McNemar test;
 *   - every pair of a suite is tested, so p-values are Holm-adjusted.
 * pass@k / pass^k (Chen et al. 2021; Yao et al. 2024, τ-bench) summarise
 * repeated epochs. Bradley–Terry ratings (LMArena's method) are fitted by
 * Newton's method on a logistic model with a small ridge, optionally with
 * style covariates, with bootstrap intervals.
 */

// ── Basics ──────────────────────────────────────────────────

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample variance (n − 1). */
export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - center) ** 2;
  return sum / (values.length - 1);
}

/** Nearest-rank percentile (0 for an empty list). */
export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function pearson(first: number[], second: number[]): number | null {
  const n = Math.min(first.length, second.length);
  if (n < 3) return null;
  const firstMean = mean(first.slice(0, n));
  const secondMean = mean(second.slice(0, n));
  let covariance = 0;
  let firstSquares = 0;
  let secondSquares = 0;
  for (let index = 0; index < n; index++) {
    const firstDelta = first[index] - firstMean;
    const secondDelta = second[index] - secondMean;
    covariance += firstDelta * secondDelta;
    firstSquares += firstDelta ** 2;
    secondSquares += secondDelta ** 2;
  }
  if (firstSquares === 0 || secondSquares === 0) return null;
  return covariance / Math.sqrt(firstSquares * secondSquares);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
export const isBinary = (values: number[]) => values.every((value) => value === 0 || value === 1);

// ── Distributions ───────────────────────────────────────────

/** ln Γ(x), Lanczos approximation (g = 7, n = 9). */
function logGamma(x: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = coefficients[0];
  for (let index = 1; index < 9; index++) sum += coefficients[index] / (shifted + index);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction of the incomplete beta function (Numerical Recipes, betacf). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    numerator = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 3e-14) break;
  }
  return result;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T ≤ t) for Student's t with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(probability: number): number {
  if (probability <= 0) return -Infinity;
  if (probability >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Student's t quantile: the t with P(T ≤ t) = probability (bisection on the CDF). */
export function studentTQuantile(probability: number, df: number): number {
  if (df <= 0 || !Number.isFinite(df)) return normalQuantile(probability);
  if (df > 1000) return normalQuantile(probability);
  if (probability === 0.5) return 0;
  let low = -1e3;
  let high = 1e3;
  for (let iteration = 0; iteration < 200; iteration++) {
    const middle = (low + high) / 2;
    if (studentTCdf(middle, df) < probability) low = middle;
    else high = middle;
    if (high - low < 1e-10) break;
  }
  return (low + high) / 2;
}

/** Two-sided exact binomial (sign) test of `successes` out of `trials` against ½. */
export function binomialTwoSided(successes: number, trials: number): number {
  if (trials <= 0) return 1;
  const smaller = Math.min(successes, trials - successes);
  // Σ_{i ≤ smaller} C(n, i) / 2^n, in log space.
  let logCoefficient = 0;
  let tail = 0;
  for (let index = 0; index <= smaller; index++) {
    if (index > 0) logCoefficient += Math.log((trials - index + 1) / index);
    tail += Math.exp(logCoefficient - trials * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

// ── Intervals ───────────────────────────────────────────────

const Z_95 = 1.959963984540054;

export interface MeanEstimate {
  mean: number;
  se: number;
  low: number;
  high: number;
}

/** Wilson score interval for a proportion. */
export function wilsonInterval(successes: number, trials: number, z = Z_95): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 };
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (proportion + (z * z) / (2 * trials)) / denominator;
  const halfWidth =
    (z * Math.sqrt((proportion * (1 - proportion)) / trials + (z * z) / (4 * trials * trials))) /
    denominator;
  return {
    low: successes <= 0 ? 0 : clamp01(center - halfWidth),
    high: successes >= trials ? 1 : clamp01(center + halfWidth),
  };
}

/**
 * Mean of per-case scores (each already averaged over its epochs) with a
 * 95 % interval: Wilson when every case mean is 0 or 1, else a t interval
 * on the clustered standard error, clamped to [0, 1].
 */
export function estimateMean(caseMeans: number[]): MeanEstimate {
  const n = caseMeans.length;
  if (n === 0) return { mean: 0, se: 0, low: 0, high: 1 };
  const center = mean(caseMeans);
  const se = n > 1 ? Math.sqrt(variance(caseMeans) / n) : 0;
  if (isBinary(caseMeans)) {
    const successes = caseMeans.filter((value) => value === 1).length;
    const interval = wilsonInterval(successes, n);
    return { mean: center, se, ...interval };
  }
  if (n === 1) return { mean: center, se: 0, low: 0, high: 1 };
  const quantile = studentTQuantile(0.975, n - 1);
  return { mean: center, se, low: clamp01(center - quantile * se), high: clamp01(center + quantile * se) };
}

// ── Paired comparisons ──────────────────────────────────────

/**
 * Two-sided sign-flip permutation test of mean(differences) = 0: under the
 * null each difference is as likely to have either sign. Exact up to 16
 * differences, 10 000 seeded random flips beyond.
 */
export function signFlipPValue(differences: number[], { rounds = 10_000, seed = 11 } = {}): number {
  const n = differences.length;
  if (n === 0) return 1;
  const observed = Math.abs(mean(differences)) - 1e-12;
  if (n <= 16) {
    let extreme = 0;
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) {
      let sum = 0;
      for (let index = 0; index < n; index++) sum += mask & (1 << index) ? -differences[index] : differences[index];
      if (Math.abs(sum / n) >= observed) extreme++;
    }
    return extreme / total;
  }
  const random = seededRandom(seed);
  let extreme = 0;
  for (let round = 0; round < rounds; round++) {
    let sum = 0;
    for (const difference of differences) sum += random() < 0.5 ? -difference : difference;
    if (Math.abs(sum / n) >= observed) extreme++;
  }
  return (1 + extreme) / (rounds + 1);
}

/** Cohen's κ between two raters' binary labels. */
export function cohensKappa(pairs: Array<[boolean, boolean]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const agree = pairs.filter(([first, second]) => first === second).length / n;
  const firstYes = pairs.filter(([first]) => first).length / n;
  const secondYes = pairs.filter(([, second]) => second).length / n;
  const chance = firstYes * secondYes + (1 - firstYes) * (1 - secondYes);
  return chance >= 1 ? (agree === 1 ? 1 : 0) : (agree - chance) / (1 - chance);
}

export interface PairedResult {
  n: number;
  diff: number;
  se: number;
  low: number;
  high: number;
  pValue: number;
  test: "mcnemar" | "permutation" | "none";
  wins: number;
  ties: number;
  losses: number;
  /** Minimum detectable difference at 80 % power, two-sided α = 0.05. */
  mde: number;
  correlation: number | null;
}

/**
 * Compare two contestants on the same cases (`first[i]` and `second[i]`
 * are the same case). Binary scores get an exact McNemar test on the
 * discordant cases; partial-credit scores a sign-flip permutation test
 * (no normality assumed). The interval is the t interval of the
 * differences.
 */
export function pairedComparison(first: number[], second: number[]): PairedResult {
  const n = Math.min(first.length, second.length);
  const differences: number[] = [];
  let wins = 0;
  let ties = 0;
  let losses = 0;
  for (let index = 0; index < n; index++) {
    const difference = first[index] - second[index];
    differences.push(difference);
    if (Math.abs(difference) < 1e-12) ties++;
    else if (difference > 0) wins++;
    else losses++;
  }
  const diff = mean(differences);
  if (n < 2) {
    return { n, diff, se: 0, low: -1, high: 1, pValue: 1, test: "none", wins, ties, losses, mde: 1, correlation: null };
  }
  const se = Math.sqrt(variance(differences) / n);
  const quantile = studentTQuantile(0.975, n - 1);
  const power = studentTQuantile(0.8, n - 1);
  const low = Math.max(-1, diff - quantile * se);
  const high = Math.min(1, diff + quantile * se);
  const firstBinary = isBinary(first.slice(0, n));
  const secondBinary = isBinary(second.slice(0, n));
  let pValue: number;
  let test: PairedResult["test"];
  if (firstBinary && secondBinary) {
    // McNemar: only the discordant cases carry information.
    pValue = binomialTwoSided(wins, wins + losses);
    test = "mcnemar";
  } else {
    pValue = diff === 0 ? 1 : signFlipPValue(differences);
    test = "permutation";
  }
  // With no spread in the differences, size the detectable effect for the worst case (sd ½).
  const effectiveSe = se > 0 ? se : 0.5 / Math.sqrt(n);
  return {
    n,
    diff,
    se,
    low,
    high,
    pValue,
    test,
    wins,
    ties,
    losses,
    mde: Math.min(1, (quantile + power) * effectiveSe),
    correlation: pearson(first.slice(0, n), second.slice(0, n)),
  };
}

/**
 * The smallest paired difference n cases detect (80 % power, α 0.05) for
 * two contestants near `accuracy` whose per-case results correlate `rho`
 * (Miller 2024, eq. 10: MDE = 2.8 · sd(d)/√n).
 */
export function minimumDetectableDifference(n: number, { accuracy = 0.7, rho = 0.5, epochs = 1 } = {}): number | null {
  if (n < 2) return null;
  // Each case mean over `epochs` samples: within-case noise shrinks by 1/epochs
  // for the share of variance that is sampling noise (half, as a middle guess).
  const variance = accuracy * (1 - accuracy);
  const perCase = variance * (0.5 + 0.5 / Math.max(1, epochs));
  const differenceVariance = 2 * perCase * (1 - rho);
  return Math.min(1, 2.8 * Math.sqrt(differenceVariance / n));
}

/** Holm–Bonferroni step-down adjustment; returns adjusted p-values in input order. */
export function holmAdjust(pValues: number[]): number[] {
  const order = pValues.map((value, index) => ({ value, index })).sort((x, y) => x.value - y.value);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ value, index }, position) => {
    running = Math.max(running, Math.min(1, (pValues.length - position) * value));
    adjusted[index] = running;
  });
  return adjusted;
}

/**
 * Ranks from pairwise significance: the best rank is 1 + the contestants
 * significantly better, the worst is N − the ones significantly worse.
 */
export function rankRanges(
  keys: string[],
  significantlyBetter: (winner: string, loser: string) => boolean,
): Record<string, [number, number]> {
  const ranges: Record<string, [number, number]> = {};
  for (const key of keys) {
    let better = 0;
    let worse = 0;
    for (const other of keys) {
      if (other === key) continue;
      if (significantlyBetter(other, key)) better++;
      if (significantlyBetter(key, other)) worse++;
    }
    ranges[key] = [1 + better, keys.length - worse];
  }
  return ranges;
}

// ── pass@k / pass^k ─────────────────────────────────────────

/** Unbiased pass@k from n runs with c passes (k clamped to n): 1 − C(n−c, k)/C(n, k). */
export function passAtK(n: number, c: number, k: number): number {
  if (n <= 0) return 0;
  const draws = Math.min(Math.max(1, Math.floor(k)), n);
  const passes = Math.min(Math.max(0, c), n);
  if (n - passes < draws) return 1;
  let allFail = 1;
  for (let index = n - passes + 1; index <= n; index++) allFail *= 1 - draws / index;
  return 1 - allFail;
}

/** Unbiased pass^k from n runs with c passes (k clamped to n): C(c, k)/C(n, k). */
export function passHatK(n: number, c: number, k: number): number {
  if (n <= 0) return 0;
  const draws = Math.min(Math.max(1, Math.floor(k)), n);
  const passes = Math.min(Math.max(0, c), n);
  if (passes < draws) return 0;
  let allPass = 1;
  for (let index = 0; index < draws; index++) allPass *= (passes - index) / (n - index);
  return allPass;
}

// ── Randomness ──────────────────────────────────────────────

/** A seeded PRNG (mulberry32) — sampling and bootstraps are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy, seeded. */
export function shuffled<Item>(items: Item[], seed: number): Item[] {
  const random = seededRandom(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// ── Bradley–Terry ───────────────────────────────────────────

/** One comparison: player `a` vs player `b`, `score` = a's share of the outcome (1 win, ½ tie, 0 loss). */
export interface Comparison {
  a: number;
  b: number;
  score: number;
  /** Style covariates (a − b, normalised) for style control. */
  covariates?: number[];
}

export interface BradleyTerryFit {
  /** Log-strength per player, centred on 0. */
  strengths: number[];
  /** Style coefficients (empty without covariates). */
  styleCoefficients: number[];
  converged: boolean;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** Solve A x = b by Gaussian elimination with partial pivoting (A is copied). */
function solveLinear(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    for (let row = column + 1; row < size; row++) {
      const factor = augmented[row][column] / augmented[column][column];
      if (factor === 0) continue;
      for (let entry = column; entry <= size; entry++) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row--) {
    let sum = augmented[row][size];
    for (let entry = row + 1; entry < size; entry++) sum -= augmented[row][entry] * solution[entry];
    solution[row] = sum / augmented[row][row];
  }
  return solution;
}

/**
 * Fit Bradley–Terry strengths: P(a beats b) = σ(β_a − β_b + γ·covariates),
 * by Newton's method on the (fractional-outcome) logistic likelihood with
 * a ridge `lambda` that keeps undefeated players finite. Comparisons with
 * no covariates are aggregated by pair first.
 */
export function fitBradleyTerry(
  players: number,
  comparisons: Comparison[],
  { lambda = 0.01, iterations = 50 }: { lambda?: number; iterations?: number } = {},
): BradleyTerryFit {
  const covariateCount = comparisons.find((comparison) => comparison.covariates?.length)?.covariates?.length ?? 0;
  type Row = { a: number; b: number; wins: number; count: number; covariates: number[] };
  let rows: Row[];
  if (covariateCount === 0) {
    const byPair = new Map<string, Row>();
    for (const comparison of comparisons) {
      const [a, b, score] =
        comparison.a < comparison.b
          ? [comparison.a, comparison.b, comparison.score]
          : [comparison.b, comparison.a, 1 - comparison.score];
      const key = `${a}:${b}`;
      const row = byPair.get(key) ?? { a, b, wins: 0, count: 0, covariates: [] };
      row.wins += score;
      row.count += 1;
      byPair.set(key, row);
    }
    rows = [...byPair.values()];
  } else {
    rows = comparisons.map((comparison) => ({
      a: comparison.a,
      b: comparison.b,
      wins: comparison.score,
      count: 1,
      covariates: comparison.covariates ?? new Array<number>(covariateCount).fill(0),
    }));
  }
  const dimension = players + covariateCount;
  const parameters = new Array<number>(dimension).fill(0);
  let converged = false;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = parameters.map((value) => -lambda * value);
    const hessian = Array.from({ length: dimension }, (_, row) =>
      Array.from({ length: dimension }, (_, column) => (row === column ? lambda : 0)),
    );
    for (const row of rows) {
      let linear = parameters[row.a] - parameters[row.b];
      for (let index = 0; index < covariateCount; index++) {
        linear += parameters[players + index] * row.covariates[index];
      }
      const probability = sigmoid(linear);
      const residual = row.wins - row.count * probability;
      const weight = row.count * probability * (1 - probability);
      // Feature vector: +1 at a, −1 at b, covariates after the players.
      const features: Array<[number, number]> = [
        [row.a, 1],
        [row.b, -1],
        ...row.covariates.map((value, index): [number, number] => [players + index, value]),
      ];
      for (const [index, value] of features) {
        gradient[index] += residual * value;
        for (const [other, otherValue] of features) hessian[index][other] += weight * value * otherValue;
      }
    }
    const step = solveLinear(hessian, gradient);
    if (!step) break;
    let largest = 0;
    for (let index = 0; index < dimension; index++) {
      parameters[index] += step[index];
      largest = Math.max(largest, Math.abs(step[index]));
    }
    if (largest < 1e-9) {
      converged = true;
      break;
    }
  }
  const strengths = parameters.slice(0, players);
  const center = mean(strengths);
  return {
    strengths: strengths.map((value) => value - center),
    styleCoefficients: parameters.slice(players),
    converged,
  };
}

/** Log-strength → Elo-style rating (400 points per factor of 10 in odds), mean 1000. */
export const toEloScale = (strength: number) => 1000 + (400 / Math.LN10) * strength;

export interface RatedPlayers {
  ratings: number[];
  intervals: Array<{ low: number; high: number }>;
}

/** Ratings plus percentile-bootstrap 95 % intervals over resampled comparisons. */
export function bradleyTerryWithIntervals(
  players: number,
  comparisons: Comparison[],
  { rounds = 200, seed = 1 }: { rounds?: number; seed?: number } = {},
): RatedPlayers {
  const fit = fitBradleyTerry(players, comparisons);
  const ratings = fit.strengths.map(toEloScale);
  if (comparisons.length === 0) {
    return { ratings, intervals: ratings.map((rating) => ({ low: rating, high: rating })) };
  }
  const random = seededRandom(seed);
  const samples: number[][] = Array.from({ length: players }, () => []);
  for (let round = 0; round < rounds; round++) {
    const resample: Comparison[] = [];
    for (let index = 0; index < comparisons.length; index++) {
      resample.push(comparisons[Math.floor(random() * comparisons.length)]);
    }
    const bootstrap = fitBradleyTerry(players, resample, { iterations: 30 });
    bootstrap.strengths.forEach((strength, player) => samples[player].push(toEloScale(strength)));
  }
  return {
    ratings,
    intervals: samples.map((values) => ({ low: percentile(values, 0.025), high: percentile(values, 0.975) })),
  };
}

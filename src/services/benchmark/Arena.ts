/**
 * Arena — pairwise preferences and the ratings fitted over them.
 *
 * A battle is one preference between two contestants' answers to the same
 * prompt: a judge's (position-swapped, BenchmarkJudge.judgePairwise) or a
 * person's, voted blind. Ratings follow LMArena: a Bradley–Terry model
 * fitted by maximum likelihood rather than online Elo (order-independent),
 * shown on the Elo scale, with bootstrap 95 % intervals; ties and "both
 * bad" count half a win to each side. Style control adds the answers'
 * length and markdown differences as covariates, so a rating says how
 * often a contestant wins beyond what its verbosity buys it.
 */
import { BENCHMARK } from "#src/constants";
import {
  bradleyTerryWithIntervals,
  fitBradleyTerry,
  mean,
  toEloScale,
  type Comparison,
} from "#src/services/benchmark/Statistics";
import type { ArenaReport, ArenaStanding, Battle, BattleStyle, BattleWinner } from "#src/types/benchmark";

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** Length and markdown of both answers (style-control covariates). */
export function battleStyle(first: string, second: string): BattleStyle {
  const measure = (text: string) => ({
    length: text.length,
    headers: count(text, /^#{1,6}\s/gm),
    lists: count(text, /^\s*(?:[-*+]|\d+[.)])\s/gm),
    bold: count(text, /\*\*[^*\n]+\*\*|__[^_\n]+__/g),
  });
  const a = measure(first);
  const b = measure(second);
  return {
    length: [a.length, b.length],
    headers: [a.headers, b.headers],
    lists: [a.lists, b.lists],
    bold: [a.bold, b.bold],
  };
}

const SCORE: Record<BattleWinner, number> = { a: 1, b: 0, tie: 0.5, both_bad: 0.5 };

/** Normalised difference (a − b)/(a + b), 0 when both are 0. */
const normalisedDifference = ([a, b]: [number, number]) => (a + b === 0 ? 0 : (a - b) / (a + b));

function styleCovariates(style: BattleStyle): number[] {
  return [
    normalisedDifference(style.length),
    normalisedDifference(style.headers),
    normalisedDifference(style.lists),
    normalisedDifference(style.bold),
  ];
}

/** Standardise each covariate column (mean 0, sd 1) so the ridge treats them alike. */
function standardise(rows: number[][]): number[][] {
  if (rows.length === 0) return rows;
  const columns = rows[0].length;
  const means = Array.from({ length: columns }, (_, column) => mean(rows.map((row) => row[column])));
  const deviations = Array.from({ length: columns }, (_, column) => {
    const spread = Math.sqrt(mean(rows.map((row) => (row[column] - means[column]) ** 2)));
    return spread > 1e-9 ? spread : 1;
  });
  return rows.map((row) => row.map((value, column) => (value - means[column]) / deviations[column]));
}

/**
 * Standings over a set of battles. `labels` names the contestant keys (the
 * latest label a battle carried otherwise).
 */
export function buildArenaReport(
  battles: Battle[],
  { styleControl = false, rounds = BENCHMARK.ARENA_BOOTSTRAP_ROUNDS, labels = {} }: {
    styleControl?: boolean;
    rounds?: number;
    labels?: Record<string, string>;
  } = {},
): ArenaReport {
  const keys: string[] = [];
  const index = new Map<string, number>();
  const knownLabels: Record<string, string> = { ...labels };
  for (const battle of battles) {
    for (const side of [battle.a, battle.b]) {
      if (!index.has(side.contestantKey)) {
        index.set(side.contestantKey, keys.length);
        keys.push(side.contestantKey);
      }
      if (!knownLabels[side.contestantKey]) knownLabels[side.contestantKey] = side.label;
    }
  }
  const usable = battles.filter((battle) => battle.a.contestantKey !== battle.b.contestantKey);
  const covariates = styleControl ? standardise(usable.map((battle) => styleCovariates(battle.style))) : [];
  const comparisons: Comparison[] = usable.map((battle, position) => ({
    a: index.get(battle.a.contestantKey)!,
    b: index.get(battle.b.contestantKey)!,
    score: SCORE[battle.winner],
    ...(styleControl && { covariates: covariates[position] }),
  }));
  const rated =
    rounds > 0
      ? bradleyTerryWithIntervals(keys.length, comparisons, { rounds, seed: 17 })
      : (() => {
          const fit = fitBradleyTerry(keys.length, comparisons);
          const ratings = fit.strengths.map(toEloScale);
          return { ratings, intervals: ratings.map((rating) => ({ low: rating, high: rating })) };
        })();

  const tallies = keys.map(() => ({ battles: 0, wins: 0, losses: 0, ties: 0 }));
  const battleCounts: Record<string, Record<string, number>> = {};
  for (const key of keys) battleCounts[key] = {};
  for (const battle of usable) {
    const a = index.get(battle.a.contestantKey)!;
    const b = index.get(battle.b.contestantKey)!;
    tallies[a].battles++;
    tallies[b].battles++;
    if (battle.winner === "a") {
      tallies[a].wins++;
      tallies[b].losses++;
    } else if (battle.winner === "b") {
      tallies[b].wins++;
      tallies[a].losses++;
    } else {
      tallies[a].ties++;
      tallies[b].ties++;
    }
    battleCounts[battle.a.contestantKey][battle.b.contestantKey] = (battleCounts[battle.a.contestantKey][battle.b.contestantKey] ?? 0) + 1;
    battleCounts[battle.b.contestantKey][battle.a.contestantKey] = (battleCounts[battle.b.contestantKey][battle.a.contestantKey] ?? 0) + 1;
  }

  const order = keys.map((_, position) => position).sort((first, second) => rated.ratings[second] - rated.ratings[first]);
  const standings: ArenaStanding[] = order.map((position, rank) => {
    const interval = rated.intervals[position];
    // LMArena's rank spread: 1 + how many are certainly better / N − how many certainly worse.
    let better = 0;
    let worse = 0;
    keys.forEach((_, other) => {
      if (other === position) return;
      if (rated.intervals[other].low > interval.high) better++;
      if (rated.intervals[other].high < interval.low) worse++;
    });
    const tally = tallies[position];
    return {
      key: keys[position],
      label: knownLabels[keys[position]] ?? keys[position],
      rating: Math.round(rated.ratings[position] * 10) / 10,
      ci: { low: Math.round(interval.low * 10) / 10, high: Math.round(interval.high * 10) / 10 },
      battles: tally.battles,
      wins: tally.wins,
      losses: tally.losses,
      ties: tally.ties,
      winRate: tally.battles > 0 ? (tally.wins + tally.ties / 2) / tally.battles : 0,
      rank: rank + 1,
      rankRange: [1 + better, keys.length - worse],
    };
  });

  const winMatrix: Record<string, Record<string, number>> = {};
  for (const [row, rowKey] of keys.entries()) {
    winMatrix[rowKey] = {};
    for (const [column, columnKey] of keys.entries()) {
      if (row === column) continue;
      const difference = (rated.ratings[row] - rated.ratings[column]) * (Math.LN10 / 400);
      winMatrix[rowKey][columnKey] = 1 / (1 + Math.exp(-difference));
    }
  }
  const judged = usable.filter((battle) => battle.source === "judge" && battle.judge);
  return {
    standings,
    winMatrix,
    battleCounts,
    battles: usable.length,
    styleControlled: styleControl,
    ...(judged.length > 0 && {
      inconsistentJudgements: judged.filter((battle) => battle.judge && !battle.judge.consistent).length,
    }),
  };
}

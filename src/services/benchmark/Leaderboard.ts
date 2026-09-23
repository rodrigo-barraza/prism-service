/**
 * Leaderboard — every contestant's latest result on every suite, across
 * runs: a matrix of contestants × suites, each cell the most recent run
 * that evaluated that contestant (by key) on that suite, with its interval.
 * Read from the headline numbers each run stores when it ends (no samples
 * are loaded).
 */
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import type { Leaderboard } from "#src/types/benchmark";

export async function buildLeaderboard(project: string | null, { limit = 500 }: { limit?: number } = {}): Promise<Leaderboard> {
  const runs = await BenchmarkStore.listRuns(project, { limit });
  const suites = new Map<string, { id: string; name: string; runs: number }>();
  const contestants = new Map<string, Leaderboard["contestants"][number]>();
  const cells: Leaderboard["cells"] = {};
  // Newest first: the first result seen for a (suite, contestant) is its latest.
  for (const run of runs) {
    if (!run.results || (run.status !== "completed" && run.status !== "cancelled")) continue;
    for (const suite of run.suites) {
      const entry = suites.get(suite.id) ?? { id: suite.id, name: suite.name, runs: 0 };
      entry.runs++;
      suites.set(suite.id, entry);
    }
    for (const contestant of run.contestants) {
      const entry = contestants.get(contestant.key) ?? {
        key: contestant.key,
        label: contestant.label,
        kind: contestant.kind,
        provider: contestant.provider,
        model: contestant.model,
        agent: contestant.agent ?? null,
        runs: 0,
        lastRunAt: run.completedAt ?? run.createdAt,
      };
      entry.runs++;
      contestants.set(contestant.key, entry);
    }
    for (const [suiteId, results] of Object.entries(run.results.suites)) {
      cells[suiteId] ??= {};
      for (const [key, cell] of Object.entries(results)) {
        if (cells[suiteId][key]) continue;
        cells[suiteId][key] = { ...cell, runId: run.id, runName: run.name, completedAt: run.completedAt ?? null };
      }
    }
  }
  return {
    suites: [...suites.values()].sort((first, second) => second.runs - first.runs),
    contestants: [...contestants.values()],
    cells,
  };
}

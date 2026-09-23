/**
 * SweepRunner — a dataset across a matrix of harness settings.
 *
 * The matrix is the cartesian product of the axes given: models × effort ×
 * compaction threshold (the context window compaction triggers against) ×
 * tool discovery mode × topology. Each cell is one DatasetRunner run, cells
 * one after another. A cell is on the Pareto frontier when no other cell is
 * at least as cheap per run, as fast per run and as reliable (pass^k), and
 * better at one of them — the settings worth choosing between; the rest
 * cost more for less. `sweepStats` projects the cells onto the per-config
 * stats the client's cost-vs-accuracy chart already plots.
 */
import crypto from "crypto";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { BENCHMARK } from "#src/constants";
import { getTopologyById } from "#src/services/orchestrator/TopologyRegistry";
import { MINIMUM_CONTEXT_WINDOW_LIMIT } from "#src/services/compact/ContextBudgets";
import DatasetStore from "#src/services/benchmark/DatasetStore";
import { clampK, configKeyOf, runDataset } from "#src/services/benchmark/DatasetRunner";
import type {
  BenchmarkDataset,
  BenchmarkModelTarget,
  BenchmarkSweep,
  CaseTrialResult,
  HarnessSettings,
  SweepAxes,
  SweepCell,
  SweepCellResult,
  ToolDiscoveryMode,
} from "#src/types/benchmark";

export const TOOL_DISCOVERY_MODES: readonly ToolDiscoveryMode[] = ["preflight", "on_demand", "off"];

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** The axes' mistakes, or null. */
export function validateSweepAxes(axes: unknown): string | null {
  if (!axes || typeof axes !== "object") return "axes must be an object";
  const { models, effort, compactionThreshold, toolDiscovery, topology } = axes as Partial<SweepAxes>;
  if (!Array.isArray(models) || models.length === 0) return "axes.models needs at least one target";
  for (const [index, target] of models.entries()) {
    if (!target || !isNonEmptyString(target.provider) || !isNonEmptyString(target.model)) {
      return `axes.models[${index}] needs a provider and a model`;
    }
  }
  if (effort !== undefined && (!Array.isArray(effort) || !effort.every(isNonEmptyString))) {
    return "axes.effort must be a list of effort levels";
  }
  if (compactionThreshold !== undefined) {
    if (
      !Array.isArray(compactionThreshold) ||
      !compactionThreshold.every(
        (value) => Number.isInteger(value) && value >= MINIMUM_CONTEXT_WINDOW_LIMIT,
      )
    ) {
      return `axes.compactionThreshold must be token counts of at least ${MINIMUM_CONTEXT_WINDOW_LIMIT}`;
    }
  }
  if (
    toolDiscovery !== undefined &&
    (!Array.isArray(toolDiscovery) ||
      !toolDiscovery.every((mode) => TOOL_DISCOVERY_MODES.includes(mode)))
  ) {
    return `axes.toolDiscovery must list modes among: ${TOOL_DISCOVERY_MODES.join(", ")}`;
  }
  if (topology !== undefined) {
    if (!Array.isArray(topology) || !topology.every(isNonEmptyString)) {
      return "axes.topology must be a list of topology ids";
    }
    const unknown = topology.find((id) => !getTopologyById(id));
    if (unknown) return `Unknown topology: ${unknown}`;
  }
  const cells = buildSweepMatrix(axes as SweepAxes).length;
  if (cells > BENCHMARK.MAX_SWEEP_CELLS) {
    return `the axes expand to ${cells} configurations; a sweep holds at most ${BENCHMARK.MAX_SWEEP_CELLS}`;
  }
  return null;
}

const unique = <Value>(values: Value[] | undefined): Array<Value | undefined> => {
  const distinct = [...new Set(values ?? [])];
  return distinct.length > 0 ? distinct : [undefined];
};

function describeCell(target: BenchmarkModelTarget, settings: HarnessSettings): string {
  const parts = [target.display_name || target.label || target.model];
  if (target.agent) parts.push(target.agent);
  if (settings.effort !== undefined) parts.push(`effort ${settings.effort}`);
  if (settings.compactionThreshold !== undefined) {
    parts.push(`window ${Math.round(settings.compactionThreshold / 1000)}K`);
  }
  if (settings.toolDiscovery !== undefined) parts.push(`discovery ${settings.toolDiscovery}`);
  if (settings.topology !== undefined) parts.push(`topology ${settings.topology}`);
  return parts.join(" · ");
}

/** Every configuration the axes describe, in axis order. */
export function buildSweepMatrix(axes: SweepAxes): SweepCell[] {
  const cells: SweepCell[] = [];
  const seen = new Set<string>();
  for (const target of axes.models ?? []) {
    for (const effort of unique(axes.effort)) {
      for (const compactionThreshold of unique(axes.compactionThreshold)) {
        for (const toolDiscovery of unique(axes.toolDiscovery)) {
          for (const topology of unique(axes.topology)) {
            const settings: HarnessSettings = {
              ...(effort !== undefined && { effort }),
              ...(compactionThreshold !== undefined && { compactionThreshold }),
              ...(toolDiscovery !== undefined && { toolDiscovery }),
              ...(topology !== undefined && { topology }),
            };
            const config = { target, settings };
            const key = configKeyOf(config);
            if (seen.has(key)) continue;
            seen.add(key);
            cells.push({ key, label: describeCell(target, settings), config });
          }
        }
      }
    }
  }
  return cells;
}

/** Mark the cells no other cell beats on cost, latency and pass^k at once. */
export function markPareto(cells: SweepCellResult[]): SweepCellResult[] {
  const measured = cells.filter((cell) => cell.summary);
  for (const cell of cells) {
    if (!cell.summary) {
      cell.pareto = false;
      continue;
    }
    const own = cell.summary;
    cell.pareto = !measured.some((other) => {
      if (other === cell) return false;
      const theirs = other.summary!;
      const noWorse =
        theirs.meanCostPerTrial <= own.meanCostPerTrial &&
        theirs.meanLatency <= own.meanLatency &&
        theirs.passHatK >= own.passHatK;
      const better =
        theirs.meanCostPerTrial < own.meanCostPerTrial ||
        theirs.meanLatency < own.meanLatency ||
        theirs.passHatK > own.passHatK;
      return noWorse && better;
    });
  }
  return cells;
}

/**
 * The cells in the shape of the per-config benchmark stats (the client's
 * BenchmarkModelStat), so its cost-vs-accuracy Pareto chart plots a sweep.
 */
export function sweepStats(sweep: BenchmarkSweep) {
  return sweep.cells
    .filter((cell) => cell.summary)
    .map((cell) => {
      const summary = cell.summary!;
      const { target } = cell.config;
      return {
        key: cell.key,
        provider: target.provider,
        model: target.model,
        label: cell.label,
        agent: target.agent ?? null,
        thinkingEnabled: !!target.thinkingEnabled,
        toolsEnabled: !!target.toolsEnabled,
        settings: cell.config.settings,
        total: summary.trials,
        passed: summary.passedTrials,
        failed: summary.trials - summary.passedTrials - summary.erroredTrials,
        errored: summary.erroredTrials,
        passRate: summary.passRate,
        passAtK: summary.passAtK,
        passHatK: summary.passHatK,
        totalCost: summary.totalCost,
        runCount: summary.trials,
        avgLatency: summary.meanLatency,
        pareto: cell.pareto,
      };
    });
}

export interface SweepOptions {
  dataset: BenchmarkDataset;
  axes: SweepAxes;
  k?: number;
  name?: string;
  project: string | null;
  username: string;
  scheduleId?: string | null;
  signal?: AbortSignal;
  onCellStart?: (cell: SweepCell, index: number, total: number) => void;
  onCellComplete?: (cell: SweepCellResult, index: number, total: number) => void;
  onTrial?: (trial: CaseTrialResult, cell: SweepCell) => void;
}

/** Run the dataset once per cell, storing the sweep as it goes. */
export async function runSweep(options: SweepOptions): Promise<BenchmarkSweep> {
  const { dataset, signal } = options;
  const cells = buildSweepMatrix(options.axes);
  const k = clampK(options.k ?? dataset.k);
  const sweep: BenchmarkSweep = {
    id: crypto.randomUUID(),
    datasetId: dataset.id,
    datasetName: dataset.name,
    project: options.project,
    username: options.username,
    name: options.name || `${dataset.name} × ${cells.length} configuration${cells.length === 1 ? "" : "s"}`,
    axes: options.axes,
    k,
    cells: cells.map((cell) => ({ ...cell, runId: null, summary: null, pareto: false })),
    status: "running",
    scheduleId: options.scheduleId ?? null,
    regression: null,
    totalCost: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  await DatasetStore.insertSweep(sweep);
  for (const [index, cell] of cells.entries()) {
    if (signal?.aborted) break;
    options.onCellStart?.(cell, index, cells.length);
    try {
      const run = await runDataset({
        dataset,
        config: cell.config,
        k,
        project: options.project,
        username: options.username,
        signal,
        sweepId: sweep.id,
        scheduleId: options.scheduleId ?? null,
        configKey: cell.key,
        onTrial: (trial) => options.onTrial?.(trial, cell),
      });
      sweep.cells[index] = { ...sweep.cells[index], runId: run.id, summary: run.summary };
    } catch (error: unknown) {
      sweep.cells[index] = { ...sweep.cells[index], error: getErrorMessage(error) };
    }
    markPareto(sweep.cells);
    sweep.totalCost = sweep.cells.reduce((sum, done) => sum + (done.summary?.totalCost ?? 0), 0);
    await DatasetStore.updateSweep(sweep.id, { cells: sweep.cells, totalCost: sweep.totalCost });
    options.onCellComplete?.(sweep.cells[index], index, cells.length);
  }
  sweep.status = signal?.aborted ? "aborted" : "complete";
  sweep.completedAt = new Date().toISOString();
  await DatasetStore.updateSweep(sweep.id, {
    status: sweep.status,
    completedAt: sweep.completedAt,
    cells: sweep.cells,
    totalCost: sweep.totalCost,
  });
  return sweep;
}

/**
 * Benchmark Type Definitions
 *
 * Shared interfaces for BenchmarkService accuracy + behavior testing.
 */

// ── Match Modes ─────────────────────────────────────────────

export const MATCH_MODES = {
  CONTAINS: "contains",
  NOT_CONTAINS: "notContains",
  EXACT: "exact",
  STARTS_WITH: "startsWith",
  REGEX: "regex",
  JSON_VALID: "jsonValid",
  JSON_MATCH: "jsonMatch",
  NUMERIC_EQUALS: "numericEquals",
} as const;

export type MatchMode = (typeof MATCH_MODES)[keyof typeof MATCH_MODES];

// ── Assertions ──────────────────────────────────────────────

export interface TextAssertion {
  expectedValue: string;
  matchMode?: MatchMode;
}

export type ComparisonOperator = "gte" | "lte" | "gt" | "lt" | "eq";

/**
 * Behavioral assertion types:
 *   replied           — non-empty text response
 *   thought           — produced thinking/chain-of-thought content
 *   max_turns         — agentic loop turn count comparison
 *   used_tool_calls   — total tool call count comparison
 *   used_tool         — named tool called (count comparison, default ≥ 1)
 *   not_used_tool     — named tool never called (no toolName → NO tools at all)
 *   first_tool        — the first tool invoked is the named tool
 *   tool_sequence     — tools called in a given order (exact or in-order subsequence)
 *   tool_args_match   — a call's arguments (JSON) match expectedValue via matchMode
 *   tool_result_match — a call's result (stringified) matches expectedValue via matchMode
 *   tool_calls_ok     — no tool call ended in an error status
 *   llm_judge         — an LLM judge grades the response against a rubric
 */
export type AgentAssertionType =
  | "replied"
  | "thought"
  | "max_turns"
  | "used_tool_calls"
  | "used_tool"
  | "not_used_tool"
  | "first_tool"
  | "tool_sequence"
  | "tool_args_match"
  | "tool_result_match"
  | "tool_calls_ok"
  | "llm_judge";

export interface AgentAssertion {
  type: AgentAssertionType;
  operator?: ComparisonOperator;
  operand?: string | number;
  /** Tool-scoped assertions: the tool name to match (comma-separated list for tool_sequence). */
  toolName?: string;
  /** For tool_sequence: require the exact full order (default: in-order subsequence). */
  exactOrder?: boolean;
  /** For tool_args_match / tool_result_match: value + mode applied to the stringified payload. */
  expectedValue?: string;
  matchMode?: MatchMode;
  /** For llm_judge: the grading rubric. */
  rubric?: string;
  /** For llm_judge: optional "provider:model" override for the judge. */
  judgeModel?: string;
}

// ── Per-assertion evaluation detail ─────────────────────────

export interface JudgeVerdict {
  passed: boolean;
  score?: number;
  reasoning?: string;
  model?: string;
  provider?: string;
  cost?: number;
  error?: string;
}

export interface AssertionResult {
  kind: "text" | "behavior";
  /** Human-readable summary, e.g. `contains "Paris"` or `used_tool search_web ≥ 1`. */
  label: string;
  passed: boolean;
  /** Observed value (matched text, call count, judge verdict…) for display. */
  actual?: string;
  /** Evaluation error (invalid regex, judge failure…). */
  error?: string;
  judge?: JudgeVerdict;
}

// ── Benchmark Definition ────────────────────────────────────

export interface BenchmarkDefinition {
  id: string;
  project: string;
  username: string;
  name: string;
  prompt: string;
  systemPrompt?: string | null;
  expectedValue?: string;
  matchMode?: MatchMode;
  benchmarkMode?: "model" | "agent" | "combined";
  assertions?: TextAssertion[];
  assertionOperator?: "AND" | "OR";
  agentAssertions?: AgentAssertion[];
  agentAssertionOperator?: "AND" | "OR";
  /** Tools exposed to targets that run with tools enabled. */
  enabledTools?: string[];
  /** Default number of repeated executions per target (1–MAX_TRIALS). */
  trials?: number;
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Model Target ────────────────────────────────────────────

export interface BenchmarkModelTarget {
  provider: string;
  model: string;
  label?: string;
  display_name?: string;
  thinkingEnabled?: boolean;
  toolsEnabled?: boolean;
  agent?: string;
  locale?: string;
  enabledTools?: string[];
}

export interface ResolvedBenchmarkModel extends BenchmarkModelTarget {
  label: string;
}

// ── Model Result ────────────────────────────────────────────

export interface BenchmarkModelResult {
  provider: string;
  model: string;
  label: string;
  thinkingEnabled: boolean;
  toolsEnabled: boolean;
  agent?: string;
  response: string | null;
  thinking: string | null;
  toolCalls?: BenchmarkToolCall[] | null;
  toolNames?: string[];
  passed: boolean;
  matchMode: MatchMode;
  assertionResults?: AssertionResult[];
  turnCount?: number;
  /** Trial index (1-based) when a target runs multiple times. */
  trial?: number;
  /** Total trials for this target in the run. */
  trialCount?: number;
  /** Wall-clock seconds from request start to finish. */
  latency: number;
  /** Milliseconds until the first streamed content (chunk/thinking/tool event). */
  ttftMs?: number | null;
  /** Server-measured generation throughput (output tokens per second). */
  tokensPerSecond?: number | null;
  usage: Record<string, number> | null;
  estimatedCost: number | null;
  /** LLM-judge spend for this result (already included in run summary totalCost). */
  judgeCost?: number;
  error: string | null;
  completedAt: string;
}

export interface BenchmarkToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status: string;
}

// ── Run ─────────────────────────────────────────────────────

export interface BenchmarkRun {
  id: string;
  benchmarkId: string;
  project: string;
  models: BenchmarkModelResult[];
  aborted: boolean;
  summary: BenchmarkRunSummary;
  startedAt: string;
  completedAt: string;
}

export interface BenchmarkRunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  totalCost: number;
}

// ── Execution Data (for behavioral assertions) ──────────────

export interface BenchmarkExecutionData {
  response: string | null;
  thinking: string | null;
  toolCalls: BenchmarkToolCall[];
  turnCount: number;
}

// ── Callbacks ───────────────────────────────────────────────

export interface BenchmarkRunCallbacks {
  onRunStart?: (info: { totalModels: number }) => void;
  onModelStart?: (model: ResolvedBenchmarkModel & { isLocal: boolean }) => void;
  onModelComplete?: (result: BenchmarkModelResult) => void;
  onEvent?: (event: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

// ── Streaming Event ─────────────────────────────────────────

export interface BenchmarkStreamEvent {
  type: string;
  content?: string;
  message?: string;
  usage?: Record<string, number>;
  estimatedCost?: number;
  status?: string;
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  tool?: {
    id?: string;
    name?: string;
    args?: unknown;
    result?: unknown;
  };
  _sourceModel?: {
    provider: string;
    model: string;
  };
}

// ── Comparator Function ─────────────────────────────────────

export type ComparatorFn = (agent: number, b: number) => boolean;

export const COMPARATORS: Record<ComparisonOperator, ComparatorFn> = {
  gte: (agent, b) => agent >= b,
  lte: (agent, b) => agent <= b,
  gt: (agent, b) => agent > b,
  lt: (agent, b) => agent < b,
  eq: (agent, b) => agent === b,
};

// ── Datasets, reliability and sweeps ────────────────────────
//
// A dataset is many prompts (cases), each graded by its own graders, run
// k times per case under one configuration — a target model and harness
// settings. pass@k and pass^k summarise the k runs (ReliabilityMetrics);
// a sweep runs the dataset once per cell of a settings matrix; a scheduled
// sweep compares itself with the previous one (BenchmarkRegression).

/**
 * How a dataset case is graded. Every grader must pass for a run to pass.
 *   regex         — the reply (or the thinking) matches a pattern
 *   tool_used     — a tool was called between min and max times, optionally
 *                   with arguments matching a pattern
 *   tool_sequence — tools were called in this order (gaps allowed unless exactOrder)
 *   file_exists   — a file exists in the case's scratch workspace afterwards,
 *                   optionally with content matching a pattern
 *   llm_rubric    — an LLM judge grades the reply against a rubric
 *   baseline      — an LLM judge compares the reply with a reference answer;
 *                   passes when the reply is at least as good
 */
export type DatasetGrader =
  | {
      type: "regex";
      pattern: string;
      flags?: string;
      target?: "response" | "thinking";
      /** Pass when the pattern does NOT match. */
      negate?: boolean;
    }
  | {
      type: "tool_used";
      tool: string;
      /** Minimum calls (default 1). `max: 0` asserts the tool was never called. */
      min?: number;
      max?: number;
      /** A pattern at least one call's JSON arguments must match. */
      argsMatch?: string;
    }
  | { type: "tool_sequence"; tools: string[]; exactOrder?: boolean }
  | {
      type: "file_exists";
      /** Relative to the scratch workspace; a glob (`*`, `**`, `?`) matches any file. */
      path: string;
      /** A pattern some matching file's text must match, line-wise (`^`/`$` at line breaks). */
      contentMatch?: string;
    }
  | { type: "llm_rubric"; rubric: string; judgeModel?: string }
  | {
      type: "baseline";
      /** The reference answer the reply is compared with. */
      reference: string;
      /** What "better" means for this case (default: correctness and completeness). */
      criteria?: string;
      judgeModel?: string;
    };

export type DatasetGraderType = DatasetGrader["type"];

export interface DatasetCase {
  id: string;
  name?: string;
  prompt: string;
  systemPrompt?: string | null;
  graders: DatasetGrader[];
  /** Files written into the case's scratch workspace before each run (path → content). */
  files?: Record<string, string>;
  tags?: string[];
}

export interface BenchmarkDataset {
  id: string;
  project: string | null;
  username: string;
  name: string;
  description?: string;
  cases: DatasetCase[];
  /** The agent persona every case runs as (null: the model alone, no tools). */
  agent?: string | null;
  /** Tools every case runs with (default: the persona's). */
  enabledTools?: string[];
  /** Runs per case — the k of pass@k and pass^k. */
  k: number;
  temperature?: number;
  maxTokens?: number;
  /**
   * A tools-service workspace root the scratch workspaces are made under
   * (cases with files or a file_exists grader). Default: its first root.
   */
  workspaceRoot?: string | null;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export type ToolDiscoveryMode = "preflight" | "on_demand" | "off";

/** Harness settings a run pins (unset: the service's own defaults). */
export interface HarnessSettings {
  /** reasoningEffort / thinkingLevel. */
  effort?: string;
  /**
   * The context window compaction triggers against (`contextWindowLimit`,
   * tokens): lower means earlier compaction.
   */
  compactionThreshold?: number;
  /**
   * preflight — tools matching the prompt are enabled before the first call;
   * on_demand — only when the model calls discover_and_enable_tools;
   * off — no activation beyond the resolved tool set.
   */
  toolDiscovery?: ToolDiscoveryMode;
  /** Multi-agent topology id (TopologyRegistry). */
  topology?: string;
}

/** One configuration a dataset runs under. */
export interface BenchmarkRunConfig {
  target: BenchmarkModelTarget;
  settings: HarnessSettings;
}

export interface GraderResult {
  type: DatasetGraderType;
  label: string;
  passed: boolean;
  actual?: string;
  error?: string;
  judge?: JudgeVerdict;
  /** A judge not paid for: a deterministic grader had already failed the run. */
  skipped?: boolean;
}

/** One run (trial) of one case. */
export interface CaseTrialResult {
  caseId: string;
  /** 1-based. */
  trial: number;
  passed: boolean;
  graderResults: GraderResult[];
  response: string | null;
  toolNames: string[];
  turnCount: number;
  /** Seconds. */
  latency: number;
  usage: Record<string, number> | null;
  /** The run's own cost plus its judges'. */
  cost: number;
  judgeCost?: number;
  error: string | null;
}

/** pass@k / pass^k of one case over its n runs, c of which passed. */
export interface CaseReliability {
  caseId: string;
  name?: string;
  trials: number;
  passed: number;
  errored: number;
  passAtK: number;
  passHatK: number;
}

export interface ReliabilitySummary {
  /** The k pass@k and pass^k are reported at. */
  k: number;
  cases: number;
  trials: number;
  passedTrials: number;
  erroredTrials: number;
  /** Passed runs over all runs. */
  passRate: number;
  /** Mean over cases: at least one of k runs passes. */
  passAtK: number;
  /** Mean over cases: all k runs pass (τ-bench's pass^k). */
  passHatK: number;
  totalCost: number;
  meanCostPerTrial: number;
  /** Seconds per run. */
  meanLatency: number;
  p50Latency: number;
  p95Latency: number;
}

export interface DatasetRun {
  id: string;
  datasetId: string;
  datasetName: string;
  project: string | null;
  config: BenchmarkRunConfig;
  /** Stable id of the configuration (the sweep cell it ran as). */
  configKey: string;
  k: number;
  trials: CaseTrialResult[];
  cases: CaseReliability[];
  summary: ReliabilitySummary;
  aborted: boolean;
  sweepId?: string | null;
  scheduleId?: string | null;
  startedAt: string;
  completedAt: string;
}

/** A matrix of configurations: the cartesian product of every axis given. */
export interface SweepAxes {
  models: BenchmarkModelTarget[];
  effort?: string[];
  compactionThreshold?: number[];
  toolDiscovery?: ToolDiscoveryMode[];
  topology?: string[];
}

export interface SweepCell {
  /** Stable across sweeps: the configuration itself, spelled out. */
  key: string;
  label: string;
  config: BenchmarkRunConfig;
}

export interface SweepCellResult extends SweepCell {
  runId: string | null;
  summary: ReliabilitySummary | null;
  /** No other cell is at least as cheap, as fast and as reliable (pass^k), and better at one. */
  pareto: boolean;
  error?: string;
}

export interface BenchmarkSweep {
  id: string;
  datasetId: string;
  datasetName: string;
  project: string | null;
  username: string;
  name: string;
  axes: SweepAxes;
  k: number;
  cells: SweepCellResult[];
  status: "running" | "complete" | "aborted" | "failed";
  scheduleId?: string | null;
  /** Set on a scheduled sweep: what changed against the previous one. */
  regression?: RegressionReport | null;
  totalCost: number;
  startedAt: string;
  completedAt: string | null;
}

export type ReliabilityMetric = "passHatK" | "passAtK" | "passRate";

/** What a scheduled sweep runs and when it alerts. */
export interface ScheduledBenchmarkConfig {
  datasetId: string;
  axes: SweepAxes;
  /** Default: the dataset's k. */
  k?: number;
  /** The metric compared with the previous run (default passHatK). */
  metric?: ReliabilityMetric;
  /** A drop of more than this (absolute, 0–1) is a regression (default 0.1). */
  threshold?: number;
  /** Where a regression is announced: the benchmark.regression webhook event and/or ntfy. */
  alert?: { webhook?: boolean; ntfyTopic?: string | null };
}

export interface CellRegression {
  key: string;
  label: string;
  baseline: number;
  current: number;
  drop: number;
  /** Cases that passed every run last time and no longer do. */
  casesLost: string[];
}

export interface RegressionReport {
  metric: ReliabilityMetric;
  threshold: number;
  baselineSweepId: string | null;
  regressed: boolean;
  cells: CellRegression[];
  alerted: { webhook: boolean; ntfy: boolean };
}

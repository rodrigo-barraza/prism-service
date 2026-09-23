/**
 * Benchmarks — the shared vocabulary of the evaluation system.
 *
 * A SUITE is a set of cases, each graded by scorers. A RUN evaluates one
 * or more suites against CONTESTANTS (a raw model, a model with tools, or
 * a Prism agent with its harness settings), `epochs` times per case; every
 * (suite, case, contestant, epoch) is one SAMPLE. A run's REPORT is
 * computed from its samples: scores with confidence intervals, paired
 * comparisons between contestants, pass@k / pass^k, cost and latency.
 * BATTLES are pairwise preferences between two contestants' answers to
 * the same prompt — from an LLM judge or a person voting blind — and the
 * ARENA fits Bradley–Terry ratings over them. docs/benchmarks.md.
 */

// ── Contestants ─────────────────────────────────────────────

export type ContestantKind = "model" | "agent";

export type ToolDiscoveryMode = "preflight" | "on_demand" | "off";

/** The agent harness knobs a contestant pins (unset: the service's defaults). */
export interface HarnessKnobs {
  /** Agentic loop iterations at most. */
  maxIterations?: number | null;
  /** preflight: tools matching the prompt enabled up front; on_demand: only via discover_and_enable_tools; off: none. */
  toolDiscovery?: ToolDiscoveryMode | null;
  /** The context window compaction triggers against (tokens, ≥ 8192). */
  compactionThreshold?: number | null;
  /** Multi-agent topology id (GET /topologies). */
  topology?: string | null;
  /** Reasoning structure (e.g. tree_of_thoughts). */
  thoughtStructure?: string | null;
}

/**
 * What is evaluated. Two specs that spell the same configuration have the
 * same `key`, so results aggregate across runs (the leaderboard, history).
 */
export interface ContestantSpec {
  kind: ContestantKind;
  provider: string;
  model: string;
  /** Display name (default: derived from the model and the settings). */
  label?: string | null;
  /** kind "agent": a persona id (CODING, OMNI…) or a custom agent id. */
  agent?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  seed?: number | null;
  /** Reasoning effort; "none" turns thinking off. Unset: the model's default. */
  effort?: string | null;
  /** Prepended to every case's system prompt — a prompt variant under test. */
  systemPrompt?: string | null;
  /**
   * "suite": the suite's tool policy; "none": no tools; a list: exactly
   * those tools (a model contestant with a list runs with function calling).
   */
  tools?: "suite" | "none" | string[] | null;
  harness?: HarnessKnobs | null;
  webSearch?: boolean | null;
}

export interface Contestant extends ContestantSpec {
  key: string;
  label: string;
}

/** A saved set of contestants ("my usual agents", "frontier models"). */
export interface ContestantLineup {
  id: string;
  project: string | null;
  username: string;
  name: string;
  contestants: ContestantSpec[];
  createdAt: string;
  updatedAt: string;
}

// ── Scorers ─────────────────────────────────────────────────

interface ScorerCommon {
  /** Shown in reports (default: derived from the spec). */
  label?: string | null;
  /** Weight in the sample's score (default 1). */
  weight?: number | null;
  /** A required scorer must pass for the sample to pass (default true). */
  required?: boolean | null;
  /** Model-graded scorers: "provider:model" judge(s) instead of the run's. */
  judges?: string[] | null;
}

/**
 * How one sample is graded. Deterministic scorers read the answer, the
 * thinking, the tool trace or the scratch workspace; model-graded ones ask
 * the run's judge(s). Every scorer yields a value in [0, 1] and a pass.
 */
export type ScorerSpec = ScorerCommon &
  (
    | { type: "exact"; ignoreCase?: boolean | null }
    | { type: "includes"; ignoreCase?: boolean | null; all?: boolean | null }
    | {
        type: "regex";
        pattern: string;
        flags?: string | null;
        negate?: boolean | null;
        source?: "output" | "thinking" | null;
      }
    | { type: "numeric"; tolerance?: number | null }
    | { type: "choice" }
    | { type: "math"; judgeFallback?: boolean | null }
    | {
        type: "json";
        requiredKeys?: string[] | null;
        match?: Record<string, unknown> | null;
      }
    | { type: "ifeval"; mode?: "strict" | "loose" | null }
    | {
        type: "length";
        unit: "words" | "characters" | "sentences" | "paragraphs";
        min?: number | null;
        max?: number | null;
      }
    | {
        type: "tool_called";
        tool: string;
        min?: number | null;
        max?: number | null;
        argsMatch?: string | null;
      }
    | { type: "tool_sequence"; tools: string[]; exactOrder?: boolean | null }
    | { type: "no_tool_errors" }
    | {
        type: "file";
        path: string;
        contentMatch?: string | null;
        absent?: boolean | null;
      }
    | {
        type: "command";
        command: string;
        timeoutSeconds?: number | null;
        expectExitCode?: number | null;
        outputMatch?: string | null;
      }
    | {
        /** The reply's code plus a test program, run in the sample's workspace: passes on exit 0. */
        type: "code_tests";
        language?: "python" | "javascript" | null;
        /** Appended after the code (default: the case's metadata.testProgram). */
        tests?: string | null;
        timeoutSeconds?: number | null;
      }
    | {
        type: "efficiency";
        maxTurns?: number | null;
        maxToolCalls?: number | null;
        maxCostUsd?: number | null;
        maxSeconds?: number | null;
      }
    | { type: "rubric"; rubric: string; passThreshold?: number | null }
    | {
        type: "checklist";
        items: Array<{ criterion: string; points: number }>;
        passThreshold?: number | null;
      }
    | { type: "reference" }
    | { type: "pairwise_reference"; criteria?: string | null }
  );

export type ScorerType = ScorerSpec["type"];

export const MODEL_GRADED_SCORERS: ReadonlySet<ScorerType> = new Set([
  "rubric",
  "checklist",
  "reference",
  "pairwise_reference",
]);

// ── Suites ──────────────────────────────────────────────────

export interface CaseMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SuiteCase {
  /** Stable within the suite. */
  id: string;
  /** The user's message, or a conversation that ends on a user turn. */
  input: string | CaseMessage[];
  systemPrompt?: string | null;
  /** Reference answer(s). exact / includes / numeric / choice / math compare against it; judges see it. */
  target?: string | string[] | null;
  /** Replaces the suite's scorers for this case. */
  scorers?: ScorerSpec[] | null;
  /** Written into the sample's scratch workspace before the run (path → text). */
  files?: Record<string, string> | null;
  /** Written after the run, before scoring — hidden tests the contestant never saw. */
  hiddenFiles?: Record<string, string> | null;
  /** Categories: the report breaks scores down by tag. */
  tags?: string[] | null;
  /** Scorer inputs that are not the target (IFEval instructions, …). */
  metadata?: Record<string, unknown> | null;
}

export type SuiteToolPolicy =
  | { mode: "none" }
  | { mode: "agent" }
  | { mode: "list"; tools: string[] };

export interface SuiteSource {
  kind: "builtin" | "custom" | "import";
  /** The catalog entry an import came from, or the built-in's id. */
  ref?: string | null;
  url?: string | null;
  license?: string | null;
  /** Import: rows available / taken, and the seed that picked them. */
  totalRows?: number | null;
  sampledRows?: number | null;
  seed?: number | null;
  split?: string | null;
}

export interface BenchmarkSuite {
  id: string;
  project: string | null;
  username: string;
  name: string;
  description?: string | null;
  source: SuiteSource;
  tags: string[];
  /** Every case's scorers unless the case names its own. */
  scorers: ScorerSpec[];
  /** Every case's system prompt unless the case names its own. */
  systemPrompt?: string | null;
  tools: SuiteToolPolicy;
  /** Each sample runs in a fresh scratch workspace (agent file tools). */
  workspace: boolean;
  /** Per-suite ceilings; a contestant's own settings win when lower. */
  limits?: {
    maxIterations?: number | null;
    maxTokens?: number | null;
    timeoutSeconds?: number | null;
  } | null;
  cases: SuiteCase[];
  /** Bumped on every edit; a run records the version it evaluated. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type SuiteSummary = Omit<BenchmarkSuite, "cases"> & {
  caseCount: number;
  caseTags: string[];
};

/** A public benchmark the service can import (sampled) from Hugging Face. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  url: string;
  license: string;
  /** Rows in the split the importer reads. */
  totalRows: number | null;
  /** What a quick run should take. */
  suggestedSample: number;
  scorer: ScorerType;
  /** Needs a Hugging Face token (gated dataset). */
  gated?: boolean;
  /** A gated entry: whether the service has a token for it. */
  available?: boolean;
  /** Needs judge calls to grade. */
  judged?: boolean;
  requiresTools?: boolean;
}

// ── Runs ────────────────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "judging"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type PairwiseMode = "off" | "all_pairs" | "vs_baseline";

export interface RunSettings {
  /** Samples per case per contestant — the k of pass@k and pass^k. */
  epochs: number;
  /** Cases per suite at most (null: all), drawn with `sampleSeed`. */
  sampleLimit?: number | null;
  sampleSeed?: number | null;
  /** "provider:model" — the default judge(s) of model-graded scorers; several = a panel. */
  judges: string[];
  /** Samples in flight at once. */
  concurrency: number;
  /** Samples in flight per provider. */
  providerConcurrency: number;
  /** Stop starting samples once spend reaches this (USD). */
  budgetUsd?: number | null;
  /** Attempts per sample on infrastructure errors (provider/timeouts), ≥ 1. */
  maxAttempts: number;
  /** Per-sample wall clock (seconds). */
  timeoutSeconds: number;
  /** After the samples, judge the contestants' answers head to head. */
  pairwise: {
    mode: PairwiseMode;
    baselineKey?: string | null;
    judges?: string[] | null;
  };
}

/** The suite as the run evaluated it (edits after the run do not change it). */
export interface RunSuite {
  id: string;
  name: string;
  version: number;
  source: SuiteSource;
  scorers: ScorerSpec[];
  systemPrompt?: string | null;
  tools: SuiteToolPolicy;
  workspace: boolean;
  limits?: BenchmarkSuite["limits"];
  cases: SuiteCase[];
  /** Cases in the suite when the run began (≥ cases.length when sampled). */
  totalCases: number;
}

export interface RunProgress {
  total: number;
  done: number;
  errored: number;
  running: number;
  cost: number;
  judgeCost: number;
  battlesTotal: number;
  battlesDone: number;
  /** A regrade in progress: samples re-scored so far. */
  regradeTotal?: number;
  regradeDone?: number;
}

export interface BenchmarkRun {
  id: string;
  project: string | null;
  username: string;
  name: string;
  notes?: string | null;
  status: RunStatus;
  /** Why the run stopped early (budget, cancel, a failure). */
  statusReason?: string | null;
  suites: RunSuite[];
  contestants: Contestant[];
  settings: RunSettings;
  progress: RunProgress;
  scheduleId?: string | null;
  /** The run a scheduled run is compared with. */
  baselineRunId?: string | null;
  regression?: RegressionReport | null;
  /** Headline numbers, stored when the run ends (lists and the leaderboard read these). */
  results?: RunResults | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ResultCell {
  label: string;
  mean: number;
  low: number;
  high: number;
  cases: number;
  samples: number;
  cost: number;
  meanLatencyMs: number;
}

export interface RunResults {
  /** suiteId → contestantKey → result. */
  suites: Record<string, Record<string, ResultCell>>;
  /** contestantKey → macro average over the run's suites. */
  overall: Record<string, ResultCell>;
  leader: { key: string; label: string; mean: number } | null;
}

export type RunListItem = Omit<BenchmarkRun, "suites"> & {
  suites: Array<Pick<RunSuite, "id" | "name" | "version" | "totalCases"> & { caseCount: number }>;
};

// ── Samples ─────────────────────────────────────────────────

export type SampleStatus = "pending" | "running" | "done" | "error" | "cancelled";

/**
 * The contestant's own failures — refusal (the model declined), timeout
 * (no answer in the sample's wall clock) — always score 0. Infrastructure
 * failures — provider (the API failed after retries), harness (Prism
 * failed around the model), workspace (no scratch workspace) — score 0
 * under the "fail" policy and are left out under "exclude".
 * cancelled/budget: the run stopped before the sample ran; never scored.
 */
export type SampleErrorKind =
  | "refusal"
  | "timeout"
  | "provider"
  | "harness"
  | "workspace"
  | "cancelled"
  | "budget";

export const CONTESTANT_FAULTS: ReadonlySet<SampleErrorKind> = new Set(["refusal", "timeout"]);
export const NOT_RUN: ReadonlySet<SampleErrorKind> = new Set(["cancelled", "budget"]);

/** A person's verdict on a sample, replacing the scorers' pass (and score). */
export interface SampleOverride {
  passed: boolean;
  note?: string | null;
  by: string;
  at: string;
}

export interface SampleError {
  kind: SampleErrorKind;
  message: string;
  retryable: boolean;
}

export interface SampleToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status: string;
}

export interface SampleOutput {
  text: string;
  thinking?: string | null;
  toolCalls: SampleToolCall[];
  turns: number;
}

export interface SampleUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface JudgeVote {
  provider: string;
  model: string;
  value: number;
  passed: boolean;
  verdict?: string | null;
  reasoning?: string | null;
  cost?: number;
  error?: string | null;
}

export interface ScoreResult {
  /** Index of the scorer in the case's scorer list. */
  index: number;
  type: ScorerType;
  label: string;
  value: number;
  passed: boolean;
  required: boolean;
  weight: number;
  /** What the scorer read as the answer (choice letter, number, boxed expression…). */
  answer?: string | null;
  expected?: string | null;
  explanation?: string | null;
  judges?: JudgeVote[] | null;
  error?: string | null;
  /** A judge not paid for: a required deterministic scorer had already failed. */
  skipped?: boolean;
  cost?: number;
}

export interface BenchmarkSample {
  id: string;
  runId: string;
  project: string | null;
  suiteId: string;
  caseId: string;
  contestantKey: string;
  /** 1-based. */
  epoch: number;
  status: SampleStatus;
  output: SampleOutput | null;
  /** output.toolCalls.length — kept apart so reports need not load the trace. */
  toolCallCount?: number;
  scores: ScoreResult[];
  /** Weighted mean of the scorer values (null until scored). */
  score: number | null;
  /** Every required scorer passed (null until scored). */
  passed: boolean | null;
  usage: SampleUsage | null;
  /** The contestant's own spend (USD). */
  cost: number;
  judgeCost: number;
  latencyMs: number | null;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  error: SampleError | null;
  attempts: number;
  /** Set when a person graded the sample by hand. */
  override?: SampleOverride | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

// ── Reports ─────────────────────────────────────────────────

export interface Interval {
  low: number;
  high: number;
}

export interface ContestantSummary {
  key: string;
  label: string;
  /** Cases with at least one scored sample. */
  cases: number;
  samples: number;
  errored: number;
  /** Mean over cases of the mean score over epochs. */
  mean: number;
  /** Standard error, clustered by case. */
  se: number;
  ci: Interval;
  /** Scored samples that passed. */
  passRate: number;
  /** epochs > 1: at least one of k passes / all k pass (means over cases). */
  passAtK: number | null;
  passHatK: number | null;
  /** pass@k and pass^k for k = 1…epochs (the reliability curve). */
  passCurve: Array<{ k: number; passAt: number; passHat: number }>;
  /** Cases whose epochs all agree (pass or fail). */
  consistency: number | null;
  /** Cases that passed some epochs and failed others. */
  flakyCases: number;
  rank: number;
  /** Best and worst rank the paired comparisons allow. */
  rankRange: [number, number];
  cost: {
    total: number;
    perSample: number;
    judge: number;
    /** Contestant spend per passed sample (null when none passed). */
    perPass: number | null;
  };
  latency: { meanMs: number; p50Ms: number; p95Ms: number };
  ttftMs: number | null;
  tokensPerSecond: number | null;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number };
  meanTurns: number;
  meanToolCalls: number;
  errors: Partial<Record<SampleErrorKind, number>>;
}

export interface PairwiseComparison {
  a: string;
  b: string;
  /** Cases both contestants were scored on. */
  n: number;
  /** mean(a) − mean(b) over the shared cases. */
  diff: number;
  se: number;
  ci: Interval;
  pValue: number;
  /** Holm-adjusted over every pair of the suite. */
  pAdjusted: number;
  significant: boolean;
  /** McNemar (binary scores), sign-flip permutation (partial credit). */
  test: "mcnemar" | "permutation" | "none";
  /** Cases where a scored higher / equal / lower. */
  wins: number;
  ties: number;
  losses: number;
  /** Smallest difference this many cases detects (80 % power, α 0.05). */
  mde: number;
  /** Correlation of the per-case scores (what the pairing buys). */
  correlation: number | null;
}

export interface TagBreakdown {
  tag: string;
  cases: number;
  means: Record<string, number>;
}

export interface CaseRow {
  caseId: string;
  tags: string[];
  input: string;
  /** Mean score per contestant key (null: not scored). */
  scores: Record<string, number | null>;
  /** Passed epochs / scored epochs per contestant key. */
  passes: Record<string, [number, number]>;
  /** Spread of the contestants' means: high = the case separates them. */
  discrimination: number;
}

export interface SuiteHealth {
  /** Cases every contestant passed every epoch — they no longer separate anyone. */
  saturated: number;
  /** Cases no contestant passed in any epoch — too hard, or a broken case/scorer. */
  unsolved: number;
  /** Cases where the contestants' means differ. */
  discriminating: number;
  /** Signal-to-noise: the spread of contestant means over their mean standard error. */
  signalToNoise: number | null;
}

export interface JudgeAgreement {
  /** Samples a person graded that a judge also graded. */
  compared: number;
  agreed: number;
  /** Cohen's κ between the judge's pass and the person's. */
  kappa: number | null;
}

export interface SuiteReport {
  suiteId: string;
  name: string;
  cases: number;
  summaries: ContestantSummary[];
  pairwise: PairwiseComparison[];
  tags: TagBreakdown[];
  caseRows: CaseRow[];
  health: SuiteHealth;
}

export interface ArenaStanding {
  key: string;
  label: string;
  /** Bradley–Terry rating on the Elo scale (mean 1000). */
  rating: number;
  ci: Interval;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  rank: number;
  rankRange: [number, number];
}

export interface ArenaReport {
  standings: ArenaStanding[];
  /** Predicted P(row beats column) from the fitted ratings. */
  winMatrix: Record<string, Record<string, number>>;
  /** Observed battles per pair. */
  battleCounts: Record<string, Record<string, number>>;
  battles: number;
  styleControlled: boolean;
  /** Judge battles whose two orders disagreed (a position-bias estimate). */
  inconsistentJudgements?: number;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  generatedAt: string;
  /** "fail": an errored sample scores 0; "exclude": it is left out. */
  errorPolicy: "fail" | "exclude";
  overall: ContestantSummary[];
  suites: SuiteReport[];
  pareto: { cost: string[]; latency: string[] };
  arena: ArenaReport | null;
  /** How often the judges agreed with the samples a person graded. */
  judgeAgreement: JudgeAgreement | null;
  judgeCost: number;
  totalCost: number;
}

// ── Leaderboard (across runs) ───────────────────────────────

export interface LeaderboardCell extends ResultCell {
  runId: string;
  runName: string;
  completedAt: string | null;
}

/** The latest result of every contestant on every suite, across runs. */
export interface Leaderboard {
  suites: Array<{ id: string; name: string; runs: number }>;
  contestants: Array<Pick<Contestant, "key" | "label" | "kind" | "provider" | "model" | "agent"> & { runs: number; lastRunAt: string | null }>;
  /** suiteId → contestantKey → its latest result. */
  cells: Record<string, Record<string, LeaderboardCell>>;
}

// ── Battles (pairwise preferences) ──────────────────────────

export type BattleWinner = "a" | "b" | "tie" | "both_bad";

export interface BattleSide {
  contestantKey: string;
  label: string;
  sampleId?: string | null;
  output: string;
}

export interface BattleStyle {
  /** Characters, markdown headers, list items, bold spans per side. */
  length: [number, number];
  headers: [number, number];
  lists: [number, number];
  bold: [number, number];
}

export interface Battle {
  id: string;
  project: string | null;
  username: string;
  source: "judge" | "human";
  runId?: string | null;
  suiteId?: string | null;
  caseId?: string | null;
  epoch?: number | null;
  /** The prompt both sides answered (for display). */
  prompt: string;
  a: BattleSide;
  b: BattleSide;
  winner: BattleWinner;
  judge?: {
    votes: Array<{ provider: string; model: string; winner: BattleWinner | null; consistent: boolean; reasoning?: string | null; cost?: number; error?: string | null }>;
    consistent: boolean;
  } | null;
  style: BattleStyle;
  category?: string | null;
  createdAt: string;
}

// ── Cost estimates ──────────────────────────────────────────

export interface CostEstimate {
  samples: number;
  battles: number;
  cases: number;
  /** USD, low and high, per contestant key and in total. */
  perContestant: Record<string, { label: string; low: number; high: number; basis: "history" | "pricing" | "unknown" }>;
  judge: { low: number; high: number };
  total: { low: number; high: number };
  /**
   * The smallest difference between two contestants this many cases can
   * detect (paired, 80 % power, α 0.05, assuming ~70 % accuracy and
   * ρ 0.5 between contestants) — what "significant" can mean here.
   */
  detectableDifference: number | null;
  /** Rough wall-clock minutes at the run's concurrency. */
  minutes: { low: number; high: number } | null;
  warnings: string[];
}

// ── Scheduled runs and regressions ──────────────────────────

export interface ScheduledBenchmarkConfig {
  name: string;
  suiteIds: string[];
  contestants: ContestantSpec[];
  settings: Partial<RunSettings>;
  /** A contestant's suite mean that drops by more than this (0–1), significantly, has regressed. */
  threshold?: number | null;
  alert?: { webhook?: boolean | null; ntfyTopic?: string | null } | null;
}

export interface Regression {
  suiteId: string;
  suiteName: string;
  contestantKey: string;
  label: string;
  baseline: number;
  current: number;
  diff: number;
  ci: Interval;
  pValue: number;
  /** Cases that passed every epoch last time and no longer do. */
  casesLost: string[];
}

export interface RegressionReport {
  baselineRunId: string | null;
  threshold: number;
  regressed: boolean;
  regressions: Regression[];
  alerted: { webhook: boolean; ntfy: boolean };
}

// ── Run comparison (A/B of two runs) ────────────────────────

export interface RunComparisonCase {
  suiteId: string;
  caseId: string;
  input: string;
  contestantKey: string;
  base: number | null;
  head: number | null;
  change: "improved" | "regressed" | "unchanged" | "new" | "missing";
}

export interface RunComparison {
  base: { id: string; name: string; completedAt?: string | null };
  head: { id: string; name: string; completedAt?: string | null };
  /** Per contestant present in both runs, per shared suite. */
  deltas: Array<{
    suiteId: string;
    suiteName: string;
    contestantKey: string;
    label: string;
    base: number;
    head: number;
    diff: number;
    ci: Interval;
    pValue: number;
    significant: boolean;
    improved: number;
    regressed: number;
  }>;
  cases: RunComparisonCase[];
}

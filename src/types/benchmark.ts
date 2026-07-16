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

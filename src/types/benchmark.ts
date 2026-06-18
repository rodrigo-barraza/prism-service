/**
 * Benchmark Type Definitions
 *
 * Shared interfaces for BenchmarkService accuracy testing.
 */

// ── Match Modes ─────────────────────────────────────────────

export const MATCH_MODES = {
  CONTAINS: "contains",
  EXACT: "exact",
  STARTS_WITH: "startsWith",
  REGEX: "regex",
} as const;

export type MatchMode = (typeof MATCH_MODES)[keyof typeof MATCH_MODES];

// ── Assertions ──────────────────────────────────────────────

export interface TextAssertion {
  expectedValue: string;
  matchMode?: MatchMode;
}

export type ComparisonOperator = "gte" | "lte" | "gt" | "lt" | "eq";

export interface AgentAssertion {
  type: "replied" | "used_tool_calls" | "thought" | "max_turns";
  operator?: ComparisonOperator;
  operand?: string | number;
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
  passed: boolean;
  matchMode: MatchMode;
  turnCount?: number;
  latency: number;
  usage: Record<string, number> | null;
  estimatedCost: number | null;
  error: string | null;
  completedAt: string;
}

export interface BenchmarkToolCall {
  id?: string;
  name: string;
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

// ── Execution Data (for agent assertions) ───────────────────

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

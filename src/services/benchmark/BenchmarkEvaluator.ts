/**
 * BenchmarkEvaluator — pure assertion engine for benchmark runs.
 *
 * Evaluates a model/agent execution against a benchmark's text assertions
 * (output matching) and behavioral assertions (tool usage, turns, thinking,
 * LLM-judge verdicts). No I/O — llm_judge verdicts are computed by the
 * caller (BenchmarkJudge) and passed in, keeping everything here testable.
 *
 * Pass semantics: each group (text / behavior) combines its assertions with
 * the group's AND/OR operator; an empty group passes vacuously; the result
 * passes when BOTH groups pass. Legacy documents keep their behavior: the
 * old mode gating ("model" ignored behavioral assertions, "agent" ignored
 * text) is equivalent because those documents only populate one group.
 */
import { BENCHMARK_MATCH_MODES } from "#src/constants";
import logger from "#src/utils/logger";
import type {
  AgentAssertion,
  AssertionResult,
  BenchmarkExecutionData,
  BenchmarkToolCall,
  ComparisonOperator,
  JudgeVerdict,
  MatchMode,
  TextAssertion,
} from "#src/types/benchmark";
import { COMPARATORS } from "#src/types/benchmark";

const OPERATOR_SYMBOLS: Record<ComparisonOperator, string> = {
  gte: "≥",
  lte: "≤",
  gt: ">",
  lt: "<",
  eq: "=",
};

const LABEL_VALUE_LIMIT = 60;

interface BenchmarkAssertionSource {
  expectedValue?: string;
  matchMode?: string;
  assertions?: TextAssertion[];
  assertionOperator?: string;
  agentAssertions?: AgentAssertion[];
  agentAssertionOperator?: string;
}

function truncateForLabel(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > LABEL_VALUE_LIMIT
    ? `${collapsed.slice(0, LABEL_VALUE_LIMIT)}…`
    : collapsed;
}

// ── JSON helpers ─────────────────────────────────────────────

/**
 * Extract the first parseable JSON value from a response: the whole trimmed
 * text, a fenced ```json block, or the first balanced {...} / [...] span.
 */
export function extractJson(response: string): unknown | undefined {
  const trimmed = response.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const opener of ["{", "["]) {
    const closer = opener === "{" ? "}" : "]";
    const start = trimmed.indexOf(opener);
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        if (inString) escaped = true;
        continue;
      }
      if (char === '"') inString = !inString;
      if (inString) continue;
      if (char === opener) depth++;
      else if (char === closer) {
        depth--;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

/**
 * Deep subset match: every key/value present in `expected` must exist in
 * `actual`. Arrays match when each expected element matches some actual
 * element. Scalars compare strictly.
 */
export function jsonSubsetMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) =>
      actual.some((actualItem) => jsonSubsetMatches(expectedItem, actualItem)),
    );
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => key in actualRecord && jsonSubsetMatches(value, actualRecord[key]),
  );
}

/** Extract numeric tokens ("1,234.5" → 1234.5) from a response. */
function extractNumbers(response: string): number[] {
  const normalized = response.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const matches = normalized.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || [];
  return matches
    .map((token) => Number.parseFloat(token))
    .filter((value) => Number.isFinite(value));
}

function numbersEqual(first: number, second: number): boolean {
  const scale = Math.max(1, Math.abs(first), Math.abs(second));
  return Math.abs(first - second) <= 1e-9 * scale;
}

// ── Text matching ────────────────────────────────────────────

/**
 * Match a response against an expected value using a match mode.
 * Case-insensitive for the string modes (legacy behavior).
 */
export function matchText(
  response: string,
  expected: string,
  matchMode: MatchMode | string = BENCHMARK_MATCH_MODES.CONTAINS,
): boolean {
  if (!response) return false;
  if (matchMode === BENCHMARK_MATCH_MODES.JSON_VALID) {
    return extractJson(response) !== undefined;
  }
  if (!expected) return false;
  const norm = (s: string) => s.trim().toLowerCase();
  switch (matchMode) {
    case BENCHMARK_MATCH_MODES.EXACT:
      return norm(response) === norm(expected);
    case BENCHMARK_MATCH_MODES.STARTS_WITH:
      return norm(response).startsWith(norm(expected));
    case BENCHMARK_MATCH_MODES.NOT_CONTAINS:
      return !norm(response).includes(norm(expected));
    case BENCHMARK_MATCH_MODES.REGEX: {
      try {
        const regex = new RegExp(expected, "i");
        return regex.test(response);
      } catch {
        logger.warn(`[benchmark] Invalid regex: ${expected}`);
        return false;
      }
    }
    case BENCHMARK_MATCH_MODES.JSON_MATCH: {
      let expectedJson: unknown;
      try {
        expectedJson = JSON.parse(expected);
      } catch {
        logger.warn(`[benchmark] jsonMatch expected value is not valid JSON`);
        return false;
      }
      const actualJson = extractJson(response);
      if (actualJson === undefined) return false;
      return jsonSubsetMatches(expectedJson, actualJson);
    }
    case BENCHMARK_MATCH_MODES.NUMERIC_EQUALS: {
      const expectedNumber = Number.parseFloat(expected.replace(/,/g, ""));
      if (!Number.isFinite(expectedNumber)) return false;
      return extractNumbers(response).some((value) =>
        numbersEqual(value, expectedNumber),
      );
    }
    case BENCHMARK_MATCH_MODES.CONTAINS:
    default:
      return norm(response).includes(norm(expected));
  }
}

const TEXT_MODE_LABELS: Record<string, (expected: string) => string> = {
  [BENCHMARK_MATCH_MODES.CONTAINS]: (expected) => `contains "${expected}"`,
  [BENCHMARK_MATCH_MODES.NOT_CONTAINS]: (expected) =>
    `does not contain "${expected}"`,
  [BENCHMARK_MATCH_MODES.EXACT]: (expected) => `equals "${expected}"`,
  [BENCHMARK_MATCH_MODES.STARTS_WITH]: (expected) =>
    `starts with "${expected}"`,
  [BENCHMARK_MATCH_MODES.REGEX]: (expected) => `matches /${expected}/i`,
  [BENCHMARK_MATCH_MODES.JSON_VALID]: () => "is valid JSON",
  [BENCHMARK_MATCH_MODES.JSON_MATCH]: (expected) => `JSON includes ${expected}`,
  [BENCHMARK_MATCH_MODES.NUMERIC_EQUALS]: (expected) => `number = ${expected}`,
};

export function describeTextAssertion(assertion: TextAssertion): string {
  const mode = assertion.matchMode || BENCHMARK_MATCH_MODES.CONTAINS;
  const format =
    TEXT_MODE_LABELS[mode] || TEXT_MODE_LABELS[BENCHMARK_MATCH_MODES.CONTAINS];
  return format(truncateForLabel(assertion.expectedValue || ""));
}

function evaluateTextAssertion(
  response: string,
  assertion: TextAssertion,
): AssertionResult {
  const passed = matchText(
    response,
    assertion.expectedValue,
    assertion.matchMode || BENCHMARK_MATCH_MODES.CONTAINS,
  );
  return {
    kind: "text",
    label: describeTextAssertion(assertion),
    passed,
  };
}

// ── Behavioral assertions ────────────────────────────────────

function toolCallName(toolCall: BenchmarkToolCall): string {
  return toolCall.name || "";
}

function compare(
  count: number,
  operator: string | undefined,
  operand: number,
  fallback: ComparisonOperator,
): boolean {
  const compareFunction =
    COMPARATORS[(operator as ComparisonOperator) || fallback];
  return compareFunction
    ? compareFunction(count, operand)
    : COMPARATORS[fallback](count, operand);
}

function stringifyPayload(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** Parse the comma-separated tool list of a tool_sequence assertion. */
function parseToolSequence(assertion: AgentAssertion): string[] {
  return (assertion.toolName || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** True when `expected` appears in `observed` in order (gaps allowed). */
function isInOrderSubsequence(expected: string[], observed: string[]): boolean {
  let cursor = 0;
  for (const name of observed) {
    if (name === expected[cursor]) cursor++;
    if (cursor === expected.length) return true;
  }
  return cursor === expected.length;
}

export function describeAgentAssertion(assertion: AgentAssertion): string {
  const symbol = OPERATOR_SYMBOLS[assertion.operator as ComparisonOperator];
  switch (assertion.type) {
    case "replied":
      return "replied";
    case "thought":
      return "thought";
    case "max_turns":
      return `turns ${symbol || "≤"} ${assertion.operand ?? "?"}`;
    case "used_tool_calls":
      return `tool calls ${symbol || "≥"} ${assertion.operand ?? 1}`;
    case "used_tool":
      return `used ${assertion.toolName || "?"} ${symbol || "≥"} ${assertion.operand ?? 1}`;
    case "not_used_tool":
      return assertion.toolName
        ? `never used ${assertion.toolName}`
        : "used no tools";
    case "first_tool":
      return `first tool is ${assertion.toolName || "?"}`;
    case "tool_sequence": {
      const sequence = parseToolSequence(assertion).join(" → ");
      return `${assertion.exactOrder ? "exact sequence" : "sequence"}: ${sequence || "?"}`;
    }
    case "tool_args_match":
      return `args${assertion.toolName ? `[${assertion.toolName}]` : ""} ${describeTextAssertion(
        {
          expectedValue: assertion.expectedValue || "",
          matchMode: assertion.matchMode,
        },
      )}`;
    case "tool_result_match":
      return `result${assertion.toolName ? `[${assertion.toolName}]` : ""} ${describeTextAssertion(
        {
          expectedValue: assertion.expectedValue || "",
          matchMode: assertion.matchMode,
        },
      )}`;
    case "tool_calls_ok":
      return "all tool calls succeeded";
    case "llm_judge":
      return `judge: ${truncateForLabel(assertion.rubric || "rubric")}`;
    default:
      return String(assertion.type);
  }
}

function evaluateBehaviorAssertion(
  assertion: AgentAssertion,
  executionData: BenchmarkExecutionData,
  judgeVerdict?: JudgeVerdict,
): AssertionResult {
  const label = describeAgentAssertion(assertion);
  const toolCalls = executionData.toolCalls || [];
  const base: AssertionResult = { kind: "behavior", label, passed: false };

  switch (assertion.type) {
    case "replied":
      base.passed =
        !!executionData.response && executionData.response.trim().length > 0;
      return base;

    case "thought":
      base.passed =
        !!executionData.thinking && executionData.thinking.trim().length > 0;
      return base;

    case "max_turns": {
      const turns = executionData.turnCount || 1;
      const limit = Number.parseInt(String(assertion.operand ?? ""), 10);
      base.actual = `${turns} turn${turns === 1 ? "" : "s"}`;
      base.passed = Number.isNaN(limit)
        ? true // no limit specified — legacy behavior
        : compare(turns, assertion.operator, limit, "lte");
      return base;
    }

    case "used_tool_calls": {
      const count = toolCalls.length;
      const target = Number.parseInt(String(assertion.operand ?? ""), 10);
      base.actual = `${count} call${count === 1 ? "" : "s"}`;
      base.passed = Number.isNaN(target)
        ? count > 0 // fallback: any tool calls — legacy behavior
        : compare(count, assertion.operator, target, "gte");
      return base;
    }

    case "used_tool": {
      const count = toolCalls.filter(
        (toolCall) => toolCallName(toolCall) === assertion.toolName,
      ).length;
      const target = Number.parseInt(String(assertion.operand ?? ""), 10);
      base.actual = `${count} call${count === 1 ? "" : "s"}`;
      if (!assertion.toolName) {
        base.error = "used_tool requires a tool name";
        return base;
      }
      base.passed = Number.isNaN(target)
        ? count >= 1
        : compare(count, assertion.operator, target, "gte");
      return base;
    }

    case "not_used_tool": {
      if (assertion.toolName) {
        const count = toolCalls.filter(
          (toolCall) => toolCallName(toolCall) === assertion.toolName,
        ).length;
        base.actual = `${count} call${count === 1 ? "" : "s"}`;
        base.passed = count === 0;
      } else {
        base.actual = `${toolCalls.length} call${toolCalls.length === 1 ? "" : "s"}`;
        base.passed = toolCalls.length === 0;
      }
      return base;
    }

    case "first_tool": {
      const firstName = toolCalls.length > 0 ? toolCallName(toolCalls[0]) : "";
      base.actual = firstName || "no tool calls";
      if (!assertion.toolName) {
        base.error = "first_tool requires a tool name";
        return base;
      }
      base.passed = firstName === assertion.toolName;
      return base;
    }

    case "tool_sequence": {
      const expected = parseToolSequence(assertion);
      const observed = toolCalls.map(toolCallName).filter(Boolean);
      base.actual = observed.join(" → ") || "no tool calls";
      if (expected.length === 0) {
        base.error = "tool_sequence requires at least one tool name";
        return base;
      }
      base.passed = assertion.exactOrder
        ? observed.length === expected.length &&
          expected.every((name, index) => observed[index] === name)
        : isInOrderSubsequence(expected, observed);
      return base;
    }

    case "tool_args_match":
    case "tool_result_match": {
      const field = assertion.type === "tool_args_match" ? "args" : "result";
      const candidates = assertion.toolName
        ? toolCalls.filter(
            (toolCall) => toolCallName(toolCall) === assertion.toolName,
          )
        : toolCalls;
      if (!assertion.expectedValue) {
        base.error = `${assertion.type} requires an expected value`;
        return base;
      }
      base.passed = candidates.some((toolCall) =>
        matchText(
          stringifyPayload(toolCall[field]),
          assertion.expectedValue!,
          assertion.matchMode || BENCHMARK_MATCH_MODES.CONTAINS,
        ),
      );
      base.actual = `${candidates.length} candidate call${candidates.length === 1 ? "" : "s"}`;
      return base;
    }

    case "tool_calls_ok": {
      const failed = toolCalls.filter(
        (toolCall) => toolCall.status === "error",
      );
      base.actual =
        failed.length > 0
          ? `${failed.length} errored: ${failed.map(toolCallName).join(", ")}`
          : `${toolCalls.length} call${toolCalls.length === 1 ? "" : "s"} clean`;
      base.passed = failed.length === 0;
      return base;
    }

    case "llm_judge": {
      if (!judgeVerdict) {
        base.error = "Judge verdict unavailable";
        return base;
      }
      base.passed = judgeVerdict.passed && !judgeVerdict.error;
      base.actual =
        judgeVerdict.score != null
          ? `score ${judgeVerdict.score}`
          : judgeVerdict.passed
            ? "pass"
            : "fail";
      if (judgeVerdict.error) base.error = judgeVerdict.error;
      base.judge = judgeVerdict;
      return base;
    }

    default:
      logger.warn(`[benchmark] Unknown agent assertion type: ${assertion.type}`);
      base.error = `Unknown assertion type: ${assertion.type}`;
      return base;
  }
}

// ── Assertion collection ─────────────────────────────────────

/**
 * Collect effective text assertions: the assertions array (entries with an
 * expected value, or valueless modes like jsonValid), falling back to the
 * legacy top-level expectedValue/matchMode pair.
 */
export function collectTextAssertions(
  benchmark: BenchmarkAssertionSource,
): TextAssertion[] {
  const list = (benchmark.assertions || []).filter(
    (assertion) =>
      assertion.expectedValue?.trim() ||
      assertion.matchMode === BENCHMARK_MATCH_MODES.JSON_VALID,
  ) as TextAssertion[];
  if (list.length > 0) return list;
  if (benchmark.expectedValue?.trim()) {
    return [
      {
        expectedValue: benchmark.expectedValue,
        matchMode: (benchmark.matchMode ||
          BENCHMARK_MATCH_MODES.CONTAINS) as MatchMode,
      },
    ];
  }
  return [];
}

export function collectBehaviorAssertions(
  benchmark: BenchmarkAssertionSource,
): AgentAssertion[] {
  return (benchmark.agentAssertions || []).filter(
    (assertion) => assertion && assertion.type,
  );
}

// ── Full evaluation ──────────────────────────────────────────

export interface BenchmarkEvaluation {
  passed: boolean;
  assertionResults: AssertionResult[];
}

function combineGroup(results: AssertionResult[], operator: string): boolean {
  if (results.length === 0) return true;
  return operator === "OR"
    ? results.some((result) => result.passed)
    : results.every((result) => result.passed);
}

/**
 * Evaluate a benchmark against execution data. `judgeVerdicts` maps the
 * index of each llm_judge assertion (within agentAssertions) to its verdict.
 */
export function evaluateBenchmark(
  benchmark: BenchmarkAssertionSource,
  executionData: BenchmarkExecutionData,
  judgeVerdicts: Map<number, JudgeVerdict> = new Map(),
): BenchmarkEvaluation {
  const response = executionData.response || "";
  const textResults = collectTextAssertions(benchmark).map((assertion) =>
    evaluateTextAssertion(response, assertion),
  );
  const behaviorAssertions = collectBehaviorAssertions(benchmark);
  const behaviorResults = behaviorAssertions.map((assertion) => {
    const judgeIndex = (benchmark.agentAssertions || []).indexOf(assertion);
    return evaluateBehaviorAssertion(
      assertion,
      executionData,
      judgeVerdicts.get(judgeIndex),
    );
  });

  const textPassed = combineGroup(
    textResults,
    benchmark.assertionOperator || "AND",
  );
  const behaviorPassed = combineGroup(
    behaviorResults,
    benchmark.agentAssertionOperator || "AND",
  );

  return {
    passed: textPassed && behaviorPassed,
    assertionResults: [...textResults, ...behaviorResults],
  };
}

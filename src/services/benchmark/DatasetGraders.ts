/**
 * DatasetGraders — how one run of a dataset case is graded.
 *
 * The grader set follows `claude plugin eval`'s (regex, tool_used,
 * file_exists, llm, baseline), plus the trajectory check benchmarks already
 * had (tool_sequence):
 *   regex / tool_used / tool_sequence  — deterministic, over the reply and
 *                                        the tool trace;
 *   file_exists                        — the run's scratch workspace, through
 *                                        tools-service (ScratchWorkspace);
 *   llm_rubric                         — BenchmarkJudge.runJudge;
 *   baseline                           — BenchmarkJudge.runPairwiseJudge
 *                                        against a reference answer; passes
 *                                        when the reply is at least as good.
 * A run passes when every grader passes. The deterministic graders go
 * first, and a run one of them already failed does not pay for its judges:
 * those are marked `skipped`.
 */
import type {
  BenchmarkToolCall,
  DatasetCase,
  DatasetGrader,
  GraderResult,
} from "#src/types/benchmark";
import { isInOrderSubsequence } from "#src/services/benchmark/BenchmarkEvaluator";
import { runJudge, runPairwiseJudge } from "#src/services/benchmark/BenchmarkJudge";
import {
  findWorkspaceFiles,
  normaliseWorkspacePath,
  readWorkspaceFile,
  type ScratchWorkspace,
  type WorkspaceIdentity,
} from "#src/services/benchmark/ScratchWorkspace";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/** What a regex grader reads at most — a user pattern never scans unbounded text. */
const REGEX_INPUT_CHARACTER_LIMIT = 200_000;
const REGEX_FLAGS = /^[gimsuy]*$/;
const LABEL_LIMIT = 60;

export interface GradedExecution {
  response: string | null;
  thinking: string | null;
  toolCalls: BenchmarkToolCall[];
}

export interface GradingContext {
  datasetCase: Pick<DatasetCase, "prompt" | "systemPrompt">;
  /** The run's scratch workspace (null when the case has none). */
  workspace: ScratchWorkspace | null;
  identity: WorkspaceIdentity;
  signal?: AbortSignal;
}

export interface CaseGrade {
  passed: boolean;
  results: GraderResult[];
  judgeCost: number;
}

const DETERMINISTIC = new Set<DatasetGrader["type"]>(["regex", "tool_used", "tool_sequence"]);

const shorten = (text: string) => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > LABEL_LIMIT ? `${collapsed.slice(0, LABEL_LIMIT)}…` : collapsed;
};

export function describeGrader(grader: DatasetGrader): string {
  switch (grader.type) {
    case "regex":
      return `${grader.target === "thinking" ? "thinking" : "reply"} ${grader.negate ? "does not match" : "matches"} /${shorten(grader.pattern)}/${grader.flags ?? ""}`;
    case "tool_used": {
      const min = grader.min ?? 1;
      const range =
        grader.max === 0
          ? "never"
          : grader.max !== undefined
            ? `${min}–${grader.max}×`
            : `≥ ${min}×`;
      return `used ${grader.tool} ${range}${grader.argsMatch ? ` with args /${shorten(grader.argsMatch)}/` : ""}`;
    }
    case "tool_sequence":
      return `${grader.exactOrder ? "exact sequence" : "sequence"}: ${grader.tools.join(" → ")}`;
    case "file_exists":
      return `file ${grader.path} exists${grader.contentMatch ? ` matching /${shorten(grader.contentMatch)}/` : ""}`;
    case "llm_rubric":
      return `rubric: ${shorten(grader.rubric)}`;
    case "baseline":
      return `at least as good as the reference${grader.criteria ? ` (${shorten(grader.criteria)})` : ""}`;
  }
}

/** A grader's own mistakes (bad pattern, empty sequence) — null when it can run. */
export function validateGrader(grader: DatasetGrader): string | null {
  const checkPattern = (pattern: string | undefined, flags = "") => {
    if (pattern === undefined) return null;
    if (!REGEX_FLAGS.test(flags)) return `invalid regex flags "${flags}"`;
    try {
      new RegExp(pattern, flags);
      return null;
    } catch (error: unknown) {
      return `invalid regex: ${getErrorMessage(error)}`;
    }
  };
  switch (grader?.type) {
    case "regex":
      if (typeof grader.pattern !== "string" || !grader.pattern) return "regex needs a pattern";
      return checkPattern(grader.pattern, grader.flags ?? "");
    case "tool_used":
      if (typeof grader.tool !== "string" || !grader.tool.trim()) return "tool_used needs a tool";
      if (grader.min !== undefined && (!Number.isInteger(grader.min) || grader.min < 0)) {
        return "tool_used min must be a non-negative integer";
      }
      if (grader.max !== undefined && (!Number.isInteger(grader.max) || grader.max < 0)) {
        return "tool_used max must be a non-negative integer";
      }
      if (grader.max !== undefined && grader.max < (grader.min ?? (grader.max === 0 ? 0 : 1))) {
        return "tool_used max is below its min";
      }
      return checkPattern(grader.argsMatch);
    case "tool_sequence":
      if (
        !Array.isArray(grader.tools) ||
        grader.tools.length === 0 ||
        grader.tools.some((tool) => typeof tool !== "string" || !tool.trim())
      ) {
        return "tool_sequence needs a non-empty list of tool names";
      }
      return null;
    case "file_exists":
      if (typeof grader.path !== "string" || !normaliseWorkspacePath(grader.path)) {
        return "file_exists needs a relative path inside the workspace";
      }
      return checkPattern(grader.contentMatch);
    case "llm_rubric":
      return typeof grader.rubric === "string" && grader.rubric.trim() ? null : "llm_rubric needs a rubric";
    case "baseline":
      return typeof grader.reference === "string" && grader.reference.trim()
        ? null
        : "baseline needs a reference answer";
    default:
      return `unknown grader type: ${(grader as { type?: unknown })?.type}`;
  }
}

function result(grader: DatasetGrader, passed: boolean, extra: Partial<GraderResult> = {}): GraderResult {
  return { type: grader.type, label: describeGrader(grader), passed, ...extra };
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** regex, tool_used and tool_sequence: pure functions of the reply and the trace. */
export function gradeDeterministic(
  grader: Extract<DatasetGrader, { type: "regex" | "tool_used" | "tool_sequence" }>,
  execution: GradedExecution,
): GraderResult {
  const invalid = validateGrader(grader);
  if (invalid) return result(grader, false, { error: invalid });
  const toolNames = execution.toolCalls.map((toolCall) => toolCall.name || "").filter(Boolean);
  switch (grader.type) {
    case "regex": {
      const text = (grader.target === "thinking" ? execution.thinking : execution.response) ?? "";
      const matched = new RegExp(grader.pattern, grader.flags ?? "").test(
        text.slice(0, REGEX_INPUT_CHARACTER_LIMIT),
      );
      return result(grader, grader.negate ? !matched : matched, {
        actual: matched ? "matched" : "no match",
      });
    }
    case "tool_used": {
      const argsPattern = grader.argsMatch ? new RegExp(grader.argsMatch) : null;
      const count = execution.toolCalls.filter(
        (toolCall) =>
          toolCall.name === grader.tool &&
          (!argsPattern || argsPattern.test(stringify(toolCall.args).slice(0, REGEX_INPUT_CHARACTER_LIMIT))),
      ).length;
      const min = grader.max === 0 ? 0 : (grader.min ?? 1);
      const max = grader.max ?? Number.POSITIVE_INFINITY;
      return result(grader, count >= min && count <= max, {
        actual: `${count} call${count === 1 ? "" : "s"}`,
      });
    }
    case "tool_sequence": {
      const expected = grader.tools.map((tool) => tool.trim());
      const passed = grader.exactOrder
        ? toolNames.length === expected.length &&
          expected.every((name, index) => toolNames[index] === name)
        : isInOrderSubsequence(expected, toolNames);
      return result(grader, passed, { actual: toolNames.join(" → ") || "no tool calls" });
    }
  }
}

async function gradeFileExists(
  grader: Extract<DatasetGrader, { type: "file_exists" }>,
  context: GradingContext,
): Promise<GraderResult> {
  if (!context.workspace) {
    return result(grader, false, { error: "The run had no scratch workspace" });
  }
  try {
    const matches = await findWorkspaceFiles(context.workspace, grader.path, context.identity);
    if (matches.length === 0) return result(grader, false, { actual: "not found" });
    if (!grader.contentMatch) return result(grader, true, { actual: matches.slice(0, 3).join(", ") });
    // Line-wise, like grep: ^ and $ match at line breaks.
    const pattern = new RegExp(grader.contentMatch, "m");
    for (const path of matches.slice(0, 20)) {
      const content = await readWorkspaceFile(context.workspace, path, context.identity);
      if (content !== null && pattern.test(content.slice(0, REGEX_INPUT_CHARACTER_LIMIT))) {
        return result(grader, true, { actual: path });
      }
    }
    return result(grader, false, { actual: `${matches.length} file(s), content does not match` });
  } catch (error: unknown) {
    return result(grader, false, { error: getErrorMessage(error) });
  }
}

/** Grade one run of a case: every grader, deterministic ones first. */
export async function gradeCase(
  graders: DatasetGrader[],
  execution: GradedExecution,
  context: GradingContext,
): Promise<CaseGrade> {
  const ordered = [
    ...graders.filter((grader) => DETERMINISTIC.has(grader.type)),
    ...graders.filter((grader) => !DETERMINISTIC.has(grader.type)),
  ];
  const results: GraderResult[] = [];
  let judgeCost = 0;
  let failedCheaply = false;
  for (const grader of ordered) {
    if (grader.type === "regex" || grader.type === "tool_used" || grader.type === "tool_sequence") {
      const graded = gradeDeterministic(grader, execution);
      if (!graded.passed) failedCheaply = true;
      results.push(graded);
      continue;
    }
    if (grader.type === "file_exists") {
      const graded = await gradeFileExists(grader, context);
      if (!graded.passed) failedCheaply = true;
      results.push(graded);
      continue;
    }
    // The judges: the run already failed — do not pay for them.
    if (failedCheaply) {
      results.push(result(grader, false, { skipped: true, actual: "not run: an earlier grader failed" }));
      continue;
    }
    if (context.signal?.aborted) {
      results.push(result(grader, false, { error: "Aborted" }));
      continue;
    }
    const response = execution.response ?? "";
    if (grader.type === "llm_rubric") {
      const verdict = await runJudge({
        rubric: grader.rubric,
        judgeModel: grader.judgeModel,
        prompt: context.datasetCase.prompt,
        systemPrompt: context.datasetCase.systemPrompt,
        response,
        toolCalls: execution.toolCalls,
        project: context.identity.project,
        username: context.identity.username,
        signal: context.signal,
      });
      judgeCost += verdict.cost ?? 0;
      results.push(
        result(grader, verdict.passed && !verdict.error, {
          actual: verdict.score != null ? `score ${verdict.score}` : verdict.passed ? "pass" : "fail",
          judge: verdict,
          ...(verdict.error && { error: verdict.error }),
        }),
      );
      continue;
    }
    const verdict = await runPairwiseJudge({
      task: context.datasetCase.prompt,
      systemPrompt: context.datasetCase.systemPrompt,
      criteria: grader.criteria,
      candidate: response,
      reference: grader.reference,
      judgeModel: grader.judgeModel,
      project: context.identity.project,
      username: context.identity.username,
      signal: context.signal,
    });
    judgeCost += verdict.cost ?? 0;
    results.push(
      result(grader, !verdict.error && verdict.winner !== "reference", {
        actual: verdict.error ? "no verdict" : `${verdict.winner} preferred`,
        judge: {
          passed: !verdict.error && verdict.winner !== "reference",
          reasoning: verdict.reasoning,
          model: verdict.model,
          provider: verdict.provider,
          cost: verdict.cost,
          error: verdict.error,
        },
        ...(verdict.error && { error: verdict.error }),
      }),
    );
  }
  return {
    passed: results.length > 0 && results.every((graded) => graded.passed),
    results,
    judgeCost,
  };
}

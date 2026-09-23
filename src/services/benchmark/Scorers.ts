/**
 * Scorers — how one sample is graded.
 *
 * Every scorer yields a value in [0, 1] and a pass. A sample passes when
 * every REQUIRED scorer passes; its score is the weighted mean of the
 * values (partial credit: IFEval's instruction share, a checklist's points,
 * a rubric's 0–10). Deterministic scorers run first — the reply, the
 * extracted answer, the tool trace, the scratch workspace — and once a
 * required one has failed, the model-graded scorers of that sample are
 * skipped (`skipped`): they could not change the pass, only the bill.
 */
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import {
  extractAnswerLine,
  extractChoice,
  extractMathAnswer,
  extractNumber,
  mathEquivalent,
  normaliseText,
  numbersMatch,
  parseNumber,
} from "#src/services/benchmark/scorers/AnswerExtraction";
import { countSentences, countWords, evaluateIfEval, instructionsOf } from "#src/services/benchmark/scorers/IfEval";
import {
  aggregateVotes,
  judgeChecklist,
  judgePairwise,
  judgeReference,
  judgeRubric,
  resolveJudges,
  voteCost,
  type JudgeContext,
} from "#src/services/benchmark/BenchmarkJudge";
import {
  findWorkspaceFiles,
  normaliseWorkspacePath,
  readWorkspaceFile,
  writeWorkspaceFiles,
  type ScratchWorkspace,
  type WorkspaceIdentity,
} from "#src/services/benchmark/ScratchWorkspace";
import {
  MODEL_GRADED_SCORERS,
  type JudgeVote,
  type SampleOutput,
  type ScoreResult,
  type ScorerSpec,
  type SuiteCase,
} from "#src/types/benchmark";

const REGEX_INPUT_LIMIT = 200_000;
const REGEX_FLAGS = /^[gimsuy]*$/;
const LABEL_LIMIT = 64;
const COMMAND_OUTPUT_LIMIT = 600;

export interface ScoringContext {
  datasetCase: SuiteCase;
  /** The user's last message, as the judge sees the task. */
  task: string;
  systemPrompt?: string | null;
  output: SampleOutput;
  cost: number | null;
  latencyMs: number;
  workspace: ScratchWorkspace | null;
  identity: WorkspaceIdentity;
  /** The run's judges ("provider:model"). */
  judges: string[];
  signal?: AbortSignal;
}

export interface SampleGrade {
  scores: ScoreResult[];
  score: number;
  passed: boolean;
  judgeCost: number;
}

const shorten = (text: string) => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > LABEL_LIMIT ? `${collapsed.slice(0, LABEL_LIMIT)}…` : collapsed;
};

export const targetsOf = (datasetCase: SuiteCase): string[] =>
  datasetCase.target == null
    ? []
    : (Array.isArray(datasetCase.target) ? datasetCase.target : [datasetCase.target]).map(String);

/** A readable one-line description of a scorer. */
export function describeScorer(scorer: ScorerSpec): string {
  if (scorer.label) return scorer.label;
  switch (scorer.type) {
    case "exact":
      return "exact match";
    case "includes":
      return scorer.all ? "contains every target" : "contains the target";
    case "regex":
      return `${scorer.source === "thinking" ? "thinking" : "reply"} ${scorer.negate ? "does not match" : "matches"} /${shorten(scorer.pattern)}/${scorer.flags ?? ""}`;
    case "numeric":
      return "numeric answer";
    case "choice":
      return "multiple-choice letter";
    case "math":
      return scorer.judgeFallback ? "math answer (judge fallback)" : "math answer";
    case "json":
      return scorer.requiredKeys?.length ? `JSON with ${scorer.requiredKeys.join(", ")}` : "valid JSON";
    case "ifeval":
      return `IFEval instructions (${scorer.mode ?? "strict"})`;
    case "length":
      return `${scorer.unit} ${scorer.min != null ? `≥ ${scorer.min}` : ""}${scorer.min != null && scorer.max != null ? " and " : ""}${scorer.max != null ? `≤ ${scorer.max}` : ""}`.trim();
    case "tool_called": {
      const min = scorer.min ?? 1;
      const range = scorer.max === 0 ? "never" : scorer.max != null ? `${min}–${scorer.max}×` : `≥ ${min}×`;
      return `called ${scorer.tool} ${range}${scorer.argsMatch ? ` with /${shorten(scorer.argsMatch)}/` : ""}`;
    }
    case "tool_sequence":
      return `${scorer.exactOrder ? "exactly" : "in order"}: ${scorer.tools.join(" → ")}`;
    case "no_tool_errors":
      return "no tool errors";
    case "file":
      return scorer.absent
        ? `no file ${scorer.path}`
        : `file ${scorer.path}${scorer.contentMatch ? ` matching /${shorten(scorer.contentMatch)}/` : ""}`;
    case "command":
      return `\`${shorten(scorer.command)}\` exits ${scorer.expectExitCode ?? 0}`;
    case "code_tests":
      return `${scorer.language === "javascript" ? "JavaScript" : "Python"} tests pass`;
    case "efficiency": {
      const limits = [
        scorer.maxTurns != null ? `≤ ${scorer.maxTurns} turns` : null,
        scorer.maxToolCalls != null ? `≤ ${scorer.maxToolCalls} tool calls` : null,
        scorer.maxCostUsd != null ? `≤ $${scorer.maxCostUsd}` : null,
        scorer.maxSeconds != null ? `≤ ${scorer.maxSeconds} s` : null,
      ].filter(Boolean);
      return limits.join(", ") || "efficiency";
    }
    case "rubric":
      return `rubric: ${shorten(scorer.rubric)}`;
    case "checklist":
      return `checklist (${scorer.items.length} criteria)`;
    case "reference":
      return "judged against the reference";
    case "pairwise_reference":
      return "at least as good as the reference";
  }
}

function checkPattern(pattern: string | null | undefined, flags = ""): string | null {
  if (pattern == null) return null;
  if (!REGEX_FLAGS.test(flags)) return `invalid regex flags "${flags}"`;
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (error: unknown) {
    return `invalid regex: ${getErrorMessage(error)}`;
  }
}

/** A scorer's own mistakes — null when it can run. */
export function validateScorer(scorer: ScorerSpec): string | null {
  if (!scorer || typeof scorer !== "object") return "a scorer must be an object";
  if (scorer.weight != null && (!Number.isFinite(scorer.weight) || scorer.weight < 0)) {
    return "weight must be a non-negative number";
  }
  switch (scorer.type) {
    case "exact":
    case "includes":
    case "numeric":
    case "choice":
    case "math":
    case "ifeval":
    case "no_tool_errors":
    case "reference":
    case "pairwise_reference":
      return null;
    case "regex":
      if (typeof scorer.pattern !== "string" || !scorer.pattern) return "regex needs a pattern";
      return checkPattern(scorer.pattern, scorer.flags ?? "");
    case "json":
      return scorer.requiredKeys && !Array.isArray(scorer.requiredKeys) ? "requiredKeys must be a list" : null;
    case "length":
      if (!["words", "characters", "sentences", "paragraphs"].includes(scorer.unit)) return "length needs a unit";
      if (scorer.min == null && scorer.max == null) return "length needs a min or a max";
      return null;
    case "tool_called":
      if (typeof scorer.tool !== "string" || !scorer.tool.trim()) return "tool_called needs a tool";
      if (scorer.max != null && scorer.max < (scorer.min ?? (scorer.max === 0 ? 0 : 1))) return "max is below min";
      return checkPattern(scorer.argsMatch);
    case "tool_sequence":
      return Array.isArray(scorer.tools) && scorer.tools.length > 0 ? null : "tool_sequence needs tools";
    case "file":
      if (typeof scorer.path !== "string" || !normaliseWorkspacePath(scorer.path)) return "file needs a relative path inside the workspace";
      return checkPattern(scorer.contentMatch, "m");
    case "command":
      if (typeof scorer.command !== "string" || !scorer.command.trim()) return "command needs a command";
      return checkPattern(scorer.outputMatch);
    case "code_tests":
      return scorer.language == null || scorer.language === "python" || scorer.language === "javascript"
        ? null
        : "code_tests runs python or javascript";
    case "efficiency":
      return [scorer.maxTurns, scorer.maxToolCalls, scorer.maxCostUsd, scorer.maxSeconds].some((value) => value != null)
        ? null
        : "efficiency needs at least one limit";
    case "rubric":
      return typeof scorer.rubric === "string" && scorer.rubric.trim() ? null : "rubric needs text";
    case "checklist":
      if (!Array.isArray(scorer.items) || scorer.items.length === 0) return "checklist needs items";
      return scorer.items.every((item) => typeof item?.criterion === "string" && item.criterion.trim() && Number.isFinite(item.points))
        ? null
        : "every checklist item needs a criterion and points";
    default:
      return `unknown scorer type "${(scorer as { type?: unknown }).type}"`;
  }
}

/** Whether a set of scorers needs the sample to run in a scratch workspace. */
export const needsWorkspace = (scorers: ScorerSpec[]) =>
  scorers.some((scorer) => scorer.type === "file" || scorer.type === "command" || scorer.type === "code_tests");

/** The code in a reply: the last fenced block that looks like the language, else the whole reply. */
export function extractCode(reply: string, language: "python" | "javascript" = "python"): string {
  const blocks = [...reply.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].map((match) => ({
    tag: match[1].toLowerCase(),
    code: match[2],
  }));
  const tags = language === "python" ? ["python", "py", "python3"] : ["javascript", "js", "mjs", "node", "typescript", "ts"];
  const tagged = blocks.filter((block) => tags.includes(block.tag));
  const candidates = tagged.length > 0 ? tagged : blocks;
  const looksRight = (code: string) => (language === "python" ? /\bdef\s|\bimport\s|\blambda\b/ : /\bfunction\b|=>|\bexport\b/).test(code);
  const chosen = [...candidates].reverse().find((block) => looksRight(block.code)) ?? candidates[candidates.length - 1];
  return (chosen ? chosen.code : reply).trim();
}

async function runInWorkspace(
  context: ScoringContext,
  command: string,
  timeoutMs: number,
): Promise<{ exitCode?: number | null; stdout?: string; stderr?: string; error?: string; timedOut?: boolean }> {
  const workspace = context.workspace!;
  return (await ToolOrchestratorService.executeTool(
    TOOL_NAMES.EXECUTE_COMMAND,
    { command, cwd: workspace.root, timeout: timeoutMs },
    {
      workspaceRoot: workspace.root,
      username: context.identity.username,
      ...(context.identity.project && { project: context.identity.project }),
    },
  )) as { exitCode?: number | null; stdout?: string; stderr?: string; error?: string; timedOut?: boolean };
}

const outputTail = (result: { stdout?: string; stderr?: string }) => {
  const combined = `${result?.stdout ?? ""}${result?.stderr ? `\n${result.stderr}` : ""}`.trim();
  return combined.length > COMMAND_OUTPUT_LIMIT ? `…${combined.slice(-COMMAND_OUTPUT_LIMIT)}` : combined;
};

// ── Deterministic scorers ───────────────────────────────────

type Outcome = Pick<ScoreResult, "value" | "passed" | "answer" | "expected" | "explanation" | "error">;

const pass = (passed: boolean, extra: Partial<Outcome> = {}): Outcome => ({ value: passed ? 1 : 0, passed, ...extra });

function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function parseJsonReply(text: string): unknown {
  const body = stripCodeFence(text);
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    if (start < 0) throw new Error("no JSON value in the reply");
    for (let end = body.length; end > start; end--) {
      if (!/[\]}]/.test(body[end - 1])) continue;
      try {
        return JSON.parse(body.slice(start, end));
      } catch {
        /* keep shrinking */
      }
    }
    throw new Error("the reply's JSON does not parse");
  }
}

/** `expected` is a subset of `actual`: every key/element it names matches. */
function deepMatches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "string" && typeof actual === "string") return actual.trim() === expected.trim();
    return actual === expected;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => deepMatches(actual[index], item));
  }
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    deepMatches((actual as Record<string, unknown>)[key], value),
  );
}

function countUnits(text: string, unit: "words" | "characters" | "sentences" | "paragraphs"): number {
  switch (unit) {
    case "words":
      return countWords(text);
    case "characters":
      return [...text.trim()].length;
    case "sentences":
      return countSentences(text);
    case "paragraphs":
      return text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim()).length;
  }
}

async function scoreDeterministic(scorer: ScorerSpec, context: ScoringContext): Promise<Outcome> {
  const { output, datasetCase } = context;
  const reply = output.text ?? "";
  const targets = targetsOf(datasetCase);
  switch (scorer.type) {
    case "exact": {
      if (targets.length === 0) return { value: 0, passed: false, error: "no target to compare with" };
      const ignoreCase = scorer.ignoreCase ?? true;
      const candidates = [reply, extractAnswerLine(reply) ?? ""].filter(Boolean).map((text) => normaliseText(text, { ignoreCase }));
      const expected = targets.map((target) => normaliseText(target, { ignoreCase }));
      const hit = expected.find((target) => candidates.includes(target));
      return pass(hit !== undefined, { expected: targets.join(" | "), answer: shorten(candidates[candidates.length - 1] ?? "") });
    }
    case "includes": {
      if (targets.length === 0) return { value: 0, passed: false, error: "no target to look for" };
      const ignoreCase = scorer.ignoreCase ?? true;
      const haystack = normaliseText(reply, { ignoreCase });
      const found = targets.filter((target) => haystack.includes(normaliseText(target, { ignoreCase })));
      const passed = scorer.all ? found.length === targets.length : found.length > 0;
      return {
        value: scorer.all ? found.length / targets.length : passed ? 1 : 0,
        passed,
        expected: targets.join(scorer.all ? " & " : " | "),
        explanation: found.length > 0 ? `found: ${found.join(", ")}` : "none found",
      };
    }
    case "regex": {
      const source = (scorer.source === "thinking" ? output.thinking : reply) ?? "";
      const matched = new RegExp(scorer.pattern, scorer.flags ?? "").test(source.slice(0, REGEX_INPUT_LIMIT));
      return pass(scorer.negate ? !matched : matched, { explanation: matched ? "matched" : "no match" });
    }
    case "numeric": {
      const expected = targets.map((target) => parseNumber(target)).filter((value): value is number => value !== null);
      if (expected.length === 0) return { value: 0, passed: false, error: "the target is not a number" };
      const extracted = extractNumber(reply);
      if (!extracted) return pass(false, { expected: targets[0], explanation: "no number in the reply" });
      const hit = expected.some((value) => numbersMatch(extracted.value, value, scorer.tolerance ?? 1e-6));
      return pass(hit, { answer: extracted.raw, expected: targets[0] });
    }
    case "choice": {
      if (targets.length === 0) return { value: 0, passed: false, error: "no target letter" };
      const choices = Array.isArray(datasetCase.metadata?.choices) ? (datasetCase.metadata!.choices as unknown[]).length : 10;
      const letter = extractChoice(reply, choices);
      const expected = targets.map((target) => target.trim().toUpperCase());
      return pass(letter !== null && expected.includes(letter), {
        answer: letter ?? "(none)",
        expected: expected.join(" | "),
      });
    }
    case "math": {
      if (targets.length === 0) return { value: 0, passed: false, error: "no target answer" };
      const answer = extractMathAnswer(reply) ?? extractNumber(reply)?.raw ?? null;
      const matched = answer !== null && targets.some((target) => mathEquivalent(answer, target));
      return pass(matched, { answer: answer ?? "(none)", expected: targets[0] });
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = parseJsonReply(reply);
      } catch (error: unknown) {
        return pass(false, { explanation: getErrorMessage(error) });
      }
      const missing = (scorer.requiredKeys ?? []).filter(
        (key) => !parsed || typeof parsed !== "object" || !(key in (parsed as Record<string, unknown>)),
      );
      if (missing.length > 0) return pass(false, { explanation: `missing keys: ${missing.join(", ")}` });
      if (scorer.match && !deepMatches(parsed, scorer.match)) return pass(false, { explanation: "values differ from the expected ones" });
      return pass(true, { explanation: "valid" });
    }
    case "ifeval": {
      const instructions = instructionsOf(datasetCase.metadata);
      if (!instructions) return { value: 0, passed: false, error: "the case has no metadata.ifeval instructions" };
      const results = evaluateIfEval(reply, instructions, scorer.mode ?? "strict");
      const followed = results.filter((result) => result.followed).length;
      const missed = results.filter((result) => !result.followed).map((result) => result.id);
      return {
        value: followed / results.length,
        passed: followed === results.length,
        explanation: missed.length > 0 ? `missed: ${missed.join(", ")}` : `all ${results.length} followed`,
      };
    }
    case "length": {
      const count = countUnits(reply, scorer.unit);
      const passed = (scorer.min == null || count >= scorer.min) && (scorer.max == null || count <= scorer.max);
      return pass(passed, { answer: `${count} ${scorer.unit}` });
    }
    case "tool_called": {
      // Arguments are matched case-insensitively ("Reykjavík" and "reykjavik" alike).
      const argsPattern = scorer.argsMatch ? new RegExp(scorer.argsMatch, "i") : null;
      const calls = output.toolCalls.filter((call) => {
        if (call.name !== scorer.tool) return false;
        if (!argsPattern) return true;
        try {
          return argsPattern.test(JSON.stringify(call.args ?? {}));
        } catch {
          return false;
        }
      });
      const min = scorer.max === 0 ? 0 : (scorer.min ?? 1);
      const passed = calls.length >= min && (scorer.max == null || calls.length <= scorer.max);
      return pass(passed, { answer: `${calls.length} call${calls.length === 1 ? "" : "s"}` });
    }
    case "tool_sequence": {
      const names = output.toolCalls.map((call) => call.name ?? "");
      let passed: boolean;
      if (scorer.exactOrder) {
        passed = names.length === scorer.tools.length && names.every((name, index) => name === scorer.tools[index]);
      } else {
        let position = 0;
        for (const name of names) if (name === scorer.tools[position]) position++;
        passed = position >= scorer.tools.length;
      }
      return pass(passed, { answer: names.join(" → ") || "(no tools)" });
    }
    case "no_tool_errors": {
      const failed = output.toolCalls.filter((call) => call.status === "error").map((call) => call.name ?? "?");
      return pass(failed.length === 0, { explanation: failed.length > 0 ? `failed: ${failed.join(", ")}` : undefined });
    }
    case "efficiency": {
      const problems = [
        scorer.maxTurns != null && output.turns > scorer.maxTurns ? `${output.turns} turns` : null,
        scorer.maxToolCalls != null && output.toolCalls.length > scorer.maxToolCalls ? `${output.toolCalls.length} tool calls` : null,
        scorer.maxCostUsd != null && (context.cost ?? 0) > scorer.maxCostUsd ? `$${(context.cost ?? 0).toFixed(4)}` : null,
        scorer.maxSeconds != null && context.latencyMs / 1000 > scorer.maxSeconds ? `${(context.latencyMs / 1000).toFixed(1)} s` : null,
      ].filter(Boolean);
      return pass(problems.length === 0, { explanation: problems.length > 0 ? `over: ${problems.join(", ")}` : "within limits" });
    }
    case "file": {
      if (!context.workspace) return { value: 0, passed: false, error: "the sample ran without a workspace" };
      const files = await findWorkspaceFiles(context.workspace, scorer.path, context.identity);
      if (scorer.absent) return pass(files.length === 0, { explanation: files.length > 0 ? `found ${files.join(", ")}` : "absent" });
      if (files.length === 0) return pass(false, { explanation: `no file matches ${scorer.path}` });
      if (!scorer.contentMatch) return pass(true, { explanation: `found ${files.slice(0, 5).join(", ")}` });
      const pattern = new RegExp(scorer.contentMatch, "m");
      for (const file of files.slice(0, 50)) {
        const content = await readWorkspaceFile(context.workspace, file, context.identity);
        if (content !== null && pattern.test(content.slice(0, REGEX_INPUT_LIMIT))) {
          return pass(true, { explanation: `${file} matches` });
        }
      }
      return pass(false, { explanation: `no matching file's content matches /${shorten(scorer.contentMatch)}/` });
    }
    case "command": {
      if (!context.workspace) return { value: 0, passed: false, error: "the sample ran without a workspace" };
      const timeout = Math.min(600, Math.max(1, scorer.timeoutSeconds ?? 60)) * 1000;
      const result = await runInWorkspace(context, scorer.command, timeout);
      const tail = outputTail(result);
      if (result?.exitCode == null) {
        return pass(false, { explanation: result?.error || (result?.timedOut ? "timed out" : "did not run"), answer: tail });
      }
      const exitOk = result.exitCode === (scorer.expectExitCode ?? 0);
      const outputOk = scorer.outputMatch ? new RegExp(scorer.outputMatch, "m").test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) : true;
      return pass(exitOk && outputOk, { answer: `exit ${result.exitCode}`, explanation: tail || undefined });
    }
    case "code_tests": {
      if (!context.workspace) return { value: 0, passed: false, error: "the sample ran without a workspace" };
      const language = scorer.language === "javascript" ? "javascript" : "python";
      const tests = scorer.tests ?? (typeof datasetCase.metadata?.testProgram === "string" ? datasetCase.metadata.testProgram : null);
      if (!tests) return { value: 0, passed: false, error: "no tests: set the scorer's tests or the case's metadata.testProgram" };
      const code = extractCode(reply, language);
      if (!code) return pass(false, { explanation: "no code in the reply" });
      const preamble = typeof datasetCase.metadata?.codePreamble === "string" ? `${datasetCase.metadata.codePreamble}\n` : "";
      const file = language === "python" ? "solution_under_test.py" : "solution_under_test.mjs";
      await writeWorkspaceFiles(context.workspace, { [file]: `${preamble}${code}\n\n${tests}\n` }, context.identity);
      const timeout = Math.min(300, Math.max(1, scorer.timeoutSeconds ?? 30)) * 1000;
      const result = await runInWorkspace(context, `${language === "python" ? "python3" : "node"} ${file}`, timeout);
      const tail = outputTail(result);
      if (result?.exitCode == null) {
        return pass(false, { explanation: result?.error || (result?.timedOut ? "tests timed out" : "tests did not run"), answer: tail });
      }
      return pass(result.exitCode === 0, { answer: `exit ${result.exitCode}`, explanation: tail || (result.exitCode === 0 ? "all tests passed" : undefined) });
    }
    default:
      return { value: 0, passed: false, error: `not a deterministic scorer: ${scorer.type}` };
  }
}

// ── Model-graded scorers ────────────────────────────────────

async function scoreWithJudges(
  scorer: ScorerSpec,
  context: ScoringContext,
): Promise<Outcome & { judges: JudgeVote[]; cost: number }> {
  const targets = resolveJudges(scorer.judges?.length ? scorer.judges : context.judges);
  if (targets.length === 0) return { value: 0, passed: false, judges: [], cost: 0, error: "no judge model available" };
  const judgeContext: JudgeContext = { project: context.identity.project, username: context.identity.username, signal: context.signal };
  const reference = targetsOf(context.datasetCase)[0] ?? null;
  const answer = {
    task: context.task,
    systemPrompt: context.systemPrompt,
    answer: context.output.text,
    toolCalls: context.output.toolCalls,
  };
  let votes: JudgeVote[];
  switch (scorer.type) {
    case "rubric":
      votes = await judgeRubric({ ...answer, reference, rubric: scorer.rubric, passThreshold: scorer.passThreshold }, targets, judgeContext);
      break;
    case "checklist":
      votes = await judgeChecklist({ ...answer, reference, items: scorer.items, passThreshold: scorer.passThreshold }, targets, judgeContext);
      break;
    case "reference":
    case "math":
      if (!reference) return { value: 0, passed: false, judges: [], cost: 0, error: "no reference answer" };
      votes = await judgeReference({ ...answer, reference }, targets, judgeContext);
      break;
    case "pairwise_reference": {
      if (!reference) return { value: 0, passed: false, judges: [], cost: 0, error: "no reference answer" };
      const pairwise = await judgePairwise(
        { task: context.task, systemPrompt: context.systemPrompt, criteria: scorer.criteria, answerA: context.output.text, answerB: reference },
        targets,
        judgeContext,
      );
      votes = pairwise.map((vote) => {
        const atLeastAsGood = vote.winner === "a" || vote.winner === "tie";
        return {
          provider: vote.provider,
          model: vote.model,
          value: vote.winner === "a" ? 1 : vote.winner === "tie" ? 0.5 : 0,
          passed: atLeastAsGood,
          verdict: vote.winner === "a" ? "better" : vote.winner === "b" ? "worse" : vote.winner ?? "failed",
          reasoning: vote.reasoning,
          cost: vote.cost,
          error: vote.error,
        };
      });
      break;
    }
    default:
      return { value: 0, passed: false, judges: [], cost: 0, error: `not a model-graded scorer: ${scorer.type}` };
  }
  const aggregate = aggregateVotes(votes);
  return {
    value: aggregate.value,
    passed: aggregate.passed,
    error: aggregate.error,
    judges: votes,
    cost: voteCost(votes),
    explanation: votes.length === 1 ? (votes[0].reasoning ?? undefined) : `${votes.filter((vote) => vote.passed).length}/${votes.length} judges passed it`,
  };
}

// ── Grading a sample ────────────────────────────────────────

/** Grade one sample against its scorers. Never throws: a scorer that breaks fails with `error`. */
export async function gradeSample(scorers: ScorerSpec[], context: ScoringContext): Promise<SampleGrade> {
  const results: ScoreResult[] = new Array(scorers.length);
  const base = (scorer: ScorerSpec, index: number) => ({
    index,
    type: scorer.type,
    label: describeScorer(scorer),
    required: scorer.required ?? true,
    weight: scorer.weight ?? 1,
  });
  // A math scorer with a judge fallback is deterministic first, judged only when that fails.
  const judged = (scorer: ScorerSpec) => MODEL_GRADED_SCORERS.has(scorer.type);
  for (const [index, scorer] of scorers.entries()) {
    if (judged(scorer)) continue;
    try {
      results[index] = { ...base(scorer, index), ...(await scoreDeterministic(scorer, context)) };
    } catch (error: unknown) {
      results[index] = { ...base(scorer, index), value: 0, passed: false, error: getErrorMessage(error) };
    }
  }
  let judgeCost = 0;
  const deterministicFailed = results.some((result) => result && result.required && !result.passed);
  const fallbacks = scorers
    .map((scorer, index) => ({ scorer, index }))
    .filter(({ scorer, index }) => scorer.type === "math" && scorer.judgeFallback && !results[index].passed && !results[index].error);
  const pending = scorers.map((scorer, index) => ({ scorer, index })).filter(({ scorer }) => judged(scorer));
  const otherRequiredFailed = (index: number) =>
    results.some((result, position) => position !== index && result && result.required && !result.passed);
  await Promise.all([
    ...pending.map(async ({ scorer, index }) => {
      if (deterministicFailed) {
        results[index] = { ...base(scorer, index), value: 0, passed: false, skipped: true };
        return;
      }
      const outcome = await scoreWithJudges(scorer, context);
      judgeCost += outcome.cost;
      results[index] = { ...base(scorer, index), ...outcome, cost: outcome.cost };
    }),
    ...fallbacks.map(async ({ scorer, index }) => {
      // Only worth a judge when nothing else already failed the sample.
      if (otherRequiredFailed(index)) return;
      const outcome = await scoreWithJudges({ ...scorer, type: "reference" } as ScorerSpec, context);
      judgeCost += outcome.cost;
      const previous = results[index];
      results[index] = {
        ...previous,
        value: outcome.value,
        passed: outcome.passed,
        judges: outcome.judges,
        cost: outcome.cost,
        explanation: outcome.passed ? "equivalent (judge)" : (outcome.explanation ?? previous.explanation),
        error: outcome.error ?? null,
      };
    }),
  ]);
  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  const score = totalWeight > 0 ? results.reduce((sum, result) => sum + result.weight * result.value, 0) / totalWeight : 0;
  const passed = results.every((result) => !result.required || result.passed);
  return { scores: results, score, passed, judgeCost };
}

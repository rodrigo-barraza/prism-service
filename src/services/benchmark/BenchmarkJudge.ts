/**
 * BenchmarkJudge — LLM-as-judge grading for benchmark results.
 *
 * Grades a model's response against a natural-language rubric using a
 * second model (the judge), returning a strict pass/fail verdict with a
 * 0–10 score and short reasoning. LLM-as-judge follows Zheng et al. 2023,
 * "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"
 * (https://arxiv.org/abs/2306.05685).
 */
import { handleConversation } from "#src/routes/ChatRoutes";
import {
  MODELS,
  MODEL_TYPES,
  getModelByName,
  resolveRecommendedDefault,
} from "#src/config";
import { getProvider } from "#src/providers/index";
import { BENCHMARK, MODALITY_TYPES } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { extractJson } from "#src/services/benchmark/BenchmarkEvaluator";
import type { BenchmarkToolCall, JudgeVerdict } from "#src/types/benchmark";
import type { SseEvent } from "#src/types/SseTypes";

/** Cap on the response text sent to the judge (characters). */
const JUDGE_RESPONSE_CHAR_LIMIT = 12_000;
/** Cap on the tool-trace summary sent to the judge (characters). */
const JUDGE_TOOL_TRACE_CHAR_LIMIT = 4_000;

const JUDGE_SYSTEM_PROMPT = `You are a strict, impartial evaluation judge for LLM benchmark runs.
You will receive a TASK given to a model, the MODEL RESPONSE, and a RUBRIC.
Grade ONLY whether the response satisfies the rubric. Ignore style unless the rubric mentions it.
Respond with STRICT JSON only — no markdown, no commentary:
{"pass": true or false, "score": <integer 0-10>, "reasoning": "<one or two short sentences>"}
A response passes only if it clearly satisfies every requirement of the rubric (score 7 or higher).`;

export interface JudgeRequest {
  rubric: string;
  /** Optional "provider:model" override for the judge model. */
  judgeModel?: string;
  prompt: string;
  systemPrompt?: string | null;
  response: string;
  toolCalls?: BenchmarkToolCall[];
  project: string | null;
  username: string;
  signal?: AbortSignal;
}

interface JudgeTarget {
  provider: string;
  model: string;
}

/** Providers that are actually reachable (API key configured / registered). */
function getAvailableProviders(): Set<string> {
  const available = new Set<string>();
  for (const model of Object.values(MODELS)) {
    if (model.modelType !== MODEL_TYPES.CONVERSATION) continue;
    if (available.has(model.provider)) continue;
    try {
      getProvider(model.provider);
      available.add(model.provider);
    } catch {
      /* provider not configured */
    }
  }
  return available;
}

/**
 * Resolve the judge model: an explicit "provider:model" override when valid,
 * otherwise the recommended default text→text model (cheap + capable).
 */
export function resolveJudgeTarget(judgeModel?: string): JudgeTarget | null {
  if (judgeModel?.includes(":")) {
    const separator = judgeModel.indexOf(":");
    const provider = judgeModel.slice(0, separator);
    const model = judgeModel.slice(separator + 1);
    if (provider && model) {
      try {
        getProvider(provider);
        if (getModelByName(model)) return { provider, model };
        logger.warn(`[benchmark] Judge model not found: ${judgeModel}`);
      } catch {
        logger.warn(`[benchmark] Judge provider unavailable: ${provider}`);
      }
    }
  }
  const recommended = resolveRecommendedDefault(
    MODALITY_TYPES.TEXT,
    MODALITY_TYPES.TEXT,
    getAvailableProviders(),
  );
  return recommended
    ? { provider: recommended.provider, model: recommended.model }
    : null;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

function buildToolTrace(toolCalls: BenchmarkToolCall[] = []): string {
  if (toolCalls.length === 0) return "";
  const lines = toolCalls.map((toolCall, index) => {
    let args: string;
    try {
      args = toolCall.args ? JSON.stringify(toolCall.args) : "";
    } catch {
      args = String(toolCall.args);
    }
    return `${index + 1}. ${toolCall.name || "unknown"}(${truncate(args, 300)}) → ${toolCall.status}`;
  });
  return truncate(lines.join("\n"), JUDGE_TOOL_TRACE_CHAR_LIMIT);
}

interface JudgeCallResult {
  text: string;
  thinkingText: string;
  cost?: number;
  error?: string;
}

/** One judge call: strict-JSON mode, no thinking, temperature 0. Never throws. */
async function callJudge(
  target: JudgeTarget,
  systemPrompt: string,
  userPrompt: string,
  request: Pick<JudgeRequest, "project" | "username" | "signal">,
): Promise<JudgeCallResult> {
  const events: Array<SseEvent & { estimatedCost?: number | null }> = [];
  try {
    await handleConversation(
      {
        provider: target.provider,
        model: target.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: BENCHMARK.JUDGE_TEMPERATURE,
        maxTokens: BENCHMARK.JUDGE_MAX_TOKENS,
        project: request.project,
        username: request.username,
        skipConversation: true,
        // Deterministic verdict plumbing: JSON mode where the provider
        // supports it, and no thinking — adaptive-thinking models (e.g.
        // Gemini Flash) can otherwise stream the start of the JSON verdict
        // inside a thought part, truncating the parseable text.
        responseFormat: "json_object",
        thinkingEnabled: false,
      },
      (event: SseEvent) => {
        events.push(event as SseEvent & { estimatedCost?: number | null });
      },
      { signal: request.signal },
    );
  } catch (error: unknown) {
    return { text: "", thinkingText: "", error: `Judge call failed: ${getErrorMessage(error)}` };
  }
  const errorEvent = events.find((event) => event.type === "error") as
    | { message?: string }
    | undefined;
  const doneEvent = events.find((event) => event.type === "done") as
    | { estimatedCost?: number | null }
    | undefined;
  const cost = doneEvent?.estimatedCost ?? undefined;
  if (errorEvent) {
    return { text: "", thinkingText: "", cost, error: `Judge error: ${errorEvent.message || "unknown"}` };
  }
  const collect = (type: string) =>
    events
      .filter((event) => event.type === type)
      .map((event) => (event as { content?: string }).content || "")
      .join("");
  return { text: collect("chunk"), thinkingText: collect("thinking"), cost };
}

/**
 * Run the judge model and parse its verdict. Never throws — failures come
 * back as a failed verdict with `error` set so runs degrade gracefully.
 */
export async function runJudge(request: JudgeRequest): Promise<JudgeVerdict> {
  const target = resolveJudgeTarget(request.judgeModel);
  if (!target) {
    return {
      passed: false,
      error: "No judge model available (no providers configured)",
    };
  }

  const toolTrace = buildToolTrace(request.toolCalls);
  const userPrompt = [
    `RUBRIC:\n${request.rubric}`,
    request.systemPrompt
      ? `TASK SYSTEM PROMPT:\n${truncate(request.systemPrompt, 2000)}`
      : null,
    `TASK:\n${truncate(request.prompt, 4000)}`,
    toolTrace ? `TOOL CALLS MADE BY THE MODEL:\n${toolTrace}` : null,
    `MODEL RESPONSE:\n${truncate(request.response || "(empty response)", JUDGE_RESPONSE_CHAR_LIMIT)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { text, thinkingText, cost, error } = await callJudge(
    target,
    JUDGE_SYSTEM_PROMPT,
    userPrompt,
    request,
  );
  if (error) {
    return {
      passed: false,
      model: target.model,
      provider: target.provider,
      ...(cost !== undefined && { cost }),
      error,
    };
  }

  // Parse the verdict from the response text; if the model leaked part of
  // the JSON into thinking content, retry on the combined stream.
  type RawVerdict = { pass?: unknown; score?: unknown; reasoning?: unknown };
  let parsed = extractJson(text) as RawVerdict | undefined;
  if ((!parsed || typeof parsed.pass !== "boolean") && thinkingText) {
    parsed = extractJson(thinkingText + text) as RawVerdict | undefined;
  }
  if (!parsed || typeof parsed.pass !== "boolean") {
    return {
      passed: false,
      model: target.model,
      provider: target.provider,
      cost,
      error: `Judge returned an unparseable verdict: ${truncate(text, 200)}`,
    };
  }

  const score =
    typeof parsed.score === "number" && Number.isFinite(parsed.score)
      ? Math.max(0, Math.min(10, Math.round(parsed.score)))
      : undefined;

  return {
    passed: parsed.pass,
    score,
    reasoning:
      typeof parsed.reasoning === "string"
        ? truncate(parsed.reasoning, 600)
        : undefined,
    model: target.model,
    provider: target.provider,
    cost,
  };
}

// ── Pairwise comparison (the baseline grader) ───────────────

const PAIRWISE_SYSTEM_PROMPT = `You are a strict, impartial judge comparing two answers to the same task.
You will receive the TASK, the CRITERIA, ANSWER A and ANSWER B.
Decide which answer better satisfies the criteria. Ignore length, order and style unless the criteria mention them.
Respond with STRICT JSON only — no markdown, no commentary:
{"winner": "A" or "B" or "tie", "reasoning": "<one or two short sentences>"}`;

const DEFAULT_PAIRWISE_CRITERIA =
  "Correctness first, then completeness: which answer solves the task better?";

export interface PairwiseJudgeRequest {
  task: string;
  systemPrompt?: string | null;
  criteria?: string;
  /** The reply under test. */
  candidate: string;
  /** The reference answer it is compared with. */
  reference: string;
  judgeModel?: string;
  project: string | null;
  username: string;
  signal?: AbortSignal;
}

export interface PairwiseVerdict {
  winner: "candidate" | "reference" | "tie";
  reasoning?: string;
  model?: string;
  provider?: string;
  cost?: number;
  error?: string;
}

async function askPairwise(
  target: JudgeTarget,
  request: PairwiseJudgeRequest,
  answerA: string,
  answerB: string,
): Promise<{ winner: "A" | "B" | "tie" | null; reasoning?: string; cost?: number; error?: string }> {
  const userPrompt = [
    `CRITERIA:\n${request.criteria?.trim() || DEFAULT_PAIRWISE_CRITERIA}`,
    request.systemPrompt ? `TASK SYSTEM PROMPT:\n${truncate(request.systemPrompt, 2000)}` : null,
    `TASK:\n${truncate(request.task, 4000)}`,
    `ANSWER A:\n${truncate(answerA || "(empty answer)", JUDGE_RESPONSE_CHAR_LIMIT)}`,
    `ANSWER B:\n${truncate(answerB || "(empty answer)", JUDGE_RESPONSE_CHAR_LIMIT)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { text, thinkingText, cost, error } = await callJudge(
    target,
    PAIRWISE_SYSTEM_PROMPT,
    userPrompt,
    request,
  );
  if (error) return { winner: null, cost, error };
  type RawPairwise = { winner?: unknown; reasoning?: unknown };
  let parsed = extractJson(text) as RawPairwise | undefined;
  if (!parsed?.winner && thinkingText) {
    parsed = extractJson(thinkingText + text) as RawPairwise | undefined;
  }
  const winner = typeof parsed?.winner === "string" ? parsed.winner.trim().toLowerCase() : "";
  if (winner !== "a" && winner !== "b" && winner !== "tie") {
    return { winner: null, cost, error: `Judge returned an unparseable verdict: ${truncate(text, 200)}` };
  }
  return {
    winner: winner === "tie" ? "tie" : winner === "a" ? "A" : "B",
    reasoning: typeof parsed?.reasoning === "string" ? truncate(parsed.reasoning, 600) : undefined,
    cost,
  };
}

/**
 * Compare a reply with a reference answer — twice, with the positions
 * swapped. LLM judges favour a position (Zheng et al. 2023, §3.4 "position
 * bias", https://arxiv.org/abs/2306.05685), so a preference that flips with
 * the order is a tie; either side wins only when both orders agree. Never
 * throws — failures come back with `error` set.
 */
export async function runPairwiseJudge(
  request: PairwiseJudgeRequest,
): Promise<PairwiseVerdict> {
  const target = resolveJudgeTarget(request.judgeModel);
  if (!target) {
    return { winner: "tie", error: "No judge model available (no providers configured)" };
  }
  const identity = { model: target.model, provider: target.provider };
  const candidateFirst = await askPairwise(target, request, request.candidate, request.reference);
  const referenceFirst = await askPairwise(target, request, request.reference, request.candidate);
  const costs = [candidateFirst.cost, referenceFirst.cost].filter(
    (cost): cost is number => typeof cost === "number",
  );
  const cost = costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : undefined;
  const failure = candidateFirst.error || referenceFirst.error;
  if (failure) return { winner: "tie", ...identity, ...(cost !== undefined && { cost }), error: failure };
  const asCandidateFirst = { A: "candidate", B: "reference", tie: "tie" } as const;
  const asReferenceFirst = { A: "reference", B: "candidate", tie: "tie" } as const;
  const first = asCandidateFirst[candidateFirst.winner!];
  const second = asReferenceFirst[referenceFirst.winner!];
  return {
    winner: first === second ? first : "tie",
    reasoning: candidateFirst.reasoning,
    ...identity,
    ...(cost !== undefined && { cost }),
  };
}

const BenchmarkJudge = { runJudge, runPairwiseJudge, resolveJudgeTarget };
export default BenchmarkJudge;

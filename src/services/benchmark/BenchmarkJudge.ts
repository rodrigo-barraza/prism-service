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

  const events: Array<SseEvent & { estimatedCost?: number | null }> = [];
  try {
    await handleConversation(
      {
        provider: target.provider,
        model: target.model,
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: BENCHMARK.JUDGE_TEMPERATURE,
        maxTokens: BENCHMARK.JUDGE_MAX_TOKENS,
        project: request.project,
        username: request.username,
        skipConversation: true,
      },
      (event: SseEvent) => {
        events.push(event as SseEvent & { estimatedCost?: number | null });
      },
      { signal: request.signal },
    );
  } catch (error: unknown) {
    return {
      passed: false,
      model: target.model,
      provider: target.provider,
      error: `Judge call failed: ${getErrorMessage(error)}`,
    };
  }

  const errorEvent = events.find((event) => event.type === "error") as
    | { message?: string }
    | undefined;
  if (errorEvent) {
    return {
      passed: false,
      model: target.model,
      provider: target.provider,
      error: `Judge error: ${errorEvent.message || "unknown"}`,
    };
  }

  const text = events
    .filter((event) => event.type === "chunk")
    .map((event) => (event as { content?: string }).content || "")
    .join("");
  const doneEvent = events.find((event) => event.type === "done") as
    | { estimatedCost?: number | null }
    | undefined;
  const cost = doneEvent?.estimatedCost ?? undefined;

  const parsed = extractJson(text) as
    | { pass?: unknown; score?: unknown; reasoning?: unknown }
    | undefined;
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

const BenchmarkJudge = { runJudge, resolveJudgeTarget };
export default BenchmarkJudge;

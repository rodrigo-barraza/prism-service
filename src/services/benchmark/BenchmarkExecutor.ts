/**
 * BenchmarkExecutor — one contestant answers one case, through the real
 * request path, observed.
 *
 * A contestant runs the way a client would send it: a model without tools
 * through handleConversation, a model with tools or an agent persona
 * through handleAgent (unattended, auto-approved, its harness knobs as the
 * same request fields a client sends). The stream is collected into what
 * scorers need — the reply, the thinking, the tool trace, turns, usage,
 * cost and timing — and failures are classified, so the run can retry an
 * infrastructure error and count a model's own failure. Nothing here grades.
 */
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { handleConversation, handleAgent } from "#src/routes/ChatRoutes";
import logger from "#src/utils/logger";
import type { SseEvent } from "#src/types/SseTypes";
import type {
  CaseMessage,
  Contestant,
  SampleError,
  SampleOutput,
  SampleToolCall,
  SampleUsage,
  SuiteToolPolicy,
} from "#src/types/benchmark";

/** The tools a sample runs with, resolved from the contestant and the suite. */
export type ResolvedTools = SuiteToolPolicy;

export interface ExecutionRequest {
  contestant: Contestant;
  systemPrompt?: string | null;
  /** The conversation, ending on a user turn. */
  messages: CaseMessage[];
  tools: ResolvedTools;
  /** Ceilings from the suite (the contestant's own lower values win). */
  maxIterations?: number | null;
  maxTokens?: number | null;
  workspaceRoot?: string | null;
  project: string | null;
  username: string;
  /** The run's stop (cancel, budget). */
  signal?: AbortSignal;
  /** Wall clock for this sample (milliseconds). */
  timeoutMs: number;
  /** Every streamed event, for live views (arena battles). */
  onEvent?: (event: StreamedEvent) => void;
}

export interface StreamedEvent {
  type: string;
  content?: string;
  message?: string;
  status?: string;
  code?: string;
  retryable?: boolean;
  usage?: Record<string, number | null | undefined> | null;
  estimatedCost?: number | null;
  tokensPerSec?: number | null;
  tokensPerSecond?: number | null;
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  tool?: { id?: string; name?: string; args?: unknown; result?: unknown };
  [key: string]: unknown;
}

export interface Execution {
  output: SampleOutput;
  usage: SampleUsage | null;
  cost: number | null;
  latencyMs: number;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  error: SampleError | null;
}

const CONTENT_EVENT_TYPES = new Set(["chunk", "thinking", "toolCall", "tool_execution", "tool_output"]);
/** Error codes that a later attempt may not repeat. */
const RETRYABLE_CODES = new Set(["rate_limited", "overloaded", "internal"]);
const DEFAULT_AGENT_ITERATIONS = 12;

/** Whether the contestant runs through the agent loop. */
export function usesAgentLoop(contestant: Contestant, tools: ResolvedTools): boolean {
  return contestant.kind === "agent" || tools.mode === "list";
}

/**
 * The tools a sample runs with. A contestant's own list wins. Otherwise a
 * suite that names its tools gives every contestant those; a suite without
 * tools leaves a model with none and an agent with its persona's — an
 * agent's tools are part of what is being measured ("does my agent beat
 * the bare model?"), so contestants validation refuses `tools: "none"` on
 * an agent rather than pretending to strip its core tools.
 */
export function resolveTools(contestant: Contestant, suitePolicy: SuiteToolPolicy): ResolvedTools {
  if (Array.isArray(contestant.tools)) {
    return contestant.tools.length > 0 ? { mode: "list", tools: contestant.tools } : { mode: "none" };
  }
  if (suitePolicy.mode === "list") return suitePolicy;
  if (contestant.kind === "agent") return { mode: "agent" };
  return { mode: "none" };
}

const lowest = (...values: Array<number | null | undefined>) => {
  const present = values.filter((value): value is number => typeof value === "number" && value > 0);
  return present.length > 0 ? Math.min(...present) : undefined;
};

/** The request a client would send for this contestant and case. */
export function buildRequest(request: ExecutionRequest): Record<string, unknown> {
  const { contestant, tools } = request;
  const systemParts = [contestant.systemPrompt, request.systemPrompt].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  const messages = [
    ...(systemParts.length > 0 ? [{ role: "system", content: systemParts.join("\n\n") }] : []),
    ...request.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  const agentLoop = usesAgentLoop(contestant, tools);
  const harness = contestant.harness ?? {};
  const maxTokens = lowest(contestant.maxTokens, request.maxTokens);
  return {
    provider: contestant.provider,
    model: contestant.model,
    messages,
    project: request.project,
    username: request.username,
    skipConversation: true,
    ...(contestant.temperature != null && { temperature: contestant.temperature }),
    ...(contestant.topP != null && { topP: contestant.topP }),
    ...(contestant.seed != null && { seed: contestant.seed }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(contestant.effort && {
      thinkingEnabled: contestant.effort !== "none",
      ...(contestant.effort !== "none" && { reasoningEffort: contestant.effort }),
    }),
    ...(contestant.webSearch != null && { webSearch: contestant.webSearch }),
    ...(agentLoop && {
      ...(contestant.kind === "agent" && contestant.agent && { agent: contestant.agent }),
      agenticLoopEnabled: true,
      autoApprove: true,
      // Nobody is watching: an ask no "approve all" answers is denied, not parked.
      unattended: true,
      onBudgetReached: "stop",
      maxIterations: lowest(harness.maxIterations, request.maxIterations) ?? DEFAULT_AGENT_ITERATIONS,
      ...(harness.toolDiscovery && { toolDiscovery: harness.toolDiscovery }),
      ...(harness.compactionThreshold && { contextWindowLimit: harness.compactionThreshold }),
      ...(harness.topology && { topology: harness.topology }),
      ...(harness.thoughtStructure && { thoughtStructure: harness.thoughtStructure }),
      ...(tools.mode === "list" && {
        functionCallingEnabled: true,
        enabledTools: tools.tools,
      }),
      ...(request.workspaceRoot && { workspaceRoot: request.workspaceRoot }),
    }),
  };
}

function normaliseUsage(raw: Record<string, number | null | undefined> | null | undefined): SampleUsage | null {
  if (!raw) return null;
  const read = (key: string) => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  const input = read("totalInputTokens") || read("inputTokens") + read("cacheReadInputTokens") + read("cacheCreationInputTokens");
  return {
    inputTokens: input,
    outputTokens: read("outputTokens"),
    reasoningTokens: read("reasoningOutputTokens"),
    cacheReadTokens: read("cacheReadInputTokens"),
    cacheWriteTokens: read("cacheCreationInputTokens"),
  };
}

/** A failure: whether sending the same sample again could succeed. */
export function classifyFailure(
  message: string,
  { code, retryable, timedOut, cancelled }: { code?: string; retryable?: boolean; timedOut?: boolean; cancelled?: boolean },
): SampleError {
  if (cancelled) return { kind: "cancelled", message, retryable: false };
  if (timedOut) return { kind: "timeout", message, retryable: false };
  if (code === "refusal") return { kind: "refusal", message, retryable: false };
  if (code === "tool_failure") return { kind: "harness", message, retryable: false };
  if (code) {
    return { kind: "provider", message, retryable: retryable ?? RETRYABLE_CODES.has(code) };
  }
  const transient = /\b(429|5\d\d|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|overloaded|rate limit|ended early)\b/i;
  return { kind: "provider", message, retryable: retryable ?? transient.test(message) };
}

const emptyOutput = (): SampleOutput => ({ text: "", thinking: null, toolCalls: [], turns: 0 });

/** Run one sample and observe it. Never throws — failures come back in `error`. */
export async function executeSample(request: ExecutionRequest): Promise<Execution> {
  const { contestant, signal } = request;
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  if (signal?.aborted) {
    return {
      output: emptyOutput(),
      usage: null,
      cost: null,
      latencyMs: 0,
      ttftMs: null,
      tokensPerSecond: null,
      error: classifyFailure("Run stopped", { cancelled: true }),
    };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  const events: StreamedEvent[] = [];
  let firstContentAt: number | null = null;
  const tools = request.tools;
  const handler = usesAgentLoop(contestant, tools) ? handleAgent : handleConversation;
  try {
    await handler(
      buildRequest(request),
      (event: SseEvent) => {
        const streamed = event as SseEvent & StreamedEvent;
        events.push(streamed);
        if (CONTENT_EVENT_TYPES.has(streamed.type) && firstContentAt === null) firstContentAt = performance.now();
        if (request.onEvent) {
          try {
            request.onEvent(streamed);
          } catch {
            /* a listener never breaks a sample */
          }
        }
      },
      { signal: controller.signal },
    );
  } catch (error: unknown) {
    events.push({ type: "error", message: getErrorMessage(error) });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
  const latencyMs = elapsed();
  const ttftMs = firstContentAt !== null ? Math.round(firstContentAt - start) : null;

  const text = events
    .filter((event) => event.type === "chunk")
    .map((event) => event.content ?? "")
    .join("");
  const thinking = events
    .filter((event) => event.type === "thinking")
    .map((event) => event.content ?? "")
    .join("");
  // Tool calls come from two paths: "toolCall" with status done (native
  // provider tools), and "tool_execution" done/error (the agent loop).
  const toolCalls: SampleToolCall[] = [
    ...events
      .filter((event) => event.type === "toolCall" && event.status === "done")
      .map((event) => ({ id: event.id, name: event.name, args: event.args, result: event.result, status: "done" })),
    ...events
      .filter((event) => event.type === "tool_execution" && (event.status === "done" || event.status === "error"))
      .map((event) => ({
        id: event.tool?.id,
        name: event.tool?.name,
        args: event.tool?.args,
        result: event.tool?.result,
        status: event.status || "done",
      })),
  ];
  const doneEvents = events.filter((event) => event.type === "done");
  const done = doneEvents[doneEvents.length - 1];
  const rawUsage = (done?.usage ?? null) as Record<string, number | null | undefined> | null;
  const usage = normaliseUsage(rawUsage);
  const turns =
    (typeof rawUsage?.requests === "number" && rawUsage.requests > 0 ? rawUsage.requests : 0) ||
    doneEvents.length ||
    (text ? 1 : 0);
  const reportedRate = done?.tokensPerSec ?? done?.tokensPerSecond;
  let tokensPerSecond = typeof reportedRate === "number" && reportedRate > 0 ? reportedRate : null;
  if (tokensPerSecond === null && usage?.outputTokens) {
    const generationSeconds = Math.max((latencyMs - (ttftMs ?? 0)) / 1000, 0.001);
    tokensPerSecond = Math.round((usage.outputTokens / generationSeconds) * 10) / 10;
  }
  const cost = typeof done?.estimatedCost === "number" ? done.estimatedCost : null;
  const output: SampleOutput = {
    text,
    thinking: thinking || null,
    toolCalls,
    turns,
  };

  const errorEvent = events.find((event) => event.type === "error");
  let error: SampleError | null = null;
  if (timedOut) {
    error = classifyFailure(`No answer within ${Math.round(request.timeoutMs / 1000)} s`, { timedOut: true });
  } else if (signal?.aborted) {
    error = classifyFailure("Run stopped", { cancelled: true });
  } else if (errorEvent) {
    error = classifyFailure(errorEvent.message || "Unknown error", {
      code: typeof errorEvent.code === "string" ? errorEvent.code : undefined,
      retryable: typeof errorEvent.retryable === "boolean" ? errorEvent.retryable : undefined,
    });
  } else if (!done && !text && toolCalls.length === 0) {
    error = classifyFailure("The stream ended without an answer", {});
  }
  if (error) {
    logger.warn(`[benchmark] ${contestant.label}: ${error.kind} — ${error.message}`);
  }
  return { output, usage, cost, latencyMs, ttftMs, tokensPerSecond, error };
}

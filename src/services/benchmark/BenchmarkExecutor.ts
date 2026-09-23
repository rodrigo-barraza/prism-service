/**
 * BenchmarkExecutor — one prompt through the real request path, observed.
 *
 * Runs a prompt the way a client would (handleAgent when the target is an
 * agent or has tools, handleConversation otherwise), collects the stream,
 * and returns what graders need: the reply, the thinking, the tool trace,
 * turns, usage, cost and timing. Nothing here grades — single-prompt
 * benchmarks (BenchmarkService) and dataset runs (DatasetRunner) both build
 * on it. Harness settings (effort, compaction threshold, tool discovery,
 * topology) and a workspace root become the same request fields a client
 * would send.
 */
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { handleConversation, handleAgent } from "#src/routes/ChatRoutes";
import logger from "#src/utils/logger";
import { BENCHMARK } from "#src/constants";
import type { SseEvent } from "#src/types/SseTypes";
import type { BenchmarkToolCall, HarnessSettings } from "#src/types/benchmark";

export interface BenchmarkExecutionTarget {
  provider: string;
  model: string;
  thinkingEnabled?: boolean;
  toolsEnabled?: boolean;
  agent?: string;
  locale?: string;
  enabledTools?: string[];
}

export interface BenchmarkExecutionRequest {
  prompt: string;
  systemPrompt?: string | null;
  target: BenchmarkExecutionTarget;
  /** Tools the run is limited to (undefined: the persona's own). */
  enabledTools?: string[];
  /** True when the tools above were chosen for this run, not defaulted. */
  constrainTools?: boolean;
  temperature?: number;
  maxTokens?: number;
  settings?: HarnessSettings;
  /** The run's workspace root (a dataset case's scratch workspace). */
  workspaceRoot?: string | null;
  project: string | null;
  username: string;
  signal?: AbortSignal;
  onEvent?: (event: BenchmarkEvent) => void;
}

export interface BenchmarkEvent {
  type: string;
  content?: string;
  message?: string;
  status?: string;
  usage?: Record<string, number>;
  estimatedCost?: number | null;
  tokensPerSecond?: number | null;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  tool?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
    result?: unknown;
  };
  [key: string]: unknown;
}

export interface BenchmarkExecution {
  response: string;
  thinking: string;
  toolCalls: BenchmarkToolCall[];
  toolNames: string[];
  turnCount: number;
  usage: Record<string, number> | null;
  estimatedCost: number | null;
  /** Seconds, unrounded. */
  latency: number;
  ttftMilliseconds: number | null;
  tokensPerSecond: number | null;
  /** Set when the run failed (an error event, a throw, an abort). */
  error: string | null;
}

/** Whether a target runs through the agent loop (tools, persona) or as a plain chat. */
export function usesAgentHandler(target: BenchmarkExecutionTarget): boolean {
  return !!(target.agent || target.toolsEnabled);
}

/**
 * The request fields a run's harness settings become. Effort needs thinking
 * on — ChatRoutes strips every thinking sub-parameter when it is off — and
 * "none" turns it off.
 */
export function harnessSettingParams(settings: HarnessSettings = {}): Record<string, unknown> {
  return {
    ...(settings.effort && {
      thinkingEnabled: settings.effort !== "none",
      reasoningEffort: settings.effort,
    }),
    ...(settings.compactionThreshold && {
      contextWindowLimit: settings.compactionThreshold,
    }),
    ...(settings.toolDiscovery && { toolDiscovery: settings.toolDiscovery }),
    ...(settings.topology && { topology: settings.topology }),
  };
}

const CONTENT_EVENT_TYPES = new Set([
  "chunk",
  "thinking",
  "toolCall",
  "tool_execution",
  "tool_output",
]);

/** Run one prompt and observe it. Never throws — failures come back in `error`. */
export async function executeBenchmarkPrompt(
  request: BenchmarkExecutionRequest,
): Promise<BenchmarkExecution> {
  const { target, signal, onEvent } = request;
  const failure = (latency: number, error: string): BenchmarkExecution => ({
    response: "",
    thinking: "",
    toolCalls: [],
    toolNames: [],
    turnCount: 0,
    usage: null,
    estimatedCost: null,
    latency,
    ttftMilliseconds: null,
    tokensPerSecond: null,
    error,
  });
  if (signal?.aborted) {
    logger.info(`[benchmark] ⏭ Skipping ${target.provider}/${target.model} — already aborted`);
    return failure(0, "Aborted");
  }

  const start = performance.now();
  let firstContentAt: number | null = null;
  const messages: Array<{ role: string; content: string }> = [];
  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  messages.push({ role: "user", content: request.prompt });
  logger.info(`[benchmark] ▶ Running ${target.provider}/${target.model}`);

  try {
    const events: BenchmarkEvent[] = [];
    const useAgentHandler = usesAgentHandler(target);
    const handler = useAgentHandler ? handleAgent : handleConversation;
    const enabledTools = request.enabledTools;
    await handler(
      {
        provider: target.provider,
        model: target.model,
        messages,
        temperature: request.temperature ?? 0,
        maxTokens: Math.max(
          request.maxTokens ?? BENCHMARK.DEFAULT_MAX_TOKENS,
          BENCHMARK.DEFAULT_MAX_TOKENS,
        ),
        project: request.project,
        username: request.username,
        skipConversation: true,
        thinkingEnabled: target.thinkingEnabled || false,
        ...(target.locale && { locale: target.locale }),
        ...(useAgentHandler && {
          ...(target.agent && { agent: target.agent }),
          agenticLoopEnabled: true,
          autoApprove: true,
          // Unattended: an ask no "approve all" answers is denied, not parked.
          unattended: true,
          maxIterations: 10,
        }),
        // Plain models with tools get an explicit tool set; agents keep
        // their persona's tools unless the run constrains them.
        ...(target.toolsEnabled &&
          !target.agent &&
          enabledTools && {
            functionCallingEnabled: true,
            enabledTools,
          }),
        ...(target.agent &&
          enabledTools &&
          request.constrainTools && {
            enabledTools,
          }),
        ...(useAgentHandler && request.workspaceRoot && { workspaceRoot: request.workspaceRoot }),
        ...harnessSettingParams(request.settings),
      },
      (event: SseEvent) => {
        const benchmarkEvent = event as SseEvent & BenchmarkEvent;
        events.push(benchmarkEvent);
        const isContentEvent = CONTENT_EVENT_TYPES.has(benchmarkEvent.type);
        // Time-to-first-token: first streamed content of any kind
        if (isContentEvent && firstContentAt === null) {
          firstContentAt = performance.now();
        }
        // Forward chunk/thinking/tool events in real-time for live preview
        if (isContentEvent && onEvent) {
          try {
            onEvent(benchmarkEvent);
          } catch {
            /* noop */
          }
        }
        if (benchmarkEvent.type === "chunk") {
          logger.info(
            `[benchmark]   📦 ${target.model} chunk (${benchmarkEvent.content?.length || 0} chars)`,
          );
        } else if (benchmarkEvent.type === "error") {
          logger.error(`[benchmark]   ❌ ${target.model} error: ${benchmarkEvent.message}`);
        } else if (benchmarkEvent.type === "done") {
          logger.info(
            `[benchmark]   ✅ ${target.model} done — usage: ${JSON.stringify(benchmarkEvent.usage || null)}, cost: ${benchmarkEvent.estimatedCost ?? "N/A"}`,
          );
        } else {
          logger.info(`[benchmark]   📨 ${target.model} event: ${benchmarkEvent.type}`);
        }
      },
      { signal },
    );
    const latency = (performance.now() - start) / 1000;
    const eventTypes = events.map((event) => event.type);
    logger.info(
      `[benchmark] ◀ ${target.model} finished in ${latency.toFixed(2)}s — events: [${eventTypes.join(", ")}]`,
    );
    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent) {
      logger.warn(`[benchmark]   ⚠ ${target.model} returned error event: ${errorEvent.message}`);
      return failure(latency, errorEvent.message || "Unknown error");
    }
    const text = events
      .filter((event) => event.type === "chunk")
      .map((event) => event.content)
      .join("");
    if (!text) {
      logger.warn(
        `[benchmark]   ⚠ ${target.model} produced NO text — chunk count: ${events.filter((event) => event.type === "chunk").length}, all events: ${JSON.stringify(eventTypes)}`,
      );
    }
    const doneEvent = events.find((event) => event.type === "done") || ({} as BenchmarkEvent);
    const thinkingText = events
      .filter((event) => event.type === "thinking")
      .map((event) => event.content)
      .join("");
    // Tool calls come from two event paths:
    // - "toolCall" with status "done" — native MCP path (e.g. LM Studio)
    // - "tool_execution" with status "done"/"error" — standard agentic path
    const nativeToolCalls: BenchmarkToolCall[] = events
      .filter((event) => event.type === "toolCall" && event.status === "done")
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        result: toolCall.result,
        status: "done",
      }));
    const agenticToolCalls: BenchmarkToolCall[] = events
      .filter(
        (event) =>
          event.type === "tool_execution" &&
          (event.status === "done" || event.status === "error"),
      )
      .map((event) => ({
        id: event.tool?.id,
        name: event.tool?.name,
        args: event.tool?.args,
        result: event.tool?.result,
        status: event.status || "done",
      }));
    const toolCalls = [...nativeToolCalls, ...agenticToolCalls];
    const toolNames = [
      ...new Set(
        toolCalls.map((toolCall) => toolCall.name).filter((name): name is string => Boolean(name)),
      ),
    ];
    // A turn is roughly: user→model→(tools)→model. "done" events mark turns.
    const turnCount = events.filter((event) => event.type === "done").length || 1;
    const ttftMilliseconds = firstContentAt !== null ? Math.round(firstContentAt - start) : null;
    const usage = (doneEvent.usage as Record<string, number>) || null;
    let tokensPerSecond =
      typeof doneEvent.tokensPerSecond === "number" && doneEvent.tokensPerSecond > 0
        ? doneEvent.tokensPerSecond
        : null;
    if (tokensPerSecond === null && usage?.outputTokens) {
      const generationSeconds =
        ttftMilliseconds !== null ? Math.max(latency - ttftMilliseconds / 1000, 0.001) : latency;
      if (generationSeconds > 0) {
        tokensPerSecond = Math.round((usage.outputTokens / generationSeconds) * 10) / 10;
      }
    }
    return {
      response: text,
      thinking: thinkingText,
      toolCalls,
      toolNames,
      turnCount,
      usage,
      estimatedCost: (doneEvent.estimatedCost as number) ?? null,
      latency,
      ttftMilliseconds,
      tokensPerSecond,
      error: null,
    };
  } catch (error: unknown) {
    const latency = (performance.now() - start) / 1000;
    logger.error(`[benchmark]   💥 ${target.model} threw: ${getErrorMessage(error)}`);
    return failure(latency, getErrorMessage(error));
  }
}

/**
 * The tools a target runs with: its own selection, then the benchmark's or
 * dataset's, then the legacy calculator-only default for plain models with
 * tools on.
 */
export function resolveEnabledTools(
  ownerTools: string[] | undefined,
  target: BenchmarkExecutionTarget,
): string[] | undefined {
  if (target.enabledTools?.length) return target.enabledTools;
  if (ownerTools?.length) return ownerTools;
  if (target.toolsEnabled) return [TOOL_NAMES.CALCULATE_PRECISE];
  return undefined;
}

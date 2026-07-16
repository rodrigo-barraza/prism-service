import { sleep, roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
// ─── Custom LLM Accuracy & Behavior Benchmarking ─────────────
import crypto from "crypto";
import { handleConversation, handleAgent } from "#src/routes/ChatRoutes";
import { MODELS, MODEL_TYPES, getModelByName } from "#src/config";
import { getProvider } from "#src/providers/index";
import { isInstance } from "#src/providers/instance-registry";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import logger from "#src/utils/logger";
import { COLLECTIONS, BENCHMARK, BENCHMARK_MATCH_MODES } from "#src/constants";
import {
  matchText,
  evaluateBenchmark,
  collectBehaviorAssertions,
} from "#src/services/benchmark/BenchmarkEvaluator";
import { runJudge } from "#src/services/benchmark/BenchmarkJudge";
import type { SseEvent } from "#src/types/SseTypes";
import type {
  AgentAssertion,
  AssertionResult,
  BenchmarkToolCall,
  JudgeVerdict,
  TextAssertion,
} from "#src/types/benchmark";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

const BENCHMARKS_COLLECTION = COLLECTIONS.BENCHMARKS;
const RUNS_COLLECTION = COLLECTIONS.BENCHMARK_RUNS;

// In-memory counter: how many benchmark model calls are actively generating
let activeGenerationCount = 0;

// ── Types ────────────────────────────────────────────────────

interface BenchmarkDoc {
  id: string;
  name: string;
  prompt: string;
  systemPrompt?: string | null;
  expectedValue?: string;
  matchMode?: string;
  benchmarkMode?: "model" | "agent" | "combined";
  assertions?: TextAssertion[];
  assertionOperator?: "AND" | "OR";
  agentAssertions?: AgentAssertion[];
  agentAssertionOperator?: "AND" | "OR";
  enabledTools?: string[];
  trials?: number;
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
  [key: string]: unknown;
}

interface ModelTarget {
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

interface ModelEntry {
  provider: string;
  model: string;
  label: string;
  thinkingEnabled: boolean;
  toolsEnabled: boolean;
  agent?: string;
  locale?: string;
  enabledTools?: string[];
  trial?: number;
  trialCount?: number;
}

interface BenchmarkEvent {
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

interface ModelResult {
  provider: string;
  model: string;
  label: string;
  thinkingEnabled: boolean;
  toolsEnabled: boolean;
  agent?: string;
  locale?: string;
  response: string | null;
  thinking: string | null;
  toolCalls?: BenchmarkToolCall[] | null;
  toolNames?: string[];
  passed: boolean;
  matchMode: string;
  assertionResults?: AssertionResult[];
  turnCount?: number;
  trial?: number;
  trialCount?: number;
  latency: number;
  ttftMs?: number | null;
  tokensPerSecond?: number | null;
  usage: Record<string, number> | null;
  estimatedCost: number | null;
  judgeCost?: number;
  error: string | null;
  completedAt: string;
}

interface RunBenchmarkOptions {
  onRunStart?: (info: { totalModels: number }) => void;
  onModelStart?: (model: ModelEntry & { isLocal: boolean }) => void;
  onModelComplete?: (result: ModelResult) => void;
  onEvent?: (event: BenchmarkEvent) => void;
  signal?: AbortSignal;
  /** Repeated executions per target (defaults to the benchmark's own `trials`). */
  trials?: number;
}

interface BenchmarkWriteData {
  name: string;
  prompt: string;
  systemPrompt?: string | null;
  expectedValue?: string;
  matchMode?: string;
  benchmarkMode?: string;
  assertions?: TextAssertion[];
  assertionOperator?: string;
  agentAssertions?: AgentAssertion[];
  agentAssertionOperator?: string;
  enabledTools?: string[];
  trials?: number;
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
}

// ─── list available conversation models ─────────────────────
/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
function getConversationModels(): ModelEntry[] {
  const results: ModelEntry[] = [];
  for (const model of Object.values(MODELS)) {
    if (model.modelType !== MODEL_TYPES.CONVERSATION) continue;
    if ((model as Record<string, unknown>).listed === false) continue;
    // Skip image-only output models (no text output)
    if (!model.outputTypes?.includes("text")) continue;
    // Skip image API models (generate images, not text completions)
    if ((model as Record<string, unknown>).imageAPI) continue;
    results.push({
      provider: model.provider,
      model: model.name,
      label: model.label,
      thinkingEnabled: false,
      toolsEnabled: false,
    });
  }
  return results;
}
/**
 * Filter a model list to only those whose providers are actually
 * reachable (have API keys configured / servers running).
 * For cloud providers we check if getProvider() doesn't throw.
 * For local providers we also do a quick health check.
 */
function filterAvailableModels(models: ModelEntry[]): ModelEntry[] {
  const checked = new Map<string, boolean>();
  return models.filter((model) => {
    if (checked.has(model.provider)) return checked.get(model.provider);
    try {
      getProvider(model.provider);
      checked.set(model.provider, true);
      return true;
    } catch {
      checked.set(model.provider, false);
      return false;
    }
  });
}

/**
 * Resolve which tools a target runs with. Per-target selection wins, then
 * the benchmark's own tool set, then the legacy calculator-only default.
 */
function resolveEnabledTools(
  benchmark: BenchmarkDoc,
  model: ModelEntry,
): string[] | undefined {
  if (model.enabledTools?.length) return model.enabledTools;
  if (benchmark.enabledTools?.length) return benchmark.enabledTools;
  if (model.toolsEnabled) return [TOOL_NAMES.CALCULATE_PRECISE];
  return undefined;
}

/** Run the llm_judge assertions of a benchmark and map verdicts by index. */
async function collectJudgeVerdicts(
  benchmark: BenchmarkDoc,
  executionData: {
    response: string | null;
    thinking: string | null;
    toolCalls: BenchmarkToolCall[];
    turnCount: number;
  },
  project: string | null,
  username: string,
  signal?: AbortSignal,
): Promise<Map<number, JudgeVerdict>> {
  const verdicts = new Map<number, JudgeVerdict>();
  const assertions = benchmark.agentAssertions || [];
  for (let index = 0; index < assertions.length; index++) {
    const assertion = assertions[index];
    if (assertion?.type !== "llm_judge") continue;
    if (signal?.aborted) {
      verdicts.set(index, { passed: false, error: "Aborted" });
      continue;
    }
    if (!assertion.rubric?.trim()) {
      verdicts.set(index, { passed: false, error: "Missing rubric" });
      continue;
    }
    const verdict = await runJudge({
      rubric: assertion.rubric,
      judgeModel: assertion.judgeModel,
      prompt: benchmark.prompt,
      systemPrompt: benchmark.systemPrompt,
      response: executionData.response || "",
      toolCalls: executionData.toolCalls,
      project,
      username,
      signal,
    });
    verdicts.set(index, verdict);
  }
  return verdicts;
}

// ─── Run a single model against a benchmark prompt ──────────
async function runSingleModel(
  benchmark: BenchmarkDoc,
  model: ModelEntry,
  project: string | null,
  username: string,
  {
    signal,
    onEvent,
  }: { signal?: AbortSignal; onEvent?: (event: BenchmarkEvent) => void } = {},
): Promise<ModelResult> {
  // Config flags carried on every result for stats differentiation
  const configFlags = {
    thinkingEnabled: model.thinkingEnabled || false,
    toolsEnabled: model.toolsEnabled || false,
    ...(model.agent && { agent: model.agent }),
    ...(model.locale && { locale: model.locale }),
    ...(model.trialCount &&
      model.trialCount > 1 && {
        trial: model.trial,
        trialCount: model.trialCount,
      }),
  };
  const failureShell = (latencySeconds: number, error: string): ModelResult => ({
    provider: model.provider,
    model: model.model,
    label: model.label,
    ...configFlags,
    response: null,
    thinking: null,
    passed: false,
    matchMode: benchmark.matchMode || BENCHMARK_MATCH_MODES.CONTAINS,
    latency: roundMilliseconds(latencySeconds),
    ttftMs: null,
    tokensPerSecond: null,
    usage: null,
    estimatedCost: null,
    error,
    completedAt: new Date().toISOString(),
  });

  // Bail immediately if already aborted
  if (signal?.aborted) {
    logger.info(
      `[benchmark] ⏭ Skipping ${model.provider}/${model.model} — already aborted`,
    );
    return failureShell(0, "Aborted");
  }
  const start = performance.now();
  let firstContentAt: number | null = null;
  const messages: Array<{ role: string; content: string }> = [];
  // Optional system prompt
  if (benchmark.systemPrompt) {
    messages.push({ role: "system", content: benchmark.systemPrompt });
  }
  messages.push({ role: "user", content: benchmark.prompt });
  logger.info(`[benchmark] ▶ Running ${model.provider}/${model.model}`);
  try {
    const events: BenchmarkEvent[] = [];
    const useAgentHandler = !!(model.agent || model.toolsEnabled);
    const handler = useAgentHandler ? handleAgent : handleConversation;
    const enabledTools = resolveEnabledTools(benchmark, model);
    await handler(
      {
        provider: model.provider,
        model: model.model,
        messages,
        temperature: benchmark.temperature ?? 0,
        maxTokens: Math.max(benchmark.maxTokens ?? BENCHMARK.DEFAULT_MAX_TOKENS, BENCHMARK.DEFAULT_MAX_TOKENS),
        project,
        username,
        skipConversation: true,
        thinkingEnabled: model.thinkingEnabled || false,
        ...(model.locale && { locale: model.locale }),
        ...(useAgentHandler && {
          ...(model.agent && { agent: model.agent }),
          agenticLoopEnabled: true,
          autoApprove: true,
          maxIterations: 10,
        }),
        // Plain models with tools get an explicit tool set; agents keep
        // their persona's tools unless the benchmark constrains them.
        ...(model.toolsEnabled &&
          !model.agent &&
          enabledTools && {
            functionCallingEnabled: true,
            enabledTools,
          }),
        ...(model.agent &&
          enabledTools &&
          (model.enabledTools?.length || benchmark.enabledTools?.length) && {
            enabledTools,
          }),
      },
      (event: SseEvent) => {
        const benchmarkEvent = event as SseEvent & BenchmarkEvent;
        events.push(benchmarkEvent);
        const isContentEvent =
          benchmarkEvent.type === "chunk" ||
          benchmarkEvent.type === "thinking" ||
          benchmarkEvent.type === "toolCall" ||
          benchmarkEvent.type === "tool_execution" ||
          benchmarkEvent.type === "tool_output";
        // Time-to-first-token: first streamed content of any kind
        if (isContentEvent && firstContentAt === null) {
          firstContentAt = performance.now();
        }
        // Forward chunk/thinking/tool events in real-time for live preview
        if (isContentEvent) {
          if (onEvent) {
            try {
              onEvent(benchmarkEvent);
            } catch {
              /* noop */
            }
          }
        }
        // Log every event for debugging
        if (benchmarkEvent.type === "chunk") {
          logger.info(
            `[benchmark]   📦 ${model.model} chunk (${benchmarkEvent.content?.length || 0} chars)`,
          );
        } else if (benchmarkEvent.type === "error") {
          logger.error(
            `[benchmark]   ❌ ${model.model} error: ${benchmarkEvent.message}`,
          );
        } else if (benchmarkEvent.type === "done") {
          logger.info(
            `[benchmark]   ✅ ${model.model} done — usage: ${JSON.stringify(benchmarkEvent.usage || null)}, cost: ${benchmarkEvent.estimatedCost ?? "N/A"}`,
          );
        } else {
          logger.info(
            `[benchmark]   📨 ${model.model} event: ${benchmarkEvent.type}`,
          );
        }
      },
      { signal },
    );
    const latency = (performance.now() - start) / 1000;
    // Log all event types received
    const eventTypes = events.map((e) => e.type);
    logger.info(
      `[benchmark] ◀ ${model.model} finished in ${latency.toFixed(2)}s — events: [${eventTypes.join(", ")}]`,
    );
    // Check for errors
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      logger.warn(
        `[benchmark]   ⚠ ${model.model} returned error event: ${errorEvent.message}`,
      );
      return failureShell(latency, errorEvent.message || "Unknown error");
    }
    // Extract text response
    const text = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content)
      .join("");
    if (!text) {
      logger.warn(
        `[benchmark]   ⚠ ${model.model} produced NO text — chunk count: ${events.filter((e) => e.type === "chunk").length}, all events: ${JSON.stringify(eventTypes)}`,
      );
    }
    const doneEvent =
      events.find((e) => e.type === "done") || ({} as BenchmarkEvent);
    const matchMode = benchmark.matchMode || BENCHMARK_MATCH_MODES.CONTAINS;
    // Extract thinking content (emitted as type: "thinking")
    const thinkingText = events
      .filter((e) => e.type === "thinking")
      .map((e) => e.content)
      .join("");
    // Extract tool calls from both event paths:
    // - "toolCall" with status "done" — native MCP path (e.g. LM Studio)
    // - "tool_execution" with status "done"/"error" — standard agentic path
    const nativeToolCalls: BenchmarkToolCall[] = events
      .filter((e) => e.type === "toolCall" && e.status === "done")
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        result: toolCall.result,
        status: "done",
      }));
    const agenticToolCalls: BenchmarkToolCall[] = events
      .filter(
        (eventItem) =>
          eventItem.type === "tool_execution" &&
          (eventItem.status === "done" || eventItem.status === "error"),
      )
      .map((eventItem) => ({
        id: eventItem.tool?.id,
        name: eventItem.tool?.name,
        args: eventItem.tool?.args,
        result: eventItem.tool?.result,
        status: eventItem.status || "done",
      }));
    const toolCalls = [...nativeToolCalls, ...agenticToolCalls];
    const toolCallsResult = toolCalls.length > 0 ? toolCalls : null;
    const toolNames: string[] = toolCallsResult
      ? [...new Set(
          toolCallsResult
            .map((toolCall) => toolCall.name)
            .filter((name): name is string => Boolean(name)),
        )]
      : [];
    // Count agentic loop turns (each chunk of tool calls + response = 1 turn)
    // A turn is roughly: user→model→(tools)→model. Count "done" events as turn markers.
    const turnCount = events.filter((e) => e.type === "done").length || 1;

    // ── Timing metrics ────────────────────────────────────────
    const ttftMs =
      firstContentAt !== null ? Math.round(firstContentAt - start) : null;
    const usage = (doneEvent.usage as Record<string, number>) || null;
    let tokensPerSecond =
      typeof doneEvent.tokensPerSecond === "number" &&
      doneEvent.tokensPerSecond > 0
        ? doneEvent.tokensPerSecond
        : null;
    if (tokensPerSecond === null && usage?.outputTokens) {
      const generationSeconds =
        ttftMs !== null ? Math.max(latency - ttftMs / 1000, 0.001) : latency;
      if (generationSeconds > 0) {
        tokensPerSecond =
          Math.round((usage.outputTokens / generationSeconds) * 10) / 10;
      }
    }

    // ── Evaluation: text + behavioral assertions (+ LLM judge) ─
    const executionData = {
      response: text,
      thinking: thinkingText,
      toolCalls,
      turnCount,
    };
    const hasJudge = collectBehaviorAssertions(benchmark).some(
      (assertion) => assertion.type === "llm_judge",
    );
    const judgeVerdicts = hasJudge
      ? await collectJudgeVerdicts(
          benchmark,
          executionData,
          project,
          username,
          signal,
        )
      : new Map<number, JudgeVerdict>();
    const evaluation = evaluateBenchmark(benchmark, executionData, judgeVerdicts);
    const judgeCost = [...judgeVerdicts.values()].reduce(
      (sum, verdict) => sum + (verdict.cost || 0),
      0,
    );

    return {
      provider: model.provider,
      model: model.model,
      label: model.label,
      ...configFlags,
      response: text || null,
      thinking: thinkingText || null,
      toolCalls: toolCallsResult,
      toolNames,
      passed: evaluation.passed,
      matchMode,
      assertionResults: evaluation.assertionResults,
      turnCount,
      latency: roundMilliseconds(latency),
      ttftMs,
      tokensPerSecond,
      usage,
      estimatedCost: (doneEvent.estimatedCost as number) ?? null,
      ...(judgeCost > 0 && { judgeCost }),
      error: null,
      completedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    const latency = (performance.now() - start) / 1000;
    logger.error(
      `[benchmark]   💥 ${model.model} threw: ${getErrorMessage(error)}`,
    );
    return failureShell(latency, getErrorMessage(error));
  }
}
// ─── public API ─────────────────────────────────────────────
const BenchmarkService = {
  BENCHMARK_MATCH_MODES,
  evaluate: matchText,
  getConversationModels,
  /** Number of benchmark model calls currently in-flight. */
  get activeGenerationCount() {
    return activeGenerationCount;
  },
  async runBenchmark(
    benchmark: BenchmarkDoc,
    modelTargets: ModelTarget[] | null,
    project: string | null,
    username: string,
    {
      onRunStart,
      onModelStart,
      onModelComplete,
      onEvent,
      signal,
      trials,
    }: RunBenchmarkOptions = {},
  ) {
    // Resolve target models
    let models: ModelEntry[];
    if (modelTargets && modelTargets.length > 0) {
      // Validate and enrich with labels
      models = modelTargets.map((tool) => {
        const modelDefinition = getModelByName(tool.model);
        return {
          provider: tool.provider,
          model: tool.model,
          label: tool.display_name || modelDefinition?.label || tool.model,
          thinkingEnabled: tool.thinkingEnabled || false,
          toolsEnabled: tool.toolsEnabled || false,
          ...(tool.agent && { agent: tool.agent }),
          ...(tool.locale && { locale: tool.locale }),
          ...(tool.enabledTools?.length && { enabledTools: tool.enabledTools }),
        };
      });
    } else {
      models = filterAvailableModels(getConversationModels());
    }
    if (models.length === 0) {
      throw new Error("No models available for benchmarking");
    }

    // ── Trials: repeat every target N times (consistency / pass-rate) ──
    const trialCount = Math.max(
      1,
      Math.min(
        Math.floor(trials ?? benchmark.trials ?? 1) || 1,
        BENCHMARK.MAX_TRIALS,
      ),
    );
    if (trialCount > 1) {
      models = models.flatMap((model) =>
        Array.from({ length: trialCount }, (_, trialIndex) => ({
          ...model,
          trial: trialIndex + 1,
          trialCount,
        })),
      );
    }

    // Notify caller of total model count (used for live reconnection state)
    if (onRunStart) {
      try {
        onRunStart({ totalModels: models.length });
      } catch {
        /* noop */
      }
    }
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    logger.info(
      `[benchmark] Starting run ${runId} — "${benchmark.name}" against ${models.length} model(s)` +
        (trialCount > 1 ? ` (${trialCount} trials each)` : ""),
    );
    // ── Instance-aware concurrent execution ─────────────────────
    // Cloud providers: all models under the same provider run sequentially
    // within a bucket, but different providers run concurrently.
    // Local providers: models are bucketed per instance (e.g. lm-studio,
    // lm-studio-2), and each instance runs up to its concurrency limit.
    // Two instances means two concurrent local inference streams.
    const INTRA_PROVIDER_DELAY_MILLISECONDS = BENCHMARK.INTRA_PROVIDER_DELAY_MILLISECONDS;
    // Group models by provider; local providers use their instance ID as key
    const buckets = new Map<string, ModelEntry[]>();
    for (const model of models) {
      const key = model.provider; // Instance IDs are already unique (lm-studio, lm-studio-2, etc.)
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(model);
    }
    logger.info(
      `[benchmark] Executing across ${buckets.size} provider bucket(s): ${[...buckets.keys()].join(", ")}`,
    );
    // Each bucket runs its models sequentially; all buckets run concurrently.
    // The process-level GPU mutex (LocalModelQueue) still serializes at the
    // instance level, so concurrent benchmark runs and chat requests are safe.
    let aborted = false;
    const bucketPromises = [...buckets.entries()].map(
      async ([_key, bucketModels]) => {
        const bucketResults: ModelResult[] = [];
        for (let i = 0; i < bucketModels.length; i++) {
          // Check abort signal before each model
          if (signal?.aborted || aborted) {
            logger.info(`[benchmark] Aborting bucket — signal received`);
            break;
          }
          if (i > 0) await sleep(INTRA_PROVIDER_DELAY_MILLISECONDS);
          const model = bucketModels[i];
          if (onModelStart) {
            try {
              onModelStart({ ...model, isLocal: isInstance(model.provider) });
            } catch {
              /* noop */
            }
          }
          activeGenerationCount++;
          // Wrap onEvent to tag each event with the source model (enables
          // correct attribution when multiple provider buckets stream concurrently).
          const modelOnEvent = onEvent
            ? (event: BenchmarkEvent) =>
                onEvent({
                  ...event,
                  _sourceModel: {
                    provider: model.provider,
                    model: model.model,
                  },
                })
            : undefined;
          let result: ModelResult;
          try {
            result = await runSingleModel(benchmark, model, project, username, {
              signal,
              onEvent: modelOnEvent,
            });
          } finally {
            activeGenerationCount = Math.max(0, activeGenerationCount - 1);
          }
          if (signal?.aborted || aborted) {
            logger.info(
              `[benchmark] Aborting after model ${model.model} completed`,
            );
            // Still record this model's result even though we're stopping
            if (onModelComplete) {
              try {
                onModelComplete(result);
              } catch {
                /* noop */
              }
            }
            bucketResults.push(result);
            break;
          }
          if (onModelComplete) {
            try {
              onModelComplete(result);
            } catch {
              /* noop */
            }
          }
          bucketResults.push(result);
        }
        return bucketResults;
      },
    );
    // Listen for abort signal to propagate to all buckets
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
    }
    const bucketOutputs = await Promise.all(bucketPromises);
    const results = bucketOutputs.flat();
    const completedAt = new Date().toISOString();
    const wasAborted = signal?.aborted || aborted;
    const passed = results.filter(
      (benchmarkResult) => benchmarkResult.passed,
    ).length;
    const failed = results.filter(
      (benchmarkResult) => !benchmarkResult.passed && !benchmarkResult.error,
    ).length;
    const errored = results.filter(
      (benchmarkResult) => benchmarkResult.error,
    ).length;
    // Total spend includes LLM-judge calls (tracked per-result as judgeCost)
    const totalCost = results.reduce(
      (sum, benchmarkResult) =>
        sum +
        (benchmarkResult.estimatedCost || 0) +
        (benchmarkResult.judgeCost || 0),
      0,
    );
    const run = {
      id: runId,
      benchmarkId: benchmark.id,
      project,
      models: results,
      aborted: wasAborted || false,
      ...(trialCount > 1 && { trials: trialCount }),
      summary: {
        total: results.length,
        passed,
        failed,
        errored,
        totalCost,
      },
      startedAt,
      completedAt,
    };
    // Persist run (even partial / aborted runs)
    if (results.length > 0) {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (db) {
        await db.collection(RUNS_COLLECTION).insertOne(run);
      }
    }
    logger.success(
      `[benchmark] Run ${runId} ${wasAborted ? "ABORTED" : "complete"} — ${passed}/${results.length} passed` +
        (errored > 0 ? `, ${errored} error(s)` : ""),
    );
    return run;
  },
  // ── CRUD Helpers ────────────────────────────────────────────
  async create(
    data: BenchmarkWriteData,
    project: string | null,
    username: string,
  ) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    const now = new Date().toISOString();
    const document = {
      id: crypto.randomUUID(),
      project,
      username,
      name: data.name,
      prompt: data.prompt,
      systemPrompt: data.systemPrompt || null,
      expectedValue: data.expectedValue,
      matchMode: data.matchMode || BENCHMARK_MATCH_MODES.CONTAINS,
      benchmarkMode: data.benchmarkMode || "model",
      assertions: data.assertions || [],
      assertionOperator: data.assertionOperator || "AND",
      agentAssertions: data.agentAssertions || [],
      agentAssertionOperator: data.agentAssertionOperator || "AND",
      enabledTools: data.enabledTools || [],
      trials: data.trials ?? 1,
      temperature: data.temperature ?? 0,
      maxTokens: data.maxTokens ?? 256,
      tags: data.tags || [],
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(BENCHMARKS_COLLECTION).insertOne(document);
    return document;
  },
  async update(
    id: string,
    data: Partial<BenchmarkWriteData>,
    project: string | null,
  ) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    const editableFields: Array<keyof BenchmarkWriteData> = [
      "name",
      "prompt",
      "systemPrompt",
      "expectedValue",
      "matchMode",
      "benchmarkMode",
      "assertions",
      "assertionOperator",
      "agentAssertions",
      "agentAssertionOperator",
      "enabledTools",
      "trials",
      "temperature",
      "maxTokens",
      "tags",
    ];
    for (const field of editableFields) {
      if (data[field] !== undefined) updates[field] = data[field];
    }
    await db
      .collection(BENCHMARKS_COLLECTION)
      .updateOne({ id, project }, { $set: updates });
    return db.collection(BENCHMARKS_COLLECTION).findOne({ id, project });
  },
  async list(project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(BENCHMARKS_COLLECTION)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray();
  },
  async getById(id: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db.collection(BENCHMARKS_COLLECTION).findOne({ id, project });
  },
  async remove(id: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    await db.collection(BENCHMARKS_COLLECTION).deleteOne({ id, project });
    await db
      .collection(RUNS_COLLECTION)
      .deleteMany({ benchmarkId: id, project });
  },
  async getRuns(benchmarkId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(RUNS_COLLECTION)
      .find({ benchmarkId, project })
      .sort({ startedAt: -1 })
      .toArray();
  },
  async getRunById(runId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db.collection(RUNS_COLLECTION).findOne({ id: runId, project });
  },
  async removeRun(runId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    const outcome = await db
      .collection(RUNS_COLLECTION)
      .deleteOne({ id: runId, project });
    return outcome.deletedCount > 0;
  },
  async getLatestRun(benchmarkId: string, project: string | null) {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");
    return db
      .collection(RUNS_COLLECTION)
      .findOne({ benchmarkId, project }, { sort: { startedAt: -1 } });
  },
};
export default BenchmarkService;

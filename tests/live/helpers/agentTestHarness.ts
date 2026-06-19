/**
 * Agent Test Harness — Shared Infrastructure for Live Integration Tests
 * ════════════════════════════════════════════════════════════════════════
 *
 * Provides:
 *   - SSE stream consumer with structured event categorization
 *   - Provider auto-discovery (local + cloud)
 *   - Assertion helpers for common behavioral checks
 *   - Structured CLI logging for test diagnostics
 *
 * Used by: tests/live/agentBehavior.live.test.ts
 */

// ── Constants ───────────────────────────────────────────────────

import { PROVIDERS, TYPES } from "../../../src/constants.ts";

export const PRISM_SERVICE_URL = process.env.PRISM_TEST_URL || "https://api.prism.rod.dev";
export const LM_STUDIO_URL = process.env.LM_STUDIO_TEST_URL || "https://api.prism.rod.dev/lm-studio";
export const OLLAMA_URL = process.env.OLLAMA_TEST_URL || "https://api.prism.rod.dev/ollama";

export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
export const CLOUD_AGENT_TIMEOUT_MS = 60_000;
export const MULTI_AGENT_TIMEOUT_MS = 300_000;
export const SSE_IDLE_TIMEOUT_MS = 60_000;

// ── Types ───────────────────────────────────────────────────────

export interface ProviderTarget {
  providerName: string;
  model: string;
  isLocal: boolean;
  supportsThinking: boolean;
  supportsToolCalling: boolean;
  timeoutMultiplier: number;
}

export interface StatusEvent {
  type: string;
  message?: string;
  phase?: string;
  progress?: number;
  iteration?: number;
  maxIterations?: number;
  strategy?: string;
  branchCount?: number;
  branchIndex?: number;
  score?: number;
  scores?: number[] | Record<string, number>;
  enabledCount?: number;
  timeToFirstToken?: number;
  [key: string]: unknown;
}

export interface SubAgentStatusEvent {
  type: string;
  subAgentId?: string;
  message?: string;
  description?: string;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface ToolCallEvent {
  type: string;
  tool?: { name: string; args: Record<string, unknown>; id: string };
  name?: string;
  args?: Record<string, unknown>;
  id?: string;
  status?: string;
  result?: unknown;
}

export interface UsageData {
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  [key: string]: unknown;
}

export interface DoneEvent {
  type: string;
  usage?: UsageData;
  estimatedCost?: number;
}

export interface TransformedSSEEvent extends StatusEvent, ToolCallEvent, DoneEvent {
  content?: string;
}

export interface TransformedUsageUpdate {
  type: string;
  usage?: UsageData;
  estimatedCost?: number;
}

export interface TransformedErrorEvent {
  type: string;
  message?: string;
}

export interface AgentSSEResult {
  events: TransformedSSEEvent[];
  chunks: string[];
  thinkingChunks: string[];
  statuses: StatusEvent[];
  subAgentStatuses: SubAgentStatusEvent[];
  toolCalls: ToolCallEvent[];
  toolExecutions: ToolCallEvent[];
  usageUpdates: TransformedUsageUpdate[];
  errors: TransformedErrorEvent[];
  done: DoneEvent | null;
  text: string;
  thinking: string;
  phases: Set<string>;
  promptProcessingStarts: number;
  iterationCount: number;
  isAborted: boolean;
  isTimedOut: boolean;
  totalEvents: number;
  durationMilliseconds: number;
  aborted: boolean;
  timedOut: boolean;
  durationMs: number;
}

interface ConsumeOptions {
  timeoutMilliseconds?: number;
  idleTimeoutMilliseconds?: number;
  controller?: AbortController;
}

interface AgentStreamPayload {
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string; toolCalls?: unknown[]; thinking?: string }>;
  agent?: string;
  agentSessionId?: string;
  maxTokens?: number;
  autoApprove?: boolean;
  maxIterations?: number;
  harness?: string;
  planFirst?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  enabledTools?: string[];
  disabledTools?: string[];
  topology?: string;
  branchCount?: number;
  reasoningStrategy?: string;
  reminderModel?: string;
  reminderProvider?: string;
  reminderInterval?: number;
}

export interface TransformedAgentResponse {
  text: string;
  thinking?: string;
  usage?: UsageData;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

interface TransformedLmStudioModel {
  key?: string;
  id?: string;
  type?: string;
  loaded_instances?: unknown[];
  [key: string]: unknown;
}

interface TransformedOllamaModelsResponse {
  models?: Array<{ name: string }>;
}


// ── SSE Consumer ────────────────────────────────────────────────

function createEmptyResult(): AgentSSEResult {
  const result = {
    events: [],
    chunks: [],
    thinkingChunks: [],
    statuses: [],
    subAgentStatuses: [],
    toolCalls: [],
    toolExecutions: [],
    usageUpdates: [],
    errors: [],
    done: null,
    text: "",
    thinking: "",
    phases: new Set(),
    promptProcessingStarts: 0,
    iterationCount: 0,
    isAborted: false,
    isTimedOut: false,
    totalEvents: 0,
    durationMilliseconds: 0,
  };

  Object.defineProperty(result, "aborted", {
    get() { return this.isAborted; },
    set(value: boolean) { this.isAborted = value; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(result, "timedOut", {
    get() { return this.isTimedOut; },
    set(value: boolean) { this.isTimedOut = value; },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(result, "durationMs", {
    get() { return this.durationMilliseconds; },
    set(value: number) { this.durationMilliseconds = value; },
    enumerable: true,
    configurable: true,
  });

  return result as unknown as AgentSSEResult;
}

/**
 * Parse SSE events from a streaming /agent response.
 * Returns a structured result with all events categorized for assertions.
 */
export async function consumeAgentSSE(
  response: Response,
  {
    timeoutMilliseconds = DEFAULT_AGENT_TIMEOUT_MS,
    idleTimeoutMilliseconds,
    controller,
  }: ConsumeOptions = {},
): Promise<AgentSSEResult> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result = createEmptyResult();
  const startTime = Date.now();
  let lastEventTime = Date.now();

  const timeoutId = setTimeout(() => {
    result.isTimedOut = true;
    controller?.abort();
    reader.cancel().catch(() => {});
  }, timeoutMilliseconds);

  const finalIdleTimeout = idleTimeoutMilliseconds ?? Math.max(SSE_IDLE_TIMEOUT_MS, timeoutMilliseconds / 2);

  const idleCheckId = setInterval(() => {
    if (Date.now() - lastEventTime > finalIdleTimeout) {
      console.warn(`  ⚠ SSE idle for ${finalIdleTimeout / 1000}s — aborting`);
      result.isTimedOut = true;
      controller?.abort();
      reader.cancel().catch(() => {});
    }
  }, 5000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        try {
          const event = JSON.parse(trimmed.slice(6)) as TransformedSSEEvent;
          result.events.push(event);
          result.totalEvents++;
          lastEventTime = Date.now();

          switch (event.type) {
            case "chunk":
              if (typeof event.content === "string") {
                result.chunks.push(event.content);
                result.text += event.content;
              }
              break;

            case "thinking":
              if (typeof event.content === "string") {
                result.thinkingChunks.push(event.content);
                result.thinking += event.content;
              }
              break;

            case "status": {
              result.statuses.push(event);
              if (event.phase) result.phases.add(event.phase);

              if (event.message === "iteration_progress") {
                result.iterationCount = event.iteration || result.iterationCount;
              }

              if (
                typeof event.message === "string" &&
                event.message.includes("Processing prompt")
              ) {
                if (
                  event.progress === 0 ||
                  event.progress === undefined ||
                  event.progress === null
                ) {
                  result.promptProcessingStarts++;
                }
              }
              break;
            }

            case "tool_execution":
              result.toolExecutions.push(event);
              break;

            case "toolCall":
              result.toolCalls.push(event);
              break;

            case "sub_agent_status":
              result.subAgentStatuses.push(event as unknown as SubAgentStatusEvent);
              break;

            case "usage_update":
              result.usageUpdates.push(event);
              break;

            case "error":
              result.errors.push(event);
              break;

            case "done":
              result.done = event;
              break;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }

      if (result.done) break;
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        result.isAborted = true;
      } else {
        result.errors.push({ type: "error", message: error.message });
      }
    } else {
      result.errors.push({ type: "error", message: String(error) });
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(idleCheckId);
    result.durationMilliseconds = Date.now() - startTime;
  }

  return result;
}


/**
 * Send an agentic request via SSE streaming and consume the full response.
 */
const DEFAULT_MIN_CONTEXT_LENGTH = 65_000;
const DEFAULT_EVAL_BATCH_SIZE = 4_096;

export async function agentStream(
  payload: AgentStreamPayload,
  {
    timeoutMilliseconds,
    timeoutMs,
  }: { timeoutMilliseconds?: number; timeoutMs?: number } = {},
): Promise<AgentSSEResult> {
  const finalTimeout = timeoutMilliseconds ?? timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const enrichedPayload = {
    minContextLength: DEFAULT_MIN_CONTEXT_LENGTH,
    evalBatchSize: DEFAULT_EVAL_BATCH_SIZE,
    ...payload,
  };
  const controller = new AbortController();
  const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: {
      "x-project": "agent-behavior-tests",
      "x-username": "test-runner",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(enrichedPayload),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agent endpoint failed: ${response.status} ${errorText}`);
  }

  return consumeAgentSSE(response, {
    timeoutMilliseconds: finalTimeout,
    idleTimeoutMilliseconds: Math.max(SSE_IDLE_TIMEOUT_MS, finalTimeout / 2),
    controller,
  });
}

/**
 * Send a non-streaming agentic request (?stream=false).
 */
export async function agentJSON(
  payload: AgentStreamPayload,
): Promise<TransformedAgentResponse> {
  const response = await fetch(`${PRISM_SERVICE_URL}/agent?stream=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "agent-behavior-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as TransformedAgentResponse;
  if (!response.ok || body.error) {
    throw new Error(
      body.message || body.error || `HTTP ${response.status}`,
    );
  }
  return body;
}

// ── Provider Discovery ──────────────────────────────────────────

const THINKING_MODEL_PATTERNS = [
  /qwq/i, /thinking/i, /reasoner/i, /deepseek.*r1/i,
  /o[134]-/i, /claude.*3\.5.*sonnet/i, /claude.*opus/i,
];

const TOOL_CALLING_SKIP_PATTERNS = [
  /embed/i, /tts/i, /whisper/i, /rerank/i,
];

/**
 * Discover available LM Studio models via Prism's /lm-studio/models endpoint.
 * Checks multiple instances (lm-studio, lm-studio-2, ..., lm-studio-4).
 */
async function discoverLmStudioModels(): Promise<ProviderTarget[]> {
  const targets: ProviderTarget[] = [];
  const instanceIds = [PROVIDERS.LM_STUDIO, "lm-studio-2", "lm-studio-3", "lm-studio-4"];

  for (const instanceId of instanceIds) {
    try {
      const response = await fetch(
        `${PRISM_SERVICE_URL}/lm-studio/models?instance=${instanceId}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) continue;

      const data = (await response.json()) as {
        models?: TransformedLmStudioModel[];
        data?: TransformedLmStudioModel[];
      };
      const models = data.models || data.data || [];

      // Find loaded conversational models on this instance
      const loadedModels = models.filter(
         (model) => {
           const loadedInstances = model.loaded_instances;
           return Array.isArray(loadedInstances) && loadedInstances.length > 0 && model.type !== TYPES.EMBEDDING;
         }
      );

      for (const loadedModel of loadedModels) {
        const modelKey = loadedModel.key || loadedModel.id;
        if (!modelKey) continue;

        targets.push({
          providerName: instanceId,
          model: modelKey,
          isLocal: true,
          supportsThinking: THINKING_MODEL_PATTERNS.some((pattern) => pattern.test(modelKey)),
          supportsToolCalling: true,
          timeoutMultiplier: 2,
        });
      }
    } catch {
      // Instance doesn't exist or not reachable — skip silently
    }
  }

  return targets;
}

/**
 * Discover available Ollama models via Prism's proxy endpoint.
 */
async function discoverOllamaModels(): Promise<ProviderTarget[]> {
  try {
    const response = await fetch(`${PRISM_SERVICE_URL}/ollama/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as TransformedOllamaModelsResponse;
    const models = data.models || [];

    if (models.length === 0) return [];

    const conversationalModel = models.find(
      (model) => !TOOL_CALLING_SKIP_PATTERNS.some((pattern) => pattern.test(model.name)),
    );
    if (!conversationalModel) return [];

    return [
      {
        providerName: PROVIDERS.OLLAMA,
        model: conversationalModel.name,
        isLocal: true,
        supportsThinking: THINKING_MODEL_PATTERNS.some((pattern) =>
          pattern.test(conversationalModel.name),
        ),
        supportsToolCalling: true,
        timeoutMultiplier: 2,
      },
    ];
  } catch {
    return [];
  }
}


/**
 * Build cloud provider targets from environment variables.
 * Only included when INCLUDE_CLOUD=true is set.
 */
function discoverCloudProviders(): ProviderTarget[] {
  const includeCloud = process.env.INCLUDE_CLOUD === "true";
  if (!includeCloud) return [];

  const targets: ProviderTarget[] = [];

  if (process.env.OPENAI_API_KEY) {
    targets.push({
      providerName: PROVIDERS.OPENAI,
      model: "gpt-4.1-mini",
      isLocal: false,
      supportsThinking: false,
      supportsToolCalling: true,
      timeoutMultiplier: 1,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    targets.push({
      providerName: PROVIDERS.ANTHROPIC,
      model: "claude-sonnet-4-20250514",
      isLocal: false,
      supportsThinking: true,
      supportsToolCalling: true,
      timeoutMultiplier: 1,
    });
  }

  if (process.env.GOOGLE_API_KEY) {
    targets.push({
      providerName: PROVIDERS.GOOGLE,
      model: "gemini-2.5-flash",
      isLocal: false,
      supportsThinking: true,
      supportsToolCalling: true,
      timeoutMultiplier: 1,
    });
  }

  return targets;
}

/**
 * Discover all available providers (local + cloud).
 * Returns at least one target or throws to skip the suite.
 */
export async function discoverProviders(): Promise<ProviderTarget[]> {
  // Check that Prism is running first
  try {
    await fetch(PRISM_SERVICE_URL, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error(
      `Prism service not running at ${PRISM_SERVICE_URL}. Start it before running live tests.`,
    );
  }

  const [lmStudioTargets, ollamaTargets] = await Promise.all([
    discoverLmStudioModels(),
    discoverOllamaModels(),
  ]);

  const cloudTargets = discoverCloudProviders();

  const allTargets = [...lmStudioTargets, ...ollamaTargets, ...cloudTargets];

  if (allTargets.length === 0) {
    throw new Error(
      "No providers available. Start LM Studio or Ollama, or set INCLUDE_CLOUD=true with API keys.",
    );
  }

  return allTargets;
}

// ── Timeout Helpers ─────────────────────────────────────────────

export function getTimeout(target: ProviderTarget, baseMilliseconds: number = DEFAULT_AGENT_TIMEOUT_MS): number {
  return baseMilliseconds * target.timeoutMultiplier;
}

export function getMultiAgentTimeout(target: ProviderTarget): number {
  return MULTI_AGENT_TIMEOUT_MS * target.timeoutMultiplier;
}


// ── Empty Response Detection ────────────────────────────────────

/**
 * Check if the agent produced a meaningful response (non-empty text/thinking/tool calls).
 * Returns false when the model was saturated and produced 0 output tokens.
 */
export function isEmptyResponse(result: AgentSSEResult): boolean {
  return (
    result.text.length === 0 &&
    result.thinking.length === 0 &&
    result.toolExecutions.length === 0 &&
    result.toolCalls.length === 0
  );
}

/**
 * Retry an agent stream request up to maximumRetries times when the model returns
 * an empty response (0 output tokens). This handles model saturation under
 * heavy sequential test load against local models.
 */
export async function agentStreamWithRetry(
  payload: AgentStreamPayload,
  options: {
    timeoutMilliseconds?: number;
    timeoutMs?: number;
    maximumRetries?: number;
    maxRetries?: number;
  } = {},
): Promise<AgentSSEResult> {
  const finalTimeout = options.timeoutMilliseconds ?? options.timeoutMs;
  const finalRetries = options.maximumRetries ?? options.maxRetries ?? 2;
  let lastResult: AgentSSEResult | null = null;

  for (let attemptIndex = 0; attemptIndex <= finalRetries; attemptIndex++) {
    if (attemptIndex > 0) {
      const backoffMilliseconds = 10_000 * attemptIndex;
      console.log(`    ↻ Retry ${attemptIndex}/${finalRetries} after ${backoffMilliseconds / 1000}s backoff (empty response — model recovery)`);
      await new Promise((resolve) => setTimeout(resolve, backoffMilliseconds));
    }

    lastResult = await agentStream(payload, { timeoutMilliseconds: finalTimeout });

    if (!isEmptyResponse(lastResult)) return lastResult;
  }

  return lastResult!;
}

// ── Assertion Helpers ───────────────────────────────────────────

/**
 * Assert that at least one tool call with the given name was made.
 */
export function assertToolCallPresent(
  result: AgentSSEResult,
  toolName: string,
): void {
  const toolExecutionMatch = result.toolExecutions.some(
    (toolEvent) =>
      toolEvent.tool?.name === toolName || toolEvent.name === toolName,
  );
  const toolCallMatch = result.toolCalls.some(
    (toolEvent) =>
      toolEvent.tool?.name === toolName || toolEvent.name === toolName,
  );

  if (!toolExecutionMatch && !toolCallMatch) {
    const allToolNames = [
      ...result.toolExecutions.map((toolEvent) => toolEvent.tool?.name || toolEvent.name),
      ...result.toolCalls.map((toolEvent) => toolEvent.tool?.name || toolEvent.name),
    ];
    throw new Error(
      `Expected tool call "${toolName}" but found: [${allToolNames.join(", ")}]`,
    );
  }
}

/**
 * Assert that ANY tool call was made (name-agnostic).
 */
export function assertAnyToolCallPresent(result: AgentSSEResult): void {
  const totalToolActivity = result.toolExecutions.length + result.toolCalls.length;
  if (totalToolActivity === 0) {
    throw new Error("Expected at least one tool call but found none");
  }
}

/**
 * Assert that thinking chunks were emitted.
 */
export function assertThinkingPresent(result: AgentSSEResult): void {
  if (result.thinkingChunks.length === 0 && result.thinking.length === 0) {
    throw new Error("Expected thinking chunks but found none");
  }
}

/**
 * Assert that no thinking chunks were emitted.
 */
export function assertNoThinking(result: AgentSSEResult): void {
  if (result.thinkingChunks.length > 0 || result.thinking.length > 0) {
    throw new Error(
      `Expected no thinking but found ${result.thinkingChunks.length} chunks (${result.thinking.length} chars)`,
    );
  }
}

/**
 * Assert that the prompt processing phase didn't restart excessively (loop detection).
 */
export function assertNoLoop(
  result: AgentSSEResult,
  maximumStartsAllowed: number = 2,
): void {
  if (result.promptProcessingStarts > maximumStartsAllowed) {
    throw new Error(
      `Prompt processing loop detected: ${result.promptProcessingStarts} starts (max ${maximumStartsAllowed})`,
    );
  }
}

/**
 * Assert that the agent completed cleanly (done event, no timeout, no errors).
 */
export function assertCleanCompletion(result: AgentSSEResult): void {
  if (result.isTimedOut) {
    throw new Error(`Agent timed out after ${result.durationMilliseconds}ms`);
  }
  if (!result.done) {
    throw new Error("Agent did not emit a done event");
  }
  if (result.errors.length > 0) {
    const errorMessages = result.errors.map((error) => error.message || "unknown").join("; ");
    throw new Error(`Agent produced ${result.errors.length} error(s): ${errorMessages}`);
  }
}

/**
 * Get effective usage from the best available source.
 * LM Studio's OpenAI-compat streaming endpoint reports 0 tokens in the
 * done event's usage. Fall back to the last usage_update event which
 * accurately tracks accumulated tokens during streaming.
 */
export function getEffectiveUsage(result: AgentSSEResult): UsageData {
  const doneUsage = result.done?.usage;
  const hasDoneUsage = doneUsage &&
    ((doneUsage.inputTokens ?? 0) > 0 || (doneUsage.outputTokens ?? 0) > 0);

  if (hasDoneUsage) return doneUsage;

  // Fall back to the last usage_update event (streaming accumulator)
  if (result.usageUpdates.length > 0) {
    const lastUpdate = result.usageUpdates[result.usageUpdates.length - 1];
    if (lastUpdate.usage) return lastUpdate.usage;
  }

  return doneUsage || { inputTokens: 0, outputTokens: 0 };
}

/**
 * Assert that usage data has non-zero input and output tokens.
 * Falls back to usage_update events when the done event reports 0
 * (known LM Studio OpenAI-compat limitation).
 */
export function assertUsagePresent(result: AgentSSEResult): void {
  const usage = getEffectiveUsage(result);
  if (!usage.inputTokens || usage.inputTokens <= 0) {
    throw new Error(`Expected inputTokens > 0 but got ${usage.inputTokens}`);
  }
  if (!usage.outputTokens || usage.outputTokens <= 0) {
    throw new Error(`Expected outputTokens > 0 but got ${usage.outputTokens}`);
  }
}

/**
 * Assert that the iteration count stayed within the expected maximum.
 */
export function assertIterationCountWithin(
  result: AgentSSEResult,
  expectedMaximum: number,
): void {
  const iterationStatuses = result.statuses.filter(
    (status) => status.message === "iteration_progress",
  );
  const highestIteration = iterationStatuses.reduce(
    (maximum, status) => Math.max(maximum, (status.iteration as number) || 0),
    0,
  );
  if (highestIteration > expectedMaximum) {
    throw new Error(
      `Expected at most ${expectedMaximum} iterations but reached ${highestIteration}`,
    );
  }
}

// ── Logging Helpers ─────────────────────────────────────────────

/**
 * Log a structured test result block to the console.
 */
export function logResult(label: string, result: AgentSSEResult): void {
  const durationSeconds = (result.durationMilliseconds / 1000).toFixed(1);
  const phaseSummary = [...result.phases].join(" → ");
  const textLength = result.text.length;
  const thinkingLength = result.thinking.length;
  const promptProcessingStartCount = result.promptProcessingStarts;
  const toolExecutionCount = result.toolExecutions.length;
  const toolCallCount = result.toolCalls.length;

  const iterationStatuses = result.statuses.filter(
    (status) => status.message === "iteration_progress",
  );

  console.log(`\n  ┌─ ${label} ${"─".repeat(Math.max(1, 55 - label.length))}┐`);
  console.log(`  │ Duration:       ${durationSeconds}s${" ".repeat(Math.max(1, 40 - durationSeconds.length))}│`);
  console.log(`  │ Phases:         ${phaseSummary.padEnd(40).slice(0, 40)}│`);
  console.log(`  │ Text length:    ${String(textLength).padEnd(40)}│`);
  console.log(`  │ Thinking:       ${String(thinkingLength).padEnd(40)}│`);
  console.log(`  │ PP starts:      ${String(promptProcessingStartCount).padEnd(40)}│`);
  console.log(`  │ Iterations:     ${String(iterationStatuses.length).padEnd(40)}│`);
  console.log(`  │ Tool execs:     ${String(toolExecutionCount).padEnd(40)}│`);
  console.log(`  │ Tool calls:     ${String(toolCallCount).padEnd(40)}│`);
  console.log(`  │ Usage updates:  ${String(result.usageUpdates.length).padEnd(40)}│`);
  console.log(`  │ Errors:         ${String(result.errors.length).padEnd(40)}│`);
  if (result.subAgentStatuses.length > 0) {
    console.log(`  │ Sub-agents:     ${String(result.subAgentStatuses.length).padEnd(40)}│`);
  }
  console.log(`  │ Total events:   ${String(result.totalEvents).padEnd(40)}│`);

  // Event type breakdown
  const typeCounts: Record<string, number> = {};
  for (const event of result.events) {
    typeCounts[event.type] = (typeCounts[event.type] || 0) + 1;
  }
  const typeBreakdown = Object.entries(typeCounts)
    .map(([eventType, eventCount]) => `${eventType}:${eventCount}`)
    .join(" ");
  console.log(`  │ Types:          ${typeBreakdown.padEnd(40).slice(0, 40)}│`);

  // Usage summary from done event
  if (result.done?.usage) {
    const usage = result.done.usage;
    const usageSummary =
      `in=${usage.inputTokens || 0} out=${usage.outputTokens || 0} reason=${usage.reasoningOutputTokens || 0}`;
    console.log(`  │ Usage:          ${usageSummary.padEnd(40).slice(0, 40)}│`);
  }

  if (result.isTimedOut) console.log(`  │ ⚠️  TIMED OUT                                        │`);
  if (result.errors.length > 0) {
    for (const error of result.errors.slice(0, 3)) {
      console.log(`  │ ❌ ${(error.message || "unknown").slice(0, 53).padEnd(53)}│`);
    }
  }
  console.log(`  └${"─".repeat(59)}┘`);
}

/**
 * Log provider discovery summary.
 */
export function logProviderSummary(targets: ProviderTarget[]): void {
  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  Agent Behavior — Live Integration Tests              ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  for (const target of targets) {
    const providerLabel = `${target.providerName} (${target.isLocal ? "local" : "cloud"})`;
    const modelLabel = target.model.slice(0, 35);
    console.log(
      `  ║  ${providerLabel.padEnd(20)} ${modelLabel.padEnd(34).slice(0, 34)}║`,
    );
  }
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}

// ── Model Discovery Helpers ─────────────────────────────────────────

/**
 * Filter loaded conversational models from an LM Studio model list.
 * Excludes embedding models and models without active loaded instances.
 */
export function filterLoadedConversationalModels(
  models: TransformedLmStudioModel[],
): TransformedLmStudioModel[] {
  return models.filter(
    (model) =>
      Array.isArray(model.loaded_instances) &&
      model.loaded_instances.length > 0 &&
      model.type !== TYPES.EMBEDDING,
  );
}

/**
 * Find the first loaded conversational model from an LM Studio model list.
 * Returns undefined if no suitable model is found.
 */
export function findFirstConversationalModel(
  models: TransformedLmStudioModel[],
): TransformedLmStudioModel | undefined {
  return filterLoadedConversationalModels(models)[0];
}

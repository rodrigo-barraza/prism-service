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

const PRISM_SERVICE_URL = process.env.PRISM_TEST_URL || "https://api.prism.rod.dev";
const LM_STUDIO_URL = process.env.LM_STUDIO_TEST_URL || "https://api.prism.rod.dev/lm-studio";
const OLLAMA_URL = process.env.OLLAMA_TEST_URL || "https://api.prism.rod.dev/ollama";

const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
const CLOUD_AGENT_TIMEOUT_MS = 60_000;
const MULTI_AGENT_TIMEOUT_MS = 300_000;
const SSE_IDLE_TIMEOUT_MS = 60_000;

// ── Types ───────────────────────────────────────────────────────

export interface ProviderTarget {
  providerName: string;
  model: string;
  isLocal: boolean;
  supportsThinking: boolean;
  supportsToolCalling: boolean;
  timeoutMultiplier: number;
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

export interface StatusEvent {
  type: string;
  message?: string;
  phase?: string;
  progress?: number;
  iteration?: number;
  maxIterations?: number;
  [key: string]: unknown;
}

export interface UsageData {
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  requests?: number;
  [key: string]: unknown;
}

export interface DoneEvent {
  type: string;
  usage?: UsageData;
  estimatedCost?: number;
  [key: string]: unknown;
}

export interface AgentSSEResult {
  events: Array<Record<string, unknown>>;
  chunks: string[];
  thinkingChunks: string[];
  statuses: StatusEvent[];
  toolCalls: ToolCallEvent[];
  toolExecutions: ToolCallEvent[];
  usageUpdates: Array<{ type: string; usage?: UsageData; estimatedCost?: number }>;
  errors: Array<{ type: string; message?: string }>;
  done: DoneEvent | null;
  text: string;
  thinking: string;
  phases: Set<string>;
  promptProcessingStarts: number;
  iterationCount: number;
  aborted: boolean;
  timedOut: boolean;
  totalEvents: number;
  durationMs: number;
}

interface ConsumeOptions {
  timeoutMs?: number;
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
  [key: string]: unknown;
}

// ── SSE Consumer ────────────────────────────────────────────────

function createEmptyResult(): AgentSSEResult {
  return {
    events: [],
    chunks: [],
    thinkingChunks: [],
    statuses: [],
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
    aborted: false,
    timedOut: false,
    totalEvents: 0,
    durationMs: 0,
  };
}

/**
 * Parse SSE events from a streaming /agent response.
 * Returns a structured result with all events categorized for assertions.
 */
export async function consumeAgentSSE(
  response: Response,
  { timeoutMs = DEFAULT_AGENT_TIMEOUT_MS, controller }: ConsumeOptions = {},
): Promise<AgentSSEResult> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const result = createEmptyResult();
  const startTime = Date.now();
  let lastEventTime = Date.now();

  const timeoutId = setTimeout(() => {
    result.timedOut = true;
    controller?.abort();
    reader.cancel().catch(() => {});
  }, timeoutMs);

  const idleCheckId = setInterval(() => {
    if (Date.now() - lastEventTime > SSE_IDLE_TIMEOUT_MS) {
      console.warn(`  ⚠ SSE idle for ${SSE_IDLE_TIMEOUT_MS / 1000}s — aborting`);
      result.timedOut = true;
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
          const event = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
          result.events.push(event);
          result.totalEvents++;
          lastEventTime = Date.now();

          switch (event.type) {
            case "chunk":
              result.chunks.push(event.content as string);
              result.text += (event.content as string) || "";
              break;

            case "thinking":
              result.thinkingChunks.push(event.content as string);
              result.thinking += (event.content as string) || "";
              break;

            case "status": {
              const statusEvent = event as unknown as StatusEvent;
              result.statuses.push(statusEvent);
              if (statusEvent.phase) result.phases.add(statusEvent.phase);

              if (statusEvent.message === "iteration_progress") {
                result.iterationCount = (statusEvent.iteration as number) || result.iterationCount;
              }

              if (
                typeof statusEvent.message === "string" &&
                statusEvent.message.includes("Processing prompt")
              ) {
                if (
                  statusEvent.progress === 0 ||
                  statusEvent.progress === undefined ||
                  statusEvent.progress === null
                ) {
                  result.promptProcessingStarts++;
                }
              }
              break;
            }

            case "tool_execution":
              result.toolExecutions.push(event as unknown as ToolCallEvent);
              break;

            case "toolCall":
              result.toolCalls.push(event as unknown as ToolCallEvent);
              break;

            case "usage_update":
              result.usageUpdates.push(event as { type: string; usage?: UsageData; estimatedCost?: number });
              break;

            case "error":
              result.errors.push(event as { type: string; message?: string });
              break;

            case "done":
              result.done = event as unknown as DoneEvent;
              break;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }

      if (result.done) break;
    }
  } catch (error: unknown) {
    if ((error as Error).name === "AbortError") {
      result.aborted = true;
    } else {
      result.errors.push({ type: "error", message: (error as Error).message });
    }
  } finally {
    clearTimeout(timeoutId);
    clearInterval(idleCheckId);
    result.durationMs = Date.now() - startTime;
  }

  return result;
}

// ── Agent Stream Caller ─────────────────────────────────────────

/**
 * Send an agentic request via SSE streaming and consume the full response.
 */
export async function agentStream(
  payload: AgentStreamPayload,
  { timeoutMs = DEFAULT_AGENT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<AgentSSEResult> {
  const controller = new AbortController();
  const response = await fetch(`${PRISM_SERVICE_URL}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "agent-behavior-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agent endpoint failed: ${response.status} ${errorText}`);
  }

  return consumeAgentSSE(response, { timeoutMs, controller });
}

/**
 * Send a non-streaming agentic request (?stream=false).
 */
export async function agentJSON(
  payload: AgentStreamPayload,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${PRISM_SERVICE_URL}/agent?stream=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "agent-behavior-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
  });

  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body.error) {
    throw new Error(
      (body.message as string) || (body.error as string) || `HTTP ${response.status}`,
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
  const instanceIds = ["lm-studio", "lm-studio-2", "lm-studio-3", "lm-studio-4"];

  for (const instanceId of instanceIds) {
    try {
      const response = await fetch(
        `${PRISM_SERVICE_URL}/lm-studio/models?instance=${instanceId}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) continue;

      const data = (await response.json()) as {
        models?: Array<Record<string, unknown>>;
        data?: Array<Record<string, unknown>>;
      };
      const models = data.models || data.data || [];

      // Find loaded conversational models on this instance
      const loadedModels = models.filter(
        (model) =>
          ((model.loaded_instances as unknown[])?.length ?? 0) > 0 &&
          model.type !== "embedding",
      );

      for (const loadedModel of loadedModels) {
        const modelKey = (loadedModel.key as string) || (loadedModel.id as string);
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
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = data.models || [];

    if (models.length === 0) return [];

    const conversationalModel = models.find(
      (model) => !TOOL_CALLING_SKIP_PATTERNS.some((pattern) => pattern.test(model.name)),
    );
    if (!conversationalModel) return [];

    return [
      {
        providerName: "ollama",
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
      providerName: "openai",
      model: "gpt-4.1-mini",
      isLocal: false,
      supportsThinking: false,
      supportsToolCalling: true,
      timeoutMultiplier: 1,
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    targets.push({
      providerName: "anthropic",
      model: "claude-sonnet-4-20250514",
      isLocal: false,
      supportsThinking: true,
      supportsToolCalling: true,
      timeoutMultiplier: 1,
    });
  }

  if (process.env.GOOGLE_API_KEY) {
    targets.push({
      providerName: "google",
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

export function getTimeout(target: ProviderTarget, baseMs: number = DEFAULT_AGENT_TIMEOUT_MS): number {
  return baseMs * target.timeoutMultiplier;
}

export function getMultiAgentTimeout(target: ProviderTarget): number {
  return MULTI_AGENT_TIMEOUT_MS * target.timeoutMultiplier;
}

export { CLOUD_AGENT_TIMEOUT_MS, DEFAULT_AGENT_TIMEOUT_MS, MULTI_AGENT_TIMEOUT_MS };

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
 * Retry an agent stream request up to maxRetries times when the model returns
 * an empty response (0 output tokens). This handles model saturation under
 * heavy sequential test load against local models.
 */
export async function agentStreamWithRetry(
  payload: Parameters<typeof agentStream>[0],
  options: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<AgentSSEResult> {
  const maximumRetries = options.maxRetries ?? 2;
  let lastResult: AgentSSEResult | null = null;

  for (let attemptIndex = 0; attemptIndex <= maximumRetries; attemptIndex++) {
    if (attemptIndex > 0) {
      const backoffMs = 10_000 * attemptIndex;
      console.log(`    ↻ Retry ${attemptIndex}/${maximumRetries} after ${backoffMs / 1000}s backoff (empty response — model recovery)`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    lastResult = await agentStream(payload, { timeoutMs: options.timeoutMs });

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
  maxStartsAllowed: number = 2,
): void {
  if (result.promptProcessingStarts > maxStartsAllowed) {
    throw new Error(
      `Prompt processing loop detected: ${result.promptProcessingStarts} starts (max ${maxStartsAllowed})`,
    );
  }
}

/**
 * Assert that the agent completed cleanly (done event, no timeout, no errors).
 */
export function assertCleanCompletion(result: AgentSSEResult): void {
  if (result.timedOut) {
    throw new Error(`Agent timed out after ${result.durationMs}ms`);
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
  const durationSeconds = (result.durationMs / 1000).toFixed(1);
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
  console.log(`  │ Total events:   ${String(result.totalEvents).padEnd(40)}│`);

  // Event type breakdown
  const typeCounts: Record<string, number> = {};
  for (const event of result.events) {
    typeCounts[event.type as string] = (typeCounts[event.type as string] || 0) + 1;
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

  if (result.timedOut) console.log(`  │ ⚠️  TIMED OUT                                        │`);
  if (result.errors.length > 0) {
    for (const error of result.errors.slice(0, 3)) {
      console.log(`  │ ❌ ${((error.message as string) || "unknown").slice(0, 53).padEnd(53)}│`);
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

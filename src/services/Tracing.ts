/**
 * Tracing — OpenTelemetry spans for agent turns, model calls and tools.
 *
 * Off by default. `startTracing()` (boot.ts) registers a NodeSDK exporting
 * OTLP/HTTP only when OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set (the standard OTEL_* variables
 * — service name, sampler, headers — apply). Unset, the SDK is never
 * loaded: every helper below runs on @opentelemetry/api's no-op tracer,
 * spans are non-recording, and nothing is parented or propagated.
 *
 * One turn, in the GenAI semantic conventions
 * (open-telemetry/semantic-conventions-genai, main as of 2026-09-22):
 *
 *   invoke_agent {agent}   INTERNAL  runAgenticLoop; a sub-agent's nests under
 *                                    the execute_tool span that spawned it
 *     chat {model}         CLIENT    one per provider pass (consumeStream)
 *     execute_tool {tool}  INTERNAL  one per executed call (executeToolBatch)
 *
 * A tool runs inside its span's context, so `traceHeaders()` on the
 * tools-service and MCP requests it makes names that span as their parent.
 */
import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type AttributeValue,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import { getTotalInputTokens } from "#src/utils/CostCalculator";
import { toolResultErrorType } from "#src/utils/ToolExecutionRecord";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  AgenticContext,
  PassState,
  ToolCall,
} from "#src/services/harnesses/types";

const TRACER_NAME = "prism-service";

/**
 * Convention attribute names, kept here rather than imported: the GenAI
 * conventions are Development-status and the npm constants lag them
 * (@opentelemetry/semantic-conventions 1.43 still says
 * `cache_creation.input_tokens`; the conventions now say `cache_write`).
 */
const ATTRIBUTES = {
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  AGENT_NAME: "gen_ai.agent.name",
  CONVERSATION_ID: "gen_ai.conversation.id",
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_STREAM: "gen_ai.request.stream",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  REQUEST_TOP_P: "gen_ai.request.top_p",
  REQUEST_REASONING_LEVEL: "gen_ai.request.reasoning.level",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  RESPONSE_TIME_TO_FIRST_CHUNK: "gen_ai.response.time_to_first_chunk",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  USAGE_CACHE_WRITE_INPUT_TOKENS: "gen_ai.usage.cache_write.input_tokens",
  USAGE_REASONING_OUTPUT_TOKENS: "gen_ai.usage.reasoning.output_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  ERROR_TYPE: "error.type",
  // Prism's own — what the conventions have no name for.
  TRACE_ID: "prism.trace_id",
  PROVIDER: "prism.provider",
  PROJECT: "prism.project",
  HARNESS: "prism.harness",
  AGENT_CONVERSATION_ID: "prism.agent_conversation_id",
  PARENT_AGENT_CONVERSATION_ID: "prism.parent_agent_conversation_id",
  SUB_AGENT: "prism.sub_agent",
  TURN_ITERATIONS: "prism.turn.iterations",
  TURN_OUTCOME: "prism.turn.outcome",
  COST_USD: "prism.cost.usd",
  ITERATION: "prism.iteration",
  REQUEST_ID: "prism.request_id",
  DEVIATION_RULE: "prism.deviation.rule",
  TOOL_TIER: "prism.tool.tier",
  TOOL_APPROVAL: "prism.tool.approval",
  TOOL_APPROVAL_LAYER: "prism.tool.approval.layer",
  TOOL_DURATION_MS: "prism.tool.duration_ms",
} as const;

/** Prism provider ids that have a well-known `gen_ai.provider.name`. */
const PROVIDER_NAMES: Record<string, string> = { google: "gcp.gemini" };

const OUTCOMES_THAT_FAILED = new Set(["error"]);

let activeSdk: { shutdown(): Promise<void> } | null = null;
let cleanupRegistered = false;

const tracer = () => trace.getTracer(TRACER_NAME);

/** Tracing is on when an OTLP endpoint is configured and the SDK is not disabled. */
export function isTracingConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return false;
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT ||
      environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
}

/**
 * Register the SDK (tracer provider, AsyncLocalStorage context manager, W3C
 * propagator). Resolves false, loading nothing, when tracing is not
 * configured. `spanProcessors` replaces the OTLP exporter — tests pass an
 * in-memory one and get the same registration production does.
 */
export async function startTracing({
  env: environment = process.env,
  spanProcessors,
}: {
  env?: NodeJS.ProcessEnv;
  spanProcessors?: NodeSDKConfiguration["spanProcessors"];
} = {}): Promise<boolean> {
  if (activeSdk) return true;
  if (!spanProcessors && !isTracingConfigured(environment)) return false;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const exporterOptions = spanProcessors
    ? { spanProcessors }
    : {
        traceExporter: new (
          await import("@opentelemetry/exporter-trace-otlp-http")
        ).OTLPTraceExporter(),
      };
  const sdk = new NodeSDK({
    serviceName: environment.OTEL_SERVICE_NAME || TRACER_NAME,
    ...exporterOptions,
    // Traces only: left unset, the SDK also starts OTLP metric and log
    // exporters from their environment defaults.
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: [],
  });
  sdk.start();
  activeSdk = sdk;
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    registerCleanup(stopTracing);
  }
  if (!spanProcessors) {
    logger.info(
      `[Tracing] OpenTelemetry traces → ${environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || environment.OTEL_EXPORTER_OTLP_ENDPOINT}`,
    );
  }
  return true;
}

/** Flush and unregister (shutdown, and between test files). */
export async function stopTracing(): Promise<void> {
  const sdk = activeSdk;
  activeSdk = null;
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch (error: unknown) {
    logger.warn(`[Tracing] Shutdown failed: ${getErrorMessage(error)}`);
  }
  trace.disable();
  otelContext.disable();
  propagation.disable();
}

/**
 * W3C trace-context headers (`traceparent`, `tracestate`) for an outgoing
 * request made in `activeContext`. Empty outside a span or with tracing off.
 */
export function traceHeaders(
  activeContext: Context = otelContext.active(),
): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(activeContext, headers);
  return headers;
}

/**
 * A `fetch` that adds `traceHeaders()` of the context active when it is
 * called — for clients that build their own requests (the MCP transports).
 * A header the caller already set wins.
 */
export const tracedFetch: typeof fetch = (input, init) => {
  const outgoing = traceHeaders();
  if (Object.keys(outgoing).length === 0) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  for (const [name, value] of Object.entries(outgoing)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return fetch(input, { ...init, headers });
};

/**
 * `params._meta` for an MCP request made in the active context: the
 * `traceHeaders()` keys, which the MCP semantic conventions carry there
 * (unprefixed, per SEP-414) so they reach the server over any transport.
 * Empty outside a span.
 */
export function traceMeta(): { _meta?: Record<string, string> } {
  const headers = traceHeaders();
  return Object.keys(headers).length > 0 ? { _meta: headers } : {};
}

/**
 * Run one agent turn inside its `invoke_agent` span, and record the span's
 * context on the AgenticContext so the turn's model calls and tools parent
 * to it explicitly. A sub-agent nests under the context it was started in
 * (the spawning tool call); a root turn always starts its own trace, even
 * when it was woken from inside another turn's span.
 */
export async function traceAgentTurn<T>(
  agenticContext: AgenticContext,
  run: (turnSpan: Span) => Promise<T>,
): Promise<T> {
  const {
    agent,
    providerName,
    resolvedModel,
    conversationId,
    agentConversationId,
    parentAgentConversationId,
    traceId,
    project,
    options,
  } = agenticContext;
  const isSubAgent = Boolean(options?.isSubAgent || parentAgentConversationId);
  const parentContext = isSubAgent ? otelContext.active() : ROOT_CONTEXT;
  const span = tracer().startSpan(
    agent ? `invoke_agent ${agent}` : "invoke_agent",
    {
      kind: SpanKind.INTERNAL,
      attributes: definedAttributes({
        [ATTRIBUTES.OPERATION_NAME]: "invoke_agent",
        [ATTRIBUTES.AGENT_NAME]: agent,
        [ATTRIBUTES.CONVERSATION_ID]: conversationId,
        [ATTRIBUTES.PROVIDER_NAME]: genAiProviderName(providerName),
        [ATTRIBUTES.REQUEST_MODEL]: resolvedModel,
        [ATTRIBUTES.PROVIDER]: providerName,
        [ATTRIBUTES.TRACE_ID]: traceId,
        [ATTRIBUTES.PROJECT]: project,
        [ATTRIBUTES.HARNESS]: stringOrUndefined(options?.harness),
        [ATTRIBUTES.AGENT_CONVERSATION_ID]: agentConversationId,
        [ATTRIBUTES.PARENT_AGENT_CONVERSATION_ID]: parentAgentConversationId,
        [ATTRIBUTES.SUB_AGENT]: isSubAgent,
      }),
    },
    parentContext,
  );
  const turnContext = trace.setSpan(parentContext, span);
  agenticContext._traceContext = turnContext;
  try {
    return await otelContext.with(turnContext, () => run(span));
  } catch (error: unknown) {
    recordSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** The turn's totals and how it ended, once its loop has finished. */
export function recordAgentTurnOutcome(
  turnSpan: Span,
  state: AgenticLoopState,
): void {
  const usage = state.overallUsage;
  turnSpan.setAttributes(
    definedAttributes({
      [ATTRIBUTES.TURN_ITERATIONS]: state.iterations,
      [ATTRIBUTES.TURN_OUTCOME]: state.conversationOutcome,
      [ATTRIBUTES.USAGE_INPUT_TOKENS]: getTotalInputTokens(usage),
      [ATTRIBUTES.USAGE_OUTPUT_TOKENS]: usage.outputTokens,
      [ATTRIBUTES.USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheReadInputTokens,
      [ATTRIBUTES.USAGE_CACHE_WRITE_INPUT_TOKENS]: usage.cacheCreationInputTokens,
      [ATTRIBUTES.USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoningOutputTokens,
    }),
  );
  // The harness keeps a failed turn's messages and returns normally, so the
  // outcome is where its failure shows.
  if (OUTCOMES_THAT_FAILED.has(state.conversationOutcome)) {
    turnSpan.setAttribute(ATTRIBUTES.ERROR_TYPE, state.conversationOutcome);
    turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: state.conversationOutcome });
  }
}

/**
 * Open the `chat` span of one provider pass. It starts at `pass.start` —
 * when the pass began building its request — so its duration matches the
 * request row's totalTime.
 */
export function startChatSpan(
  agenticContext: AgenticContext,
  pass: PassState,
  { iteration, requestId }: { iteration: number; requestId: string | null },
): Span {
  const { providerName, resolvedModel, conversationId } = agenticContext;
  const options = pass.options ?? {};
  return tracer().startSpan(
    `chat ${resolvedModel}`,
    {
      kind: SpanKind.CLIENT,
      startTime: pass.start,
      attributes: definedAttributes({
        [ATTRIBUTES.OPERATION_NAME]: "chat",
        [ATTRIBUTES.PROVIDER_NAME]: genAiProviderName(providerName),
        [ATTRIBUTES.REQUEST_MODEL]: resolvedModel,
        [ATTRIBUTES.CONVERSATION_ID]: conversationId,
        [ATTRIBUTES.REQUEST_STREAM]: true,
        [ATTRIBUTES.REQUEST_MAX_TOKENS]: numberOrUndefined(options.maxTokens),
        [ATTRIBUTES.REQUEST_TEMPERATURE]: numberOrUndefined(options.temperature),
        [ATTRIBUTES.REQUEST_TOP_P]: numberOrUndefined(options.topP),
        [ATTRIBUTES.REQUEST_REASONING_LEVEL]: stringOrUndefined(options.reasoningEffort),
        [ATTRIBUTES.PROVIDER]: providerName,
        [ATTRIBUTES.ITERATION]: iteration,
        [ATTRIBUTES.REQUEST_ID]: requestId,
      }),
    },
    parentContextOf(agenticContext),
  );
}

/** Close a pass's `chat` span with what the provider reported. */
export function endChatSpan(
  span: Span,
  pass: PassState,
  { costUsd, error }: { costUsd?: number | null; error?: unknown } = {},
): void {
  const usage = pass.usage;
  const finishReason = pass.refusal ? "refusal" : pass.stopReason;
  span.setAttributes(
    definedAttributes({
      [ATTRIBUTES.RESPONSE_MODEL]: pass.servedModel,
      [ATTRIBUTES.RESPONSE_ID]: pass.providerResponseId,
      [ATTRIBUTES.RESPONSE_FINISH_REASONS]: finishReason ? [finishReason] : undefined,
      [ATTRIBUTES.RESPONSE_TIME_TO_FIRST_CHUNK]:
        pass.firstTokenTime != null ? (pass.firstTokenTime - pass.start) / 1000 : undefined,
      [ATTRIBUTES.USAGE_INPUT_TOKENS]: getTotalInputTokens(usage),
      [ATTRIBUTES.USAGE_OUTPUT_TOKENS]: usage?.outputTokens,
      [ATTRIBUTES.USAGE_CACHE_READ_INPUT_TOKENS]: usage?.cacheReadInputTokens,
      [ATTRIBUTES.USAGE_CACHE_WRITE_INPUT_TOKENS]: usage?.cacheCreationInputTokens,
      [ATTRIBUTES.USAGE_REASONING_OUTPUT_TOKENS]: usage?.reasoningOutputTokens,
      [ATTRIBUTES.COST_USD]: costUsd,
      [ATTRIBUTES.DEVIATION_RULE]: pass.deviation?.ruleId,
    }),
  );
  if (error !== undefined) recordSpanError(span, error);
  span.end();
}

/**
 * Run one tool call inside its `execute_tool` span. The call's tools-service
 * and MCP requests, and any sub-agent it spawns, see this span as active.
 * A result carrying an error marks the span failed; the result itself is
 * returned untouched.
 */
export async function traceToolExecution<T>(
  agenticContext: AgenticContext,
  toolCall: ToolCall,
  execute: () => Promise<T>,
): Promise<T> {
  const parentContext = parentContextOf(agenticContext);
  const approval = toolCall._approval;
  const span = tracer().startSpan(
    `execute_tool ${toolCall.name}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: definedAttributes({
        [ATTRIBUTES.OPERATION_NAME]: "execute_tool",
        [ATTRIBUTES.TOOL_NAME]: toolCall.name,
        [ATTRIBUTES.TOOL_CALL_ID]: toolCall.id,
        [ATTRIBUTES.AGENT_NAME]: agenticContext.agent,
        [ATTRIBUTES.CONVERSATION_ID]: agenticContext.conversationId,
        [ATTRIBUTES.TOOL_TIER]: approval?.tierLabel ?? approval?.tier,
        [ATTRIBUTES.TOOL_APPROVAL]: approvalDecision(toolCall),
        [ATTRIBUTES.TOOL_APPROVAL_LAYER]: approval?.layer,
      }),
    },
    parentContext,
  );
  const startedAt = performance.now();
  try {
    const result = await otelContext.with(
      trace.setSpan(parentContext, span),
      execute,
    );
    span.setAttribute(
      ATTRIBUTES.TOOL_DURATION_MS,
      Math.round(performance.now() - startedAt),
    );
    const errorType = toolResultErrorType(result);
    if (errorType) {
      span.setAttribute(ATTRIBUTES.ERROR_TYPE, errorType);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
    }
    return result;
  } catch (error: unknown) {
    recordSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

/** How the call was cleared to run, from the approval gate's stamp. */
function approvalDecision(toolCall: ToolCall): string {
  const stamp = toolCall._approval;
  if (!stamp) return "none";
  if (stamp.isDenied) return "denied";
  if (stamp.decidedBy === "user" || stamp.layer === "user") {
    return stamp.editedByUser ? "user_edited" : "user_approved";
  }
  if (stamp.reason === "hook_permission_request") return "hook_approved";
  if (stamp.reason === "approve_all") return "user_approved_all";
  return stamp.isApproved ? "auto_approved" : "none";
}

function recordSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setAttribute(ATTRIBUTES.ERROR_TYPE, error.name || "Error");
  } else {
    span.setAttribute(ATTRIBUTES.ERROR_TYPE, "_OTHER");
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: getErrorMessage(error) });
}

function parentContextOf(agenticContext: AgenticContext): Context {
  return agenticContext._traceContext ?? otelContext.active();
}

function genAiProviderName(providerName: string | undefined): string | undefined {
  return providerName ? (PROVIDER_NAMES[providerName] ?? providerName) : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Drop the attributes a context does not have (OTel rejects null values). */
function definedAttributes(
  attributes: Record<string, AttributeValue | null | undefined>,
): Attributes {
  const defined: Attributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) defined[name] = value;
  }
  return defined;
}

import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { ProviderError } from "#src/utils/errors";
import logger from "#src/utils/logger";
import { extractAnthropicRateLimits } from "#src/utils/rateLimits";
import {
  compressImageForSizeLimit,
  extractVideoFramesCached,
  getMaxImageDimensionForModel,
  normalizeImageFormatForProvider,
} from "#src/utils/media";
import { getDocumentContextText } from "#src/utils/documentContext";
import AnthropicFileCacheService, {
  ANTHROPIC_FILES_API_BETA,
  type FileSourceApplication,
} from "#src/services/AnthropicFileCacheService";
import { mergeUsage } from "#src/utils/CostCalculator";
import SettingsService from "#src/services/SettingsService";
import {
  ANTHROPIC_SETTING_DEFAULTS,
  type AnthropicSettings,
} from "#src/constants/AnthropicRequestSettings";
import type { AnthropicThinkingBlock } from "#src/types/admin";
import { EMPTY_USAGE } from "#src/providers/openai-compat";
import { ANTHROPIC_API_KEY } from "#config";
import { MODALITY_TYPES, getDefaultModels, getModelByName } from "#src/config";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "#src/constants/TokenBudgetDefaults";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  callWithRetries,
  isTransientProviderError,
  streamEndedEarlyError,
} from "#src/utils/ProviderStreamResilience";
import {
  hashPromptPrefix,
  isDiagnosticsRejection,
  isProviderDiagnosticsRejected,
  markProviderDiagnosticsRejected,
  requestTelemetryChunk,
  type ProviderCacheDiagnostics,
  type RequestTelemetryChunk,
} from "#src/utils/PromptPrefixHashes";

import {
  type ProviderOptions,
  type ChatMessage,
  type ToolActivation,
} from "#src/types/ProviderTypes";
import {
  TOOL_LOADING_MODES,
  supportsMidConversationSystem,
  type ToolLoadingMode,
} from "#src/providers/toolLoading";
import type { TokenUsage } from "#src/types/admin";

export type { AnthropicThinkingBlock };

/** A `stop_reason: "refusal"` response's `stop_details`, normalised. */
export interface AnthropicRefusal {
  category: string | null;
  explanation: string | null;
  recommendedModel?: string | null;
}

export interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  citations?: Array<{
    type: string;
    url?: string;
    title?: string;
    cited_text?: string;
  }>;
  url?: string;
  title?: string;
  page_age?: string;
}

/** Typed shape for errors thrown by the Anthropic SDK. */
interface AnthropicSdkError extends Error {
  status?: number;
  type?: string;
  error?: { type?: string };
}

/** Result shape returned by generateText/captionImage. */
export interface AnthropicGenerateResult {
  text: string;
  usage: TokenUsage;
  thinking?: string | null;
  thinkingSignature?: string | null;
  citations?: Array<{ url?: string; title?: string; citedText?: string }>;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
  }>;
  rateLimits?: ReturnType<typeof extractAnthropicRateLimits>;
  stopReason?: string;
  stopDetails?: Record<string, unknown>;
  /** Every thinking block of the response, verbatim and in order. */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** Set on `stop_reason: "refusal"` — `text` is then empty. */
  refusal?: AnthropicRefusal;
  /** The model that produced the response, when a fallback served it. */
  servedModel?: string;
}

export type TransformedStreamEvent =
  | string
  // A complete thinking / redacted_thinking block, exactly as the API sent
  // it. `afterContent` marks a block that followed text or a tool call in
  // the same response (a progress update) — the router places it in front
  // of the next tool call.
  | { type: "thinking_block"; block: AnthropicThinkingBlock; afterContent: boolean }
  | { type: "refusal"; category: string | null; explanation: string | null; recommendedModel?: string | null }
  // A server-side fallback took over mid-response: everything the declining
  // model produced before it except text is not replayed.
  | { type: "fallback"; from: string | null; to: string | null }
  | { type: "servedModel"; model: string }
  | { type: "toolCallStart"; id: string; name: string }
  | { type: "codeExecutionResult"; output: string; outcome: string }
  | { type: "webSearchResult"; results: Array<{ url?: string; title?: string; pageAge?: string }> }
  | { type: "executableCode"; code: string; language: string }
  | { type: "toolCall"; id: string | null; name: string | null; args: Record<string, unknown>; argsParseError?: boolean; rawArgs?: string }
  | { type: "thinking"; content: string }
  | { type: "thinking_signature"; signature: string }
  | { type: "toolCallDelta"; characters: number }
  | { type: "stopReason"; stopReason: string }
  | { type: "stopDetails"; stopDetails: unknown }
  | { type: "usage"; usage: TokenUsage }
  | { type: "rateLimits"; rateLimits: ReturnType<typeof extractAnthropicRateLimits> }
  | RequestTelemetryChunk;

/** Rejection-registry key for server-side context editing (PromptPrefixHashes). */
const CONTEXT_EDITING_FEATURE_KEY = "anthropic-context-editing";

/** Beta that returns why the prompt cache missed against a previous message. */
export const ANTHROPIC_CACHE_DIAGNOSIS_BETA = "cache-diagnosis-2026-04-07";

/**
 * The API reads `content: "x"` as `[{ type: "text", text: "x" }]`, and
 * applyCacheBreakpoints converts only the newest message — hash both forms
 * alike so the breakpoint moving on does not read as a rewritten history.
 */
function asTextBlocks(content: unknown): unknown {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Hashes of the final Anthropic payload (tools → system → messages). */
export function hashAnthropicPrefix(payload: Record<string, unknown>) {
  const messages = payload.messages as Array<Record<string, unknown>> | undefined;
  return hashPromptPrefix({
    system: asTextBlocks(payload.system),
    tools: payload.tools as unknown[] | undefined,
    messages: messages?.map((message) => ({
      ...message,
      content: asTextBlocks(message.content),
    })),
  });
}

/**
 * Normalize `message.diagnostics` (beta cache-diagnosis). A null
 * `cache_miss_reason` means the server answered before its background
 * comparison finished; `diagnostics: null` against a previous message is
 * what a full cache hit returns (observed live on claude-sonnet-5,
 * 2026-09-22) — there is no miss to explain.
 */
export function normalizeAnthropicCacheDiagnostics(
  envelope: unknown,
  comparedResponseId: string | null,
): ProviderCacheDiagnostics | null {
  if (envelope === undefined || (envelope === null && !comparedResponseId)) {
    return null;
  }
  if (envelope === null) {
    return {
      source: "anthropic",
      status: "no_miss",
      reason: null,
      missedTokens: null,
      comparedResponseId,
      raw: null,
    };
  }
  const reason = (envelope as { cache_miss_reason?: unknown } | null)
    ?.cache_miss_reason as
    | { type?: string; cache_missed_input_tokens?: number }
    | null
    | undefined;
  const reasonType = reason?.type ?? null;
  const status = !reasonType
    ? "pending"
    : reasonType === "previous_message_not_found"
      ? "comparison_not_found"
      : reasonType === "unavailable"
        ? "unavailable"
        : "cache_miss";
  return {
    source: "anthropic",
    status,
    reason: status === "cache_miss" ? reasonType : null,
    missedTokens:
      typeof reason?.cache_missed_input_tokens === "number"
        ? reason.cache_missed_input_tokens
        : null,
    comparedResponseId,
    raw: envelope,
  };
}

/** Keep the most informative diagnostics seen on the stream. */
function preferDiagnostics(current: unknown, candidate: unknown): unknown {
  if (candidate === undefined) return current;
  const candidateReason = (candidate as { cache_miss_reason?: unknown } | null)
    ?.cache_miss_reason;
  if (current === undefined || candidateReason) return candidate;
  return current;
}

// Default budget tokens mapped from effort level (for non-adaptive models)
const EFFORT_BUDGET_MAP: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 50000,
  xhigh: 100000,
  max: 128000,
};

let client: Anthropic | null = null;

/**
 * An Anthropic Messages–compatible endpoint this adapter runs against for
 * the duration of a call (Kimi K3, providers/moonshot.ts): its client
 * replaces Anthropic's, and adapts each request to what the endpoint takes.
 */
export interface AnthropicCompatibleEndpoint {
  client: () => Anthropic;
}
export const anthropicCompatibleEndpoint = new AsyncLocalStorage<AnthropicCompatibleEndpoint>();

function getClient(): Anthropic {
  const endpoint = anthropicCompatibleEndpoint.getStore();
  if (endpoint) return endpoint.client();
  if (!client) {
    if (!ANTHROPIC_API_KEY) {
      throw new ProviderError("anthropic", "ANTHROPIC_API_KEY is not set", 401);
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

// ── Request surface per model ────────────────────────────────
// Every rule below reads the catalog flags documented at the top of the
// Anthropic section of src/data/models.ts. An uncatalogued newer claude-*
// ID resolves (getModelByName) to the current-generation surface.

const ANTHROPIC_BETA_SERVER_SIDE_FALLBACK = "server-side-fallback-2026-07-01";
const ANTHROPIC_BETA_THINKING_DISPLAY_UPDATES =
  "thinking-display-updates-2026-08-18";
const ANTHROPIC_BETA_THINKING_BINDING = "thinking-binding-controls-2026-08-01";
/** `tool_addition` / `tool_removal` blocks in mid-conversation system messages. */
export const ANTHROPIC_BETA_MID_CONVERSATION_TOOL_CHANGES =
  "mid-conversation-tool-changes-2026-07-01";
/** Turn-scoped (`clear_at: "next_user_message"`) mid-conversation system messages. */
export const ANTHROPIC_BETA_SYSTEM_CLEAR_AT =
  "mid-conversation-system-clear-at-2026-08-21";
/** Server-side context editing (`clear_tool_uses_20250919`). */
export const ANTHROPIC_BETA_CONTEXT_MANAGEMENT = "context-management-2025-06-27";

const EFFORT_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/** Enough output left over for a legacy thinking budget's answer. */
const LEGACY_THINKING_ANSWER_TOKENS = 1024;

/** How many times a `pause_turn` (server tool loop limit) is resumed. */
const MAX_PAUSE_TURN_CONTINUATIONS = 5;

/** Appended when a request would otherwise end on an assistant turn. */
const ASSISTANT_PREFILL_CONTINUATION = "Continue.";

const JSON_OBJECT_INSTRUCTION =
  "Respond with a single JSON object and nothing else — no prose and no code fences.";

export interface AnthropicModelProfile {
  adaptiveThinking: boolean;
  lockedSampling: boolean;
  deprecatedTopK: boolean;
  thinkingAlwaysOn: boolean;
  thinkingDisableMaxEffort?: string;
  noAssistantPrefill: boolean;
  preservedThinking: boolean;
  thinkingDisplayUpdates: boolean;
  serverSideFallbacks: boolean;
  maxOutputTokens?: number;
}

const warnedUncataloguedModels = new Set<string>();

export function resolveAnthropicModelProfile(
  model: string | undefined,
): AnthropicModelProfile {
  const definition = (model ? getModelByName(model) : null) as Record<
    string,
    unknown
  > | null;
  if (
    model &&
    definition?.uncatalogued === true &&
    !warnedUncataloguedModels.has(model)
  ) {
    warnedUncataloguedModels.add(model);
    logger.warn(
      `[anthropic] "${model}" is not in the model catalog — using the current-generation request surface ` +
        `(adaptive thinking, no sampling parameters, 1M / 128K budgets). Catalog it in src/data/models.ts.`,
    );
  }
  const flag = (key: string) => definition?.[key] === true;
  return {
    adaptiveThinking: flag("adaptiveThinking"),
    lockedSampling: flag("lockedSampling"),
    deprecatedTopK: flag("deprecatedTopK"),
    thinkingAlwaysOn: flag("thinkingAlwaysOn"),
    thinkingDisableMaxEffort:
      typeof definition?.thinkingDisableMaxEffort === "string"
        ? definition.thinkingDisableMaxEffort
        : undefined,
    noAssistantPrefill: flag("noAssistantPrefill"),
    preservedThinking: flag("preservedThinking"),
    thinkingDisplayUpdates: flag("thinkingDisplayUpdates"),
    serverSideFallbacks: flag("serverSideFallbacks"),
    maxOutputTokens:
      typeof definition?.maxOutputTokens === "number"
        ? definition.maxOutputTokens
        : undefined,
  };
}

function getAnthropicSettings(): AnthropicSettings {
  const configured = SettingsService.getCached?.()?.anthropic as
    | Partial<AnthropicSettings>
    | undefined;
  return { ...ANTHROPIC_SETTING_DEFAULTS, ...(configured ?? {}) };
}

/**
 * The API accepts `service_tier` "auto" (Priority Tier capacity when the org
 * has it) and "standard_only". Prism's "priority" means the former; there is
 * no Anthropic "flex", so it and anything unknown are omitted (= "auto").
 */
function mapServiceTier(serviceTier: string | undefined) {
  switch (serviceTier) {
    case "standard":
    case "standard_only":
      return "standard_only";
    case "auto":
    case "priority":
      return "auto";
    default:
      return undefined;
  }
}

function normalizeEffort(effort: unknown): string | undefined {
  return typeof effort === "string" && effort in EFFORT_RANK ? effort : undefined;
}

function isJsonObjectFormat(responseFormat: ProviderOptions["responseFormat"]) {
  return (
    responseFormat === "json_object" ||
    (typeof responseFormat === "object" && responseFormat?.type === "json_object")
  );
}

/**
 * Lenient JSON extraction for `json_object` requests sent without a schema:
 * the reply is instructed, not constrained, so accept a fenced block or a
 * JSON object embedded in prose. Returns the text unchanged when nothing
 * parses.
 */
export function extractJsonObjectText(text: string): string {
  const candidates: string[] = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // try the next shape
    }
  }
  return text;
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type.toLowerCase()) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * With `eager_input_streaming` the API no longer validates tool input, so
 * check what the tool needs before running it: an object, every `required`
 * key present, top-level property types and enums honoured. Returns the
 * first violation, or null.
 */
export function findToolInputViolation(
  input: unknown,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (!schema || typeof schema !== "object") return null;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "input is not a JSON object";
  }
  const record = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in record)) {
      return `missing required property "${key}"`;
    }
  }
  const properties = (schema.properties ?? {}) as Record<
    string,
    { type?: unknown; enum?: unknown }
  >;
  for (const [key, value] of Object.entries(record)) {
    const property = properties[key];
    if (!property) continue;
    const types = Array.isArray(property.type)
      ? property.type
      : typeof property.type === "string"
        ? [property.type]
        : [];
    if (
      types.length > 0 &&
      !types.some((type) => typeof type === "string" && matchesJsonType(value, type))
    ) {
      return `property "${key}" is not ${types.join(" | ")}`;
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      return `property "${key}" is not one of ${JSON.stringify(property.enum)}`;
    }
  }
  return null;
}

/**
 * `input_transformations` (thinking-binding-controls beta): each thinking
 * block the API dropped because the model or the conversation prefix
 * changed. An entry means Prism edited history (or switched models).
 */
function logInputTransformations(transformations: unknown, model: string) {
  if (Array.isArray(transformations) && transformations.length > 0) {
    logger.warn(
      `[anthropic] ${model}: the API dropped replayed thinking — input_transformations=${JSON.stringify(transformations)}`,
    );
  }
}

/** Request options carrying every beta the request needs. */
function anthropicRequestOptions(
  betas: string[],
  signal?: AbortSignal,
): { headers?: Record<string, string>; signal?: AbortSignal; maxRetries: number } {
  const uniqueBetas = [...new Set(betas)];
  return {
    // Both call sites retry through ProviderStreamResilience (streams at
    // the harness, callWithRetries here); the SDK's own retries would
    // multiply the attempts and wait out a Retry-After twice.
    maxRetries: 0,
    ...(signal && { signal }),
    ...(uniqueBetas.length > 0 && {
      headers: { "anthropic-beta": uniqueBetas.join(",") },
    }),
  };
}

export interface AnthropicRequest {
  payload: Record<string, unknown>;
  /** Beta headers this request needs (Files API is added by the caller). */
  betas: string[];
}

/**
 * Build the Messages API payload for `model` — the single place the
 * sampling, thinking, effort, output-cap and beta rules live, shared by the
 * streaming and non-streaming paths.
 */
export function buildAnthropicRequest(
  prepared: { systemMessage?: string; messages: ChatMessage[] },
  model: string,
  options: ProviderOptions,
  { streaming }: { streaming: boolean },
): AnthropicRequest {
  const profile = resolveAnthropicModelProfile(model);
  const settings = getAnthropicSettings();
  const betas: string[] = [];

  const jsonObjectRequested = isJsonObjectFormat(options.responseFormat);
  const jsonSchema =
    jsonObjectRequested && options.responseSchema ? options.responseSchema : null;
  let systemPrompt = resolveSystemPrompt(
    options.systemPrompt,
    prepared.systemMessage,
  );
  if (jsonObjectRequested && !jsonSchema) {
    // No real schema: `{type:"object", additionalProperties:false}` only
    // admits `{}`. Instruct instead, and parse the reply leniently.
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${JSON_OBJECT_INSTRUCTION}`
      : JSON_OBJECT_INSTRUCTION;
  }

  const payload: Record<string, unknown> = {
    ...(systemPrompt && { system: systemPrompt }),
    model,
    messages: prepared.messages,
    max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    temperature:
      options.temperature !== undefined
        ? Math.min(options.temperature, 1)
        : undefined,
    top_p:
      options.temperature === undefined && options.topP !== undefined
        ? options.topP
        : undefined,
    top_k: options.topK !== undefined ? options.topK : undefined,
    stop_sequences:
      options.stopSequences !== undefined ? options.stopSequences : undefined,
  };
  const serviceTier = mapServiceTier(options.serviceTier);
  if (serviceTier) payload.service_tier = serviceTier;
  if (jsonSchema) {
    payload.output_config = {
      format: { type: "json_schema" as const, schema: jsonSchema },
    };
  }

  // Locked-sampling models reject temperature / top_p / top_k whatever the
  // thinking state (utility calls send thinking off plus a temperature).
  if (profile.lockedSampling || profile.adaptiveThinking) {
    delete payload.temperature;
    delete payload.top_p;
    delete payload.top_k;
  }
  if (profile.deprecatedTopK) delete payload.top_k;

  const tools = buildTools(options, { eagerInputStreaming: streaming });
  if (tools) payload.tools = tools;
  if (tools && options.toolChoice === "none") {
    // The exhaustion pass: same tool block, no calls.
    payload.tool_choice = { type: "none" };
  }
  if (
    options.toolLoadingMode === TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION &&
    options.deferredTools?.length
  ) {
    betas.push(ANTHROPIC_BETA_MID_CONVERSATION_TOOL_CHANGES);
  }
  if (options.contextEditing && tools?.length) {
    payload.context_management = {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: {
            type: "input_tokens",
            value: options.contextEditing.triggerInputTokens,
          },
          keep: { type: "tool_uses", value: options.contextEditing.keepToolUses },
          clear_at_least: {
            type: "input_tokens",
            value: options.contextEditing.clearAtLeastInputTokens,
          },
        },
      ],
    };
    betas.push(ANTHROPIC_BETA_CONTEXT_MANAGEMENT);
  }
  if (
    (prepared.messages as unknown as Array<Record<string, unknown>>).some(
      (message) => message.clear_at !== undefined,
    )
  ) {
    betas.push(ANTHROPIC_BETA_SYSTEM_CLEAR_AT);
  }

  const requestedEffort = normalizeEffort(options.reasoningEffort);
  const thinkingOff =
    options.thinkingEnabled === false ||
    (options.reasoningEffort as string | undefined) === "none";

  if (profile.adaptiveThinking) {
    let effort = requestedEffort;
    if (!thinkingOff) {
      payload.thinking = { type: "adaptive", ...thinkingDisplay(profile, settings, betas) };
    } else if (profile.thinkingAlwaysOn) {
      // {type:"disabled"} is a 400 here: omit `thinking` and think as
      // little as the model allows.
      effort = "low";
    } else if (
      profile.thinkingDisableMaxEffort &&
      effort &&
      EFFORT_RANK[effort] > EFFORT_RANK[profile.thinkingDisableMaxEffort]
    ) {
      // Disabling thinking above this effort is a 400. The model thinks by
      // default, so omitting `thinking` keeps the requested effort valid.
      logger.info(
        `[anthropic] ${model}: thinking stays on at effort "${effort}" (it can only be disabled at "${profile.thinkingDisableMaxEffort}" or below)`,
      );
    } else {
      payload.thinking = { type: "disabled" };
    }
    if (effort) {
      payload.output_config = {
        ...((payload.output_config as Record<string, unknown>) || {}),
        effort,
      };
    }
    applyThinkingBinding(payload, profile, settings, betas);
  } else if (
    !thinkingOff &&
    (options.thinkingEnabled === true ||
      options.thinkingBudget ||
      options.reasoningEffort)
  ) {
    // Legacy models (Haiku 4.5, 4.5 and older, Opus/Sonnet 4.6's deprecated
    // escape hatch): manual extended thinking with budget_tokens.
    let budget = options.thinkingBudget
      ? parseInt(String(options.thinkingBudget))
      : (requestedEffort ? EFFORT_BUDGET_MAP[requestedEffort] : undefined) ||
        EFFORT_BUDGET_MAP.high;
    let maxTokens = Math.max(
      payload.max_tokens as number,
      budget + LEGACY_THINKING_ANSWER_TOKENS,
    );
    if (profile.maxOutputTokens) {
      maxTokens = Math.min(maxTokens, profile.maxOutputTokens);
    }
    // budget_tokens must stay below max_tokens (the output ceiling caps both)
    budget = Math.max(
      1024,
      Math.min(budget, maxTokens - LEGACY_THINKING_ANSWER_TOKENS),
    );
    payload.thinking = { type: "enabled", budget_tokens: budget };
    payload.max_tokens = maxTokens;
    // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
    payload.temperature = 1;
    delete payload.top_p;
    delete payload.top_k;
  }

  if (
    profile.maxOutputTokens &&
    (payload.max_tokens as number) > profile.maxOutputTokens
  ) {
    payload.max_tokens = profile.maxOutputTokens;
  }

  if (profile.serverSideFallbacks && settings.serverSideFallbacks) {
    payload.fallbacks = "default";
    betas.push(ANTHROPIC_BETA_SERVER_SIDE_FALLBACK);
  }

  return { payload, betas };
}

/** `thinking.display` for an adaptive request, per the setting. */
function thinkingDisplay(
  profile: AnthropicModelProfile,
  settings: AnthropicSettings,
  betas: string[],
): { display?: string } {
  if (settings.thinkingDisplay === "omitted") return {};
  if (settings.thinkingDisplay === "updates" && profile.thinkingDisplayUpdates) {
    betas.push(ANTHROPIC_BETA_THINKING_DISPLAY_UPDATES);
    return { display: "updates" };
  }
  return { display: "summarized" };
}

/**
 * Preserved thinking: on models that bind a block to the conversation
 * prefix, a history edit invalidates later blocks. `drop_block` turns that
 * into a logged drop (input_transformations) instead of a 400.
 */
function applyThinkingBinding(
  payload: Record<string, unknown>,
  profile: AnthropicModelProfile,
  settings: AnthropicSettings,
  betas: string[],
) {
  if (!profile.preservedThinking || settings.thinkingBlockBinding === "off") {
    return;
  }
  const thinking = payload.thinking as Record<string, unknown> | undefined;
  if (thinking?.type === "adaptive") {
    thinking.block_binding = {
      prefix_mismatch_behavior: settings.thinkingBlockBinding,
    };
    betas.push(ANTHROPIC_BETA_THINKING_BINDING);
  } else if (settings.thinkingBlockBinding === "drop_block") {
    // No `thinking` object to carry the field: the beta header alone opts
    // the request into its default, drop_block.
    betas.push(ANTHROPIC_BETA_THINKING_BINDING);
  }
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Walk all Anthropic-format message content blocks and compress any
 * base64 image that exceeds 5 MB. Mutates the messages array in-place.
 */
async function enforceImageSizeLimits(
  messages: ChatMessage[],
  maxDimension?: number,
) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as AnthropicBlock[]) {
      if (block.type !== "image" || block.source?.type !== "base64") continue;
      const data = block.source.data;
      if (!data) continue;

      // Enforce byte-size limit
      const size = data.length; // Anthropic checks base64 STRING length
      if (size <= MAX_IMAGE_BYTES) continue;

      logger.warn(
        `[anthropic] SAFETY NET: image still ${(size / 1024 / 1024).toFixed(2)} MB after prepareMessages. Compressing now...`,
      );
      const result = await compressImageForSizeLimit(
        data,
        block.source.media_type || "image/png",
        undefined,
        maxDimension,
      );
      block.source.data = result.data;
      block.source.media_type = result.mediaType;

      const newSize = result.data.length;
      logger.info(
        `[anthropic] SAFETY NET compressed: ${(size / 1024 / 1024).toFixed(2)} → ${(newSize / 1024 / 1024).toFixed(2)} MB`,
      );
    }
  }
}

/**
 * Whether the model natively accepts `role: "system"` messages
 * mid-conversation: Opus 4.8, Opus 5 / 5.5 and Fable 5 / 5.1 (the catalog's
 * `midConversationSystem` flag; no beta header). Every other Claude model
 * returns a 400 ("role 'system' is not supported on this model"), so their
 * system messages are demoted to user role. Provider-prefixed IDs (Bedrock's
 * "anthropic.claude-opus-4-8") resolve too.
 */
export function supportsMidConversationSystemMessages(model?: string): boolean {
  return supportsMidConversationSystem(model);
}

/** Placeholder block marking where a `tool_reference` activation goes (resolved after merging). */
const TOOL_REFERENCE_ATTACHMENT = "__prism_tool_reference_attachment";

/**
 * A mid-conversation system message's content as Anthropic blocks: its text,
 * then — when the tools are activated with `tool_addition` — one block per
 * added / removed tool (rendered only in that mode; the harness declared the
 * added tools with `defer_loading`).
 */
function systemMessageBlocks(
  text: string,
  activation: ToolActivation | undefined,
  toolLoadingMode: ToolLoadingMode | undefined,
): string | AnthropicBlock[] {
  if (
    !activation ||
    toolLoadingMode !== TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION
  ) {
    return text;
  }
  return [
    ...(text.trim() ? [{ type: "text", text }] : []),
    ...activation.added.map((tool) => ({
      type: "tool_addition",
      tool: { type: "tool_reference", name: tool.name },
    })),
    ...activation.removed.map((toolName) => ({
      type: "tool_removal",
      tool: { type: "tool_reference", name: toolName },
    })),
  ] as unknown as AnthropicBlock[];
}

/**
 * Custom tool search: the tools a `tool_reference`-mode activation loads are
 * referenced from the result of the call that activated them. A tool result
 * that carries references may hold nothing else, so its own text moves to a
 * text block right after it, in the same user turn (verified live on
 * claude-sonnet-5 and claude-haiku-4-5, 2026-09-22). Runs after merging, on
 * placeholders left by the demoted activation message.
 */
function attachToolReferences(messages: ChatMessage[]): void {
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const blocks = message.content as unknown as AnthropicBlock[];
    if (!blocks.some((block) => block.type === TOOL_REFERENCE_ATTACHMENT)) continue;
    const output: AnthropicBlock[] = [];
    const attachments: Array<{ names: string[]; sourceToolCallId?: string | null }> = [];
    for (const block of blocks) {
      if (block.type === TOOL_REFERENCE_ATTACHMENT) {
        attachments.push(
          block as unknown as { names: string[]; sourceToolCallId?: string | null },
        );
      } else {
        output.push(block);
      }
    }
    for (const attachment of attachments) {
      const results = output.filter((block) => block.type === "tool_result");
      const target =
        results.find((block) => block.tool_use_id === attachment.sourceToolCallId) ??
        results[results.length - 1];
      if (!target) {
        logger.warn(
          `[anthropic] No tool result to carry tool_reference for [${attachment.names.join(", ")}] — not loaded`,
        );
        continue;
      }
      const existing = Array.isArray(target.content) ? target.content : [];
      const alreadyReferences = existing.every(
        (block) => (block as { type?: string }).type === "tool_reference",
      );
      const references = [
        ...(alreadyReferences ? existing : []),
        ...attachment.names.map((toolName) => ({
          type: "tool_reference",
          tool_name: toolName,
        })),
      ];
      if (!alreadyReferences || typeof target.content === "string") {
        const originalText =
          typeof target.content === "string"
            ? target.content
            : JSON.stringify(target.content);
        output.splice(output.indexOf(target) + 1, 0, {
          type: "text",
          text: originalText,
        });
      }
      target.content = references as unknown as AnthropicBlock[];
    }
    message.content = output as unknown as ChatMessage["content"];
  }
}

/**
 * Convert one attachment reference into Anthropic content blocks,
 * routed by MIME type. NOTHING is dropped silently: media the model
 * cannot perceive natively (audio, unresolved refs, failed video
 * extraction) becomes a visible text placeholder that also points the
 * model at the tool-side "attached" escape hatch.
 */
async function buildMediaBlocksForReference(
  reference: string,
  maxDimension: number,
): Promise<AnthropicBlock[]> {
  const match = reference.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    // Non-data references. HTTP(S) image URLs are supported natively via
    // url sources; anything else (e.g. an unresolved minio:// ref) gets a
    // visible placeholder instead of a silent drop.
    if (reference.startsWith("http://") || reference.startsWith("https://")) {
      return [{ type: "image", source: { type: "url", url: reference } }];
    }
    return [
      {
        type: "text",
        text: `[Attached file (unresolved reference "${reference.substring(0, 80)}") — content unavailable to this model]`,
      },
    ];
  }

  let mimeType = match[1];
  let data = match[2];

  // Normalize provider-hostile formats (HEIC/HEIF → JPEG, SVG → PNG) —
  // safety belt for references that bypassed MediaResolutionService.
  // text/plain results are visible conversion fallbacks: emit them as
  // text blocks, never as broken image blocks.
  if (
    mimeType.startsWith("image/") ||
    mimeType === "application/octet-stream"
  ) {
    try {
      const normalized = await normalizeImageFormatForProvider(
        data,
        mimeType,
        maxDimension,
      );
      if (normalized.converted) {
        if (normalized.mediaType === "text/plain") {
          return [
            {
              type: "text",
              text: Buffer.from(normalized.data, "base64").toString("utf-8"),
            },
          ];
        }
        data = normalized.data;
        mimeType = normalized.mediaType;
      }
    } catch (error: unknown) {
      logger.warn(
        `[anthropic] Image format normalization failed: ${getErrorMessage(error)} — continuing with original data`,
      );
    }
  }

  if (mimeType.startsWith("image/")) {
    // Image content block
    let mediaType = mimeType;
    if (data.startsWith("/9j/")) mediaType = "image/jpeg";
    else if (data.startsWith("iVBOR")) mediaType = "image/png";
    else if (data.startsWith("R0lG")) mediaType = "image/gif";
    else if (data.startsWith("UklG")) mediaType = "image/webp";

    // Enforce Anthropic's 5 MB per-image limit
    logger.info(
      `[anthropic] Image block: ${mediaType}, b64_len=${data.length} (${(data.length / 1024 / 1024).toFixed(2)} MB), decoded=${(Buffer.byteLength(data, "base64") / 1024 / 1024).toFixed(2)} MB`,
    );
    const compressed = await compressImageForSizeLimit(
      data,
      mediaType,
      undefined,
      maxDimension,
    );
    data = compressed.data;
    mediaType = compressed.mediaType;

    return [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      },
    ];
  }

  if (mimeType === "application/pdf") {
    // PDF document content block
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      },
    ];
  }

  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    // Text-based files — decode and inline as text
    try {
      const decoded = Buffer.from(data, "base64").toString("utf-8");
      return [
        { type: "text", text: `[Attached file (${mimeType})]:\n${decoded}` },
      ];
    } catch {
      return [
        {
          type: "text",
          text: `[Attached file (${mimeType}): unable to decode]`,
        },
      ];
    }
  }

  if (mimeType.startsWith("audio/")) {
    // Anthropic models cannot hear audio — visible placeholder, never silent
    return [
      {
        type: "text",
        text: `[Attached audio file (${mimeType}) — this model cannot hear audio directly. Audio tools (e.g. transcribe_audio) can access it via their "attached" input.]`,
      },
    ];
  }

  if (mimeType.startsWith("video/")) {
    // Expand into sampled frames (cache-stable across turns); if ffmpeg is
    // unavailable or extraction fails, fall back to a text placeholder.
    try {
      const frames = await extractVideoFramesCached(reference);
      const blocks: AnthropicBlock[] = [
        {
          type: "text",
          text: `[Attached video (${mimeType}) — showing ${frames.length} sampled frame${frames.length === 1 ? "" : "s"} at 1fps; video tools can access the full file via "attached"]`,
        },
      ];
      for (const frameDataUrl of frames) {
        const frameMatch = frameDataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!frameMatch) continue;
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: frameMatch[1],
            data: frameMatch[2],
          },
        });
      }
      return blocks;
    } catch (error: unknown) {
      logger.warn(
        `[anthropic] Video frame extraction failed: ${getErrorMessage(error)} — inserting placeholder`,
      );
      return [
        {
          type: "text",
          text: `[Attached video file (${mimeType}) — this model cannot watch video directly and frame extraction is unavailable. Video tools can access it via their "attached" input.]`,
        },
      ];
    }
  }

  // Unknown MIME type — visible placeholder, never silent
  return [
    {
      type: "text",
      text: `[Attached file (${mimeType}) — this file type is not directly readable by this model. Tools may access it via their "attached" input.]`,
    },
  ];
}

/**
 * A mid-conversation system message that breaks placement rules goes out
 * as user text: a user turn carries no `clear_at` and no tool-change blocks.
 */
function demoteSystemMessage(message: ChatMessage): void {
  const record = message as unknown as Record<string, unknown>;
  message.role = "user";
  delete record.clear_at;
  if (Array.isArray(message.content)) {
    const blocks = message.content as unknown as AnthropicBlock[];
    const kept = blocks.filter(
      (block) => block.type !== "tool_addition" && block.type !== "tool_removal",
    );
    if (kept.length !== blocks.length) {
      logger.warn(
        "[anthropic] A tool-change system message could not stay a system message (placement) — its tool_addition / tool_removal blocks were dropped",
      );
    }
    message.content = (kept.length > 0
      ? kept
      : [{ type: "text", text: " " }]) as unknown as ChatMessage["content"];
  }
}

/** Merge consecutive same-role messages into a single turn. */
function mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
  return messages.reduce((acc: ChatMessage[], current: ChatMessage) => {
    if (acc.length && acc[acc.length - 1].role === current.role) {
      const previous = acc[acc.length - 1];
      // A merged system message is turn-scoped only if every part was.
      const previousRecord = previous as unknown as Record<string, unknown>;
      if (
        previousRecord.clear_at !==
        (current as unknown as Record<string, unknown>).clear_at
      ) {
        delete previousRecord.clear_at;
      }
      // Handle merging when content might be string or array
      if (
        typeof previous.content === "string" &&
        typeof current.content === "string"
      ) {
        previous.content += `\n\n${current.content}`;
      } else {
        // Convert both to arrays and concat
        const previousBlocks =
          typeof previous.content === "string"
            ? [{ type: "text", text: previous.content }]
            : previous.content || [];
        const currentBlocks =
          typeof current.content === "string"
            ? [{ type: "text", text: current.content }]
            : current.content || [];
        previous.content = [...previousBlocks, ...currentBlocks];
      }
    } else {
      acc.push({ ...current });
    }
    return acc;
  }, []);
}

/** A stored thinking block as the API wants it back: Prism's placement keys removed. */
function replayableThinkingBlock(block: AnthropicThinkingBlock): AnthropicBlock {
  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking", data: block.data } as AnthropicBlock;
  }
  return { type: "thinking", thinking: block.thinking, signature: block.signature };
}

/**
 * Lay out an assistant turn's content with its stored thinking blocks in
 * the order the model produced them: leading blocks first, a progress
 * update in front of the tool call it introduced, trailing blocks last.
 * Blocks are replayed byte-for-byte — never merged, trimmed or skipped for
 * being empty (display "omitted" returns empty text with a valid signature).
 */
function layoutAssistantTurn(
  thinkingBlocks: AnthropicThinkingBlock[],
  textBlocks: AnthropicBlock[],
  toolUseBlocks: AnthropicBlock[],
): AnthropicBlock[] {
  const toolIds = new Set(toolUseBlocks.map((block) => block.id));
  const leading: AnthropicBlock[] = [];
  const trailing: AnthropicBlock[] = [];
  const beforeTool = new Map<string, AnthropicBlock[]>();
  for (const block of thinkingBlocks) {
    const replayable = replayableThinkingBlock(block);
    if (block.beforeToolCallId && toolIds.has(block.beforeToolCallId)) {
      const queue = beforeTool.get(block.beforeToolCallId) ?? [];
      queue.push(replayable);
      beforeTool.set(block.beforeToolCallId, queue);
    } else if (block.beforeToolCallId || block.trailing) {
      trailing.push(replayable);
    } else {
      leading.push(replayable);
    }
  }
  const content: AnthropicBlock[] = [...leading, ...textBlocks];
  for (const toolUse of toolUseBlocks) {
    content.push(...(beforeTool.get(toolUse.id as string) ?? []), toolUse);
  }
  content.push(...trailing);
  return content;
}

/**
 * Anthropic requires alternating user/assistant roles and handles system messages separately.
 * This helper extracts the system message and merges consecutive same-role messages.
 *
 * Pass `model` so mid-conversation system messages can be kept as
 * `role: "system"` on models that support them (Opus 4.8) instead of being
 * demoted to user role.
 */
export async function prepareMessages(
  messages: ChatMessage[],
  model?: string,
  { toolLoadingMode }: { toolLoadingMode?: ToolLoadingMode } = {},
) {
  let systemMessage: string | undefined;
  const keepSystemRole = supportsMidConversationSystemMessages(model);
  // High-res Anthropic vision models accept a 2576px long edge; everything
  // else keeps the conservative 2000px default.
  const maxImageDimension = getMaxImageDimensionForModel(model);

  // Extract system message
  const conversation = messages.map((chatMessage: ChatMessage) => ({
    ...chatMessage,
  }));
  if (conversation.length > 0 && conversation[0].role === "system") {
    const extractedContent = conversation.shift()?.content as string | undefined;
    // Anthropic rejects system text blocks containing only whitespace.
    // Normalise empty/whitespace-only values to undefined so the field
    // is omitted from the API payload entirely.
    systemMessage = extractedContent?.trim() ? extractedContent : undefined;
  }

  // Build clean messages with ONLY the fields Anthropic's API accepts.
  // Whitelist approach: explicitly construct each output object instead of
  // destructuring + ...rest, which leaks any new internal fields (e.g.
  // _ttftSamples, _liveGenProgress, _workerTokens) into the API payload.
  //
  // Mid-conversation system messages are kept as role: "system" on models
  // that support them (Opus 4.8) and demoted to user role everywhere else.
  // Either way the harness wraps their content in semantic XML tags
  // (see utils/SystemMessageTags.ts), so demoted messages remain
  // distinguishable from genuine user input.
  const cleaned = await Promise.all(
    conversation
      .filter(
        (chatMessage: ChatMessage) =>
          chatMessage.role === "user" ||
          chatMessage.role === "assistant" ||
          chatMessage.role === "tool" ||
          chatMessage.role === "system",
      )
      .map(async (message: ChatMessage) => {
        // Convert tool role messages to tool_result user messages for Anthropic
        if (message.role === "tool") {
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id:
                  message.tool_call_id ||
                  message.id ||
                  message.name ||
                  "unknown",
                content:
                  typeof message.content === "string"
                    ? message.content
                    : JSON.stringify(message.content),
              },
            ],
          };
        }

        // Mid-conversation system messages (e.g. dynamic tool updates from
        // the harness). On models with native support they stay system-role
        // (position constraints are enforced after merging); elsewhere they
        // are demoted to user role — the harness's XML tags let the model
        // distinguish them from actual user messages.
        if (message.role === "system") {
          const text =
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content);
          if (keepSystemRole) {
            return {
              role: "system",
              content: systemMessageBlocks(
                text,
                message.toolActivation,
                toolLoadingMode,
              ),
              // A one-turn nudge renders for this turn only and stays in
              // the transcript (beta mid-conversation-system-clear-at).
              ...(message.turnScoped && { clear_at: "next_user_message" }),
            };
          }
          const activation = message.toolActivation;
          if (
            activation?.added.length &&
            toolLoadingMode === TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE
          ) {
            return {
              role: "user",
              content: [
                { type: "text", text },
                {
                  type: TOOL_REFERENCE_ATTACHMENT,
                  names: activation.added.map((tool) => tool.name),
                  sourceToolCallId: activation.sourceToolCallId ?? null,
                },
              ],
            };
          }
          return { role: "user", content: text };
        }

        // Convert assistant messages with toolCalls to multi-part content
        if (
          message.role === "assistant" &&
          message.toolCalls &&
          message.toolCalls.length > 0
        ) {
          const textBlocks: AnthropicBlock[] =
            typeof message.content === "string" && message.content.trim()
              ? [{ type: "text", text: message.content }]
              : [];
          const toolUseBlocks: AnthropicBlock[] = message.toolCalls.map(
            (toolCall) => ({
              type: "tool_use",
              id: toolCall.id || toolCall.name || `toolCall-${Date.now()}`,
              name: toolCall.name,
              input: (toolCall.args as Record<string, unknown>) || {},
            }),
          );
          // Every thinking block of the turn, verbatim and in order.
          if (message.thinkingBlocks?.length) {
            return {
              role: "assistant",
              content: layoutAssistantTurn(
                message.thinkingBlocks,
                textBlocks,
                toolUseBlocks,
              ),
            };
          }
          // Legacy documents (before thinkingBlocks): one merged thinking
          // text with the last block's signature. Only replayed when both
          // exist — the API rejects a thinking block without its signature.
          const contentBlocks: AnthropicBlock[] = [];
          if (message.thinking && message.thinkingSignature) {
            contentBlocks.push({
              type: "thinking",
              thinking: message.thinking,
              signature: message.thinkingSignature,
            });
          }
          contentBlocks.push(...textBlocks, ...toolUseBlocks);
          return {
            role: "assistant",
            content: contentBlocks,
          };
        }

        // Convert messages with media to Anthropic content block format.
        // All media array fields participate — images (which may also carry
        // PDFs/text files/videos routed by MIME type), plus the dedicated
        // audio/video/pdf arrays. Unsupported media becomes visible text
        // placeholders instead of being dropped silently.
        const mediaReferences: string[] = [
          ...(message.images || []),
          ...(Array.isArray(message.audio) ? message.audio : []),
          ...(Array.isArray(message.video) ? message.video : []),
          ...(Array.isArray(message.pdf) ? message.pdf : []),
        ];
        const documentReferences = Array.isArray(message.documents)
          ? message.documents
          : [];
        if (mediaReferences.length > 0 || documentReferences.length > 0) {
          const contentBlocks: AnthropicBlock[] = [];
          for (const reference of mediaReferences) {
            contentBlocks.push(
              ...(await buildMediaBlocksForReference(
                reference,
                maxImageDimension,
              )),
            );
          }
          // Document attachments — small text-like documents were primed
          // at resolution time and inline their content directly; binary
          // or oversized documents keep the reader-tool pointer (the model
          // reads those via reader tools using the "attached" input).
          for (const documentReference of documentReferences) {
            contentBlocks.push({
              type: "text",
              text: getDocumentContextText(documentReference),
            });
          }
          const textContent =
            typeof message.content === "string" ? message.content : "";
          if (textContent) {
            contentBlocks.push({ type: "text", text: textContent });
          }
          return {
            role: message.role,
            content: contentBlocks.length > 0 ? contentBlocks : message.content,
          };
        }

        // Handle assistant messages that have thinking but no toolCalls.
        // Anthropic requires thinking blocks as structured content blocks,
        // not top-level fields — convert them into the proper format.
        // Only include thinking when we have the signature; conversations
        // without it must omit the block to avoid API 400 errors.
        if (
          message.role === "assistant" &&
          message.thinkingBlocks?.length &&
          !message.toolCalls?.length
        ) {
          const textBlocks: AnthropicBlock[] = [
            {
              type: "text",
              text:
                typeof message.content === "string" && message.content.trim()
                  ? message.content
                  : " ",
            },
          ];
          return {
            role: "assistant",
            content: layoutAssistantTurn(message.thinkingBlocks, textBlocks, []),
          };
        }
        if (
          message.role === "assistant" &&
          message.thinking &&
          !message.toolCalls?.length
        ) {
          const contentBlocks: AnthropicBlock[] = [];
          if (message.thinkingSignature) {
            contentBlocks.push({
              type: "thinking",
              thinking: message.thinking,
              signature: message.thinkingSignature,
            });
          }
          if (typeof message.content === "string" && message.content.trim()) {
            contentBlocks.push({ type: "text", text: message.content });
          } else {
            contentBlocks.push({ type: "text", text: " " });
          }
          return {
            role: "assistant",
            content:
              contentBlocks.length > 1
                ? contentBlocks
                : (typeof message.content === "string"
                    ? message.content.trim()
                    : "") || " ",
          };
        }

        // Ensure assistant messages never have empty content
        if (
          message.role === "assistant" &&
          (!message.content ||
            (typeof message.content === "string" && !message.content.trim()))
        ) {
          return { role: "assistant", content: " " };
        }

        // Default: user or assistant with plain text — whitelist only role + content
        return { role: message.role, content: message.content || " " };
      }),
  );

  // Merge consecutive same-role messages
  let merged = mergeConsecutiveSameRole(cleaned);

  // Enforce Anthropic's placement rules for retained mid-conversation
  // system messages: a system message cannot be messages[0], must follow a
  // user message, and must be either the last entry or followed by an
  // assistant turn. Demote any message violating these to user role, then
  // re-merge in case the demotion created adjacent user messages.
  if (keepSystemRole) {
    let demotedAny = false;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i].role !== "system") continue;
      const followsUser = i > 0 && merged[i - 1].role === "user";
      const validSuccessor =
        i === merged.length - 1 || merged[i + 1].role === "assistant";
      if (!followsUser || !validSuccessor) {
        demoteSystemMessage(merged[i]);
        demotedAny = true;
      }
    }
    if (demotedAny) {
      merged = mergeConsecutiveSameRole(merged);
    }
  }

  // Deduplicate tool_result blocks within merged user messages.
  // Anthropic requires exactly one tool_result per tool_use_id.
  // The frontend may send both inline results (from assistant.toolCalls
  // expansion) and standalone tool-role messages with the same ID,
  // which after merging creates duplicate tool_result blocks.
  for (const message of merged) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const seenToolResultIds = new Set();
    message.content = (message.content as AnthropicBlock[]).filter(
      (block: AnthropicBlock) => {
        if (block.type !== "tool_result") return true;
        if (seenToolResultIds.has(block.tool_use_id)) return false;
        seenToolResultIds.add(block.tool_use_id);
        return true;
      },
    );
  }

  // Custom tool search: tool references into the activating call's result.
  attachToolReferences(merged);

  // Ensure conversation starts with a user message
  if (merged.length > 0 && merged[0].role === "assistant") {
    merged.shift();
  }

  // Strip orphaned tool_use blocks: if an assistant message has tool_use
  // content blocks but the next message is NOT a tool_result, remove them.
  // This handles stale conversation history loaded from the database.
  for (let i = 0; i < merged.length; i++) {
    const message = merged[i];
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;

    const hasToolUse = (message.content as AnthropicBlock[]).some(
      (b: AnthropicBlock) => b.type === "tool_use",
    );
    if (!hasToolUse) continue;

    const next = merged[i + 1];
    const nextHasToolResult =
      next?.role === "user" &&
      Array.isArray(next.content) &&
      next.content.some((b: AnthropicBlock) => b.type === "tool_result");

    if (!nextHasToolResult) {
      // Strip tool_use blocks, keep only text
      message.content = (message.content as AnthropicBlock[]).filter(
        (b: AnthropicBlock) => b.type !== "tool_use",
      );
      if (message.content.length === 0) {
        message.content = " ";
      }
    }
  }

  // Anthropic rejects requests where the final assistant message content ends
  // with trailing whitespace (400: "final assistant content cannot end with
  // trailing whitespace"). Sanitize all assistant text blocks to be safe.
  for (const message of merged) {
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") {
      message.content = message.content.trimEnd() || " ";
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text = block.text.trimEnd() || " ";
        }
      }
    }
  }

  // Defense in depth: every Claude 4.6+ model rejects a request that ends
  // on an assistant turn (prefill). The harness never builds one; if some
  // path does, continue the turn instead of sending a guaranteed 400.
  if (
    merged.length > 0 &&
    merged[merged.length - 1].role === "assistant" &&
    resolveAnthropicModelProfile(model).noAssistantPrefill
  ) {
    logger.warn(
      `[anthropic] Request for ${model} ended on an assistant turn — appending a user continuation (this model rejects prefill).`,
    );
    merged.push({ role: "user", content: ASSISTANT_PREFILL_CONTINUATION });
  }

  return { systemMessage, messages: merged };
}
export function buildTools(
  options: ProviderOptions,
  { eagerInputStreaming = false }: { eagerInputStreaming?: boolean } = {},
) {
  const tools: Array<Record<string, unknown>> = [];
  if (options.webSearch) {
    tools.push({
      type: "web_search_20260209",
      name: "web_search",
      max_uses: 5,
    });
  }
  if (options.webFetch) {
    tools.push({
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: 10,
    });
  }
  if (options.codeExecution) {
    tools.push({
      type: "code_execution_20260120",
      name: "code_execution",
    });
  }
  // Custom function calling tools
  if (options.tools && Array.isArray(options.tools)) {
    for (const tool of options.tools) {
      tools.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.parameters || { type: "object", properties: {} },
        // Streamed requests: input arrives as it is generated instead of
        // after server-side buffering — which also means unvalidated, so
        // the stream checks it against the schema (findToolInputViolation).
        ...(eagerInputStreaming && { eager_input_streaming: true }),
      });
    }
  }
  // Tools the conversation may activate later, declared now and loaded only
  // when a tool_addition / tool_reference says so — the tool block never
  // changes mid-conversation (providers/toolLoading.ts).
  const declaredNames = new Set(tools.map((tool) => tool.name));
  if (
    options.deferredTools?.length &&
    (options.toolLoadingMode === TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION ||
      options.toolLoadingMode === TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE) &&
    tools.length > 0
  ) {
    for (const tool of options.deferredTools) {
      if (declaredNames.has(tool.name)) continue;
      tools.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.parameters || { type: "object", properties: {} },
        ...(eagerInputStreaming && { eager_input_streaming: true }),
        defer_loading: true,
      });
    }
  }
  return tools.length > 0 ? tools : undefined;
}
export function extractResponseContent(contentBlocks: AnthropicBlock[]) {
  let text = "";
  let thinking = null;
  let thinkingSignature = null;
  const citations: Array<{ url?: string; title?: string; citedText?: string }> =
    [];
  const toolCalls: Array<{
    id?: string;
    name?: string;
    args: Record<string, unknown>;
  }> = [];
  const thinkingBlocks: AnthropicThinkingBlock[] = [];
  let fallbackTo: string | null = null;

  // A `fallback` block marks a server-side fallback: the thinking and
  // client tool calls the declining model produced before the last one are
  // never echoed back (the fallback model cannot read them).
  const blocks = contentBlocks || [];
  const lastFallbackIndex = blocks.map((block) => block.type).lastIndexOf("fallback");
  let sawContent = false;
  let pendingPlacement: AnthropicThinkingBlock[] = [];

  for (const [blockIndex, block] of blocks.entries()) {
    const beforeFallback = blockIndex < lastFallbackIndex;
    if (block.type === "fallback") {
      fallbackTo =
        ((block as { to?: { model?: string } }).to?.model as string) ?? fallbackTo;
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      if (block.type === "thinking") {
        thinking = block.thinking;
        if (block.signature) thinkingSignature = block.signature;
      }
      if (beforeFallback) continue;
      // Unsigned (cut off mid-thought): cannot be replayed.
      if (block.type === "thinking" && !block.signature) continue;
      const stored: AnthropicThinkingBlock =
        block.type === "thinking"
          ? {
              type: "thinking",
              thinking: block.thinking ?? "",
              signature: block.signature ?? "",
            }
          : {
              type: "redacted_thinking",
              data: (block as { data?: string }).data ?? "",
            };
      if (sawContent) {
        stored.trailing = true;
        pendingPlacement.push(stored);
      }
      thinkingBlocks.push(stored);
      continue;
    }
    if (block.type === "tool_use") {
      if (beforeFallback) continue;
      for (const pending of pendingPlacement) {
        delete pending.trailing;
        pending.beforeToolCallId = block.id;
      }
      pendingPlacement = [];
    }
    sawContent = true;
    if (block.type === "text") {
      text += block.text || "";
      // Collect inline citations from this text block
      if (block.citations) {
        for (const cite of block.citations) {
          if (cite.type === "web_search_result_location") {
            citations.push({
              url: cite.url,
              title: cite.title,
              citedText: cite.cited_text,
            });
          }
        }
      }
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input || {},
      });
    }
    // server_tool_use and *_tool_result blocks are informational — skip
  }

  return {
    text,
    thinking,
    thinkingSignature,
    citations,
    toolCalls,
    thinkingBlocks,
    fallbackTo,
  };
}
interface AnthropicUsageCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** One attempt in `usage.iterations` (server-side fallback). */
interface AnthropicUsageIteration extends AnthropicUsageCounts {
  type?: string;
  model?: string;
}

/**
 * Token usage of a response. With server-side fallback, top-level `usage`
 * covers only the attempt that produced the message, and
 * `usage.iterations` is the per-attempt billing record: an attempt that
 * declined before any output is not billed, every other attempt bills at
 * its own model's rates. Those are summed, and `byModel` carries the split
 * so calculateTextCost prices each part correctly.
 */
export function buildUsage(
  responseUsage:
    | (AnthropicUsageCounts & { iterations?: AnthropicUsageIteration[] | null })
    | null
    | undefined,
): TokenUsage {
  const iterations = responseUsage?.iterations;
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return {
      inputTokens: responseUsage?.input_tokens ?? 0,
      outputTokens: responseUsage?.output_tokens ?? 0,
      cacheReadInputTokens: responseUsage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: responseUsage?.cache_creation_input_tokens ?? 0,
    };
  }
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const iteration of iterations) {
    if (!iteration.output_tokens) continue; // declined before output: not billed
    const counts = {
      inputTokens: iteration.input_tokens ?? 0,
      outputTokens: iteration.output_tokens ?? 0,
      cacheReadInputTokens: iteration.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: iteration.cache_creation_input_tokens ?? 0,
    };
    mergeUsage(usage, {
      ...counts,
      ...(iteration.model && { byModel: { [iteration.model]: counts } }),
    });
  }
  return usage;
}

/**
 * Resolve the effective system prompt for Anthropic's `system:` field.
 *
 * The identity prompt (persona, tool policy, guidelines) flows through
 * `options.systemPrompt` as a first-class parameter from the harness.
 * Contextual injections (local time, agent memory) may also arrive via
 * the messages array as a leading `role: "system"` message, extracted by
 * `prepareMessages` into `prepared.systemMessage`. When both exist, the
 * identity prompt takes precedence and the contextual block is appended.
 */
export function resolveSystemPrompt(
  identityPrompt: string | undefined,
  contextualSystemMessage: string | undefined,
): string | undefined {
  if (identityPrompt && contextualSystemMessage) {
    return `${identityPrompt}\n\n${contextualSystemMessage}`;
  }
  return identityPrompt || contextualSystemMessage;
}

const EPHEMERAL_CACHE = { type: "ephemeral" } as const;

/**
 * Attach real prompt-cache breakpoints to the request.
 *
 * The Anthropic API only honors `cache_control` on system blocks, tool
 * definitions, and message content blocks — the previous top-level
 * `cache_control` key on the payload root was silently ignored, so prompt
 * caching was effectively disabled for every agentic turn.
 *
 * Breakpoints (≤4 allowed; we use up to 3):
 *   1. Last tool definition   → caches the (large, stable) tool schema block
 *   2. System prompt block    → caches the assembled system prompt
 *   3. Last message block     → moving marker; each turn re-hits the prefix
 *      cached by the previous turn's marker and extends it.
 */
export function applyCacheBreakpoints(payload: Record<string, unknown>): void {
  // 1. Tools — serialize first in the prompt; mark the last loaded
  //    definition (a deferred one cannot carry cache_control — a 400).
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    let markIndex = tools.length - 1;
    while (markIndex >= 0 && tools[markIndex].defer_loading === true) markIndex--;
    if (markIndex >= 0) {
      tools[markIndex] = { ...tools[markIndex], cache_control: EPHEMERAL_CACHE };
    }
  }

  // 2. System — convert the plain string to a cacheable text block
  if (typeof payload.system === "string" && payload.system.trim()) {
    payload.system = [
      { type: "text", text: payload.system, cache_control: EPHEMERAL_CACHE },
    ];
  }

  // 3. Messages — moving breakpoint on the last cacheable content block.
  //    A turn-scoped (clear_at) system message takes no cache_control: the
  //    breakpoint goes on the turn before it.
  const messages = payload.messages as
    | Array<{ content: unknown; [key: string]: unknown }>
    | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return;
  let lastIndex = messages.length - 1;
  while (lastIndex > 0 && messages[lastIndex].clear_at !== undefined) lastIndex--;
  const lastMessage = messages[lastIndex];
  if (typeof lastMessage.content === "string") {
    if (!lastMessage.content.trim()) return; // empty text blocks are rejected
    lastMessage.content = [
      {
        type: "text",
        text: lastMessage.content,
        cache_control: EPHEMERAL_CACHE,
      },
    ];
    return;
  }
  if (Array.isArray(lastMessage.content)) {
    const blocks = lastMessage.content as Array<Record<string, unknown>>;
    // cache_control is not allowed on thinking blocks — walk back to the
    // last block that accepts it.
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex];
      if (block.type === "thinking" || block.type === "redacted_thinking")
        continue;
      if (block.type === "text" && !String(block.text ?? "").trim()) continue;
      blocks[blockIndex] = { ...block, cache_control: EPHEMERAL_CACHE };
      return;
    }
  }
}

const anthropicProvider = {
  name: "anthropic",

  async generateText(
    messages: ChatMessage[],
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).anthropic,
    options: ProviderOptions = {},
  ): Promise<AnthropicGenerateResult> {
    logger.provider("Anthropic", `generateText model=${model}`);

    const prepared = await prepareMessages(messages, model, {
      toolLoadingMode: options.toolLoadingMode,
    });
    const { payload, betas } = buildAnthropicRequest(prepared, model, options, {
      streaming: false,
    });

    // Upload-once media: swap large inline base64 image/PDF blocks for
    // Files API file_id references (first-party API only). Falls back to
    // inline base64 on any Files API failure.
    let fileSources: FileSourceApplication = {
      applied: false,
      substitutions: [],
      fileIds: [],
    };
    if (!options.disableAnthropicFileSources) {
      fileSources = await AnthropicFileCacheService.applyFileSources(
        prepared.messages as Array<{ content?: unknown }>,
      );
    }

    applyCacheBreakpoints(payload);
    const requestBetas = [
      ...(fileSources.applied ? [ANTHROPIC_FILES_API_BETA] : []),
      ...betas,
    ];

    try {
      // A server tool loop that hits its iteration limit stops with
      // `pause_turn`: send the paused assistant content back as-is (no
      // extra user turn) and the API resumes where it left off.
      const pages: Anthropic.Messages.Message[] = [];
      let rateLimits: ReturnType<typeof extractAnthropicRateLimits> | null =
        null;
      for (let continuation = 0; ; continuation++) {
        // Transient failures (overloaded, rate limit, network) retry via the
        // shared provider resilience policy — same classification and jittered
        // backoff the harness applies to streams.
        const { data: response, response: rawResponse } = await callWithRetries(
          () =>
            getClient()
              .messages.create(
                payload as unknown as Anthropic.MessageCreateParamsNonStreaming,
                anthropicRequestOptions(requestBetas),
              )
              .withResponse(),
          { signal: options.signal, label: "anthropic" },
        );
        rateLimits ??= extractAnthropicRateLimits(rawResponse, model);
        const page = response as Anthropic.Messages.Message;
        pages.push(page);
        logInputTransformations(
          (page as { input_transformations?: unknown }).input_transformations,
          model,
        );
        if (
          page.stop_reason !== "pause_turn" ||
          continuation >= MAX_PAUSE_TURN_CONTINUATIONS
        ) {
          break;
        }
        payload.messages = [
          ...(payload.messages as unknown[]),
          { role: "assistant", content: page.content },
        ];
      }

      const message = pages[pages.length - 1];
      const usage: TokenUsage = buildUsage(pages[0].usage);
      for (const page of pages.slice(1)) mergeUsage(usage, buildUsage(page.usage));
      const stopDetails =
        "stop_details" in message && message.stop_details
          ? { ...(message.stop_details as unknown as Record<string, unknown>) }
          : undefined;

      // A refusal is read before content: whatever partial output came
      // with it is incomplete and never returned as the answer.
      if (message.stop_reason === "refusal") {
        return {
          text: "",
          usage,
          refusal: {
            category: (stopDetails?.category as string | null) ?? null,
            explanation: (stopDetails?.explanation as string | null) ?? null,
            recommendedModel:
              (stopDetails?.recommended_model as string | null) ?? null,
          },
          stopReason: message.stop_reason,
          ...(stopDetails && { stopDetails }),
          ...(message.model && message.model !== model && { servedModel: message.model }),
          ...(rateLimits && { rateLimits }),
        };
      }

      const {
        text,
        thinking,
        thinkingSignature,
        citations,
        toolCalls,
        thinkingBlocks,
        fallbackTo,
      } = extractResponseContent(
        pages.flatMap((page) => page.content) as AnthropicBlock[],
      );
      const result: AnthropicGenerateResult = {
        text: isJsonObjectFormat(options.responseFormat) && !options.responseSchema
          ? extractJsonObjectText(text)
          : text,
        usage,
      };
      if (thinking) result.thinking = thinking;
      if (thinkingSignature) result.thinkingSignature = thinkingSignature;
      if (thinkingBlocks.length > 0) result.thinkingBlocks = thinkingBlocks;
      if (citations.length > 0) result.citations = citations;
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      if (rateLimits) result.rateLimits = rateLimits;
      const servedModel =
        message.model && message.model !== model ? message.model : fallbackTo;
      if (servedModel && servedModel !== model) result.servedModel = servedModel;
      // Forward structured stop details for observability (SDK 0.82+)
      if (message.stop_reason) result.stopReason = message.stop_reason;
      if (stopDetails) result.stopDetails = stopDetails;
      return result;
    } catch (error: unknown) {
      // A rejected file_id (deleted server-side, beta unavailable) —
      // invalidate the stale cache entries and retry once fully inline.
      if (AnthropicFileCacheService.isFileSourceError(error, fileSources)) {
        logger.warn(
          `[anthropic] Files API reference rejected (${getErrorMessage(error)}) — retrying with inline media`,
        );
        await AnthropicFileCacheService.revertFileSources(fileSources);
        return anthropicProvider.generateText(messages, model, {
          ...options,
          disableAnthropicFileSources: true,
        });
      }
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error as Error,
      );
    }
  },
  async captionImage(
    images: string[],
    prompt: string = "Describe this image.",
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).anthropic,
    systemPrompt?: string,
  ) {
    logger.provider("Anthropic", `captionImage model=${model}`);
    try {
      const contentBlocks: AnthropicBlock[] = [];

      for (const imageUrlOrBase64 of images) {
        const match = imageUrlOrBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          let mediaType = match[1];
          let data = match[2];
          // Auto-detect media type from data prefix
          if (data.startsWith("/9j/")) mediaType = "image/jpeg";
          else if (data.startsWith("iVBOR")) mediaType = "image/png";
          else if (data.startsWith("R0lG")) mediaType = "image/gif";
          else if (data.startsWith("UklG")) mediaType = "image/webp";

          // Enforce Anthropic's 5 MB per-image limit
          const compressed = await compressImageForSizeLimit(data, mediaType);
          data = compressed.data;
          mediaType = compressed.mediaType;

          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data,
            },
          });
        } else if (imageUrlOrBase64.startsWith("http")) {
          // URL-based image
          contentBlocks.push({
            type: "image",
            source: {
              type: "url",
              url: imageUrlOrBase64,
            },
          });
        }
      }

      contentBlocks.push({ type: "text", text: prompt });

      const payload: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: contentBlocks }],
        max_tokens: 1000,
      };
      if (systemPrompt) {
        payload.system = systemPrompt;
      }

      const response = (await getClient().messages.create(
        payload as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as Anthropic.Messages.Message;

      const { text } = extractResponseContent(
        response.content as AnthropicBlock[],
      );
      return {
        text,
        usage: buildUsage(response.usage),
      };
    } catch (error: unknown) {
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error as Error,
      );
    }
  },

  async *generateTextStream(
    messages: ChatMessage[],
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).anthropic,
    options: ProviderOptions = {},
  ): AsyncGenerator<TransformedStreamEvent> {
    logger.provider("Anthropic", `generateTextStream model=${model}`);
    // The tool_use block currently streaming its input. With eager input
    // streaming the SDK materializes the input at content_block_stop and
    // throws from the iterator when it cannot parse it — the catch below
    // turns that into the malformed-arguments path instead of a failed turn.
    let openToolUse: { id: string | null; name: string | null; rawInput: string } | null =
      null;
    let fileSources: FileSourceApplication = {
      applied: false,
      substitutions: [],
      fileIds: [],
    };
    let receivedAnyStreamChunk = false;
    // A model that rejected server-side context editing this process is not
    // asked again (the loop then relies on compaction alone).
    if (
      options.contextEditing &&
      isProviderDiagnosticsRejected(CONTEXT_EDITING_FEATURE_KEY, model)
    ) {
      options = { ...options, contextEditing: undefined };
    }
    const cacheTelemetry = options.cacheTelemetry;
    const requestsCacheDiagnostics =
      !!cacheTelemetry && !isProviderDiagnosticsRejected("anthropic", model);
    try {
      const prepared = await prepareMessages(messages, model, {
        toolLoadingMode: options.toolLoadingMode,
      });
      const { payload: streamPayload, betas } = buildAnthropicRequest(
        prepared,
        model,
        options,
        { streaming: true },
      );
      // Resuming a `pause_turn`: the paused assistant content goes back
      // as-is, with no extra user turn, and the API continues it.
      const pausedTurn = options.anthropicPausedTurn;
      if (Array.isArray(pausedTurn) && pausedTurn.length > 0) {
        streamPayload.messages = [
          ...(streamPayload.messages as unknown[]),
          { role: "assistant", content: pausedTurn },
        ];
      }
      const toolSchemas = new Map(
        (options.tools ?? []).map((tool) => [tool.name, tool.parameters]),
      );

      await enforceImageSizeLimits(
        streamPayload.messages as ChatMessage[],
        getMaxImageDimensionForModel(model),
      );

      // Upload-once media: swap large inline base64 image/PDF blocks for
      // Files API file_id references (first-party API only). Falls back to
      // inline base64 on any Files API failure.
      if (!options.disableAnthropicFileSources) {
        fileSources = await AnthropicFileCacheService.applyFileSources(
          streamPayload.messages as Array<{ content?: unknown }>,
        );
      }

      applyCacheBreakpoints(streamPayload);

      // Prompt-cache telemetry: hash exactly what is sent, and opt into
      // Anthropic's own miss diagnosis against the previous message
      // (`null` on a conversation's first request opts in for the next).
      const prefixHashes = cacheTelemetry
        ? hashAnthropicPrefix(streamPayload)
        : null;
      if (requestsCacheDiagnostics) {
        streamPayload.diagnostics = {
          previous_message_id: cacheTelemetry?.previousResponseId ?? null,
        };
      }
      const stream = getClient().messages.stream(
        streamPayload as unknown as Anthropic.MessageCreateParamsNonStreaming,
        anthropicRequestOptions(
          [
            ...(fileSources.applied ? [ANTHROPIC_FILES_API_BETA] : []),
            ...betas,
            ...(requestsCacheDiagnostics ? [ANTHROPIC_CACHE_DIAGNOSIS_BETA] : []),
          ],
          options.signal,
        ),
      );
      let anthropicMessageId: string | undefined;
      let diagnosticsEnvelope: unknown;
      // With the thinking-binding beta every response carries this array
      // (empty = no replayed thinking block was dropped).
      let inputTransformations: unknown[] | null = null;

      // Track current content block type for server tool response processing
      let currentBlockType: string | null = null;
      let currentBlockName: string | null = null;
      let currentToolUseId: string | null = null;
      let codeInput = "";
      let usage: TokenUsage | null = null;
      let messageStartUsage: {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      } | null = null;
      let rateLimits: ReturnType<typeof extractAnthropicRateLimits> | null =
        null;
      // Thinking blocks are accumulated verbatim (text + signature) and
      // emitted whole at content_block_stop. `sawContent`: a text / tool
      // block already streamed, so a later thinking block is a progress
      // update placed in front of the next tool call.
      let currentThinkingBlock: AnthropicThinkingBlock | null = null;
      let currentThinkingAfterContent = false;
      let sawContent = false;
      let finalStopReason: string | null = null;
      let usageIterations: unknown[] | null = null;
      // Without `message_stop` the body ended mid-reply: the SDK accepts
      // that, and the reply would end looking finished.
      let sawMessageStop = false;

      for await (const chunk of stream) {
        receivedAnyStreamChunk = true;
        if (options.signal?.aborted) {
          stream.abort();
          break;
        }
        if (chunk.type === "message_stop") sawMessageStop = true;
        if (chunk.type === "message_start") {
          anthropicMessageId = chunk.message?.id || anthropicMessageId;
          diagnosticsEnvelope = preferDiagnostics(
            diagnosticsEnvelope,
            (chunk.message as { diagnostics?: unknown } | undefined)
              ?.diagnostics,
          );
        }
        // Capture input token counts from message_start (sent once at stream start).
        // Anthropic sends input_tokens, cache_read_input_tokens, and
        // cache_creation_input_tokens here — message_delta only has output_tokens.
        if (chunk.type === "message_start" && chunk.message?.usage) {
          messageStartUsage = chunk.message.usage;
          // Sticky routing / a pre-output fallback: the stream opens on the
          // fallback model already.
          if (chunk.message.model && chunk.message.model !== model) {
            yield { type: "servedModel", model: chunk.message.model };
          }
          const startTransformations = (
            chunk.message as { input_transformations?: unknown }
          ).input_transformations;
          logInputTransformations(startTransformations, model);
          if (Array.isArray(startTransformations)) {
            inputTransformations = startTransformations;
          }
          const startIterations = (
            chunk.message.usage as { iterations?: unknown[] }
          ).iterations;
          if (Array.isArray(startIterations)) usageIterations = startIterations;
          // Capture rate-limit headers from the stream's initial response
          if (!rateLimits && stream.response) {
            rateLimits = extractAnthropicRateLimits(stream.response, model);
          }
          continue;
        }
        // Content block start — track what kind of block we're in
        if (chunk.type === "content_block_start") {
          const block = chunk.content_block;
          currentBlockType = block?.type || null;
          currentBlockName = ("name" in block ? block.name : null) as
            | string
            | null;
          currentToolUseId = ("id" in block ? block.id : null) as string | null;
          codeInput = "";

          const blockType = block?.type as string | undefined;
          if (blockType === "thinking") {
            const opened = block as { thinking?: string; signature?: string };
            currentThinkingBlock = {
              type: "thinking",
              thinking: opened.thinking ?? "",
              signature: opened.signature ?? "",
            };
            currentThinkingAfterContent = sawContent;
          } else if (blockType === "redacted_thinking") {
            currentThinkingBlock = {
              type: "redacted_thinking",
              data: (block as { data?: string }).data ?? "",
            };
            currentThinkingAfterContent = sawContent;
          } else if (blockType === "fallback") {
            // A server-side fallback took over. Streamed content stays valid;
            // the declining model's thinking and tool calls are not replayed.
            const handoff = block as unknown as {
              from?: { model?: string };
              to?: { model?: string };
            };
            yield {
              type: "fallback",
              from: handoff.from?.model ?? null,
              to: handoff.to?.model ?? null,
            };
            if (handoff.to?.model) {
              yield { type: "servedModel", model: handoff.to.model };
            }
            sawContent = false;
            continue;
          } else {
            sawContent = true;
          }
          if (blockType === "tool_use") {
            openToolUse = {
              id: currentToolUseId,
              name: currentBlockName,
              rawInput: "",
            };
          }

          // Server tool use start — yield the tool name being invoked
          if (
            block?.type === "server_tool_use" &&
            "name" in block &&
            block.name === "code_execution"
          ) {
            // Code execution starting — we'll accumulate the input
          }

          // Custom tool_use start — emit early disclosure before argument streaming
          if (
            block?.type === "tool_use" &&
            currentBlockName &&
            currentToolUseId
          ) {
            yield {
              type: "toolCallStart",
              id: currentToolUseId,
              name: currentBlockName,
            };
          }

          // Code execution tool result — legacy (code_execution_tool_result)
          // and current bash variant (code_execution_20260120 emits
          // bash_code_execution_tool_result) share the stdout/stderr shape.
          if (
            block?.type === "code_execution_tool_result" ||
            block?.type === "bash_code_execution_tool_result"
          ) {
            const result = (
              block as {
                content?: {
                  stdout?: string;
                  stderr?: string;
                  return_code?: number;
                };
              }
            ).content;
            if (result) {
              yield {
                type: "codeExecutionResult",
                output: result.stdout || result.stderr || "",
                outcome: result.return_code === 0 ? "OK" : "ERROR",
              };
            }
          }

          // Web search / web fetch tool result — extract citations.
          // Search success content is a list of web_search_result blocks;
          // fetch success content is a single web_fetch_result object
          // (error content is an object with error_code — skipped by the
          // type filter either way).
          if (
            block?.type === "web_search_tool_result" ||
            block?.type === "web_fetch_tool_result"
          ) {
            const content = (
              block as { content?: AnthropicBlock[] | AnthropicBlock }
            ).content;
            const blocks = Array.isArray(content)
              ? content
              : content
                ? [content]
                : [];
            const results = blocks
              .filter(
                (r: AnthropicBlock) =>
                  r.type === "web_search_result" ||
                  r.type === "web_fetch_result",
              )
              .map((r: AnthropicBlock) => ({
                url: r.url,
                title: r.title,
                pageAge: r.page_age,
              }));
            if (results.length > 0) {
              yield { type: "webSearchResult", results };
            }
          }

          continue;
        }

        // Content block stop
        if (chunk.type === "content_block_stop") {
          // A thinking block cut off before its signature (max_tokens mid-
          // thought) cannot be replayed — the API rejects it unsigned.
          if (
            currentThinkingBlock &&
            (currentThinkingBlock.type === "redacted_thinking" ||
              currentThinkingBlock.signature)
          ) {
            yield {
              type: "thinking_block",
              block: currentThinkingBlock,
              afterContent: currentThinkingAfterContent,
            };
          }
          currentThinkingBlock = null;
          // Server code execution — yield code. Legacy tool sends
          // name "code_execution" with {code}; code_execution_20260120
          // sends the "bash_code_execution" sub-tool with {command}.
          if (
            currentBlockType === "server_tool_use" &&
            (currentBlockName === "code_execution" ||
              currentBlockName === "bash_code_execution") &&
            codeInput
          ) {
            try {
              const parsed = JSON.parse(codeInput);
              const code = parsed.code || parsed.command;
              if (code) {
                yield {
                  type: "executableCode",
                  code,
                  language: parsed.language || "bash",
                };
              }
            } catch {
              // Not valid JSON, skip
            }
          }
          // Custom tool_use block ended — emit toolCall
          if (currentBlockType === "tool_use") {
            let args: Record<string, unknown> = {};
            let argsParseError = false;
            if (codeInput) {
              try {
                args = JSON.parse(codeInput);
              } catch {
                // Malformed/truncated tool-call JSON (common at output-token
                // exhaustion). Flag it instead of silently executing with {}
                // — the harness converts this into a synthetic error result
                // telling the model its own JSON was broken.
                argsParseError = true;
              }
            }
            // Eager input streaming skips the API's validation: input that
            // parses but breaks the tool's schema takes the same path.
            const violation = argsParseError
              ? null
              : findToolInputViolation(
                  args,
                  toolSchemas.get(currentBlockName ?? "") as
                    | Record<string, unknown>
                    | undefined,
                );
            if (violation) {
              logger.warn(
                `[anthropic] ${currentBlockName} input fails its schema (${violation}) — returning it to the model`,
              );
              argsParseError = true;
            }
            openToolUse = null;
            yield {
              type: "toolCall",
              id: currentToolUseId,
              name: currentBlockName,
              args,
              ...(argsParseError && {
                argsParseError: true,
                rawArgs: codeInput.slice(0, 2000),
              }),
            };
          }
          currentBlockType = null;
          currentBlockName = null;
          currentToolUseId = null;
          codeInput = "";
          continue;
        }

        // Content block deltas
        if (chunk.type === "content_block_delta") {
          // Thinking delta
          if (chunk.delta.type === "thinking_delta") {
            if (currentThinkingBlock?.type === "thinking") {
              currentThinkingBlock.thinking += chunk.delta.thinking;
            }
            yield { type: "thinking", content: chunk.delta.thinking };
            continue;
          }
          // Signature delta — Anthropic sends the thinking block's cryptographic
          // signature as a separate delta event. This MUST be captured and passed
          // back verbatim in multi-turn conversations, otherwise the API rejects
          // the request with a 400.
          if (chunk.delta.type === "signature_delta") {
            if (currentThinkingBlock?.type === "thinking") {
              currentThinkingBlock.signature = chunk.delta.signature;
            }
            yield {
              type: "thinking_signature",
              signature: chunk.delta.signature,
            };
            continue;
          }
          // Text delta
          if (chunk.delta.type === "text_delta") {
            yield chunk.delta.text;
            continue;
          }
          // Input JSON delta for server tool use or custom tool_use (accumulate)
          if (
            chunk.delta.type === "input_json_delta" &&
            (currentBlockType === "server_tool_use" ||
              currentBlockType === "tool_use")
          ) {
            const partial = chunk.delta.partial_json || "";
            codeInput += partial;
            if (openToolUse) openToolUse.rawInput += partial;
            // Yield progress event for tool_use blocks so generation
            // throughput tracking stays alive during FC argument streaming.
            if (currentBlockType === "tool_use" && partial.length > 0) {
              yield { type: "toolCallDelta", characters: partial.length };
            }
            continue;
          }
        }

        // Message delta (final usage + stop details) — carries output_tokens only
        if (chunk.type === "message_delta") {
          diagnosticsEnvelope = preferDiagnostics(
            diagnosticsEnvelope,
            (chunk as { diagnostics?: unknown }).diagnostics,
          );
          if (chunk.usage) {
            usage = {
              inputTokens: messageStartUsage?.input_tokens ?? 0,
              outputTokens: chunk.usage.output_tokens ?? 0,
              cacheReadInputTokens:
                messageStartUsage?.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens:
                messageStartUsage?.cache_creation_input_tokens ?? 0,
            };
          }
          // Forward structured stop details for observability (SDK 0.82+)
          if (chunk.delta?.stop_reason) {
            finalStopReason = chunk.delta.stop_reason;
            yield { type: "stopReason", stopReason: chunk.delta.stop_reason };
          }
          const deltaIterations = (
            chunk.usage as { iterations?: unknown[] } | undefined
          )?.iterations;
          if (Array.isArray(deltaIterations)) usageIterations = deltaIterations;
          const deltaTransformations = (
            chunk as { input_transformations?: unknown }
          ).input_transformations;
          logInputTransformations(deltaTransformations, model);
          if (Array.isArray(deltaTransformations)) {
            inputTransformations = deltaTransformations;
          }
          // Read before anything treats the output as an answer: a refusal
          // (before or during output) is not an empty response to retry.
          if (chunk.delta?.stop_reason === "refusal") {
            const details = (chunk.delta as { stop_details?: Record<string, unknown> | null })
              .stop_details;
            yield {
              type: "refusal",
              category: (details?.category as string | null) ?? null,
              explanation: (details?.explanation as string | null) ?? null,
              recommendedModel: (details?.recommended_model as string | null) ?? null,
            };
          }
          if (chunk.delta && "stop_details" in chunk.delta) {
            yield {
              type: "stopDetails",
              stopDetails: chunk.delta.stop_details,
            };
          }
        }
      }

      if (!sawMessageStop && !options.signal?.aborted) {
        throw streamEndedEarlyError("anthropic", "no message_stop");
      }

      // Get full usage from the finalized message
      try {
        const finalMessage = await stream.finalMessage();
        if (finalMessage?.usage) {
          usage = buildUsage(finalMessage.usage);
        }
        diagnosticsEnvelope = preferDiagnostics(
          diagnosticsEnvelope,
          (finalMessage as { diagnostics?: unknown } | undefined)?.diagnostics,
        );
      } catch {
        // finalMessage() can throw for tool_use stop reasons — use message_delta usage
      }
      // Server-side fallback: bill each attempt at its own model's rates.
      if (usageIterations && usage) {
        usage = buildUsage({
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          iterations: usageIterations as never,
        });
      }
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: EMPTY_USAGE };
      }
      // Before any pause_turn continuation: the pass keeps the LAST request's
      // telemetry, and the continuation is the request sent last.
      if (cacheTelemetry) {
        yield requestTelemetryChunk(prefixHashes, {
          providerResponseId: anthropicMessageId,
          cacheDiagnostics: requestsCacheDiagnostics
            ? normalizeAnthropicCacheDiagnostics(
                diagnosticsEnvelope,
                cacheTelemetry.previousResponseId ?? null,
              )
            : null,
          inputTransformations,
        });
      }
      const pauseContinuations = options.anthropicPauseContinuations ?? 0;
      if (
        finalStopReason === "pause_turn" &&
        pauseContinuations < MAX_PAUSE_TURN_CONTINUATIONS
      ) {
        const pausedMessage = await stream.finalMessage().catch(() => null);
        if (pausedMessage) {
          yield* anthropicProvider.generateTextStream(messages, model, {
            ...options,
            anthropicPausedTurn: [
              ...(options.anthropicPausedTurn ?? []),
              ...(pausedMessage.content as unknown[]),
            ],
            anthropicPauseContinuations: pauseContinuations + 1,
            ...(cacheTelemetry && {
              cacheTelemetry: { previousResponseId: anthropicMessageId ?? null },
            }),
          });
        }
      }
      if (rateLimits) {
        yield { type: "rateLimits", rateLimits };
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return;
      // The SDK could not parse a streamed tool input (eager input
      // streaming): hand the raw text back to the model as a malformed call.
      // API errors (they carry an HTTP status) are never mistaken for it,
      // and neither is a connection that dropped or a body that ended
      // mid-input: those are transport failures, and the pass fails.
      if (
        openToolUse &&
        typeof (error as AnthropicSdkError | null)?.status !== "number" &&
        !isTransientProviderError(error)
      ) {
        logger.warn(
          `[anthropic] ${openToolUse.name} input could not be parsed (${getErrorMessage(error)}) — returning it to the model`,
        );
        yield {
          type: "toolCall",
          id: openToolUse.id,
          name: openToolUse.name,
          args: {},
          argsParseError: true,
          rawArgs: openToolUse.rawInput.slice(0, 2000),
        };
        yield { type: "usage", usage: EMPTY_USAGE };
        return;
      }
      // A rejected file_id (deleted server-side, beta unavailable) surfaces
      // at request validation — before any chunk. Invalidate the stale cache
      // entries and retry once fully inline. Zero-chunk guard ensures the
      // retry never replays text or re-executes tool calls.
      if (
        !receivedAnyStreamChunk &&
        AnthropicFileCacheService.isFileSourceError(error, fileSources)
      ) {
        logger.warn(
          `[anthropic] Files API reference rejected (${getErrorMessage(error)}) — retrying stream with inline media`,
        );
        await AnthropicFileCacheService.revertFileSources(fileSources);
        yield* anthropicProvider.generateTextStream(messages, model, {
          ...options,
          disableAnthropicFileSources: true,
        });
        return;
      }
      // Server-side context editing is an optimization: a request rejected
      // for it is sent again without it (nothing reached the consumer yet).
      if (
        !receivedAnyStreamChunk &&
        options.contextEditing &&
        isDiagnosticsRejection(error, /context_management|context-management|clear_tool_uses/i)
      ) {
        logger.warn(
          `[anthropic] context editing rejected for ${model} (${getErrorMessage(error)}) — retrying without`,
        );
        markProviderDiagnosticsRejected(CONTEXT_EDITING_FEATURE_KEY, model);
        yield* anthropicProvider.generateTextStream(messages, model, {
          ...options,
          contextEditing: undefined,
        });
        return;
      }
      // Telemetry must never cost a turn: a request rejected for the
      // diagnostics beta is sent again without it (nothing reached the
      // consumer yet), and this model is not asked again this process.
      if (
        !receivedAnyStreamChunk &&
        requestsCacheDiagnostics &&
        isDiagnosticsRejection(error, /diagnostics|cache-diagnosis/i)
      ) {
        logger.warn(
          `[anthropic] cache diagnostics rejected for ${model} (${getErrorMessage(error)}) — retrying without`,
        );
        markProviderDiagnosticsRejected("anthropic", model);
        yield* anthropicProvider.generateTextStream(messages, model, options);
        return;
      }
      // No provider-level retry: transient stream failures are retried by the
      // shared streamWithRetries wrapper at the call site (zero-chunk only,
      // so a retry never replays text or re-executes tool calls).
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "anthropic",
        getErrorMessage(error),
        (error as AnthropicSdkError)?.status || 500,
        error as Error,
      );
    }
  },
};

export default anthropicProvider;

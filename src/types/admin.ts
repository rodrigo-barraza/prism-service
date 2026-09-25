/**
 * Admin Type Definitions
 *
 * Shared interfaces for AdminRoutes analytics, stats, and request log queries.
 */

import type { Document } from "mongodb";

// ── Config Route Response Types ─────────────────────────────

export interface AgentConfigResponse {
  id: string;
  name: string;
  description: string;
  custom: boolean;
  icon: string;
  avatar: string;
  color: string;
  backgroundImage: string;
  project: string;
  toolCount: number;
  enabledToolNames: string[];
  enabledByDefaultToolNames: string[];
  coreToolsLocked: boolean;
  canSpawnSubAgents: boolean;
  usesDirectoryTree: boolean;
  usesCodingGuidelines: boolean;
}

export interface ToolSchemaResponse {
  name: string;
  domain?: string;
  domainKey?: string;
  system?: boolean;
}

// ── Query Parameters ────────────────────────────────────────

export interface DateRangeFilter {
  from?: string;
  to?: string;
}

export interface AdminQueryParams extends DateRangeFilter {
  project?: string;
  username?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  operation?: string;
  success?: string;
  page?: string | number;
  limit?: string | number;
  sort?: string;
  order?: "asc" | "desc";
  tool?: string;
}

// ── Request Log Entry ───────────────────────────────────────

export interface RequestLogEntry {
  requestId: string;
  timestamp: string;
  endpoint: string | null;
  operation: string | null;
  project: string;
  username: string;
  clientIp: string | null;
  agent: string | null;
  harness?: string | null;
  provider: string;
  model: string;
  conversationId: string | null;
  traceId: string | null;
  agentConversationId: string | null;
  parentAgentConversationId?: string;
  toolsUsed: boolean;
  toolDisplayNames: string[];
  toolApiNames: string[];
  success: boolean;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCost: number | null;
  tokensPerSec: number | null;
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  topK: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  stopSequences: string[] | null;
  messageCount: number;
  inputCharacters: number;
  outputCharacters: number;
  timeToGeneration: number | null;
  generationTime: number | null;
  totalTime: number | null;
  requestPayload: Record<string, unknown> | null;
  responsePayload: Record<string, unknown> | null;
  modalities: ModalityFlags | null;
  rateLimits: Record<string, unknown> | null;
}

export interface ModalityFlags {
  textIn?: boolean;
  textOut?: boolean;
  imageIn?: boolean;
  imageOut?: boolean;
  audioIn?: boolean;
  audioOut?: boolean;
  videoIn?: boolean;
  pdfIn?: boolean;
}

// ── Stats Aggregation ───────────────────────────────────────

export interface StatsOverview {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgLatency: number;
  avgTokensPerSec: number;
  totalDuration: number;
  successCount: number;
  errorCount: number;
  traceCount: number;
  conversationCount: number;
  totalToolCalls: number;
  agentCount: number;
  workspaceCount: number;
}

export interface ProjectStats {
  project: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  avgLatency: number;
  avgTokensPerSec: number;
  lastRequest: string;
  modelCount: number;
  providerCount: number;
  models: string[];
  providers: string[];
  workflowCount: number;
  conversationCount: number;
  traceCount: number;
}

export interface ModelStats {
  model: string;
  provider: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  avgLatency: number;
  avgTokensPerSec: number;
  toolsUsed: boolean;
  conversationCount: number;
  workflowCount: number;
  traceCount: number;
}

// ── MongoDB Match Helpers ───────────────────────────────────

export type MongoTimestampFilter = {
  $gte?: string;
  $lte?: string;
};

export type MongoMatch = Record<string, unknown>;
export type MongoPipeline = Document[];
export type CountMap = Record<string, number>;

// ── Request Logger Types ────────────────────────────────────

export interface LogChatGenerationParams {
  requestId: string;
  endpoint?: string;
  operation?: string | null;
  project: string;
  username: string;
  clientIp?: string | null;
  agent?: string | null;
  harness?: string | null;
  provider: string;
  model: string;
  conversationId?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  success?: boolean;
  errorMessage?: string | null;
  usage?: TokenUsage | null;
  estimatedCost?: number | null;
  tokensPerSec?: number | null;
  timeToGenerationSec?: number | null;
  generationSec?: number | null;
  totalSec?: number | null;
  options?: GenerationOptions;
  messages?: ChatMessage[];
  text?: string | null;
  thinking?: string | null;
  images?: string[];
  toolCalls?: ToolCallEntry[];
  outputCharacters?: number;
  audioRef?: string | null;
  agenticIteration?: number | null;
  rateLimits?: Record<string, unknown> | null;
}

export interface LogBackgroundLlmCallParams {
  requestId: string;
  endpoint?: string | null;
  operation: string;
  project: string | null;
  username?: string;
  agent?: string | null;
  harness?: string | null;
  provider: string;
  model: string;
  traceId?: string | null;
  agentConversationId?: string | null;
  aiMessages: ChatMessage[];
  resultText: string;
  usage?: TokenUsage | null;
  success: boolean;
  errorMessage: string | null;
  requestStartMilliseconds: number;
  extraRequestPayload?: Record<string, unknown>;
  extraResponsePayload?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * The part of cacheCreationInputTokens written at a 1-hour TTL (Kimi K3
   * with MOONSHOT_CACHE_TTL=1h), billed at the model's 1-hour write rate.
   */
  cacheCreation1hInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  /**
   * Authoritative pre-summed prompt tokens (new + cache_read + cache_write).
   * Attached by CostCalculator.withTotalInputTokens at emission/persistence
   * so the client never re-derives billing token composition.
   */
  totalInputTokens?: number;
  /** Provider-reported tokens/sec (llama.cpp, lm-studio). */
  tokensPerSec?: number;
  /**
   * Billed tokens broken down by the model that produced them — set when
   * more than one model ran (Anthropic server-side fallback: the declining
   * model's partial output and the fallback model's answer bill at their
   * own rates). The top-level counts are the sum; calculateTextCost prices
   * each entry with that model's catalog pricing.
   */
  byModel?: Record<string, ModelTokenUsage>;
  /**
   * The part of these counts from requests whose prompt passed the model's
   * long-context threshold (OpenAI: 272K tokens bills the whole request at
   * its `…Over272kPerMillion` rates). Marked per request, where the prompt
   * size is known (CostCalculator.markLongContext); summed like the rest.
   */
  longContext?: ModelTokenUsage;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * An Anthropic thinking block exactly as the API returned it. Replayed
 * byte-for-byte on the next request (a modified block is a tampered
 * signature — always a 400). The two optional keys are Prism's placement
 * of a block that followed other content in its response, stripped before
 * replay: `beforeToolCallId` (a progress update introducing that tool call)
 * or `trailing` (nothing followed it).
 */
export type AnthropicThinkingBlock = (
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
) & { beforeToolCallId?: string; trailing?: boolean };

export interface GenerationOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  tools?: ToolEntry[];
  [key: string]: unknown;
}

export interface ToolEntry {
  name?: string;
  function?: { name: string };
  [key: string]: unknown;
}

/**
 * OpenAI Responses API reasoning output item, replayed verbatim on the next
 * request. `encrypted_content` is the opaque reasoning state the API returns
 * when `include: ["reasoning.encrypted_content"]` is requested (or `store`
 * is false); without it the model re-reasons from the summary alone.
 */
/**
 * Gemini: one part of a model turn, kept in the order the model produced it
 * so a replay returns every thought signature where it was received
 * (providers/google.ts convertModelParts). `functionCall` indexes the
 * message's toolCalls.
 */
export interface GeminiReplayPart {
  text?: string;
  thought?: boolean;
  functionCall?: number;
  /** A server-side (built-in) tool call or its result, verbatim (Google Search). */
  toolCall?: unknown;
  toolResponse?: unknown;
  thoughtSignature?: string;
}

/** Web sources a grounded answer cited (Gemini Google Search grounding). */
export interface MessageCitations {
  sources: Array<{ url: string; title: string }>;
  queries: string[];
  /** Answer segments and the indices of the sources that support them. */
  supports: Array<{ text: string; sources: number[] }>;
}

export interface ResponsesReasoningItem {
  id: string;
  summary: Array<{ type: string; text: string }>;
  encrypted_content?: string;
}

/**
 * Responses API assistant-message phase (gpt-5.3-codex and later). OpenAI
 * asks that it be preserved and resent on every assistant message.
 */
export type ResponsesPhase = "commentary" | "final_answer" | null;

export interface ToolCallEntry {
  id?: string | null;
  name: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  responsesItemId?: string;
  thoughtSignature?: string;
  /** OpenAI Responses API reasoning output item paired with this function call. */
  reasoningItem?: ResponsesReasoningItem;
  durationMilliseconds?: number;
}

export interface ChatMessage {
  role: string;
  content?: string | null;
  name?: string;
  images?: string[];
  audio?: string | string[];
  video?: string[];
  pdf?: string[];
  /** Non-inlined document attachments — URLs/data URIs resolved by MediaResolutionService. */
  documents?: string[];
  toolCalls?: ToolCallEntry[];
  thinking?: string;
  thinkingSignature?: string;
  /** Anthropic: every thinking block of the turn, verbatim and in order. */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** OpenAI Responses API message phase — resent on replay. */
  phase?: ResponsesPhase;
  /** OpenAI Responses API reasoning items NOT paired with a tool call (text-only turns). */
  reasoningItems?: ResponsesReasoningItem[];
  /** OpenAI Responses API `response.id` that produced this message. */
  providerResponseId?: string;
  /** OpenAI Responses API reasoning effort in effect when this message was produced — where a configuration_update goes on replay. */
  responsesEffort?: string;
  /** Gemini: the turn's parts in order, with their thought signatures (replayed verbatim). */
  geminiParts?: GeminiReplayPart[];
  /** Sources a grounded answer cited — rendered under the answer. */
  citations?: MessageCitations;
  deleted?: boolean;
  /** Soft rewind-pruned flag — excluded from model context, kept for the UI. */
  pruned?: boolean;
  tool_call_id?: string;
  /**
   * Stable server-minted id (conversation/messageIds.ts) — what rewind,
   * fork and a compaction boundary address.
   */
  id?: string;
  /** Marks the synthetic compaction summary — context for the model, never persisted. */
  isCompactSummary?: boolean;
  /** On a compaction summary: the id of the last message it covers. */
  compactionThroughMessageId?: string;
  /** Mid-conversation tool activation (system messages only; never persisted). */
  toolActivation?: import("./ProviderTypes.ts").ToolActivation;
  /** A one-turn system nudge (rendered `clear_at` where supported). */
  turnScoped?: boolean;
  /** Context injected before this turn's user message (never persisted). */
  turnContext?: boolean;
  [key: string]: unknown;
}

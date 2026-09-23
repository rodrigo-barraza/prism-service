import type { Provider } from "./provider.ts";
import type {
  AnthropicThinkingBlock,
  ResponsesPhase,
  ResponsesReasoningItem,
} from "./admin.ts";

export interface ProviderInstanceConfig {
  url: string;
  concurrency?: number;
  nickname?: string;
  /** Bearer token for a server started with an API key (SGLang --api-key). */
  apiKey?: string;
  /** vLLM started with --scheduling-policy priority: requests may carry a priority. */
  priorityScheduling?: boolean;
}

export interface InstanceEntry {
  id: string;
  type: string;
  baseUrl: string;
  concurrency: number;
  instanceNumber: number;
  nickname?: string;
  provider: Provider;
}

// Basic interfaces for chat structures
export interface ChatMessageContent {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: string;
  content?: string | ChatMessageContent[];
  name?: string;
  images?: string[];
  audio?: string[];
  video?: string[];
  pdf?: string[];
  /** Non-inlined document attachments (CSV/DOCX/XLSX…) — URLs or data URIs for reader tools. */
  documents?: string[];
  toolCalls?: Array<{
    id?: string | null;
    name: string;
    args?: Record<string, unknown> | unknown;
    responsesItemId?: string;
    thoughtSignature?: string;
    reasoningItem?: ResponsesReasoningItem;
  }>;
  thinking?: string;
  thinkingSignature?: string;
  /** Anthropic: every thinking block of the turn, verbatim and in order. */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** OpenAI Responses API message phase — resent on replay. */
  phase?: ResponsesPhase;
  /** OpenAI Responses API reasoning items not paired with a tool call. */
  reasoningItems?: ResponsesReasoningItem[];
  /** OpenAI Responses API `response.id` that produced this message. */
  providerResponseId?: string;
  /** OpenAI Responses API reasoning effort in effect when this message was produced — where a configuration_update goes on replay. */
  responsesEffort?: string;
  /** Gemini: the turn's parts in order, with their thought signatures (replayed verbatim). */
  geminiParts?: import("#src/types/admin").GeminiReplayPart[];
  /** A native async call's completion (OpenAI): replayed as that call's output. */
  asyncCallId?: string;
  /** Tool result correlation — maps this message to the tool_use that produced it. */
  tool_call_id?: string;
  /** Generic message ID — fallback for tool correlation. */
  id?: string;
}

export interface ProviderResponseUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  text?: string;
  thinking?: string;
  images?: Array<{ data: string; mimeType: string }>;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  provider?: string;
  model?: string;
  usage?: ProviderResponseUsage;
  estimatedCost?: number;
}

export interface ProviderOptions {
  maxTokens?: number;
  temperature?: number;
  deliveryMode?: "STABLE" | "BALANCED" | "CREATIVE";
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  serviceTier?: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: string;
  thinkingBudget?: number | string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  signal?: AbortSignal;
  /**
   * Stable per-conversation key for provider prompt caching. OpenAI uses it
   * as `prompt_cache_key` to route requests to the cache shard holding the
   * conversation's prefix; providers without an equivalent ignore it.
   */
  promptCacheKey?: string;
  /**
   * Prompt-cache telemetry (agent loop). When set, the adapter hashes the
   * payload it sends and yields one `requestTelemetry` chunk at the end of
   * the stream. `previousResponseId` — the previous request's provider
   * response id in the same conversation — is what OpenAI
   * (`prompt_cache_options.comparison_response_id`) and Anthropic
   * (`diagnostics.previous_message_id`) diagnose a cache miss against.
   */
  cacheTelemetry?: { previousResponseId?: string | null };
  webSearch?: boolean | string;
  webFetch?: boolean;
  codeExecution?: boolean;
  urlContext?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
  reasoningSummary?: boolean | string;
  verbosity?: string;
  seed?: number | string;
  responseFormat?: string | { type: string };
  responseSchema?: Record<string, unknown>;
  /** Internal: skip Anthropic Files API substitution (fallback retry path). */
  disableAnthropicFileSources?: boolean;
  /** Internal: assistant content of a `pause_turn` being resumed (Anthropic). */
  anthropicPausedTurn?: unknown[];
  /** Internal: how many `pause_turn` resumes this stream has made (Anthropic). */
  anthropicPauseContinuations?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
  parallelToolCalls?: boolean;
  candidateCount?: number;
  responseMimeType?: string;
  store?: boolean;
  mediaResolution?: string;
  topLogprobs?: number;
  responseLogprobs?: boolean;
  logprobs?: number;
  model?: string;
  format?: string;
  instructions?: string;
  language?: string;
  prompt?: string | number;
  // Context length
  minContextLength?: number;
  evalBatchSize?: number;
  contextLength?: number;
  _loadedContextLength?: number;
  _loadedEvalBatchSize?: number;
  _loadedPhysicalBatchSize?: number;
  // Embedding
  dimensions?: number;
  // Extended sampling
  minP?: number;
  // LM Studio load config
  context_length?: number;
  flash_attention?: boolean;
  offload_kv_cache_to_gpu?: boolean;
  eval_batch_size?: number;
  parallel?: number;
  unified_kv_cache?: boolean;
  // Image generation
  forceImageGeneration?: boolean;
  imageCount?: number;
  /** Gemini imageConfig.aspectRatio, e.g. "1:1", "16:9", "9:16", "21:9" */
  aspectRatio?: string;
  /** Gemini imageConfig.imageSize: "512" | "1K" | "2K" | "4K" */
  imageSize?: string;
  // System prompt
  systemPrompt?: string;
  // OpenAI Responses API
  responsesAPI?: boolean;
  /**
   * OpenAI Responses API `previous_response_id` — stateful continuation from
   * a stored response. No caller sets it yet; the hook exists so the harness
   * can chain turns server-side instead of replaying the transcript.
   */
  previousResponseId?: string;
  /**
   * The running turn's loop key (TurnInputMailbox), set by a harness that
   * can take input natively applied mid-stream. OpenAI streams GPT-6 turns
   * that carry it over the Responses WebSocket and steers them with
   * `response.steer`.
   */
  turnInputKey?: string;
  // Provider routing
  agent?: string;
  username?: string;
  project?: string;
  // ElevenLabs-specific
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  // Google embedding task type
  taskType?: string;
}

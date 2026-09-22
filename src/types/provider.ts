import type { AnthropicThinkingBlock } from "./admin.ts";
import type { ToolSchema } from "#src/services/harnesses/types";
import type { ChatMessage, ProviderOptions } from "./ProviderTypes.ts";
import type { ResponsesPhase, ResponsesReasoningItem } from "./admin.ts";
import type { RequestTelemetryChunk } from "#src/utils/PromptPrefixHashes";

export type { ChatMessage, ProviderOptions };

// ── Google GenAI Config ─────────────────────────────────────

export interface GoogleGenerateConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  maxOutputTokens?: number;
  seed?: number;
  responseMimeType?: string;
  thinkingConfig?: {
    includeThoughts: boolean;
    thinkingLevel?: string;
    thinkingBudgetTokens?: number;
  };
  tools?: Record<string, unknown>[];
  responseModalities?: string[];
  systemInstruction?: string;
}

// ── LM Studio Config ────────────────────────────────────────

export interface LmStudioLoadConfig {
  model: string;
  echo_load_config?: boolean;
  context_length?: number;
  flash_attention?: boolean;
  offload_kv_cache_to_gpu?: boolean;
  eval_batch_size?: number;
  parallel?: number;
  unified_kv_cache?: boolean;
}

export interface LmStudioModelMeta {
  repeatPenalty?: number;
  minContextLength?: number;
  _loadedContextLength?: number;
  _loadedEvalBatchSize?: number;
  _loadedPhysicalBatchSize?: number;
  contextLength?: number;
  context_length?: number;
  signal?: AbortSignal;
  thinkingEnabled?: boolean;
  tools?: ToolSchema[];
}

export interface LmStudioResponsesBody {
  model: string;
  input: unknown;
  stream: boolean;
  store: boolean;
  temperature?: number;
  max_output_tokens?: number;
  repeat_penalty?: number;
  tools?: ToolSchema[];
}

// ── Streaming Chunk Types ───────────────────────────────────

export interface StreamTextChunk {
  type?: undefined;
}

export interface StreamThinkingChunk {
  type: "thinking";
  content: string;
}

export interface StreamToolCallChunk {
  type: "toolCall";
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status?: "calling" | "done" | "error";
  native?: boolean;
  thoughtSignature?: string;
  responsesItemId?: string;
  reasoningItem?: ResponsesReasoningItem;
  /** The arguments were not valid JSON; the harness asks for a re-emit. */
  argsParseError?: boolean;
  /** The unparseable arguments, truncated, for that re-emit message. */
  rawArgs?: string;
}

/**
 * Provider-native conversation state that is not text, thinking or a tool
 * call but must be stored on the assistant message and replayed next turn.
 * Emitted by the OpenAI Responses path; every field is optional and the
 * consumer merges each chunk into its accumulator.
 */
export interface StreamProviderStateChunk {
  type: "providerState";
  providerResponseId?: string;
  phase?: ResponsesPhase;
  reasoningItems?: ResponsesReasoningItem[];
}

export interface StreamUsageChunk {
  type: "usage";
  usage: { inputTokens: number; outputTokens: number; tokensPerSec?: number };
  safetyBlock?: boolean;
}

export interface StreamImageChunk {
  type: "image";
  data: string;
  mimeType: string;
}

export interface StreamExecutableCodeChunk {
  type: "executableCode";
  code: string;
  language: string;
}

export interface StreamCodeExecutionResultChunk {
  type: "codeExecutionResult";
  output: string;
  outcome: string;
}

export interface StreamToolCallStartChunk {
  type: "toolCallStart";
  id: string;
  name: string;
}

export interface StreamToolCallDeltaChunk {
  type: "toolCallDelta";
  characters: number;
}

export interface StreamStopReasonChunk {
  type: "stopReason";
  stopReason: string;
}

export interface StreamStatusChunk {
  type: "status";
  message: string;
  phase?: string;
  progress?: number;
}

export type StreamChunk =
  | string
  | StreamThinkingChunk
  | StreamToolCallChunk
  | StreamUsageChunk
  | StreamImageChunk
  | StreamExecutableCodeChunk
  | StreamCodeExecutionResultChunk
  | StreamToolCallStartChunk
  | StreamToolCallDeltaChunk
  | StreamStopReasonChunk
  | StreamStatusChunk
  | StreamProviderStateChunk
  | RequestTelemetryChunk;

// ── Provider Result Types ───────────────────────────────────

export interface GenerateTextResult {
  text: string;
  thinking?: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    thoughtSignature?: string;
    responsesItemId?: string;
    reasoningItem?: ResponsesReasoningItem;
    durationMilliseconds?: number;
  }>;
  images?: Array<{ data: string; mimeType: string }>;
  safetyBlock?: boolean;
  rateLimits?: Record<string, unknown> | null;
  /** OpenAI Responses API message phase of the final message item. */
  phase?: ResponsesPhase;
  /** OpenAI Responses API reasoning items not paired with a tool call. */
  reasoningItems?: ResponsesReasoningItem[];
  /** OpenAI Responses API `response.id`. */
  providerResponseId?: string;
  /** Anthropic thinking blocks, verbatim and in order. */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** Anthropic safety-classifier refusal — `text` is then empty. */
  refusal?: { category: string | null; explanation: string | null };
  /** The model that served the response when a fallback did. */
  servedModel?: string;
}

export interface GenerateImageResult {
  imageData: string;
  mimeType: string;
  text: string;
}

export interface EmbeddingResult {
  embedding: number[];
  dimensions: number;
}

/** Content types accepted by `generateEmbedding`. Providers narrow as needed. */
export type EmbeddingContent = string | string[] | EmbeddingMultimodalPart[];

export interface EmbeddingMultimodalPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

export interface EnsureModelLoadedResult {
  alreadyLoaded: boolean;
  contextLength: number | null;
}

export interface CaptionResult {
  text: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface TranscriptionResult {
  text: string;
  usage: Record<string, number>;
}

export interface SpeechResult {
  stream: ReadableStream | import("stream").Readable | null;
  contentType: string;
}

export interface HealthCheckResult {
  ok: boolean;
  status: string;
  slotsIdle?: number | null;
  slotsProcessing?: number | null;
  error?: string;
}

export interface LmStudioModelEntry {
  key: string;
  display_name?: string;
  type: string;
  loaded_instances?: Array<LmStudioLoadedInstance>;
  archParams?: Record<string, unknown>;
  architecture?: string;
  params_string?: string;
  size_bytes?: number;
  quantization?: { bits_per_weight?: number };
  max_context_length?: number;
  id?: string;
  capabilities?: { vision?: boolean };
}

export interface LmStudioLoadedInstance {
  id: string;
  config?: LmStudioInstanceConfig;
}

export interface LmStudioInstanceConfig {
  context_length?: number;
  eval_batch_size?: number;
  physical_batch_size?: number;
}

export interface ListModelsResult {
  models: LmStudioModelEntry[];
  data?: LmStudioModelEntry[];
}

// ── Rate Limits ─────────────────────────────────────────────

export interface StreamRateLimitsChunk {
  type: "rateLimits";
  rateLimits: Record<string, unknown>;
}

// ── Provider Interface ──────────────────────────────────────

export interface Provider {
  name: string;
  generateText(
    messages: ChatMessage[],
    model?: string,
    options?: ProviderOptions,
  ): Promise<GenerateTextResult>;
  generateTextStream(
    messages: ChatMessage[],
    model?: string,
    options?: ProviderOptions,
  ): AsyncGenerator<StreamChunk, void, unknown>;
  generateTextStreamLive?(
    messages: ChatMessage[],
    model?: string,
    options?: ProviderOptions,
  ): AsyncGenerator<StreamChunk, void, unknown>;
  generateImage?(
    prompt: string,
    images?: Array<string | { imageData: string; mimeType?: string }>,
    model?: string,
    systemPrompt?: string,
  ): Promise<GenerateImageResult>;
  captionImage?(
    images: string[],
    prompt?: string,
    model?: string,
    systemPrompt?: string,
  ): Promise<CaptionResult>;
  generateEmbedding?(
    content: EmbeddingContent,
    model: string,
    options?: ProviderOptions,
  ): Promise<EmbeddingResult>;
  listModels?(): Promise<ListModelsResult>;
  checkHealth?(): Promise<HealthCheckResult>;
  generateSpeech?(
    text: string,
    voice?: string,
    options?: ProviderOptions,
  ): Promise<SpeechResult>;
  generateSpeechStream?(
    textStream: AsyncIterable<string>,
    voice?: string,
    options?: ProviderOptions,
  ): AsyncGenerator<Buffer | Uint8Array, void, unknown>;
  transcribeAudio?(
    audioBuffer: Buffer,
    mimeType: string,
    model?: string,
    options?: ProviderOptions,
  ): Promise<TranscriptionResult>;
  unloadModelByKey?(modelKey: string): Promise<void>;
  ensureModelLoaded?(
    modelKey: string,
    options?: ProviderOptions,
    signal?: AbortSignal,
    onStatus?: (status: string) => void,
  ): Promise<EnsureModelLoadedResult>;
  unloadModel?(modelId: string): Promise<void>;
  /**
   * Pre-discover the model's context window before the harness runs
   * output token clamping. Self-hosted providers (vLLM, llama-cpp,
   * Ollama) implement this to query their model info endpoint and
   * populate `options._loadedContextLength`. Cloud providers with
   * static model definitions don't need this.
   *
   * Called by the harness in `createProviderStream` so the budget
   * tracker has the context window available on the very first
   * iteration (fixing the cold-start race where discovery happened
   * inside the async generator, after clamping had already run).
   */
  discoverContextWindow?(
    model: string,
    options: ProviderOptions,
  ): Promise<void>;
}

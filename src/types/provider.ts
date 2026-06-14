/**
 * Provider Type Definitions
 *
 * Shared interfaces for AI provider options, generation config,
 * and streaming chunk types. Consumed by all provider implementations
 * (google.ts, openai.ts, anthropic.ts, lm-studio.ts, etc.)
 */

import type { ToolSchema } from "../services/harnesses/types.ts";
import type { ChatMessage, ProviderOptions } from "./ProviderTypes.ts";

export type { ChatMessage, ProviderOptions };

// ── Provider Generation Options ─────────────────────────────

/**
 * Unified options object passed to all provider generateText / generateTextStream methods.
 * Each provider picks the fields it supports and ignores the rest.
 */

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
  [key: string]: unknown;
}

// ── LM Studio Config ────────────────────────────────────────

export interface LmStudioLoadConfig {
  model: string;
  echo_load_config?: boolean;
  context_length?: number;
  flash_attention?: boolean;
  offload_kv_cache_to_gpu?: boolean;
  eval_batch_size?: number;
  [key: string]: unknown;
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
  [key: string]: unknown;
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
  [key: string]: unknown;
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
}

export interface StreamUsageChunk {
  type: "usage";
  usage: { inputTokens: number; outputTokens: number };
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
  | StreamStatusChunk;

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
  }>;
  images?: Array<{ data: string; mimeType: string }>;
  safetyBlock?: boolean;
}

export interface Provider {
  name: string;
  generateText(
    messages: ChatMessage[],
    model?: string,
    options?: ProviderOptions
  ): Promise<GenerateTextResult>;
  generateTextStream(
    messages: ChatMessage[],
    model?: string,
    options?: ProviderOptions
  ): AsyncGenerator<StreamChunk, void, unknown>;
  captionImage?(
    images: string[],
    prompt?: string,
    model?: string,
    systemPrompt?: string
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
  generateEmbedding?(
    content: string | string[],
    model: string,
    options?: ProviderOptions
  ): Promise<{ embedding: number[]; dimensions: number }>;
  listModels?(): Promise<{
    models?: Array<{
      key: string;
      display_name?: string;
      type: string;
      loaded_instances?: Array<{ id: string; [key: string]: unknown }>;
      [key: string]: unknown;
    }>;
    data?: Array<{
      key: string;
      display_name?: string;
      type: string;
      loaded_instances?: Array<{ id: string; [key: string]: unknown }>;
      [key: string]: unknown;
    }>;
  }>;
  checkHealth?(): Promise<{
    ok: boolean;
    status: string;
    slotsIdle?: number | null;
    slotsProcessing?: number | null;
    error?: string;
  }>;
}

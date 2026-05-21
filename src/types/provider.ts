/**
 * Provider Type Definitions
 *
 * Shared interfaces for AI provider options, generation config,
 * and streaming chunk types. Consumed by all provider implementations
 * (google.ts, openai.ts, anthropic.ts, lm-studio.ts, etc.)
 */

import type { ToolSchema } from "../services/harnesses/types.ts";

// ── Provider Generation Options ─────────────────────────────

/**
 * Unified options object passed to all provider generateText / generateTextStream methods.
 * Each provider picks the fields it supports and ignores the rest.
 */
export interface ProviderOptions {
  // ── Sampling Parameters ──────────────────────────────────
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repeatPenalty?: number;
  stopSequences?: string[];
  maxTokens?: number;
  seed?: number | string;

  // ── Response Format ──────────────────────────────────────
  responseFormat?: string;

  // ── Thinking / Reasoning ─────────────────────────────────
  thinkingEnabled?: boolean;
  thinkingLevel?: string;
  thinkingBudget?: number | string;
  reasoningEffort?: string;

  // ── Tool Calling ─────────────────────────────────────────
  tools?: ToolSchema[];

  // ── Web Search / Code Execution ──────────────────────────
  webSearch?: boolean | string;
  codeExecution?: boolean;
  urlContext?: boolean;

  // ── Image Generation ─────────────────────────────────────
  forceImageGeneration?: boolean;
  imageCount?: number;

  // ── System Prompt (for providers that support injection) ─
  systemPrompt?: string;

  // ── Abort Signal ─────────────────────────────────────────
  signal?: AbortSignal;

  // ── Context Length ───────────────────────────────────────
  minContextLength?: number;
  contextLength?: number;
  _loadedContextLength?: number;

  // ── OpenAI Responses API ─────────────────────────────────
  responsesAPI?: boolean;
  reasoningSummary?: string;
  serviceTier?: string;
  verbosity?: string;
  responseSchema?: Record<string, unknown>;

  // ── Audio / TTS ──────────────────────────────────────────
  model?: string;
  prompt?: string | number;
  format?: string;
  instructions?: string;
  language?: string;

  // ── Embedding ────────────────────────────────────────────
  dimensions?: number;

  // ── Extended Sampling ────────────────────────────────────
  minP?: number;

  // ── LM Studio Load Config ───────────────────────────────
  context_length?: number;
  flash_attention?: boolean;
  offload_kv_cache_to_gpu?: boolean;
  eval_batch_size?: number;

  // ── Provider Routing / Metadata ─────────────────────────
  agent?: string;
  username?: string;
  project?: string;
  _retryAttempt?: number;

  // ── Extensible ───────────────────────────────────────────
  [key: string]: unknown;
}

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
  id: string;
  name: string;
  args: Record<string, unknown>;
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

export type StreamChunk =
  | string
  | StreamThinkingChunk
  | StreamToolCallChunk
  | StreamUsageChunk
  | StreamImageChunk
  | StreamExecutableCodeChunk
  | StreamCodeExecutionResultChunk;

// ── Provider Result Types ───────────────────────────────────

export interface GenerateTextResult {
  text: string;
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

/**
 * Harness Type Definitions
 *
 * Shared interfaces for the agentic harness system. Consumed by
 * BaseAgenticHarness, all harness subclasses, lifecycle modules,
 * AgenticLoopState, and the AgenticLoopService façade.
 */

// ── Usage & Cost ────────────────────────────────────────────

import type { TokenUsage } from "../RequestLogger.ts";

export interface UsageAccumulator extends TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  /** Set during finalization to track total LLM round-trips. */
  requests?: number;
  /** Provider-reported tok/s (when available). */
  tokensPerSec?: number;
  promptTokens?: number;
}

// ── Tool Schemas & Calls ────────────────────────────────────

export interface ToolSchema {
  name: string;
  description: string;
  _isCustom?: boolean;
  parameters?: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  responsesItemId?: string;
  thoughtSignature?: string;
  /** Populated by AutoApprovalEngine during beforeToolCall hook. */
  _approval?: { tier: string; tierLabel: string };
  result?: unknown;
  status?: string;
}

export interface ToolResult {
  name: string;
  id: string | null;
  result: unknown;
}

export interface ResolvedTools {
  finalTools: ToolSchema[];
  customToolMap: Map<string, Record<string, unknown>>;
  resolvedEnabledTools: string[] | null;
}

// ── Display Segments ────────────────────────────────────────

export type DisplaySegment =
  | { type: "text"; fragmentIndex: number }
  | { type: "thinking"; fragmentIndex: number }
  | { type: "tools"; toolIds: string[] };

// ── Conversation Messages ───────────────────────────────────

export interface ConversationMessage {
  role: string;
  content?: string;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ToolCall[];
  images?: string[];
  audio?: string;
  timestamp?: string;
  model?: string;
  provider?: string;
  usage?: UsageAccumulator | null;
  totalTime?: number;
  tokensPerSec?: number | null;
  estimatedCost?: number | null;
  contentSegments?: DisplaySegment[];
  textFragments?: string[];
  thinkingFragments?: string[];
  generationSettings?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── SSE Emission ────────────────────────────────────────────

export type EmitFn = (event: { type: string; [key: string]: unknown }) => void;

// ── LLM Provider ────────────────────────────────────────────

export interface LLMProvider {
  generateTextStream(
    messages: unknown[],
    model: string,
    options: Record<string, unknown>,
  ): AsyncIterable<unknown>;
  generateTextStreamLive?(
    messages: unknown[],
    model: string,
    options: Record<string, unknown>,
  ): AsyncIterable<unknown>;
}

// ── Model Definition ────────────────────────────────────────

export interface ModelDef {
  maxInputTokens?: number;
  liveAPI?: boolean;
  pricing?: Record<string, number>;
  outputTypes?: string[];
  inputTypes?: string[];
  [key: string]: unknown;
}

// ── Agentic Options ─────────────────────────────────────────

export interface AgenticOptions {
  harness?: string;
  planFirst?: boolean;
  autoApprove?: boolean;
  maxIterations?: number;
  enabledTools?: string[];
  disabledBuiltIns?: string[];
  agenticLoopEnabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  webSearch?: boolean;
  agentContext?: unknown;
  maxWorkerIterations?: number;
  minContextLength?: number;
  tools?: ToolSchema[];
  [key: string]: unknown;
}

// ── Generation Context ──────────────────────────────────────

export interface AgenticContext {
  options: AgenticOptions;
  agent?: string | null;
  project: string;
  username: string;
  modelDef?: ModelDef | null;
  messages: ConversationMessage[];
  agentSessionId: string;
  parentAgentSessionId?: string | null;
  traceId?: string | null;
  provider: LLMProvider;
  providerName: string;
  resolvedModel: string;
  signal?: AbortSignal | null;
  emit: EmitFn;
  requestId?: string;
  requestStart?: number;
  clientIp?: string | null;
  workspaceRoot?: string | null;
  conversationId?: string | null;
  originalMessages?: ConversationMessage[] | null;
  userMessage?: ConversationMessage | null;
  conversationMeta?: Record<string, unknown> | null;
  /** Injected by harnesses before tool execution for tools that need conversation history. */
  _currentMessages?: ConversationMessage[];
  [key: string]: unknown;
}

// ── Per-Iteration Pass State ────────────────────────────────

export interface PassState {
  streamedText: string;
  finalStreamedText: string;
  streamedThinking: string;
  thinkingSignature: string;
  pendingToolCalls: ToolCall[];
  streamedImages: string[];
  start: number;
  firstTokenTime: number | null;
  generationEnd: number | null;
  outputCharacters: number;
  usage: UsageAccumulator;
  options: Record<string, unknown>;
  requestId: string | null;
}

// ── Stream Chunk Routing ────────────────────────────────────

export type ChunkAction =
  | { action: "continue" }
  | { action: "break" }
  | { action: "skip" }
  | { action: "toolCall"; tc: ToolCall };

// ── AgenticLoopState Constructor ────────────────────────────

export interface AgenticLoopStateInit {
  originalMessageCount?: number;
  planModeActive?: boolean;
}

/**
 * Harness Type Definitions
 *
 * Shared interfaces for the agentic harness system. Consumed by
 * BaseAgenticHarness, all harness subclasses, lifecycle modules,
 * AgenticLoopState, and the AgenticLoopService façade.
 */

import type { RepetitionVerdict } from "#src/utils/RepetitionDetector";

// ── Usage & Cost ────────────────────────────────────────────

import type { TokenUsage } from "#src/services/RequestLogger";

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
  /** OpenAI Responses API reasoning output item paired with this function call. */
  reasoningItem?: {
    id: string;
    summary: Array<{ type: string; text: string }>;
  };
  /** Populated by AutoApprovalEngine.checkBatch / the ApprovalGate. */
  _approval?: {
    tier: number | string;
    tierLabel: string;
    isApproved?: boolean;
    isDenied?: boolean;
    reason?: string;
  };
  result?: unknown;
  status?: string;
  durationMilliseconds?: number;
  /** Set when the provider could not parse the model's tool-call JSON (e.g. truncated at output-token exhaustion). */
  _argsParseError?: boolean;
  /** Raw (unparseable) argument text excerpt, for the synthetic error result. */
  _rawArgs?: string;
}

export interface ToolResult {
  name: string;
  id: string | null;
  result: unknown;
  durationMilliseconds?: number;
}

export interface ResolvedTools {
  finalTools: ToolSchema[];
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
  /** Duration of the thinking phase in seconds (wall-clock, per-iteration). */
  thinkingDurationSeconds?: number | null;
  /** Duration of the content generation phase in seconds (wall-clock, per-iteration). */
  contentDurationSeconds?: number | null;
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
  /** Internal marker — message already persisted to database, skip double persistence. */
  _alreadyPersisted?: boolean;
  /** Internal marker — planning injection message, stripped on plan exit and DB persistence. */
  _isPlanningInjection?: boolean;
  /** Notification origin — identifies system-generated messages for deterministic detection.
   *  Values: "orchestrator" | "timer" | "async-task". Absent on real user messages. */
  _notificationSource?: string;
  /** Idempotency key — prevents duplicate notification persistence during race conditions.
   *  Format: "<source>:<identifier>:<timestamp>". Used by deduplication guards. */
  _notificationId?: string;
  [key: string]: unknown;
}

// ── Validation Feedback ─────────────────────────────────────

export interface ValidationFeedback {
  toolName: string;
  filePath: string;
  validatorType: string;
  errors: string[];
  rawOutput: string;
}

// ── SSE Emission ────────────────────────────────────────────

export type EmitFunction = (event: {
  type: string;
  [key: string]: unknown;
}) => void;

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
  discoverContextWindow?(
    model: string,
    options: Record<string, unknown>,
  ): Promise<void>;
}

// ── Model Definition ────────────────────────────────────────

export interface ModelDefinition {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  liveAPI?: boolean;
  pricing?: Record<string, number>;
  outputTypes?: string[];
  inputTypes?: string[];
  [key: string]: unknown;
}

import type { PolicyRule } from "#src/services/PolicyEngine";

// ── Agentic Options ─────────────────────────────────────────

export interface AgenticOptions {
  harness?: string;
  planFirst?: boolean;
  autoApprove?: boolean;
  maxIterations?: number;
  disabledTools?: string[];
  agenticLoopEnabled?: boolean;
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  webSearch?: boolean;
  agentContext?: unknown;
  maxSubAgentIterations?: number;
  minContextLength?: number;
  tools?: ToolSchema[];
  /** Declarative tool call policies (allow/deny/askUser with argument predicates). */
  policies?: PolicyRule[];
  /** Enable CriticGate multi-model review of dangerous tool calls. */
  enableCriticGate?: boolean;
  /** Model to use for CriticGate reviews (resolved from settings). */
  criticModel?: string;
  /** Number of parallel branches for TreeOfThought harness (default: 3, max: 5). */
  branchCount?: number;
  /** Search strategy for TreeOfThought: "bfs" (parallel exploration, default) or "dfs" (depth-first with pruning). */
  searchStrategy?: string;
  /** Score threshold (0-10) for proactive backtracking in ToT. Branches scoring below this are pruned before tool execution. Default: 5.0. */
  valueThreshold?: number;
  /** Thought structure for the agentic loop: "chain_of_thought" (default single-pass) or "tree_of_thoughts" (parallel branching with scoring). */
  thoughtStructure?: string;
  /** Enable sandbox execution with git-based rollback for destructive tools. */
  enableSandbox?: boolean;
  /** Skip CriticGate review for this session. */
  skipCritic?: boolean;
  /** Skip sandbox for destructive tools. */
  skipSandbox?: boolean;
  /** Maximum cost in dollars before the loop terminates with an exhaustion recovery. */
  maxCostDollars?: number;
  /**
   * Shared cost accumulator spanning this loop and every sub-agent it spawns.
   * Created by AgenticLoopService when maxCostDollars is set; threaded through
   * the sub-agent tree so delegation cannot escape the budget.
   */
  _sharedCostBudget?: import("./lifecycle/CostBudgetEnforcer.ts").SharedCostBudget;
  /** Per-tool wall-clock timeout in milliseconds. 0 disables. Defaults to HARNESS.DEFAULT_TOOL_TIMEOUT_MILLISECONDS. */
  toolTimeoutMilliseconds?: number;
  /** Iteration interval at which abbreviated system prompt reminders are re-injected to counteract instruction fade-out. Default: 8. */
  reminderInterval?: number;
  /** Model for LLM-based system prompt distillation (instruction fade-out countermeasure). If empty, reminders are disabled. */
  reminderModel?: string;
  /** Provider for the reminder extraction model. */
  reminderProvider?: string;
  [key: string]: unknown;
}

// ── Generation Context ──────────────────────────────────────

export interface AgenticContext {
  options: AgenticOptions;
  agent?: string | null;
  project: string;
  username: string;
  modelDefinition?: ModelDefinition | null;
  messages: ConversationMessage[];
  agentConversationId: string;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
  traceId?: string | null;
  provider: LLMProvider;
  providerName: string;
  resolvedModel: string;
  signal?: AbortSignal | null;
  emit: EmitFunction;
  requestId?: string;
  requestStart?: number;
  clientIp?: string | null;
  workspaceRoot?: string | null;
  conversationId: string;
  originalMessages?: ConversationMessage[] | null;
  userMessage?: ConversationMessage | null;
  conversationMeta?: Record<string, unknown> | null;
  /** Injected by harnesses before tool execution for tools that need conversation history. */
  _currentMessages?: ConversationMessage[];
  /** When true, this conversation was just created (no prior messages in DB).
   *  Prevents marking incoming context messages as _alreadyPersisted when
   *  they are ephemeral platform history (e.g. Discord channel messages). */
  isNewConversation?: boolean;
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
  /** Timestamp (performance.now()) when the first thinking chunk arrived. */
  thinkingStartTime: number | null;
  /** Timestamp (performance.now()) when thinking ended (first non-thinking output). */
  thinkingEndTime: number | null;
  outputCharacters: number;
  usage: UsageAccumulator;
  options: AgenticOptions;
  requestId: string | null;
  // Promise resolving to the MongoDB _id of the pending request document inserted at iteration start.
  pendingRequestDocumentIdPromise: Promise<import("mongodb").ObjectId | null>;
  /** Provider stop reason — "length"/"max_tokens" when output was truncated by token budget. */
  stopReason?: string;
  /** Set by the streaming repetition detector when degenerate output is identified. */
  repetitionDetected?: boolean;
}

// ── Stream Chunk Routing ────────────────────────────────────

export type ChunkAction =
  | { action: "continue" }
  | { action: "break" }
  | { action: "skip" }
  | { action: "toolCall"; toolCall: ToolCall }
  | { action: "repetitionDetected"; verdict: RepetitionVerdict };

// ── AgenticLoopState Constructor ────────────────────────────

export interface AgenticLoopStateInit {
  originalMessageCount?: number;
  planModeActive?: boolean;
}

// ── Stream Chunk ────────────────────────────────────────────

/**
 * Loose union of all provider stream events. We branch on `type` at
 * runtime so a flat optional-field interface avoids verbose DU noise.
 */
export interface StreamChunk {
  type?: string;
  // Usage
  usage?: Record<string, number>;
  // Rate limits
  rateLimits?: Record<string, unknown>;
  // Thinking
  content?: string;
  signature?: string;
  // Tool call delta
  characters?: number;
  // Tool call
  id?: string;
  responsesItemId?: string;
  /** OpenAI Responses API reasoning output item paired with this tool call. */
  reasoningItem?: {
    id: string;
    summary: Array<{ type: string; text: string }>;
  };
  name?: string;
  args?: Record<string, unknown>;
  thoughtSignature?: string;
  native?: boolean;
  status?: string;
  result?: unknown;
  // Image
  data?: string;
  mimeType?: string;
  // Executable code
  code?: string;
  language?: string;
  // Code execution result
  output?: string;
  outcome?: string;
  // Web search result
  results?: unknown[];
  // Status
  message?: string;
  [key: string]: unknown;
}

/**
 * Context object passed to the beforePrompt lifecycle hook.
 * Carries all the data the hook pipeline needs to assemble the system prompt,
 * inject skills, and mutate the message array before the first LLM call.
 */
export interface BeforePromptHookContext {
  messages: ConversationMessage[];
  project: string;
  username: string;
  agent?: string | null;
  traceId?: string | null;
  conversationId: string;
  agentConversationId: string;
  agentContext?: unknown;
  enabledTools: string[] | null;
  resolvedToolNames: string[];
  workspaceRoot?: string;
  workspaceEnabled?: boolean;
  locale?: string;
  _injectedSkills?: string[];
  [key: string]: unknown;
}

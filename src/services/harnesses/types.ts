/**
 * Harness Type Definitions
 *
 * Shared interfaces for the agentic harness system. Consumed by
 * BaseAgenticHarness, all harness subclasses, lifecycle modules,
 * AgenticLoopState, and the AgenticLoopService façade.
 */

import type { DeviationVerdict } from "./lifecycle/DeviationRuleEngine.ts";
import type { Context } from "@opentelemetry/api";

// ── Usage & Cost ────────────────────────────────────────────

import type { TokenUsage } from "#src/services/RequestLogger";
import type { RequestTelemetryChunk } from "#src/utils/PromptPrefixHashes";
import type {
  AnthropicThinkingBlock,
  ResponsesPhase,
  ResponsesReasoningItem,
} from "#src/types/admin";

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
  reasoningItem?: ResponsesReasoningItem;
  /** A native async call (OpenAI async tools): its result is returned later on its id. */
  nativeAsync?: boolean;
  /** Populated by AutoApprovalEngine.checkBatch / the ApprovalGate. */
  _approval?: {
    tier: number | string;
    tierLabel: string;
    /** Which permission layer decided, and by which rule (permissions/types). */
    layer?: string;
    rule?: string;
    ruleId?: string;
    ruleScope?: string;
    isApproved?: boolean;
    isDenied?: boolean;
    reason?: string;
    /** Which layer denied: a rule, the classifier, a hook, or the user. */
    deniedBy?: "rule" | "classifier" | "hook" | "user";
    /** Set by the ApprovalGate for a call a human decided (or that timed out waiting). */
    decidedBy?: "user" | "superseded" | "turn_ended";
    /** The user's own reason for declining. */
    userReason?: string;
    /** The user edited the arguments on the approval card; `args` holds the edit. */
    editedByUser?: boolean;
    originalArgs?: Record<string, unknown>;
  };
  /**
   * The configured PreToolUse hooks' verdict, stamped BEFORE the approval
   * gate: `ask` forces a per-call approval request, `allow` skips the mode's
   * prompt (never a deny or ask rule).
   */
  _hookPermission?: {
    decision: "allow" | "ask";
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

/** A provider safety refusal (Anthropic `stop_reason: "refusal"`). */
export interface ModelRefusal {
  category: string | null;
  explanation: string | null;
  recommendedModel?: string | null;
  /** The model that declined. */
  model?: string;
}

export interface ConversationMessage {
  role: string;
  content?: string;
  thinking?: string;
  thinkingSignature?: string;
  /** Anthropic: every thinking block of the turn, verbatim and in order. */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** Set on the final assistant message of a turn a safety classifier declined. */
  refusal?: ModelRefusal;
  /** Duration of the thinking phase in seconds (wall-clock, per-iteration). */
  thinkingDurationSeconds?: number | null;
  /** Duration of the content generation phase in seconds (wall-clock, per-iteration). */
  contentDurationSeconds?: number | null;
  toolCalls?: ToolCall[];
  /** OpenAI Responses API message phase — resent on replay. */
  phase?: ResponsesPhase;
  /** OpenAI Responses API reasoning items not paired with a tool call. */
  reasoningItems?: ResponsesReasoningItem[];
  /** OpenAI Responses API `response.id` that produced this message. */
  providerResponseId?: string;
  /** OpenAI Responses API reasoning effort in effect when this message was produced — where a configuration_update goes on replay. */
  responsesEffort?: string;
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
  /**
   * Stable server-minted id (conversation/messageIds.ts) — what rewind,
   * fork and a compaction boundary address.
   */
  id?: string;
  /** Marks the synthetic compaction summary — context for the model, never persisted. */
  isCompactSummary?: boolean;
  /** On a compaction summary: the id of the last message it covers. */
  compactionThroughMessageId?: string;
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
  /** Skip CriticGate review for this session. */
  skipCritic?: boolean;
  /** Maximum cost in dollars before the loop terminates with an exhaustion recovery. */
  maxCostDollars?: number;
  /**
   * Shared cost accumulator spanning this loop and every sub-agent it spawns.
   * Created by AgenticLoopService when maxCostDollars is set; threaded through
   * the sub-agent tree so delegation cannot escape the budget.
   */
  _sharedCostBudget?: import("./lifecycle/CostBudgetEnforcer.ts").SharedCostBudget;
  /**
   * The run's stored permission rules. Loaded by AgenticLoopService for every
   * entry point; a sub-agent inherits its parent's (see `forSubAgent`).
   */
  _permissionRules?: import("#src/services/permissions/PermissionRuleSet").default;
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
  /** Profile partition for this request — stamped literally on persisted
   *  documents; absent means the default profile. */
  profileId?: string | null;
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
  /** This turn's `invoke_agent` span context (Tracing.traceAgentTurn) — the
   *  explicit parent of its `chat` and `execute_tool` spans. */
  _traceContext?: Context;
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
  /** Anthropic: this pass's thinking blocks, verbatim and in order. */
  thinkingBlocks?: AnthropicThinkingBlock[];
  /** Set when the provider declined the pass (Anthropic `stop_reason: "refusal"`). */
  refusal?: ModelRefusal;
  /** The model that actually served the pass, when a fallback did. */
  servedModel?: string;
  pendingToolCalls: ToolCall[];
  /** Tool calls the model emitted but that were dropped because the tool is
   *  not in the current native schema. Used to give the model explicit
   *  corrective feedback instead of a generic "provide output" nudge (a
   *  silent drop reads as a no-op to the model and causes retry loops). */
  droppedToolCallNames?: string[];
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
  /** Set when a mid-stream deviation rule fired and aborted this pass. */
  deviation?: DeviationVerdict;
  /** OpenAI Responses API message phase of this pass's final message item. */
  phase?: ResponsesPhase;
  /** OpenAI Responses API reasoning items this pass emitted without a tool call to pair with. */
  reasoningItems?: ResponsesReasoningItem[];
  /** OpenAI Responses API `response.id` of this pass. */
  providerResponseId?: string;
  /** OpenAI Responses API reasoning effort this pass ran at (configuration_update models). */
  responsesEffort?: string;
  /** Mid-turn input the provider applied natively during this pass (OpenAI response.steer). */
  nativeTurnInput?: ConversationMessage[];
  /** Prompt-cache telemetry the adapter reported for this pass's request. */
  requestTelemetry?: RequestTelemetryChunk;
}

// ── Deviation Abort/Retry Snapshot ──────────────────────────

/**
 * Positions of every stream-accumulated AgenticLoopState field, captured
 * before a provider pass so a deviation-aborted pass can be rolled back
 * without leaking partial content into the final transcript.
 */
export interface StreamStateSnapshot {
  streamedThinkingLength: number;
  finalStreamedText: string;
  streamedToolCallCount: number;
  streamedImageCount: number;
  streamedAudioChunkCount: number;
  displaySegmentCount: number;
  displayTextFragmentCount: number;
  displayThinkingFragmentCount: number;
  lastTextFragmentLength: number;
  lastThinkingFragmentLength: number;
  lastToolsSegmentToolIdCount: number;
  lastDisplaySegType: string | null;
  planModeTextLength: number;
  overallOutputCharacters: number;
}

// ── Stream Chunk Routing ────────────────────────────────────

export type ChunkAction =
  | { action: "continue" }
  | { action: "break" }
  | { action: "skip" }
  | { action: "toolCall"; toolCall: ToolCall }
  | { action: "deviation"; verdict: DeviationVerdict };

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
  reasoningItem?: ResponsesReasoningItem;
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
  // Provider-native state (type: "providerState")
  providerResponseId?: string;
  phase?: ResponsesPhase;
  reasoningItems?: ResponsesReasoningItem[];
  responsesEffort?: string;
  // Native steering applied (type: "turnInputApplied")
  inputIds?: string[];
  // A native async tool call (type: "toolCall")
  nativeAsync?: boolean;
  // Prompt-cache telemetry (type: "requestTelemetry")
  prefixHashes?: RequestTelemetryChunk["prefixHashes"];
  cacheDiagnostics?: RequestTelemetryChunk["cacheDiagnostics"];
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
  profileId?: string | null;
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
  /** Names of user-pinned rules to inject as an <active-rules> section */
  activeRuleNames?: string[];
  _injectedSkills?: string[];
  _skillsText?: string;
  _skillCatalogText?: string;
  [key: string]: unknown;
}

import type { ChatMessage } from "#src/types/admin";

export interface ConversationMeta {
  title?: string;
  /** Profile partition — stamped as a literal top-level field on the document. */
  profileId?: string | null;
  systemPrompt?: string;
  settings?: ConversationSettings;
  traceId?: string | null;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
  workspaceRoot?: string | null;
  synthetic?: boolean;
  agent?: string | null;
  contextBudget?: Record<string, unknown> | null;
  conversationOutcome?: string | null;
  /** Runtime-only: memory IDs injected this turn, written via $addToSet to the document's injectedMemoryIds array. Not stored as a top-level field. */
  _newInjectedMemoryIds?: string[];
}

export interface ConversationSettings {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ConversationPatchInput {
  title?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ConversationPatchFields {
  updatedAt: string;
  title?: string;
  messages?: ChatMessage[];
  messageCount?: number;
  modalities?: Record<string, boolean>;
  providers?: string[];
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCounts?: Record<string, number>;
  modelNames?: string[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ToolCallPayload {
  name: string;
  id?: string | null;
  args?: Record<string, unknown> | string;
  thoughtSignature?: string;
  durationMilliseconds?: number;
}

export interface MessagePayload {
  role: string;
  content?: string | unknown[] | null;
  rawContent?: string;
  images?: string[] | unknown[];
  audio?: string | unknown[];
  video?: string | unknown[];
  pdf?: string | unknown[];
  toolCalls?: ToolCallPayload[];
  thinking?: string;
  /** For role="tool" messages — links this result back to the assistant's tool call. */
  tool_call_id?: string | null;
  /** For role="tool" messages — the name of the tool that produced this result. */
  name?: string;
  /** Foreign key linking this message to the `requests` collection for telemetry data. */
  requestId?: string;
  isCompactSummary?: boolean;
  _isInjectedContext?: boolean;
  _isPlanningInjection?: boolean;
  _alreadyPersisted?: boolean;
  [key: string]: unknown;
}

export interface TransformedConversation {
  id: string;
  project: string;
  username: string;
  /** Profile partition; legacy documents have no field (default profile). */
  profileId?: string | null;
  title: string;
  messages: ChatMessage[];
  messageCount?: number;
  systemPrompt: string;
  settings: ConversationSettings;
  modalities: Record<string, boolean>;
  providers: string[];
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  toolCounts: Record<string, number>;
  modelNames: string[];
  isGenerating: boolean;
  isActive?: boolean;
  pendingBackgroundTasks?: number;
  synthetic?: boolean;
  traceId?: string | null;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
  workspaceRoot?: string | null;
  agent?: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown; // Allow extra MongoDB properties dynamically
}

export interface TransformedConversationStats {
  agentConversationId: string;
  requestCount: number;
  subAgentRequestCount: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalReasoningOutputTokens: number;
  providers: string[];
  models: string[];
  operations: string[];
  modalities: Record<string, boolean>;
  toolCounts: Record<string, number>;
  requestErrorCount: number;
  totalElapsedTime: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationServiceInterface {
  appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: Array<ChatMessage | MessagePayload>,
    conversationMeta?: ConversationMeta | null,
    options?: { collection?: string },
  ): Promise<TransformedConversation>;
  setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    options?: {
      collection?: string;
      agent?: string;
      title?: string;
      agentConversationId?: string;
      profileId?: string;
    },
  ): Promise<void>;
  getConversationStats(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<TransformedConversationStats | null>;
  /**
   * Overwrite the crash-safety shadow copy of the in-flight turn's messages.
   * Written once per agentic iteration; cleared atomically by the next
   * successful appendMessages. Recovered into `messages` on startup when a
   * crash/restart orphaned it.
   */
  saveTurnCheckpoint(
    conversationId: string,
    project: string,
    username: string,
    messages: Array<ChatMessage | MessagePayload>,
    options?: { collection?: string },
  ): Promise<void>;
  /**
   * Recover orphaned turn checkpoints: for every conversation that still has
   * a turnCheckpoint (meaning the process died before finalize could append
   * the turn), append the checkpointed messages for real. Returns the number
   * of conversations recovered.
   */
  recoverOrphanedTurnCheckpoints(options?: {
    collection?: string;
  }): Promise<number>;
  /**
   * Atomically increment or decrement the pendingBackgroundTasks counter.
   * Use +1 when dispatching an async tool, -1 when it completes.
   * MongoDB $inc ensures correctness under concurrent completions.
   */
  adjustPendingBackgroundTasks(
    conversationId: string,
    project: string,
    username: string,
    delta: number,
    options?: { collection?: string },
  ): Promise<void>;
}

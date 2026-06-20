/**
 * Memory Type Definitions
 *
 * Shared interfaces for the memory subsystem. Consumed by MemoryService,
 * MemoryConsolidationService, and MemoryExtractor.
 */

// ── Memory Documents ────────────────────────────────────────

export interface MemoryDocument {
  id: string;
  agent: string;
  project?: string | null;
  username?: string | null;
  type: string;
  title?: string | null;
  content: string;
  embedding?: number[] | null;
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
  // LUPOS-specific fields (guild-scoped personal facts)
  guildId?: string;
  channelId?: string;
  aboutUserId?: string;
  aboutUsername?: string;
  sourceUserId?: string;
  sourceUsername?: string;
  confidence?: number;
  sourceMessageId?: string | null;
  [key: string]: unknown;
}

export interface MemorySearchResult {
  id: unknown;
  type: string;
  title: string;
  content: string;
  aboutUserId?: string;
  aboutUsername?: string;
  confidence?: number;
  createdAt: string;
  age: string;
  ageDays: number;
  score: number;
}

export interface MemoryStoreParams {
  agent: string;
  project?: string | null;
  username?: string | null;
  type?: string;
  title?: string | null;
  content: string;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  endpoint?: string | null;
}

export interface MemorySearchParams {
  agent: string;
  project?: string | null;
  guildId?: string;
  userIds?: string[];
  queryText: string;
  limit?: number;
  traceId?: string | null;
  agentConversationId?: string | null;
  endpoint?: string | null;
}

export interface MemoryListParams {
  agent?: string;
  project?: string | null;
  guildId?: string;
  userId?: string;
  limit?: number;
  skip?: number;
}

// ── Consolidation Types ─────────────────────────────────────

export interface ConsolidationAction {
  type: "merge" | "delete";
  sourceIds?: string[];
  merged?: {
    type: string;
    title?: string;
    content: string;
  };
  id?: string;
  reason?: string;
}

export interface ConsolidationResult {
  actions: ConsolidationAction[];
  summary: string;
}

export interface ConsolidationParams {
  agent?: string;
  project: string;
  username?: string;
  trigger?: string;
  broadcast?: (event: Record<string, unknown>) => void;
  endpoint?: string | null;
  traceId?: string | null;
  agentConversationId?: string | null;
  guildId?: string;
}

export interface ConsolidationBatch {
  clusters: MemoryDocument[][];
  stale: MemoryDocument[];
  partitionMeta?: PartitionMeta;
}

export interface PartitionMeta {
  aboutUserId: string;
  aboutUsername: string;
  sourceUserId: string;
  sourceUsername: string;
}

export interface ConsolidationRunResult {
  skipped?: boolean;
  reason?: string;
  total: number;
  merged?: number;
  deleted?: number;
  errors?: number;
  batches?: number;
  durationMs?: number;
}

// ── Fact Extraction ─────────────────────────────────────────

export interface ExtractedFact {
  fact: string;
  aboutUserId: string;
  aboutUsername: string;
  sourceUserId?: string;
  sourceUsername?: string;
  category?: string;
  confidence?: number;
}

export interface ExtractionMeta {
  project?: string | null;
  username?: string;
  traceId?: string | null;
  agentConversationId?: string | null;
  endpoint?: string | null;
  agent?: string | null;
}

export interface ExtractionParticipant {
  id: string;
  username: string;
  displayName?: string;
}

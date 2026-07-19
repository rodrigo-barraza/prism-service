import logger from "#src/utils/logger";

// ─────────────────────────────────────────────────────────────
// ConversationStatusRegistry — in-memory live status tracker
// ─────────────────────────────────────────────────────────────
// Tracks the real-time generation status of every active
// conversation so the frontend can recover exact phase,
// iteration, throughput, and sub-agent state after a page
// refresh or conversation switch.
//
// Entries are written by harness emit callbacks (same data
// already sent via SSE) and cleaned up when generation ends.
// Read by GET /conversations/:id/live-status and enriched
// into GET /conversations/:id responses.
// ─────────────────────────────────────────────────────────────

export interface LiveSubAgentStatus {
  phase: string;
  label: string | null;
  conversationId: string | null;
  startedAt: string | null;
}

export interface LiveConversationStatus {
  phase: string;
  label: string | null;
  iteration: number;
  maxIterations: number;
  startedAt: string;
  phaseStartedAt: string;
  tokensPerSecond: number | null;
  activeRequests: number;
  outputTokens: number;
  inputTokens: number;
  totalTokens: number;
  /** Live server-estimated cost of the in-flight generation (USD). */
  estimatedCost?: number;
  subAgents: Record<string, LiveSubAgentStatus>;
}

const activeStatuses = new Map<string, LiveConversationStatus>();

const ConversationStatusRegistry = {
  /**
   * Set the full live status for a conversation (initial registration).
   * Overwrites any existing entry.
   */
  set(conversationId: string, status: LiveConversationStatus): void {
    activeStatuses.set(conversationId, status);
    logger.debug(
      `[ConversationStatusRegistry] Set status for ${conversationId} (phase=${status.phase}, active=${activeStatuses.size})`,
    );
  },

  /**
   * Merge a partial update into an existing status entry.
   * Creates a new entry with defaults if none exists.
   */
  patch(
    conversationId: string,
    partial: Partial<LiveConversationStatus>,
  ): void {
    const existing = activeStatuses.get(conversationId);
    if (existing) {
      // If the phase changed, update phaseStartedAt
      if (partial.phase && partial.phase !== existing.phase) {
        partial.phaseStartedAt =
          partial.phaseStartedAt || new Date().toISOString();
      }
      activeStatuses.set(conversationId, { ...existing, ...partial });
    } else {
      const now = new Date().toISOString();
      activeStatuses.set(conversationId, {
        phase: "generating",
        label: null,
        iteration: 0,
        maxIterations: 0,
        startedAt: now,
        phaseStartedAt: now,
        tokensPerSecond: null,
        activeRequests: 0,
        outputTokens: 0,
        inputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        subAgents: {},
        ...partial,
      });
    }
  },

  /**
   * Update a specific sub-agent's status within a parent conversation.
   */
  patchSubAgent(
    parentConversationId: string,
    subAgentId: string,
    subAgentStatus: Partial<LiveSubAgentStatus>,
  ): void {
    const existing = activeStatuses.get(parentConversationId);
    if (!existing) return;

    const currentSubAgent = existing.subAgents[subAgentId] || {
      phase: "starting",
      label: null,
      conversationId: null,
      startedAt: null,
    };

    existing.subAgents[subAgentId] = { ...currentSubAgent, ...subAgentStatus };
  },

  /**
   * Remove a sub-agent entry (e.g. on completion/failure).
   */
  removeSubAgent(parentConversationId: string, subAgentId: string): void {
    const existing = activeStatuses.get(parentConversationId);
    if (!existing) return;
    delete existing.subAgents[subAgentId];
  },

  /**
   * Retrieve the current live status for a conversation.
   * Returns null if the conversation is not actively generating.
   */
  get(conversationId: string): LiveConversationStatus | null {
    return activeStatuses.get(conversationId) || null;
  },

  /**
   * Remove a conversation's status entry (called on generation end).
   */
  remove(conversationId: string): void {
    const deleted = activeStatuses.delete(conversationId);
    if (deleted) {
      logger.debug(
        `[ConversationStatusRegistry] Removed status for ${conversationId} (active=${activeStatuses.size})`,
      );
    }
  },

  /** Current number of tracked conversations (for diagnostics). */
  get activeCount(): number {
    return activeStatuses.size;
  },
};

export default ConversationStatusRegistry;

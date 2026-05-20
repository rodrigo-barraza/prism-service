/**
 * Valid memory types — inspired by Claude Code's memdir taxonomy.
 *
 * Memories are constrained to these types. LUPOS additionally uses its own
 * category values (personal, preference, gaming, etc.) stored in the `type`
 * field — the schema is flexible per agent.
 */
export declare const CODING_MEMORY_TYPES: string[];
/**
 * MemoryService — unified, agent-scoped memory system.
 *
 * All memories live in a single `memories` collection. Every document carries
 * an `agent` field ("LUPOS", "CODING", etc.) and all queries filter by it,
 * ensuring complete isolation between agents.
 *
 * LUPOS memories: personal facts about Discord users (guild-scoped)
 * CODING memories: project knowledge from coding sessions (project-scoped)
 */
declare const MemoryService: {
    /**
     * Store a single memory with embedding generation and duplicate detection.
     *
  
     * @param {string} params.agent - Agent identifier ("LUPOS", "CODING", etc.)
  
  
     * @param {string} params.content - Full memory text
  
  
     * @returns {Promise<object|null>} Stored memory document, or null if duplicate
     */
    store({ agent, project, username, type, title, content, embedding, metadata, conversationId, traceId, agentSessionId, endpoint, }: any): Promise<any>;
    /**
     * Extract and store LUPOS memories from a Discord conversation chunk.
     *
  
     * @param {string} params.guildId
     * @param {string} params.channelId
     * @param {Array} params.messages - Recent conversation messages
     * @param {Array} params.participants - Array of { id, username, displayName }
  
     * @returns {Promise<Array>} The stored memory documents
     */
    extractAndStore({ guildId, channelId, messages, participants, sourceMessageId, traceId, project, endpoint, }: any): Promise<any[]>;
    /**
     * Search for relevant memories using cosine similarity.
     * Always scoped by `agent`.
     *
  
     * @param {string} params.agent - Agent identifier
  
  
     * @param {string} params.queryText - Text to search for
  
     * @returns {Promise<Array>} Relevant memories sorted by relevance
     */
    search({ agent, project, guildId, userIds, queryText, limit, traceId, agentSessionId, endpoint, }: any): Promise<{
        id: any;
        type: any;
        title: any;
        content: any;
        aboutUserId: any;
        aboutUsername: any;
        confidence: any;
        createdAt: any;
        age: string;
        ageDays: number;
        score: number;
    }[]>;
    /**
     * List memories for a specific agent, optionally filtered by project/guild/user.
     *
  
     * @param {string} params.agent - Agent identifier
  
  
     * @returns {Promise<{ memories: Array, total: number }>}
     */
    list({ agent, project, guildId, userId, limit, skip }: any): Promise<{
        memories: import("mongodb").WithId<import("bson").Document>[];
        total: number;
    }>;
    /**
     * Aggregate all distinct project/agent combinations with memory counts.
     * Bypasses project scoping — used by the consolidation CLI's --all sweep.
     *
     * @returns {Promise<Array<{ project: string, agent: string, count: number }>>}
     */
    discoverCombos(): Promise<import("bson").Document[]>;
    /**
     * Delete a specific memory by its id field.
     *
  
     * @returns {Promise<boolean>} Whether a document was deleted
     */
    delete(memoryId: any): Promise<boolean>;
    /**
     * Alias for delete — used by callers that preferred the AgentMemoryService naming.
     */
    remove(memoryId: any): Promise<boolean>;
    /**
     * Update an existing memory.
     *
  
  
     */
    update(memoryId: any, { title, content, type }: any): Promise<boolean>;
    /**
     * Format memories for injection into the system prompt.
     * Adds type badges and staleness caveats.
     *
  
     * @returns {string} Formatted text block
     */
    formatForPrompt(memories: any): any;
    /**
     * Ensure indexes exist on the unified memories collection.
     */
    ensureIndexes(): Promise<void>;
};
export default MemoryService;
//# sourceMappingURL=MemoryService.d.ts.map
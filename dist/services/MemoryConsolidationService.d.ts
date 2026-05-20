declare const MemoryConsolidationService: {
    /**
     * Run memory consolidation for a specific agent within a project.
     * Processes memories in batches to avoid context window overflow.
     *
  
     * @param {string} params.agent - Agent identifier
     * @param {string} params.project - Project identifier
  
  
     * @returns {Promise<object>} Consolidation results
     */
    consolidate({ agent, project, username, trigger, broadcast, endpoint, traceId, agentSessionId, guildId, }: Record<string, unknown>): Promise<{
        actionsApplied: unknown;
        batchCount: unknown;
        summary: string;
        total: number;
        trigger: unknown;
        durationMs: number;
        merged: number;
        deleted: number;
        errors: number;
    } | {
        skipped: boolean;
        reason: string;
        total: number;
        actions?: undefined;
        summary?: undefined;
    } | {
        actions: number;
        summary: string;
        total: number;
        skipped?: undefined;
        reason?: undefined;
    }>;
    /**
     * Check if consolidation should run and trigger if needed.
     * Called by MemoryExtractor after storing new memories.
     *
  
     * @param {string} params.project - Project identifier
  
  
     */
    checkAndRun({ project, username, broadcast, endpoint, agent, traceId, agentSessionId, }: Record<string, unknown>): Promise<void>;
    /**
     * Get consolidation run history for a project.
     *
  
  
     * @returns {Promise<Array>} Consolidation history entries, newest first
     */
    getHistory(project: Record<string, unknown>, limit?: Record<string, unknown>): Promise<import("bson").Document[]>;
};
export default MemoryConsolidationService;
//# sourceMappingURL=MemoryConsolidationService.d.ts.map
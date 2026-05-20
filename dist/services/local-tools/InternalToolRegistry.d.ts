export default class InternalToolRegistry {
    /**
     * Check if a tool name is handled by the internal registry.
  
  
     */
    static has(name: string): boolean;
    /**
     * Execute an internal tool by name.
  
  
     */
    static execute(name: string, args: Record<string, unknown>, context?: Record<string, unknown>): Promise<any>;
    /**
     * Get all internal tool schemas (for LLM consumption — no endpoint metadata).
  
     */
    static getSchemas(): unknown[];
    /**
     * Get all internal tool schemas with domain/labels (for client UI).
  
     */
    static getClientSchemas(): any[];
    /**
     * Get the Set of all registered internal tool names.
     * Used by AgenticLoopService for bypass-filter logic.
  
     */
    static getNames(): Set<any>;
}
//# sourceMappingURL=InternalToolRegistry.d.ts.map
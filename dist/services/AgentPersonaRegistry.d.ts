declare const AgentPersonaRegistry: {
    /**
     * Get a persona by agent identifier.
  
  
     */
    get(agentId: Record<string, unknown>): any;
    /**
     * List all registered personas.
     * @returns {Array<{ id: string, name: string, custom?: boolean }>}
     */
    list(): {
        custom?: boolean | undefined;
        id: unknown;
        name: unknown;
        type: {};
    }[];
    /**
     * Check if a persona exists.
  
  
     */
    has(agentId: Record<string, unknown>): boolean;
    /**
     * Check if a project belongs to a registered agent.
  
  
     */
    isAgentProject(project: Record<string, unknown>): boolean;
    /**
     * Register a custom (user-defined) agent persona at runtime.
     * Converts a MongoDB document into a persona object compatible
     * with the built-in format, then inserts into the PERSONAS map.
     *
  
     */
    registerCustom(document: Record<string, unknown>): void;
    /**
     * Unregister a persona by agent ID (only custom agents should be removed).
  
     */
    unregister(agentId: Record<string, unknown>): void;
    /**
     * Load all custom agents from the database and register them.
     * Called at startup and can be called to refresh after mutations.
     */
    loadCustomAgents(): Promise<void>;
};
export default AgentPersonaRegistry;
//# sourceMappingURL=AgentPersonaRegistry.d.ts.map
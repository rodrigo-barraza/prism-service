declare const AgentPersonaRegistry: {
    /**
     * Get a persona by agent identifier.
  
  
     */
    get(agentId: any): any;
    /**
     * List all registered personas.
     * @returns {Array<{ id: string, name: string, custom?: boolean }>}
     */
    list(): {
        custom?: boolean | undefined;
        id: any;
        name: any;
        type: any;
    }[];
    /**
     * Check if a persona exists.
  
  
     */
    has(agentId: any): boolean;
    /**
     * Check if a project belongs to a registered agent.
  
  
     */
    isAgentProject(project: any): boolean;
    /**
     * Register a custom (user-defined) agent persona at runtime.
     * Converts a MongoDB document into a persona object compatible
     * with the built-in format, then inserts into the PERSONAS map.
     *
  
     */
    registerCustom(document: any): void;
    /**
     * Unregister a persona by agent ID (only custom agents should be removed).
  
     */
    unregister(agentId: any): void;
    /**
     * Load all custom agents from the database and register them.
     * Called at startup and can be called to refresh after mutations.
     */
    loadCustomAgents(): Promise<void>;
};
export default AgentPersonaRegistry;
//# sourceMappingURL=AgentPersonaRegistry.d.ts.map
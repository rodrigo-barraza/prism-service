declare const HarnessRegistry: {
    /**
     * Get a harness class by ID, falling back to the ReAct harness.
  
  
     */
    get(id: string): any;
    /**
     * List all registered harnesses for the settings UI.
     * @returns {Array<{ id: string, label: string, description: string }>}
     */
    list(): {
        id: unknown;
        label: unknown;
        description: unknown;
    }[];
    /**
     * Check if a harness ID exists.
  
  
     */
    has(id: string): boolean;
};
export default HarnessRegistry;
//# sourceMappingURL=HarnessRegistry.d.ts.map
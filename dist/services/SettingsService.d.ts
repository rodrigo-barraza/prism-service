/**
 * SettingsService — server-side settings store backed by MongoDB.
 *
 * Stores a single document (keyed by `_key: "global"`) in the `settings`
 * collection. Uses an in-memory cache to avoid DB round-trips on the
 * hot path (embedding generation, memory extraction).
 */
declare const SettingsService: {
    /**
     * Get the current settings, merging with defaults for any missing keys.
  
     */
    get(): Promise<any>;
    /**
     * Get a specific section of settings (e.g. "memory").
  
  
     */
    getSection(section: Record<string, unknown>): Promise<any>;
    /**
     * Update settings. Performs a deep merge with existing settings.
  
     * @returns {Promise<object>} The full settings after merge
     */
    update(data: Record<string, unknown>): Promise<any>;
    /**
     * Resolve provider + model for a memory subsystem role.
     * Centralises the identical getXxxConfig() helpers in MemoryService,
     * MemoryConsolidationService, and EmbeddingService.
     *
  
     * @returns {Promise<{ provider: string, model: string }>}
     */
    getMemoryModelConfig(role: string): Promise<{
        provider: any;
        model: any;
    }>;
    /**
     * Clear the in-memory cache (useful for testing).
     */
    invalidateCache(): void;
    /**
     * Return the compiled defaults for reference.
     */
    getDefaults(): {
        memory: {
            extractionProvider: string;
            extractionModel: string;
            consolidationProvider: string;
            consolidationModel: string;
            embeddingProvider: string;
            embeddingModel: string;
        };
        agents: {
            subagentProvider: string;
            subagentModel: string;
            harness: string;
        };
    };
};
export default SettingsService;
//# sourceMappingURL=SettingsService.d.ts.map
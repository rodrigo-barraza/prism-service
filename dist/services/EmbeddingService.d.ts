/**
 * EmbeddingService — single entry point for all embedding generation.
 *
 * Wraps the provider's `generateEmbedding()` with RequestLogger tracking,
 * ensuring both HTTP `/embed` requests and internal callers (MemoryService,
 * SystemPromptAssembler) flow through the same path.
 */
declare const EmbeddingService: {
    /**
     * Generate an embedding and log the request.
     *
  
  
     * @returns {Promise<{ embedding: number[], dimensions: number, provider: string, model: string }>}
     */
    generate(content: string, options?: Record<string, unknown>): Promise<{
        embedding: unknown;
        dimensions: unknown;
        provider: any;
        model: any;
    }>;
    /**
     * Convenience wrapper — returns just the embedding vector.
     * Used by internal callers that only need the float array.
     *
  
  
     */
    embed(text: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};
export default EmbeddingService;
//# sourceMappingURL=EmbeddingService.d.ts.map
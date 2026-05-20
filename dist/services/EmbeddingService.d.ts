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
    generate(content: string, options?: any): Promise<{
        embedding: any;
        dimensions: any;
        provider: any;
        model: any;
    }>;
    /**
     * Convenience wrapper — returns just the embedding vector.
     * Used by internal callers that only need the float array.
     *
  
  
     */
    embed(text: any, options?: any): Promise<any>;
};
export default EmbeddingService;
//# sourceMappingURL=EmbeddingService.d.ts.map
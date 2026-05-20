/**
 * Factory: create a vLLM provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all vLLM methods
 */
export declare function createVllmProvider(baseUrl: any, instanceId?: any): {
    name: any;
    generateText(messages: any, model?: any, options?: any): Promise<{
        text: any;
        thinking: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateTextStream(messages: any, model?: any, options?: any): AsyncGenerator<any, void, unknown>;
    captionImage(images: any, prompt: any | undefined, model: any | undefined, systemPrompt: any): Promise<{
        text: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    /**
     * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
     * vLLM also exposes /v2/embed, but /v1/embeddings keeps the response
     * contract identical to the OpenAI provider.
     *


     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    generateEmbedding(content: any, model: any, options?: any): Promise<{
        embedding: any;
        dimensions: any;
    }>;
    /**
     * List all models available from the vLLM server.
     * Uses the OpenAI-standard GET /v1/models endpoint.
     * Returns { models: [...] } normalized format.
     */
    listModels(): Promise<{
        models: any;
    }>;
};
//# sourceMappingURL=vllm.d.ts.map
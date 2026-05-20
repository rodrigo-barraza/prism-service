/**
 * Factory: create an Ollama provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all Ollama methods
 */
export declare function createOllamaProvider(baseUrl: any, instanceId?: any): {
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
     * List all models available in Ollama.
     * GET /api/tags
     */
    listModels(): Promise<{
        models: any;
    }>;
};
//# sourceMappingURL=ollama.d.ts.map
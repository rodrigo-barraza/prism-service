import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
/**
 * Factory: create a vLLM provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all vLLM methods
 */
export declare function createVllmProvider(baseUrl: string, instanceId?: string): {
    name: string;
    generateText(messages: ChatMessage[], model?: string, options?: ProviderOptions): Promise<{
        text: any;
        thinking: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateTextStream(messages: ChatMessage[], model?: string, options?: ProviderOptions): AsyncGenerator<any, void, unknown>;
    captionImage(images: string[], prompt?: string, model?: string, systemPrompt?: string): Promise<{
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
    generateEmbedding(content: any, model: any, options?: ProviderOptions): Promise<{
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
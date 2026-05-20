import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
/**
 * Factory: create an Ollama provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all Ollama methods
 */
export declare function createOllamaProvider(baseUrl: string, instanceId?: string): {
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
     * List all models available in Ollama.
     * GET /api/tags
     */
    listModels(): Promise<{
        models: any;
    }>;
};
//# sourceMappingURL=ollama.d.ts.map
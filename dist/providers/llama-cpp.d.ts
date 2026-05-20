import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
/**
 * Factory: create a llama.cpp provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all llama.cpp methods
 */
export declare function createLlamaCppProvider(baseUrl: string, instanceId?: string): {
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
    listModels(): Promise<{
        models: any;
    }>;
    checkHealth(): Promise<{
        ok: boolean;
        status: any;
        slotsIdle: any;
        slotsProcessing: any;
        error?: undefined;
    } | {
        ok: boolean;
        status: string;
        error: string;
        slotsIdle?: undefined;
        slotsProcessing?: undefined;
    }>;
};
//# sourceMappingURL=llama-cpp.d.ts.map
/**
 * Factory: create a llama.cpp provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all llama.cpp methods
 */
export declare function createLlamaCppProvider(baseUrl: any, instanceId?: any): {
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
        error: any;
        slotsIdle?: undefined;
        slotsProcessing?: undefined;
    }>;
};
//# sourceMappingURL=llama-cpp.d.ts.map
declare const anthropicProvider: {
    name: string;
    generateText(messages: any, model?: any, options?: any): Promise<{
        text: string;
        usage: {
            inputTokens: any;
            outputTokens: any;
            cacheReadInputTokens: any;
            cacheCreationInputTokens: any;
        };
    }>;
    /**
     * Caption / describe images (image-to-text).
  
  
     * @returns {Promise<{ text: string, usage: object }>}
     */
    captionImage(images: any, prompt: any | undefined, model: any | undefined, systemPrompt: any): Promise<{
        text: string;
        usage: {
            inputTokens: any;
            outputTokens: any;
            cacheReadInputTokens: any;
            cacheCreationInputTokens: any;
        };
    }>;
    generateTextStream(messages: any, model?: any, options?: any): any;
};
export default anthropicProvider;
//# sourceMappingURL=anthropic.d.ts.map
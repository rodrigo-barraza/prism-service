import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
export interface AnthropicBlock {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    source?: {
        type: string;
        media_type?: string;
        data?: string;
        url?: string;
    };
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string | AnthropicBlock[];
    citations?: Array<{
        type: string;
        url?: string;
        title?: string;
        cited_text?: string;
    }>;
    url?: string;
    title?: string;
    page_age?: string;
}
declare const anthropicProvider: {
    name: string;
    generateText(messages: ChatMessage[], model?: string, options?: ProviderOptions): Promise<{
        text: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
        };
    }>;
    /**
     * Caption / describe images (image-to-text).
  
  
     * @returns {Promise<{ text: string, usage: object }>}
     */
    captionImage(images: string[], prompt?: string, model?: string, systemPrompt?: string): Promise<{
        text: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
        };
    }>;
    generateTextStream(messages: ChatMessage[], model?: string, options?: ProviderOptions): any;
};
export default anthropicProvider;
//# sourceMappingURL=anthropic.d.ts.map
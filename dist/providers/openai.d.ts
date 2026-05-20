import type { ProviderOptions } from "../types/provider.ts";
/** OpenAI conversation message (same shape as Google's ConversationMsg) */
export interface OpenAIMsg {
    role: string;
    content?: string;
    name?: string;
    images?: string[];
    toolCalls?: Array<{
        id?: string;
        name: string;
        args: unknown;
        responsesItemId?: string;
    }>;
    tool_call_id?: string;
    id?: string;
    [key: string]: unknown;
}
declare const openaiProvider: {
    name: string;
    generateText(messages: OpenAIMsg[], model?: string, options?: ProviderOptions): Promise<Record<string, unknown>>;
    /**
     * Responses API path for GPT-5.2/5.4 models.
     */
    _generateTextResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions): Promise<Record<string, unknown>>;
    /**
     * Chat Completions fallback for older models.
     */
    _generateTextChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions): Promise<Record<string, unknown>>;
    generateTextStream(messages: OpenAIMsg[], model?: string, options?: ProviderOptions): AsyncGenerator<any, void, unknown>;
    /**
     * Streaming via the Responses API.
     */
    _streamResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions): AsyncGenerator<any, void, unknown>;
    /**
     * Streaming via Chat Completions (fallback for older models).
     */
    _streamChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions): AsyncGenerator<any, void, unknown>;
    generateSpeech(text: string, voice?: string, options?: ProviderOptions): Promise<{
        stream: import("node:stream/web").ReadableStream<any> | null;
        contentType: string;
    }>;
    generateImage(prompt: string, images?: Array<string | {
        imageData: string;
        mimeType?: string;
    }>, model?: string): Promise<{
        imageData: {};
        mimeType: string;
        text: string;
    }>;
    captionImage(images: string[], prompt?: string, model?: string, systemPrompt?: string): Promise<{
        text: string | null;
        usage: {
            inputTokens: number;
            outputTokens: number;
        };
    }>;
    generateEmbedding(text: string, model?: string): Promise<{
        embedding: number[];
    }>;
    transcribeAudio(audioBuffer: Buffer, mimeType: string, model?: string, options?: ProviderOptions): Promise<{
        text: string;
        usage: Record<string, number>;
    }>;
};
export default openaiProvider;
//# sourceMappingURL=openai.d.ts.map
import { ProviderOptions } from "../types/ProviderTypes.ts";
/** OpenAI conversation message (same shape as Google's ConversationMsg) */
export interface OpenAIMsg {
    role: string;
    content?: string;
    name?: string;
    images?: string[];
    toolCalls?: Array<{
        id?: string;
        name: string;
        args: any;
        responsesItemId?: string;
    }>;
    tool_call_id?: string;
    id?: string;
    [key: string]: any;
}
declare const openaiProvider: {
    name: string;
    generateText(messages: OpenAIMsg[], model?: string, options?: ProviderOptions): Promise<any>;
    /**
     * Responses API path for GPT-5.2/5.4 models.
     */
    _generateTextResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions): Promise<any>;
    /**
     * Chat Completions fallback for older models.
     */
    _generateTextChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions): Promise<any>;
    generateTextStream(messages: OpenAIMsg[], model?: string, options?: ProviderOptions): AsyncGenerator<string | {
        type: string;
        content: string;
        data?: undefined;
        mimeType?: undefined;
        characters?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        data: string;
        mimeType: string;
        content?: undefined;
        characters?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        characters: number;
        id?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        id: string;
        name: string;
        args: {};
        characters?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
        };
        characters?: undefined;
        id?: undefined;
        name?: undefined;
        args?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        rateLimits: {
            provider: string;
            requests: {
                limit: number | null;
                remaining: number | null;
                reset: any;
            };
            tokens: {
                limit: number | null;
                remaining: number | null;
                reset: any;
            };
        };
        characters?: undefined;
        id?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
    }, void, unknown>;
    /**
     * Streaming via the Responses API.
     */
    _streamResponses(messages: OpenAIMsg[], model: string, options: ProviderOptions): AsyncGenerator<string | {
        type: string;
        content: string;
        data?: undefined;
        mimeType?: undefined;
        characters?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        data: string;
        mimeType: string;
        content?: undefined;
        characters?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        characters: number;
        content?: undefined;
        data?: undefined;
        mimeType?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        id: string;
        responsesItemId: string;
        name: string;
        args: {};
        content?: undefined;
        data?: undefined;
        mimeType?: undefined;
        characters?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
        };
        content?: undefined;
        data?: undefined;
        mimeType?: undefined;
        characters?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        rateLimits: {
            provider: string;
            requests: {
                limit: number | null;
                remaining: number | null;
                reset: any;
            };
            tokens: {
                limit: number | null;
                remaining: number | null;
                reset: any;
            };
        };
        content?: undefined;
        data?: undefined;
        mimeType?: undefined;
        characters?: undefined;
        id?: undefined;
        responsesItemId?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
    }, void, unknown>;
    /**
     * Streaming via Chat Completions (fallback for older models).
     */
    _streamChatCompletions(messages: OpenAIMsg[], model: string, options: ProviderOptions): AsyncGenerator<string | {
        type: string;
        characters: number;
        id?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        id: string;
        name: string;
        args: {};
        characters?: undefined;
        usage?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
        };
        characters?: undefined;
        id?: undefined;
        name?: undefined;
        args?: undefined;
        rateLimits?: undefined;
    } | {
        type: string;
        rateLimits: {
            provider: string;
            requests: {
                limit: number | null;
                remaining: number | null;
                reset: any;
            };
            tokens: {
                limit: number | null;
                remaining: number | null;
                reset: any;
            };
        };
        characters?: undefined;
        id?: undefined;
        name?: undefined;
        args?: undefined;
        usage?: undefined;
    }, void, unknown>;
    generateSpeech(text: string, voice?: string, options?: ProviderOptions): Promise<{
        stream: import("node:stream/web").ReadableStream<any> | null;
        contentType: string;
    }>;
    generateImage(prompt: string, images?: Array<string | {
        imageData: string;
        mimeType?: string;
    }>, model?: string): Promise<{
        imageData: any;
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
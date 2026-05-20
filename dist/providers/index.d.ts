declare const providers: {
    openai: {
        name: string;
        generateText(messages: import("./openai.ts").OpenAIMsg[], model?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<Record<string, unknown>>;
        _generateTextResponses(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/provider.ts").ProviderOptions): Promise<Record<string, unknown>>;
        _generateTextChatCompletions(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/provider.ts").ProviderOptions): Promise<Record<string, unknown>>;
        generateTextStream(messages: import("./openai.ts").OpenAIMsg[], model?: string, options?: import("../types/provider.ts").ProviderOptions): AsyncGenerator<any, void, unknown>;
        _streamResponses(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/provider.ts").ProviderOptions): AsyncGenerator<any, void, unknown>;
        _streamChatCompletions(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/provider.ts").ProviderOptions): AsyncGenerator<any, void, unknown>;
        generateSpeech(text: string, voice?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<{
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
        transcribeAudio(audioBuffer: Buffer, mimeType: string, model?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<{
            text: string;
            usage: Record<string, number>;
        }>;
    };
    anthropic: {
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
    google: {
        name: string;
        generateText(messages: import("./google.ts").ConversationMsg[], model?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<Record<string, unknown>>;
        generateTextStream(messages: import("./google.ts").ConversationMsg[], model?: string, options?: import("../types/provider.ts").ProviderOptions): AsyncGenerator<string | {
            type: string;
            id: string;
            name: string;
            args: Record<string, unknown>;
            thoughtSignature: string | undefined;
            content?: undefined;
            data?: undefined;
            mimeType?: undefined;
            code?: undefined;
            language?: undefined;
            output?: undefined;
            outcome?: undefined;
            usage?: undefined;
            safetyBlock?: undefined;
        } | {
            type: string;
            content: string;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            data?: undefined;
            mimeType?: undefined;
            code?: undefined;
            language?: undefined;
            output?: undefined;
            outcome?: undefined;
            usage?: undefined;
            safetyBlock?: undefined;
        } | {
            type: string;
            data: string;
            mimeType: string;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            content?: undefined;
            code?: undefined;
            language?: undefined;
            output?: undefined;
            outcome?: undefined;
            usage?: undefined;
            safetyBlock?: undefined;
        } | {
            type: string;
            code: string;
            language: string;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            content?: undefined;
            data?: undefined;
            mimeType?: undefined;
            output?: undefined;
            outcome?: undefined;
            usage?: undefined;
            safetyBlock?: undefined;
        } | {
            type: string;
            output: string;
            outcome: string;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            content?: undefined;
            data?: undefined;
            mimeType?: undefined;
            code?: undefined;
            language?: undefined;
            usage?: undefined;
            safetyBlock?: undefined;
        } | {
            type: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
            };
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            content?: undefined;
            data?: undefined;
            mimeType?: undefined;
            code?: undefined;
            language?: undefined;
            output?: undefined;
            outcome?: undefined;
            safetyBlock?: undefined;
        } | {
            type: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
            };
            safetyBlock: boolean;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            content?: undefined;
            data?: undefined;
            mimeType?: undefined;
            code?: undefined;
            language?: undefined;
            output?: undefined;
            outcome?: undefined;
        }, void, unknown>;
        generateTextStreamLive(messages: import("./google.ts").ConversationMsg[], model: string, options?: import("../types/provider.ts").ProviderOptions): AsyncGenerator<string | {
            type: string;
            content: string | undefined;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            usage?: undefined;
            data?: undefined;
            mimeType?: undefined;
        } | {
            type: string;
            id: string | undefined;
            name: string | undefined;
            args: Record<string, unknown> | undefined;
            thoughtSignature: string | undefined;
            content?: undefined;
            usage?: undefined;
            data?: undefined;
            mimeType?: undefined;
        } | {
            type: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
            } | undefined;
            content?: undefined;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            data?: undefined;
            mimeType?: undefined;
        } | {
            type: string;
            data: string | undefined;
            mimeType: string | undefined;
            content?: undefined;
            id?: undefined;
            name?: undefined;
            args?: undefined;
            thoughtSignature?: undefined;
            usage?: undefined;
        } | undefined, void, unknown>;
        captionImage(images: string[], prompt?: string, model?: string, systemPrompt?: string): Promise<{
            text: string | undefined;
            usage: {
                inputTokens: number;
                outputTokens: number;
            };
        }>;
        generateImage(prompt: string, images?: Array<string | {
            imageData: string;
            mimeType?: string;
        }>, model?: string, systemPrompt?: string): Promise<{
            imageData: string | undefined;
            mimeType: string;
            text: string;
        }>;
        generateSpeech(text: string, voice?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<{
            stream: import("node:stream").Readable;
            contentType: string;
        }>;
        transcribeAudio(audioBuffer: Buffer, mimeType: string, model?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<{
            text: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
            };
        }>;
        generateEmbedding(content: unknown, model?: string, options?: import("../types/provider.ts").ProviderOptions): Promise<{
            embedding: number[];
            dimensions: number;
        }>;
    };
    elevenlabs: {
        name: string;
        generateSpeech(text: any, voiceId?: any, options?: any): Promise<{
            stream: import("node:stream/web").ReadableStream<any> | null;
            contentType: string;
        }>;
        generateSpeechStream(textStream: any, voiceId?: any, options?: any): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
    };
    inworld: {
        name: string;
        generateSpeech(text: any, voice?: any, options?: any): Promise<{
            stream: import("node:stream").Readable;
            contentType: string;
        }>;
        generateSpeechStream(textStream: any, voice?: any, options?: any): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
    };
};
export declare function getProvider(name: any): any;
export declare function listProviders(): string[];
export { providers };
//# sourceMappingURL=index.d.ts.map
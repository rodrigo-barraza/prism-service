declare const providers: {
    openai: {
        name: string;
        generateText(messages: import("./openai.ts").OpenAIMsg[], model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<any>;
        _generateTextResponses(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/ProviderTypes.ts").ProviderOptions): Promise<any>;
        _generateTextChatCompletions(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/ProviderTypes.ts").ProviderOptions): Promise<any>;
        generateTextStream(messages: import("./openai.ts").OpenAIMsg[], model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): AsyncGenerator<string | {
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
        _streamResponses(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/ProviderTypes.ts").ProviderOptions): AsyncGenerator<string | {
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
        _streamChatCompletions(messages: import("./openai.ts").OpenAIMsg[], model: string, options: import("../types/ProviderTypes.ts").ProviderOptions): AsyncGenerator<string | {
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
        generateSpeech(text: string, voice?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<{
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
        transcribeAudio(audioBuffer: Buffer, mimeType: string, model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<{
            text: string;
            usage: Record<string, number>;
        }>;
    };
    anthropic: {
        name: string;
        generateText(messages: import("../types/ProviderTypes.ts").ChatMessage[], model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<{
            text: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
                cacheReadInputTokens: number;
                cacheCreationInputTokens: number;
            };
        }>;
        captionImage(images: string[], prompt?: string, model?: string, systemPrompt?: string): Promise<{
            text: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
                cacheReadInputTokens: number;
                cacheCreationInputTokens: number;
            };
        }>;
        generateTextStream(messages: import("../types/ProviderTypes.ts").ChatMessage[], model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): any;
    };
    google: {
        name: string;
        generateText(messages: import("./google.ts").ConversationMsg[], model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<any>;
        generateTextStream(messages: import("./google.ts").ConversationMsg[], model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): AsyncGenerator<string | {
            type: string;
            id: string;
            name: string;
            args: any;
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
        generateTextStreamLive(messages: import("./google.ts").ConversationMsg[], model: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): AsyncGenerator<string | {
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
            args: any;
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
        generateSpeech(text: string, voice?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<{
            stream: import("node:stream").Readable;
            contentType: string;
        }>;
        transcribeAudio(audioBuffer: Buffer, mimeType: string, model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<{
            text: string;
            usage: {
                inputTokens: number;
                outputTokens: number;
            };
        }>;
        generateEmbedding(content: any, model?: string, options?: import("../types/ProviderTypes.ts").ProviderOptions): Promise<{
            embedding: number[];
            dimensions: number;
        }>;
    };
    elevenlabs: any;
    inworld: any;
};
export declare function getProvider(name: any): any;
export declare function listProviders(): string[];
export { providers };
//# sourceMappingURL=index.d.ts.map
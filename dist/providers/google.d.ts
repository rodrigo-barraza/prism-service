import { Readable } from "stream";
import type { ProviderOptions } from "../types/provider.ts";
interface GoogleToolDeclaration {
    functionDeclarations: Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    }>;
    [key: string]: unknown;
}
export interface ConversationMsg {
    role: string;
    content?: string;
    name?: string;
    toolCalls?: Array<{
        name: string;
        args: Record<string, unknown>;
        thoughtSignature?: string;
    }>;
    images?: string[];
    audio?: string[];
    video?: string[];
    pdf?: string[];
    [key: string]: unknown;
}
/**
 * Convert generic tool schemas to Google's functionDeclarations format.
 * Input:  [{ name, description, parameters: { type, properties, required } }]
 * Output: [{ functionDeclarations: [...] }]
 */
export declare function convertToolsToGoogle(tools: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}> | null | undefined): GoogleToolDeclaration[] | null;
declare const googleProvider: {
    name: string;
    generateText(messages: ConversationMsg[], model?: string, options?: ProviderOptions): Promise<Record<string, unknown>>;
    generateTextStream(messages: ConversationMsg[], model?: string, options?: ProviderOptions): AsyncGenerator<string | {
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
    /**
     * Live API streaming — for models that only support the bidirectional
     * WebSocket-based BidiGenerateContent method (e.g. gemini-3.1-flash-live-preview).
     *
     * Bridges the event-driven Live API into an async generator matching
     * the same interface as generateTextStream().
     */
    generateTextStreamLive(messages: ConversationMsg[], model: string, options?: ProviderOptions): AsyncGenerator<string | {
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
    generateSpeech(text: string, voice?: string, options?: ProviderOptions): Promise<{
        stream: Readable;
        contentType: string;
    }>;
    transcribeAudio(audioBuffer: Buffer, mimeType: string, model?: string, options?: ProviderOptions): Promise<{
        text: string;
        usage: {
            inputTokens: number;
            outputTokens: number;
        };
    }>;
    generateEmbedding(content: unknown, model?: string, options?: ProviderOptions): Promise<{
        embedding: number[];
        dimensions: number;
    }>;
};
export default googleProvider;
//# sourceMappingURL=google.d.ts.map
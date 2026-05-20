import { ProviderOptions } from "../types/ProviderTypes.ts";
declare const elevenlabsProvider: {
    name: string;
    generateSpeech(text: Record<string, unknown>, voiceId?: Record<string, unknown>, options?: ProviderOptions): Promise<{
        stream: import("node:stream/web").ReadableStream<any> | null;
        contentType: string;
    }>;
    /**
     * Stream text to ElevenLabs via WebSocket and yield audio chunks.
  
  
     * @returns {AsyncGenerator<Buffer>} Audio chunks.
     */
    generateSpeechStream(textStream: Record<string, unknown>, voiceId?: Record<string, unknown>, options?: ProviderOptions): AsyncGenerator<Buffer<ArrayBufferLike>, void, unknown>;
};
export default elevenlabsProvider;
//# sourceMappingURL=elevenlabs.d.ts.map
declare const elevenlabsProvider: {
    name: string;
    generateSpeech(text: any, voiceId?: any, options?: any): Promise<{
        stream: import("node:stream/web").ReadableStream<any> | null;
        contentType: string;
    }>;
    /**
     * Stream text to ElevenLabs via WebSocket and yield audio chunks.
  
  
     * @returns {AsyncGenerator<Buffer>} Audio chunks.
     */
    generateSpeechStream(textStream: any, voiceId?: any, options?: any): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
};
export default elevenlabsProvider;
//# sourceMappingURL=elevenlabs.d.ts.map
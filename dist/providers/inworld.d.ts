import { ProviderOptions } from "../types/ProviderTypes.ts";
import { Readable } from "stream";
declare const inworldProvider: {
    name: string;
    /**
     * Generate speech via Inworld TTS (MP3).
     * Returns a Node Readable stream suitable for piping to an HTTP response.
     *
  
  
     * @returns {{ stream: Readable, contentType: string }}
     */
    generateSpeech(text: Record<string, unknown>, voice?: Record<string, unknown>, options?: ProviderOptions): Promise<{
        stream: Readable;
        contentType: string;
    }>;
    /**
     * Stream speech via Inworld TTS (PCM LINEAR16 + word timestamps).
     * Accepts an async text iterator (same interface as ElevenLabs) and
     * yields raw audio Buffer chunks.
     *
  
  
     * @yields {Buffer} PCM audio chunks.
     */
    generateSpeechStream(textStream: Record<string, unknown>, voice?: Record<string, unknown>, options?: ProviderOptions): AsyncGenerator<Buffer<ArrayBuffer>, void, unknown>;
};
export default inworldProvider;
//# sourceMappingURL=inworld.d.ts.map
import WebSocket from "ws";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
// @ts-ignore
import { ELEVENLABS_API_KEY } from "../../config.js";
import { TYPES, DEFAULT_VOICES, getDefaultModels } from "../config.js";
function getApiKey() {
    if (!ELEVENLABS_API_KEY) {
        throw new ProviderError("elevenlabs", "ELEVENLABS_API_KEY is not set", 401);
    }
    return ELEVENLABS_API_KEY;
}
const elevenlabsProvider = {
    name: "elevenlabs",
    async generateSpeech(text, 
    // @ts-ignore - TODO: strict typing
    voiceId = DEFAULT_VOICES.elevenlabs, options = {}) {
        // @ts-ignore - TODO: strict typing
        logger.provider("ElevenLabs", `generateSpeech voiceId=${voiceId}`);
        try {
            const apiKey = getApiKey();
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
                method: "POST",
                headers: {
                    Accept: "audio/mpeg",
                    "Content-Type": "application/json",
                    "xi-api-key": apiKey,
                },
                body: JSON.stringify({
                    text,
                    model_id: 
                    // @ts-ignore
                    options.modelId ||
                        // @ts-ignore
                        getDefaultModels(TYPES.TEXT, TYPES.AUDIO).elevenlabs,
                    voice_settings: {
                        // @ts-ignore
                        stability: options.stability || 0.5,
                        // @ts-ignore
                        similarity_boost: options.similarityBoost || 0.8,
                    },
                }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ElevenLabs API error: ${response.status} ${errorText}`);
            }
            return { stream: response.body, contentType: "audio/mpeg" };
        }
        catch (error) {
            if (error instanceof ProviderError)
                throw error;
            // @ts-ignore - TODO: strict typing
            throw new ProviderError("elevenlabs", error.message, 500, error);
        }
    },
    /**
     * Stream text to ElevenLabs via WebSocket and yield audio chunks.
  
  
     * @returns {AsyncGenerator<Buffer>} Audio chunks.
     */
    async *generateSpeechStream(textStream, 
    // @ts-ignore - TODO: strict typing
    voiceId = DEFAULT_VOICES.elevenlabs, options = {}) {
        // @ts-ignore - TODO: strict typing
        logger.provider("ElevenLabs", `generateSpeechStream voiceId=${voiceId}`);
        const apiKey = getApiKey();
        const modelId = 
        // @ts-ignore
        options.modelId || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).elevenlabs;
        const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;
        const ws = new WebSocket(wsUrl, {
            headers: { "xi-api-key": apiKey },
        });
        // Wait for connection
        // @ts-ignore - TODO: strict typing
        await new Promise((resolve, reject) => {
            // @ts-ignore - TODO: strict typing
            ws.on("open", resolve);
            // @ts-ignore - TODO: strict typing
            ws.on("error", reject);
        });
        // Send initial config
        ws.send(JSON.stringify({
            text: " ",
            voice_settings: {
                // @ts-ignore
                stability: options.stability || 0.5,
                // @ts-ignore
                similarity_boost: options.similarityBoost || 0.8,
            },
            xi_api_key: apiKey,
        }));
        // Message queue for yielding in order
        // @ts-ignore
        const messageQueue = [];
        // @ts-ignore
        let resolveMessage = null;
        let ended = false;
        let error = null;
        ws.on("message", (data) => {
            // @ts-ignore - TODO: strict typing
            const response = JSON.parse(data);
            messageQueue.push(response);
            // @ts-ignore
            if (resolveMessage) {
                const resolve = resolveMessage;
                resolveMessage = null;
                resolve();
            }
        });
        ws.on("close", () => {
            ended = true;
            // @ts-ignore
            if (resolveMessage)
                resolveMessage();
        });
        ws.on("error", (wsError) => {
            error = wsError;
            // @ts-ignore
            if (resolveMessage)
                resolveMessage();
        });
        // Send text in background
        (async () => {
            try {
                let buffer = "";
                // @ts-ignore
                for await (const chunk of textStream) {
                    buffer += chunk;
                    let match;
                    // @ts-ignore - TODO: strict typing
                    while ((match = buffer.match(/([.!?]+)\s/))) {
                        // @ts-ignore - TODO: strict typing
                        const cutIndex = match.index + match[0].length;
                        const sentence = buffer.slice(0, cutIndex);
                        buffer = buffer.slice(cutIndex);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                text: sentence,
                                try_trigger_generation: true,
                            }));
                        }
                    }
                }
                // Flush remaining
                if (buffer.length > 0 && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ text: buffer, try_trigger_generation: true }));
                }
                // Send EOS
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ text: "" }));
                }
            }
            catch (error) {
                logger.error("Error sending to ElevenLabs WS:", error);
                ws.close();
            }
        })();
        // Yield audio chunks
        try {
            while (true) {
                if (messageQueue.length > 0) {
                    // @ts-ignore
                    const message = messageQueue.shift();
                    // @ts-ignore - TODO: strict typing
                    if (message.audio) {
                        // @ts-ignore - TODO: strict typing
                        yield Buffer.from(message.audio, "base64");
                    }
                    // @ts-ignore - TODO: strict typing
                    if (message.isFinal) {
                        break;
                    }
                }
                else {
                    if (error)
                        // @ts-ignore
                        throw new ProviderError("elevenlabs", error.message, 500, error);
                    if (ended)
                        break;
                    // @ts-ignore - TODO: strict typing
                    await new Promise((r) => (resolveMessage = r));
                }
            }
        }
        finally {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        }
    },
};
export default elevenlabsProvider;
//# sourceMappingURL=elevenlabs.js.map
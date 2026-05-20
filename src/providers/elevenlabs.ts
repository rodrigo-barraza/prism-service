import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
import WebSocket from "ws";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import { ELEVENLABS_API_KEY } from "../../config.ts";
import { TYPES, DEFAULT_VOICES, getDefaultModels } from "../config.ts";

function getApiKey() {
  if (!ELEVENLABS_API_KEY) {
    throw new ProviderError("elevenlabs", "ELEVENLABS_API_KEY is not set", 401);
  }
  return ELEVENLABS_API_KEY;
}

const elevenlabsProvider = ({
  name: "elevenlabs",

  async generateSpeech(
    text: any,
        voiceId: any = DEFAULT_VOICES.elevenlabs,
    options: ProviderOptions = {},
  ) {
        (logger.provider as any)(("ElevenLabs" as any), (`generateSpeech voiceId=${voiceId}` as any));
    try {
      const apiKey = getApiKey();
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          method: "POST",
          headers: {
            Accept: "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({
            text,
            model_id:
                            options.modelId ||
                            getDefaultModels(TYPES.TEXT, TYPES.AUDIO).elevenlabs,
            voice_settings: {
                            stability: options.stability || 0.5,
                            similarity_boost: options.similarityBoost || 0.8,
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `ElevenLabs API error: ${response.status} ${errorText}`,
        );
      }

      return { stream: response.body, contentType: "audio/mpeg" };
    } catch (error: any) {
      if (error instanceof ProviderError) throw error;
            throw new ProviderError("elevenlabs", (error as Error).message, 500, error);
    }
  },

  /**
   * Stream text to ElevenLabs via WebSocket and yield audio chunks.


   * @returns {AsyncGenerator<Buffer>} Audio chunks.
   */
  async *generateSpeechStream(
    textStream: any,
        voiceId: any = DEFAULT_VOICES.elevenlabs,
    options: ProviderOptions = {},
  ) {
        (logger.provider as any)(("ElevenLabs" as any), (`generateSpeechStream voiceId=${voiceId}` as any));
    const apiKey = getApiKey();
    const modelId =
            options.modelId || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).elevenlabs;
    const wsUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;

    const ws = new WebSocket(wsUrl, {
      headers: { "xi-api-key": apiKey },
    });

    // Wait for connection
        await new Promise((resolve: any, reject: any) => {
            ws.on("open", resolve);
            ws.on("error", reject);
    });

    // Send initial config
    ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: {
                    stability: options.stability || 0.5,
                    similarity_boost: options.similarityBoost || 0.8,
        },
        xi_api_key: apiKey,
      }),
    );

    // Message queue for yielding in order
        const messageQueue: any[] = [];
        let resolveMessage: any = null;
    let ended = false;
    let error = null;

    ws.on("message", (data: any) => {
            const response = JSON.parse((data as any));
      messageQueue.push(response);
            if (resolveMessage) {
        const resolve = resolveMessage;
        resolveMessage = null;
        resolve();
      }
    });

    ws.on("close", () => {
      ended = true;
            if (resolveMessage) resolveMessage();
    });

    ws.on("error", (wsError: any) => {
      error = wsError;
            if (resolveMessage) resolveMessage();
    });

    // Send text in background
    (async () => {
      try {
        let buffer = "";
                for await ( const chunk of textStream) {
          buffer += chunk;
          let match: any;
                    while ((match = buffer.match(/([.!?]+)\s/))) {
                        const cutIndex = match.index + (match as any)[0].length;
            const sentence = buffer.slice(0, cutIndex);
            buffer = buffer.slice(cutIndex);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  text: sentence,
                  try_trigger_generation: true,
                }),
              );
            }
          }
        }

        // Flush remaining
        if (buffer.length > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ text: buffer, try_trigger_generation: true }),
          );
        }

        // Send EOS
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ text: "" }));
        }
      } catch (error: any) {
        logger.error("Error sending to ElevenLabs WS:", error);
        ws.close();
      }
    })();

    // Yield audio chunks
    try {
      while (true) {
        if (messageQueue.length > 0) {
                    const message = messageQueue.shift();
                    if (message.audio) {
                        yield Buffer.from(message.audio, "base64");
          }
                    if (message.isFinal) {
            break;
          }
        } else {
          if (error)
                        throw new ProviderError("elevenlabs", (error as any).message, 500, error);
          if (ended) break;
                    await new Promise(((r: any) => (resolveMessage = r) as any as (resolve: (value: any) => void, reject: (reason?: any) => void) => void));
        }
      }
    } finally {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  },
} as any);

export default elevenlabsProvider;

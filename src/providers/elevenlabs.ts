import { type ProviderOptions } from "#src/types/ProviderTypes";
import type { SoundEffectOptions, SoundEffectResult } from "#src/types/provider";
import WebSocket from "ws";
import { ProviderError } from "#src/utils/errors";
import logger from "#src/utils/logger";
import { ELEVENLABS_API_KEY } from "#config";
import {
  MODALITY_TYPES,
  DEFAULT_VOICES,
  VOICES,
  getDefaultModels,
} from "#src/config";
import { PROVIDERS } from "#src/constants";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/** ElevenLabs' text-to-sound-effects model (POST /v1/sound-generation). */
export const SOUND_EFFECT_MODEL = "eleven_text_to_sound_v2";

/** An ElevenLabs voice ID: 20 alphanumeric characters. */
const VOICE_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

function getApiKey() {
  if (!ELEVENLABS_API_KEY) {
    throw new ProviderError("elevenlabs", "ELEVENLABS_API_KEY is not set", 401);
  }
  return ELEVENLABS_API_KEY;
}

/**
 * The voice ID for a request. ElevenLabs only takes IDs, but the agent's
 * voice catalog (VoiceCatalog) lists voices by label — "Callum", not
 * "N2lVS1w4EtoT3dr4eOWO" — so a label is mapped to its ID here. Anything
 * that is neither an ID nor a catalog label (a model naming a voice
 * ElevenLabs retired) gets the default voice rather than a failed call.
 */
export function resolveVoiceId(voice?: string): string {
  const requested = voice?.trim();
  if (!requested) return DEFAULT_VOICES.elevenlabs;
  if (VOICE_ID_PATTERN.test(requested)) return requested;
  const label = requested.split(/[\s(]/)[0].toLowerCase();
  const voices = (VOICES[PROVIDERS.ELEVENLABS] || []) as {
    name: string;
    label: string;
  }[];
  const match = voices.find((entry) => entry.label.toLowerCase() === label);
  if (match) return match.name;
  logger.warn(
    `[ElevenLabs] Unknown voice "${requested}" — using the default voice`,
  );
  return DEFAULT_VOICES.elevenlabs;
}

/**
 * The TTS model for a request: the caller's `model` (what AudioRoutes and
 * workflow nodes send), else the older `modelId` spelling, else the
 * catalog default. Reading only `modelId` dropped every configured model
 * on the floor and rendered with the catalog default instead.
 */
export function resolveSpeechModel(options: ProviderOptions = {}): string {
  return (
    options.model ||
    options.modelId ||
    getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.AUDIO).elevenlabs
  );
}

function voiceSettings(options: ProviderOptions) {
  return {
    stability: options.stability ?? 0.5,
    similarity_boost: options.similarityBoost ?? 0.8,
  };
}

const elevenlabsProvider = {
  name: "elevenlabs",

  async generateSpeech(
    text: string,
    voice?: string,
    options: ProviderOptions = {},
  ) {
    const voiceId = resolveVoiceId(voice);
    const modelId = resolveSpeechModel(options);
    logger.provider(
      "ElevenLabs",
      `generateSpeech voiceId=${voiceId} model=${modelId}`,
    );
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
            model_id: modelId,
            voice_settings: voiceSettings(options),
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
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("elevenlabs", getErrorMessage(error), 500, error as Error);
    }
  },
  async *generateSpeechStream(
    textStream: AsyncIterable<string>,
    voice?: string,
    options: ProviderOptions = {},
  ) {
    const voiceId = resolveVoiceId(voice);
    const modelId = resolveSpeechModel(options);
    logger.provider(
      "ElevenLabs",
      `generateSpeechStream voiceId=${voiceId} model=${modelId}`,
    );
    const apiKey = getApiKey();
    const websocketUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}`;

    const websocket = new WebSocket(websocketUrl, {
      headers: { "xi-api-key": apiKey },
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      websocket.on("open", resolve);
      websocket.on("error", reject);
    });

    // Send initial config
    websocket.send(
      JSON.stringify({
        text: " ",
        voice_settings: voiceSettings(options),
        xi_api_key: apiKey,
      }),
    );

    // Message queue for yielding in order
    const messageQueue: { audio?: string; isFinal?: boolean }[] = [];
    let resolveMessage: (() => void) | null = null;
    let ended = false;
    let error = null;

    websocket.on("message", (data: WebSocket.RawData) => {
      const response = JSON.parse(data.toString());
      messageQueue.push(response);
      if (resolveMessage) {
        const resolve = resolveMessage;
        resolveMessage = null;
        resolve();
      }
    });

    websocket.on("close", () => {
      ended = true;
      if (resolveMessage) resolveMessage();
    });

    websocket.on("error", (websocketError: Error) => {
      error = websocketError;
      if (resolveMessage) resolveMessage();
    });

    // Send text in background
    (async () => {
      try {
        let buffer = "";
        for await (const chunk of textStream) {
          buffer += chunk;
          let match: RegExpMatchArray | null;
          while ((match = buffer.match(/([.!?]+)\s/))) {
            const cutIndex = match.index! + match[0].length;
            const sentence = buffer.slice(0, cutIndex);
            buffer = buffer.slice(cutIndex);
            if (websocket.readyState === WebSocket.OPEN) {
              websocket.send(
                JSON.stringify({
                  text: sentence,
                  try_trigger_generation: true,
                }),
              );
            }
          }
        }

        // Flush remaining
        if (buffer.length > 0 && websocket.readyState === WebSocket.OPEN) {
          websocket.send(
            JSON.stringify({ text: buffer, try_trigger_generation: true }),
          );
        }

        // Send EOS
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ text: "" }));
        }
      } catch (error: unknown) {
        logger.error("Error sending to ElevenLabs WS:", error);
        websocket.close();
      }
    })();

    // Yield audio chunks
    try {
      while (true) {
        if (messageQueue.length > 0) {
          const message = messageQueue.shift()!;
          if (message.audio) {
            yield Buffer.from(message.audio, "base64");
          }
          if (message.isFinal) {
            break;
          }
        } else {
          if (error)
            throw new ProviderError(
              "elevenlabs",
              getErrorMessage(error),
              500,
              error,
            );
          if (ended) break;
          await new Promise<void>((resolve) => {
            resolveMessage = resolve;
          });
        }
      }
    } finally {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close();
      }
    }
  },

  /**
   * Text to sound effect (POST /v1/sound-generation), MP3 at 44.1 kHz /
   * 128 kbps. Billed by generated duration, up to 30 s per clip.
   */
  async generateSoundEffect(
    prompt: string,
    options: SoundEffectOptions = {},
  ): Promise<SoundEffectResult> {
    const modelId = options.model || SOUND_EFFECT_MODEL;
    logger.provider(
      "ElevenLabs",
      `generateSoundEffect model=${modelId} duration=${options.durationSeconds ?? "auto"}${options.loop ? " loop" : ""}`,
    );
    try {
      const apiKey = getApiKey();
      const response = await fetch(
        "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
        {
          method: "POST",
          headers: {
            Accept: "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({
            text: prompt,
            model_id: modelId,
            ...(options.durationSeconds !== undefined && {
              duration_seconds: options.durationSeconds,
            }),
            ...(options.loop !== undefined && { loop: options.loop }),
            ...(options.promptInfluence !== undefined && {
              prompt_influence: options.promptInfluence,
            }),
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new ProviderError(
          "elevenlabs",
          `ElevenLabs sound effect error: ${response.status} ${errorText}`,
          response.status,
        );
      }

      return {
        audio: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || "audio/mpeg",
      };
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        "elevenlabs",
        getErrorMessage(error),
        500,
        error as Error,
      );
    }
  },
};

export default elevenlabsProvider;

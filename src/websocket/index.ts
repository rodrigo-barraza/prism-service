import { handleConversation } from "../routes/ChatRoutes.ts";
import { handleVoice } from "../routes/AudioRoutes.ts";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
} from "@google/genai";
import { GOOGLE_API_KEY, LIVE_AUDIO_MODEL } from "../../config.ts";
import crypto from "crypto";
import logger from "../utils/logger.ts";
import RequestLogger from "../services/RequestLogger.ts";
import ConversationService from "../services/ConversationService.ts";
import { calculateLiveCost } from "../utils/CostCalculator.ts";
import { getModelByName } from "../config.ts";
import { calculateTokensPerSec } from "../utils/math.ts";

/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /ws/chat   — Streaming chat (text, images, code, thinking, etc.)
 *   /ws/text-to-audio  — Streaming TTS (binary audio frames)
 *   /ws/live   — Persistent Live API session (audio/text bidirectional)
 */
export function setupWebSocket(wss: any) {
    (wss as any).on("connection", (ws: any, req: any) => {
        const url = new URL((req.url as any | URL), `http://${(req as any).headers.host}`);
    const pathname = url.pathname;

    const project =
            (req as any).headers["x-project"] || url.searchParams.get("project") || "any";
    const rawIp =
            (req as any).headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
            (req as any).socket.remoteAddress;
    // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
    const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
    const username =
            (req as any).headers["x-username"] ||
      url.searchParams.get("username") ||
      "anonymous";
        const agent = (req as any).headers["x-agent"] || null;
    logger.info(
      `WebSocket connection on ${pathname} (project: ${project}, user: ${username})`,
    );

    if (pathname === "/ws/chat") {
      handleWsChat(ws, project, username, clientIp, agent);
    } else if (pathname === "/ws/text-to-audio") {
      handleWsVoice(ws, project, username, clientIp, agent);
    } else if (pathname === "/ws/live") {
      handleWsLive(ws, project, username, clientIp, agent);
    } else {
            (ws as any).send(
        JSON.stringify({
          type: "error",
          message: `Unknown WebSocket path: ${pathname}`,
        }),
      );
            (ws as any).close();
    }
  });
}

/**
 * WebSocket chat handler — delegates to handleConversation() from chat.js.
 */
function handleWsChat(
  ws: any,
  project: any,
  username: string,
  clientIp: any,
  agent: any,
) {
    (ws as any).on("message", async (rawData: any) => {
    let data: any;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
            (ws as any).send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    await handleConversation(
      { ...data, project, username, clientIp, agent },
            (event: any) => {
        if (ws.readyState === ws.OPEN) {
                    (ws as any).send(JSON.stringify(event));
        }
      },
    );
  });
}

/**
 * WebSocket voice handler — delegates to shared handleVoice() from voice.js.
 * Sends binary audio frames for audio data, JSON for control events.
 */
function handleWsVoice(
  ws: any,
  project: any,
  username: string,
  clientIp: any,
  agent: any,
) {
    (ws as any).on("message", async (rawData: any) => {
    let data: any;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
            (ws as any).send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      await handleVoice(
        { ...data, project, username, clientIp, agent },
                (chunk: any) => {
          if (ws.readyState === ws.OPEN) {
                        (ws as any).send(chunk); // Binary audio frame
          }
        },
        (event: any) => {
          if (ws.readyState === ws.OPEN) {
                        (ws as any).send(JSON.stringify(event));
          }
        },
      );
    } catch {
      // Error already emitted via emitJSON in handleVoice
    }
  });
}

// ─── persistent bidirectional session proxy ─────────────────

/**
 * Manages a persistent Live API WebSocket session.
 *
 * Protocol (client → Prism):
 *   { type: "setup", model, config }       — Initialize the Live API session
 *   { type: "audio", data }                — Base64-encoded PCM audio chunk
 *   { type: "text", text }                 — Text input
 *   { type: "toolResponse", responses }    — Function call responses
 *   { type: "close" }                      — Close the session
 *
 * Protocol (Prism → client):
 *   { type: "setupComplete" }              — Session is ready
 *   { type: "audio", data, mimeType }      — Audio chunk from model
 *   { type: "text", text }                 — Text chunk from model
 *   { type: "thinking", content }          — Thinking content
 *   { type: "toolCall", functionCalls }    — Tool call request
 *   { type: "inputTranscription", text }   — Transcription of user audio
 *   { type: "outputTranscription", text }  — Transcription of model audio
 *   { type: "turnComplete" }               — Model finished responding
 *   { type: "interrupted" }                — Model was interrupted
 *   { type: "error", message }             — Error
 */
function handleWsLive(
  ws: any,
  project: any,
  username: string,
  _clientIp: any,
  agent: any,
) {
    let liveSession: any = null;
  /** @type {string[]} Accumulated base64 PCM audio chunks for current turn (model output, 24kHz) */
    let turnAudioChunks: any[] = [];
  let audioSampleRate = 24000;
  /** @type {string[]} Accumulated base64 PCM audio chunks for current turn (user input, 16kHz) */
    const userInputAudioChunks: any[] = [];
  const userInputSampleRate = 16000;
  /** Whether user audio upload has been triggered for this turn */
  let userAudioUploading = false;
  /** Accumulated usage across the current turn */
  let turnUsage = { inputTokens: 0, outputTokens: 0 };

  // Variables for Request Logging
  let activeModel = LIVE_AUDIO_MODEL;
    let activeConversationId: any = null;
  let activeConfig = {};

  let turnStart = performance.now();
    let passFirstTokenTime: any = null;
  let turnText = "";
  let turnThinking = "";
    let turnToolCalls: any[] = [];
  let turnInputText = "";
    let turnUserAudioRef: any = null;

  function emit(event: any) {
    if (ws.readyState === ws.OPEN) {
            (ws as any).send(JSON.stringify(event));
    }
  }

  /**
   * Build a WAV from accumulated PCM chunks, upload to MinIO, and return the ref.


   * @returns {Promise<string|null>} MinIO ref or null on failure
   */
    async function buildAndUploadAudio(
        chunks: any = turnAudioChunks,
        sampleRate: any = audioSampleRate,
  ) {
    if (chunks.length === 0) return null;
    try {
            const pcmBuffers = (chunks as any).map((b64: any) => Buffer.from(b64, "base64"));
      const pcmData = Buffer.concat(pcmBuffers);

      const numChannels = 1;
      const bitsPerSample = 16;
            const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(numChannels, 22);
            wavHeader.writeUInt32LE((sampleRate as any), 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);

      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;

      const FileService = (await import("../services/FileService.js")).default;
      const { ref } = await (FileService as any).uploadFile(
        dataUrl,
        "generations",
                (project as any),
        username,
      );
      return ref;
    } catch (error: any) {
            logger.error(`[Live API] Failed to build/upload WAV: ${(error as Error).message}`);
      return null;
    }
  }

    (ws as any).on("message", async (rawData: any) => {
    let data: any;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      emit({ type: "error", message: "Invalid JSON" });
      return;
    }

    const { type } = data;

    // ── Setup: create a new Live API session ────────────────────
    if (type === "setup") {
            if (liveSession) {
        try {
          (liveSession as any).close();
        } catch {
          /* ignore */
        }
        liveSession = null;
      }

      const model = data.model || LIVE_AUDIO_MODEL;
      const clientConfig = data.config || {};

            activeModel = model;
      activeConversationId =
                data.conversationId || (clientConfig as any)?.conversationId || null;

      // Tools setup
      const tools: any[] = [];
      if (
                (clientConfig as any).enabledTools &&
                Array.isArray((clientConfig as any).enabledTools)
      ) {
                const enabledSet = new Set((clientConfig as any).enabledTools);

        if (enabledSet.has("Web Search") || enabledSet.has("Google Search")) {
          tools.push({ googleSearch: {} });
        }

        try {
          const ToolOrchestratorService = (
            await import("../services/ToolOrchestratorService.js")
          ).default;
          const { convertToolsToGoogle } =
            await import("../providers/google.js");
          const MongoWrapper = (await import("../wrappers/MongoWrapper.js"))
            .default;
                    const { MONGO_DB_NAME } = await import("../../config.js");

          const dynamicTools = [...ToolOrchestratorService.getToolSchemas()];

          const mClient = MongoWrapper.getClient(MONGO_DB_NAME);
          if (mClient) {
            const customToolsData = await (mClient as any)
                            .db(MONGO_DB_NAME)
              .collection("custom_tools")
              .find({ project, username, enabled: true })
              .toArray();

                        for ( const t of customToolsData) {
              dynamicTools.push({
                name: t.name,
                description: t.description,
                parameters: {
                  type: "object",
                  properties: Object.fromEntries(
                    (t.parameters || []).map((p: any) => [
                      p.name,
                      {
                        type: p.type || "string",
                        description: p.description || "",
                                                ...((p.enum as any)?.length ? { enum: p.enum } : {}),
                      },
                    ]),
                  ),
                  required: (t.parameters || [])
                    .filter((p: any) => p.required)
                    .map((p: any) => p.name),
                },
              });
            }
          }

                    const filtered = dynamicTools.filter((t: any) =>
            enabledSet.has(t.name),
          );
                    const googleFormats = convertToolsToGoogle((filtered as any as { name: string; description?: string | undefined; parameters?: any | undefined; }[]));
          if (googleFormats) {
            tools.push(...googleFormats);
          }
        } catch (error: any) {
                    logger.error(`[Live API] Error loading tools: ${(error as Error).message}`);
        }
      }

      // Build Live API config
      const liveConfig = {
                responseModalities: (clientConfig as any).responseModalities || [Modality.AUDIO],
        // Always include a base system instruction with language hint to anchor
        // the input transcription model (which has no languageCode field)
                systemInstruction: (clientConfig as any).systemInstruction
                    ? `${(clientConfig as any).systemInstruction}\n\nAlways respond in the same language the user speaks. The user's primary language is English.`
          : "Always respond in the same language the user speaks. The user's primary language is English.",
                ...((clientConfig as any).temperature !== undefined && {
                    temperature: (clientConfig as any).temperature,
        }),
                ...((clientConfig as any).thinkingConfig && {
                    thinkingConfig: (clientConfig as any).thinkingConfig,
        }),
        ...(tools.length > 0 && { tools }),
        // Voice Activity Detection — tuned for reliable speech capture
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 500,
            silenceDurationMs: 1500,
          },
        },
        // Voice config — explicit voice selection
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
                            voiceName: (clientConfig as any).voiceName || "Puck",
            },
          },
        },
        // Enable transcription for audio responses
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      };
      activeConfig = liveConfig;

      try {
        const client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
        liveSession = await client.live.connect({
                    model,
          config: liveConfig,
          callbacks: {
            onopen: () => {
              logger.info(
                `[Live API] Session opened for ${model} (project: ${project}, user: ${username})`,
              );
              // Mark conversation as generating when the Live session opens
                            if (activeConversationId) {
                (ConversationService as any).setGenerating(
                  activeConversationId,
                  project,
                  username,
                                    (true as any),
                ).catch((error: any) =>
                  logger.error(
                    `[Live API] Failed to set isGenerating: ${error.message}`,
                  ),
                );
              }
              emit({ type: "setupComplete" });
            },
                        // @ts-ignore - TODO: strict typing
                        onmessage: (message: string) => {
              // Model turn parts (audio data, text, function calls)
                            if ((message as any).serverContent?.modelTurn?.parts) {
                                if (!passFirstTokenTime) {
                  passFirstTokenTime = performance.now();
                  // Re-set isGenerating at the start of each new turn
                                    if (activeConversationId) {
                    (ConversationService as any).setGenerating(
                      activeConversationId,
                      project,
                      username,
                                            (true as any),
                    ).catch(() => {});
                  }
                }

                // First model turn message = user is done speaking.
                // Eagerly upload user audio and emit userAudioReady now,
                // so the audio card shows up before the model finishes.
                if (!userAudioUploading && userInputAudioChunks.length > 0) {
                  userAudioUploading = true;
                                    buildAndUploadAudio(
                                        (userInputAudioChunks as any),
                    (userInputSampleRate as any),
                                    ).then((userAudioRef: any) => {
                    if (userAudioRef) {
                      turnUserAudioRef = userAudioRef;
                      emit({ type: "userAudioReady", userAudioRef });
                    }
                  });
                }
                                for ( const part of (message as any).serverContent.modelTurn.parts) {
                  if (part.thought && part.text) {
                    emit({ type: "thinking", content: part.text });
                    turnThinking += part.text;
                  } else if (part.text) {
                    emit({ type: "text", text: part.text });
                    turnText += part.text;
                  } else if (part.inlineData) {
                    emit({
                      type: "audio",
                      data: part.inlineData.data,
                      mimeType: part.inlineData.mimeType,
                    });
                    // Accumulate for WAV building
                    if (part.inlineData.data) {
                      turnAudioChunks.push(part.inlineData.data);
                    }
                    if (part.inlineData.mimeType) {
                      const rateMatch =
                        part.inlineData.mimeType.match(/rate=(\d+)/);
                      if (rateMatch)
                        audioSampleRate = parseInt(rateMatch[1], 10);
                    }
                  } else if (part.functionCall) {
                    emit({
                      type: "toolCall",
                      functionCalls: [
                        {
                          id: `live-tc-${crypto.randomUUID()}`,
                          name: part.functionCall.name,
                          args: part.functionCall.args || {},
                        },
                      ],
                    });
                  }
                }
              }

              // Top-level tool calls
                            if ((message as any).toolCall?.functionCalls) {
                                const functionCalls = (message as any).toolCall.functionCalls.map(
                  (fc: any) => ({
                    id: fc.id || `live-tc-${crypto.randomUUID()}`,
                    name: fc.name,
                    args: fc.args || {},
                  }),
                );
                turnToolCalls.push(...functionCalls);

                // Emit calling status to the client
                                for ( const fc of functionCalls) {
                  emit({
                    type: "tool_execution",
                    tool: { name: fc.name, args: fc.args, id: fc.id },
                    status: "calling",
                  });
                }

                // Execute tools natively in Prism and return response to Gemini
                (async () => {
                  try {
                    const ToolOrchestratorService = (
                      await import("../services/ToolOrchestratorService.js")
                    ).default;
                    const { truncateToolResult } =
                      await import("../utils/FunctionCallingUtilities.js");
                    const MongoWrapper = (
                      await import("../wrappers/MongoWrapper.js")
                    ).default;
                                        const { MONGO_DB_NAME } = await import("../../config.js");

                    // Build merged tool map (custom + built-in) for execution
                    const customToolMap = new Map();
                    try {
                      const mClient = MongoWrapper.getClient(MONGO_DB_NAME);
                      if (mClient) {
                        const customToolsData = await (mClient as any)
                                                    .db(MONGO_DB_NAME)
                          .collection("custom_tools")
                          .find({ project, username, enabled: true })
                          .toArray();
                                                for ( const t of customToolsData) {
                          customToolMap.set(t.name, t);
                        }
                      }
                    } catch (error: any) {
                      logger.warn(
                                                `Failed to fetch custom tools for Live API loop: ${(error as Error).message}`,
                      );
                    }

                    const results = (await Promise.all(
                                          functionCalls.map(async (tc: any) => {
                                            let result: any;
                                            const customDef = customToolMap.get(tc.name);
                                            if (customDef) {
                                                                        result =
                                                await ToolOrchestratorService.executeCustomTool(
                                                  customDef,
                                                                                (tc.args as any | undefined),
                                                );
                                            } else {
                                              result = await ToolOrchestratorService.executeTool(
                                                                            (tc.name as any),
                                                (tc.args as any | undefined),
                                              );
                                            }
                                            return { id: tc.id, name: tc.name, result };
                                          }),
                                        ) as any);

                                        for ( const res of results) {
                      emit({
                        type: "tool_execution",
                        tool: {
                          name: res.name,
                          id: res.id,
                          result: res.result,
                        },
                        status: res.result?.error ? "error" : "done",
                      });
                    }

                    const functionResponses = (results as any).map((r: any) => ({
                      id: r.id,
                      name: r.name,
                                            response: truncateToolResult((r.result as any)),
                    }));

                                        (liveSession as any).sendToolResponse({ functionResponses });
                  } catch (error: any) {
                    logger.error(
                                            `[Live API] Error executing tools: ${(error as Error).message}`,
                    );
                  }
                })();
              }

              // Transcriptions
                            if ((message as any).serverContent?.inputTranscription?.text) {
                turnInputText +=
                                    (message as any).serverContent.inputTranscription.text + "\n";
                emit({
                  type: "inputTranscription",
                                    text: (message as any).serverContent.inputTranscription.text,
                });
              }
                            if ((message as any).serverContent?.outputTranscription?.text) {
                                const outText = (message as any).serverContent.outputTranscription.text;
                turnText += outText;
                emit({
                  type: "outputTranscription",
                  text: outText,
                });
              }

              // Usage metadata — accumulate per turn (must run BEFORE
              // turnComplete / interrupted checks because the final
              // usageMetadata arrives in the same message as those events)
                            if ((message as any).usageMetadata) {
                turnUsage.inputTokens +=
                                    (message as any).usageMetadata.promptTokenCount ?? 0;
                turnUsage.outputTokens +=
                                    (message as any).usageMetadata.candidatesTokenCount ?? 0;
              }

              // Finalize usage: the Live API does not report
              // candidatesTokenCount for audio output, so we estimate
              // output tokens from accumulated PCM data.
              // Google tokenises audio at 32 tokens/second.
              function finalizeUsage() {
                if (
                  turnUsage.outputTokens === 0 &&
                  turnAudioChunks.length > 0
                ) {
                                    const totalPcmBytes = turnAudioChunks.reduce(
                    (sum: any, b64: any) =>
                                            sum + Buffer.from(b64, "base64").length,
                                        0,
                  );
                  // 16-bit mono → 2 bytes per sample
                                    const durationSeconds = totalPcmBytes / (audioSampleRate * 2);
                  turnUsage.outputTokens = Math.ceil(durationSeconds * 32);
                }
              }

              // Shared helper — handles logging, emitting, resetting, and
              // clearing isGenerating for both turnComplete and interrupted.
              function finalizeTurn(eventType: any) {
                finalizeUsage();
                                buildAndUploadAudio().then((audioRef: any) => {
                                    const modelDef = getModelByName((model as any));
                  const estimatedCost = calculateLiveCost(
                    turnUsage,
                                        (modelDef as any)?.pricing,
                  );

                  const totalSec = (performance.now() - turnStart) / 1000;
                                    const timeToGenerationSec = passFirstTokenTime
                    ? (passFirstTokenTime - turnStart) / 1000
                    : null;
                                    const generationSec = passFirstTokenTime
                                        // @ts-ignore - TODO: strict typing
                                        ? totalSec - timeToGenerationSec
                    : null;

                  RequestLogger.logChatGeneration({
                    requestId: `live-${crypto.randomUUID()}`,
                    endpoint: "/live",
                    operation: "live",
                    project,
                    username,
                    clientIp: _clientIp,
                    agent,
                    provider: "google",
                    model: activeModel,
                                        conversationId: activeConversationId || null,
                    success: true,
                    usage: { ...turnUsage },
                    estimatedCost,
                    tokensPerSec: calculateTokensPerSec(
                                            (turnUsage.outputTokens as any),
                      (generationSec as any),
                    ),
                    timeToGenerationSec,
                    generationSec,
                    totalSec,
                    options: activeConfig,
                    messages: [
                      {
                        role: "user",
                        content: turnInputText.trim() || "[Voice Input]",
                                                ...(turnUserAudioRef
                          ? {
                              audio: [turnUserAudioRef],
                              liveTranscription: true,
                            }
                          : {}),
                      },
                    ],
                    text: turnText,
                    thinking: turnThinking,
                                        toolCalls: turnToolCalls,
                    outputCharacters: turnText.length,
                    ...(audioRef ? { audioRef } : {}),
                  }).catch((error: any) =>
                    logger.error(
                      `[Live API] Failed to log ${eventType} request: ${error.message}`,
                    ),
                  );

                  emit({
                    type: eventType,
                    ...(audioRef ? { audioRef } : {}),
                    usage: { ...turnUsage },
                    ...(estimatedCost !== null ? { estimatedCost } : {}),
                  });

                  // Reset per-turn accumulators
                  turnAudioChunks = [];
                  userInputAudioChunks.length = 0;
                  userAudioUploading = false;
                  turnUsage = { inputTokens: 0, outputTokens: 0 };
                  turnStart = performance.now();
                  passFirstTokenTime = null;
                  turnText = "";
                  turnThinking = "";
                  turnToolCalls = [];
                  turnInputText = "";
                  turnUserAudioRef = null;

                  // Clear isGenerating flag
                                    if (activeConversationId) {
                    (ConversationService as any).setGenerating(
                      activeConversationId,
                      project,
                      username,
                                            (false as any),
                    ).catch((error: any) =>
                      logger.error(
                        `[Live API] Failed to clear isGenerating on ${eventType}: ${error.message}`,
                      ),
                    );
                  }
                });
              }

              // Turn complete — build WAV + upload, then emit with audioRef and usage
                            if ((message as any).serverContent?.turnComplete) {
                                finalizeTurn(("turnComplete" as any));
                return;
              }

              // Interrupted (model was cut off by user speech)
                            if ((message as any).serverContent?.interrupted) {
                                finalizeTurn(("interrupted" as any));
                return;
              }
            },
                        onerror: (e: any) => {
              const errMsg =
                                (e?.error as any)?.message || e?.message || "Live API error";
              logger.error(
                `[Live API] Error (${project}/${username}): ${errMsg}`,
              );
              // Clear isGenerating flag on error
                            if (activeConversationId) {
                (ConversationService as any).setGenerating(
                  activeConversationId,
                  project,
                  username,
                                    (false as any),
                ).catch(() => {});
              }
              emit({ type: "error", message: errMsg });
            },
            onclose: () => {
              logger.info(
                `[Live API] Session closed (project: ${project}, user: ${username})`,
              );
              liveSession = null;
              // Clear isGenerating flag when the Live API session closes
                            if (activeConversationId) {
                (ConversationService as any).setGenerating(
                  activeConversationId,
                  project,
                  username,
                                    (false as any),
                ).catch((error: any) =>
                  logger.error(
                    `[Live API] Failed to clear isGenerating on close: ${error.message}`,
                  ),
                );
              }
              emit({ type: "sessionClosed" });
            },
          },
        });
      } catch (error: any) {
                logger.error(`[Live API] Failed to connect: ${(error as Error).message}`);
                emit({ type: "error", message: `Failed to connect: ${(error as Error).message}` });
      }
      return;
    }

    // ── All other messages require an active session ─────────────
        if (!liveSession) {
      emit({
        type: "error",
        message: "No active session. Send a 'setup' message first.",
      });
      return;
    }

    // ── Audio input ─────────────────────────────────────────────
    if (type === "audio") {
      // Accumulate user's mic audio for WAV upload at turn end
      if (data.data) {
                userInputAudioChunks.push((data.data as any));
      }
      (liveSession as any).sendRealtimeInput({
        audio: {
          data: data.data,
          mimeType: data.mimeType || "audio/pcm;rate=16000",
        },
      });
      return;
    }

    // ── Audio stream end (mic stopped — flush server-side cache) ──
    if (type === "audioStreamEnd") {
      (liveSession as any).sendRealtimeInput({ audioStreamEnd: true });
      return;
    }

    // ── Text input ──────────────────────────────────────────────
    // The Live API uses server-managed VAD (Voice Activity Detection).
    // For text input we must bracket the message with activityStart /
    // activityEnd signals so the API recognises the turn boundary and
    // triggers a model response — without these the session closes.
    if (type === "text") {
      turnInputText += data.text + "\n";
      try {
        (liveSession as any).sendRealtimeInput({ activityStart: {} });
        (liveSession as any).sendRealtimeInput({ text: data.text });
        (liveSession as any).sendRealtimeInput({ activityEnd: {} });
      } catch (error: any) {
                logger.error(`[Live API] Failed to send text: ${(error as Error).message}`);
        emit({
          type: "error",
                    message: `Failed to send text: ${(error as Error).message}`,
        });
      }
      return;
    }

    // ── Tool response ───────────────────────────────────────────
    if (type === "toolResponse") {
      (liveSession as any).sendToolResponse({
        functionResponses: data.responses,
      });
      return;
    }

    // ── Close session ───────────────────────────────────────────
    if (type === "close") {
      try {
        (liveSession as any).close();
      } catch {
        /* ignore */
      }
      liveSession = null;
      return;
    }
  });

  // Clean up on client disconnect
    (ws as any).on("close", () => {
        if (liveSession) {
      try {
        (liveSession as any).close();
      } catch {
        /* ignore */
      }
      liveSession = null;
    }
    // Clear isGenerating flag on client disconnect
        if (activeConversationId) {
      (ConversationService as any).setGenerating(
        activeConversationId,
        project,
        username,
                (false as any),
      ).catch((error: any) =>
        logger.error(
          `[Live API] Failed to clear isGenerating on disconnect: ${error.message}`,
        ),
      );
    }
    logger.info(
      `[Live API] Client disconnected (project: ${project}, user: ${username})`,
    );
  });
}

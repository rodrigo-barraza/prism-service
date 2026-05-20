import { Request, Response, NextFunction } from "express";
import { handleConversation } from "../routes/ChatRoutes.ts";
import { handleVoice } from "../routes/AudioRoutes.ts";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
} from "@google/genai";
// @ts-ignore
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
export function setupWebSocket(wss: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  wss.on("connection", (ws: Record<string, unknown>, req: Record<string, unknown>) => {
    // @ts-ignore - TODO: strict typing
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    const project =
      // @ts-ignore - TODO: strict typing
      req.headers["x-project"] || url.searchParams.get("project") || "unknown";
    const rawIp =
      // @ts-ignore - TODO: strict typing
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      // @ts-ignore - TODO: strict typing
      req.socket.remoteAddress;
    // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
    const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
    const username =
      // @ts-ignore - TODO: strict typing
      req.headers["x-username"] ||
      url.searchParams.get("username") ||
      "anonymous";
    // @ts-ignore - TODO: strict typing
    const agent = req.headers["x-agent"] || null;
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
      // @ts-ignore - TODO: strict typing
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Unknown WebSocket path: ${pathname}`,
        }),
      );
      // @ts-ignore - TODO: strict typing
      ws.close();
    }
  });
}

/**
 * WebSocket chat handler — delegates to handleConversation() from chat.js.
 */
function handleWsChat(
  ws: Record<string, unknown>,
  project: Record<string, unknown>,
  username: string,
  clientIp: Record<string, unknown>,
  agent: Record<string, unknown>,
) {
  // @ts-ignore - TODO: strict typing
  ws.on("message", async (rawData: Record<string, unknown>) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      // @ts-ignore - TODO: strict typing
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    await handleConversation(
      { ...data, project, username, clientIp, agent },
      // @ts-ignore - TODO: strict typing
      (event: Record<string, unknown>) => {
        if (ws.readyState === ws.OPEN) {
          // @ts-ignore - TODO: strict typing
          ws.send(JSON.stringify(event));
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
  ws: Record<string, unknown>,
  project: Record<string, unknown>,
  username: string,
  clientIp: Record<string, unknown>,
  agent: Record<string, unknown>,
) {
  // @ts-ignore - TODO: strict typing
  ws.on("message", async (rawData: Record<string, unknown>) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      // @ts-ignore - TODO: strict typing
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      await handleVoice(
        { ...data, project, username, clientIp, agent },
        // @ts-ignore - TODO: strict typing
        (chunk: Record<string, unknown>) => {
          if (ws.readyState === ws.OPEN) {
            // @ts-ignore - TODO: strict typing
            ws.send(chunk); // Binary audio frame
          }
        },
        (event: Record<string, unknown>) => {
          if (ws.readyState === ws.OPEN) {
            // @ts-ignore - TODO: strict typing
            ws.send(JSON.stringify(event));
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
  ws: Record<string, unknown>,
  project: Record<string, unknown>,
  username: string,
  _clientIp: Record<string, unknown>,
  agent: Record<string, unknown>,
) {
  // @ts-ignore
  let liveSession = null;
  /** @type {string[]} Accumulated base64 PCM audio chunks for current turn (model output, 24kHz) */
  // @ts-ignore
  let turnAudioChunks: Record<string, unknown>[] = [];
  let audioSampleRate = 24000;
  /** @type {string[]} Accumulated base64 PCM audio chunks for current turn (user input, 16kHz) */
  // @ts-ignore
  const userInputAudioChunks: Record<string, unknown>[] = [];
  const userInputSampleRate = 16000;
  /** Whether user audio upload has been triggered for this turn */
  let userAudioUploading = false;
  /** Accumulated usage across the current turn */
  let turnUsage = { inputTokens: 0, outputTokens: 0 };

  // Variables for Request Logging
  let activeModel = LIVE_AUDIO_MODEL;
  // @ts-ignore
  let activeConversationId = null;
  let activeConfig = {};

  let turnStart = performance.now();
  // @ts-ignore
  let passFirstTokenTime = null;
  let turnText = "";
  let turnThinking = "";
  // @ts-ignore
  let turnToolCalls: Record<string, unknown>[] = [];
  let turnInputText = "";
  // @ts-ignore
  let turnUserAudioRef = null;

  function emit(event: Record<string, unknown>) {
    if (ws.readyState === ws.OPEN) {
      // @ts-ignore - TODO: strict typing
      ws.send(JSON.stringify(event));
    }
  }

  /**
   * Build a WAV from accumulated PCM chunks, upload to MinIO, and return the ref.


   * @returns {Promise<string|null>} MinIO ref or null on failure
   */
  // @ts-ignore
  async function buildAndUploadAudio(
    // @ts-ignore
    chunks: Record<string, unknown> = turnAudioChunks,
    // @ts-ignore - TODO: strict typing
    sampleRate: Record<string, unknown> = audioSampleRate,
  ) {
    if (chunks.length === 0) return null;
    try {
      // @ts-ignore - TODO: strict typing
      const pcmBuffers = chunks.map((b64: Record<string, unknown>) => Buffer.from(b64, "base64"));
      const pcmData = Buffer.concat(pcmBuffers);

      const numChannels = 1;
      const bitsPerSample = 16;
      // @ts-ignore - TODO: strict typing
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
      // @ts-ignore - TODO: strict typing
      wavHeader.writeUInt32LE(sampleRate, 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);

      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;

      const FileService = (await import("../services/FileService.js")).default;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        "generations",
        // @ts-ignore - TODO: strict typing
        project,
        username,
      );
      return ref;
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`[Live API] Failed to build/upload WAV: ${error.message}`);
      return null;
    }
  }

  // @ts-ignore - TODO: strict typing
  ws.on("message", async (rawData: Record<string, unknown>) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      emit({ type: "error", message: "Invalid JSON" });
      return;
    }

    const { type } = data;

    // ── Setup: create a new Live API session ────────────────────
    if (type === "setup") {
      // @ts-ignore
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          /* ignore */
        }
        liveSession = null;
      }

      const model = data.model || LIVE_AUDIO_MODEL;
      const clientConfig = data.config || {};

      // @ts-ignore - TODO: strict typing
      activeModel = model;
      activeConversationId =
        // @ts-ignore - TODO: strict typing
        data.conversationId || clientConfig?.conversationId || null;

      // Tools setup
      const tools: Record<string, unknown>[] = [];
      if (
        // @ts-ignore - TODO: strict typing
        clientConfig.enabledTools &&
        // @ts-ignore - TODO: strict typing
        Array.isArray(clientConfig.enabledTools)
      ) {
        // @ts-ignore - TODO: strict typing
        const enabledSet = new Set(clientConfig.enabledTools);

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
          // @ts-ignore
          const { MONGO_DB_NAME } = await import("../../config.js");

          const dynamicTools = [...ToolOrchestratorService.getToolSchemas()];

          const mClient = MongoWrapper.getClient(MONGO_DB_NAME);
          if (mClient) {
            const customToolsData = await mClient
              // @ts-ignore
              .db(MONGO_DB_NAME)
              .collection("custom_tools")
              .find({ project, username, enabled: true })
              .toArray();

            // @ts-ignore
            for ( const t of customToolsData) {
              dynamicTools.push({
                name: t.name,
                description: t.description,
                parameters: {
                  type: "object",
                  properties: Object.fromEntries(
                    (t.parameters || []).map((p: Record<string, unknown>) => [
                      p.name,
                      {
                        type: p.type || "string",
                        description: p.description || "",
                        // @ts-ignore - TODO: strict typing
                        ...(p.enum?.length ? { enum: p.enum } : {}),
                      },
                    ]),
                  ),
                  required: (t.parameters || [])
                    .filter((p: Record<string, unknown>) => p.required)
                    .map((p: Record<string, unknown>) => p.name),
                },
              });
            }
          }

          // @ts-ignore - TODO: strict typing
          const filtered = dynamicTools.filter((t: Record<string, unknown>) =>
            enabledSet.has(t.name),
          );
          // @ts-ignore - TODO: strict typing
          const googleFormats = convertToolsToGoogle(filtered);
          if (googleFormats) {
            tools.push(...googleFormats);
          }
        } catch (error: unknown) {
          // @ts-ignore - TODO: strict typing
          logger.error(`[Live API] Error loading tools: ${error.message}`);
        }
      }

      // Build Live API config
      const liveConfig = {
        // @ts-ignore - TODO: strict typing
        responseModalities: clientConfig.responseModalities || [Modality.AUDIO],
        // Always include a base system instruction with language hint to anchor
        // the input transcription model (which has no languageCode field)
        // @ts-ignore - TODO: strict typing
        systemInstruction: clientConfig.systemInstruction
          // @ts-ignore - TODO: strict typing
          ? `${clientConfig.systemInstruction}\n\nAlways respond in the same language the user speaks. The user's primary language is English.`
          : "Always respond in the same language the user speaks. The user's primary language is English.",
        // @ts-ignore - TODO: strict typing
        ...(clientConfig.temperature !== undefined && {
          // @ts-ignore - TODO: strict typing
          temperature: clientConfig.temperature,
        }),
        // @ts-ignore - TODO: strict typing
        ...(clientConfig.thinkingConfig && {
          // @ts-ignore - TODO: strict typing
          thinkingConfig: clientConfig.thinkingConfig,
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
              // @ts-ignore - TODO: strict typing
              voiceName: clientConfig.voiceName || "Puck",
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
          // @ts-ignore - TODO: strict typing
          model,
          config: liveConfig,
          callbacks: {
            onopen: () => {
              logger.info(
                `[Live API] Session opened for ${model} (project: ${project}, user: ${username})`,
              );
              // Mark conversation as generating when the Live session opens
              // @ts-ignore
              if (activeConversationId) {
                ConversationService.setGenerating(
                  activeConversationId,
                  project,
                  username,
                  // @ts-ignore - TODO: strict typing
                  true,
                ).catch((error: Record<string, unknown>) =>
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
              // @ts-ignore - TODO: strict typing
              if (message.serverContent?.modelTurn?.parts) {
                // @ts-ignore
                if (!passFirstTokenTime) {
                  passFirstTokenTime = performance.now();
                  // Re-set isGenerating at the start of each new turn
                  // @ts-ignore
                  if (activeConversationId) {
                    ConversationService.setGenerating(
                      activeConversationId,
                      project,
                      username,
                      // @ts-ignore - TODO: strict typing
                      true,
                    ).catch(() => {});
                  }
                }

                // First model turn message = user is done speaking.
                // Eagerly upload user audio and emit userAudioReady now,
                // so the audio card shows up before the model finishes.
                if (!userAudioUploading && userInputAudioChunks.length > 0) {
                  userAudioUploading = true;
                  // @ts-ignore
                  buildAndUploadAudio(
                    // @ts-ignore
                    userInputAudioChunks,
                    userInputSampleRate,
                  // @ts-ignore - TODO: strict typing
                  ).then((userAudioRef: Record<string, unknown>) => {
                    if (userAudioRef) {
                      turnUserAudioRef = userAudioRef;
                      emit({ type: "userAudioReady", userAudioRef });
                    }
                  });
                }
                // @ts-ignore
                for ( const part of message.serverContent.modelTurn.parts) {
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
              // @ts-ignore - TODO: strict typing
              if (message.toolCall?.functionCalls) {
                // @ts-ignore - TODO: strict typing
                const functionCalls = message.toolCall.functionCalls.map(
                  (fc: Record<string, unknown>) => ({
                    id: fc.id || `live-tc-${crypto.randomUUID()}`,
                    name: fc.name,
                    args: fc.args || {},
                  }),
                );
                turnToolCalls.push(...functionCalls);

                // Emit calling status to the client
                // @ts-ignore
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
                    // @ts-ignore
                    const { MONGO_DB_NAME } = await import("../../config.js");

                    // Build merged tool map (custom + built-in) for execution
                    const customToolMap = new Map();
                    try {
                      const mClient = MongoWrapper.getClient(MONGO_DB_NAME);
                      if (mClient) {
                        const customToolsData = await mClient
                          // @ts-ignore
                          .db(MONGO_DB_NAME)
                          .collection("custom_tools")
                          .find({ project, username, enabled: true })
                          .toArray();
                        // @ts-ignore
                        for ( const t of customToolsData) {
                          customToolMap.set(t.name, t);
                        }
                      }
                    } catch (error: unknown) {
                      logger.warn(
                        // @ts-ignore - TODO: strict typing
                        `Failed to fetch custom tools for Live API loop: ${error.message}`,
                      );
                    }

                    const results = await Promise.all(
                      functionCalls.map(async (tc: Record<string, unknown>) => {
                        let result: Record<string, unknown>;
                        const customDef = customToolMap.get(tc.name);
                        if (customDef) {
                          // @ts-ignore - TODO: strict typing
                          result =
                            await ToolOrchestratorService.executeCustomTool(
                              customDef,
                              // @ts-ignore - TODO: strict typing
                              tc.args,
                            );
                        } else {
                          result = await ToolOrchestratorService.executeTool(
                            // @ts-ignore - TODO: strict typing
                            tc.name,
                            tc.args,
                          );
                        }
                        return { id: tc.id, name: tc.name, result };
                      }),
                    );

                    // @ts-ignore
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

                    const functionResponses = results.map((r: Record<string, unknown>) => ({
                      id: r.id,
                      name: r.name,
                      // @ts-ignore - TODO: strict typing
                      response: truncateToolResult(r.result),
                    }));

                    // @ts-ignore
                    liveSession.sendToolResponse({ functionResponses });
                  } catch (error: unknown) {
                    logger.error(
                      // @ts-ignore - TODO: strict typing
                      `[Live API] Error executing tools: ${error.message}`,
                    );
                  }
                })();
              }

              // Transcriptions
              // @ts-ignore - TODO: strict typing
              if (message.serverContent?.inputTranscription?.text) {
                turnInputText +=
                  // @ts-ignore - TODO: strict typing
                  message.serverContent.inputTranscription.text + "\n";
                emit({
                  type: "inputTranscription",
                  // @ts-ignore - TODO: strict typing
                  text: message.serverContent.inputTranscription.text,
                });
              }
              // @ts-ignore - TODO: strict typing
              if (message.serverContent?.outputTranscription?.text) {
                // @ts-ignore - TODO: strict typing
                const outText = message.serverContent.outputTranscription.text;
                turnText += outText;
                emit({
                  type: "outputTranscription",
                  text: outText,
                });
              }

              // Usage metadata — accumulate per turn (must run BEFORE
              // turnComplete / interrupted checks because the final
              // usageMetadata arrives in the same message as those events)
              // @ts-ignore - TODO: strict typing
              if (message.usageMetadata) {
                turnUsage.inputTokens +=
                  // @ts-ignore - TODO: strict typing
                  message.usageMetadata.promptTokenCount ?? 0;
                turnUsage.outputTokens +=
                  // @ts-ignore - TODO: strict typing
                  message.usageMetadata.candidatesTokenCount ?? 0;
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
                  // @ts-ignore
                  const totalPcmBytes = turnAudioChunks.reduce(
                    (sum: Record<string, unknown>, b64: Record<string, unknown>) =>
                      // @ts-ignore - TODO: strict typing
                      sum + Buffer.from(b64, "base64").length,
                    // @ts-ignore - TODO: strict typing
                    0,
                  );
                  // 16-bit mono → 2 bytes per sample
                  // @ts-ignore - TODO: strict typing
                  const durationSeconds = totalPcmBytes / (audioSampleRate * 2);
                  turnUsage.outputTokens = Math.ceil(durationSeconds * 32);
                }
              }

              // Shared helper — handles logging, emitting, resetting, and
              // clearing isGenerating for both turnComplete and interrupted.
              function finalizeTurn(eventType: Record<string, unknown>) {
                finalizeUsage();
                // @ts-ignore - TODO: strict typing
                buildAndUploadAudio().then((audioRef: Record<string, unknown>) => {
                  // @ts-ignore - TODO: strict typing
                  const modelDef = getModelByName(model);
                  const estimatedCost = calculateLiveCost(
                    turnUsage,
                    // @ts-ignore
                    modelDef?.pricing,
                  );

                  const totalSec = (performance.now() - turnStart) / 1000;
                  // @ts-ignore
                  const timeToGenerationSec = passFirstTokenTime
                    ? (passFirstTokenTime - turnStart) / 1000
                    : null;
                  // @ts-ignore
                  const generationSec = passFirstTokenTime
                    // @ts-ignore
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
                    // @ts-ignore
                    conversationId: activeConversationId || null,
                    success: true,
                    usage: { ...turnUsage },
                    estimatedCost,
                    tokensPerSec: calculateTokensPerSec(
                      // @ts-ignore - TODO: strict typing
                      turnUsage.outputTokens,
                      generationSec,
                    ),
                    timeToGenerationSec,
                    generationSec,
                    totalSec,
                    options: activeConfig,
                    messages: [
                      {
                        role: "user",
                        content: turnInputText.trim() || "[Voice Input]",
                        // @ts-ignore
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
                    // @ts-ignore
                    toolCalls: turnToolCalls,
                    outputCharacters: turnText.length,
                    ...(audioRef ? { audioRef } : {}),
                  }).catch((error: Record<string, unknown>) =>
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
                  // @ts-ignore
                  if (activeConversationId) {
                    ConversationService.setGenerating(
                      activeConversationId,
                      project,
                      username,
                      // @ts-ignore - TODO: strict typing
                      false,
                    ).catch((error: Record<string, unknown>) =>
                      logger.error(
                        `[Live API] Failed to clear isGenerating on ${eventType}: ${error.message}`,
                      ),
                    );
                  }
                });
              }

              // Turn complete — build WAV + upload, then emit with audioRef and usage
              // @ts-ignore - TODO: strict typing
              if (message.serverContent?.turnComplete) {
                // @ts-ignore - TODO: strict typing
                finalizeTurn("turnComplete");
                return;
              }

              // Interrupted (model was cut off by user speech)
              // @ts-ignore - TODO: strict typing
              if (message.serverContent?.interrupted) {
                // @ts-ignore - TODO: strict typing
                finalizeTurn("interrupted");
                return;
              }
            },
            // @ts-ignore - TODO: strict typing
            onerror: (e: Record<string, unknown>) => {
              const errMsg =
                // @ts-ignore - TODO: strict typing
                e?.error?.message || e?.message || "Live API error";
              logger.error(
                `[Live API] Error (${project}/${username}): ${errMsg}`,
              );
              // Clear isGenerating flag on error
              // @ts-ignore
              if (activeConversationId) {
                ConversationService.setGenerating(
                  activeConversationId,
                  project,
                  username,
                  // @ts-ignore - TODO: strict typing
                  false,
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
              // @ts-ignore
              if (activeConversationId) {
                ConversationService.setGenerating(
                  activeConversationId,
                  project,
                  username,
                  // @ts-ignore - TODO: strict typing
                  false,
                ).catch((error: Record<string, unknown>) =>
                  logger.error(
                    `[Live API] Failed to clear isGenerating on close: ${error.message}`,
                  ),
                );
              }
              emit({ type: "sessionClosed" });
            },
          },
        });
      } catch (error: unknown) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[Live API] Failed to connect: ${error.message}`);
        // @ts-ignore - TODO: strict typing
        emit({ type: "error", message: `Failed to connect: ${error.message}` });
      }
      return;
    }

    // ── All other messages require an active session ─────────────
    // @ts-ignore
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
        // @ts-ignore - TODO: strict typing
        userInputAudioChunks.push(data.data);
      }
      liveSession.sendRealtimeInput({
        audio: {
          data: data.data,
          mimeType: data.mimeType || "audio/pcm;rate=16000",
        },
      });
      return;
    }

    // ── Audio stream end (mic stopped — flush server-side cache) ──
    if (type === "audioStreamEnd") {
      liveSession.sendRealtimeInput({ audioStreamEnd: true });
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
        liveSession.sendRealtimeInput({ activityStart: {} });
        liveSession.sendRealtimeInput({ text: data.text });
        liveSession.sendRealtimeInput({ activityEnd: {} });
      } catch (error: unknown) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[Live API] Failed to send text: ${error.message}`);
        emit({
          type: "error",
          // @ts-ignore - TODO: strict typing
          message: `Failed to send text: ${error.message}`,
        });
      }
      return;
    }

    // ── Tool response ───────────────────────────────────────────
    if (type === "toolResponse") {
      liveSession.sendToolResponse({
        functionResponses: data.responses,
      });
      return;
    }

    // ── Close session ───────────────────────────────────────────
    if (type === "close") {
      try {
        liveSession.close();
      } catch {
        /* ignore */
      }
      liveSession = null;
      return;
    }
  });

  // Clean up on client disconnect
  // @ts-ignore - TODO: strict typing
  ws.on("close", () => {
    // @ts-ignore
    if (liveSession) {
      try {
        liveSession.close();
      } catch {
        /* ignore */
      }
      liveSession = null;
    }
    // Clear isGenerating flag on client disconnect
    // @ts-ignore
    if (activeConversationId) {
      ConversationService.setGenerating(
        activeConversationId,
        project,
        username,
        // @ts-ignore - TODO: strict typing
        false,
      ).catch((error: Record<string, unknown>) =>
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

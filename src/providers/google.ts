import { GoogleGenAI, Modality, type Content, type Part, type GenerateContentConfig, type ThinkingLevel, type LiveServerMessage } from "@google/genai";
import crypto from "crypto";
import { Readable } from "stream";
import { ProviderError } from "../utils/errors.ts";
import logger from "../utils/logger.ts";
import {
  GOOGLE_API_KEY,
  GOOGLE_TTS_MODEL,
  GOOGLE_EMBEDDING_MODEL,
} from "../../config.ts";
import { TYPES, MODELS, DEFAULT_VOICES, getDefaultModels } from "../config.ts";
import type { ProviderOptions } from "../types/provider.ts";

// ── Google GenAI Content Types ──────────────────────────────

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

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    if (!GOOGLE_API_KEY) {
      throw new ProviderError("google", "GOOGLE_API_KEY is not set", 401);
    }
    client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  }
  return client;
}

/**
 * Detect content safety block errors from the Google GenAI SDK.
 * These occur when Gemini refuses to generate content due to content policy.
 * Returns true for errors that should be handled gracefully (empty result)
 * rather than propagated as 500 server errors.
 */
function isSafetyBlockError(error: unknown): boolean {
  const message = ((error as Error)?.message || "").toLowerCase();
  return (
    message.includes("prohibited_content") ||
    message.includes("image_safety") ||
    message.includes("safety") ||
    message.includes("blocked") ||
    message.includes("content filter") ||
    message.includes("response was blocked")
  );
}

/**
 * Add a WAV header to raw PCM audio data.
 */
function addWavHeader(buffer: Buffer, sampleRate: number = 24000, numChannels: number = 1): Buffer {
  const headerLength = 44;
  const dataLength = buffer.length;
  const fileSize = dataLength + headerLength - 8;
  const header = Buffer.alloc(headerLength);

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * 2, 28);
  header.writeUInt16LE(numChannels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, buffer]);
}

/**
 * Recursively sanitize a JSON Schema object for Google's restricted format.
 * Gemini's functionDeclarations only support a subset of JSON Schema —
 * unsupported keywords like `const`, `$schema`, `$id`, `$ref`, `examples`,
 * `default`, `additionalProperties` etc. cause 400 INVALID_ARGUMENT errors.
 *
 * Strategy:
 *   - `const: "value"` → `enum: ["value"]` (semantically equivalent)
 *   - Other unsupported keys → stripped entirely
 */
const GOOGLE_UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "examples",
  "default",
  "additionalProperties",
  "patternProperties",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "title",
]);

function sanitizeSchemaForGoogle(
  schema: unknown,
  isPropertyMap: boolean = false,
): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema))
    return schema.map((item) => sanitizeSchemaForGoogle(item, false));

  const source = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // Convert `const` → single-value `enum`
    if (key === "const" && !isPropertyMap) {
      cleaned.enum = [value];
      continue;
    }
    // Strip unsupported schema keywords — but NOT when we're iterating
    // over a `properties` map, where keys are user-defined field names
    // (e.g. properties.title is a field called "title", not the JSON Schema title keyword)
    if (!isPropertyMap && GOOGLE_UNSUPPORTED_KEYS.has(key)) continue;
    // When we hit a "properties" key, its children are a map of field names → schemas
    cleaned[key] = sanitizeSchemaForGoogle(value, key === "properties");
  }
  return cleaned;
}

/**
 * Convert generic tool schemas to Google's functionDeclarations format.
 * Input:  [{ name, description, parameters: { type, properties, required } }]
 * Output: [{ functionDeclarations: [...] }]
 */
export function convertToolsToGoogle(
  tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> | null | undefined,
): GoogleToolDeclaration[] | null {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        parameters: sanitizeSchemaForGoogle(t.parameters || {}) as Record<string, unknown>,
      })),
    },
  ];
}

/**
 * Build a GoogleGenerateConfig from ProviderOptions.
 * Centralizes the repeated config-building pattern across generateText,
 * generateTextStream, and generateTextStreamLive.
 */
function buildGenerateConfig(options: ProviderOptions, modelDef: Record<string, unknown> | null | undefined): GenerateContentConfig {
  const config: GenerateContentConfig = {};

  if (options.temperature !== undefined) config.temperature = options.temperature;
  if (options.topP !== undefined) config.topP = options.topP;
  if (options.topK !== undefined) config.topK = options.topK;
  if (options.presencePenalty !== undefined) config.presencePenalty = options.presencePenalty;
  if (options.frequencyPenalty !== undefined) config.frequencyPenalty = options.frequencyPenalty;
  if (options.stopSequences !== undefined) config.stopSequences = options.stopSequences;
  if (options.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
  if (options.seed !== undefined) config.seed = parseInt(String(options.seed));
  if (options.responseFormat === "json_object") config.responseMimeType = "application/json";

  // Thinking config
  if (
    options.thinkingEnabled !== false &&
    (options.thinkingLevel || options.thinkingBudget !== undefined)
  ) {
    config.thinkingConfig = { includeThoughts: true };
    if (options.thinkingLevel && modelDef?.thinkingLevels) {
      config.thinkingConfig.thinkingLevel = options.thinkingLevel as ThinkingLevel;
    }
    if (options.thinkingBudget !== undefined && options.thinkingBudget !== "") {
      config.thinkingConfig.thinkingBudget = parseInt(String(options.thinkingBudget));
    }
  }

  // System prompt
  if (options.systemPrompt) {
    config.systemInstruction = options.systemPrompt;
  }

  return config;
}

async function convertMessages(messages: ConversationMsg[]): Promise<Content[]> {
  const result: Content[] = [];

  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];
    const parts: Part[] = [];

    // ── Consecutive tool result messages → single user turn ──
    // Gemini requires ALL functionResponse parts for a model turn
    // to be grouped in one user message.
    if (item.role === "tool") {
      const responseParts: Part[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMsg = messages[j];
        responseParts.push({
          functionResponse: {
            name: toolMsg.name || "unknown",
            response: {
              result:
                typeof toolMsg.content === "string"
                  ? toolMsg.content
                  : JSON.stringify(toolMsg.content),
            },
          },
        });
        j++;
      }
      result.push({ role: "user", parts: responseParts });
      i = j - 1; // skip merged messages (loop will i++)
      continue;
    }

    // Only include media for user messages — model-generated media
    // require a thought_signature when sent back, so we skip them.
    if (item.role !== "assistant") {
      // All media fields are arrays of data URLs or HTTP URLs
      for (const field of ["images", "audio", "video", "pdf"] as const) {
        const array = item[field];
        if (array && Array.isArray(array)) {
          for (const mediaRef of array) {
            const match = (mediaRef as string).match(
              /^data:([\w-]+\/[\w.+-]+);base64,(.+)$/,
            );
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            } else if (
              (mediaRef as string).startsWith("http://") ||
              (mediaRef as string).startsWith("https://")
            ) {
              // HTTP URLs — fetch and convert to inline base64
              try {
                const response = await fetch(mediaRef as string);
                if (response.ok) {
                  const arrayBuffer = await response.arrayBuffer();
                  const base64Data =
                    Buffer.from(arrayBuffer).toString("base64");
                  const mimeType =
                    response.headers.get("content-type") || "image/jpeg";
                  parts.push({
                    inlineData: { mimeType, data: base64Data },
                  });
                }
              } catch (fetchErr: unknown) {
                logger.warn(
                  `[Google] Failed to fetch media URL for inline data: ${(fetchErr as Error).message}`,
                );
              }
            }
          }
        }
      }
    }

    // Assistant messages with tool calls — include functionCall parts
    if (item.role === "assistant" && item.toolCalls) {
      for (const tc of item.toolCalls) {
        const fcPart: Part = { functionCall: { name: tc.name, args: tc.args || {} } };
        // Preserve thoughtSignature (sibling of functionCall, required by Gemini)
        if (tc.thoughtSignature) {
          fcPart.thoughtSignature = tc.thoughtSignature;
        }
        parts.push(fcPart);
      }
    }

    if (item.content) {
      parts.push({ text: item.content });
    }
    result.push({
      role: item.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return result;
}

const googleProvider = {
  name: "google",

  async generateText(
    messages: ConversationMsg[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google,
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `generateText model=${model}`);
    try {
      const contents = await convertMessages(messages);
      const modelDef = Object.values(MODELS).find((m) => m.name === model) as Record<string, unknown> | undefined;
      const config = buildGenerateConfig(options, modelDef);

      // Web search
      if (options.webSearch) {
        config.tools = [{ googleSearch: {} }];
      }

      // Custom function calling tools
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) {
        config.tools = [...(config.tools || []), ...customTools];
      }

      // For models that output images, set responseModalities explicitly.
      // These models REQUIRE ["TEXT", "IMAGE"] — ["TEXT"] alone returns 0 tokens.
      if (modelDef?.outputTypes && (modelDef.outputTypes as string[]).includes(TYPES.IMAGE)) {
        config.responseModalities = options.forceImageGeneration
          ? ["IMAGE"]
          : ["TEXT", "IMAGE"];
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });

      // Check for function calls, images, and text in the response
      interface ToolCallResult { id: string; name: string; args: Record<string, unknown>; thoughtSignature?: string }
      interface ImageResult { data: string; mimeType: string }
      const toolCalls: ToolCallResult[] = [];
      const textParts: string[] = [];
      const images: ImageResult[] = [];
      const maxImages = options.imageCount || 1;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.functionCall) {
          toolCalls.push({
            id: `google-tc-${crypto.randomUUID()}`,
            name: part.functionCall.name || "unknown",
            args: (part.functionCall.args || {}) as Record<string, unknown>,
            thoughtSignature: (part as Record<string, unknown>).thoughtSignature as string | undefined,
          });
        } else if (part.text) {
          textParts.push(part.text);
        } else if (part.inlineData && images.length < maxImages) {
          images.push({
            data: part.inlineData.data || "",
            mimeType: part.inlineData.mimeType || "image/png",
          });
        }
      }

      const result: Record<string, unknown> = {
        text: textParts.join("") || response.text || "",
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      if (images.length > 0) result.images = images;
      return result;
    } catch (error: unknown) {
      // Content safety blocks (PROHIBITED_CONTENT, SAFETY, IMAGE_SAFETY)
      // should return an empty result, not a 500. This lets consumers
      // handle "no image generated" gracefully and preserves the conversation.
      if (isSafetyBlockError(error)) {
        logger.error(`[Google] Content safety block: ${(error as Error).message}`);
        return {
          text: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          safetyBlock: true,
        };
      }
      throw new ProviderError("google", (error as Error).message, 500, error);
    }
  },

  async *generateTextStream(
    messages: ConversationMsg[],
    model: string = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google,
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `generateTextStream model=${model}`);
    try {
      const contents = await convertMessages(messages);
      const modelDef = Object.values(MODELS).find((m) => m.name === model) as Record<string, unknown> | undefined;
      const config = buildGenerateConfig(options, modelDef);

      // Build tools array based on enabled options
      const tools: Record<string, unknown>[] = [];
      if (options.webSearch) tools.push({ googleSearch: {} });
      if (options.codeExecution) tools.push({ codeExecution: {} });
      if (options.urlContext) tools.push({ urlContext: {} });

      // Custom function calling tools
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) tools.push(...customTools);

      if (tools.length > 0) config.tools = tools;

      // For models that output images, set responseModalities explicitly.
      if (modelDef?.outputTypes && (modelDef.outputTypes as string[]).includes(TYPES.IMAGE)) {
        config.responseModalities = options.forceImageGeneration
          ? ["IMAGE"]
          : ["TEXT", "IMAGE"];
      }

      const streamConfig: GenerateContentConfig = { ...config };
      if (options.signal) {
        streamConfig.httpOptions = { timeout: 0 };
      }
      const responseStream = await getClient().models.generateContentStream({
        model,
        contents,
        config: streamConfig,
      });
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      const maxImages = options.imageCount || 1;
      let imageCount = 0;
      for await (const chunk of responseStream) {
        if (options.signal?.aborted) break;
        // Process all parts in the chunk
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part.functionCall) {
              yield {
                type: "toolCall",
                id: `google-tc-${crypto.randomUUID()}`,
                name: part.functionCall.name || "unknown",
                args: (part.functionCall.args || {}) as Record<string, unknown>,
                thoughtSignature: (part as Record<string, unknown>).thoughtSignature as string | undefined,
              };
            } else if (part.thought && part.text) {
              yield { type: "thinking", content: part.text };
            } else if (part.text) {
              yield part.text;
            } else if (part.inlineData && imageCount < maxImages) {
              imageCount++;
              yield {
                type: "image",
                data: part.inlineData.data || "",
                mimeType: part.inlineData.mimeType || "image/png",
              };
            } else if (part.executableCode?.code) {
              yield {
                type: "executableCode",
                code: part.executableCode.code,
                language: part.executableCode.language || "python",
              };
            } else if (part.codeExecutionResult) {
              yield {
                type: "codeExecutionResult",
                output: part.codeExecutionResult.output || "",
                outcome: part.codeExecutionResult.outcome || "OK",
              };
            }
          }
        } else if (chunk.text) {
          yield chunk.text;
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      }
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      }
    } catch (error: unknown) {
      if ((error as Error).name === "AbortError") return;
      if (isSafetyBlockError(error)) {
        logger.error(
          `[Google] Content safety block (stream): ${(error as Error).message}`,
        );
        yield {
          type: "usage",
          usage: { inputTokens: 0, outputTokens: 0 },
          safetyBlock: true,
        };
        return;
      }
      throw new ProviderError("google", (error as Error).message, 500, error);
    }
  },

  /**
   * Live API streaming — for models that only support the bidirectional
   * WebSocket-based BidiGenerateContent method (e.g. gemini-3.1-flash-live-preview).
   *
   * Bridges the event-driven Live API into an async generator matching
   * the same interface as generateTextStream().
   */
  async *generateTextStreamLive(messages: ConversationMsg[], model: string, options: ProviderOptions = {}) {
    logger.provider(
      "Google",
      `generateTextStreamLive (Live API) model=${model}`,
    );
    let session: Awaited<ReturnType<GoogleGenAI["live"]["connect"]>> | null = null;
    try {
      // ── Build Live API config ────────────────────────────────────
      // This model ONLY supports AUDIO output modality.
      // Text responses come via outputTranscription, not responseModalities.
      const liveConfig: Record<string, unknown> = {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
      };

      if (options.temperature !== undefined) liveConfig.temperature = options.temperature;
      if (options.topP !== undefined) liveConfig.topP = options.topP;
      if (options.topK !== undefined) liveConfig.topK = options.topK;
      if (options.maxTokens !== undefined) liveConfig.maxOutputTokens = options.maxTokens;

      if (
        options.thinkingEnabled !== false &&
        (options.thinkingLevel || options.thinkingBudget !== undefined)
      ) {
        const thinkCfg: Record<string, unknown> = { includeThoughts: true };
        if (options.thinkingLevel) thinkCfg.thinkingLevel = options.thinkingLevel;
        if (options.thinkingBudget !== undefined && options.thinkingBudget !== "") {
          thinkCfg.thinkingBudget = parseInt(String(options.thinkingBudget));
        }
        liveConfig.thinkingConfig = thinkCfg;
      }

      // Tools
      const tools: Record<string, unknown>[] = [];
      if (options.webSearch) tools.push({ googleSearch: {} });
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) tools.push(...customTools);
      if (tools.length > 0) liveConfig.tools = tools;

      // System instruction from messages[0] if role === "system"
      const systemMsg = messages.find((m) => m.role === "system");
      if (systemMsg?.content) {
        liveConfig.systemInstruction = systemMsg.content;
      }

      // ── Async queue to bridge callbacks → async generator ─────────
      interface LiveQueueItem {
        type: string;
        content?: string;
        data?: string;
        mimeType?: string;
        id?: string;
        name?: string;
        args?: Record<string, unknown>;
        thoughtSignature?: string;
        usage?: { inputTokens: number; outputTokens: number };
        message?: string;
      }
      const queue: LiveQueueItem[] = [];
      let resolver: ((item: LiveQueueItem) => void) | null = null;
      let done = false;
      let setupComplete = false;

      function enqueue(item: LiveQueueItem) {
        if (resolver) {
          const r = resolver;
          resolver = null;
          r(item);
        } else {
          queue.push(item);
        }
      }

      function dequeue(): Promise<LiveQueueItem | undefined> {
        if (queue.length > 0) {
          return Promise.resolve(queue.shift());
        }
        return new Promise((resolve) => {
          resolver = resolve;
        });
      }

      // ── Connect to Live API ───────────────────────────────────────
      session = await getClient().live.connect({
        model,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            logger.provider("Google", `Live API session opened for ${model}`);
          },
          onmessage: (message: LiveServerMessage) => {
            // Setup complete — signal we can send messages
            if (message.setupComplete !== undefined) {
              setupComplete = true;
              enqueue({ type: "setupComplete" });
              return;
            }

            // Audio data from model turn (inlineData)
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.thought && part.text) {
                  enqueue({ type: "thinking", content: part.text });
                } else if (part.inlineData) {
                  // Audio chunks from the model — forward for playback
                  enqueue({
                    type: "audio",
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                  });
                } else if (part.text) {
                  enqueue({ type: "text", content: part.text });
                } else if (part.functionCall) {
                  enqueue({
                    type: "toolCall",
                    id: `google-tc-${crypto.randomUUID()}`,
                    name: part.functionCall.name,
                    args: part.functionCall.args || {},
                    thoughtSignature: part.thoughtSignature || undefined,
                  });
                }
              }
            }

            // Output transcription — TEXT transcript of the audio output.
            // This is the primary text content for the SSE chat flow.
            if (message.serverContent?.outputTranscription?.text) {
              enqueue({
                type: "text",
                content: message.serverContent.outputTranscription.text,
              });
            }

            // Tool calls from the server
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                enqueue({
                  type: "toolCall",
                  id: `google-tc-${crypto.randomUUID()}`,
                  name: fc.name || "unknown",
                  args: (fc.args || {}) as Record<string, unknown>,
                });
              }
            }

            // Usage metadata
            if (message.usageMetadata) {
              const u = message.usageMetadata;
              if (u.promptTokenCount || u.responseTokenCount) {
                enqueue({
                  type: "usage",
                  usage: {
                    inputTokens: u.promptTokenCount ?? 0,
                    outputTokens: u.responseTokenCount ?? 0,
                  },
                });
              }
            }

            // Turn complete — signal we're done
            if (message.serverContent?.turnComplete) {
              done = true;
              enqueue({ type: "done" });
            }
          },
          onerror: (e: unknown) => {
            const errObj = e as Record<string, unknown>;
            const innerErr = errObj?.error as Record<string, unknown> | undefined;
            const errMsg = (innerErr?.message as string) || (errObj?.message as string) || "unknown";
            logger.error(
              `[Google Live API] Error: ${errMsg}`,
            );
            done = true;
            enqueue({
              type: "error",
              message: errMsg,
            });
          },
          onclose: () => {
            logger.provider("Google", "Live API session closed");
            done = true;
            enqueue({ type: "done" });
          },
        },
      });

      // ── Wait for setupComplete before sending ─────────────────────
      while (!setupComplete) {
        const item = await dequeue();
        if (item?.type === "setupComplete") break;
        if (item?.type === "error")
          throw new ProviderError("google", item.message || "Unknown error", 500);
        if (item?.type === "done") return;
      }

      // ── Seed conversation history & send user message ─────────────
      // sendClientContent works for seeding prior turns (turnComplete: false)
      // but causes "invalid argument" when used as the final turn.
      // So we seed history with sendClientContent, then send the last
      // user message via sendRealtimeInput.
      const nonSystemMessages = messages.filter(
        (m) => m.role !== "system",
      );
      const lastUserMsg = nonSystemMessages[nonSystemMessages.length - 1];
      const priorMessages = nonSystemMessages.slice(0, -1);

      // Build Content objects for prior history turns
      if (priorMessages.length > 0) {
        const historyTurns: Content[] = [];
        for (const msg of priorMessages) {
          const parts: Part[] = [];

          if (msg.content) {
            parts.push({ text: msg.content });
          }

          if (parts.length > 0) {
            historyTurns.push({
              role: msg.role === "assistant" ? "model" : "user",
              parts,
            });
          }
        }

        if (historyTurns.length > 0) {
          session.sendClientContent({
            turns: historyTurns,
            turnComplete: false,
          });
        }
      }

      // Send the final user message via sendRealtimeInput
      if (lastUserMsg?.content) {
        session.sendRealtimeInput({ text: lastUserMsg.content });
      }

      // ── Yield chunks from the queue ───────────────────────────────
      while (!done || queue.length > 0) {
        if (options.signal?.aborted) break;

        const item = await dequeue();
        if (!item || item.type === "done") break;

        if (item.type === "error") {
          throw new ProviderError("google", item.message || "Unknown error", 500);
        }

        if (item.type === "text") {
          yield item.content;
        } else if (item.type === "thinking") {
          yield { type: "thinking", content: item.content };
        } else if (item.type === "toolCall") {
          yield {
            type: "toolCall",
            id: item.id,
            name: item.name,
            args: item.args,
            thoughtSignature: item.thoughtSignature,
          };
        } else if (item.type === "usage") {
          yield { type: "usage", usage: item.usage };
        } else if (item.type === "audio") {
          yield { type: "audio", data: item.data, mimeType: item.mimeType };
        }
      }
    } catch (error: unknown) {
      if ((error as Error).name === "AbortError") return;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", (error as Error).message, 500, error);
    } finally {
      if (session) {
        try {
          session.close();
        } catch {
          /* already closed */
        }
      }
    }
  },

  async captionImage(
    images: string[],
    prompt: string = "Describe this image.",
    model: string = getDefaultModels(TYPES.IMAGE, TYPES.TEXT).google,
    systemPrompt?: string,
  ) {
    logger.provider("Google", `captionImage model=${model}`);
    try {
      // Process each image into inline data parts
      const imageParts: Part[] = [];
      for (const imageUrlOrBase64 of images) {
        let imageData = imageUrlOrBase64;
        let mimeType = "image/jpeg";

        if (imageUrlOrBase64.startsWith("http")) {
          const response = await fetch(imageUrlOrBase64);
          if (!response.ok) {
            throw new Error(
              `Failed to fetch image from URL: ${imageUrlOrBase64}`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          imageData = Buffer.from(arrayBuffer).toString("base64");
          mimeType = response.headers.get("content-type") || "image/jpeg";
        } else if (imageUrlOrBase64.includes(";base64,")) {
          const parts = imageUrlOrBase64.split(";base64,");
          mimeType = parts[0].split(":")[1];
          imageData = parts[1];
        }

        imageParts.push({ inlineData: { data: imageData, mimeType } });
      }

      const contents = [
        {
          role: "user",
          parts: [...imageParts, { text: prompt }],
        },
      ];

      const config: GenerateContentConfig = {};
      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config: Object.keys(config).length > 0 ? config : undefined,
      });
      const usage = {
        inputTokens: response.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      };
      return { text: response.text, usage };
    } catch (error: unknown) {
      throw new ProviderError("google", (error as Error).message, 500, error);
    }
  },

  async generateImage(
    prompt: string,
    images: Array<string | { imageData: string; mimeType?: string }> = [],
    model: string = MODELS.GEMINI_3_PRO_IMAGE.name,
    systemPrompt?: string,
  ) {
    logger.provider("Google", `generateImage model=${model}`);
    try {
      const config: GenerateContentConfig = {
        responseModalities: ["IMAGE"],
        imageConfig: { imageSize: "1K" },
      };

      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      const parts: Part[] = [{ text: prompt }];
      if (images.length) {
        for (const image of images) {
          // Support both data URL strings and { imageData, mimeType } objects
          if (typeof image === "string") {
            const match = image.match(/^data:([\w-]+\/[\w.+-]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            }
          } else {
            parts.push({
              inlineData: {
                data: image.imageData,
                mimeType: image.mimeType || "image/jpeg",
              },
            });
          }
        }
      }

      const contents = [{ role: "user", parts }];
      const response = await getClient().models.generateContentStream({
        model,
        config,
        contents,
      });

      let combinedText = "";
      for await (const chunk of response) {
        if (!chunk.candidates?.[0]?.content?.parts) continue;
        if (chunk.candidates?.[0]?.finishReason === "PROHIBITED_CONTENT") {
          throw new Error("Content was flagged as prohibited by Google AI");
        }
        const part = chunk.candidates[0].content.parts[0];
        if (part.inlineData) {
          return {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType || "image/png",
            text: combinedText,
          };
        } else if (chunk.text) {
          combinedText += chunk.text;
        }
      }
      throw new Error("No image data received from Google AI");
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", (error as Error).message, 500, error);
    }
  },

  async generateSpeech(text: string, voice: string = DEFAULT_VOICES.google, options: ProviderOptions = {}) {
    logger.provider("Google", `generateSpeech voice=${voice}`);
    try {
      const config: GenerateContentConfig = {
        temperature: 1,
        responseModalities: ["audio"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      };

      const speechModel = (options.model as string) || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).google;
      const speechText = options.prompt ? `${options.prompt}\n\n${text}` : text;
      const response = await getClient().models.generateContent({
        model: speechModel,
        contents: [
          {
            role: "user",
            parts: [
              { text: speechText },
            ],
          },
        ],
        config,
      });

      const candidates = response.candidates;
      if (candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const inlineData = candidates[0].content.parts[0].inlineData;
        const audioBuffer = Buffer.from(inlineData.data || "", "base64");

        if (
          inlineData.mimeType === "audio/mpeg" ||
          inlineData.mimeType === "audio/mp3"
        ) {
          return {
            stream: Readable.from(audioBuffer),
            contentType: "audio/mpeg",
          };
        } else {
          const wavBuffer = addWavHeader(audioBuffer);
          return { stream: Readable.from(wavBuffer), contentType: "audio/wav" };
        }
      } else {
        throw new Error("No audio content received from Google GenAI");
      }
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", (error as Error).message, 500, error);
    }
  },

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    model: string = GOOGLE_TTS_MODEL || "gemini-2.0-flash",
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `transcribeAudio model=${model}`);
    try {
      const audioBase64 = audioBuffer.toString("base64");
      const prompt =
        (options.prompt as string) ||
        "Transcribe the following audio accurately. Return only the transcription text, nothing else.";

      const contents: Content[] = [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            { text: prompt },
          ],
        },
      ];

      const config: GenerateContentConfig = {};
      if (options.language) {
        config.systemInstruction = `Transcribe in ${options.language}.`;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });

      return {
        text: response.text || "",
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (error: unknown) {
      throw new ProviderError("google", (error as Error).message, 500, error);
    }
  },

  async generateEmbedding(content: unknown, model?: string, options: ProviderOptions = {}) {
    const resolvedModel =
      model ||
      getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.google ||
      GOOGLE_EMBEDDING_MODEL;
    logger.provider("Google", `generateEmbedding model=${resolvedModel}`);
    try {
      const params: Record<string, unknown> = { model: resolvedModel };
      const config: Record<string, unknown> = {};

      // Build the contents for the embedding request
      if (typeof content === "string") {
        // Simple text-only input
        params.contents = content;
      } else if (Array.isArray(content)) {
        // Multimodal: wrap all parts in a single Content object.
        params.contents = { role: "user", parts: content };
      } else {
        params.contents = content;
      }

      if (options.taskType) {
        config.taskType = options.taskType;
      }
      if (options.dimensions) {
        config.outputDimensionality = options.dimensions;
      }

      if (Object.keys(config).length > 0) {
        params.config = config;
      }

      const response = await getClient().models.embedContent(
        params as unknown as Parameters<GoogleGenAI["models"]["embedContent"]>[0],
      );

      // embedContent returns { embeddings: [{ values: [...] }] } for batch/multimodal,
      // or { embedding: { values: [...] } } for single text
      let values: number[];
      if (response.embeddings?.[0]?.values) {
        values = response.embeddings[0].values;
      } else {
        throw new Error("No embedding data in response");
      }

      return {
        embedding: values,
        dimensions: values.length,
      };
    } catch (error: unknown) {
      throw new ProviderError(
        "google",
        (error as Error).message,
        (error as Record<string, unknown>).status as number || 500,
        error,
      );
    }
  },
};

export default googleProvider;

import { roundMs } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import {
  getTotalInputTokens,
  estimateTokens,
  calculateTextCost,
} from "../utils/CostCalculator.ts";
import { computeModalities } from "./ConversationService.ts";
import { COLLECTIONS } from "../constants.ts";
import { TYPES, getPricing } from "../config.ts";
import { calculateTokensPerSec } from "../utils/math.ts";
const COLLECTION = COLLECTIONS.REQUESTS;
const API_TO_CANONICAL = {
  googleSearch: "Google Search",
  googleSearchRetrieval: "Google Search",
  web_search: "Web Search",
  webSearch: "Web Search",
  webFetch: "Web Fetch",
  codeExecution: "Code Execution",
  code_execution: "Code Execution",
  computerUse: "Computer Use",
  computer_use: "Computer Use",
  fileSearch: "File Search",
  file_search: "File Search",
  urlContext: "URL Context",
  url_context: "URL Context",
  thinking: "Thinking",
  imageGeneration: "Image Generation",
  image_generation: "Image Generation",
};
export interface LogParams {
  requestId?: string;
  endpoint?: string | null;
  operation?: string | null;
  project?: string | null;
  username?: string | null;
  clientIp?: string | null;
  agent?: string | null;
  provider?: string | null;
  model?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  agentSessionId?: string | null;
  parentAgentSessionId?: string | null;
  toolsUsed?: boolean;
  toolDisplayNames?: string[];
  toolApiNames?: string[];
  success?: boolean;
  errorMessage?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCost?: number | null;
  tokensPerSec?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  stopSequences?: string[] | null;
  messageCount?: number;
  inputCharacters?: number;
  outputCharacters?: number;
  timeToGeneration?: number | null;
  generationTime?: number | null;
  totalTime?: number | null;
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: Record<string, unknown> | null;
  modalities?: Record<string, unknown> | null;
  rateLimits?: Record<string, unknown> | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  [key: string]: number | undefined;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stopSequences?: string[];
  tools?: { name?: string; function?: { name: string } }[];
  [key: string]: unknown;
}

export interface ToolCallPayload {
  name: string;
  id?: string | null;
  args?: Record<string, unknown> | string;
}

export interface MessagePayload {
  role: string;
  content?: string | unknown[] | null;
  rawContent?: string;
  images?: string[] | unknown[];
  audio?: string | unknown[];
  video?: string | unknown[];
  pdf?: string | unknown[];
  toolCalls?: ToolCallPayload[];
  thinking?: string;
  [key: string]: unknown;
}

export interface LogChatGenerationParams extends LogParams {
  usage?: TokenUsage;
  timeToGenerationSec?: number | null;
  generationSec?: number | null;
  totalSec?: number | null;
  options?: LlmOptions;
  messages?: MessagePayload[];
  text?: string | null;
  thinking?: string | null;
  images?: string[];
  toolCalls?: ToolCallPayload[];
  audioRef?: string | null;
  agenticIteration?: number | null;
}

export interface LogBackgroundLlmCallParams extends LogParams {
  provider: string;
  aiMessages: MessagePayload[];
  resultText: string | null;
  usage?: TokenUsage | Record<string, unknown> | null;
  requestStartMs: number;
  extraRequestPayload?: Record<string, unknown>;
  extraResponsePayload?: Record<string, unknown>;
}

function sanitizeMsg(m: MessagePayload) {
  const sanitizeStr = (s: unknown) =>
        typeof s === "string" && s.startsWith("data:") ? `[base64 data]` : s;
  const sanitizeMedia = (value: unknown) => {
    if (Array.isArray(value)) return value.map(sanitizeStr);
    if (typeof value === "string") return sanitizeStr(value);
    return value;
  };
  return {
    role: m.role,
    content: m.content,
        ...(m.images?.length ? { images: sanitizeMedia(m.images) } : {}),
        ...(m.audio?.length ? { audio: sanitizeMedia(m.audio) } : {}),
        ...(m.video?.length ? { video: sanitizeMedia(m.video) } : {}),
        ...(m.pdf?.length ? { pdf: sanitizeMedia(m.pdf) } : {}),
  };
}
const RequestLogger = {
  async log({
    requestId,
    endpoint,
    operation = null,
    project,
    username,
    clientIp = null,
    agent = null,
    provider,
    model,
    conversationId = null,
    traceId = null,
    agentSessionId = null,
    parentAgentSessionId = null,
    toolsUsed = false,
    toolDisplayNames = [],
    toolApiNames = [],
    success,
    errorMessage = null,
    inputTokens = 0,
    outputTokens = 0,
    estimatedCost = null,
    tokensPerSec = null,
    temperature = null,
    maxTokens = null,
    topP = null,
    topK = null,
    frequencyPenalty = null,
    presencePenalty = null,
    stopSequences = null,
    messageCount = 0,
    inputCharacters = 0,
    outputCharacters = 0,
    timeToGeneration = null, // seconds — time to first token (TTFT)
    generationTime = null, // seconds — token generation duration
    totalTime = null, // seconds — end-to-end request time
    requestPayload = null,
    responsePayload = null,
    modalities = null,
    rateLimits = null,
  }: LogParams) {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) {
        logger.error("RequestLogger: MongoDB client not available");
        return;
      }
      const document = {
        requestId,
        timestamp: new Date().toISOString(),
        endpoint,
        operation: operation || null,
        project,
        username,
        clientIp,
        agent: agent || null,
        provider,
        model,
        conversationId,
        traceId,
        agentSessionId,
                ...(parentAgentSessionId && { parentAgentSessionId }),
        toolsUsed,
        toolDisplayNames,
        toolApiNames,
        success,
        errorMessage,
        inputTokens,
        outputTokens,
        estimatedCost,
        tokensPerSec,
        temperature,
        maxTokens,
        topP,
        topK,
        frequencyPenalty,
        presencePenalty,
        stopSequences,
        messageCount,
        inputCharacters,
        outputCharacters,
        timeToGeneration,
        generationTime,
        totalTime,
        requestPayload,
        responsePayload,
        modalities,
        rateLimits,
      };
      await db.collection(COLLECTION).insertOne(document);
    } catch (error: unknown) {
            logger.error("RequestLogger: failed to save request", (error as Error).message);
    }
  },
  /**
   * High-level utility to format and log a chat-like generation.
   * Centralizes the formatting of request payloads, telemetry, and tokens.
   */
  async logChatGeneration({
    requestId,
    endpoint = "chat",
    operation = null,
    project,
    username,
    clientIp = null,
    agent = null,
    provider,
    model,
    conversationId = null,
    traceId = null,
    agentSessionId = null,
    parentAgentSessionId = null,
    success = true,
    errorMessage = null,
    // Telemetry
    usage,
    estimatedCost = null,
    tokensPerSec = null,
    timeToGenerationSec = null,
    generationSec = null,
    totalSec = null,
    // Inputs
    options = {},
    messages = [],
    // Outputs
    text = null,
    thinking = null,
    images = [],
    toolCalls = [],
    outputCharacters = 0,
    audioRef = null,
    // Optional
    agenticIteration = null,
    rateLimits = null,
  }: LogChatGenerationParams) {
        const inputTokens = usage ? getTotalInputTokens(usage as Parameters<typeof getTotalInputTokens>[0]) : 0;
        const outputTokens = usage ? usage.outputTokens || 0 : 0;
        const cacheReadInputTokens = usage?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = usage?.cacheCreationInputTokens || 0;
        const reasoningOutputTokens = usage?.reasoningOutputTokens || 0;
    // Build synthetic message array for computeModalities (same function used by conversations)
    const syntheticMessages = [
            ...messages,
      {
        role: "assistant",
        content: text || null,
                ...(images && images.length > 0 ? { images } : {}),
        ...(audioRef ? { audio: audioRef } : {}),
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        ...(thinking ? { thinking } : {}),
      },
    ];
        const modalities = computeModalities(syntheticMessages as Parameters<typeof computeModalities>[0]);
    return this.log({
      requestId,
      endpoint,
      operation,
      project,
      username,
      clientIp,
      agent,
      provider,
      model,
      conversationId,
      traceId,
      agentSessionId,
      parentAgentSessionId,
            toolsUsed: toolCalls && toolCalls.length > 0,
            toolDisplayNames:
                toolCalls && toolCalls.length > 0
          ? [
              ...new Set(
                                toolCalls.map(
                                    (tc) => (API_TO_CANONICAL as Record<string, string>)[tc.name] || tc.name,
                ),
              ),
            ]
          : [],
      toolApiNames:
                toolCalls && toolCalls.length > 0
                    ? [...new Set(toolCalls.map((tc) => tc.name))]
          : [],
      success,
      errorMessage,
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
      ...(Number(cacheReadInputTokens) > 0 && { cacheReadInputTokens: Number(cacheReadInputTokens) }),
      ...(Number(cacheCreationInputTokens) > 0 && { cacheCreationInputTokens: Number(cacheCreationInputTokens) }),
      ...(Number(reasoningOutputTokens) > 0 && { reasoningOutputTokens: Number(reasoningOutputTokens) }),
      estimatedCost,
      tokensPerSec,
      temperature: options?.temperature ?? null,
      maxTokens: options?.maxTokens ?? null,
      topP: options?.topP ?? null,
      topK: options?.topK ?? null,
      frequencyPenalty: options?.frequencyPenalty ?? null,
      presencePenalty: options?.presencePenalty ?? null,
      stopSequences: options?.stopSequences ?? null,
      messageCount: messages?.length ?? 0,
      inputCharacters: messages?.reduce(
        (sum, m) =>
                    sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      ) ?? 0,
      outputCharacters,
      timeToGeneration:
                timeToGenerationSec !== null ? roundMs(timeToGenerationSec) : null,
      generationTime: generationSec !== null ? roundMs(generationSec) : null,
      totalTime: totalSec !== null ? roundMs(totalSec) : null,
      requestPayload: {
                messages: messages?.map(sanitizeMsg) ?? [],
                ...(options?.tools
                    ? { tools: options.tools.map((t: { name?: string; function?: { name: string } }) => t.name || t.function?.name) }
          : {}),
        ...(agenticIteration !== null ? { agenticIteration } : {}),
      },
      responsePayload: {
        text: text || null,
        thinking: thinking || null,
                ...(images && images.length > 0 ? { images } : {}),
                toolCalls:
                    toolCalls && toolCalls.length > 0
                        ? toolCalls.map((tc) => ({
                                name: (API_TO_CANONICAL as Record<string, string>)[tc.name] || tc.name,
                id: tc.id,
                args: tc.args,
              }))
            : null,
        ...(audioRef ? { audioRef } : {}),
        usage,
      },
      modalities,
      rateLimits,
    });
  },
  /**
   * Log a background (non-streaming) LLM call with automatic cost estimation.
   * Centralises the identical pattern used by MemoryService, MemoryExtractor,
   * MemoryConsolidationService, and CoordinatorService for fire-and-forget
   * AI calls (extraction, consolidation, decomposition).
   *
   * Handles: estimateTokens, getPricing, calculateTextCost, calculateTokensPerSec,
   * roundMs, and calls this.log().
   */
  async logBackgroundLlmCall({
    requestId,
    endpoint,
    operation,
    project,
    username,
    agent,
    provider: providerName,
    model,
    traceId,
    agentSessionId,
    aiMessages,
    resultText,
    usage: apiUsage = null,
    success,
    errorMessage,
    requestStartMs,
    extraRequestPayload,
    extraResponsePayload,
  }: LogBackgroundLlmCallParams) {
        const totalSec = (performance.now() - requestStartMs) / 1000;
        const inputText = aiMessages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");

    // Prefer real API-reported usage over the ~4 chars/token heuristic.
    // The heuristic remains as fallback for callers that don't pass usage.
    const inputTokens = apiUsage
            ? getTotalInputTokens(apiUsage as Parameters<typeof getTotalInputTokens>[0])
      : estimateTokens(inputText);
    const outputTokens = apiUsage
            ? apiUsage.outputTokens || 0
      : resultText
                ? estimateTokens(resultText)
        : 0;
        const cacheReadInputTokens = apiUsage?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = apiUsage?.cacheCreationInputTokens || 0;

        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[model as string];
    let estimatedCost = null;
    if (pricing) {
      estimatedCost = calculateTextCost(
                (apiUsage || { inputTokens, outputTokens }) as Parameters<typeof calculateTextCost>[0],
        pricing,
      );
    }
    return this.log({
      requestId,
      endpoint: endpoint || null,
      operation,
      project,
      username: username || "system",
      clientIp: null,
      agent: agent || null,
      traceId: traceId || null,
      agentSessionId: agentSessionId || null,
      provider: providerName,
      model,
      success,
      errorMessage,
      estimatedCost,
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
      ...(Number(cacheReadInputTokens) > 0 && { cacheReadInputTokens: Number(cacheReadInputTokens) }),
      ...(Number(cacheCreationInputTokens) > 0 && { cacheCreationInputTokens: Number(cacheCreationInputTokens) }),
      tokensPerSec: calculateTokensPerSec(outputTokens as number, totalSec),
      inputCharacters: inputText.length,
      totalTime: roundMs(totalSec),
      modalities: { textIn: true, textOut: true },
      requestPayload: {
        operation,
                ...extraRequestPayload,
      },
      responsePayload: success
        ? {
                        textPreview: (resultText || "").slice(0, 200),
                        ...extraResponsePayload,
          }
        : { error: errorMessage },
    });
  },
};
export default RequestLogger;

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
import {} from "../utils/utilities.ts";
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
function sanitizeMsg(m: any) {
  const sanitizeStr = (s: any) =>
        typeof s === "string" && (s as any).startsWith("data:") ? `[base64 data]` : s;
  const sanitizeMedia = (value: any) => {
    if (Array.isArray(value)) return value.map(sanitizeStr);
    if (typeof value === "string") return sanitizeStr(value);
    return value;
  };
  return {
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content,
        ...((m.images as any)?.length ? { images: sanitizeMedia((m.images as any)) } : {}),
        ...(m.audio ? { audio: sanitizeMedia((m.audio as any)) } : {}),
        ...((m.video as any)?.length ? { video: sanitizeMedia((m.video as any)) } : {}),
        ...((m.pdf as any)?.length ? { pdf: sanitizeMedia((m.pdf as any)) } : {}),
  };
}
const RequestLogger = {
  /**
   * Log a text-to-text request to MongoDB (fire-and-forget).
   */
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
  }: any) {
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
    } catch (error: any) {
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
  }: any) {
        const inputTokens = usage ? getTotalInputTokens((usage as any)) : 0;
        const outputTokens = usage ? (usage as any).outputTokens || 0 : 0;
        const cacheReadInputTokens = (usage as any)?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = (usage as any)?.cacheCreationInputTokens || 0;
        const reasoningOutputTokens = (usage as any)?.reasoningOutputTokens || 0;
    // Build synthetic message array for computeModalities (same function used by conversations)
    const syntheticMessages = [
            ...messages,
      {
        role: "assistant",
        content: text || null,
                ...(images && (images as any).length > 0 ? { images } : {}),
        ...(audioRef ? { audio: audioRef } : {}),
                ...(toolCalls && (toolCalls as any).length > 0 ? { toolCalls } : {}),
        ...(thinking ? { thinking } : {}),
      },
    ];
        const modalities = computeModalities((syntheticMessages as any));
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
            toolsUsed: toolCalls && (toolCalls as any).length > 0,
            toolDisplayNames:
                toolCalls && (toolCalls as any).length > 0
          ? [
              ...new Set(
                                (toolCalls as any).map(
                                    (tc: any) => (API_TO_CANONICAL as any)[((tc as string) as any).name] || tc.name,
                ),
              ),
            ]
          : [],
      toolApiNames:
                toolCalls && (toolCalls as any).length > 0
                    ? [...new Set((toolCalls as any).map((tc: any) => tc.name))]
          : [],
      success,
      errorMessage,
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens > 0 && { cacheReadInputTokens }),
      ...(cacheCreationInputTokens > 0 && { cacheCreationInputTokens }),
      ...(reasoningOutputTokens > 0 && { reasoningOutputTokens }),
      estimatedCost,
      tokensPerSec,
            temperature: (options as any)?.temperature ?? null,
            maxTokens: (options as any)?.maxTokens ?? null,
            topP: (options as any)?.topP ?? null,
            topK: (options as any)?.topK ?? null,
            frequencyPenalty: (options as any)?.frequencyPenalty ?? null,
            presencePenalty: (options as any)?.presencePenalty ?? null,
            stopSequences: (options as any)?.stopSequences ?? null,
            messageCount: (messages as any).length,
            inputCharacters: (messages as any).reduce(
        (sum: any, m: any) =>
                    sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      ),
      outputCharacters,
      timeToGeneration:
                timeToGenerationSec !== null ? roundMs((timeToGenerationSec as any)) : null,
            generationTime: generationSec !== null ? roundMs((generationSec as any)) : null,
            totalTime: totalSec !== null ? roundMs((totalSec as any)) : null,
      requestPayload: {
                messages: (messages as any).map(sanitizeMsg),
                ...((options as any)?.tools
                    ? { tools: (options as any).tools.map((t: any) => t.name || (t.function as any)?.name) }
          : {}),
        ...(agenticIteration !== null ? { agenticIteration } : {}),
      },
      responsePayload: {
        text: text || null,
        thinking: thinking || null,
                ...(images && (images as any).length > 0 ? { images } : {}),
                toolCalls:
                    toolCalls && (toolCalls as any).length > 0
                        ? (toolCalls as any).map((tc: any) => ({
                                name: (API_TO_CANONICAL as any)[((tc as string) as any).name] || tc.name,
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
  }: any) {
        const totalSec = (performance.now() - (requestStartMs as any)) / 1000;
        const inputText = (aiMessages as any).map((m: any) => m.content).join("\n");

    // Prefer real API-reported usage over the ~4 chars/token heuristic.
    // The heuristic remains as fallback for callers that don't pass usage.
    const inputTokens = apiUsage
            ? getTotalInputTokens((apiUsage as any))
      : estimateTokens(inputText);
    const outputTokens = apiUsage
            ? (apiUsage as any).outputTokens || 0
      : resultText
                ? estimateTokens((resultText as any))
        : 0;
        const cacheReadInputTokens = (apiUsage as any)?.cacheReadInputTokens || 0;
        const cacheCreationInputTokens = (apiUsage as any)?.cacheCreationInputTokens || 0;

        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[(model as string)];
    let estimatedCost = null;
    if (pricing) {
      estimatedCost = calculateTextCost(
                (apiUsage || { inputTokens, outputTokens } as any),
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
      inputTokens,
      outputTokens,
      ...(cacheReadInputTokens > 0 && { cacheReadInputTokens }),
      ...(cacheCreationInputTokens > 0 && { cacheCreationInputTokens }),
            tokensPerSec: calculateTokensPerSec((outputTokens as any), (totalSec as any)),
      inputCharacters: inputText.length,
      totalTime: roundMs(totalSec),
      modalities: { textIn: true, textOut: true },
      requestPayload: {
        operation,
                ...extraRequestPayload,
      },
      responsePayload: success
        ? {
                        textPreview: ((resultText || "") as any).slice(0, 200),
                        ...extraResponsePayload,
          }
        : { error: errorMessage },
    });
  },
};
export default RequestLogger;

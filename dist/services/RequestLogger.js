// @ts-ignore
import { roundMs } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "../wrappers/MongoWrapper.js";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import { getTotalInputTokens, estimateTokens, calculateTextCost, } from "../utils/CostCalculator.js";
import { computeModalities } from "./ConversationService.js";
import { COLLECTIONS } from "../constants.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";
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
function sanitizeMsg(m) {
    const sanitizeStr = (s) => 
    // @ts-ignore - TODO: strict typing
    typeof s === "string" && s.startsWith("data:") ? `[base64 data]` : s;
    const sanitizeMedia = (value) => {
        if (Array.isArray(value))
            return value.map(sanitizeStr);
        if (typeof value === "string")
            return sanitizeStr(value);
        return value;
    };
    return {
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content,
        // @ts-ignore - TODO: strict typing
        ...(m.images?.length ? { images: sanitizeMedia(m.images) } : {}),
        // @ts-ignore - TODO: strict typing
        ...(m.audio ? { audio: sanitizeMedia(m.audio) } : {}),
        // @ts-ignore - TODO: strict typing
        ...(m.video?.length ? { video: sanitizeMedia(m.video) } : {}),
        // @ts-ignore - TODO: strict typing
        ...(m.pdf?.length ? { pdf: sanitizeMedia(m.pdf) } : {}),
    };
}
const RequestLogger = {
    /**
     * Log a text-to-text request to MongoDB (fire-and-forget).
     */
    async log({ requestId, endpoint, operation = null, project, username, clientIp = null, agent = null, provider, model, conversationId = null, traceId = null, agentSessionId = null, parentAgentSessionId = null, toolsUsed = false, toolDisplayNames = [], toolApiNames = [], success, errorMessage = null, inputTokens = 0, outputTokens = 0, estimatedCost = null, tokensPerSec = null, temperature = null, maxTokens = null, topP = null, topK = null, frequencyPenalty = null, presencePenalty = null, stopSequences = null, messageCount = 0, inputCharacters = 0, outputCharacters = 0, timeToGeneration = null, // seconds — time to first token (TTFT)
    generationTime = null, // seconds — token generation duration
    totalTime = null, // seconds — end-to-end request time
    requestPayload = null, responsePayload = null, modalities = null, rateLimits = null, }) {
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
                // @ts-ignore - TODO: strict typing
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
        }
        catch (error) {
            // @ts-ignore - TODO: strict typing
            logger.error("RequestLogger: failed to save request", error.message);
        }
    },
    /**
     * High-level utility to format and log a chat-like generation.
     * Centralizes the formatting of request payloads, telemetry, and tokens.
     */
    async logChatGeneration({ requestId, endpoint = "chat", operation = null, project, username, clientIp = null, agent = null, provider, model, conversationId = null, traceId = null, agentSessionId = null, parentAgentSessionId = null, success = true, errorMessage = null, 
    // Telemetry
    usage, estimatedCost = null, tokensPerSec = null, timeToGenerationSec = null, generationSec = null, totalSec = null, 
    // Inputs
    options = {}, messages = [], 
    // Outputs
    text = null, thinking = null, images = [], toolCalls = [], outputCharacters = 0, audioRef = null, 
    // Optional
    agenticIteration = null, rateLimits = null, }) {
        // @ts-ignore - TODO: strict typing
        const inputTokens = usage ? getTotalInputTokens(usage) : 0;
        // @ts-ignore - TODO: strict typing
        const outputTokens = usage ? usage.outputTokens || 0 : 0;
        // @ts-ignore - TODO: strict typing
        const cacheReadInputTokens = usage?.cacheReadInputTokens || 0;
        // @ts-ignore - TODO: strict typing
        const cacheCreationInputTokens = usage?.cacheCreationInputTokens || 0;
        // @ts-ignore - TODO: strict typing
        const reasoningOutputTokens = usage?.reasoningOutputTokens || 0;
        // Build synthetic message array for computeModalities (same function used by conversations)
        const syntheticMessages = [
            // @ts-ignore - TODO: strict typing
            ...messages,
            {
                role: "assistant",
                content: text || null,
                // @ts-ignore - TODO: strict typing
                ...(images && images.length > 0 ? { images } : {}),
                ...(audioRef ? { audio: audioRef } : {}),
                // @ts-ignore - TODO: strict typing
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
                ...(thinking ? { thinking } : {}),
            },
        ];
        // @ts-ignore - TODO: strict typing
        const modalities = computeModalities(syntheticMessages);
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
            // @ts-ignore - TODO: strict typing
            toolsUsed: toolCalls && toolCalls.length > 0,
            // @ts-ignore
            toolDisplayNames: 
            // @ts-ignore - TODO: strict typing
            toolCalls && toolCalls.length > 0
                ? [
                    ...new Set(
                    // @ts-ignore - TODO: strict typing
                    toolCalls.map(
                    // @ts-ignore
                    (tc) => API_TO_CANONICAL[tc.name] || tc.name)),
                ]
                : [],
            toolApiNames: 
            // @ts-ignore - TODO: strict typing
            toolCalls && toolCalls.length > 0
                // @ts-ignore - TODO: strict typing
                ? [...new Set(toolCalls.map((tc) => tc.name))]
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
            // @ts-ignore - TODO: strict typing
            temperature: options?.temperature ?? null,
            // @ts-ignore - TODO: strict typing
            maxTokens: options?.maxTokens ?? null,
            // @ts-ignore - TODO: strict typing
            topP: options?.topP ?? null,
            // @ts-ignore - TODO: strict typing
            topK: options?.topK ?? null,
            // @ts-ignore - TODO: strict typing
            frequencyPenalty: options?.frequencyPenalty ?? null,
            // @ts-ignore - TODO: strict typing
            presencePenalty: options?.presencePenalty ?? null,
            // @ts-ignore - TODO: strict typing
            stopSequences: options?.stopSequences ?? null,
            // @ts-ignore - TODO: strict typing
            messageCount: messages.length,
            // @ts-ignore - TODO: strict typing
            inputCharacters: messages.reduce((sum, m) => 
            // @ts-ignore - TODO: strict typing
            sum + (typeof m.content === "string" ? m.content.length : 0), 0),
            outputCharacters,
            timeToGeneration: 
            // @ts-ignore - TODO: strict typing
            timeToGenerationSec !== null ? roundMs(timeToGenerationSec) : null,
            // @ts-ignore - TODO: strict typing
            generationTime: generationSec !== null ? roundMs(generationSec) : null,
            // @ts-ignore - TODO: strict typing
            totalTime: totalSec !== null ? roundMs(totalSec) : null,
            requestPayload: {
                // @ts-ignore - TODO: strict typing
                messages: messages.map(sanitizeMsg),
                // @ts-ignore - TODO: strict typing
                ...(options?.tools
                    // @ts-ignore - TODO: strict typing
                    ? { tools: options.tools.map((t) => t.name || t.function?.name) }
                    : {}),
                ...(agenticIteration !== null ? { agenticIteration } : {}),
            },
            responsePayload: {
                text: text || null,
                thinking: thinking || null,
                // @ts-ignore - TODO: strict typing
                ...(images && images.length > 0 ? { images } : {}),
                // @ts-ignore
                toolCalls: 
                // @ts-ignore - TODO: strict typing
                toolCalls && toolCalls.length > 0
                    // @ts-ignore - TODO: strict typing
                    ? toolCalls.map((tc) => ({
                        // @ts-ignore
                        name: API_TO_CANONICAL[tc.name] || tc.name,
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
    async logBackgroundLlmCall({ requestId, endpoint, operation, project, username, agent, provider: providerName, model, traceId, agentSessionId, aiMessages, resultText, usage: apiUsage = null, success, errorMessage, requestStartMs, extraRequestPayload, extraResponsePayload, }) {
        // @ts-ignore - TODO: strict typing
        const totalSec = (performance.now() - requestStartMs) / 1000;
        // @ts-ignore - TODO: strict typing
        const inputText = aiMessages.map((m) => m.content).join("\n");
        // Prefer real API-reported usage over the ~4 chars/token heuristic.
        // The heuristic remains as fallback for callers that don't pass usage.
        const inputTokens = apiUsage
            // @ts-ignore - TODO: strict typing
            ? getTotalInputTokens(apiUsage)
            : estimateTokens(inputText);
        const outputTokens = apiUsage
            // @ts-ignore - TODO: strict typing
            ? apiUsage.outputTokens || 0
            : resultText
                // @ts-ignore - TODO: strict typing
                ? estimateTokens(resultText)
                : 0;
        // @ts-ignore - TODO: strict typing
        const cacheReadInputTokens = apiUsage?.cacheReadInputTokens || 0;
        // @ts-ignore - TODO: strict typing
        const cacheCreationInputTokens = apiUsage?.cacheCreationInputTokens || 0;
        // @ts-ignore
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[model];
        let estimatedCost = null;
        if (pricing) {
            estimatedCost = calculateTextCost(
            // @ts-ignore - TODO: strict typing
            apiUsage || { inputTokens, outputTokens }, pricing);
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
            // @ts-ignore - TODO: strict typing
            tokensPerSec: calculateTokensPerSec(outputTokens, totalSec),
            inputCharacters: inputText.length,
            totalTime: roundMs(totalSec),
            modalities: { textIn: true, textOut: true },
            requestPayload: {
                operation,
                // @ts-ignore - TODO: strict typing
                ...extraRequestPayload,
            },
            responsePayload: success
                ? {
                    // @ts-ignore - TODO: strict typing
                    textPreview: (resultText || "").slice(0, 200),
                    // @ts-ignore - TODO: strict typing
                    ...extraResponsePayload,
                }
                : { error: errorMessage },
        });
    },
};
export default RequestLogger;
//# sourceMappingURL=RequestLogger.js.map
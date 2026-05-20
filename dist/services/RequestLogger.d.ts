declare const RequestLogger: {
    /**
     * Log a text-to-text request to MongoDB (fire-and-forget).
     */
    log({ requestId, endpoint, operation, project, username, clientIp, agent, provider, model, conversationId, traceId, agentSessionId, parentAgentSessionId, toolsUsed, toolDisplayNames, toolApiNames, success, errorMessage, inputTokens, outputTokens, estimatedCost, tokensPerSec, temperature, maxTokens, topP, topK, frequencyPenalty, presencePenalty, stopSequences, messageCount, inputCharacters, outputCharacters, timeToGeneration, generationTime, totalTime, requestPayload, responsePayload, modalities, rateLimits, }: any): Promise<void>;
    /**
     * High-level utility to format and log a chat-like generation.
     * Centralizes the formatting of request payloads, telemetry, and tokens.
     */
    logChatGeneration({ requestId, endpoint, operation, project, username, clientIp, agent, provider, model, conversationId, traceId, agentSessionId, parentAgentSessionId, success, errorMessage, usage, estimatedCost, tokensPerSec, timeToGenerationSec, generationSec, totalSec, options, messages, text, thinking, images, toolCalls, outputCharacters, audioRef, agenticIteration, rateLimits, }: any): Promise<void>;
    /**
     * Log a background (non-streaming) LLM call with automatic cost estimation.
     * Centralises the identical pattern used by MemoryService, MemoryExtractor,
     * MemoryConsolidationService, and CoordinatorService for fire-and-forget
     * AI calls (extraction, consolidation, decomposition).
     *
     * Handles: estimateTokens, getPricing, calculateTextCost, calculateTokensPerSec,
     * roundMs, and calls this.log().
     */
    logBackgroundLlmCall({ requestId, endpoint, operation, project, username, agent, provider: providerName, model, traceId, agentSessionId, aiMessages, resultText, usage: apiUsage, success, errorMessage, requestStartMs, extraRequestPayload, extraResponsePayload, }: any): Promise<void>;
};
export default RequestLogger;
//# sourceMappingURL=RequestLogger.d.ts.map
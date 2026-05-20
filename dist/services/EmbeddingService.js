// @ts-ignore
import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { TYPES, getDefaultModels, getPricing } from "../config.js";
import { estimateTokens } from "../utils/CostCalculator.js";
import { ProviderError } from "../utils/errors.js";
import RequestLogger from "./RequestLogger.js";
import logger from "../utils/logger.js";
import { calculateTokensPerSec } from "../utils/math.js";
import SettingsService from "./SettingsService.js";
/** Resolve the current embedding provider + model from settings. */
async function getEmbeddingConfig() {
    return SettingsService.getMemoryModelConfig("embedding");
}
/**
 * EmbeddingService — single entry point for all embedding generation.
 *
 * Wraps the provider's `generateEmbedding()` with RequestLogger tracking,
 * ensuring both HTTP `/embed` requests and internal callers (MemoryService,
 * SystemPromptAssembler) flow through the same path.
 */
const EmbeddingService = {
    /**
     * Generate an embedding and log the request.
     *
  
  
     * @returns {Promise<{ embedding: number[], dimensions: number, provider: string, model: string }>}
     */
    async generate(content, options = {}) {
        const requestId = crypto.randomUUID();
        const requestStart = performance.now();
        // Resolve defaults from settings when no explicit provider/model given
        const embedConfig = await getEmbeddingConfig();
        // @ts-ignore
        const providerName = options.provider || embedConfig.provider;
        const resolvedModel = 
        // @ts-ignore
        options.model ||
            // @ts-ignore
            getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.[providerName] ||
            embedConfig.model;
        let result;
        let success = true;
        let errorMessage = null;
        try {
            const provider = getProvider(providerName);
            if (!provider.generateEmbedding) {
                throw new ProviderError(providerName, `Provider "${providerName}" does not support embeddings`, 400);
            }
            const providerOptions = {};
            // @ts-ignore
            if (options.taskType)
                providerOptions.taskType = options.taskType;
            // @ts-ignore
            if (options.dimensions)
                providerOptions.dimensions = options.dimensions;
            result = await provider.generateEmbedding(content, resolvedModel, providerOptions);
        }
        catch (error) {
            success = false;
            // @ts-ignore - TODO: strict typing
            errorMessage = error.message;
            throw error;
        }
        finally {
            const totalSec = (performance.now() - requestStart) / 1000;
            // Cost estimation
            // @ts-ignore
            const pricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING)[resolvedModel];
            const approxInputTokens = 
            // @ts-ignore - TODO: strict typing
            typeof content === "string" ? estimateTokens(content) : 100;
            let estimatedCost = null;
            if (pricing?.inputPerMillion) {
                estimatedCost =
                    (approxInputTokens / 1_000_000) * pricing.inputPerMillion;
            }
            // @ts-ignore
            const source = options.source || "unknown";
            // Determine input content type for payload logging
            const contentType = typeof content === "string"
                ? "text"
                : Array.isArray(content)
                    ? "multimodal"
                    : "unknown";
            const inputCharacters = typeof content === "string" ? content.length : 0;
            logger.request(
            // @ts-ignore
            options.project || null, 
            // @ts-ignore
            options.username || "system", 
            // @ts-ignore
            options.clientIp || null, `[embed] ${providerName} model=${resolvedModel} source=${source} — ` +
                (success
                    // @ts-ignore - TODO: strict typing
                    ? `dims: ${result?.dimensions}, total: ${totalSec.toFixed(2)}s`
                    : `FAILED: ${errorMessage}`) +
                formatCostTag(estimatedCost));
            RequestLogger.log({
                requestId,
                // @ts-ignore
                endpoint: options.endpoint || null,
                operation: `embed:${source}`,
                // @ts-ignore
                project: options.project || null,
                // @ts-ignore
                username: options.username || "system",
                // @ts-ignore
                clientIp: options.clientIp || null,
                // @ts-ignore
                agent: options.agent || null,
                provider: providerName,
                model: resolvedModel,
                // @ts-ignore
                traceId: options.traceId || null,
                // @ts-ignore
                agentSessionId: options.agentSessionId || null,
                success,
                errorMessage,
                estimatedCost,
                inputTokens: approxInputTokens,
                outputTokens: 0, // Embeddings produce vectors, not output tokens
                // @ts-ignore - TODO: strict typing
                tokensPerSec: calculateTokensPerSec(approxInputTokens, totalSec),
                inputCharacters,
                totalTime: roundMs(totalSec),
                modalities: (() => {
                    const mod = { embeddingOut: true };
                    if (typeof content === "string") {
                        // @ts-ignore
                        mod.textIn = true;
                    }
                    else if (Array.isArray(content)) {
                        // @ts-ignore
                        for (const part of content) {
                            // @ts-ignore
                            if (part.text)
                                mod.textIn = true;
                            const mime = part.inlineData?.mimeType || "";
                            // @ts-ignore
                            if (mime.startsWith("image/"))
                                mod.imageIn = true;
                            // @ts-ignore
                            else if (mime.startsWith("audio/"))
                                mod.audioIn = true;
                            // @ts-ignore
                            else if (mime.startsWith("video/"))
                                mod.videoIn = true;
                            // @ts-ignore
                            else if (mime === "application/pdf")
                                mod.docIn = true;
                        }
                    }
                    return mod;
                })(),
                requestPayload: {
                    source,
                    contentType,
                    // @ts-ignore
                    ...(options.taskType ? { taskType: options.taskType } : {}),
                    // @ts-ignore
                    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
                    ...(contentType === "text"
                        ? { text: typeof content === "string" ? content : "" }
                        : {}),
                },
                responsePayload: success
                    ? {
                        // @ts-ignore - TODO: strict typing
                        dimensions: result?.dimensions || null,
                        // @ts-ignore - TODO: strict typing
                        embeddingPreview: result?.embedding?.slice(0, 5) || null,
                    }
                    : { error: errorMessage },
            });
        }
        return {
            embedding: result.embedding,
            dimensions: result.dimensions,
            provider: providerName,
            model: resolvedModel,
        };
    },
    /**
     * Convenience wrapper — returns just the embedding vector.
     * Used by internal callers that only need the float array.
     *
  
  
     */
    async embed(text, options = {}) {
        // @ts-ignore - TODO: strict typing
        const result = await this.generate(text, options);
        return result.embedding;
    },
};
export default EmbeddingService;
//# sourceMappingURL=EmbeddingService.js.map
import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { TYPES, getDefaultModels, getPricing } from "../config.ts";
import { estimateTokens } from "../utils/CostCalculator.ts";
import { ProviderError } from "../utils/errors.ts";
import RequestLogger from "./RequestLogger.ts";
import logger from "../utils/logger.ts";
import { calculateTokensPerSec } from "../utils/math.ts";
import {} from "../utils/utilities.ts";
import SettingsService from "./SettingsService.ts";
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
  async generate(content: string, options: any = {}) {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    // Resolve defaults from settings when no explicit provider/model given
    const embedConfig = await getEmbeddingConfig();
        const providerName = options.provider || embedConfig.provider;
    const resolvedModel =
            options.model ||
            getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.[providerName] ||
      embedConfig.model;
    let result: any;
    let success = true;
    let errorMessage = null;
    try {
      const provider = getProvider(providerName);
      if (!provider.generateEmbedding) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support embeddings`,
          400,
        );
      }
      const providerOptions: any = {};
            if (options.taskType) providerOptions.taskType = options.taskType;
            if (options.dimensions) providerOptions.dimensions = options.dimensions;
      result = await provider.generateEmbedding(
        content,
        resolvedModel,
        providerOptions,
      );
    } catch (error: any) {
      success = false;
            errorMessage = (error as Error).message;
      throw error;
    } finally {
      const totalSec = (performance.now() - requestStart) / 1000;
      // Cost estimation
            const pricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING)[resolvedModel];
      const approxInputTokens =
                typeof content === "string" ? estimateTokens((content as any)) : 100;
      let estimatedCost = null;
      if (pricing?.inputPerMillion) {
        estimatedCost =
          (approxInputTokens / 1_000_000) * pricing.inputPerMillion;
      }
            const source = options.source || "any";
      // Determine input content type for payload logging
      const contentType =
        typeof content === "string"
          ? "text"
          : Array.isArray(content)
            ? "multimodal"
            : "any";
      const inputCharacters = typeof content === "string" ? content.length : 0;
      logger.request(
                (options.project || null as any),
                options.username || "system",
                options.clientIp || null,
        `[embed] ${providerName} model=${resolvedModel} source=${source} — ` +
          (success
                        ? `dims: ${result?.dimensions}, total: ${totalSec.toFixed(2)}s`
            : `FAILED: ${errorMessage}`) +
          formatCostTag(estimatedCost),
      );
      RequestLogger.log({
        requestId,
                endpoint: options.endpoint || null,
        operation: `embed:${source}`,
                project: options.project || null,
                username: options.username || "system",
                clientIp: options.clientIp || null,
                agent: options.agent || null,
        provider: providerName,
        model: resolvedModel,
                traceId: options.traceId || null,
                agentSessionId: options.agentSessionId || null,
        success,
        errorMessage,
        estimatedCost,
        inputTokens: approxInputTokens,
        outputTokens: 0, // Embeddings produce vectors, not output tokens
                tokensPerSec: calculateTokensPerSec((approxInputTokens as any), (totalSec as any)),
        inputCharacters,
        totalTime: roundMs(totalSec),
        modalities: (() => {
          const mod = { embeddingOut: true };
          if (typeof content === "string") {
                        (mod as any).textIn = true;
          } else if (Array.isArray(content)) {
                        // @ts-ignore - TODO: strict typing
                        for ( const part of content) {
                            if (part.text) (mod as any).textIn = true;
              const mime = part.inlineData?.mimeType || "";
                            if (mime.startsWith("image/")) (mod as any).imageIn = true;
                            else if (mime.startsWith("audio/")) (mod as any).audioIn = true;
                            else if (mime.startsWith("video/")) (mod as any).videoIn = true;
                            else if (mime === "application/pdf") (mod as any).docIn = true;
            }
          }
          return mod;
        })(),
        requestPayload: {
          source,
          contentType,
                    ...(options.taskType ? { taskType: options.taskType } : {}),
                    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
          ...(contentType === "text"
            ? { text: typeof content === "string" ? content : "" }
            : {}),
        },
        responsePayload: success
          ? {
                            dimensions: result?.dimensions || null,
                            embeddingPreview: (result?.embedding as any)?.slice(0, 5) || null,
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
  async embed(text: any, options: any = {}) {
        const result = await this.generate((text as any), options);
    return result.embedding;
  },
};
export default EmbeddingService;

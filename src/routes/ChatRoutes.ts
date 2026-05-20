// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// @ts-ignore
import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response, NextFunction } from "express";
import {
  finalizeTextGeneration,
  getCollectionOpts,
} from "../services/harnesses/lifecycle/Finalizer.ts";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { ProviderError } from "../utils/errors.ts";
import {
  TYPES,
  getDefaultModels,
  getPricing,
  getModelByName,
} from "../config.ts";
import {
  estimateTokens,
  calculateImageCost,
  mergeUsage,
} from "../utils/CostCalculator.ts";
import logger from "../utils/logger.ts";
import RequestLogger from "../services/RequestLogger.ts";
import FileService from "../services/FileService.ts";
import {
  createStreamState,
  dispatchChunk,
} from "../utils/StreamChunkDispatcher.ts";
import {
  compressImageForSizeLimit,
  constrainImageDimensions,
} from "../utils/media.ts";

import SessionGenerationTracker from "../services/SessionGenerationTracker.ts";
import ToolOrchestratorService from "../services/ToolOrchestratorService.ts";
import localModelQueue from "../services/LocalModelQueue.ts";
import LocalProviderGateway from "../services/LocalProviderGateway.ts";
import { getInstancesByType } from "../providers/instance-registry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";
import {
  markGenerating,
  appendAndFinalize,
} from "../utils/ConversationUtilities.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";

const router = express.Router();
// ─── converts refs for providers & storage ──────────────────
/**
 * Resolve image references in messages for both provider use and storage.
 *
 * Returns a deep copy of messages where all images are base64 data URLs
 * (ready for providers). The ORIGINAL messages array is mutated in-place
 * so that images are stored as minio:// refs (for conversation storage).
 *
 * Handles:
 *  - data:... base64  → upload to MinIO (original gets minio ref), provider gets data URL
 *  - minio://...       → download from MinIO (original unchanged), provider gets data URL
 *  - http(s)://...     → fetch (original unchanged), provider gets data URL
 */
async function resolveImageRefs(messages: Record<string, unknown>, project: Record<string, unknown>, username: string) {
  // Deep copy for the provider — images will be data URLs
  // @ts-ignore - TODO: strict typing
  const providerMessages = messages.map((m: Record<string, unknown>) => ({ ...m }));
  // @ts-ignore - TODO: strict typing
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // ── Resolve media array fields: images, audio, video, pdf ──
    // @ts-ignore
    for ( const field of ["images", "audio", "video", "pdf"]) {
      // @ts-ignore - TODO: strict typing
      const array = message[field];
      if (array && Array.isArray(array) && array.length > 0) {
        // @ts-ignore
        const providerArr: Record<string, unknown>[] = [];
        // @ts-ignore
        const storageArr: Record<string, unknown>[] = [];
        await Promise.all(
          // @ts-ignore - TODO: strict typing
          array.map(async (ref: Record<string, unknown>, j: Record<string, unknown>) => {
            const resolved = await resolveMediaRef(ref, project, username);
            // @ts-ignore - TODO: strict typing
            providerArr[j] = resolved.providerRef;
            // @ts-ignore - TODO: strict typing
            storageArr[j] = resolved.storageRef;
          }),
        );
        // @ts-ignore
        providerMessages[i][field] = providerArr;
        // @ts-ignore
        messages[i][field] = storageArr;
      }
    }
  }
  return providerMessages;
}
/**
 * Compress an oversized image data URL in-place.
 * Parses the data URL, checks decoded size, runs through compressImageForSizeLimit,
 * and reconstructs if compression changed the data.

 * @returns {Promise<string>} - Possibly compressed data URL
 */
async function compressDataUrlIfOversized(dataUrl: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return dataUrl;
  let mimeType = match[1];
  if (!mimeType.startsWith("image/")) return dataUrl;
  let base64Data = match[2];
  // Step 1: enforce pixel dimension limits (Anthropic rejects >8000px)
  try {
    const dimResult = await constrainImageDimensions(base64Data, mimeType);
    if (dimResult.data !== base64Data) {
      base64Data = dimResult.data;
      mimeType = dimResult.mediaType;
      logger.info(
        `[chat] Dimension-constrained image: now ${(base64Data.length / 1024 / 1024).toFixed(2)} MB b64 (${mimeType})`,
      );
    }
  } catch (error: unknown) {
    // @ts-ignore - TODO: strict typing
    logger.warn(`[chat] Dimension constraint failed: ${error.message}`);
  }
  // Step 2: enforce byte-size limit
  const b64Len = base64Data.length; // Anthropic checks base64 STRING length
  const MAX = 5 * 1024 * 1024;
  if (b64Len <= MAX) {
    // Dimensions may have changed even if size is fine — rebuild URL
    return `data:${mimeType};base64,${base64Data}`;
  }
  logger.info(
    `[chat] Oversized image detected: ${(b64Len / 1024 / 1024).toFixed(2)} MB b64 (${mimeType}). Compressing...`,
  );
  try {
    const result = await compressImageForSizeLimit(base64Data, mimeType);
    const newUrl = `data:${result.mediaType};base64,${result.data}`;
    const newLen = result.data.length;
    logger.info(
      `[chat] Compressed: ${(b64Len / 1024 / 1024).toFixed(2)} MB → ${(newLen / 1024 / 1024).toFixed(2)} MB b64 (${result.mediaType})`,
    );
    return newUrl;
  } catch (error: unknown) {
    logger.error(
      // @ts-ignore - TODO: strict typing
      `[chat] Image compression failed: ${error.message}. Sending original.`,
    );
    return `data:${mimeType};base64,${base64Data}`;
  }
}
/**
 * Resolve a single media reference for both provider and storage use.
 * @returns {{ providerRef: string, storageRef: string }}
 */
async function resolveMediaRef(ref: Record<string, unknown>, project: Record<string, unknown>, username: string) {
  // Already a base64 data URL — compress if oversized, upload to MinIO for storage
  // @ts-ignore - TODO: strict typing
  if (ref.startsWith("data:")) {
    let providerRef = ref;
    // Compress oversized images before they reach any provider
    // @ts-ignore - TODO: strict typing
    providerRef = await compressDataUrlIfOversized(providerRef);
    let storageRef = providerRef;
    try {
      const { ref: minioRef } = await FileService.uploadFile(
        // @ts-ignore - TODO: strict typing
        ref, // Upload original to MinIO
        "uploads",
        project,
        username,
      );
      // @ts-ignore - TODO: strict typing
      storageRef = minioRef;
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`[chat] Failed to upload media to MinIO: ${error.message}`);
    }
    return { providerRef, storageRef };
  }
  // MinIO reference — download for provider, keep ref for storage
  if (FileService.isMinioRef(ref)) {
    try {
      const key = FileService.extractKey(ref);
      const file = await FileService.getFile(key);
      if (!file) {
        logger.warn(`[chat] Could not resolve MinIO ref: ${ref}`);
        return { providerRef: ref, storageRef: ref };
      }
      const chunks: Record<string, unknown>[] = [];
      // @ts-ignore
      for await ( const chunk of file.stream) {
        chunks.push(chunk);
      }
      // @ts-ignore - TODO: strict typing
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString("base64");
      let providerRef = `data:${file.contentType};base64,${base64}`;
      // Constrain dimensions + compress oversized images before they reach any provider
      // @ts-ignore - TODO: strict typing
      providerRef = await compressDataUrlIfOversized(providerRef);
      return {
        providerRef,
        storageRef: ref,
      };
    } catch (error: unknown) {
      logger.error(
        // @ts-ignore - TODO: strict typing
        `[chat] Failed to resolve MinIO ref ${ref}: ${error.message}`,
      );
      return { providerRef: ref, storageRef: ref };
    }
  }
  // HTTP(S) URL — fetch for provider, keep URL for storage
  // @ts-ignore - TODO: strict typing
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    try {
      // @ts-ignore - TODO: strict typing
      const response = await fetch(ref);
      if (!response.ok) {
        logger.warn(
          `[chat] Failed to fetch media URL (${response.status}): ${ref}`,
        );
        return { providerRef: ref, storageRef: ref };
      }
      const contentType =
        response.headers.get("content-type") || "application/octet-stream";
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      let providerRef = `data:${contentType};base64,${base64}`;
      // Compress oversized images before they reach any provider
      // @ts-ignore - TODO: strict typing
      providerRef = await compressDataUrlIfOversized(providerRef);
      return {
        providerRef,
        storageRef: ref,
      };
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`[chat] Failed to fetch media URL ${ref}: ${error.message}`);
      return { providerRef: ref, storageRef: ref };
    }
  }
  // Unknown — pass through
  return { providerRef: ref, storageRef: ref };
}
// ─── parameter parsing, validation, model resolution ────────
/**
 * Parse and validate incoming request parameters, resolve images,
 * model, and acquire GPU lock if needed.
 *
 * Returns a prepared context object shared by handleConversation
 * and handleAgent, or throws on validation failure.
 *
 * @param {Object}   params   Raw request parameters
 * @param {Function} emit     Event emitter callback


 * @returns {Promise<Object>} Prepared generation context
 */
// @ts-ignore
async function prepareGenerationContext(
  params: Record<string, unknown>,
  emit: Record<string, unknown>,
  // @ts-ignore
  { signal }: Record<string, unknown> = {},
) {
  const requestStart = performance.now();
  const requestId = crypto.randomUUID();
  const {
    provider: _providerName,
    model: requestedModel,
    messages,
    conversationId: incomingConversationId,
    agentSessionId: incomingAgentSessionId,
    conversationMeta: incomingConversationMeta,
    traceId: incomingTraceId,
    project = "unknown",
    username = "unknown",
    clientIp = null,
    agent = null,
    // Generation options — flat at top-level (OpenAI-style)
    tools,
    temperature,
    maxTokens,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    seed,
    minP,
    repeatPenalty,
    thinkingEnabled,
    reasoningEffort,
    thinkingLevel,
    thinkingBudget,
    webSearch,
    webFetch,
    codeExecution,
    urlContext,
    verbosity,
    reasoningSummary,
    functionCallingEnabled,
    agenticLoopEnabled,
    enabledTools,
    disabledBuiltIns,
    minContextLength,
    forceImageGeneration,
    responseFormat,
    serviceTier,
    textOnly,
    skipConversation,
    autoApprove,
    planFirst,
    maxIterations,
    maxWorkerIterations,
    agentContext,
    // Multi-workspace: user-selected workspace root path (absolute fs path).
    // Flows from x-workspace-root header → AuthMiddleware → agent route → here.
    workspaceRoot,
    ...extraParams
  } = params;
  let providerName = _providerName;
  // Build the internal options object that providers expect
  const options = {
    // @ts-ignore - TODO: strict typing
    ...(tools && { tools }),
    ...(temperature !== undefined && { temperature }),
    ...(maxTokens !== undefined && { maxTokens }),
    ...(topP !== undefined && { topP }),
    ...(topK !== undefined && { topK }),
    ...(frequencyPenalty !== undefined && { frequencyPenalty }),
    ...(presencePenalty !== undefined && { presencePenalty }),
    // @ts-ignore - TODO: strict typing
    ...(stopSequences && { stopSequences }),
    ...(seed !== undefined && seed !== "" && { seed }),
    ...(minP !== undefined && { minP }),
    ...(repeatPenalty !== undefined && { repeatPenalty }),
    ...(thinkingEnabled !== undefined && { thinkingEnabled }),
    // @ts-ignore - TODO: strict typing
    ...(reasoningEffort && { reasoningEffort }),
    // @ts-ignore - TODO: strict typing
    ...(thinkingLevel && { thinkingLevel }),
    // @ts-ignore - TODO: strict typing
    ...(thinkingBudget && { thinkingBudget }),
    // @ts-ignore - TODO: strict typing
    ...(webSearch && { webSearch }),
    // @ts-ignore - TODO: strict typing
    ...(webFetch && { webFetch }),
    // @ts-ignore - TODO: strict typing
    ...(codeExecution && { codeExecution }),
    // @ts-ignore - TODO: strict typing
    ...(urlContext && { urlContext }),
    // @ts-ignore - TODO: strict typing
    ...(verbosity && { verbosity }),
    // @ts-ignore - TODO: strict typing
    ...(reasoningSummary && { reasoningSummary }),
    ...(functionCallingEnabled !== undefined && { functionCallingEnabled }),
    ...(agenticLoopEnabled !== undefined && { agenticLoopEnabled }),
    // @ts-ignore - TODO: strict typing
    ...(enabledTools && { enabledTools }),
    // @ts-ignore - TODO: strict typing
    ...(disabledBuiltIns && { disabledBuiltIns }),
    // @ts-ignore - TODO: strict typing
    ...(minContextLength && { minContextLength }),
    // @ts-ignore - TODO: strict typing
    ...(forceImageGeneration && { forceImageGeneration }),
    // @ts-ignore - TODO: strict typing
    ...(responseFormat && { responseFormat }),
    // @ts-ignore - TODO: strict typing
    ...(serviceTier && { serviceTier }),
    // @ts-ignore - TODO: strict typing
    ...(textOnly && { textOnly }),
    // @ts-ignore - TODO: strict typing
    ...(autoApprove && { autoApprove }),
    // @ts-ignore - TODO: strict typing
    ...(planFirst && { planFirst }),
    ...(maxIterations !== undefined && { maxIterations }),
    ...(maxWorkerIterations !== undefined && { maxWorkerIterations }),
    // @ts-ignore - TODO: strict typing
    ...(agentContext && { agentContext }),
    // @ts-ignore - TODO: strict typing
    ...(extraParams.systemPrompt && { systemPrompt: extraParams.systemPrompt }),
  };
  // When thinking is explicitly disabled, strip all thinking sub-params
  // so providers don't inadvertently enable thinking by detecting them.
  if (thinkingEnabled === false) {
    delete options.reasoningEffort;
    delete options.thinkingLevel;
    delete options.thinkingBudget;
  }
  // Local models emit thinking tokens (<think> tags) by default. Default
  // thinkingEnabled ON only when the client didn't send a value (undefined).
  // When the client explicitly sends false (thinking toggle off), respect it
  // — models can use tools without thinking.
  // @ts-ignore - TODO: strict typing
  LocalProviderGateway.applyLocalDefaults(providerName, options, {
    thinkingEnabled,
  });
  // ── Validation ──────────────────────────────────────────────
  if (!providerName) {
    throw new ProviderError("server", "Missing required field: provider", 400);
  }
  if (!messages || !Array.isArray(messages)) {
    throw new ProviderError(
      "server",
      "Missing or invalid field: messages (must be an array)",
      400,
    );
  }
  // ── Strip soft-deleted messages ──────────────────────────────
  const activeMessages = messages.filter((m: Record<string, unknown>) => !m.deleted);
  // ── Resolve image refs ─────────────────────────────────────
  const providerMessages = await resolveImageRefs(
    // @ts-ignore - TODO: strict typing
    activeMessages,
    project,
    username,
  );
  // ── Multi-instance load balancing ─────────────────────────
  // When the caller sends a base provider type (e.g. "lm-studio") and
  // multiple instances are registered, verify the model is available on
  // each instance (with quant-level fallback) and pick the least-busy
  // usable instance. Same model resolution logic as CoordinatorService.
  let resolvedModel =
    // @ts-ignore
    requestedModel || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName];
  // @ts-ignore - TODO: strict typing
  if (localModelQueue.isLocal(providerName)) {
    // @ts-ignore - TODO: strict typing
    let siblings = getInstancesByType(providerName);
    // ── Model resolution (always) ──────────────────────────────
    // Resolve model availability across instances with quant-level
    // fallback. Also handles @quant syntax (e.g. "qwen3-32b@q4_k_m")
    // by mapping it to the actual LM Studio model key.
    const { usable, modelOverrides } = await resolveModelForInstances(
      resolvedModel,
      // @ts-ignore - TODO: strict typing
      siblings,
    );
    // @ts-ignore - TODO: strict typing
    if (usable.length > 0) {
      // @ts-ignore - TODO: strict typing
      siblings = usable;
      // For single instance, apply model override directly
      if (siblings.length === 1) {
        const override = modelOverrides.get(siblings[0].id);
        if (override) {
          resolvedModel = override;
          logger.info(
            `[chat] Model resolved: "${requestedModel}" → "${resolvedModel}" (single instance)`,
          );
        }
      }
    } else {
      logger.warn(
        `[chat] Model "${resolvedModel}" not available on any ${providerName} instance — falling back to first`,
      );
    }
    // ── Multi-instance load balancing ──────────────────────────
    if (siblings.length > 1) {
      // Least-busy: pick the instance with the most available slots
      let bestId = providerName;
      let bestAvailable = -Infinity;
      // @ts-ignore
      for ( const inst of siblings) {
        // @ts-ignore - TODO: strict typing
        const queueState = localModelQueue._getQueue(inst.id);
        const available = inst.concurrency - queueState.activeCount;
        if (available > bestAvailable) {
          bestAvailable = available;
          bestId = inst.id;
        }
      }
      if (bestId !== providerName) {
        // Apply model override if this instance uses a different quant
        const modelOverride = modelOverrides.get(bestId);
        if (modelOverride) {
          resolvedModel = modelOverride;
        }
        logger.info(
          `[chat] ⚖️ Load balance: ${providerName} → ${bestId} ` +
            // @ts-ignore - TODO: strict typing
            `(model="${resolvedModel}", ${siblings.map((s: Record<string, unknown>) => `${s.id}:${s.concurrency - localModelQueue._getQueue(s.id).activeCount}free`).join(", ")})`,
        );
        providerName = bestId;
      }
    }
  }
  // @ts-ignore - TODO: strict typing
  const provider = getProvider(providerName);
  // ── Resolve model ─────────────────────────────────────────
  // resolvedModel is set earlier (before load balancing) and may have
  // been updated to a quant variant by the model availability check.
  const modelDef = getModelByName(resolvedModel);
  // @ts-ignore
  const isImageAPIModel = modelDef?.imageAPI && provider.generateImage;
  // ── Local GPU mutex ──────────────────────────────────────
  let localRelease: Record<string, unknown>;
  // @ts-ignore - TODO: strict typing
  if (localModelQueue.isLocal(providerName)) {
    // @ts-ignore - TODO: strict typing
    localRelease = await localModelQueue.acquire(providerName);
    // @ts-ignore - TODO: strict typing
    const queueState = localModelQueue._getQueue(providerName);
    logger.info(
      `[chat] 🔒 Acquired local GPU slot for ${resolvedModel} (${providerName}) ` +
        `(${queueState.activeCount}/${queueState.maxConcurrency} active` +
        (queueState.pending > 0 ? `, ${queueState.pending} queued)` : ")"),
    );
  }
  // Derive userMessage from the last user message
  const userMessage =
    messages?.filter((m: Record<string, unknown>) => m.role === "user").pop() || null;
  return {
    provider,
    providerName,
    resolvedModel,
    requestedModel,
    modelDef,
    isImageAPIModel,
    messages: providerMessages,
    originalMessages: activeMessages,
    rawMessages: messages,
    options,
    userMessage,
    // Identity
    incomingConversationId,
    incomingAgentSessionId,
    incomingConversationMeta,
    incomingTraceId,
    skipConversation,
    project,
    username,
    clientIp,
    agent,
    // Multi-workspace
    workspaceRoot: workspaceRoot || null,
    // Timing
    requestStart,
    requestId,
    // Control
    emit,
    signal,
    // @ts-ignore - TODO: strict typing
    localRelease,
  };
}
// ─── Chat / Conversation persistence path ───────────────────
/**
 * Handle a conversation request: text generation, image generation,
 * vision/captioning — with conversationId-based persistence.
 *
 * Used by the /chat route and any non-agent callers.
 */
// @ts-ignore
export async function handleConversation(
  params: Record<string, unknown>,
  emit: Record<string, unknown>,
  // @ts-ignore
  { signal }: Record<string, unknown> = {},
) {
  let context: Record<string, unknown>;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: unknown) {
    // @ts-ignore - TODO: strict typing
    emit({ type: "error", message: error.message });
    return;
  }
  const {
    providerName,
    resolvedModel,
    requestedModel,
    options,
    incomingConversationId,
    incomingConversationMeta,
    incomingTraceId,
    skipConversation,
    project,
    username,
    clientIp,
    requestStart,
    requestId,
    localRelease,
  } = context;
  // ── Conversation identity ──────────────────────────────────
  let conversationId = skipConversation ? null : incomingConversationId;
  let conversationMeta = skipConversation ? null : incomingConversationMeta;
  if (!skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    const firstUserMsg = context.rawMessages
      // @ts-ignore - TODO: strict typing
      ?.filter((m: Record<string, unknown>) => m.role === "user")
      .pop();
    const titleSnippet =
      (firstUserMsg?.content || "").slice(0, 100).trim() || "New Conversation";
    conversationMeta = conversationMeta || { title: titleSnippet };
  }
  const traceId = incomingTraceId || null;
  if (traceId && conversationMeta) {
    // @ts-ignore - TODO: strict typing
    conversationMeta.traceId = traceId;
  } else if (traceId) {
    conversationMeta = { traceId };
  }
  // Merge conversation identity into ctx for sub-handlers
  const fullCtx = { ...context, conversationId, conversationMeta, traceId };
  try {
    try {
      if (context.isImageAPIModel) {
        await handleImageAPIModel(fullCtx);
        return;
      }
      // @ts-ignore - TODO: strict typing
      if (!context.provider.generateTextStream && !context.provider.generateText) {
        throw new ProviderError(
          // @ts-ignore - TODO: strict typing
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      const useStreaming =
        // @ts-ignore - TODO: strict typing
        context.provider.generateTextStream && context.modelDef?.streaming !== false;
      if (useStreaming) {
        // Native MCP tool execution — provider handles tool calling internally
        const useNativeMcp =
          // @ts-ignore - TODO: strict typing
          LocalProviderGateway.isNativeMCP(providerName) &&
          // @ts-ignore - TODO: strict typing
          !options.agenticLoopEnabled;
        // @ts-ignore - TODO: strict typing
        if (useNativeMcp && options.functionCallingEnabled) {
          const builtInTools = ToolOrchestratorService.getToolSchemas();
          let tools = builtInTools;
          // @ts-ignore - TODO: strict typing
          if (options.enabledTools && Array.isArray(options.enabledTools)) {
            // @ts-ignore - TODO: strict typing
            const enabledSet = new Set(options.enabledTools);
            // @ts-ignore - TODO: strict typing
            tools = tools.filter((t: Record<string, unknown>) => enabledSet.has(t.name));
          } else if (
            // @ts-ignore - TODO: strict typing
            options.disabledBuiltIns &&
            // @ts-ignore - TODO: strict typing
            Array.isArray(options.disabledBuiltIns)
          ) {
            // @ts-ignore - TODO: strict typing
            const disabledSet = new Set(options.disabledBuiltIns);
            // @ts-ignore - TODO: strict typing
            tools = tools.filter((t: Record<string, unknown>) => !disabledSet.has(t.name));
          }
          // @ts-ignore - TODO: strict typing
          options.tools = tools;
          // @ts-ignore - TODO: strict typing
          if (context.modelDef?.contextLength) {
            // @ts-ignore - TODO: strict typing
            options.contextLength = context.modelDef.contextLength;
          }
          logger.info(
            // @ts-ignore - TODO: strict typing
            `[chat] Native MCP (${providerName}): ${tools.length} tools enabled, enabledTools=${(options.enabledTools || []).length}, builtIn=${builtInTools.length}, contextLength=${options.contextLength || "unset"}`,
          );
        } else if (useNativeMcp) {
          logger.warn(
            // @ts-ignore - TODO: strict typing
            `[chat] Native MCP SKIPPED (${providerName}): functionCallingEnabled=${options.functionCallingEnabled}, useNativeMcp=${useNativeMcp}`,
          );
        }
        // Non-LM-Studio FC on /chat path
        if (
          !useNativeMcp &&
          // @ts-ignore - TODO: strict typing
          !options.agenticLoopEnabled &&
          // @ts-ignore - TODO: strict typing
          options.functionCallingEnabled
        ) {
          const builtInTools = ToolOrchestratorService.getToolSchemas();
          let tools = builtInTools;
          // @ts-ignore - TODO: strict typing
          if (options.enabledTools && Array.isArray(options.enabledTools)) {
            // @ts-ignore - TODO: strict typing
            const enabledSet = new Set(options.enabledTools);
            // @ts-ignore - TODO: strict typing
            tools = tools.filter((t: Record<string, unknown>) => enabledSet.has(t.name));
          } else if (
            // @ts-ignore - TODO: strict typing
            options.disabledBuiltIns &&
            // @ts-ignore - TODO: strict typing
            Array.isArray(options.disabledBuiltIns)
          ) {
            // @ts-ignore - TODO: strict typing
            const disabledSet = new Set(options.disabledBuiltIns);
            // @ts-ignore - TODO: strict typing
            tools = tools.filter((t: Record<string, unknown>) => !disabledSet.has(t.name));
          }
          // @ts-ignore - TODO: strict typing
          options.tools = tools;
          logger.info(
            `[chat] FC tools injected: ${tools.length} tools enabled for ${providerName} ${resolvedModel}`,
          );
        }
        await handleStreamingText(fullCtx);
      } else {
        await handleNonStreamingText(fullCtx);
      }
    } finally {
      if (localRelease) {
        // @ts-ignore - TODO: strict typing
        localRelease();
        logger.info(`[chat] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
    }
  } catch (error: unknown) {
    markGenerating(
      // @ts-ignore - TODO: strict typing
      conversationId,
      project,
      username,
      false,
      // @ts-ignore - TODO: strict typing
      getCollectionOpts(project),
    );
    // @ts-ignore - TODO: strict typing
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: "/chat",
      operation: "chat",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel || requestedModel || "unknown",
      conversationId: conversationId || null,
      traceId: traceId || null,
      success: false,
      // @ts-ignore - TODO: strict typing
      errorMessage: error.message,
      totalSec,
      messages: context.rawMessages || [],
      options: {},
    });
    // @ts-ignore - TODO: strict typing
    emit({ type: "error", message: error.message });
  }
}
// ─── Agent session path (agentSessionId, no conversationId) ─
/**
 * Handle an agent request: always dispatches to AgenticLoopService.
 * Persistence uses agentSessionId (not conversationId).
 *
 * Used exclusively by the /agent route.
 */
// @ts-ignore
export async function handleAgent(params: Record<string, unknown>, emit: Record<string, unknown>, { signal }: Record<string, unknown> = {}) {
  let context: Record<string, unknown>;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: unknown) {
    // @ts-ignore - TODO: strict typing
    emit({ type: "error", message: error.message });
    return;
  }
  const {
    providerName,
    resolvedModel,
    requestedModel,
    options,
    incomingConversationId,
    incomingAgentSessionId,
    incomingConversationMeta,
    incomingTraceId,
    project,
    username,
    clientIp,
    agent,
    requestStart,
    requestId,
    localRelease,
  } = context;
  // ── Agent session identity ─────────────────────────────────
  const agentSessionId =
    incomingAgentSessionId || incomingConversationId || crypto.randomUUID();
  const traceId = incomingTraceId || null;
  const conversationMeta = incomingConversationMeta || null;
  // ── Eager session stub ───────────────────────────────────────
  // Create the session document immediately via upsert so that
  // GET /agent-sessions/:id never 404s while the loop is running
  // (e.g. when the user switches away and back during generation).
  markGenerating(
    // @ts-ignore - TODO: strict typing
    agentSessionId,
    project,
    username,
    true,
    // @ts-ignore - TODO: strict typing
    { ...getCollectionOpts(project), agent },
  );
  try {
    try {
      // @ts-ignore - TODO: strict typing
      if (!context.provider.generateTextStream && !context.provider.generateText) {
        throw new ProviderError(
          // @ts-ignore - TODO: strict typing
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      const { default: AgenticLoopService } =
        await import("../services/AgenticLoopService.js");
      await AgenticLoopService.runAgenticLoop({
        // @ts-ignore - TODO: strict typing
        provider: context.provider,
        // @ts-ignore - TODO: strict typing
        providerName,
        // @ts-ignore - TODO: strict typing
        resolvedModel,
        // @ts-ignore - TODO: strict typing
        modelDef: context.modelDef,
        // @ts-ignore - TODO: strict typing
        messages: context.messages,
        // @ts-ignore - TODO: strict typing
        originalMessages: context.originalMessages,
        // @ts-ignore - TODO: strict typing
        options,
        // @ts-ignore - TODO: strict typing
        agentSessionId,
        // @ts-ignore - TODO: strict typing
        userMessage: context.userMessage,
        // @ts-ignore - TODO: strict typing
        conversationMeta,
        // @ts-ignore - TODO: strict typing
        traceId,
        // @ts-ignore - TODO: strict typing
        project,
        // @ts-ignore - TODO: strict typing
        username,
        // @ts-ignore - TODO: strict typing
        clientIp,
        // @ts-ignore - TODO: strict typing
        agent,
        // @ts-ignore - TODO: strict typing
        workspaceRoot: context.workspaceRoot,
        // @ts-ignore - TODO: strict typing
        requestId,
        // @ts-ignore - TODO: strict typing
        requestStart,
        // @ts-ignore - TODO: strict typing
        emit,
        // @ts-ignore - TODO: strict typing
        signal,
      });
    } finally {
      if (localRelease) {
        // @ts-ignore - TODO: strict typing
        localRelease();
        logger.info(`[agent] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
      // When the SSE connection is severed (user pressed stop), abort any
      // spawned workers that are still running under this coordinator session.
      // @ts-ignore - TODO: strict typing
      if (signal?.aborted) {
        try {
          const { default: CoordinatorService } =
            await import("../services/CoordinatorService.js");
          // @ts-ignore - TODO: strict typing
          await CoordinatorService.abortWorkersBySession(agentSessionId);
        } catch (cleanupErr: unknown) {
          // @ts-ignore - TODO: strict typing
          logger.warn(`[agent] Worker cleanup failed: ${cleanupErr.message}`);
        }
      }
    }
  } catch (error: unknown) {
    markGenerating(
      // @ts-ignore - TODO: strict typing
      agentSessionId,
      project,
      username,
      false,
      // @ts-ignore - TODO: strict typing
      getCollectionOpts(project),
    );
    // @ts-ignore - TODO: strict typing
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: "/agent",
      operation: "agent",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel || requestedModel || "unknown",
      agentSessionId,
      traceId: traceId || null,
      success: false,
      // @ts-ignore - TODO: strict typing
      errorMessage: error.message,
      totalSec,
      messages: context.rawMessages || [],
      options: {},
    });
    // @ts-ignore - TODO: strict typing
    emit({ type: "error", message: error.message });
  }
}
// ─── Dispatch: Image API models (e.g. GPT Image 1.5, OpenAI images) ─
async function handleImageAPIModel(context: Record<string, unknown>) {
  const {
    provider,
    providerName,
    resolvedModel,
    modelDef,
    messages,
    options,
    conversationId,
    userMessage,
    conversationMeta,
    traceId,
    project,
    username,
    clientIp,
    requestId,
    requestStart,
    emit,
  } = context;
  // Mark conversation as generating
  markGenerating(
    // @ts-ignore - TODO: strict typing
    conversationId,
    project,
    username,
    true,
    // @ts-ignore - TODO: strict typing
    getCollectionOpts(project),
  );
  // @ts-ignore - TODO: strict typing
  const lastUserMsg = messages.filter((m: Record<string, unknown>) => m.role === "user").pop();
  const prompt = lastUserMsg?.content || "";
  // Collect all images from the conversation
  const allImages: Record<string, unknown>[] = [];
  // @ts-ignore
  for ( const message of messages) {
    if (message.images && message.images.length > 0) {
      allImages.push(...message.images);
    }
  }
  // @ts-ignore - TODO: strict typing
  const result = await provider.generateImage(
    prompt,
    allImages,
    resolvedModel,
    // @ts-ignore - TODO: strict typing
    options?.systemPrompt,
  );
  // @ts-ignore - TODO: strict typing
  const totalSec = (performance.now() - requestStart) / 1000;
  // Cost calculation
  const imgPricing =
    // @ts-ignore
    getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel] || modelDef?.pricing;
  const outputImgTokens =
    // @ts-ignore - TODO: strict typing
    modelDef?.imageTokensPerImage || (providerName === "openai" ? 1056 : 1120);
  const estimatedCost = calculateImageCost(
    prompt,
    imgPricing,
    // @ts-ignore - TODO: strict typing
    allImages.length,
    outputImgTokens,
  );
  logger.request(
    // @ts-ignore - TODO: strict typing
    project,
    username,
    clientIp,
    `[chat/image-api] ${providerName} ${resolvedModel} — ` +
      `total: ${totalSec.toFixed(2)}s` +
      formatCostTag(estimatedCost),
  );
  // Upload generated image to MinIO
  let minioRef = null;
  if (result.imageData) {
    try {
      const mimeType = result.mimeType || "image/png";
      const dataUrl = `data:${mimeType};base64,${result.imageData}`;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        "generations",
        // @ts-ignore - TODO: strict typing
        project,
        username,
      );
      minioRef = ref;
    } catch (uploadErr: unknown) {
      logger.error(
        // @ts-ignore - TODO: strict typing
        `[chat/image-api] MinIO upload failed: ${uploadErr.message}`,
      );
    }
  }
  // Estimate token counts for tracking
  const estimatedInputTokens =
    estimateTokens(prompt) +
    // @ts-ignore - TODO: strict typing
    allImages.length * (modelDef?.imageTokensPerImage || 1120);
  RequestLogger.log({
    requestId,
    endpoint: "/chat",
    operation: "chat:image",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel,
    conversationId: conversationId || null,
    traceId: traceId || null,
    success: true,
    inputTokens: estimatedInputTokens,
    outputTokens: outputImgTokens,
    inputCharacters: prompt.length,
    outputCharacters: result.text ? result.text.length : 0,
    estimatedCost,
    totalTime: roundMs(totalSec),
  });
  // Emit events
  if (result.text) {
    // @ts-ignore - TODO: strict typing
    emit({ type: "chunk", content: result.text });
  }
  // @ts-ignore - TODO: strict typing
  emit({
    type: "image",
    data: result.imageData,
    mimeType: result.mimeType || "image/png",
    minioRef,
  });
  // @ts-ignore - TODO: strict typing
  emit({
    type: "done",
    usage: result.usage || null,
    estimatedCost,
    totalTime: totalSec,
    // @ts-ignore - TODO: strict typing
    ...(traceId && { traceId }),
    // @ts-ignore - TODO: strict typing
    ...(conversationId && { conversationId }),
  });
  // Link conversation to session
  // Auto-append to conversation
  if (conversationId) {
    const messagesToAppend: Record<string, unknown>[] = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        role: "user",
        ...userMessage,
        // @ts-ignore - TODO: strict typing
        timestamp: userMessage.timestamp || new Date().toISOString(),
      });
    }
    const assistantImages = minioRef ? [minioRef] : [];
    messagesToAppend.push({
      role: "assistant",
      content: result.text || "",
      ...(assistantImages.length > 0 && { images: assistantImages }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      totalTime: roundMs(totalSec),
      estimatedCost,
    });
    const meta = conversationMeta
      ? {
          ...conversationMeta,
          settings: { provider: providerName, model: resolvedModel },
        }
      : undefined;
    appendAndFinalize(
      // @ts-ignore - TODO: strict typing
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
      // @ts-ignore - TODO: strict typing
      getCollectionOpts(project),
    );
  }
}
// ─── Post-generation finalization ────────────────────────────
// Moved to src/services/harnesses/lifecycle/Finalizer.ts
// Imported at the top of this file via:
//   import { finalizeTextGeneration, getCollectionOpts } from "../services/harnesses/lifecycle/Finalizer.ts";

async function handleStreamingText(context: Record<string, unknown>) {
  const {
    provider,
    providerName,
    resolvedModel,
    modelDef,
    messages,
    options,
    conversationId,
    project,
    username,
    requestStart,
    emit,
    signal,
  } = context;
  // Mark conversation as generating
  markGenerating(
    // @ts-ignore - TODO: strict typing
    conversationId,
    project,
    username,
    true,
    // @ts-ignore - TODO: strict typing
    getCollectionOpts(project),
  );
  const stream =
    // @ts-ignore - TODO: strict typing
    modelDef?.liveAPI && provider.generateTextStreamLive
      // @ts-ignore - TODO: strict typing
      ? provider.generateTextStreamLive(messages, resolvedModel, {
          // @ts-ignore - TODO: strict typing
          ...options,
          signal,
        })
      // @ts-ignore - TODO: strict typing
      : provider.generateTextStream(messages, resolvedModel, {
          // @ts-ignore - TODO: strict typing
          ...options,
          signal,
        });
  const ss = createStreamState();
  // @ts-ignore - TODO: strict typing
  ss.requestStart = requestStart;
  // @ts-ignore
  for await ( const chunk of stream) {
    // Client disconnected — abort the upstream provider stream
    // @ts-ignore - TODO: strict typing
    if (signal?.aborted) {
      if (typeof stream.return === "function") stream.return();
      logger.info(
        `[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`,
      );
      break;
    }
    await dispatchChunk(
      chunk,
      ss,
      { emit, project, username },
      { logPrefix: "chat/stream" },
    );
  }
  // ── FC tool execution loop ─────────────────────────────────
  // When functionCallingEnabled is set on /chat (not the agentic loop),
  // execute returned tool calls via ToolOrchestratorService and re-call
  // the provider with tool results. Lightweight loop — no approval
  // engine, no context manager, just direct execution.
  const MAX_FC_ITERATIONS = 10;
  let fcIteration = 0;
  while (
    // @ts-ignore - TODO: strict typing
    options.functionCallingEnabled &&
    ss.toolCalls.length > 0 &&
    ss.toolCalls.some(
      (tc: Record<string, unknown>) => !tc.result && tc.status !== "done" && tc.status !== "error",
    ) &&
    fcIteration < MAX_FC_ITERATIONS &&
    // @ts-ignore - TODO: strict typing
    !signal?.aborted
  ) {
    fcIteration++;
    const pendingCalls = ss.toolCalls.filter(
      (tc: Record<string, unknown>) => !tc.result && tc.status !== "done" && tc.status !== "error",
    );
    if (pendingCalls.length === 0) break;
    logger.info(
      `[chat/FC] Iteration ${fcIteration}: executing ${pendingCalls.length} tool call(s)`,
    );
    // Execute all pending tool calls
    // @ts-ignore
    for ( const tc of pendingCalls) {
      // @ts-ignore
      emit({
        type: "toolCall",
        // @ts-ignore
        id: tc.id,
        // @ts-ignore
        name: tc.name,
        // @ts-ignore
        args: tc.args,
        status: "calling",
      });
      try {
        // @ts-ignore
        const result = await ToolOrchestratorService.executeTool(
          // @ts-ignore
          tc.name,
          // @ts-ignore
          tc.args,
          { project, username },
        );
        // @ts-ignore
        tc.result = result;
        // @ts-ignore
        tc.status = result?.error ? "error" : "done";
        // @ts-ignore
        emit({
          type: "toolCall",
          // @ts-ignore
          id: tc.id,
          // @ts-ignore
          name: tc.name,
          // @ts-ignore
          args: tc.args,
          result,
          // @ts-ignore
          status: tc.status,
        });
      } catch (error: unknown) {
        // @ts-ignore
        tc.result = { error: error.message };
        // @ts-ignore
        tc.status = "error";
        // @ts-ignore
        emit({
          type: "toolCall",
          // @ts-ignore
          id: tc.id,
          // @ts-ignore
          name: tc.name,
          // @ts-ignore
          args: tc.args,
          // @ts-ignore
          result: tc.result,
          status: "error",
        });
      }
    }
    // Build tool result messages for the provider
    const assistantToolMsg = {
      role: "assistant",
      content: ss.text || "",
      toolCalls: ss.toolCalls.map((tc: Record<string, unknown>) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
      })),
      ...(ss.thinking ? { thinking: ss.thinking } : {}),
      ...(ss.thinkingSignature
        ? { thinkingSignature: ss.thinkingSignature }
        : {}),
    };
    const toolResultMsgs = ss.toolCalls
      .filter((tc: Record<string, unknown>) => tc.result)
      .map((tc: Record<string, unknown>) => ({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content:
          typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result),
      }));
    // Re-call provider with tool results appended
    // @ts-ignore - TODO: strict typing
    const updatedMessages = [...messages, assistantToolMsg, ...toolResultMsgs];
    // Reset accumulators for the follow-up stream
    ss.text = "";
    ss.thinking = "";
    ss.thinkingSignature = "";
    ss.toolCalls.length = 0;
    // @ts-ignore - TODO: strict typing
    const followUpStream = provider.generateTextStream(
      updatedMessages,
      resolvedModel,
      {
        // @ts-ignore - TODO: strict typing
        ...options,
        signal,
      },
    );
    // Use dispatchChunk with a custom usage merger for follow-up iteration
    const usageMerger = (followUpUsage: Record<string, unknown>) => {
      if (ss.usage) {
        mergeUsage(ss.usage, followUpUsage);
      } else {
        // @ts-ignore - TODO: strict typing
        ss.usage = followUpUsage;
      }
    };
    // @ts-ignore
    for await ( const chunk of followUpStream) {
      // @ts-ignore - TODO: strict typing
      if (signal?.aborted) {
        if (typeof followUpStream.return === "function")
          followUpStream.return();
        break;
      }
      await dispatchChunk(
        chunk,
        ss,
        { emit, project, username },
        { onUsage: usageMerger, logPrefix: "chat/FC" },
      );
    }
    // Emit intermediate usage update so the frontend has authoritative
    // per-iteration token counts instead of relying on chunk heuristics
    if (ss.usage) {
      // @ts-ignore - TODO: strict typing
      emit({
        type: "usage_update",
        // @ts-ignore
        usage: { ...ss.usage, requests: fcIteration + 1 },
      });
    }
    // Update messages ref for potential next iteration
    // @ts-ignore - TODO: strict typing
    messages.push(assistantToolMsg, ...toolResultMsgs);
  }
  // Build normalized result for shared finalization
  const now = performance.now();
  await finalizeTextGeneration(context, {
    text: ss.text,
    thinking: ss.thinking,
    thinkingSignature: ss.thinkingSignature,
    images: ss.images,
    toolCalls: ss.toolCalls,
    audioChunks: ss.audioChunks,
    audioSampleRate: ss.audioSampleRate,
    usage: ss.usage,
    outputCharacters: ss.outputCharacters,
    timeToGenerationSec: ss.firstTokenTime
      // @ts-ignore - TODO: strict typing
      ? (ss.firstTokenTime - requestStart) / 1000
      : null,
    generationSec:
      ss.firstTokenTime && ss.generationEnd
        ? (ss.generationEnd - ss.firstTokenTime) / 1000
        : null,
    // @ts-ignore - TODO: strict typing
    totalSec: (now - requestStart) / 1000,
    rateLimits: ss.rateLimits,
  });
}
// ─── Dispatch: Non-streaming text generation (fallback) ─────
async function handleNonStreamingText(context: Record<string, unknown>) {
  const {
    provider,
    resolvedModel,
    messages,
    options,
    conversationId,
    project,
    username,
    requestStart,
    emit,
  } = context;
  // Mark conversation as generating
  markGenerating(
    // @ts-ignore - TODO: strict typing
    conversationId,
    project,
    username,
    true,
    // @ts-ignore - TODO: strict typing
    getCollectionOpts(project),
  );
  // Track this sub-request in SessionGenerationTracker if it belongs
  // to an active agent session (e.g., tools-api calling /chat?stream=false
  // for generate_image prompt-softening or describe_image).
  const subRequestId = context.agentSessionId
    ? `sub-${context.requestId || crypto.randomUUID()}`
    : null;
  if (subRequestId && context.agentSessionId) {
    // @ts-ignore - TODO: strict typing
    SessionGenerationTracker.register(context.agentSessionId, subRequestId, {
      // @ts-ignore
      provider: context.providerName,
      model: resolvedModel,
      source: "tool-sub-request",
    });
  }
  const generationStart = performance.now();
  // @ts-ignore - TODO: strict typing
  const genResult = await provider.generateText(
    messages,
    resolvedModel,
    options,
  );
  const now = performance.now();
  // Complete sub-request tracking with actual token data
  if (subRequestId && context.agentSessionId) {
    const outTokens = genResult.usage?.outputTokens || 0;
    if (outTokens > 0) {
      // @ts-ignore - TODO: strict typing
      SessionGenerationTracker.update(subRequestId, {
        outputTokens: outTokens,
      });
    }
    // @ts-ignore - TODO: strict typing
    SessionGenerationTracker.complete(subRequestId);
  }
  // Emit chunk/thinking/toolCall events before finalization
  if (genResult.text) {
    // @ts-ignore - TODO: strict typing
    emit({ type: "chunk", content: genResult.text });
  }
  if (genResult.thinking) {
    // @ts-ignore - TODO: strict typing
    emit({ type: "thinking", content: genResult.thinking });
  }
  if (genResult.toolCalls && genResult.toolCalls.length > 0) {
    // @ts-ignore
    for ( const tc of genResult.toolCalls) {
      // @ts-ignore - TODO: strict typing
      emit({
        type: "toolCall",
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      });
    }
  }
  // Handle images from the generation result (e.g. Gemini image models)
  const images: Record<string, unknown>[] = [];
  if (genResult.images && genResult.images.length > 0) {
    // @ts-ignore
    for ( const image of genResult.images) {
      let minioRef = null;
      if (image.data) {
        try {
          const mimeType = image.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${image.data}`;
          const { ref } = await FileService.uploadFile(
            dataUrl,
            "generations",
            // @ts-ignore - TODO: strict typing
            project,
            username,
          );
          minioRef = ref;
        } catch (uploadErr: unknown) {
          logger.error(
            // @ts-ignore - TODO: strict typing
            `[chat/non-stream] MinIO upload failed: ${uploadErr.message}`,
          );
        }
        images.push(
          // @ts-ignore - TODO: strict typing
          minioRef || `data:${image.mimeType || "image/png"};base64,${image.data}`,
        );
      }
      // @ts-ignore - TODO: strict typing
      emit({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
        minioRef,
      });
    }
  }
  // Build normalized result for shared finalization
  await finalizeTextGeneration(context, {
    text: genResult.text || "",
    thinking: genResult.thinking || "",
    images,
    toolCalls:
      genResult.toolCalls?.map((tc: Record<string, unknown>) => ({
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      })) || [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: genResult.usage || { inputTokens: 0, outputTokens: 0 },
    outputCharacters: genResult.text ? genResult.text.length : 0,
    // @ts-ignore - TODO: strict typing
    timeToGenerationSec: (generationStart - requestStart) / 1000,
    generationSec: (now - generationStart) / 1000,
    // @ts-ignore - TODO: strict typing
    totalSec: (now - requestStart) / 1000,
    rateLimits: genResult.rateLimits || null,
  });
}
// ─── SSE streaming or JSON fallback ─────────────────────────
/**
 * POST /chat
 *
 * Default:       SSE streaming (text/event-stream)
 * ?stream=false: Plain JSON response (for server-to-server callers)
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, tools?, temperature?, maxTokens?, ... }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const params = {
      ...req.body,
      project: req.project,
      username: req.username,
      clientIp: req.clientIp,
    };
    if (req.query.stream !== "false") {
      await handleSseRequest(req, res, params);
    } else {
      await handleJsonRequest(req, res, next, params);
    }
  }),
);
export default router;

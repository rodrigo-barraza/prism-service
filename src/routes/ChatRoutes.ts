import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
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
import { SseEvent } from "../types/SseTypes.ts";
import { ChatRequestSchema } from "../types/index.ts";

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
async function resolveImageRefs(messages: any[], project: any, username: string) {
  // Deep copy for the provider — images will be data URLs
  const providerMessages = messages.map((m: any) => ({ ...m }));
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // ── Resolve media array fields: images, audio, video, pdf ──
    for (const field of ["images", "audio", "video", "pdf"]) {
      const array = (message as any)[field];
      if (array && Array.isArray(array) && array.length > 0) {
        const providerArr: any[] = [];
        const storageArr: any[] = [];
        await Promise.all(
          array.map(async (ref: any, j: number) => {
            const resolved = await resolveMediaRef(ref, project, username);
            providerArr[j] = resolved.providerRef;
            storageArr[j] = resolved.storageRef;
          }),
        );
        providerMessages[i][field] = providerArr;
        message[field] = storageArr;
      }
    }
  }
  return providerMessages;
}
/**
 * Compress an oversized image data URL in-place.
 * Parses the data URL, checks decoded size, runs through compressImageForSizeLimit,
 * and reconstructs if compression changed the data.

 */
async function compressDataUrlIfOversized(dataUrl: any) {
    const match = (dataUrl as any).match(/^data:([^;]+);base64,(.+)$/);
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
  } catch (error: any) {
        logger.warn(`[chat] Dimension constraint failed: ${(error as Error).message}`);
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
  } catch (error: any) {
    logger.error(
            `[chat] Image compression failed: ${(error as Error).message}. Sending original.`,
    );
    return `data:${mimeType};base64,${base64Data}`;
  }
}
/**
 * Resolve a single media reference for both provider and storage use.
 */
async function resolveMediaRef(ref: any, project: any, username: string) {
  // Already a base64 data URL — compress if oversized, upload to MinIO for storage
    if ((ref as any).startsWith("data:")) {
    let providerRef = ref;
    // Compress oversized images before they reach any provider
        providerRef = await compressDataUrlIfOversized(providerRef);
    let storageRef = providerRef;
    try {
      const { ref: minioRef } = await (FileService as any).uploadFile(
                (ref as any), // Upload original to MinIO
        "uploads",
        project,
        username,
      );
            storageRef = minioRef;
    } catch (error: any) {
            logger.error(`[chat] Failed to upload media to MinIO: ${(error as Error).message}`);
    }
    return { providerRef, storageRef };
  }
  // MinIO reference — download for provider, keep ref for storage
  if ((FileService as any).isMinioRef(ref)) {
    try {
      const key = (FileService as any).extractKey(ref);
      const file = await (FileService as any).getFile(key);
      if (!file) {
        logger.warn(`[chat] Could not resolve MinIO ref: ${ref}`);
        return { providerRef: ref, storageRef: ref };
      }
      const chunks: any[] = [];
            for await ( const chunk of file.stream) {
        chunks.push(chunk);
      }
            const buffer = Buffer.concat((chunks as any as readonly Uint8Array<ArrayBufferLike>[]));
      const base64 = buffer.toString("base64");
      let providerRef = `data:${file.contentType};base64,${base64}`;
      // Constrain dimensions + compress oversized images before they reach any provider
            providerRef = await compressDataUrlIfOversized((providerRef as any));
      return {
        providerRef,
        storageRef: ref,
      };
    } catch (error: any) {
      logger.error(
                `[chat] Failed to resolve MinIO ref ${ref}: ${(error as Error).message}`,
      );
      return { providerRef: ref, storageRef: ref };
    }
  }
  // HTTP(S) URL — fetch for provider, keep URL for storage
    if ((ref as any).startsWith("http://") || (ref as any).startsWith("https://")) {
    try {
            const response = await fetch((ref as any | URL | Request));
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
            providerRef = await compressDataUrlIfOversized((providerRef as any));
      return {
        providerRef,
        storageRef: ref,
      };
    } catch (error: any) {
            logger.error(`[chat] Failed to fetch media URL ${ref}: ${(error as Error).message}`);
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
 */
async function prepareGenerationContext(
  params: any,
  emit: any,
    { signal }: any = {},
) {
  const requestStart = performance.now();
  const requestId = crypto.randomUUID();

  const parseResult = ChatRequestSchema.safeParse(params);
  if (!parseResult.success) {
    // Custom error mappings to match the exact ones expected by existing consumers and test cases
    if (!params || !("provider" in params) || params.provider === undefined || params.provider === null) {
      throw new ProviderError("server", "Missing required field: provider", 400);
    }
    if (!params || !("messages" in params) || !Array.isArray(params.messages)) {
      throw new ProviderError(
        "server",
        "Missing or invalid field: messages (must be an array)",
        400,
      );
    }
    const issueMessages = parseResult.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    throw new ProviderError(
      "server",
      `Validation failed: ${issueMessages.join("; ")}`,
      400
    );
  }

  const validatedParams = parseResult.data as any;

  const {
    provider: _providerName,
    model: requestedModel,
    messages,
    conversationId: incomingConversationId,
    agentSessionId: incomingAgentSessionId,
    conversationMeta: incomingConversationMeta,
    traceId: incomingTraceId,
    project,
    username,
    clientIp,
    agent,
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
    workspaceRoot,
    ...extraParams
  } = validatedParams;

  let providerName = _providerName;
  // Build the internal options object that providers expect
  const options = {
    ...(tools && { tools }),
    ...(temperature !== undefined && temperature !== null && { temperature }),
    ...(maxTokens !== undefined && maxTokens !== null && { maxTokens }),
    ...(topP !== undefined && topP !== null && { topP }),
    ...(topK !== undefined && topK !== null && { topK }),
    ...(frequencyPenalty !== undefined && frequencyPenalty !== null && { frequencyPenalty }),
    ...(presencePenalty !== undefined && presencePenalty !== null && { presencePenalty }),
    ...(stopSequences && { stopSequences }),
    ...(seed !== undefined && seed !== null && seed !== "" && { seed }),
    ...(minP !== undefined && minP !== null && { minP }),
    ...(repeatPenalty !== undefined && repeatPenalty !== null && { repeatPenalty }),
    ...(thinkingEnabled !== undefined && thinkingEnabled !== null && { thinkingEnabled }),
    ...(reasoningEffort && { reasoningEffort }),
    ...(thinkingLevel && { thinkingLevel }),
    ...(thinkingBudget !== undefined && thinkingBudget !== null && { thinkingBudget }),
    ...(webSearch !== undefined && webSearch !== null && { webSearch }),
    ...(webFetch !== undefined && webFetch !== null && { webFetch }),
    ...(codeExecution !== undefined && codeExecution !== null && { codeExecution }),
    ...(urlContext !== undefined && urlContext !== null && { urlContext }),
    ...(verbosity && { verbosity }),
    ...(reasoningSummary && { reasoningSummary }),
    ...(functionCallingEnabled !== undefined && functionCallingEnabled !== null && { functionCallingEnabled }),
    ...(agenticLoopEnabled !== undefined && agenticLoopEnabled !== null && { agenticLoopEnabled }),
    ...(enabledTools && { enabledTools }),
    ...(disabledBuiltIns && { disabledBuiltIns }),
    ...(minContextLength && { minContextLength }),
    ...(forceImageGeneration !== undefined && forceImageGeneration !== null && { forceImageGeneration }),
    ...(responseFormat && { responseFormat }),
    ...(serviceTier && { serviceTier }),
    ...(textOnly !== undefined && textOnly !== null && { textOnly }),
    ...(autoApprove !== undefined && autoApprove !== null && { autoApprove }),
    ...(planFirst !== undefined && planFirst !== null && { planFirst }),
    ...(maxIterations !== undefined && maxIterations !== null && { maxIterations }),
    ...(maxWorkerIterations !== undefined && maxWorkerIterations !== null && { maxWorkerIterations }),
    ...(agentContext && { agentContext }),
    ...(extraParams.systemPrompt && { systemPrompt: extraParams.systemPrompt }),
  };
  // When thinking is explicitly disabled, strip all thinking sub-params
  // so providers don't inadvertently enable thinking by detecting them.
  if (thinkingEnabled === false) {
    delete (options as any).reasoningEffort;
    delete (options as any).thinkingLevel;
    delete (options as any).thinkingBudget;
  }
  // Local models emit thinking tokens (<think> tags) by default. Default
  // thinkingEnabled ON only when the client didn't send a value (undefined).
  // When the client explicitly sends false (thinking toggle off), respect it
  // — models can use tools without thinking.
  LocalProviderGateway.applyLocalDefaults((providerName as any), options, {
    thinkingEnabled: thinkingEnabled ?? undefined,
  });

  // ── Strip soft-deleted messages ──────────────────────────────
  const activeMessages = messages.filter((m: any) => !m.deleted);
  // ── Resolve image refs ─────────────────────────────────────
  const providerMessages = await resolveImageRefs(
        (activeMessages as any),
    (project as any),
    (username as any),
  );
  // ── Multi-instance load balancing ─────────────────────────
  // When the caller sends a base provider type (e.g. "lm-studio") and
  // multiple instances are registered, verify the model is available on
  // each instance (with quant-level fallback) and pick the least-busy
  // usable instance. Same model resolution logic as CoordinatorService.
  let resolvedModel =
        requestedModel || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[(providerName as string)];
    if (localModelQueue.isLocal((providerName as any))) {
        let siblings = getInstancesByType((providerName as any));
    // ── Model resolution (always) ──────────────────────────────
    // Resolve model availability across instances with quant-level
    // fallback. Also handles @quant syntax (e.g. "qwen3-32b@q4_k_m")
    // by mapping it to the actual LM Studio model key.
    const { usable, modelOverrides } = await resolveModelForInstances(
      (resolvedModel as any),
            (siblings as any),
    );
        if ((usable as any).length > 0) {
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
            for ( const inst of siblings) {
                const queueState = localModelQueue._getQueue((inst.id as any));
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
          `(model="${resolvedModel}", ${siblings.map((s: any) => `${s.id}:${s.concurrency - localModelQueue._getQueue(s.id).activeCount}free`).join(", ")})`,
        );
        providerName = bestId;
      }
    }
  }
    const provider = getProvider((providerName as any));
  // ── Resolve model ─────────────────────────────────────────
  // resolvedModel is set earlier (before load balancing) and may have
  // been updated to a quant variant by the model availability check.
  const modelDef = getModelByName((resolvedModel as any));
    const isImageAPIModel = (modelDef as any)?.imageAPI && provider.generateImage;
  // ── Local GPU mutex ──────────────────────────────────────
  let localRelease: any;
    if (localModelQueue.isLocal((providerName as any))) {
        localRelease = await localModelQueue.acquire((providerName as any | undefined));
        const queueState = localModelQueue._getQueue((providerName as any));
    logger.info(
      `[chat] 🔒 Acquired local GPU slot for ${resolvedModel} (${providerName}) ` +
        `(${queueState.activeCount}/${queueState.maxConcurrency} active` +
        (queueState.pending > 0 ? `, ${queueState.pending} queued)` : ")"),
    );
  }
  // Derive userMessage from the last user message
  const userMessage =
    messages?.filter((m: any) => m.role === "user").pop() || null;
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
export async function handleConversation(
  params: any,
  emit: any,
    { signal }: any = {},
) {
  let context: any;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: any) {
        emit({ type: "error", message: (error as Error).message });
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
    const firstUserMsg = (context.rawMessages as any)
            ?.filter((m: any) => m.role === "user")
      .pop();
    const titleSnippet =
      (firstUserMsg?.content || "").slice(0, 100).trim() || "New Conversation";
    conversationMeta = conversationMeta || { title: titleSnippet };
  }
  const traceId = incomingTraceId || null;
  if (traceId && conversationMeta) {
        (conversationMeta as any).traceId = traceId;
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
            if (!(context as any).provider.generateTextStream && !(context as any).provider.generateText) {
        throw new ProviderError(
                    (providerName as any),
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      const useStreaming =
                (context as any).provider.generateTextStream && (context.modelDef as any)?.streaming !== false;
      if (useStreaming) {
        // Native MCP tool execution — provider handles tool calling internally
        const useNativeMcp =
                    LocalProviderGateway.isNativeMCP((providerName as any)) &&
                    !(options as any).agenticLoopEnabled;
                if (useNativeMcp && (options as any).functionCallingEnabled) {
          const builtInTools = ToolOrchestratorService.getToolSchemas();
          let tools = builtInTools;
                    if ((options as any).enabledTools && Array.isArray((options as any).enabledTools)) {
                        const enabledSet = new Set((options as any).enabledTools);
                        tools = tools.filter((t: any) => enabledSet.has(t.name));
          } else if (
                        (options as any).disabledBuiltIns &&
                        Array.isArray((options as any).disabledBuiltIns)
          ) {
                        const disabledSet = new Set((options as any).disabledBuiltIns);
                        tools = tools.filter((t: any) => !disabledSet.has(t.name));
          }
                    (options as any).tools = tools;
                    if ((context.modelDef as any)?.contextLength) {
                        (options as any).contextLength = (context as any).modelDef.contextLength;
          }
          logger.info(
                        `[chat] Native MCP (${providerName}): ${tools.length} tools enabled, enabledTools=${((options as any).enabledTools || []).length}, builtIn=${builtInTools.length}, contextLength=${(options as any).contextLength || "unset"}`,
          );
        } else if (useNativeMcp) {
          logger.warn(
                        `[chat] Native MCP SKIPPED (${providerName}): functionCallingEnabled=${(options as any).functionCallingEnabled}, useNativeMcp=${useNativeMcp}`,
          );
        }
        // Non-LM-Studio FC on /chat path
        if (
          !useNativeMcp &&
                    !(options as any).agenticLoopEnabled &&
                    (options as any).functionCallingEnabled
        ) {
          const builtInTools = ToolOrchestratorService.getToolSchemas();
          let tools = builtInTools;
                    if ((options as any).enabledTools && Array.isArray((options as any).enabledTools)) {
                        const enabledSet = new Set((options as any).enabledTools);
                        tools = tools.filter((t: any) => enabledSet.has(t.name));
          } else if (
                        (options as any).disabledBuiltIns &&
                        Array.isArray((options as any).disabledBuiltIns)
          ) {
                        const disabledSet = new Set((options as any).disabledBuiltIns);
                        tools = tools.filter((t: any) => !disabledSet.has(t.name));
          }
                    (options as any).tools = tools;
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
                localRelease();
        localRelease();
        logger.info(`[chat] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
    }
  } catch (error: any) {
    markGenerating(
      conversationId,
      project,
      username,
      false,
      getCollectionOpts(project),
    );
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: "/chat",
      operation: "chat",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel || requestedModel || "any",
      conversationId: conversationId || null,
      traceId: traceId || null,
      success: false,
            errorMessage: (error as Error).message,
      totalSec,
      messages: context.rawMessages || [],
      options: {},
    });
        emit({ type: "error", message: (error as Error).message });
  }
}
// ─── Agent session path (agentSessionId, no conversationId) ─
/**
 * Handle an agent request: always dispatches to AgenticLoopService.
 * Persistence uses agentSessionId (not conversationId).
 *
 * Used exclusively by the /agent route.
 */
export async function handleAgent(params: any, emit: (event: SseEvent) => void, { signal }: { signal?: AbortSignal } = {}) {
  let context: any;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: any) {
        emit({ type: "error", message: (error as Error).message });
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
    agentSessionId,
    project,
    username,
    true,
    { ...getCollectionOpts(project), agent },
  );
  try {
    try {
            if (!(context as any).provider.generateTextStream && !(context as any).provider.generateText) {
        throw new ProviderError(
                    (providerName as any),
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      const { default: AgenticLoopService } =
        await import("../services/AgenticLoopService.js");
      await AgenticLoopService.runAgenticLoop({
                provider: context.provider,
                providerName,
                resolvedModel,
                modelDef: context.modelDef,
                messages: context.messages,
                originalMessages: context.originalMessages,
                options,
                agentSessionId,
                userMessage: context.userMessage,
                conversationMeta,
                traceId,
                project,
                username,
                clientIp,
                agent,
                workspaceRoot: context.workspaceRoot,
                requestId,
                requestStart,
                emit,
                signal,
      });
    } finally {
      if (localRelease) {
                localRelease();
        logger.info(`[agent] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
      // When the SSE connection is severed (user pressed stop), abort any
      // spawned workers that are still running under this coordinator session.
            if ((signal as any)?.aborted) {
        try {
          const { default: CoordinatorService } =
            await import("../services/CoordinatorService.js");
                    await CoordinatorService.abortWorkersBySession((agentSessionId as any));
        } catch (cleanupErr: any) {
                    logger.warn(`[agent] Worker cleanup failed: ${(cleanupErr as Error).message}`);
        }
      }
    }
  } catch (error: any) {
    markGenerating(
      agentSessionId,
      project,
      username,
      false,
      getCollectionOpts(project),
    );
        const totalSec = (performance.now() - (requestStart as any)) / 1000;
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: "/agent",
      operation: "agent",
      project,
      username,
      clientIp,
      provider: providerName,
      model: resolvedModel || requestedModel || "any",
      agentSessionId,
      traceId: traceId || null,
      success: false,
            errorMessage: (error as Error).message,
      totalSec,
      messages: context.rawMessages || [],
      options: {},
    });
        emit({ type: "error", message: (error as Error).message });
  }
}
// ─── Dispatch: Image API models (e.g. GPT Image 1.5, OpenAI images) ─
async function handleImageAPIModel(context: any) {
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
    conversationId,
    project,
    username,
    true,
    getCollectionOpts(project),
  );
    const lastUserMsg = (messages as any).filter((m: any) => m.role === "user").pop();
  const prompt = lastUserMsg?.content || "";
  // Collect all images from the conversation
  const allImages: any[] = [];
    for ( const message of (messages as any)) {
    if (message.images && message.images.length > 0) {
      allImages.push(...message.images);
    }
  }
    const result = await (provider as any).generateImage(
    prompt,
    allImages,
    resolvedModel,
        (options as any)?.systemPrompt,
  );
    const totalSec = (performance.now() - (requestStart as any)) / 1000;
  // Cost calculation
  const imgPricing =
        getPricing(TYPES.TEXT, TYPES.IMAGE)[(resolvedModel as string)] || (modelDef as any)?.pricing;
  const outputImgTokens =
        (modelDef as any)?.imageTokensPerImage || (providerName === "openai" ? 1056 : 1120);
  const estimatedCost = calculateImageCost(
    prompt,
    imgPricing,
        (allImages.length as any),
    (outputImgTokens as any),
  );
  logger.request(
        (project as any),
    (username as any),
    (clientIp as any),
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
      const { ref } = await (FileService as any).uploadFile(
        dataUrl,
        "generations",
                (project as any | null | undefined),
        username,
      );
      minioRef = ref;
    } catch (uploadErr: any) {
      logger.error(
                `[chat/image-api] MinIO upload failed: ${(uploadErr as Error).message}`,
      );
    }
  }
  // Estimate token counts for tracking
  const estimatedInputTokens =
    estimateTokens(prompt) +
        allImages.length * ((modelDef as any)?.imageTokensPerImage || 1120);
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
        (emit as any)({ type: "chunk", content: result.text });
  }
    (emit as any)({
    type: "image",
    data: result.imageData,
    mimeType: result.mimeType || "image/png",
    minioRef,
  });
    (emit as any)({
    type: "done",
    usage: result.usage || null,
    estimatedCost,
    totalTime: totalSec,
        ...(traceId && { traceId }),
        ...(conversationId && { conversationId }),
  });
  // Link conversation to session
  // Auto-append to conversation
  if (conversationId) {
    const messagesToAppend: any[] = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        role: "user",
        ...userMessage,
                timestamp: (userMessage as any).timestamp || new Date().toISOString(),
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
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
      getCollectionOpts(project),
    );
  }
}
// ─── Post-generation finalization ────────────────────────────
// Moved to src/services/harnesses/lifecycle/Finalizer.ts
// Imported at the top of this file via:
//   import { finalizeTextGeneration, getCollectionOpts } from "../services/harnesses/lifecycle/Finalizer.ts";

async function handleStreamingText(context: any) {
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
    conversationId,
    project,
    username,
    true,
    getCollectionOpts(project),
  );
  const stream =
        (modelDef as any)?.liveAPI && (provider as any).generateTextStreamLive
            ? (provider as any).generateTextStreamLive(messages, resolvedModel, {
                    ...options,
          signal,
        })
            : (provider as any).generateTextStream(messages, resolvedModel, {
                    ...options,
          signal,
        });
  const ss = createStreamState();
    ss.requestStart = requestStart;
    for await ( const chunk of stream) {
    // Client disconnected — abort the upstream provider stream
        if ((signal as any)?.aborted) {
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
        (options as any).functionCallingEnabled &&
    ss.toolCalls.length > 0 &&
    ss.toolCalls.some(
      (tc: any) => !tc.result && tc.status !== "done" && tc.status !== "error",
    ) &&
    fcIteration < MAX_FC_ITERATIONS &&
        !(signal as any)?.aborted
  ) {
    fcIteration++;
    const pendingCalls = ss.toolCalls.filter(
      (tc: any) => !tc.result && tc.status !== "done" && tc.status !== "error",
    );
    if (pendingCalls.length === 0) break;
    logger.info(
      `[chat/FC] Iteration ${fcIteration}: executing ${pendingCalls.length} tool call(s)`,
    );
    // Execute all pending tool calls
        for ( const tc of pendingCalls) {
            (emit as any)({
        type: "toolCall",
                id: (tc as any).id,
                name: (tc as any).name,
                args: (tc as any).args,
        status: "calling",
      });
      try {
                const result = await ToolOrchestratorService.executeTool(
                    (tc as any).name,
                    (tc as any).args,
          { project, username },
        );
                (tc as any).result = result;
                (tc as any).status = result?.error ? "error" : "done";
                (emit as any)({
          type: "toolCall",
                    id: (tc as any).id,
                    name: (tc as any).name,
                    args: (tc as any).args,
          result,
                    status: (tc as any).status,
        });
      } catch (error: any) {
                (tc as any).result = { error: (error as Error).message };
                (tc as any).status = "error";
                (emit as any)({
          type: "toolCall",
                    id: (tc as any).id,
                    name: (tc as any).name,
                    args: (tc as any).args,
                    result: (tc as any).result,
          status: "error",
        });
      }
    }
    // Build tool result messages for the provider
    const assistantToolMsg = {
      role: "assistant",
      content: ss.text || "",
      toolCalls: ss.toolCalls.map((tc: any) => ({
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
      .filter((tc: any) => tc.result)
      .map((tc: any) => ({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content:
          typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result),
      }));
    // Re-call provider with tool results appended
        const updatedMessages = [...messages, assistantToolMsg, ...toolResultMsgs];
    // Reset accumulators for the follow-up stream
    ss.text = "";
    ss.thinking = "";
    ss.thinkingSignature = "";
    ss.toolCalls.length = 0;
        const followUpStream = (provider as any).generateTextStream(
      updatedMessages,
      resolvedModel,
      {
                ...options,
        signal,
      },
    );
    // Use dispatchChunk with a custom usage merger for follow-up iteration
    const usageMerger = (followUpUsage: any) => {
      if (ss.usage) {
        mergeUsage(ss.usage, followUpUsage);
      } else {
                ss.usage = followUpUsage;
      }
    };
        for await ( const chunk of followUpStream) {
            if ((signal as any)?.aborted) {
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
      emit({
        type: "usage_update",
        usage: { ...(ss.usage as any), requests: fcIteration + 1 },
      });
    }
    // Update messages ref for potential next iteration
        (messages as any).push(assistantToolMsg, ...toolResultMsgs);
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
            ? (ss.firstTokenTime - (requestStart as any)) / 1000
      : null,
    generationSec:
      ss.firstTokenTime && ss.generationEnd
        ? (ss.generationEnd - ss.firstTokenTime) / 1000
        : null,
        totalSec: (now - (requestStart as any)) / 1000,
    rateLimits: ss.rateLimits,
  });
}
// ─── Dispatch: Non-streaming text generation (fallback) ─────
async function handleNonStreamingText(context: any) {
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
    conversationId,
    project,
    username,
    true,
    getCollectionOpts(project),
  );
  // Track this sub-request in SessionGenerationTracker if it belongs
  // to an active agent session (e.g., tools-api calling /chat?stream=false
  // for generate_image prompt-softening or describe_image).
  const subRequestId = context.agentSessionId
    ? `sub-${context.requestId || crypto.randomUUID()}`
    : null;
  if (subRequestId && context.agentSessionId) {
        (SessionGenerationTracker as any).register((context.agentSessionId as any), subRequestId, {
            provider: context.providerName,
      model: resolvedModel,
      source: "tool-sub-request",
    });
  }
  const generationStart = performance.now();
    const genResult = await (provider as any).generateText(
    messages,
    resolvedModel,
    options,
  );
  const now = performance.now();
  // Complete sub-request tracking with actual token data
  if (subRequestId && context.agentSessionId) {
    const outTokens = genResult.usage?.outputTokens || 0;
    if (outTokens > 0) {
            (SessionGenerationTracker as any).update((subRequestId as any), {
        outputTokens: outTokens,
      });
    }
        (SessionGenerationTracker as any).complete((subRequestId as any));
  }
  // Emit chunk/thinking/toolCall events before finalization
  if (genResult.text) {
        (emit as any)({ type: "chunk", content: genResult.text });
  }
  if (genResult.thinking) {
        (emit as any)({ type: "thinking", content: genResult.thinking });
  }
  if (genResult.toolCalls && genResult.toolCalls.length > 0) {
        for ( const tc of genResult.toolCalls) {
            (emit as any)({
        type: "toolCall",
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      });
    }
  }
  // Handle images from the generation result (e.g. Gemini image models)
  const images: any[] = [];
  if (genResult.images && genResult.images.length > 0) {
        for ( const image of genResult.images) {
      let minioRef = null;
      if (image.data) {
        try {
          const mimeType = image.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${image.data}`;
          const { ref } = await (FileService as any).uploadFile(
            dataUrl,
            "generations",
                        (project as any | null | undefined),
            username,
          );
          minioRef = ref;
        } catch (uploadErr: any) {
          logger.error(
                        `[chat/non-stream] MinIO upload failed: ${(uploadErr as Error).message}`,
          );
        }
        images.push(
                    (minioRef || `data:${image.mimeType || "image/png"};base64,${image.data}` as any),
        );
      }
            (emit as any)({
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
      genResult.toolCalls?.map((tc: any) => ({
        id: tc.id || null,
        name: tc.name,
        args: tc.args || {},
        thoughtSignature: tc.thoughtSignature || undefined,
      })) || [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: genResult.usage || { inputTokens: 0, outputTokens: 0 },
    outputCharacters: genResult.text ? genResult.text.length : 0,
        timeToGenerationSec: (generationStart - (requestStart as any)) / 1000,
    generationSec: (now - generationStart) / 1000,
        totalSec: (now - (requestStart as any)) / 1000,
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

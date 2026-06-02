import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
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
  getAgentDefaults,
} from "../config.ts";
import {
  estimateTokens,
  calculateImageCost,
  mergeUsage,
} from "../utils/CostCalculator.ts";
import type { TokenUsage } from "../types/admin.ts";
import type { ToolCallPayload, TokenUsage as FinalizerTokenUsage } from "../services/RequestLogger.ts";
import logger from "../utils/logger.ts";
import RequestLogger from "../services/RequestLogger.ts";
import FileService from "../services/FileService.ts";
import {
  createStreamState,
  dispatchChunk,
} from "../utils/StreamChunkDispatcher.ts";
import { resolveMessageMediaReferences } from "../services/MediaResolutionService.ts";

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
import type { ConversationMessage, EmitFn } from "../services/harnesses/types.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = express.Router();
function injectToolsIntoSystemPrompt(
  messages: Array<{ role: string; content?: string; [key: string]: unknown }>,
  tools: any[],
) {
  if (!tools || tools.length === 0) {
    return;
  }

  const groups = new Map<string, any[]>();
  for (const tool of tools) {
    const domain = ((tool.domain as string) || "Other").replace(/^Agentic:\s*/i, "");
    if (!groups.has(domain)) {
      groups.set(domain, []);
    }
    groups.get(domain)!.push(tool);
  }

  const sections: string[] = [];
  for (const [domain, domainTools] of groups) {
    const entries = domainTools.map((tool) => {
      const description = (tool.description as string) || "";
      const parameters = (tool.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>> || {};
      const parameterNames = Object.keys(parameters);
      const required = ((tool.parameters as Record<string, unknown>)?.required || []) as string[];
      const parameterString = parameterNames
        .map((parameterName) => {
          const isRequired = required.includes(parameterName);
          const parameterDescription = (parameters[parameterName].description as string) || "";
          return `  - ${parameterName}${isRequired ? " (required)" : ""}: ${parameterDescription}`;
        })
        .join("\n");

      return `### ${tool.name}\n${description}\n${parameterString}`;
    });

    sections.push(`**${domain}**\n${entries.join("\n\n")}`);
  }

  const toolsSection = `\n\n## Available Tools (${tools.length})\n` + sections.join("\n\n");

  const systemMessage = messages.find((message) => message.role === "system");
  if (systemMessage) {
    if (typeof systemMessage.content === "string" && !systemMessage.content.includes("## Available Tools")) {
      systemMessage.content += toolsSection;
    }
  } else {
    messages.unshift({
      role: "system",
      content: `You are a helpful AI assistant with access to a comprehensive suite of real-time data and utility tools. Present data clearly with relevant formatting. For questions that don't require API data, respond naturally without tool calls.` + toolsSection,
    });
  }
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
  params: Record<string, unknown>,
  emit: EmitFn,
  { signal }: { signal?: AbortSignal } = {},
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

  const validatedParams = parseResult.data;

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
    harness,
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
    disabledTools,
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
    // CriticGate: multi-model review of dangerous tool calls.
    enableCriticGate,
    criticModel,
    parallelToolCalls,
    candidateCount,
    responseMimeType,
    store,
    mediaResolution,
    topLogprobs,
    responseLogprobs,
    logprobs,
    ...extraParams
  } = validatedParams;

  let providerName = _providerName;
  // Build the internal options object that providers expect
  const options: Record<string, unknown> = {
    ...(tools && { tools }),
    ...(temperature != null && { temperature }),
    ...(maxTokens != null && { maxTokens }),
    ...(topP != null && { topP }),
    ...(topK != null && { topK }),
    ...(frequencyPenalty != null && { frequencyPenalty }),
    ...(presencePenalty != null && { presencePenalty }),
    ...(stopSequences && { stopSequences }),
    ...(seed != null && seed !== "" && { seed }),
    ...(minP != null && { minP }),
    ...(repeatPenalty != null && { repeatPenalty }),
    ...(thinkingEnabled != null && { thinkingEnabled }),
    ...(reasoningEffort && { reasoningEffort }),
    ...(thinkingLevel && { thinkingLevel }),
    ...(thinkingBudget != null && { thinkingBudget }),
    ...(webSearch != null && { webSearch }),
    ...(webFetch != null && { webFetch }),
    ...(codeExecution != null && { codeExecution }),
    ...(urlContext != null && { urlContext }),
    ...(verbosity && { verbosity }),
    ...(reasoningSummary && { reasoningSummary }),
    ...(functionCallingEnabled != null && { functionCallingEnabled }),
    ...(agenticLoopEnabled != null && { agenticLoopEnabled }),
    ...(enabledTools && { enabledTools }),
    ...(disabledTools && { disabledTools }),
    ...(minContextLength && { minContextLength }),
    ...(forceImageGeneration != null && { forceImageGeneration }),
    ...(responseFormat != null && { responseFormat }),
    ...(serviceTier != null && { serviceTier }),
    ...(textOnly != null && { textOnly }),
    ...(autoApprove != null && { autoApprove }),
    ...(planFirst != null && { planFirst }),
    ...(maxIterations != null && { maxIterations }),
    ...(maxWorkerIterations != null && { maxWorkerIterations }),
    ...(agentContext != null && { agentContext }),
    ...(enableCriticGate != null && { enableCriticGate }),
    ...(criticModel != null && { criticModel }),
    ...(harness != null && { harness }),
    ...(parallelToolCalls != null && { parallelToolCalls }),
    ...(candidateCount != null && { candidateCount }),
    ...(responseMimeType != null && responseMimeType !== "" && { responseMimeType }),
    ...(store != null && { store }),
    ...(mediaResolution != null && mediaResolution !== "" && { mediaResolution }),
    ...(topLogprobs != null && topLogprobs > 0 && { topLogprobs }),
    ...(responseLogprobs != null && { responseLogprobs }),
    ...(logprobs != null && logprobs > 0 && { logprobs }),
    ...((extraParams as Record<string, unknown>).systemPrompt ? { systemPrompt: (extraParams as Record<string, unknown>).systemPrompt } : {}),
  };
  // When thinking is explicitly disabled, strip all thinking sub-params
  // so providers don't inadvertently enable thinking by detecting them.
  if (thinkingEnabled === false) {
    delete options.reasoningEffort;
    delete options.thinkingLevel;
    delete options.thinkingBudget;
  } else {
    // Synchronize both fields so OpenAI/Anthropic (reasoningEffort) and Gemini (thinkingLevel) both get the correct option
    if (options.thinkingLevel && !options.reasoningEffort) {
      options.reasoningEffort = options.thinkingLevel;
    }
    if (options.reasoningEffort && !options.thinkingLevel) {
      options.thinkingLevel = options.reasoningEffort;
    }
  }

  // Apply agent-optimized defaults for parameters not explicitly set by client.
  // Agent sessions benefit from deterministic, high-output defaults
  // (e.g., temperature=0, maxTokens=16384, reasoningEffort="high").
  if (agent) {
    const agentDefaultValues = getAgentDefaults();
    for (const [parameterKey, defaultValue] of Object.entries(agentDefaultValues)) {
      if (options[parameterKey] === undefined || options[parameterKey] === null) {
        options[parameterKey] = defaultValue;
      }
    }
  }

  // Local models emit thinking tokens (<think> tags) by default. Default
  // thinkingEnabled ON only when the client didn't send a value (undefined).
  // When the client explicitly sends false (thinking toggle off), respect it
  // — models can use tools without thinking.
  LocalProviderGateway.applyLocalDefaults(providerName, options, {
    thinkingEnabled: thinkingEnabled ?? undefined,
  });

  // ── Strip soft-deleted messages ──────────────────────────────
  const activeMessages = messages.filter((m) => !m.deleted);
  // ── Resolve image refs ─────────────────────────────────────
  const providerMessages = await resolveMessageMediaReferences(
    activeMessages as ConversationMessage[],
    project,
    username,
  );
  // ── Multi-instance load balancing ─────────────────────────
  // When the caller sends a base provider type (e.g. "lm-studio") and
  // multiple instances are registered, verify the model is available on
  // each instance (with quant-level fallback) and pick the least-busy
  // usable instance. Same model resolution logic as CoordinatorService.
  let resolvedModel =
    requestedModel || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName as string];
  if (localModelQueue.isLocal(providerName)) {
    let siblings = getInstancesByType(providerName);
    // ── Model resolution (always) ──────────────────────────────
    // Resolve model availability across instances with quant-level
    // fallback. Also handles @quant syntax (e.g. "qwen3-32b@q4_k_m")
    // by mapping it to the actual LM Studio model key.
    const { usable, modelOverrides } = await resolveModelForInstances(
      resolvedModel,
      siblings,
    );
    if (usable.length > 0) {
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
      for (const inst of siblings) {
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
          `(model="${resolvedModel}", ${siblings.map((s) => `${s.id}:${s.concurrency - localModelQueue._getQueue(s.id).activeCount}free`).join(", ")})`,
        );
        providerName = bestId;
      }
    }
  }
  const provider = getProvider(providerName);
  // ── Resolve model ─────────────────────────────────────────
  // resolvedModel is set earlier (before load balancing) and may have
  // been updated to a quant variant by the model availability check.
  const modelDef = getModelByName(resolvedModel);
  const isImageAPIModel = (modelDef as Record<string, unknown> | null)?.imageAPI && provider.generateImage;
  // ── Local GPU mutex ──────────────────────────────────────
  let localRelease: (() => void) | null = null;
  if (localModelQueue.isLocal(providerName)) {
    localRelease = await localModelQueue.acquire(providerName);
    const queueState = localModelQueue._getQueue(providerName);
    logger.info(
      `[chat] 🔒 Acquired local GPU slot for ${resolvedModel} (${providerName}) ` +
        `(${queueState.activeCount}/${queueState.maxConcurrency} active` +
        (queueState.pending > 0 ? `, ${queueState.pending} queued)` : ")"),
    );
  }
  // Derive userMessage from the last user message
  const userMessage =
    messages?.filter((m) => m.role === "user").pop() || null;
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
  params: Record<string, unknown>,
  emit: EmitFn,
  { signal }: { signal?: AbortSignal } = {},
) {
  let context: Awaited<ReturnType<typeof prepareGenerationContext>> | null = null;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: unknown) {
        emit({ type: SSE_EVENT_TYPES.ERROR, message: getErrorMessage(error) });
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
    modelDef,
    localRelease,
  } = context;
  // ── Conversation identity ──────────────────────────────────
  let conversationId = skipConversation ? null : incomingConversationId;
  let conversationMeta = skipConversation ? null : incomingConversationMeta;
  if (!skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    const firstUserMsg = (context.rawMessages as ConversationMessage[])
      ?.filter((m) => m.role === "user")
      .pop();
    const titleSnippet =
      (firstUserMsg?.content || "").slice(0, 100).trim() || "New Conversation";
    conversationMeta = conversationMeta || { title: titleSnippet };
  }
  const traceId = incomingTraceId || null;
  if (traceId && conversationMeta) {
    (conversationMeta as Record<string, unknown>).traceId = traceId;
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
      if (!context.provider.generateTextStream && !context.provider.generateText) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      // Resolve and inject tools for /chat function calling
      if (options.functionCallingEnabled && !options.agenticLoopEnabled) {
        const useNativeMcp = LocalProviderGateway.isNativeMCP(providerName);
        const builtInTools = ToolOrchestratorService.getToolSchemas();
        let tools = builtInTools;
        if (options.enabledTools && Array.isArray(options.enabledTools)) {
          const enabledSet = new Set(options.enabledTools as string[]);
          tools = tools.filter((t) => enabledSet.has(t.name));
        } else if (
          options.disabledTools &&
          Array.isArray(options.disabledTools)
        ) {
          const disabledSet = new Set(options.disabledTools as string[]);
          tools = tools.filter((t) => !disabledSet.has(t.name));
        }
        options.tools = tools;

        // Inject tool descriptions into the system prompt
        injectToolsIntoSystemPrompt(fullCtx.messages as any[], tools);

        if (useNativeMcp && (modelDef as Record<string, unknown> | null)?.contextLength) {
          options.contextLength = (modelDef as Record<string, unknown>).contextLength;
        }

        logger.info(
          `[chat] FC tools resolved and injected into system prompt: ${tools.length} tools enabled for ${providerName} ${resolvedModel}`,
        );
      }

      const useStreaming =
        context.provider.generateTextStream && (modelDef as Record<string, unknown> | null)?.streaming !== false;
      if (useStreaming) {
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
  } catch (error: unknown) {
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
            errorMessage: getErrorMessage(error),
      totalSec,
      messages: context.rawMessages || [],
      options: {},
    });
        emit({ type: SSE_EVENT_TYPES.ERROR, message: getErrorMessage(error) });
  }
}
// ─── Agent session path (agentSessionId, no conversationId) ─
/**
 * Handle an agent request: always dispatches to AgenticLoopService.
 * Persistence uses agentSessionId (not conversationId).
 *
 * Used exclusively by the /agent route.
 */
export async function handleAgent(params: Record<string, unknown>, emit: (event: SseEvent) => void, { signal }: { signal?: AbortSignal } = {}) {
  let context: Awaited<ReturnType<typeof prepareGenerationContext>> | null = null;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: unknown) {
        emit({ type: SSE_EVENT_TYPES.ERROR, message: getErrorMessage(error) });
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
    { ...getCollectionOpts(project), agent: agent ?? undefined },
  );
  try {
    try {
      if (!context!.provider.generateTextStream && !context!.provider.generateText) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      const { default: AgenticLoopService } =
        await import("../services/AgenticLoopService.js");

      // Inject persona-level policies into options (if the agent has them)
      if (agent && !options.policies) {
        const { default: AgentPersonaRegistry } =
          await import("../services/AgentPersonaRegistry.js");
        const persona = AgentPersonaRegistry.get(agent);
        if (persona?.policies && persona.policies.length > 0) {
          options.policies = persona.policies;
        }
      }

      await AgenticLoopService.runAgenticLoop({
        provider: context.provider as import("../services/harnesses/types.ts").LLMProvider,
                providerName,
                resolvedModel,
                modelDef: context.modelDef,
                messages: context.messages,
                originalMessages: context.originalMessages as ConversationMessage[],
                options,
                agentSessionId,
                userMessage: context.userMessage as ConversationMessage | null,
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
      if (signal?.aborted) {
        try {
          const { default: CoordinatorService } =
            await import("../services/CoordinatorService.js");
          await CoordinatorService.abortWorkersBySession(agentSessionId);
        } catch (cleanupErr: unknown) {
                    logger.warn(`[agent] Worker cleanup failed: ${getErrorMessage(cleanupErr)}`);
        }
      }
    }
  } catch (error: unknown) {
    markGenerating(
      agentSessionId,
      project,
      username,
      false,
      getCollectionOpts(project),
    );
    const totalSec = (performance.now() - requestStart) / 1000;
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
            errorMessage: getErrorMessage(error),
      totalSec,
      messages: context.rawMessages || [],
      options: {},
    });
        emit({ type: SSE_EVENT_TYPES.ERROR, message: getErrorMessage(error) });
  }
}
// ─── Dispatch: Image API models (e.g. GPT Image 1.5, OpenAI images) ─
async function handleImageAPIModel(context: Awaited<ReturnType<typeof prepareGenerationContext>> & { conversationId?: string | null; conversationMeta?: Record<string, unknown> | null; traceId?: string | null }) {
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
  const lastUserMsg = (messages as ConversationMessage[]).filter((m) => m.role === "user").pop();
  const prompt = lastUserMsg?.content || "";
  // Collect all images from the conversation
  const allImages: string[] = [];
  for (const message of messages as ConversationMessage[]) {
    if (message.images && message.images.length > 0) {
      allImages.push(...message.images);
    }
  }
  const result = await provider.generateImage(
    prompt,
    allImages,
    resolvedModel,
    options?.systemPrompt,
  );
  const totalSec = (performance.now() - requestStart) / 1000;
  // Cost calculation
  const imgPricing =
    getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel as string] || (modelDef as Record<string, unknown> | null)?.pricing;
  const outputImgTokens =
    (modelDef as Record<string, unknown> | null)?.imageTokensPerImage as number || (providerName === "openai" ? 1056 : 1120);
  const estimatedCost = calculateImageCost(
    prompt,
    imgPricing,
    allImages.length,
    outputImgTokens,
  );
  logger.request(
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
        project,
        username,
      );
      minioRef = ref;
    } catch (uploadErr: unknown) {
      logger.error(
                `[chat/image-api] MinIO upload failed: ${getErrorMessage(uploadErr)}`,
      );
    }
  }
  // Estimate token counts for tracking
  const estimatedInputTokens =
    estimateTokens(prompt) +
    allImages.length * ((modelDef as Record<string, unknown> | null)?.imageTokensPerImage as number || 1120);
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
    emit({ type: SSE_EVENT_TYPES.CHUNK, content: result.text });
  }
  emit({
    type: SSE_EVENT_TYPES.IMAGE,
    data: result.imageData,
    mimeType: result.mimeType || "image/png",
    minioRef,
  });
  // Link conversation to session
  // Auto-append to conversation — persist BEFORE emitting `done`
  // so the client's post-stream DB fetch sees the complete conversation.
  if (conversationId) {
    const messagesToAppend: ConversationMessage[] = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        ...userMessage,
        role: "user",
        timestamp: (userMessage as ConversationMessage).timestamp || new Date().toISOString(),
      } as ConversationMessage);
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
    await appendAndFinalize(
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
      getCollectionOpts(project),
    );
  }
  emit({
    type: SSE_EVENT_TYPES.DONE,
    usage: result.usage || null,
    estimatedCost,
    totalTime: totalSec,
    ...(traceId && { traceId }),
    ...(conversationId && { conversationId }),
  });
}

type GenerationContext = Awaited<ReturnType<typeof prepareGenerationContext>> & {
  conversationId?: string | null;
  conversationMeta?: Record<string, unknown> | null;
  traceId?: string | null;
  agentSessionId?: string | null;
};

async function handleStreamingText(context: GenerationContext) {
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
    (modelDef as Record<string, unknown> | null)?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(messages, resolvedModel, {
          ...options,
          signal,
        })
      : provider.generateTextStream(messages, resolvedModel, {
          ...options,
          signal,
        });
  const streamState = createStreamState();
  streamState.requestStart = requestStart;
  for await (const chunk of stream) {
    // Client disconnected — abort the upstream provider stream
    if (signal?.aborted) {
      if (typeof stream.return === "function") stream.return();
      logger.info(
        `[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`,
      );
      break;
    }
    await dispatchChunk(
      chunk,
      streamState,
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
    options.functionCallingEnabled &&
    streamState.toolCalls.length > 0 &&
    streamState.toolCalls.some(
      (toolCall) => !toolCall.result && toolCall.status !== "done" && toolCall.status !== "error",
    ) &&
    fcIteration < MAX_FC_ITERATIONS &&
    !signal?.aborted
  ) {
    fcIteration++;
    const pendingCalls = streamState.toolCalls.filter(
      (toolCall) => !toolCall.result && toolCall.status !== "done" && toolCall.status !== "error",
    );
    if (pendingCalls.length === 0) break;
    logger.info(
      `[chat/FC] Iteration ${fcIteration}: executing ${pendingCalls.length} tool call(s)`,
    );
    // Execute all pending tool calls
    for (const toolCall of pendingCalls) {
      emit({
        type: SSE_EVENT_TYPES.TOOL_CALL,
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        status: "calling",
      });
      try {
        const result = await ToolOrchestratorService.executeTool(
          toolCall.name as string,
          toolCall.args as Record<string, unknown>,
          { project, username },
        );
        toolCall.result = result;
        toolCall.status = (result && typeof result === "object" && "error" in result && result.error) ? "error" : "done";
        emit({
          type: SSE_EVENT_TYPES.TOOL_CALL,
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          result,
          status: toolCall.status,
        });
      } catch (error: unknown) {
        toolCall.result = { error: getErrorMessage(error) };
        toolCall.status = "error";
        emit({
          type: SSE_EVENT_TYPES.TOOL_CALL,
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          result: toolCall.result,
          status: "error",
        });
      }
    }
    // Build tool result messages for the provider
    const assistantToolMsg = {
      role: "assistant",
      content: streamState.text || "",
      toolCalls: streamState.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        ...(toolCall.responsesItemId ? { responsesItemId: toolCall.responsesItemId } : {}),
        ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
        ...(toolCall.reasoningItem ? { reasoningItem: toolCall.reasoningItem } : {}),
      })),
      ...(streamState.thinking ? { thinking: streamState.thinking } : {}),
      ...(streamState.thinkingSignature
        ? { thinkingSignature: streamState.thinkingSignature }
        : {}),
    };
    const toolResultMsgs = streamState.toolCalls
      .filter((toolCall) => toolCall.result)
      .map((toolCall) => ({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content:
          typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result),
      }));
    // Re-call provider with tool results appended
    const updatedMessages = [...messages, assistantToolMsg, ...toolResultMsgs];
    // Reset accumulators for the follow-up stream
    streamState.text = "";
    streamState.thinking = "";
    streamState.thinkingSignature = "";
    streamState.toolCalls.length = 0;
    const followUpStream = provider.generateTextStream(
      updatedMessages,
      resolvedModel,
      {
        ...options,
        signal,
      },
    );
    // Use dispatchChunk with a custom usage merger for follow-up iteration
    const usageMerger = (followUpUsage: TokenUsage) => {
      if (streamState.usage) {
        mergeUsage(streamState.usage, followUpUsage);
      } else {
        streamState.usage = followUpUsage;
      }
    };
    for await (const chunk of followUpStream) {
      if (signal?.aborted) {
        if (typeof followUpStream.return === "function")
          followUpStream.return();
        break;
      }
      await dispatchChunk(
        chunk,
        streamState,
        { emit, project, username },
        { onUsage: usageMerger, logPrefix: "chat/FC" },
      );
    }
    // Emit intermediate usage update so the frontend has authoritative
    // per-iteration token counts instead of relying on chunk heuristics
    if (streamState.usage) {
      emit({
        type: SSE_EVENT_TYPES.USAGE_UPDATE,
        usage: { ...(streamState.usage as Record<string, unknown>), requests: fcIteration + 1 },
      });
    }
    // Update messages ref for potential next iteration
    (messages as Record<string, unknown>[]).push(assistantToolMsg, ...toolResultMsgs);
  }
  // Surface max_tokens truncation if the model produced no useful output
  const isChatTruncated =
    (streamState.stopReason === "length" || streamState.stopReason === "max_tokens") &&
    !streamState.text.trim();
  if (isChatTruncated) {
    const truncationWarning =
      `⚠️ The model's response was cut short because the **max_tokens** limit was reached ` +
      `before it could finish generating. Try increasing the **Max Tokens** setting.`;
    emit({
      type: SSE_EVENT_TYPES.CHUNK,
      content: truncationWarning,
    });
    emit({
      type: SSE_EVENT_TYPES.STATUS,
      message: (STATUS_MESSAGES as any).MAX_TOKENS_TRUNCATED || "max_tokens_truncated",
      phase: "truncated",
    });
    streamState.text = truncationWarning;
  }
  // Build normalized result for shared finalization
  const now = performance.now();
  await finalizeTextGeneration(context, {
    text: streamState.text,
    thinking: streamState.thinking,
    images: streamState.images,
    toolCalls: streamState.toolCalls.map((toolCall): ToolCallPayload => ({
      name: toolCall.name,
      id: toolCall.id,
      args: toolCall.args as Record<string, unknown>,
      ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
    })),
    audioChunks: streamState.audioChunks,
    audioSampleRate: streamState.audioSampleRate,
    usage: streamState.usage as FinalizerTokenUsage | null,
    resolvedEnabledTools: (options.tools as any[])?.map((t) => t.name) || null,
    outputCharacters: streamState.outputCharacters,
    timeToGenerationSec: streamState.firstTokenTime
      ? (streamState.firstTokenTime - requestStart) / 1000
      : null,
    generationSec:
      streamState.firstTokenTime && streamState.generationEnd
        ? (streamState.generationEnd - streamState.firstTokenTime) / 1000
        : null,
    totalSec: (now - requestStart) / 1000,
    rateLimits: streamState.rateLimits as Record<string, unknown> | null,
  });
}
// ─── Dispatch: Non-streaming text generation (fallback) ─────
async function handleNonStreamingText(context: GenerationContext) {
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
    SessionGenerationTracker.register(context.agentSessionId, subRequestId, {
      provider: context.providerName,
      model: resolvedModel,
      source: "tool-sub-request",
    });
  }
  const generationStart = performance.now();
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
      SessionGenerationTracker.update(subRequestId, {
        outputTokens: outTokens,
      });
    }
    SessionGenerationTracker.complete(subRequestId);
  }
  // Emit chunk/thinking/toolCall events before finalization
  if (genResult.text) {
    emit({ type: SSE_EVENT_TYPES.CHUNK, content: genResult.text });
  }
  if (genResult.thinking) {
    emit({ type: SSE_EVENT_TYPES.THINKING, content: genResult.thinking });
  }
  if (genResult.toolCalls && genResult.toolCalls.length > 0) {
    for (const toolCall of genResult.toolCalls) {
      emit({
        type: SSE_EVENT_TYPES.TOOL_CALL,
        id: toolCall.id || null,
        name: toolCall.name,
        args: toolCall.args || {},
        thoughtSignature: toolCall.thoughtSignature || undefined,
      });
    }
  }
  // Handle images from the generation result (e.g. Gemini image models)
  const images: string[] = [];
  if (genResult.images && genResult.images.length > 0) {
    for (const image of genResult.images) {
      let minioRef = null;
      if (image.data) {
        try {
          const mimeType = image.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${image.data}`;
          const { ref } = await FileService.uploadFile(
            dataUrl,
            "generations",
            project,
            username,
          );
          minioRef = ref;
        } catch (uploadErr: unknown) {
          logger.error(
            `[chat/non-stream] MinIO upload failed: ${getErrorMessage(uploadErr)}`,
          );
        }
        images.push(
          minioRef || `data:${image.mimeType || "image/png"};base64,${image.data}`,
        );
      }
      emit({
        type: SSE_EVENT_TYPES.IMAGE,
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
      genResult.toolCalls?.map((toolCall: Record<string, unknown>) => ({
        id: toolCall.id || null,
        name: toolCall.name,
        args: toolCall.args || {},
        thoughtSignature: toolCall.thoughtSignature || undefined,
      })) || [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: genResult.usage || { inputTokens: 0, outputTokens: 0 },
    resolvedEnabledTools: (options.tools as any[])?.map((t) => t.name) || null,
    outputCharacters: genResult.text ? genResult.text.length : 0,
    timeToGenerationSec: (generationStart - requestStart) / 1000,
    generationSec: (now - generationStart) / 1000,
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

// @ts-ignore
import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import {
  calculateTextCost,
  getTotalInputTokens,
} from "../../../utils/CostCalculator.ts";
import { calculateTokensPerSec } from "../../../utils/math.ts";
import { TYPES, getPricing } from "../../../config.ts";
import RequestLogger from "../../RequestLogger.ts";
import FileService from "../../FileService.ts";
import AgentPersonaRegistry from "../../AgentPersonaRegistry.ts";
import {
  appendAndFinalize,
} from "../../../utils/ConversationUtilities.ts";
import { COLLECTIONS } from "../../../constants.ts";
import logger from "../../../utils/logger.ts";

/**
 * Resolve the MongoDB collection for conversation persistence.
 * Agent projects go to agent_sessions; everything else to conversations.
 */
function getCollectionOpts(project: Record<string, unknown>) {
  if (AgentPersonaRegistry.isAgentProject(project)) {
    return { collection: COLLECTIONS.AGENT_SESSIONS };
  }
  return undefined;
}

/**
 * Finalizer — shared generation finalization logic extracted from ChatRoutes.
 *
 * Handles:
 *   - Cost calculation (text, image, mixed)
 *   - Console logging with telemetry
 *   - WAV audio assembly from PCM chunks
 *   - Request logging (non-agentic paths)
 *   - Done event emission
 *   - Conversation/session persistence via appendAndFinalize
 *
 * Used by all harness implementations and the /chat streaming path.
 */
export async function finalizeTextGeneration(
  context: Record<string, unknown>,
  {
    text,
    thinking,
    thinkingSignature,
    images,
    toolCalls,
    audioChunks,
    audioSampleRate,
    usage,
    outputCharacters,
    timeToGenerationSec,
    generationSec,
    totalSec,
    rateLimits,
    // Display segment metadata (from AgenticLoopService)
    contentSegments,
    textFragments,
    thinkingFragments,
  }: Record<string, unknown>,
  // @ts-ignore - TODO: strict typing
  overrideMessagesToAppend: Record<string, unknown> = null,
) {
  const {
    providerName,
    resolvedModel,
    modelDef,
    messages,
    originalMessages,
    options,
    conversationId: rawConversationId,
    agentSessionId,
    parentAgentSessionId,
    userMessage,
    conversationMeta,
    traceId,
    project,
    username,
    clientIp,
    agent,
    workspaceRoot,
    requestId,
    emit,
    signal,
  } = context;
  // Agent sessions use agentSessionId as the persistence key
  const conversationId = rawConversationId ?? agentSessionId;
  // ── Cost calculation ──────────────────────────────────────────
  let estimatedCost = null;
  let tokensPerSec = null;
  if (usage) {
    // @ts-ignore - TODO: strict typing
    const imageCount = images.length;
    if (imageCount > 0) {
      const imgPricing =
        // @ts-ignore
        getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel] || modelDef?.pricing;
      if (imgPricing?.imageOutputPerMillion) {
        // Derive image tokens dynamically from the API-reported total.
        // The API's outputTokens already includes both text and image tokens,
        // so we estimate text tokens from the generated text length (~4 chars/token)
        // and attribute the remainder to images. This adapts to any resolution
        // (512px≈747tok, 1024px≈1120tok, 2048px≈1680tok, 4096px≈2520tok).
        // @ts-ignore - TODO: strict typing
        const estimatedTextOutputTokens = Math.ceil((text?.length || 0) / 4);
        const imageTokens = Math.max(
          0,
          // @ts-ignore - TODO: strict typing
          usage.outputTokens - estimatedTextOutputTokens,
        );
        // @ts-ignore - TODO: strict typing
        const textOutputTokens = Math.max(0, usage.outputTokens - imageTokens);
        const inputCost =
          // @ts-ignore - TODO: strict typing
          (usage.inputTokens / 1_000_000) * (imgPricing.inputPerMillion || 0);
        const textOutCost =
          (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
        const imageOutCost =
          (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
        estimatedCost = parseFloat(
          (inputCost + textOutCost + imageOutCost).toFixed(8),
        );
      } else {
        // @ts-ignore
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        // @ts-ignore - TODO: strict typing
        estimatedCost = calculateTextCost(usage, pricing);
      }
    } else {
      // @ts-ignore
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
      // @ts-ignore - TODO: strict typing
      estimatedCost = calculateTextCost(usage, pricing);
    }
    // @ts-ignore - TODO: strict typing
    tokensPerSec = calculateTokensPerSec(usage.outputTokens, generationSec, {
      // @ts-ignore - TODO: strict typing
      providerReported: usage.tokensPerSec,
      fallbackSec: totalSec,
    });
  }
  // ── Console logging ───────────────────────────────────────────
  // @ts-ignore - TODO: strict typing
  const inputTokens = getTotalInputTokens(usage);
  // @ts-ignore - TODO: strict typing
  const outputTokens = usage?.outputTokens || 0;
  const tokensPerSecStr =
    tokensPerSec !== null ? tokensPerSec.toFixed(1) : "N/A";
  const cacheInfo =
    // @ts-ignore - TODO: strict typing
    usage?.cacheReadInputTokens || usage?.cacheCreationInputTokens
      // @ts-ignore - TODO: strict typing
      ? `, cache_read: ${usage.cacheReadInputTokens || 0}, cache_write: ${usage.cacheCreationInputTokens || 0}`
      : "";
  logger.request(
    // @ts-ignore - TODO: strict typing
    project,
    username,
    clientIp,
    `[chat] ${providerName} ${resolvedModel} — ` +
      `in: ${inputTokens} tokens, out: ${outputTokens} tokens${cacheInfo}, ` +
      `speed: ${tokensPerSecStr} tok/s, ` +
      // @ts-ignore - TODO: strict typing
      `ttg: ${timeToGenerationSec !== null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
      // @ts-ignore - TODO: strict typing
      `generation: ${generationSec !== null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
      // @ts-ignore - TODO: strict typing
      `total: ${totalSec.toFixed(2)}s` +
      formatCostTag(estimatedCost),
  );
  // ── Build WAV from accumulated PCM audio chunks ───────────────
  let audioRef = null;
  // @ts-ignore - TODO: strict typing
  if (audioChunks.length > 0) {
    try {
      // @ts-ignore - TODO: strict typing
      const pcmBuffers = audioChunks.map((b64: Record<string, unknown>) =>
        // @ts-ignore - TODO: strict typing
        Buffer.from(b64, "base64"),
      );
      const pcmData = Buffer.concat(pcmBuffers);
      const numChannels = 1;
      const bitsPerSample = 16;
      // @ts-ignore - TODO: strict typing
      const byteRate = audioSampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(numChannels, 22);
      // @ts-ignore - TODO: strict typing
      wavHeader.writeUInt32LE(audioSampleRate, 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);
      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        "generations",
        // @ts-ignore - TODO: strict typing
        project,
        username,
      );
      audioRef = ref;
    } catch (error: unknown) {
      logger.error(
        // @ts-ignore - TODO: strict typing
        `[chat] Failed to build/upload Live API audio WAV: ${error.message}`,
      );
    }
  }
  // ── Request logging with sanitized payloads ────────────────────
  // Placed after audio build so audioRef is available for modality detection.
  // Agentic requests are logged granularly per-iteration by AgenticLoopService,
  // so we only log here for non-agentic paths (chat, live).
  // @ts-ignore - TODO: strict typing
  if (!options.agenticLoopEnabled) {
    RequestLogger.logChatGeneration({
      requestId,
      // @ts-ignore - TODO: strict typing
      endpoint: modelDef?.liveAPI ? "/live" : "/chat",
      // @ts-ignore - TODO: strict typing
      operation: modelDef?.liveAPI ? "live" : "chat",
      project,
      username,
      clientIp,
      agent,
      provider: providerName,
      model: resolvedModel,
      conversationId: conversationId || null,
      // When Direct Chat routes through /chat, agentSessionId maps the
      // request to the correct agent session for stats aggregation.
      agentSessionId: agentSessionId || conversationId || null,
      traceId: traceId || null,
      success: true,
      usage,
      estimatedCost,
      tokensPerSec,
      timeToGenerationSec,
      generationSec,
      totalSec,
      options,
      messages: originalMessages || messages,
      text,
      thinking,
      images,
      toolCalls,
      outputCharacters,
      audioRef,
      rateLimits,
    });
  }
  // ── Emit done event ───────────────────────────────────────────
  // @ts-ignore - TODO: strict typing
  if (!signal?.aborted) {
    // @ts-ignore - TODO: strict typing
    emit({
      type: "done",
      provider: providerName,
      model: resolvedModel,
      usage: usage || null,
      estimatedCost,
      tokensPerSec,
      ...(audioRef ? { audioRef } : {}),
      timeToGeneration:
        // @ts-ignore - TODO: strict typing
        timeToGenerationSec !== null ? roundMs(timeToGenerationSec) : null,
      // @ts-ignore - TODO: strict typing
      generationTime: generationSec !== null ? roundMs(generationSec) : null,
      // @ts-ignore - TODO: strict typing
      totalTime: roundMs(totalSec),
      // @ts-ignore - TODO: strict typing
      ...(traceId && { traceId }),
      // @ts-ignore - TODO: strict typing
      ...(conversationId && { conversationId }),
    });
  }
  // ── Conversation persistence ──────────────────────────────────
  if (conversationId) {
    let messagesToAppend: Record<string, unknown>[] = [];
    if (overrideMessagesToAppend) {
      // @ts-ignore - TODO: strict typing
      messagesToAppend = [...overrideMessagesToAppend];
      // When the agentic loop ran multiple iterations, intermediate assistant
      // messages already carry their own content + toolCalls. Attaching the
      // full-turn contentSegments/textFragments to the final message would
      // duplicate that content on page refresh (each intermediate message
      // renders its own content, then segments re-render everything again).
      // Only include segments on single-iteration turns where the final
      // message is the sole assistant message — segments preserve the
      // thinking ↔ tools ↔ text interleaving for that case.
      // @ts-ignore
      const hasIntermediateToolMessages = overrideMessagesToAppend.some(
        // @ts-ignore - TODO: strict typing
        (m: Record<string, unknown>) => m.role === "assistant" && m.toolCalls?.length > 0,
      );
      // Append the final LLM response block (contains telemetry and final text step)
      // @ts-ignore
      messagesToAppend.push({
        role: "assistant",
        content: text,
        // @ts-ignore - TODO: strict typing
        ...(thinking && { thinking }),
        // @ts-ignore - TODO: strict typing
        ...(thinkingSignature && { thinkingSignature }),
        // @ts-ignore - TODO: strict typing
        ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
        // Include toolCalls on the final message if no intermediate message
        // already persists them. The regular agentic loop embeds toolCalls in
        // intermediate assistant messages (overrideMessagesToAppend), but
        // native MCP tool calls (e.g. LM Studio) bypass that path — without
        // this, tool calls vanish on page refresh.
        ...(!hasIntermediateToolMessages &&
          // @ts-ignore - TODO: strict typing
          toolCalls.length > 0 && { toolCalls }),
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
        // @ts-ignore - TODO: strict typing
        totalTime: roundMs(totalSec),
        tokensPerSec,
        estimatedCost,
        // Display segment metadata — preserves interleaving order for Prism Client.
        // Only attach when there are NO intermediate tool-calling messages;
        // otherwise intermediate messages already carry their own content and
        // the segments would cause duplicate rendering on page refresh.
        ...(!hasIntermediateToolMessages &&
          // @ts-ignore - TODO: strict typing
          contentSegments?.length > 0 && { contentSegments }),
        ...(!hasIntermediateToolMessages &&
          // @ts-ignore - TODO: strict typing
          textFragments?.length > 0 && { textFragments }),
        ...(!hasIntermediateToolMessages &&
          // @ts-ignore - TODO: strict typing
          thinkingFragments?.length > 0 && { thinkingFragments }),
        // Generation settings — source of truth per request
        generationSettings: {
          // @ts-ignore - TODO: strict typing
          temperature: options.temperature,
          // @ts-ignore - TODO: strict typing
          maxTokens: options.maxTokens,
          // @ts-ignore - TODO: strict typing
          thinkingEnabled: options.thinkingEnabled || false,
          // @ts-ignore - TODO: strict typing
          ...(options.reasoningEffort && {
            // @ts-ignore - TODO: strict typing
            reasoningEffort: options.reasoningEffort,
          }),
          // @ts-ignore - TODO: strict typing
          ...(options.thinkingBudget && {
            // @ts-ignore - TODO: strict typing
            thinkingBudget: options.thinkingBudget,
          }),
        },
      });
    } else {
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
      messagesToAppend.push({
        role: "assistant",
        content: text,
        // @ts-ignore - TODO: strict typing
        ...(thinking && { thinking }),
        // @ts-ignore - TODO: strict typing
        ...(thinkingSignature && { thinkingSignature }),
        // @ts-ignore - TODO: strict typing
        ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
        // @ts-ignore - TODO: strict typing
        ...(toolCalls.length > 0 && { toolCalls }),
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
        // @ts-ignore - TODO: strict typing
        totalTime: roundMs(totalSec),
        tokensPerSec,
        estimatedCost,
        // Generation settings — source of truth per request
        generationSettings: {
          // @ts-ignore - TODO: strict typing
          temperature: options.temperature,
          // @ts-ignore - TODO: strict typing
          maxTokens: options.maxTokens,
          // @ts-ignore - TODO: strict typing
          thinkingEnabled: options.thinkingEnabled || false,
          // @ts-ignore - TODO: strict typing
          ...(options.reasoningEffort && {
            // @ts-ignore - TODO: strict typing
            reasoningEffort: options.reasoningEffort,
          }),
          // @ts-ignore - TODO: strict typing
          ...(options.thinkingBudget && {
            // @ts-ignore - TODO: strict typing
            thinkingBudget: options.thinkingBudget,
          }),
        },
      });
    }
    const meta = conversationMeta
      ? {
          ...conversationMeta,
          settings: { provider: providerName, model: resolvedModel },
        }
      : undefined;
    // Merge parentAgentSessionId, workspaceRoot, and agent into meta for persistence
    let finalMeta = meta;
    if (parentAgentSessionId) {
      // @ts-ignore - TODO: strict typing
      finalMeta = { ...(finalMeta || {}), parentAgentSessionId };
    }
    if (workspaceRoot) {
      // @ts-ignore - TODO: strict typing
      finalMeta = { ...(finalMeta || {}), workspaceRoot };
    }
    if (agent) {
      // @ts-ignore - TODO: strict typing
      finalMeta = { ...(finalMeta || {}), agent };
    }
    appendAndFinalize(
      // @ts-ignore - TODO: strict typing
      conversationId,
      project,
      username,
      messagesToAppend,
      finalMeta,
      // @ts-ignore - TODO: strict typing
      getCollectionOpts(project),
    );
  }
}

export { getCollectionOpts };

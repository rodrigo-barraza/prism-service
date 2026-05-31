import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import { SSE_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
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
import { TokenUsage, MessagePayload, ToolCallPayload, LlmOptions } from "../../RequestLogger.ts";

export interface FinalizerContext {
  providerName: string;
  resolvedModel: string;
  modelDef?: Record<string, unknown> | null;
  messages: MessagePayload[];
  originalMessages?: MessagePayload[];
  options: LlmOptions;
  conversationId?: string | null;
  agentSessionId?: string | null;
  parentAgentSessionId?: string | null;
  userMessage?: MessagePayload | null;
  conversationMeta?: Record<string, unknown> | null;
  traceId?: string | null;
  project?: string | null;
  username?: string | null;
  clientIp?: string | null;
  agent?: string | null;
  workspaceRoot?: string | null;
  requestId?: string;
  emit?: (event: { type: string; [key: string]: unknown }) => void;
  signal?: AbortSignal;
}

export interface FinalizerPayload {
  text: string | null;
  thinking: string | null;
  thinkingSignature?: string | null;
  images?: string[];
  toolCalls?: ToolCallPayload[];
  audioChunks?: string[];
  audioSampleRate?: number;
  usage?: TokenUsage | null;
  outputCharacters?: number;
  timeToGenerationSec?: number | null;
  generationSec?: number | null;
  totalSec?: number | null;
  rateLimits?: Record<string, unknown> | null;
  contentSegments?: unknown[];
  textFragments?: unknown[];
  thinkingFragments?: unknown[];
}

/**
 * Resolve the MongoDB collection for conversation persistence.
 * Agent projects go to agent_conversations; everything else to model_conversations.
 */
function getCollectionOpts(project: string | null | undefined) {
  if (AgentPersonaRegistry.isAgentProject(project || "")) {
    return { collection: COLLECTIONS.AGENT_CONVERSATIONS };
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
  context: FinalizerContext,
  {
    text,
    thinking,
    thinkingSignature,
    images = [],
    toolCalls = [],
    audioChunks = [],
    audioSampleRate = 16000,
    usage,
    outputCharacters = 0,
    timeToGenerationSec,
    generationSec,
    totalSec,
    rateLimits,
    // Display segment metadata (from AgenticLoopService)
    contentSegments,
    textFragments,
    thinkingFragments,
  }: FinalizerPayload,
    overrideMessagesToAppend: MessagePayload[] | null = null,
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

/**
 * Swap content and rawContent if present to ensure the database and caller get clean text.
 * Fallback to regex parsing for legacy/unmigrated messages to populate rawContent and clean content.
 */
function swapMsgContent(message: MessagePayload) {
  if (message.role === "user" && typeof message.content === "string") {
    if (message.rawContent?.startsWith("[System Context]") || message.rawContent?.startsWith("[System Context - Local Time:")) {
      return;
    }
    if (message.rawContent) {
      const dirty = message.content;
      message.content = message.rawContent;
      message.rawContent = dirty;
    } else if (message.content.startsWith("[System Context]")) {
      const dirty = message.content;
      let clean = message.content;
      const splitIdx = message.content.indexOf("\n\n[User Message]\n");
      if (splitIdx !== -1) {
        clean = message.content.substring(splitIdx + "\n\n[User Message]\n".length);
      } else {
        const altSplit = message.content.indexOf("[User Message]\n");
        if (altSplit !== -1) {
          clean = message.content.substring(altSplit + "[User Message]\n".length);
        }
      }
      message.content = clean;
      message.rawContent = dirty;
    } else if (message.content.startsWith("[System Context - Local Time:")) {
      const dirty = message.content;
      let clean = message.content;
      const index = message.content.indexOf("]\n\n");
      if (index !== -1) {
        clean = message.content.slice(index + 3);
      }
      message.content = clean;
      message.rawContent = dirty;
    }
  }
}

  // Swap content and rawContent if present to ensure the database and caller get clean text
  if (messages) {
    for (const message of messages) {
      swapMsgContent(message);
    }
  }
  if (overrideMessagesToAppend) {
    for (const message of overrideMessagesToAppend) {
      swapMsgContent(message);
    }
  }
  if (userMessage) {
    swapMsgContent(userMessage);
  }
  // ── Cost calculation ──────────────────────────────────────────
  let estimatedCost: number | null = null;
  let tokensPerSec: number | null = null;
  if (usage) {
        const imageCount = images.length;
    if (imageCount > 0) {
      const imgPricing =
                getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel] || (modelDef?.pricing as Record<string, number>);
      if (imgPricing?.imageOutputPerMillion) {
        // Derive image tokens dynamically from the API-reported total.
        // The API's outputTokens already includes both text and image tokens,
        // so we estimate text tokens from the generated text length (~4 chars/token)
        // and attribute the remainder to images. This adapts to any resolution
        // (512px≈747tok, 1024px≈1120tok, 2048px≈1680tok, 4096px≈2520tok).
                const estimatedTextOutputTokens = Math.ceil((text?.length || 0) / 4);
        const imageTokens = Math.max(
          0,
                    (usage.outputTokens || 0) - estimatedTextOutputTokens,
        );
                const textOutputTokens = Math.max(0, (usage.outputTokens || 0) - imageTokens);
        const inputCost =
                    ((usage.inputTokens || 0) / 1_000_000) * (imgPricing.inputPerMillion || 0);
        const textOutCost =
          (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
        const imageOutCost =
          (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
        estimatedCost = parseFloat(
          (inputCost + textOutCost + imageOutCost).toFixed(8),
        );
      } else {
                const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
                estimatedCost = calculateTextCost(usage as Parameters<typeof calculateTextCost>[0], pricing);
      }
    } else {
            const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
            estimatedCost = calculateTextCost(usage as Parameters<typeof calculateTextCost>[0], pricing);
    }
        tokensPerSec = calculateTokensPerSec(usage.outputTokens || 0, generationSec, {
            providerReported: usage.tokensPerSec as number | undefined,
      fallbackSec: totalSec,
    });
  }
  // ── Console logging ───────────────────────────────────────────
    const inputTokens = usage ? getTotalInputTokens(usage as Parameters<typeof getTotalInputTokens>[0]) : 0;
    const outputTokens = usage?.outputTokens || 0;
  const tokensPerSecStr =
    tokensPerSec !== null ? tokensPerSec.toFixed(1) : "N/A";
  const cacheInfo =
        usage?.cacheReadInputTokens || usage?.cacheCreationInputTokens
            ? `, cache_read: ${usage.cacheReadInputTokens || 0}, cache_write: ${usage.cacheCreationInputTokens || 0}`
      : "";
  logger.request(
    project || "",
    username as string,
    clientIp || null,
    `[chat] ${providerName} ${resolvedModel} — ` +
      `in: ${inputTokens} tokens, out: ${outputTokens} tokens${cacheInfo}, ` +
      `speed: ${tokensPerSecStr} tok/s, ` +
            `ttg: ${timeToGenerationSec != null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
            `generation: ${generationSec != null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
            `total: ${totalSec != null ? totalSec.toFixed(2) : "0.00"}s` +
      formatCostTag(estimatedCost),
  );
  // ── Build WAV from accumulated PCM audio chunks ───────────────
  let audioRef: string | null = null;
    if (audioChunks.length > 0) {
    try {
            const pcmBuffers = audioChunks.map((b64) =>
                Buffer.from(b64, "base64"),
      );
      const pcmData = Buffer.concat(pcmBuffers);
      const numChannels = 1;
      const bitsPerSample = 16;
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
                project as string,
        username || "system",
      );
      audioRef = ref;
    } catch (error: unknown) {
      logger.error(
                `[chat] Failed to build/upload Live API audio WAV: ${(error as Error).message}`,
      );
    }
  }
  // ── Request logging with sanitized payloads ────────────────────
  // Placed after audio build so audioRef is available for modality detection.
  // Agentic requests are logged granularly per-iteration by AgenticLoopService,
  // so we only log here for non-agentic paths (chat, live).
    if (!options.agenticLoopEnabled) {
    RequestLogger.logChatGeneration({
      requestId,
            endpoint: modelDef?.liveAPI ? "/live" : "/chat",
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
      usage: usage || undefined,
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
  // ── Conversation persistence ──────────────────────────────────
  // IMPORTANT: Persist BEFORE emitting `done` so the client's post-stream
  // DB fetch sees the complete conversation. Previously, `done` fired first
  // and `appendAndFinalize` was fire-and-forget, causing a race condition
  // where the client fetched stale data from MongoDB.
  if (conversationId) {
    let messagesToAppend: MessagePayload[] = [];
    if (overrideMessagesToAppend) {
            messagesToAppend = [...overrideMessagesToAppend];
      // When the agentic loop ran multiple iterations, intermediate assistant
      // messages already carry their own content + toolCalls. Attaching the
      // full-turn contentSegments/textFragments to the final message would
      // duplicate that content on page refresh (each intermediate message
      // renders its own content, then segments re-render everything again).
      // Only include segments on single-iteration turns where the final
      // message is the sole assistant message — segments preserve the
      // thinking ↔ tools ↔ text interleaving for that case.
            const hasIntermediateToolMessages = overrideMessagesToAppend.some(
                (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
      );
      // Append the final LLM response block (contains telemetry and final text step)
            messagesToAppend.push({
        role: "assistant",
        content: text,
                ...(thinking && { thinking }),
                ...(thinkingSignature && { thinkingSignature }),
                ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
        // Include toolCalls on the final message if no intermediate message
        // already persists them. The regular agentic loop embeds toolCalls in
        // intermediate assistant messages (overrideMessagesToAppend), but
        // native MCP tool calls (e.g. LM Studio) bypass that path — without
        // this, tool calls vanish on page refresh.
        ...(!hasIntermediateToolMessages &&
                    toolCalls.length > 0 && { toolCalls }),
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
                totalTime: totalSec != null ? roundMs(totalSec as number) : null,
        tokensPerSec,
        estimatedCost,
        // Display segment metadata — preserves interleaving order for Prism Client.
        // Only attach when there are NO intermediate tool-calling messages;
        // otherwise intermediate messages already carry their own content and
        // the segments would cause duplicate rendering on page refresh.
        ...(!hasIntermediateToolMessages &&
                    contentSegments?.length ? { contentSegments } : {}),
        ...(!hasIntermediateToolMessages &&
                    textFragments?.length ? { textFragments } : {}),
        ...(!hasIntermediateToolMessages &&
                    thinkingFragments?.length ? { thinkingFragments } : {}),
        // Generation settings — source of truth per request
        generationSettings: {
                    temperature: options.temperature,
                    maxTokens: options.maxTokens,
                    thinkingEnabled: options.thinkingEnabled || false,
                    ...(options.reasoningEffort ? {
                        reasoningEffort: options.reasoningEffort,
          } : {}),
                    ...(options.thinkingBudget ? {
                        thinkingBudget: options.thinkingBudget,
          } : {}),
        },
      });
    } else {
      // Only append the user message on the first call for this turn
      // (indicated by conversationMeta). Follow-up tool iterations reuse
      // the same conversationId but omit conversationMeta, so the user
      // message is already persisted from the first call.
      if (userMessage && conversationMeta) {
        messagesToAppend.push({
          ...userMessage,
          role: "user",
                    timestamp: userMessage.timestamp || new Date().toISOString(),
        });
      }
      messagesToAppend.push({
        role: "assistant",
        content: text,
                ...(thinking && { thinking }),
                ...(thinkingSignature && { thinkingSignature }),
                ...(images.length > 0 && { images }),
        ...(audioRef && { audio: audioRef }),
                ...(toolCalls.length > 0 && { toolCalls }),
        model: resolvedModel,
        provider: providerName,
        timestamp: new Date().toISOString(),
        usage: usage || null,
                totalTime: totalSec != null ? roundMs(totalSec as number) : null,
        tokensPerSec,
        estimatedCost,
        // Generation settings — source of truth per request
        generationSettings: {
                    temperature: options.temperature,
                    maxTokens: options.maxTokens,
                    thinkingEnabled: options.thinkingEnabled || false,
                    ...(options.reasoningEffort ? {
                        reasoningEffort: options.reasoningEffort,
          } : {}),
                    ...(options.thinkingBudget ? {
                        thinkingBudget: options.thinkingBudget,
          } : {}),
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
    let finalMeta: Record<string, unknown> | undefined = meta as Record<string, unknown> | undefined;
    if (parentAgentSessionId) {
            finalMeta = { ...(finalMeta || {}), parentAgentSessionId };
    }
    if (workspaceRoot) {
            finalMeta = { ...(finalMeta || {}), workspaceRoot };
    }
    if (agent) {
            finalMeta = { ...(finalMeta || {}), agent };
    }
    // Ensure all user messages to append are properly swapped/sanitized,
    // then filter out synthetic compaction artifacts that should never
    // reach MongoDB (context notes, compaction summaries, cleared stubs).
    const sanitizedMessagesToAppend = messagesToAppend
      .map((message) => {
        const cloned = { ...message };
        swapMsgContent(cloned);
        return cloned;
      })
      .filter((message) => {
        if (message.role === "user" && typeof message.content === "string") {
          if (message.content.startsWith("[CONTEXT NOTE:")) return false;
          if (message.content.startsWith("[Conversation Summary")) return false;
          if ((message as Record<string, unknown>).isCompactSummary === true) return false;
        }
        // Strip ephemeral planning injection messages (cache-stable planning mode)
        if ((message as Record<string, unknown>)._isPlanningInjection === true) return false;
        // Strip eagerly-persisted messages (timer reminders, scheduled task triggers)
        // that were already appended to MongoDB before the agentic loop ran
        if ((message as Record<string, unknown>)._alreadyPersisted === true) return false;
        return true;
      });

    await appendAndFinalize(
      conversationId || "",
      project || "",
      username as string,
      sanitizedMessagesToAppend,
      finalMeta,
            getCollectionOpts(project),
    );
  }
  // ── Emit done event ───────────────────────────────────────────
  // Emitted AFTER persistence so the client's post-stream DB fetch
  // is guaranteed to see the complete, up-to-date conversation.
    if (!signal?.aborted) {
        if (emit) {
          emit({
            type: SSE_EVENT_TYPES.DONE,
            provider: providerName,
            model: resolvedModel,
            usage: usage || null,
            estimatedCost,
            tokensPerSec,
            ...(audioRef ? { audioRef } : {}),
            timeToGeneration:
                      timeToGenerationSec != null ? roundMs(timeToGenerationSec) : null,
                  generationTime: generationSec != null ? roundMs(generationSec) : null,
                  totalTime: totalSec != null ? roundMs(totalSec) : null,
                  ...(traceId && { traceId }),
                  ...(conversationId && { conversationId }),
          });
        }
  }
}

export { getCollectionOpts };

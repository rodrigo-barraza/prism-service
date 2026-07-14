import {
  formatCostTag,
  roundMilliseconds,
} from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  calculateTextCost,
  getTotalInputTokens,
  withTotalInputTokens,
} from "#src/utils/CostCalculator";
import { calculateTokensPerSec } from "#src/utils/math";
import { MODALITY_TYPES, getPricing } from "#src/config";
import RequestLogger from "#src/services/RequestLogger";
import FileService from "#src/services/FileService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { resolveToolEntriesToSet } from "#src/utils/resolveToolEntriesToSet";
import ToolContext from "#src/services/ToolContext";
import { appendAndFinalize } from "#src/utils/ConversationUtilities";
import {
  COLLECTIONS,
  FILE_CATEGORIES,
  PROMPT_DELIMITERS,
  MEDIA,
} from "#src/constants";
import logger from "#src/utils/logger";
import {
  TokenUsage,
  MessagePayload,
  ToolCallPayload,
  LlmOptions,
} from "#src/services/RequestLogger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

export interface FinalizerContext {
  providerName: string;
  resolvedModel: string;
  modelDefinition?: Record<string, unknown> | null;
  messages: MessagePayload[];
  originalMessages?: MessagePayload[];
  options: LlmOptions;
  conversationId: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
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

import type { ContextBudgetSnapshot } from "#src/services/harnesses/ContextBudgetTracker";

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
  resolvedEnabledTools?: string[] | null;
  contextBudget?: ContextBudgetSnapshot;
  /** Accumulated thinking phase duration across all iterations (seconds). */
  thinkingDurationSeconds?: number | null;
  /** Accumulated content generation phase duration across all iterations (seconds). */
  contentDurationSeconds?: number | null;
  conversationOutcome?: string | null;
}

/**
 * Resolve the MongoDB collection for conversation persistence.
 * Agent requests always go to agent_conversations; everything else to model_conversations.
 */
function getCollectionOpts(
  project: string | null | undefined,
  agent?: string | null,
) {
  if (agent || AgentPersonaRegistry.isAgentProject(project || "")) {
    return { collection: COLLECTIONS.AGENT_CONVERSATIONS };
  }
  return undefined;
}

/**
 * Swap content and rawContent if present to ensure the database and caller get clean text.
 * Fallback to regex parsing for legacy/unmigrated messages to populate rawContent and clean content.
 */
export function swapMessageContent(message: MessagePayload) {
  if (message.role === "user" && typeof message.content === "string") {
    if (
      message.rawContent?.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT) ||
      message.rawContent?.startsWith(
        PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX,
      )
    ) {
      return;
    }
    if (message.rawContent) {
      const dirty = message.content;
      message.content = message.rawContent;
      message.rawContent = dirty;
    } else if (message.content.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT)) {
      const dirty = message.content;
      let clean = message.content;
      const splitDelimiter = "\n\n" + PROMPT_DELIMITERS.USER_MESSAGE + "\n";
      const splitIndex = message.content.indexOf(splitDelimiter);
      if (splitIndex !== -1) {
        clean = message.content.substring(splitIndex + splitDelimiter.length);
      } else {
        const altDelimiter = PROMPT_DELIMITERS.USER_MESSAGE + "\n";
        const altSplit = message.content.indexOf(altDelimiter);
        if (altSplit !== -1) {
          clean = message.content.substring(altSplit + altDelimiter.length);
        }
      }
      message.content = clean;
      message.rawContent = dirty;
    } else if (
      message.content.startsWith(
        PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX,
      )
    ) {
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
export interface DeferredDoneEvent {
  type: string;
  [key: string]: unknown;
}

export async function finalizeTextGeneration(
  context: FinalizerContext,
  {
    text,
    thinking,
    thinkingSignature,
    images = [],
    toolCalls = [],
    audioChunks = [],
    audioSampleRate = MEDIA.DEFAULT_AUDIO_SAMPLE_RATE_HZ,
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
    resolvedEnabledTools,
    contextBudget,
    thinkingDurationSeconds,
    contentDurationSeconds,
    conversationOutcome,
  }: FinalizerPayload,
  overrideMessagesToAppend: MessagePayload[] | null = null,
  finalizerOptions?: { deferDoneEmission?: boolean },
): Promise<DeferredDoneEvent | null> {
  const {
    providerName,
    resolvedModel,
    modelDefinition,
    messages,
    originalMessages,
    options,
    conversationId,
    agentConversationId,
    parentAgentConversationId,
    parentConversationId,
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

  // Swap content and rawContent if present to ensure the database and caller get clean text
  if (messages) {
    for (const message of messages) {
      swapMessageContent(message);
    }
  }
  if (overrideMessagesToAppend) {
    for (const message of overrideMessagesToAppend) {
      swapMessageContent(message);
    }
  }
  if (userMessage) {
    swapMessageContent(userMessage);
  }
  // ── Cost calculation ──────────────────────────────────────────
  let estimatedCost: number | null = null;
  let tokensPerSec: number | null = null;
  if (usage) {
    const imageCount = images.length;
    if (imageCount > 0) {
      const imgPricing =
        getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.IMAGE)[resolvedModel] ||
        (modelDefinition?.pricing as Record<string, number>);
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
        const textOutputTokens = Math.max(
          0,
          (usage.outputTokens || 0) - imageTokens,
        );
        const inputCost =
          ((usage.inputTokens || 0) / 1_000_000) *
          (imgPricing.inputPerMillion || 0);
        const textOutCost =
          (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
        const imageOutCost =
          (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
        estimatedCost = parseFloat(
          (inputCost + textOutCost + imageOutCost).toFixed(8),
        );
      } else {
        const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[resolvedModel];
        estimatedCost = calculateTextCost(usage, pricing);
      }
    } else {
      const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[resolvedModel];
      estimatedCost = calculateTextCost(usage, pricing);
    }
    tokensPerSec = calculateTokensPerSec(
      usage.outputTokens || 0,
      generationSec,
      {
        providerReported: usage.tokensPerSec as number | undefined,
        fallbackSec: totalSec,
      },
    );
  }
  // ── Console logging ───────────────────────────────────────────
  const inputTokens = usage ? getTotalInputTokens(usage) : 0;
  const outputTokens = usage?.outputTokens || 0;
  const tokensPerSecondString =
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
      `speed: ${tokensPerSecondString} tok/s, ` +
      `ttg: ${timeToGenerationSec != null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
      `generation: ${generationSec != null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
      `total: ${totalSec != null ? totalSec.toFixed(2) : "0.00"}s` +
      formatCostTag(estimatedCost),
  );
  // ── Build WAV from accumulated PCM audio chunks ───────────────
  let audioRef: string | null = null;
  if (audioChunks.length > 0) {
    try {
      const pcmBuffers = audioChunks.map((b64) => Buffer.from(b64, "base64"));
      const pcmData = Buffer.concat(pcmBuffers);
      const numberOfChannels = 1;
      const bitsPerSample = 16;
      const byteRate = audioSampleRate * numberOfChannels * (bitsPerSample / 8);
      const blockAlign = numberOfChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(numberOfChannels, 22);
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
        FILE_CATEGORIES.GENERATIONS,
        project as string,
        username || "system",
      );
      audioRef = ref;
    } catch (error: unknown) {
      logger.error(
        `[chat] Failed to build/upload Live API audio WAV: ${getErrorMessage(error)}`,
      );
    }
  }
  // ── Request logging with sanitized payloads ────────────────────
  // Placed after audio build so audioRef is available for modality detection.
  // Agentic requests are logged granularly per-iteration by AgenticLoopService,
  // so we only log here for non-agentic paths (chat, live).
  //
  // AWAITED: appendAndFinalize's rollup aggregates the requests collection,
  // so this turn's request row must be written before persistence runs.
  if (!options.agenticLoopEnabled) {
    await RequestLogger.logChatGeneration({
      requestId,
      endpoint: modelDefinition?.liveAPI ? "/live" : "/chat",
      operation: modelDefinition?.liveAPI ? "live" : "chat",
      project,
      username,
      clientIp,
      agent,
      provider: providerName,
      model: resolvedModel,
      conversationId,
      agentConversationId: agentConversationId || null,
      parentAgentConversationId: parentAgentConversationId || null,
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
  //
  // Sub-agents share the parent's conversationId for telemetry correlation but
  // must NOT persist their messages into the parent conversation document —
  // their output is returned via the create_subagents tool call result instead.
  if (conversationId) {
    const messagesToAppend = assembleMessagesToAppend({
      overrideMessagesToAppend,
      text,
      thinking,
      thinkingSignature,
      images,
      audioReference: audioRef,
      toolCalls,
      resolvedModel,
      providerName,
      usage,
      totalSeconds: totalSec,
      tokensPerSecond: tokensPerSec,
      estimatedCost,
      contentSegments,
      textFragments,
      thinkingFragments,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      thinkingEnabled: options.thinkingEnabled,
      reasoningEffort: options.reasoningEffort,
      thinkingBudget: options.thinkingBudget,
      thinkingDurationSeconds,
      contentDurationSeconds,
      userMessage,
      conversationMeta,
    });
    let toolConfig: Record<string, unknown> | undefined = undefined;
    if (resolvedEnabledTools) {
      const existingSettings = conversationMeta?.settings as
        | Record<string, unknown>
        | undefined;
      const existingToolConfig = existingSettings?.toolConfig as
        | Record<string, unknown>
        | undefined;
      const rawDisabledTools: string[] =
        (Array.isArray(options.disabledTools) ? options.disabledTools : null) ||
        (Array.isArray(existingToolConfig?.disabledTools)
          ? (existingToolConfig.disabledTools as string[])
          : null) ||
        [];
      // Remove dynamically enabled tools from the persisted disabled list.
      // The agent may have called enable_tools / discover_and_enable_tools
      // mid-generation, which adds tools to resolvedEnabledTools. Without
      // this filter, the client restores a stale disabled list on
      // change-stream refresh, reverting the UI checkboxes.
      const dynamicEnabledSet = new Set(resolvedEnabledTools);
      const disabledTools = rawDisabledTools.filter(
        (toolName) => !dynamicEnabledSet.has(toolName),
      );
      let availableTools: string[] = [];
      if (agent) {
        const persona = AgentPersonaRegistry.get(agent);
        if (persona) {
          const clientSchemas =
            ToolOrchestratorService.getClientToolSchemas() || [];
          const resolvedAvailable = resolveToolEntriesToSet(
            persona.availableTools,
            clientSchemas,
          );
          availableTools = [...resolvedAvailable];
        }
      } else {
        const clientSchemas =
          ToolOrchestratorService.getClientToolSchemas() || [];
        availableTools = clientSchemas.map((toolSchema) => toolSchema.name);
      }
      // Persist the dynamically enabled tool names so the client can
      // reconcile checkbox state on conversation restore using the same
      // enableSpecificTools() flow as the live SSE TOOL_SET_CHANGED path.
      const dynamicEnabledTools = agentConversationId
        ? (ToolContext.get<string[]>(agentConversationId, "dynamicEnabledTools") || [])
        : [];
      toolConfig = {
        availableTools,
        disabledTools,
        dynamicEnabledTools,
      };
    }

    const mergedSettings: Record<string, unknown> = {
      ...(conversationMeta?.settings || {}),
      provider: providerName,
      model: resolvedModel,
      agent: agent || undefined,
      workspaceRoot: workspaceRoot || undefined,
      toolConfig: toolConfig || undefined,
      harness: options.harness || undefined,
      topology: options.topology || undefined,
      thoughtStructure: options.thoughtStructure || undefined,
      locale: options.locale || undefined,
    };
    if (options.thinkingEnabled != null) mergedSettings.thinkingEnabled = options.thinkingEnabled;
    if (options.thinkingBudget != null) mergedSettings.thinkingBudget = options.thinkingBudget;
    if (options.thinkingLevel) mergedSettings.thinkingLevel = options.thinkingLevel;
    if (options.reasoningEffort) mergedSettings.reasoningEffort = options.reasoningEffort;

    const finalMeta: Record<string, unknown> = {
      ...(conversationMeta || {}),
      settings: mergedSettings,
    };

    if (parentAgentConversationId) {
      finalMeta.parentAgentConversationId = parentAgentConversationId;
      finalMeta.isSubAgent = true;
    }
    if (parentConversationId) {
      finalMeta.parentConversationId = parentConversationId;
    }
    if (workspaceRoot) {
      finalMeta.workspaceRoot = workspaceRoot;
    }
    if (agent) {
      finalMeta.agent = agent;
    }
    if (conversationOutcome !== undefined) {
      finalMeta.conversationOutcome = conversationOutcome;
    }
    // Persist the latest context budget snapshot on the conversation document
    // so the client can display it when users switch between conversations.
    // All agent conversations (including sub-agents) track their own budget.
    if (contextBudget) {
      finalMeta.contextBudget = contextBudget;
    }
    // Ensure all user messages to append are properly swapped/sanitized,
    // then filter out synthetic compaction artifacts that should never
    // reach MongoDB (context notes, compaction summaries, cleared stubs).
    const sanitizedMessagesToAppend =
      sanitizeMessagesForPersistence(messagesToAppend);

    await appendAndFinalize(
      conversationId || "",
      project || "",
      username as string,
      sanitizedMessagesToAppend,
      finalMeta,
      {
        ...getCollectionOpts(project, agent),
        // When deferring the done event (non-blocking sub-agent dispatch),
        // keep isGenerating=true in MongoDB so clients loading the conversation
        // from the database see it as still active. The auto-response's own
        // finalize call will clear the flag when the full cycle completes.
        ...(finalizerOptions?.deferDoneEmission && { skipGeneratingClear: true }),
      },
    );
  }
  // ── Emit done event ───────────────────────────────────────────
  // Emitted AFTER persistence so the client's post-stream DB fetch
  // is guaranteed to see the complete, up-to-date conversation.
  //
  // When deferDoneEmission is true, the done event is NOT emitted here
  // but returned to the caller so it can be emitted later (e.g., after
  // non-blocking sub-agent dispatches settle). This prevents the client
  // from treating the generation as complete while sub-agents are running.
  if (!signal?.aborted) {
    const doneEventPayload: DeferredDoneEvent = {
      type: SERVER_SENT_EVENT_TYPES.DONE,
      provider: providerName,
      model: resolvedModel,
      usage: withTotalInputTokens(usage) || null,
      estimatedCost,
      tokensPerSec,
      ...(audioRef ? { audioRef } : {}),
      timeToGeneration:
        timeToGenerationSec != null
          ? roundMilliseconds(timeToGenerationSec)
          : null,
      generationTime:
        generationSec != null ? roundMilliseconds(generationSec) : null,
      totalTime: totalSec != null ? roundMilliseconds(totalSec) : null,
      ...(thinkingDurationSeconds != null && { thinkingDurationSeconds }),
      ...(contentDurationSeconds != null && { contentDurationSeconds }),
      ...(traceId && { traceId }),
      ...(conversationId && { conversationId }),
    };

    if (finalizerOptions?.deferDoneEmission) {
      return doneEventPayload;
    }

    if (emit) {
      emit(doneEventPayload);
    }
  }

  return null;
}

export { getCollectionOpts };

/**
 * Expand assistant messages with embedded tool call results into the
 * industry-standard canonical format for persistence.
 *
 * During the live agentic loop, tool call results are embedded directly
 * inside the assistant message's `toolCalls[].result` field for
 * convenience. This compact format produces consecutive assistant
 * messages in the database because there are no interleaving tool-role
 * messages to maintain the alternating conversation contract.
 *
 * This function transforms each compact assistant message into:
 *   assistant: { toolCalls: [{ id, name, args }] }  (results stripped)
 *   tool:      { tool_call_id, name, content }       (one per tool call)
 *
 * The result is the standard format used by OpenAI, Anthropic, and
 * Google — tool results are always separate messages. Providers that
 * require `role: "user"` for tool results (Anthropic, Google) transform
 * at their own adapter layer.
 *
 * Shared between production finalizer and test assertion suites.
 */
export function expandToolCallsForPersistence(
  messages: MessagePayload[],
): MessagePayload[] {
  const expanded: MessagePayload[] = [];

  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      // Check if any tool call has an embedded result — if none do,
      // the message is already in canonical format (or is a fresh call
      // that hasn't been executed yet).
      const hasEmbeddedResults = message.toolCalls.some(
        (toolCall) => (toolCall as unknown as Record<string, unknown>).result !== undefined,
      );

      if (hasEmbeddedResults) {
        // Push the assistant message with toolCalls but WITHOUT results
        const cleanedToolCalls: ToolCallPayload[] = message.toolCalls.map(
          (toolCall) => {
            const { result: _result, status: _status, ...cleanedFields } =
              toolCall as ToolCallPayload & {
                result?: unknown;
                status?: string;
              };
            return cleanedFields;
          },
        );

        expanded.push({
          ...message,
          toolCalls: cleanedToolCalls,
        });

        // Push separate tool-role messages for each result,
        // inheriting requestId from the parent assistant message.
        const parentRequestId = message.requestId;
        for (const toolCall of message.toolCalls) {
          const toolCallWithResult = toolCall as ToolCallPayload & {
            result?: unknown;
            status?: string;
          };
          const resultValue = toolCallWithResult.result ?? null;

          expanded.push({
            role: "tool",
            tool_call_id: toolCall.id || null,
            name: toolCall.name,
            content:
              typeof resultValue === "string"
                ? resultValue
                : JSON.stringify(resultValue),
            ...(toolCallWithResult.durationMilliseconds !== undefined && {
              durationMilliseconds: toolCallWithResult.durationMilliseconds,
            }),
            ...(parentRequestId && { requestId: parentRequestId }),
          });
        }
      } else {
        // No embedded results — pass through as-is
        expanded.push(message);
      }
    } else if (
      message.role === "assistant" &&
      !message.content?.toString().trim() &&
      (!message.toolCalls || message.toolCalls.length === 0)
    ) {
      // Strip empty assistant stubs — no content and no tool calls.
      // These are artifacts from intermediate loop iterations that
      // produced no output.
      continue;
    } else {
      expanded.push(message);
    }
  }

  return expanded;
}

/**
 * Sanitize messages for MongoDB persistence — clones each message,
 * applies content/rawContent swapping, strips runtime-only tags,
 * filters out synthetic compaction artifacts, and expands compact
 * assistant messages with embedded tool results into separate
 * role="tool" messages per the industry-standard canonical format.
 *
 * System context messages (_isInjectedContext) are preserved for
 * conversation history visibility; only the internal marker flag
 * is cleaned from the persisted payload.
 *
 * Shared between production finalizer and test assertion suites.
 */
export function sanitizeMessagesForPersistence(
  messagesToAppend: MessagePayload[],
): MessagePayload[] {
  const filtered = messagesToAppend
    .filter((message) => {
      if (message._isIdentityPrompt === true) return false;

      if (message.role === "user" && typeof message.content === "string") {
        if (message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX))
          return false;
        if (
          message.content.startsWith(
            PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX,
          )
        )
          return false;
        if (message.isCompactSummary === true) return false;
      }
      if (message._isPlanningInjection === true) return false;
      if (message._alreadyPersisted === true) return false;
      return true;
    })
    .map((message) => {
      const cloned = { ...message };
      swapMessageContent(cloned);
      delete cloned._isIdentityPrompt;
      delete cloned._isInjectedContext;
      return cloned;
    });

  return expandToolCallsForPersistence(filtered);
}

/**
 * Standard utility to assemble the messages array to append to the database.
 * Shared between production finalizers and test assertion modules.
 */
export function assembleMessagesToAppend(options: {
  overrideMessagesToAppend?: MessagePayload[] | null;
  text: string | null;
  thinking?: string | null;
  thinkingSignature?: string | null;
  images?: string[];
  audioReference?: string | null;
  toolCalls?: ToolCallPayload[];
  resolvedModel?: string;
  providerName?: string;
  usage?: TokenUsage | null;
  totalSeconds?: number | null;
  tokensPerSecond?: number | null;
  estimatedCost?: number | null;
  contentSegments?: unknown[];
  textFragments?: unknown[];
  thinkingFragments?: unknown[];
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  thinkingDurationSeconds?: number | null;
  contentDurationSeconds?: number | null;
  userMessage?: MessagePayload | null;
  conversationMeta?: Record<string, unknown> | null;
  requestId?: string;
}): MessagePayload[] {
  const {
    overrideMessagesToAppend,
    text,
    thinking,
    thinkingSignature,
    images = [],
    audioReference,
    toolCalls = [],
    contentSegments,
    textFragments,
    thinkingFragments,
    thinkingDurationSeconds,
    contentDurationSeconds,
    userMessage,
    conversationMeta,
    requestId,
  } = options;

  let messagesToAppend: MessagePayload[] = [];

  if (overrideMessagesToAppend) {
    messagesToAppend = [...overrideMessagesToAppend];
    const hasIntermediateToolMessages = overrideMessagesToAppend.some(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls &&
        message.toolCalls.length > 0,
    );
    let finalThinking = thinking || "";
    if (hasIntermediateToolMessages && finalThinking) {
      for (const message of overrideMessagesToAppend) {
        if (
          message.role === "assistant" &&
          message.thinking &&
          finalThinking.startsWith(message.thinking)
        ) {
          finalThinking = finalThinking.slice(message.thinking.length).trim();
        }
      }
    }

    const hasFinalContent = text?.trim();

    if (hasFinalContent || !hasIntermediateToolMessages) {
      // The final iteration produced text — push it as a proper message
      // with content only (no telemetry). Also used for non-agentic
      // single-shot tool calls where there are no intermediate iterations.
      messagesToAppend.push({
        role: "assistant",
        content: text,
        ...(finalThinking && { thinking: finalThinking }),
        ...(thinkingSignature && { thinkingSignature }),
        ...(images.length > 0 && { images }),
        ...(audioReference && { audio: audioReference }),
        ...(!hasIntermediateToolMessages &&
          toolCalls.length > 0 && { toolCalls }),
        ...(!hasIntermediateToolMessages && contentSegments?.length
          ? { contentSegments }
          : {}),
        ...(!hasIntermediateToolMessages && textFragments?.length
          ? { textFragments }
          : {}),
        ...(!hasIntermediateToolMessages && thinkingFragments?.length
          ? { thinkingFragments }
          : {}),
        ...(thinkingDurationSeconds != null && { thinkingDurationSeconds }),
        ...(contentDurationSeconds != null && { contentDurationSeconds }),
        timestamp: new Date().toISOString(),
        ...(requestId && { requestId }),
      } as MessagePayload);
    } else {
      // The final iteration produced no text — all response content was
      // delivered during intermediate tool-calling iterations. Merge any
      // remaining media fields into the last assistant message instead of
      // creating a separate empty stub that would produce consecutive
      // assistant messages in the database.
      let lastAssistantIndex = -1;
      for (
        let scanIndex = messagesToAppend.length - 1;
        scanIndex >= 0;
        scanIndex--
      ) {
        if (messagesToAppend[scanIndex].role === "assistant") {
          lastAssistantIndex = scanIndex;
          break;
        }
      }
      if (lastAssistantIndex !== -1) {
        if (finalThinking) {
          messagesToAppend[lastAssistantIndex].thinking = finalThinking;
        }
        if (thinkingSignature) {
          messagesToAppend[lastAssistantIndex].thinkingSignature =
            thinkingSignature;
        }
        if (images.length > 0) {
          messagesToAppend[lastAssistantIndex].images = images;
        }
        if (audioReference) {
          messagesToAppend[lastAssistantIndex].audio = audioReference;
        }
      }
    }
  } else {
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
      ...(audioReference && { audio: audioReference }),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(thinkingDurationSeconds != null && { thinkingDurationSeconds }),
      ...(contentDurationSeconds != null && { contentDurationSeconds }),
      timestamp: new Date().toISOString(),
      ...(requestId && { requestId }),
    } as MessagePayload);
  }

  return messagesToAppend;
}

/**
 * Slice and filter message history to identify new messages for the current turn.
 * Shared between BaseAgenticHarness execution and test suite assertion suites to ensure
 * they do not diverge.
 *
 * For sub-agents, the initial messages array contains both a system message
 * (operational context: topology, workspace, delegation rules) and a user
 * message (the task prompt). Both are new and must be persisted. The scan
 * below walks backward from the default slice point to find the earliest
 * consecutive non-persisted original message so nothing is dropped.
 */
export function computeNewTurnMessages(
  originalMessages: MessagePayload[],
  currentMessages: MessagePayload[],
  originalMessageCount: number,
): MessagePayload[] {
  const lastOriginalMessage = originalMessages[originalMessageCount - 1];
  const isLastAlreadyPersisted =
    lastOriginalMessage && lastOriginalMessage._alreadyPersisted === true;

  let sliceIndex: number;
  if (isLastAlreadyPersisted) {
    // All originals are already in the DB — only persist new messages
    sliceIndex = originalMessageCount;
  } else {
    // Default: include the last original message (the triggering user input)
    sliceIndex = Math.max(0, originalMessageCount - 1);

    // Walk backward to include any preceding non-persisted original messages
    // (e.g. sub-agent operational context system message at index 0)
    for (let scanIndex = sliceIndex - 1; scanIndex >= 0; scanIndex--) {
      if (originalMessages[scanIndex]?._alreadyPersisted) break;
      sliceIndex = scanIndex;
    }
  }

  return currentMessages
    .slice(sliceIndex)
    .filter(
      (message) =>
        !(
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)
        ) && !message._alreadyPersisted,
    );
}

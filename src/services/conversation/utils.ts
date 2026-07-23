import FileService from "#src/services/FileService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import {
  COLLECTIONS,
  COST_SUMMATION_EXPRESSION,
  FILE_CATEGORIES,
} from "#src/constants";
import type { ChatMessage } from "#src/types/admin";
import type {
  MessagePayload,
  ConversationSettings,
  ConversationPatchInput,
  ConversationPatchFields,
} from "./types.ts";

interface ConversationDocument {
  id: string;
  totalCost?: number;
  requestErrorCount?: number;
  [key: string]: unknown;
}

/**
 * Media array fields whose base64 data URLs are offloaded to MinIO before
 * persistence. Provider-form messages can carry any of these inline —
 * `video` in particular (never image-compressed) reaches tens of MB.
 */
const EXTRACTABLE_MEDIA_ARRAY_FIELDS = ["images", "video", "pdf"] as const;

/**
 * MongoDB documents cap at 16MB and the driver's BSON serializer buffer at
 * ~17MB — one unswapped video blob makes the whole `$push` throw and loses
 * the turn (see the 2026-07-22 lupos "summarize this video" empty-stub).
 * A data: ref that survives the MinIO swap (storage down, upload failed)
 * and exceeds this cap is dropped with a placeholder instead of being
 * persisted inline.
 */
const MAXIMUM_INLINE_MEDIA_CHARACTERS = 8 * 1024 * 1024;

function capOversizedInlineMediaRef(ref: string, fieldName: string): string {
  if (
    !ref.startsWith("data:") ||
    ref.length <= MAXIMUM_INLINE_MEDIA_CHARACTERS
  ) {
    return ref;
  }
  const mimeType = ref.match(/^data:([^;,]+)/)?.[1] || "unknown";
  const approximateMegabytes = (ref.length / (1024 * 1024)).toFixed(1);
  logger.error(
    `Dropped oversized inline ${fieldName} (${mimeType}, ${approximateMegabytes}MB base64) — could not offload to MinIO`,
  );
  return `dropped://oversized-${fieldName}?type=${encodeURIComponent(mimeType)}&approximateMegabytes=${approximateMegabytes}`;
}

/**
 * Upload any base64 data URLs in message media fields (images/video/pdf
 * arrays, audio string) to external storage, replacing inline data with
 * minio:// refs. When MinIO is unavailable, small media stays inline by
 * design, but oversized entries are dropped via placeholder so the
 * conversation `$push` can never blow the BSON document limit.
 */
export async function extractFiles(
  messages: Array<ChatMessage | MessagePayload>,
  project: string | null = null,
  username: string | null = null,
): Promise<Array<ChatMessage | MessagePayload>> {
  if (!messages) return messages;
  const isExternalStorageAvailable = FileService.isExternalStorage();

  const processed: Array<ChatMessage | MessagePayload> = [];
  for (const message of messages) {
    const updated = { ...message } as ChatMessage | MessagePayload;
    const category =
      message.role === "assistant"
        ? FILE_CATEGORIES.GENERATIONS
        : FILE_CATEGORIES.UPLOADS;

    for (const field of EXTRACTABLE_MEDIA_ARRAY_FIELDS) {
      const mediaArray = (updated as Record<string, unknown>)[field];
      if (!Array.isArray(mediaArray) || mediaArray.length === 0) continue;
      const newRefs: string[] = [];
      for (const rawRef of mediaArray) {
        if (typeof rawRef !== "string") {
          newRefs.push(String(rawRef));
          continue;
        }
        let ref = rawRef;
        if (ref.startsWith("data:") && isExternalStorageAvailable) {
          try {
            // uploadFile passes the data URL through unchanged when MinIO
            // drops mid-call — the size cap below still covers that case.
            const { ref: uploadedRef } = await FileService.uploadFile(
              ref,
              category,
              project,
              username,
            );
            ref = uploadedRef;
          } catch (error: unknown) {
            logger.error(`Failed to upload file: ${errorMessage(error)}`);
          }
        }
        newRefs.push(capOversizedInlineMediaRef(ref, field));
      }
      (updated as Record<string, unknown>)[field] = newRefs;
    }

    // Handle audio data URLs (single string field)
    if (
      updated.audio &&
      typeof updated.audio === "string" &&
      updated.audio.startsWith("data:")
    ) {
      if (isExternalStorageAvailable) {
        try {
          const { ref } = await FileService.uploadFile(
            updated.audio,
            category,
            project,
            username,
          );
          updated.audio = ref;
        } catch (error: unknown) {
          logger.error(`Failed to upload audio: ${errorMessage(error)}`);
        }
      }
      updated.audio = capOversizedInlineMediaRef(
        updated.audio as string,
        "audio",
      );
    }

    processed.push(updated);
  }
  return processed;
}

/**
 * Compute input/output modalities from messages for lightweight querying.
 */
export function computeModalities(
  messages: ChatMessage[],
): Record<string, boolean> {
  const modalities = {
    textIn: false,
    textOut: false,
    imageIn: false,
    imageOut: false,
    audioIn: false,
    audioOut: false,
    videoIn: false,
    docIn: false,
    webSearch: false,
    codeExecution: false,
    functionCalling: false,
    thinking: false,
  };

  const WEB_SEARCH_NAMES: Set<string> = new Set([
    TOOL_NAMES.SEARCH_WEB,
    TOOL_NAMES.SEARCH_WEB_PREVIEW,
  ]);
  const CODE_EXEC_NAMES: Set<string> = new Set([TOOL_NAMES.CODE_EXECUTION]);
  const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".webm"];

  for (const chatMessage of messages || []) {
    if (chatMessage.deleted) continue;
    const isUser = chatMessage.role === "user";
    const isAssistant = chatMessage.role === "assistant";
    if (chatMessage.content && (isUser || isAssistant)) {
      if (isUser && !(chatMessage as Record<string, unknown>).liveTranscription)
        modalities.textIn = true;
      if (isAssistant) modalities.textOut = true;
    }
    // Tool calls are structured text output
    if (
      isAssistant &&
      chatMessage.toolCalls &&
      chatMessage.toolCalls.length > 0
    ) {
      modalities.textOut = true;
    }

    // Classify each image reference as image, video, or document
    if (chatMessage.images && chatMessage.images.length > 0) {
      for (const imageReference of chatMessage.images) {
        if (typeof imageReference !== "string") continue;
        const isDocumentReference =
          imageReference.startsWith("data:application/") ||
          imageReference.startsWith("data:text/") ||
          imageReference.endsWith(".pdf") ||
          imageReference.endsWith(".txt");
        const isVideoReference =
          imageReference.startsWith("data:video/") ||
          VIDEO_EXTENSIONS.some((extension) =>
            imageReference.endsWith(extension),
          );
        if (isDocumentReference) {
          modalities.docIn = true;
        } else if (isVideoReference) {
          if (isUser) modalities.videoIn = true;
        } else {
          if (isUser) modalities.imageIn = true;
          if (isAssistant) modalities.imageOut = true;
        }
      }
    }

    // Standalone image field (not from images array)
    if (
      (chatMessage as Record<string, unknown>).image &&
      !chatMessage.images?.length
    ) {
      if (isUser) modalities.imageIn = true;
      if (isAssistant) modalities.imageOut = true;
    }

    if (chatMessage.audio) {
      if (isUser) modalities.audioIn = true;
      if (isAssistant) modalities.audioOut = true;
    }

    // Documents array (separate from image-based document detection)
    if (
      (
        (chatMessage as Record<string, unknown>).documents as
          | string[]
          | undefined
      )?.length
    ) {
      modalities.docIn = true;
    }

    // Classify tool calls by type
    if (chatMessage.toolCalls && chatMessage.toolCalls.length > 0) {
      for (const toolCall of chatMessage.toolCalls) {
        const name = (toolCall.name || "").toLowerCase();
        if (WEB_SEARCH_NAMES.has(name)) {
          modalities.webSearch = true;
        } else if (CODE_EXEC_NAMES.has(name)) {
          modalities.codeExecution = true;
        } else {
          modalities.functionCalling = true;
        }
      }
    }

    // Detect inline web search results (from streaming)
    if (
      isAssistant &&
      typeof chatMessage.content === "string" &&
      chatMessage.content.includes("> **Sources:**")
    ) {
      modalities.webSearch = true;
    }

    // Detect inline code execution blocks (from streaming)
    if (
      isAssistant &&
      typeof chatMessage.content === "string" &&
      chatMessage.content.includes("```exec-")
    ) {
      modalities.codeExecution = true;
    }

    // Tool result messages — mark as function calling
    // (provider-native web_search and code_execution results are inlined, not stored as role:"tool")
    if (chatMessage.role === "tool") {
      modalities.functionCalling = true;
    }

    // Detect thinking / reasoning
    if (isAssistant && chatMessage.thinking) {
      modalities.thinking = true;
    }
  }
  return modalities;
}

/**
 * Extract unique providers from messages and settings.
 */
export function extractProviders(
  messages: ChatMessage[],
  settings: ConversationSettings | null,
): string[] {
  const providers = new Set<string>();
  for (const chatMessage of messages || []) {
    if (chatMessage.deleted) continue;
    if ((chatMessage as Record<string, unknown>).provider) {
      providers.add(
        (
          (chatMessage as Record<string, unknown>).provider as string
        ).toLowerCase(),
      );
    }
  }
  if (settings?.provider) providers.add(settings.provider.toLowerCase());
  return [...providers];
}

/**
 * Compute total estimated cost across all messages.
 */
export function computeTotalCost(messages: ChatMessage[]): number {
  let total = 0;
  for (const chatMessage of messages || []) {
    if (chatMessage.deleted) continue;
    const cost = (chatMessage as Record<string, unknown>).estimatedCost;
    if (typeof cost === "number") total += cost;
  }
  return total;
}

/**
 * Aggregate input/output tokens from assistant messages.
 */
export function computeTokenStats(messages: ChatMessage[]): {
  input: number;
  output: number;
} {
  let input = 0;
  let output = 0;
  for (const message of messages || []) {
    if (message.deleted || message.role !== "assistant") continue;
    if (message.usage) {
      input += (message.usage as Record<string, unknown>).inputTokens as number || 0;
      output += (message.usage as Record<string, unknown>).outputTokens as number || 0;
    }
  }
  return { input, output };
}

/**
 * Count tool invocations across assistant messages.
 */
export function computeToolCounts(messages: ChatMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages || []) {
    if (message.deleted || message.role !== "assistant") continue;

    // Capability: Thinking
    if (message.thinking) {
      counts["Thinking"] = (counts["Thinking"] || 0) + 1;
    }

    // Capability: Tool Calling (if any tool calls present)
    if (message.toolCalls && message.toolCalls.length > 0) {
      counts["Tool Calling"] = (counts["Tool Calling"] || 0) + 1;

      for (const toolCall of message.toolCalls) {
        if (toolCall.name) {
          counts[toolCall.name] = (counts[toolCall.name] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

/** Write-side rollup totals aggregated from the requests collection. */
export interface ConversationRequestTotals {
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  modelNames: string[];
  providers: string[];
}

/**
 * Aggregate a conversation's own usage totals from the `requests` collection
 * (the write-side source of truth for cost/tokens — persisted messages are
 * telemetry-free by design, see messageTelemetrySeparation.test.ts).
 *
 * Match semantics mirror the read-side enrichment (ConversationsRoutes):
 * request rows carry `conversationId` (the doc id) and/or an
 * `agentConversationId` — which is sometimes the doc id itself and sometimes
 * a separate per-loop correlation ID recorded on the doc's own
 * `agentConversationId` field. The $or covers all three keying shapes.
 * Child conversations (`parentAgentConversationId`) are NOT folded in; the
 * stored rollup means "this conversation's own spend" and the read-side
 * child rollup keeps adding descendants for display.
 *
 * Returns null when no matching requests exist (callers fall back to
 * message-derived stats for legacy/imported conversations).
 */
export async function aggregateConversationTotalsFromRequests(
  conversationId: string,
  collection: string,
  {
    agentCorrelationId = null,
  }: { agentCorrelationId?: string | null } = {},
): Promise<ConversationRequestTotals | null> {
  const requestsCollection = MongoWrapper.getCollection(
    MONGO_DB_NAME,
    COLLECTIONS.REQUESTS,
  );
  void collection; // same match for both conversation collections

  const matchCondition = {
    $or: [
      { conversationId },
      { agentConversationId: conversationId },
      ...(agentCorrelationId && agentCorrelationId !== conversationId
        ? [{ agentConversationId: agentCorrelationId }]
        : []),
    ],
  };

  const results = await requestsCollection
    .aggregate<{
      totalCost: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningOutputTokens: number;
      modelNames: Array<string | null>;
      providers: Array<string | null>;
    }>([
      { $match: matchCondition },
      {
        $group: {
          _id: null,
          totalCost: COST_SUMMATION_EXPRESSION,
          inputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          outputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          cacheReadInputTokens: {
            $sum: { $ifNull: ["$cacheReadInputTokens", 0] },
          },
          cacheCreationInputTokens: {
            $sum: { $ifNull: ["$cacheCreationInputTokens", 0] },
          },
          reasoningOutputTokens: {
            $sum: { $ifNull: ["$reasoningOutputTokens", 0] },
          },
          modelNames: { $addToSet: "$model" },
          providers: { $addToSet: "$provider" },
        },
      },
    ])
    .toArray();

  if (results.length === 0) return null;
  const totals = results[0];
  return {
    totalCost: totals.totalCost || 0,
    inputTokens: totals.inputTokens || 0,
    outputTokens: totals.outputTokens || 0,
    cacheReadInputTokens: totals.cacheReadInputTokens || 0,
    cacheCreationInputTokens: totals.cacheCreationInputTokens || 0,
    reasoningOutputTokens: totals.reasoningOutputTokens || 0,
    modelNames: (totals.modelNames || []).filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    ),
    providers: (totals.providers || []).filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    ),
  };
}

/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 */
export function buildConversationPatchFields({
  title,
  messages,
  systemPrompt,
  settings,
}: ConversationPatchInput): ConversationPatchFields {
  const setFields: ConversationPatchFields = {
    updatedAt: new Date().toISOString(),
  };
  if (title !== undefined) setFields.title = title;
  if (messages !== undefined) {
    setFields.messages = messages;
    setFields.messageCount = messages.length;
    setFields.modalities = computeModalities(messages);
    setFields.providers = extractProviders(messages, settings || null);
    // Deliberately NOT recomputing totalCost/inputTokens/outputTokens here:
    // persisted messages are telemetry-free, so message-derived totals are
    // always 0 — a PATCH that replaces messages must not zero (or "refund")
    // spend already recorded in the requests collection.
    setFields.toolCounts = computeToolCounts(messages);

    const modelNamesSet = new Set<string>();
    for (const message of messages || []) {
      if (message.deleted) continue;
      if (message.role === "assistant" && message.model) {
        modelNamesSet.add(message.model as string);
      }
    }
    if (modelNamesSet.size === 0 && settings?.model) {
      modelNamesSet.add(settings.model as string);
    }
    setFields.modelNames = Array.from(modelNamesSet);
  }
  if (systemPrompt !== undefined) setFields.systemPrompt = systemPrompt;
  if (settings !== undefined) {
    setFields.settings = { ...settings };
  }
  return setFields;
}

/**
 * Canonical activity state for a served conversation document, derived from
 * persisted fields only. Fine-grained live phases (thinking, executing…)
 * require a live SSE connection and never appear here.
 */
export type AgentConversationState =
  | "completed"
  | "completed-with-errors"
  | "generating"
  | "orchestrating"
  | "background-tasks"
  | "sub-agents-running"
  | "active";

/**
 * Derive the canonical conversation activity state from persisted document
 * fields, evaluated in priority order: generating → orchestrating →
 * done → error → sub-agents → background-tasks → active.
 *
 * Mirrors the client-side ladder in
 * prism-client/src/utils/agentConversationStates.ts — keep the two in sync.
 * The client keeps its own copy because the live sidebar derives state from
 * SSE-patched props, where a server snapshot would go stale.
 *
 * Call AFTER cost/sub-agent enrichment — the ladder reads the enriched
 * `hasSubAgents`/`requestErrorCount` values.
 */
export function deriveAgentConversationState(conversation: {
  isActive?: boolean;
  isGenerating?: boolean;
  pendingBackgroundTasks?: number;
  hasSubAgents?: boolean;
  requestErrorCount?: number;
}): AgentConversationState {
  if (conversation.isGenerating) {
    return conversation.hasSubAgents ? "orchestrating" : "generating";
  }
  if (conversation.isActive === false) {
    return (conversation.requestErrorCount ?? 0) > 0
      ? "completed-with-errors"
      : "completed";
  }
  if ((conversation.pendingBackgroundTasks ?? 0) > 0) {
    return conversation.hasSubAgents ? "sub-agents-running" : "background-tasks";
  }
  return "active";
}

/**
 * Stamp the derived `state` onto a conversation record about to be served.
 */
export function attachConversationState(
  conversation: Record<string, unknown>,
): void {
  conversation.state = deriveAgentConversationState(
    conversation as Parameters<typeof deriveAgentConversationState>[0],
  );
}

/**
 * Enrich conversations list with authoritative totalCost from request logs.
 */
export function enrichConversationsWithRequestCosts(
  conversations: ConversationDocument[],
  requestLogCosts: Array<{
    _id: string;
    totalCost: number;
    requestErrorCount?: number;
  }>,
): void {
  if (conversations.length === 0) return;
  const costMap = new Map(
    requestLogCosts.map((costEntry) => [
      costEntry._id,
      {
        totalCost: costEntry.totalCost,
        requestErrorCount: costEntry.requestErrorCount || 0,
      },
    ]),
  );
  for (const conversation of conversations) {
    const conversationId = conversation.id;
    const aggregated = costMap.get(conversationId);
    if (aggregated) {
      if (aggregated.totalCost > 0) {
        conversation.totalCost = Math.max(
          conversation.totalCost || 0,
          aggregated.totalCost,
        );
      }
      if (aggregated.requestErrorCount > 0) {
        conversation.requestErrorCount = aggregated.requestErrorCount;
      }
    }
  }
}

/**
 * Enrich a single conversation's totalCost with request logs.
 */
export function enrichSingleConversationCost(
  conversation: ConversationDocument,
  requestLogAggregation: Array<{
    _id: string;
    totalCost: number;
    requestErrorCount?: number;
  }>,
): void {
  if (requestLogAggregation.length > 0) {
    if (requestLogAggregation[0].totalCost > 0) {
      conversation.totalCost = Math.max(
        conversation.totalCost || 0,
        requestLogAggregation[0].totalCost,
      );
    }
    if ((requestLogAggregation[0].requestErrorCount || 0) > 0) {
      conversation.requestErrorCount =
        requestLogAggregation[0].requestErrorCount;
    }
  }
}

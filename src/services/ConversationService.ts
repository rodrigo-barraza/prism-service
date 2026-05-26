import MongoWrapper from "../wrappers/MongoWrapper.ts";
import FileService from "./FileService.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import type { ChatMessage, ToolCallEntry } from "../types/admin.ts";
import type { MessagePayload } from "./RequestLogger.ts";

const DEFAULT_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;

// ── Conversation Metadata ───────────────────────────────────

export interface ConversationMeta {
  title?: string;
  systemPrompt?: string;
  settings?: ConversationSettings;
  traceId?: string | null;
  parentAgentSessionId?: string | null;
  workspaceRoot?: string | null;
  synthetic?: boolean;
  agent?: string | null;
}

export interface ConversationSettings {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  [key: string]: unknown;
}

export interface ConversationPatchInput {
  title?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ConversationPatchFields {
  updatedAt: string;
  title?: string;
  messages?: ChatMessage[];
  modalities?: Record<string, boolean>;
  providers?: string[];
  totalCost?: number;
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ConversationServiceInterface {
  appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: Array<ChatMessage | MessagePayload>,
    conversationMeta?: ConversationMeta | null,
    options?: { collection?: string },
  ): Promise<Record<string, unknown>>;
  setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    options?: { collection?: string; agent?: string },
  ): Promise<void>;
  getSessionStats(
    sessionId: string,
    project: string,
    username: string,
  ): Promise<Record<string, unknown> | null>;
}

/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 */
export async function extractFiles(
  messages: Array<ChatMessage | MessagePayload>,
  project: string | null = null,
  username: string | null = null,
): Promise<Array<ChatMessage | MessagePayload>> {
  if (!messages || !FileService.isExternalStorage()) return messages;

  const processed: Array<ChatMessage | MessagePayload> = [];
  for (const message of messages) {
    const updated = { ...message } as ChatMessage | MessagePayload;

    // Handle images
    if (message.images && message.images.length > 0) {
      const category = message.role === "assistant" ? "generations" : "uploads";
      const newImages: string[] = [];
      for (const rawImage of message.images) {
        if (typeof rawImage !== "string") {
          newImages.push(String(rawImage));
          continue;
        }
        const image = rawImage;
        if (image.startsWith("minio://") || image.startsWith("http")) {
          newImages.push(image);
          continue;
        }
        if (image.startsWith("data:")) {
          try {
            const { ref } = await FileService.uploadFile(
              image,
              category,
              project,
              username,
            );
            newImages.push(ref);
          } catch (error: unknown) {
            logger.error(`Failed to upload file: ${errorMessage(error)}`);
            newImages.push(image);
          }
        } else {
          newImages.push(image);
        }
      }
      updated.images = newImages;
    }

    // Handle audio data URLs
    if (
      updated.audio &&
      typeof updated.audio === "string" &&
      updated.audio.startsWith("data:")
    ) {
      const category = updated.role === "assistant" ? "generations" : "uploads";
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

    processed.push(updated);
  }
  return processed;
}

/**
 * Compute input/output modalities from messages for lightweight querying.
 */
export function computeModalities(messages: ChatMessage[]): Record<string, boolean> {
  const modalities = {
    textIn: false,
    textOut: false,
    imageIn: false,
    imageOut: false,
    audioIn: false,
    audioOut: false,
    docIn: false,
    webSearch: false,
    codeExecution: false,
    functionCalling: false,
    thinking: false,
  };

  const WEB_SEARCH_NAMES = new Set(["web_search", "web_search_preview"]);
  const CODE_EXEC_NAMES = new Set(["code_execution"]);

  for (const m of messages || []) {
    if (m.deleted) continue;
    const isUser = m.role === "user";
    const isAssistant = m.role === "assistant";
    if (m.content && (isUser || isAssistant)) {
      if (isUser && !(m as Record<string, unknown>).liveTranscription) modalities.textIn = true;
      if (isAssistant) modalities.textOut = true;
    }
    // Tool calls are structured text output
    if (isAssistant && m.toolCalls && m.toolCalls.length > 0) {
      modalities.textOut = true;
    }
    if ((m.images && m.images.length > 0) || (m as Record<string, unknown>).image) {
      if (isUser) modalities.imageIn = true;
      if (isAssistant) modalities.imageOut = true;
    }
    if (m.audio) {
      if (isUser) modalities.audioIn = true;
      if (isAssistant) modalities.audioOut = true;
    }
    if (
      ((m as Record<string, unknown>).documents as string[] | undefined)?.length ||
      m.images?.some(
        (ref: string) =>
          typeof ref === "string" &&
          (ref.endsWith(".pdf") || ref.endsWith(".txt")),
      )
    ) {
      modalities.docIn = true;
    }

    // Classify tool calls by type
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const name = (tc.name || "").toLowerCase();
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
      typeof m.content === "string" &&
      m.content.includes("> **Sources:**")
    ) {
      modalities.webSearch = true;
    }

    // Detect inline code execution blocks (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("```exec-")
    ) {
      modalities.codeExecution = true;
    }

    // Tool result messages — mark as function calling
    // (web_search and code_execution results are inlined, not stored as role:"tool")
    if (m.role === "tool") {
      modalities.functionCalling = true;
    }

    // Detect thinking / reasoning
    if (isAssistant && m.thinking) {
      modalities.thinking = true;
    }
  }
  return modalities;
}

/**
 * Extract unique providers from messages and settings.
 */
export function extractProviders(messages: ChatMessage[], settings: ConversationSettings | null): string[] {
  const providers = new Set<string>();
  for (const m of messages || []) {
    if (m.deleted) continue;
    if ((m as Record<string, unknown>).provider) {
      providers.add(((m as Record<string, unknown>).provider as string).toLowerCase());
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
  for (const m of messages || []) {
    if (m.deleted) continue;
    const cost = (m as Record<string, unknown>).estimatedCost;
    if (typeof cost === "number") total += cost;
  }
  return total;
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
  const setFields: ConversationPatchFields = { updatedAt: new Date().toISOString() };
  if (title !== undefined) setFields.title = title;
  if (messages !== undefined) {
    setFields.messages = messages;
    setFields.modalities = computeModalities(messages);
    setFields.providers = extractProviders(messages, settings || null);
    setFields.totalCost = computeTotalCost(messages);
  }
  if (systemPrompt !== undefined) setFields.systemPrompt = systemPrompt;
  if (settings !== undefined) {
    setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
  }
  return setFields;
}

/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
const ConversationService: ConversationServiceInterface = {
  /**
   * Append messages to a conversation, auto-creating it if it doesn't exist.
   * Handles file extraction (MinIO upload) and recomputes derived fields.
   * Optionally applies conversation metadata (title, systemPrompt, settings).
   */
  async appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: Array<ChatMessage | MessagePayload>,
    conversationMeta: ConversationMeta | null = null,
    { collection = DEFAULT_COLLECTION }: { collection?: string } = {},
  ): Promise<Record<string, unknown>> {
    const traceId = conversationMeta?.traceId || null;
    const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
    const isAgentSession = collection === COLLECTIONS.AGENT_CONVERSATIONS;

    // Extract files (upload base64 data to MinIO)
    const processedMessages = await extractFiles(
      newMessages,
      project,
      username,
    );

    const now = new Date().toISOString();

    // Build $set fields for metadata
    const setFields: Record<string, unknown> = { updatedAt: now };
    if (traceId) setFields.traceId = traceId;

    if (conversationMeta) {
      if (conversationMeta.title !== undefined) {
        setFields.title = conversationMeta.title;
      }
      if (conversationMeta.systemPrompt !== undefined) {
        setFields.systemPrompt = conversationMeta.systemPrompt;
      }
      if (conversationMeta.settings !== undefined) {
        setFields.settings = {
          ...conversationMeta.settings,
          systemPrompt: conversationMeta.systemPrompt || "",
        };
      }
      if (conversationMeta.parentAgentSessionId) {
        setFields.parentAgentSessionId = conversationMeta.parentAgentSessionId;
      }
      if (conversationMeta.workspaceRoot) {
        setFields.workspaceRoot = conversationMeta.workspaceRoot;
      }
    }

    // Build $setOnInsert for auto-creation of new conversations
    const metaSettings = conversationMeta?.settings || {};
    const metaSysPrompt = conversationMeta?.systemPrompt || "";
    const parentId = conversationMeta?.parentAgentSessionId || null;

    const setOnInsertBase: Record<string, unknown> = {
      title: conversationMeta?.title || "New Conversation",
      systemPrompt: metaSysPrompt,
      settings: {
        ...metaSettings,
        systemPrompt: metaSysPrompt,
      },
      modalities: computeModalities([]),
      providers: extractProviders([], metaSettings as ConversationSettings),
      totalCost: 0,
      isGenerating: true,
      ...(conversationMeta?.synthetic && { synthetic: true }),
      ...(traceId && { traceId }),
      ...(parentId && { parentAgentSessionId: parentId }),
      ...(conversationMeta?.workspaceRoot && {
        workspaceRoot: conversationMeta.workspaceRoot,
      }),
      // Agent identity — stored on agent sessions for per-agent filtering
      ...(isAgentSession && conversationMeta?.agent && {
        agent: conversationMeta.agent,
      }),
      createdAt: now,
    };

    // MongoDB forbids the same field path in both $set and $setOnInsert —
    // strip any keys already present in $set to prevent MongoServerError:
    // "Updating the path 'X' would create a conflict at 'X'"
    const setOnInsert = { ...setOnInsertBase };
    for (const key of Object.keys(setFields)) {
      delete setOnInsert[key];
    }

    // 1. Atomic upsert: push messages + set metadata in a single operation
    await dbCollection.updateOne(
      { id: conversationId, project, username },
      {
        $push: { messages: { $each: processedMessages } },
        $set: setFields,
        $setOnInsert: setOnInsert,
      } as import("mongodb").Document,
      { upsert: true },
    );

    // 2. Single re-read to compute derived fields
    const conversation = await dbCollection.findOne({
      id: conversationId,
      project,
      username,
    });

    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // 3. Recompute derived fields and persist
    const modelNamesSet = new Set<string>();
    for (const model of (conversation.messages as ChatMessage[]) || []) {
      if (model.deleted) continue;
      if (model.role === "assistant" && model.model) {
        modelNamesSet.add(model.model as string);
      }
    }
    if (modelNamesSet.size === 0 && conversation.settings?.model) {
      modelNamesSet.add(conversation.settings.model as string);
    }

    const derived: Record<string, unknown> = {
      modalities: computeModalities(conversation.messages as ChatMessage[]),
      providers: extractProviders(conversation.messages as ChatMessage[], conversation.settings as ConversationSettings),
      totalCost: computeTotalCost(conversation.messages as ChatMessage[]),
      modelNames: Array.from(modelNamesSet),
    };

    // Auto-derive a descriptive title from the first user message if the current title is missing or is 'New Conversation'
    if (!conversation.title || conversation.title === "New Conversation") {
      const firstUserMsg = (conversation.messages as ChatMessage[])?.find(
        (m) => m.role === "user"
      );
      if (firstUserMsg?.content) {
        const titleSnippet = firstUserMsg.content.slice(0, 100).trim();
        if (titleSnippet) {
          derived.title = titleSnippet;
          conversation.title = titleSnippet; // Update local memory representation
        }
      }
    }

    await dbCollection.updateOne(
      { id: conversationId, project, username },
      { $set: derived },
    );

    // Return the doc with derived fields merged (avoids a third read)
    return { ...conversation, ...derived };
  },

  /**
   * Set or clear the isGenerating flag on a conversation.
   * Lightweight update — only touches isGenerating + updatedAt.
   */
  async setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    { collection = DEFAULT_COLLECTION, agent }: { collection?: string; agent?: string } = {},
  ): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const now = new Date().toISOString();

    if (generating) {
      // Upsert — create a stub if it doesn't exist yet
      const isAgentSession = collection === COLLECTIONS.AGENT_CONVERSATIONS;
      await db.collection(collection).updateOne(
        { id: conversationId, project, username },
        {
          $set: { isGenerating: true, updatedAt: now },
          $setOnInsert: {
            title: "New Conversation",
            messages: [],
            systemPrompt: "",
            settings: {},
            modalities: computeModalities([]),
            providers: [],
            totalCost: 0,
            // Agent identity — stored on agent sessions for per-agent filtering
            ...(isAgentSession && agent && { agent }),
            createdAt: now,
          },
        },
        { upsert: true },
      );
    } else {
      await db
        .collection(collection)
        .updateOne(
          { id: conversationId, project, username },
          { $set: { isGenerating: false, updatedAt: now } },
        );
    }
  },

  async getSessionStats(
    sessionId: string,
    project: string,
    username: string,
  ): Promise<Record<string, unknown> | null> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return null;

    // Recursively discover all descendant session IDs (multi-level workers)
    const allSessionIds = new Set([sessionId]);
    let frontier = [sessionId];
    for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
      const childIds = await db
        .collection(COLLECTIONS.REQUESTS)
        .distinct("agentSessionId", {
          parentAgentSessionId: { $in: frontier },
          agentSessionId: { $nin: [...allSessionIds] },
          project,
          username,
        });
      if (childIds.length === 0) break;
      const newIds = childIds.filter(Boolean);
      for (const id of newIds) allSessionIds.add(id);
      frontier = newIds;
    }

    const requests = await db
      .collection(COLLECTIONS.REQUESTS)
      .find({
        agentSessionId: { $in: [...allSessionIds] },
        project,
        username,
      })
      .project({
        estimatedCost: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 1,
        reasoningOutputTokens: 1,
        provider: 1,
        model: 1,
        operation: 1,
        timestamp: 1,
        modalities: 1,
        toolApiNames: 1,
        success: 1,
        agentSessionId: 1,
        parentAgentSessionId: 1,
      })
      .toArray();

    if (requests.length === 0) {
      return null;
    }

    // Aggregate
    const providers = new Set();
    const models = new Set();
    const operations = new Set();
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let totalCacheCreationInputTokens = 0;
    let totalReasoningOutputTokens = 0;
    const mergedModalities: Record<string, boolean> = {};
    const toolCounts: Record<string, number> = {};

    for (const r of requests) {
      totalCost += r.estimatedCost || 0;
      totalInputTokens += r.inputTokens || 0;
      totalOutputTokens += r.outputTokens || 0;
      totalCacheReadInputTokens += r.cacheReadInputTokens || 0;
      totalCacheCreationInputTokens += r.cacheCreationInputTokens || 0;
      totalReasoningOutputTokens += r.reasoningOutputTokens || 0;
      if (r.provider) providers.add(r.provider);
      if (r.model) models.add(r.model);
      if (r.operation) operations.add(r.operation);
      // Merge modalities
      if (r.modalities) {
        for (const [k, value] of Object.entries(r.modalities)) {
          if (value) mergedModalities[k] = true;
        }
      }
      // Count tool usage
      if (r.toolApiNames && r.toolApiNames.length > 0) {
        for (const name of r.toolApiNames) {
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
    }

    const workerRequestCount = requests.filter(
      (r) => r.agentSessionId !== sessionId,
    ).length;

    const createdAt = (requests as Record<string, unknown>[]).reduce(
      (min: string | null, r) => (!min || (r.timestamp as string) < min ? (r.timestamp as string) : min),
      null as string | null,
    );
    const updatedAt = (requests as Record<string, unknown>[]).reduce(
      (max: string | null, r) => (!max || (r.timestamp as string) > max ? (r.timestamp as string) : max),
      null as string | null,
    );

    // Wall-clock elapsed time: from first request to last request (includes workers)
    const totalElapsedTime =
      createdAt && updatedAt
        ? Math.max(
            0,
            (new Date(updatedAt as string).getTime() - new Date(createdAt as string).getTime()) /
              1000,
          )
        : 0;

    return {
      agentSessionId: sessionId,
      requestCount: requests.length,
      workerRequestCount,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCacheReadInputTokens,
      totalCacheCreationInputTokens,
      totalReasoningOutputTokens,
      providers: [...providers],
      models: [...models],
      operations: [...operations],
      modalities: mergedModalities,
      toolCounts,
      totalElapsedTime,
      createdAt,
      updatedAt,
    };
  },
};

export default ConversationService;

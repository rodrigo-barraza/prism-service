import MongoWrapper from "../wrappers/MongoWrapper.ts";
import FileService from "./FileService.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";

const DEFAULT_COLLECTION = COLLECTIONS.CONVERSATIONS;

export interface ConversationServiceInterface {
  appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: any[],
    conversationMeta?: any,
    options?: { collection?: string },
  ): Promise<any>;
  setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    options?: { collection?: string; agent?: string },
  ): Promise<void>;
}

/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 */
export async function extractFiles(
  messages: any[],
  project: string | null = null,
  username: string | null = null,
): Promise<any[]> {
  if (!messages || !FileService.isExternalStorage()) return messages;

  const processed: any[] = [];
  for (const message of messages) {
    const updated = { ...message };

    // Handle images
    if (message.images && message.images.length > 0) {
      const category = message.role === "assistant" ? "generations" : "uploads";
      const newImages: string[] = [];
      for (const image of message.images) {
        if (FileService.isMinioRef(image) || image.startsWith("http")) {
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
          } catch (error: any) {
            logger.error(`Failed to upload file: ${error.message}`);
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
      } catch (error: any) {
        logger.error(`Failed to upload audio: ${error.message}`);
      }
    }

    processed.push(updated);
  }
  return processed;
}

/**
 * Compute input/output modalities from messages for lightweight querying.
 */
export function computeModalities(messages: any[]): Record<string, boolean> {
  const mod = {
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
      if (isUser && !m.liveTranscription) mod.textIn = true;
      if (isAssistant) mod.textOut = true;
    }
    // Tool calls are structured text output
    if (isAssistant && m.toolCalls?.length > 0) {
      mod.textOut = true;
    }
    if (m.images?.length > 0 || m.image) {
      if (isUser) mod.imageIn = true;
      if (isAssistant) mod.imageOut = true;
    }
    if (m.audio) {
      if (isUser) mod.audioIn = true;
      if (isAssistant) mod.audioOut = true;
    }
    if (
      m.documents?.length > 0 ||
      m.images?.some(
        (ref: any) =>
          typeof ref === "string" &&
          (ref.endsWith(".pdf") || ref.endsWith(".txt")),
      )
    ) {
      mod.docIn = true;
    }

    // Classify tool calls by type
    if (m.toolCalls?.length > 0) {
      for (const tc of m.toolCalls) {
        const name = (tc.name || "").toLowerCase();
        if (WEB_SEARCH_NAMES.has(name)) {
          mod.webSearch = true;
        } else if (CODE_EXEC_NAMES.has(name)) {
          mod.codeExecution = true;
        } else {
          mod.functionCalling = true;
        }
      }
    }

    // Detect inline web search results (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("> **Sources:**")
    ) {
      mod.webSearch = true;
    }

    // Detect inline code execution blocks (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("```exec-")
    ) {
      mod.codeExecution = true;
    }

    // Tool result messages — mark as function calling
    // (web_search and code_execution results are inlined, not stored as role:"tool")
    if (m.role === "tool") {
      mod.functionCalling = true;
    }

    // Detect thinking / reasoning
    if (isAssistant && m.thinking) {
      mod.thinking = true;
    }
  }
  return mod;
}

/**
 * Extract unique providers from messages and settings.
 */
export function extractProviders(messages: any[], settings: any): string[] {
  const providers = new Set<string>();
  for (const m of messages || []) {
    if (m.deleted) continue;
    if (m.provider) providers.add(m.provider.toLowerCase());
  }
  if (settings?.provider) providers.add(settings.provider.toLowerCase());
  return [...providers];
}

/**
 * Compute total estimated cost across all messages.
 */
export function computeTotalCost(messages: any[]): number {
  let total = 0;
  for (const m of messages || []) {
    if (m.deleted) continue;
    if (m.estimatedCost) total += m.estimatedCost;
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
}: any): Record<string, any> {
  const setFields: Record<string, any> = { updatedAt: new Date().toISOString() };
  if (title !== undefined) setFields.title = title;
  if (messages !== undefined) {
    setFields.messages = messages;
    setFields.modalities = computeModalities(messages);
    setFields.providers = extractProviders(messages, settings);
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
    newMessages: any[],
    conversationMeta: any = null,
    { collection = DEFAULT_COLLECTION }: { collection?: string } = {},
  ): Promise<any> {
    const traceId = conversationMeta?.traceId || null;
    const col = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
    const isAgentSession = collection === COLLECTIONS.AGENT_SESSIONS;

    // Extract files (upload base64 data to MinIO)
    const processedMessages = await extractFiles(
      newMessages,
      project,
      username,
    );

    const now = new Date().toISOString();

    // Build $set fields for metadata
    const setFields: Record<string, any> = { updatedAt: now };
    if (traceId) setFields.traceId = traceId;

    if (conversationMeta) {
      if (conversationMeta.title !== undefined) {
        setFields.title = conversationMeta.title;
      }
      if (conversationMeta.systemPrompt !== undefined && !isAgentSession) {
        setFields.systemPrompt = conversationMeta.systemPrompt;
      }
      if (conversationMeta.settings !== undefined) {
        setFields.settings = isAgentSession
          ? { ...conversationMeta.settings }
          : {
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
    const metaSysPrompt = isAgentSession
      ? undefined
      : conversationMeta?.systemPrompt || "";
    const parentId = conversationMeta?.parentAgentSessionId || null;

    const setOnInsertBase: Record<string, any> = {
      title: conversationMeta?.title || "New Conversation",
      ...(!isAgentSession && { systemPrompt: metaSysPrompt }),
      settings: isAgentSession
        ? { ...metaSettings }
        : { ...metaSettings, systemPrompt: metaSysPrompt },
      modalities: computeModalities([]),
      providers: extractProviders([], metaSettings),
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
    await col.updateOne(
      { id: conversationId, project, username },
      {
        $push: { messages: { $each: processedMessages } },
        $set: setFields,
        $setOnInsert: setOnInsert,
      } as any,
      { upsert: true },
    );

    // 2. Single re-read to compute derived fields
    const conversation = await col.findOne({
      id: conversationId,
      project,
      username,
    });

    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // 3. Recompute derived fields and persist
    const derived = {
      modalities: computeModalities(conversation.messages),
      providers: extractProviders(conversation.messages, conversation.settings),
      totalCost: computeTotalCost(conversation.messages),
    };
    await col.updateOne(
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
      const isAgentSession = collection === COLLECTIONS.AGENT_SESSIONS;
      await db.collection(collection).updateOne(
        { id: conversationId, project, username },
        {
          $set: { isGenerating: true, updatedAt: now },
          $setOnInsert: {
            title: "New Conversation",
            messages: [],
            ...(!isAgentSession && { systemPrompt: "" }),
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
};

export default ConversationService;

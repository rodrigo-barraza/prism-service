import MongoWrapper from "../wrappers/MongoWrapper.js";
import FileService from "./FileService.js";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
const DEFAULT_COLLECTION = COLLECTIONS.CONVERSATIONS;
/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.


 * @returns {Promise<Array>} messages with refs replacing inline data
 */
export async function extractFiles(messages, project = null, username = null) {
    if (!messages || !FileService.isExternalStorage())
        return messages;
    const processed = [];
    // @ts-ignore
    for (const message of messages) {
        let updated = message;
        // Handle images
        if (message.images && message.images.length > 0) {
            const category = message.role === "assistant" ? "generations" : "uploads";
            const newImages = [];
            // @ts-ignore
            for (const image of message.images) {
                if (FileService.isMinioRef(image) || image.startsWith("http")) {
                    newImages.push(image);
                    continue;
                }
                if (image.startsWith("data:")) {
                    try {
                        const { ref } = await FileService.uploadFile(image, category, project, username);
                        newImages.push(ref);
                    }
                    catch (error) {
                        logger.error(`Failed to upload file: ${error.message}`);
                        newImages.push(image);
                    }
                }
                else {
                    newImages.push(image);
                }
            }
            updated = { ...updated, images: newImages };
        }
        // Handle audio data URLs
        if (updated.audio &&
            typeof updated.audio === "string" &&
            updated.audio.startsWith("data:")) {
            const category = updated.role === "assistant" ? "generations" : "uploads";
            try {
                const { ref } = await FileService.uploadFile(updated.audio, category, project, username);
                updated = { ...updated, audio: ref };
            }
            catch (error) {
                logger.error(`Failed to upload audio: ${error.message}`);
            }
        }
        processed.push(updated);
    }
    return processed;
}
/**
 * Compute input/output modalities from messages for lightweight querying.

 * @returns {Object} modalities flags
 */
export function computeModalities(messages) {
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
    // @ts-ignore
    for (const m of messages || []) {
        if (m.deleted)
            continue;
        const isUser = m.role === "user";
        const isAssistant = m.role === "assistant";
        if (m.content && (isUser || isAssistant)) {
            if (isUser && !m.liveTranscription)
                mod.textIn = true;
            if (isAssistant)
                mod.textOut = true;
        }
        // Tool calls are structured text output
        if (isAssistant && m.toolCalls?.length > 0) {
            mod.textOut = true;
        }
        if (m.images?.length > 0 || m.image) {
            if (isUser)
                mod.imageIn = true;
            if (isAssistant)
                mod.imageOut = true;
        }
        if (m.audio) {
            if (isUser)
                mod.audioIn = true;
            if (isAssistant)
                mod.audioOut = true;
        }
        if (m.documents?.length > 0 ||
            m.images?.some((ref) => typeof ref === "string" &&
                (ref.endsWith(".pdf") || ref.endsWith(".txt")))) {
            mod.docIn = true;
        }
        // Classify tool calls by type
        if (m.toolCalls?.length > 0) {
            // @ts-ignore
            for (const tc of m.toolCalls) {
                const name = (tc.name || "").toLowerCase();
                if (WEB_SEARCH_NAMES.has(name)) {
                    mod.webSearch = true;
                }
                else if (CODE_EXEC_NAMES.has(name)) {
                    mod.codeExecution = true;
                }
                else {
                    mod.functionCalling = true;
                }
            }
        }
        // Detect inline web search results (from streaming)
        if (isAssistant &&
            typeof m.content === "string" &&
            m.content.includes("> **Sources:**")) {
            mod.webSearch = true;
        }
        // Detect inline code execution blocks (from streaming)
        if (isAssistant &&
            typeof m.content === "string" &&
            m.content.includes("```exec-")) {
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
export function extractProviders(messages, settings) {
    const providers = new Set();
    // @ts-ignore
    for (const m of messages || []) {
        if (m.deleted)
            continue;
        if (m.provider)
            providers.add(m.provider.toLowerCase());
    }
    if (settings?.provider)
        providers.add(settings.provider.toLowerCase());
    return [...providers];
}
/**
 * Compute total estimated cost across all messages.


 */
export function computeTotalCost(messages) {
    let total = 0;
    // @ts-ignore
    for (const m of messages || []) {
        if (m.deleted)
            continue;
        if (m.estimatedCost)
            total += m.estimatedCost;
    }
    return total;
}
/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 *

 * @returns {object} $set fields ready for updateOne
 */
export function buildConversationPatchFields({ title, messages, systemPrompt, settings, }) {
    const setFields = { updatedAt: new Date().toISOString() };
    // @ts-ignore
    if (title !== undefined)
        setFields.title = title;
    if (messages !== undefined) {
        // @ts-ignore
        setFields.messages = messages;
        // @ts-ignore
        setFields.modalities = computeModalities(messages);
        // @ts-ignore
        setFields.providers = extractProviders(messages, settings);
        // @ts-ignore
        setFields.totalCost = computeTotalCost(messages);
    }
    // @ts-ignore
    if (systemPrompt !== undefined)
        setFields.systemPrompt = systemPrompt;
    if (settings !== undefined) {
        // @ts-ignore
        setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
    }
    return setFields;
}
/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
const ConversationService = {
    /**
       * Append messages to a conversation, auto-creating it if it doesn't exist.
       * Handles file extraction (MinIO upload) and recomputes derived fields.
       * Optionally applies conversation metadata (title, systemPrompt, settings).
       *
  
  
       * @returns {Promise<object>} The updated conversation document
       */
    async appendMessages(conversationId, project, username, newMessages, conversationMeta = null, { collection = DEFAULT_COLLECTION } = {}) {
        // @ts-ignore
        const traceId = conversationMeta?.traceId || null;
        const col = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
        const isAgentSession = collection === COLLECTIONS.AGENT_SESSIONS;
        // Extract files (upload base64 data to MinIO)
        const processedMessages = await extractFiles(newMessages, project, username);
        const now = new Date().toISOString();
        // Build $set fields for metadata
        const setFields = { updatedAt: now };
        // @ts-ignore
        if (traceId)
            setFields.traceId = traceId;
        if (conversationMeta) {
            // @ts-ignore
            if (conversationMeta.title !== undefined) {
                // @ts-ignore
                setFields.title = conversationMeta.title;
            }
            // @ts-ignore
            if (conversationMeta.systemPrompt !== undefined && !isAgentSession) {
                // @ts-ignore
                setFields.systemPrompt = conversationMeta.systemPrompt;
            }
            // @ts-ignore
            if (conversationMeta.settings !== undefined) {
                // @ts-ignore
                setFields.settings = isAgentSession
                    ? // @ts-ignore
                        { ...conversationMeta.settings }
                    : {
                        // @ts-ignore
                        ...conversationMeta.settings,
                        // @ts-ignore
                        systemPrompt: conversationMeta.systemPrompt || "",
                    };
            }
            // @ts-ignore
            if (conversationMeta.parentAgentSessionId) {
                // @ts-ignore
                setFields.parentAgentSessionId = conversationMeta.parentAgentSessionId;
            }
            // @ts-ignore
            if (conversationMeta.workspaceRoot) {
                // @ts-ignore
                setFields.workspaceRoot = conversationMeta.workspaceRoot;
            }
        }
        // Build $setOnInsert for auto-creation of new conversations
        // @ts-ignore
        const metaSettings = conversationMeta?.settings || {};
        // @ts-ignore
        const metaSysPrompt = isAgentSession
            ? undefined
            // @ts-ignore
            : conversationMeta?.systemPrompt || "";
        // @ts-ignore
        const parentId = conversationMeta?.parentAgentSessionId || null;
        const setOnInsertBase = {
            // @ts-ignore
            title: conversationMeta?.title || "New Conversation",
            ...(!isAgentSession && { systemPrompt: metaSysPrompt }),
            settings: isAgentSession
                ? { ...metaSettings }
                : { ...metaSettings, systemPrompt: metaSysPrompt },
            modalities: computeModalities([]),
            providers: extractProviders([], metaSettings),
            totalCost: 0,
            isGenerating: true,
            // @ts-ignore
            ...(conversationMeta?.synthetic && { synthetic: true }),
            ...(traceId && { traceId }),
            ...(parentId && { parentAgentSessionId: parentId }),
            // @ts-ignore
            ...(conversationMeta?.workspaceRoot && {
                // @ts-ignore
                workspaceRoot: conversationMeta.workspaceRoot,
            }),
            // Agent identity — stored on agent sessions for per-agent filtering
            // @ts-ignore
            ...(isAgentSession && conversationMeta?.agent && {
                // @ts-ignore
                agent: conversationMeta.agent,
            }),
            createdAt: now,
        };
        // MongoDB forbids the same field path in both $set and $setOnInsert —
        // strip any keys already present in $set to prevent MongoServerError:
        // "Updating the path 'X' would create a conflict at 'X'"
        const setOnInsert = { ...setOnInsertBase };
        // @ts-ignore
        for (const key of Object.keys(setFields)) {
            delete setOnInsert[key];
        }
        // 1. Atomic upsert: push messages + set metadata in a single operation
        await col.updateOne({ id: conversationId, project, username }, {
            $push: { messages: { $each: processedMessages } },
            $set: setFields,
            $setOnInsert: setOnInsert,
        }, { upsert: true });
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
        await col.updateOne({ id: conversationId, project, username }, { $set: derived });
        // Return the doc with derived fields merged (avoids a third read)
        return { ...conversation, ...derived };
    },
    /**
     * Set or clear the isGenerating flag on a conversation.
     * Lightweight update — only touches isGenerating + updatedAt.
     *
  
  
     */
    async setGenerating(conversationId, project, username, generating, { collection = DEFAULT_COLLECTION, agent } = {}) {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return;
        const now = new Date().toISOString();
        if (generating) {
            // Upsert — create a stub if it doesn't exist yet
            const isAgentSession = collection === COLLECTIONS.AGENT_SESSIONS;
            await db.collection(collection).updateOne({ id: conversationId, project, username }, {
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
            }, { upsert: true });
        }
        else {
            await db
                .collection(collection)
                .updateOne({ id: conversationId, project, username }, { $set: { isGenerating: false, updatedAt: now } });
        }
    },
};
export default ConversationService;
//# sourceMappingURL=ConversationService.js.map
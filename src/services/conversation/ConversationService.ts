import { DEFAULT_CONVERSATION_TITLE } from "@rodrigo-barraza/utilities-library/taxonomy";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";

import { COLLECTIONS, MAXIMUM_DERIVED_CONVERSATION_TITLE_LENGTH } from "#src/constants";
import type { ChatMessage } from "#src/types/admin";
import { discoverDescendantConversationIds } from "#src/utils/ConversationDiscovery";
import type {
  ConversationMeta,
  ConversationSettings,
  MessagePayload,
  ConversationServiceInterface,
  TransformedConversation,
  TransformedConversationStats,
} from "./types.ts";
import {
  extractFiles,
  computeModalities,
  extractProviders,
  computeTotalCost,
  computeTokenStats,
  computeToolCounts,
  aggregateConversationTotalsFromRequests,
} from "./utils.ts";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { getRequestContext } from "#src/utils/RequestContext";

const DEFAULT_COLLECTION = COLLECTIONS.MODEL_CONVERSATIONS;

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
  ): Promise<TransformedConversation> {
    const traceId = conversationMeta?.traceId || null;
    const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, collection);

    // Extract files (upload base64 data to MinIO)
    const processedMessages = await extractFiles(
      newMessages,
      project,
      username,
    );

    const now = new Date().toISOString();

    // Build $set fields for metadata
    const setFields: Partial<TransformedConversation> = { updatedAt: now };
    if (traceId) setFields.traceId = traceId;

    // Profile stamp — always the literal id (never null / $in). Falls back to
    // the request-context ALS so callers that don't thread profileId through
    // meta (legacy paths) still stamp the requesting profile.
    const stampProfileId =
      (typeof conversationMeta?.profileId === "string" &&
        conversationMeta.profileId) ||
      getRequestContext().profileId;
    if (stampProfileId) setFields.profileId = stampProfileId;

    if (conversationMeta) {
      if (conversationMeta.title !== undefined) {
        setFields.title = conversationMeta.title;
      }
      if (conversationMeta.systemPrompt !== undefined) {
        setFields.systemPrompt = conversationMeta.systemPrompt;
      }
      if (conversationMeta.settings !== undefined) {
        setFields.settings = { ...conversationMeta.settings };
      }
      if (conversationMeta.parentAgentConversationId) {
        setFields.parentAgentConversationId =
          conversationMeta.parentAgentConversationId;
      }
      if (conversationMeta.parentConversationId) {
        setFields.parentConversationId = conversationMeta.parentConversationId;
      }
      if (conversationMeta.workspaceRoot) {
        setFields.workspaceRoot = conversationMeta.workspaceRoot;
      }
      if (conversationMeta.contextBudget) {
        setFields.contextBudget = conversationMeta.contextBudget;
      }
      if (conversationMeta.agent) {
        setFields.agent = conversationMeta.agent;
      }
      if (conversationMeta.conversationOutcome !== undefined) {
        setFields.conversationOutcome = conversationMeta.conversationOutcome;
      }
    }

    // Build $setOnInsert for auto-creation of new conversations
    const metaSettings = conversationMeta?.settings || {};
    const metaSysPrompt = conversationMeta?.systemPrompt || "";
    const parentId = conversationMeta?.parentAgentConversationId || null;
    const parentConversationId = conversationMeta?.parentConversationId || null;

    const setOnInsertBase: Partial<TransformedConversation> = {
      title: conversationMeta?.title || DEFAULT_CONVERSATION_TITLE,
      systemPrompt: metaSysPrompt,
      settings: { ...metaSettings },
      modalities: computeModalities([]),
      providers: extractProviders([], metaSettings as ConversationSettings),
      totalCost: 0,
      isGenerating: true,
      isActive: true,
      ...(conversationMeta?.synthetic && { synthetic: true }),
      ...(traceId && { traceId }),
      ...(parentId && { parentAgentConversationId: parentId }),
      ...(parentConversationId && { parentConversationId }),
      ...(conversationMeta?.workspaceRoot && {
        workspaceRoot: conversationMeta.workspaceRoot,
      }),
      ...(conversationMeta?.agent && {
        agent: conversationMeta.agent,
      }),
      ...(conversationMeta?.conversationOutcome && {
        conversationOutcome: conversationMeta.conversationOutcome,
      }),
      createdAt: now,
    };

    // MongoDB forbids the same field path in both $set and $setOnInsert —
    // strip any keys already present in $set to prevent MongoServerError:
    // "Updating the path 'X' would create a conflict at 'X'"
    const setOnInsert = { ...setOnInsertBase } as Record<string, any>;
    const setFieldsTyped = setFields as Record<string, any>;
    for (const key of Object.keys(setFieldsTyped)) {
      delete setOnInsert[key];
    }

    // 1. Atomic upsert: push messages + set metadata in a single operation.
    // When new memory IDs were injected this turn, $addToSet them onto the
    // injectedMemoryIds array so future turns can exclude them. $addToSet with
    // $each is idempotent — safe to retry without producing duplicates.
    const newInjectedMemoryIds = Array.isArray(
      conversationMeta?._newInjectedMemoryIds,
    )
      ? (conversationMeta._newInjectedMemoryIds as string[])
      : null;

    const updateOperation: Record<string, unknown> = {
      $push: { messages: { $each: processedMessages } },
      $set: setFields,
      $setOnInsert: setOnInsert,
      // The turn's messages are now durably in `messages` — atomically drop
      // the crash-safety shadow copy so recovery can never double-append.
      $unset: { turnCheckpoint: "" },
    };

    if (newInjectedMemoryIds && newInjectedMemoryIds.length > 0) {
      updateOperation.$addToSet = {
        injectedMemoryIds: { $each: newInjectedMemoryIds },
      };
    }

    await dbCollection.updateOne(
      { id: conversationId, project, username },
      updateOperation as import("mongodb").Document,
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

    // 3. Recompute derived fields and persist.
    //
    // Cost/token rollups come from the `requests` collection — the write-side
    // source of truth. Persisted messages are deliberately telemetry-free
    // (messageTelemetrySeparation), so message-derived stats only serve as a
    // fallback for legacy/imported conversations and paths that still attach
    // per-message estimatedCost (e.g. image chat).
    let requestTotals: Awaited<
      ReturnType<typeof aggregateConversationTotalsFromRequests>
    > = null;
    try {
      requestTotals = await aggregateConversationTotalsFromRequests(
        conversationId,
        collection,
        {
          // Agent runs record a per-loop correlation ID on the doc; request
          // rows are keyed by it (in addition to conversationId).
          agentCorrelationId:
            (conversation.agentConversationId as string | undefined) || null,
        },
      );
    } catch (error: unknown) {
      // A requests-collection hiccup must never block message persistence.
      logger.warn(
        `[ConversationService] requests rollup failed for ${conversationId}: ${getErrorMessage(error)} — falling back to message-derived stats`,
      );
    }

    const modelNamesSet = new Set<string>(requestTotals?.modelNames || []);
    for (const model of (conversation.messages as ChatMessage[]) || []) {
      if (model.deleted) continue;
      if (model.role === "assistant" && model.model) {
        modelNamesSet.add(model.model as string);
      }
    }
    if (modelNamesSet.size === 0 && conversation.settings?.model) {
      modelNamesSet.add(conversation.settings.model as string);
    }

    const providersSet = new Set<string>(
      extractProviders(
        conversation.messages as ChatMessage[],
        conversation.settings as ConversationSettings,
      ),
    );
    for (const provider of requestTotals?.providers || []) {
      providersSet.add(provider.toLowerCase());
    }

    const tokenStats = computeTokenStats(conversation.messages as ChatMessage[]);
    const messageDerivedCost = computeTotalCost(
      conversation.messages as ChatMessage[],
    );

    const derived: Partial<TransformedConversation> = {
      // Stored so list endpoints never have to load message arrays to count them
      messageCount: ((conversation.messages as ChatMessage[]) || []).length,
      modalities: computeModalities(conversation.messages as ChatMessage[]),
      providers: [...providersSet],
      // Math.max mirrors the read-side enrichment semantics: request totals
      // win once present; message-derived values cover legacy documents.
      totalCost: Math.max(requestTotals?.totalCost || 0, messageDerivedCost),
      inputTokens: requestTotals?.inputTokens || tokenStats.input,
      outputTokens: requestTotals?.outputTokens || tokenStats.output,
      toolCounts: computeToolCounts(conversation.messages as ChatMessage[]),
      modelNames: Array.from(modelNamesSet),
    };

    if (requestTotals) {
      // Cache-efficiency visibility (new fields; only written when the
      // requests aggregate is available so legacy docs stay untouched).
      derived.cacheReadInputTokens = requestTotals.cacheReadInputTokens;
      derived.cacheCreationInputTokens = requestTotals.cacheCreationInputTokens;
      derived.reasoningOutputTokens = requestTotals.reasoningOutputTokens;
    }

    // Auto-derive a descriptive title from the first user message if the current title is missing or is 'New Conversation'
    if (
      !conversation.title ||
      conversation.title === DEFAULT_CONVERSATION_TITLE
    ) {
      const firstUserMessage = (conversation.messages as ChatMessage[])?.find(
        (chatMessage) => chatMessage.role === "user",
      );
      if (firstUserMessage?.content) {
        const titleSnippet = (firstUserMessage.content as string)
          .slice(0, MAXIMUM_DERIVED_CONVERSATION_TITLE_LENGTH)
          .trim();
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
    return {
      ...conversation,
      ...derived,
    } as unknown as TransformedConversation;
  },

  /**
   * Overwrite the crash-safety shadow copy of the in-flight turn's messages.
   *
   * Messages only land in `messages` at finalize — a crash/restart mid-turn
   * previously lost the entire turn (user message included), leaving the
   * conversation as an empty stub. Each agentic iteration overwrites this
   * field with the accumulated sanitized turn messages; the next successful
   * appendMessages atomically $unsets it, and startup recovery appends any
   * orphaned checkpoint left behind by a dead process.
   *
   * Lightweight by design: plain $set on the existing document (the eager
   * markGenerating stub), no upsert, no derived-field recompute.
   */
  async saveTurnCheckpoint(
    conversationId: string,
    project: string,
    username: string,
    messages: Array<ChatMessage | MessagePayload>,
    { collection = DEFAULT_COLLECTION }: { collection?: string } = {},
  ): Promise<void> {
    if (!conversationId || messages.length === 0) return;
    const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
    await dbCollection.updateOne(
      { id: conversationId, project, username },
      {
        $set: {
          turnCheckpoint: {
            messages,
            savedAt: new Date().toISOString(),
          },
        },
      },
    );
  },

  /**
   * Recover orphaned turn checkpoints left behind by a crash/restart.
   *
   * Any surviving turnCheckpoint at process start is orphaned by definition
   * (no turn can be in flight yet), so its messages are appended for real
   * via appendMessages — which also recomputes derived fields, derives the
   * title, and atomically clears the checkpoint.
   */
  async recoverOrphanedTurnCheckpoints({
    collection = DEFAULT_COLLECTION,
  }: { collection?: string } = {}): Promise<number> {
    const dbCollection = MongoWrapper.getCollection(MONGO_DB_NAME, collection);
    const orphanedConversations = await dbCollection
      .find({ "turnCheckpoint.messages.0": { $exists: true } })
      .project({ id: 1, project: 1, username: 1, turnCheckpoint: 1 })
      .toArray();

    let recoveredCount = 0;
    for (const orphaned of orphanedConversations) {
      try {
        await ConversationService.appendMessages(
          orphaned.id as string,
          (orphaned.project as string) || "any",
          (orphaned.username as string) || "any",
          (orphaned.turnCheckpoint as { messages: ChatMessage[] }).messages,
          null,
          { collection },
        );
        recoveredCount++;
        logger.info(
          `[ConversationService] Recovered ${(orphaned.turnCheckpoint as { messages: ChatMessage[] }).messages.length} ` +
            `checkpointed message(s) into conversation ${orphaned.id} after unclean shutdown`,
        );
      } catch (error: unknown) {
        logger.error(
          `[ConversationService] Failed to recover turn checkpoint for ${orphaned.id}: ${getErrorMessage(error)}`,
        );
      }
    }
    return recoveredCount;
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
    {
      collection = DEFAULT_COLLECTION,
      agent,
      title,
      agentConversationId,
      profileId,
    }: {
      collection?: string;
      agent?: string;
      title?: string;
      agentConversationId?: string;
      profileId?: string;
    } = {},
  ): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const now = new Date().toISOString();

    // Profile stamp — literal id only; ALS fallback covers callers that
    // can't thread it through opts (e.g. utils/ConversationUtilities).
    const stampProfileId = profileId || getRequestContext().profileId;

    if (generating) {
      // Upsert — create a stub if it doesn't exist yet
      await db.collection(collection).updateOne(
        { id: conversationId, project, username },
        {
          $set: {
            isGenerating: true,
            isActive: true,
            updatedAt: now,
            ...(agentConversationId && { agentConversationId }),
            ...(stampProfileId && { profileId: stampProfileId }),
          },
          $setOnInsert: {
            title: title || DEFAULT_CONVERSATION_TITLE,
            messages: [],
            systemPrompt: "",
            settings: {},
            modalities: computeModalities([]),
            providers: [],
            totalCost: 0,
            inputTokens: 0,
            outputTokens: 0,
            toolCounts: {},
            modelNames: [],
            createdAt: now,
            ...(agent && { agent }),
          },
        },
        { upsert: true },
      );
    } else {
      // Use an aggregation pipeline so isActive is derived atomically from
      // the resulting pendingBackgroundTasks value — no second round-trip needed.
      await db
        .collection(collection)
        .updateOne(
          { id: conversationId, project, username },
          [
            { $set: { isGenerating: false, updatedAt: now } },
            {
              $set: {
                isActive: { $gt: [{ $ifNull: ["$pendingBackgroundTasks", 0] }, 0] },
              },
            },
          ],
        );
    }
  },

  /**
   * Atomically adjust the pendingBackgroundTasks counter on a conversation.
   * Uses MongoDB $inc for race-safe concurrent completions.
   * After decrementing, clamps to 0 to prevent negative counts from
   * double-decrements or crash recovery edge cases.
   */
  async adjustPendingBackgroundTasks(
    conversationId: string,
    project: string,
    username: string,
    delta: number,
    { collection = DEFAULT_COLLECTION }: { collection?: string } = {},
  ): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const now = new Date().toISOString();

    // Single atomic aggregation pipeline: clamp the counter at 0 and derive
    // isActive from the resulting values — no second round-trip needed.
    await db
      .collection(collection)
      .updateOne(
        { id: conversationId, project, username },
        [
          {
            $set: {
              pendingBackgroundTasks: {
                $max: [
                  { $add: [{ $ifNull: ["$pendingBackgroundTasks", 0] }, delta] },
                  0,
                ],
              },
              updatedAt: now,
            },
          },
          {
            $set: {
              isActive: {
                $or: [
                  { $eq: ["$isGenerating", true] },
                  { $gt: ["$pendingBackgroundTasks", 0] },
                ],
              },
            },
          },
        ],
      );
  },

  async getConversationStats(
    conversationId: string,
    project: string,
    username: string,
  ): Promise<TransformedConversationStats | null> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return null;

    // Recursively discover all descendant conversation IDs (multi-level sub-agents)
    const allConversationIds = await discoverDescendantConversationIds(
      db,
      conversationId,
      {
        project,
        username,
      },
    );



    interface RequestProjection {
      estimatedCost?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      reasoningOutputTokens?: number;
      provider?: string;
      model?: string;
      operation?: string;
      createdAt?: string;
      modalities?: Record<string, boolean>;
      toolApiNames?: string[];
      success?: boolean;
      clientIp?: string;
      agentConversationId?: string;
      parentAgentConversationId?: string;
    }

    const requests = (await db
      .collection(COLLECTIONS.REQUESTS)
      .find({
        agentConversationId: { $in: [...allConversationIds] },
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
        createdAt: 1,
        modalities: 1,
        toolApiNames: 1,
        success: 1,
        clientIp: 1,
        agentConversationId: 1,
        parentAgentConversationId: 1,
      })
      .toArray()) as unknown as RequestProjection[];

    if (requests.length === 0) {
      return null;
    }

    // Aggregate
    const providers = new Set<string>();
    const models = new Set<string>();
    const operations = new Set<string>();
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let totalCacheCreationInputTokens = 0;
    let totalReasoningOutputTokens = 0;
    const mergedModalities: Record<string, boolean> = {};
    const toolCounts: Record<string, number> = {};
    let requestErrorCount = 0;

    for (const request of requests) {
      totalCost += request.estimatedCost || 0;
      totalInputTokens += request.inputTokens || 0;
      totalOutputTokens += request.outputTokens || 0;
      totalCacheReadInputTokens += request.cacheReadInputTokens || 0;
      totalCacheCreationInputTokens += request.cacheCreationInputTokens || 0;
      totalReasoningOutputTokens += request.reasoningOutputTokens || 0;
      if (request.provider) providers.add(request.provider);
      if (request.model) models.add(request.model);
      if (request.operation) operations.add(request.operation);
      // Merge modalities
      if (request.modalities) {
        for (const [k, value] of Object.entries(request.modalities)) {
          if (value) mergedModalities[k] = true;
        }
      }
      // Count tool usage
      if (request.toolApiNames && request.toolApiNames.length > 0) {
        for (const name of request.toolApiNames) {
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
      const isAutoResponse =
        request.clientIp === "auto-response" ||
        request.clientIp === "async-task-auto-response";
      if (request.success === false && !isAutoResponse) {
        requestErrorCount++;
      }
    }

    const subAgentRequestCount = requests.filter(
      (reservation) => reservation.agentConversationId !== conversationId,
    ).length;

    const createdAt = requests.reduce(
      (min: string | null, r) =>
        !min || (r.createdAt as string) < min ? (r.createdAt as string) : min,
      null as string | null,
    );
    const updatedAt = requests.reduce(
      (max: string | null, r) =>
        !max || (r.createdAt as string) > max ? (r.createdAt as string) : max,
      null as string | null,
    );

    // Wall-clock elapsed time: from first request to last request (includes sub-agents)
    const totalElapsedTime =
      createdAt && updatedAt
        ? Math.max(
            0,
            (new Date(updatedAt as string).getTime() -
              new Date(createdAt as string).getTime()) /
              1000,
          )
        : 0;

    return {
      agentConversationId: conversationId,
      requestCount: requests.length,
      subAgentRequestCount,
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
      requestErrorCount,
      totalElapsedTime,
      createdAt,
      updatedAt,
    };
  },
};

export default ConversationService;

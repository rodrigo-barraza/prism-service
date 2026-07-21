import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, { type Request, type Response, type NextFunction } from "express";
import { ObjectId, type Document } from "mongodb";
import requireDb from "#src/middleware/RequireDbMiddleware";
import ConversationService, {
  attachConversationState,
  buildConversationPatchFields,
  type ConversationPatchInput,
  deriveAgentConversationState,
  enrichConversationsWithRequestCosts,
  enrichSingleConversationCost,
  prepareDisplayMessages,
} from "#src/services/ConversationService";
import { COLLECTIONS, COST_SUMMATION_EXPRESSION, ORCHESTRATOR } from "#src/constants";
import logger from "#src/utils/logger";
import ConversationTimerService from "#src/services/ConversationTimerService";
import ConversationStatusRegistry from "#src/services/ConversationStatusRegistry";
import AgenticLoopService from "#src/services/AgenticLoopService";
import {
  GetConversationsQuerySchema,
  PostConversationMessagesBodySchema,
  PatchConversationBodySchema,
} from "#src/types/index";
import { CONVERSATION_LIST_BASE_PROJECTION } from "#src/utils/QueryBuilders";

const router = express.Router();
router.use(requireDb);

const CONVERSATION_LIST_PROJECTION: import("mongodb").Document = {
  ...CONVERSATION_LIST_BASE_PROJECTION,
  traceId: 1,
  synthetic: 1,
  systemPrompt: 1,
  model: 1,
  modelNames: 1,
  settings: 1,
  parentAgentConversationId: 1,
  subAgents: 1,
};

interface ConversationDocument {
  _id: ObjectId;
  id: string;
  project: string;
  username: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modalities?: Record<string, boolean>;
  providers?: string[];
  totalCost?: number;
  isGenerating?: boolean;
  isActive?: boolean;
  pendingBackgroundTasks?: number;
  traceId?: string | null;
  synthetic?: boolean;
  messages: Record<string, unknown>[];
  systemPrompt?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

interface WorkflowDocument {
  _id: ObjectId;
  workflowName: string;
  conversationIds: string[];
  updatedAt: Date;
}

/**
 * GET /conversations
 * List both direct conversations and agent conversations, merged and sorted by updatedAt.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const username = req.username || "any";
      const { db } = req;

      const parsed = GetConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const {
        limit,
        cursor,
        agent,
        type = "all",
        taskId,
        project: queryProject,
      } = parsed.data;
      const project = queryProject || req.project || "any";

      const filter: Record<string, unknown> = {};
      if (taskId) {
        filter.taskId = taskId;
      } else {
        filter.project = project;
        filter.username = username;
      }
      if (cursor) {
        filter.updatedAt = { $lt: cursor };
      }

      let modelConversations: Document[] = [];
      let agentConversations: Document[] = [];

      const fetchModelConversations = () =>
        db
          .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
          .find(filter)
          .project<Omit<ConversationDocument, "messages">>(
            CONVERSATION_LIST_PROJECTION,
          )
          .sort({ updatedAt: -1 })
          .limit(limit + 1)
          .toArray();

      const fetchAgentConversations = async () => {
        const agentFilter = { ...filter };
        if (agent) {
          agentFilter.agent = agent;
        }
        const directMatches = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .find(agentFilter)
          .project(CONVERSATION_LIST_PROJECTION)
          .sort({ updatedAt: -1 })
          .limit(limit + 1)
          .toArray();

        // When filtering by agent, also discover sub-agent conversations
        // spawned by the matched orchestrator conversations — these may
        // have a different `agent` persona but belong to the same tree.
        if (agent && directMatches.length > 0) {
          const directMatchIds = directMatches
            .map(
              (document) => (document as Record<string, unknown>).id as string,
            )
            .filter(Boolean);

          // Iteratively walk the parentConversationId chain to find all
          // descendant sub-agent conversations (multi-level nesting).
          const allDiscoveredIds = new Set(directMatchIds);
          let frontier = directMatchIds;
          const maxDepthIterations = 5;

          for (
            let depth = 0;
            depth < maxDepthIterations && frontier.length > 0;
            depth++
          ) {
            const childConversations = await db
              .collection(COLLECTIONS.AGENT_CONVERSATIONS)
              .find({
                parentConversationId: { $in: frontier },
                project: filter.project,
                username: filter.username,
                ...(cursor ? { updatedAt: filter.updatedAt } : {}),
              })
              .project(CONVERSATION_LIST_PROJECTION)
              .sort({ updatedAt: -1 })
              .toArray();

            const newFrontier: string[] = [];
            for (const childConversation of childConversations) {
              const childRecord = childConversation as Record<string, unknown>;
              const childId = childRecord.id as string;
              if (childId && !allDiscoveredIds.has(childId)) {
                allDiscoveredIds.add(childId);
                directMatches.push(childConversation);
                newFrontier.push(childId);
              }
            }
            frontier = newFrontier;
          }
        }

        return directMatches;
      };

      if (type === "all") {
        const [fetchedModelConversations, fetchedAgentConversations] =
          await Promise.all([
            fetchModelConversations(),
            fetchAgentConversations(),
          ]);
        modelConversations = fetchedModelConversations;
        agentConversations = fetchedAgentConversations;
      } else if (type === "direct") {
        modelConversations = await fetchModelConversations();
      } else if (type === "agent") {
        agentConversations = await fetchAgentConversations();
      }

      // Enrich conversations with authoritative totalCost from request logs.
      // The document-level totalCost (from message estimatedCost sums) can be
      // stale or incomplete — the requests collection is the source of truth.
      // Background operations (memory extraction, embedding, consolidation)
      // log costs to the requests collection but never update the conversation
      // document, causing the sidebar cost badge to show stale values.
      const queryAndEnrichConversationsWithRequestCosts = async (
        conversations: Document[],
        isAgentType: boolean,
      ) => {
        if (conversations.length === 0) return;
        const conversationIds = conversations
          .map(
            (conversation) =>
              (conversation as Record<string, unknown>).id as string,
          )
          .filter(Boolean);
        if (conversationIds.length === 0) return;

        try {
          const matchCondition = isAgentType
            ? {
                $or: [
                  { agentConversationId: { $in: conversationIds } },
                  { conversationId: { $in: conversationIds } },
                  { parentAgentConversationId: { $in: conversationIds } },
                ],
              }
            : { conversationId: { $in: conversationIds } };

          const groupId = isAgentType
            ? {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$parentAgentConversationId", null] },
                      { $in: ["$parentAgentConversationId", conversationIds] },
                    ],
                  },
                  "$parentAgentConversationId",
                  { $ifNull: ["$conversationId", "$agentConversationId"] },
                ],
              }
            : "$conversationId";

          const costAggregation = await db
            .collection(COLLECTIONS.REQUESTS)
            .aggregate<{
              _id: string;
              totalCost: number;
              requestErrorCount: number;
            }>([
              {
                $match: {
                  ...matchCondition,
                  project,
                  username,
                },
              },
              {
                $group: {
                  _id: groupId,
                  totalCost: COST_SUMMATION_EXPRESSION,
                  requestErrorCount: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ["$success", false] },
                            { $ne: ["$clientIp", "auto-response"] },
                            { $ne: ["$clientIp", "async-task-auto-response"] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ])
            .toArray();

          enrichConversationsWithRequestCosts(
            conversations as ConversationDocument[],
            costAggregation,
          );
        } catch (costError: unknown) {
          logger.warn(
            `Failed to enrich ${isAgentType ? "agent conversation" : "conversation"} costs: ${errorMessage(costError)}`,
          );
        }
      };

      // Enrich conversations with `hasSubAgents` by cross-referencing
      // child conversations that point back via `parentConversationId`.
      // The stored flag may be missing on conversations created before the flag
      // was introduced or when the write failed silently at spawn time.
      const enrichConversationsWithSubAgentFlag = async (
        conversations: Document[],
      ) => {
        if (conversations.length === 0) return;
        const conversationIds = conversations
          .map(
            (conversation) =>
              (conversation as Record<string, unknown>).id as string,
          )
          .filter(Boolean);
        if (conversationIds.length === 0) return;

        try {
          const parentFieldQuery = {
            parentConversationId: { $in: conversationIds },
            project,
            username,
          };
          const [agentParents, modelParents] = await Promise.all([
            db
              .collection(COLLECTIONS.AGENT_CONVERSATIONS)
              .find(parentFieldQuery)
              .project({ parentConversationId: 1 })
              .toArray(),
            db
              .collection(COLLECTIONS.MODEL_CONVERSATIONS)
              .find(parentFieldQuery)
              .project({ parentConversationId: 1 })
              .toArray(),
          ]);

          const parentIdSet = new Set<string>();
          for (const childDocument of [...agentParents, ...modelParents]) {
            const documentRecord = childDocument as Record<string, unknown>;
            const linkId = documentRecord.parentConversationId as string | null;
            if (linkId) parentIdSet.add(linkId);
          }

          if (parentIdSet.size > 0) {
            for (const conversation of conversations) {
              const conversationRecord = conversation as Record<
                string,
                unknown
              >;
              if (parentIdSet.has(conversationRecord.id as string)) {
                conversationRecord.hasSubAgents = true;
              }
            }
          }
        } catch (enrichmentError: unknown) {
          logger.warn(
            `Failed to enrich conversations with hasSubAgents flag: ${errorMessage(enrichmentError)}`,
          );
        }
      };

      await Promise.all([
        queryAndEnrichConversationsWithRequestCosts(modelConversations, false),
        queryAndEnrichConversationsWithRequestCosts(agentConversations, true),
        enrichConversationsWithSubAgentFlag(modelConversations),
        enrichConversationsWithSubAgentFlag(agentConversations),
      ]);

      // Derive hasSubAgents from the stored subAgents array (primary source
      // of truth, written by BaseAgenticHarness.finalize) and strip the
      // heavy array from the list response. The cross-reference enrichment
      // above acts as a secondary fallback for conversations that predate the
      // subAgents array or where finalize didn't run.
      const deriveAndStripSubAgentsArray = (conversations: Document[]) => {
        for (const conversation of conversations) {
          const record = conversation as Record<string, unknown>;
          const storedSubAgents = record.subAgents as unknown[] | undefined;
          if (
            storedSubAgents &&
            Array.isArray(storedSubAgents) &&
            storedSubAgents.length > 0
          ) {
            record.hasSubAgents = true;
          }
          delete record.subAgents;
        }
      };
      deriveAndStripSubAgentsArray(modelConversations);
      deriveAndStripSubAgentsArray(agentConversations);

      // Stamp the canonical activity state now that cost/error and sub-agent
      // enrichment have run — the ladder reads the enriched fields.
      for (const conversation of [...modelConversations, ...agentConversations]) {
        attachConversationState(conversation as Record<string, unknown>);
      }

      // Merge and sort in memory by updatedAt descending
      const merged = [
        ...modelConversations.map((conversation) => ({
          ...conversation,
          type: "direct" as const,
        })),
        ...agentConversations.map((conversation) => ({
          ...conversation,
          type: "agent" as const,
        })),
      ] as (Document & { type: string })[];
      merged.sort(
        (firstConversation, secondConversation) =>
          new Date(secondConversation.updatedAt as string).getTime() -
          new Date(firstConversation.updatedAt as string).getTime(),
      );

      const hasMore = merged.length > limit;
      const items = hasMore ? merged.slice(0, limit) : merged;
      const nextCursor = hasMore
        ? (items[items.length - 1].updatedAt as string)
        : null;

      res.json({ items, nextCursor, hasMore });
    } catch (error: unknown) {
      logger.error(
        `Error fetching unified conversations: ${errorMessage(error)}`,
      );
      next(error);
    }
  }),
);

/**
 * GET /conversations/:id
 * Get a specific conversation or agent conversation.
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryProject = req.query.project as string | undefined;
      const project = queryProject || req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

      const usernameFilter = username;

      // Check conversations first
      const chat = await db
        .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
        .findOne({ id: conversationId, project, username: usernameFilter });

      if (chat) {
        // Enrich totalCost from the requests collection (source of truth).
        // Background operations (memory extraction, embedding) log their
        // costs to requests but never update the conversation document.
        try {
          const costAggregation = await db
            .collection(COLLECTIONS.REQUESTS)
            .aggregate<{
              _id: string;
              totalCost: number;
              requestErrorCount: number;
            }>([
              {
                $match: { conversationId, project, username: usernameFilter },
              },
              {
                $group: {
                  _id: "$conversationId",
                  totalCost: COST_SUMMATION_EXPRESSION,
                  requestErrorCount: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ["$success", false] },
                            { $ne: ["$clientIp", "auto-response"] },
                            { $ne: ["$clientIp", "async-task-auto-response"] },
                          ],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                },
              },
            ])
            .toArray();

          enrichSingleConversationCost(chat, costAggregation);
        } catch {
          // Non-fatal — fall back to document-level totalCost
        }

        const pendingApproval =
          AgenticLoopService.getPendingApproval(conversationId);
        const pendingQuestion =
          AgenticLoopService.getPendingQuestion(conversationId);
        // Raw `messages` are deliberately omitted — displayMessages is the
        // serve-time form and shipping both doubles a multi-hundred-KB payload
        const { messages: rawMessages, ...chatWithoutMessages } = chat;
        return res.json({
          ...chatWithoutMessages,
          type: "direct",
          state: deriveAgentConversationState(chat),
          messageCount: (
            (rawMessages as import("../types/admin.ts").ChatMessage[]) || []
          ).length,
          displayMessages: prepareDisplayMessages(
            (rawMessages as import("../types/admin.ts").ChatMessage[]) || [],
          ),
          liveStatus: (chat.isGenerating || chat.isActive)
            ? ConversationStatusRegistry.get(conversationId) || undefined
            : undefined,
          pendingApproval: pendingApproval.isPending
            ? pendingApproval
            : undefined,
          pendingQuestion: pendingQuestion.isPending
            ? pendingQuestion
            : undefined,
        });
      }

      // Check agent conversations next
      const agentChat = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: conversationId, project, username: usernameFilter });

      if (agentChat) {
        const stats = await ConversationService.getConversationStats(
          conversationId,
          project,
          username,
        );
        const pendingApproval =
          AgenticLoopService.getPendingApproval(conversationId);
        const pendingQuestion =
          AgenticLoopService.getPendingQuestion(conversationId);

        // Derive hasSubAgents from the stored subAgents array when the
        // persisted boolean flag is missing (conversations created before the
        // flag was introduced or when the OrchestratorService write failed).
        const agentChatRecord = agentChat as Record<string, unknown>;
        if (
          !agentChatRecord.hasSubAgents &&
          Array.isArray(agentChatRecord.subAgents) &&
          (agentChatRecord.subAgents as unknown[]).length > 0
        ) {
          agentChatRecord.hasSubAgents = true;
        }

        const isConversationActive = !!(agentChatRecord.isGenerating || agentChatRecord.isActive);

        // Raw `messages` are deliberately omitted — displayMessages is the
        // serve-time form and shipping both doubles a multi-hundred-KB payload
        const { messages: rawAgentMessages, ...agentChatWithoutMessages } =
          agentChat;
        return res.json({
          ...agentChatWithoutMessages,
          stats: stats || undefined,
          type: "agent",
          state: deriveAgentConversationState(
            agentChatRecord as Parameters<typeof deriveAgentConversationState>[0],
          ),
          messageCount: (
            (rawAgentMessages as import("../types/admin.ts").ChatMessage[]) ||
            []
          ).length,
          displayMessages: prepareDisplayMessages(
            (rawAgentMessages as import("../types/admin.ts").ChatMessage[]) || [],
          ),
          liveStatus: isConversationActive
            ? ConversationStatusRegistry.get(conversationId) || undefined
            : undefined,
          pendingApproval: pendingApproval.isPending
            ? pendingApproval
            : undefined,
          pendingQuestion: pendingQuestion.isPending
            ? pendingQuestion
            : undefined,
        });
      }

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      logger.error(
        `Error fetching specific conversation: ${errorMessage(error)}`,
      );
      next(error);
    }
  }),
);

/**
 * GET /conversations/:id/live-status
 * Returns the real-time generation status for an active conversation.
 * Reads from an in-memory registry — no database query.
 */
router.get(
  "/:id/live-status",
  asyncHandler(async (req: Request, res: Response) => {
    const conversationId = req.params.id as string;
    const liveStatus = ConversationStatusRegistry.get(conversationId);
    if (liveStatus) {
      res.json({ active: true, ...liveStatus });
    } else {
      res.json({ active: false });
    }
  }),
);

/**
 * GET /conversations/:id/status
 * Lightweight persisted-state snapshot for pollers. The full GET /:id ships
 * the entire displayMessages payload (hundreds of KB on large conversations);
 * background pollers only need the lifecycle flags, so this projects them
 * straight off the document.
 */
router.get(
  "/:id/status",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryProject = req.query.project as string | undefined;
      const project = queryProject || req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;
      const statusProjection = {
        _id: 0,
        id: 1,
        isActive: 1,
        isGenerating: 1,
        pendingBackgroundTasks: 1,
        updatedAt: 1,
      };

      const chatStatus = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .findOne(
          { id: conversationId, project, username },
          { projection: statusProjection },
        );
      if (chatStatus) return res.json({ ...chatStatus, type: "direct" });

      const agentChatStatus = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne(
          { id: conversationId, project, username },
          { projection: statusProjection },
        );
      if (agentChatStatus)
        return res.json({ ...agentChatStatus, type: "agent" });

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      logger.error(
        `Error fetching conversation status: ${errorMessage(error)}`,
      );
      next(error);
    }
  }),
);

/**
 * GET /conversations/:id/workflows
 * Find workflows that include this conversation ID.
 */
router.get(
  "/:id/workflows",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const conversationId = req.params.id as string;

      const workflows = await db
        .collection<WorkflowDocument>("workflows")
        .find({ conversationIds: conversationId })
        .project({ workflowName: 1, updatedAt: 1 })
        .toArray();

      res.json(workflows);
    } catch (error: unknown) {
      logger.error(
        `Error fetching conversation workflows: ${errorMessage(error)}`,
      );
      next(error);
    }
  }),
);

/**
 * POST /conversations/:id/messages
 * Append messages to an existing conversation or agent conversation.
 */
router.post(
  "/:id/messages",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryProject = req.query.project as string | undefined;
      const project = queryProject || req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;
      const usernameFilter = username;

      const parsed = PostConversationMessagesBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const { messages, conversationMeta } = parsed.data;

      // Determine which collection has this chat
      let isAgent = false;
      const directExists = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .countDocuments({
          id: conversationId,
          project,
          username: usernameFilter,
        });

      if (directExists === 0) {
        const agentExists = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .countDocuments({
            id: conversationId,
            project,
            username: usernameFilter,
          });
        if (agentExists > 0) {
          isAgent = true;
        } else {
          return res.status(404).json({ error: "Conversation not found" });
        }
      }

      const conversation = await ConversationService.appendMessages(
        conversationId,
        project,
        username,
        messages as import("../types/admin.ts").ChatMessage[],
        conversationMeta || null,
        { collection: isAgent ? COLLECTIONS.AGENT_CONVERSATIONS : undefined },
      );

      res.json({ ...conversation, type: isAgent ? "agent" : "direct" });
    } catch (error: unknown) {
      logger.error(
        `Error appending messages to conversation: ${errorMessage(error)}`,
      );
      next(error);
    }
  }),
);

/**
 * PATCH /conversations/:id
 * Update specific fields of a conversation or agent conversation.
 */
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryProject = req.query.project as string | undefined;
      const project = queryProject || req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;
      const usernameFilter = username;

      const parsed = PatchConversationBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const setFields = buildConversationPatchFields(
        parsed.data as unknown as ConversationPatchInput,
      );

      // Try updating conversations first
      let result = await db
        .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
        .updateOne(
          { id: conversationId, project, username: usernameFilter },
          {
            $set: setFields as import("mongodb").UpdateFilter<ConversationDocument>,
          },
        );

      if (result.matchedCount > 0) {
        const conversation = await db
          .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
          .findOne({ id: conversationId, project, username: usernameFilter });
        return res.json({ ...conversation, type: "direct" });
      }

      // Try updating agent conversations next
      result = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).updateOne(
        { id: conversationId, project, username: usernameFilter },
        {
          $set: setFields as import("mongodb").UpdateFilter<
            import("mongodb").Document
          >,
        },
      );

      if (result.matchedCount > 0) {
        const agentConversation = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .findOne({ id: conversationId, project, username: usernameFilter });
        return res.json({ ...agentConversation, type: "agent" });
      }

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      logger.error(`Error patching conversation: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /conversations/:id
 * Delete a specific conversation or agent conversation.
 * Cascading: iteratively deletes all descendant sub-agent conversations
 * linked via `parentConversationId` across both collections.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const queryProject = req.query.project as string | undefined;
      const project = queryProject || req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;
      const usernameFilter = username;

      // Try deleting from conversations first
      let result = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .deleteOne({ id: conversationId, project, username: usernameFilter });

      let deletedType: string | null = null;
      if (result.deletedCount > 0) {
        deletedType = "direct";
      } else {
        // Try deleting from agent conversations next
        result = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .deleteOne({ id: conversationId, project, username: usernameFilter });

        if (result.deletedCount > 0) {
          deletedType = "agent";
        }
      }

      if (!deletedType) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Cascading deletion: iteratively discover and delete all descendant
      // conversations linked via parentConversationId (BFS traversal).
      const MAX_CASCADE_DEPTH = ORCHESTRATOR.AGENT_TREE_DISCOVERY_MAX_DEPTH;
      const ownershipFilter = { project, username: usernameFilter };
      let descendantDeletedCount = 0;
      let frontier = [conversationId];

      for (
        let depth = 0;
        depth < MAX_CASCADE_DEPTH && frontier.length > 0;
        depth++
      ) {
        const parentFilter = {
          parentConversationId: { $in: frontier },
          ...ownershipFilter,
        };

        // Discover child IDs from both collections before deleting
        const [agentChildren, modelChildren] = await Promise.all([
          db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .find(parentFilter)
            .project({ id: 1 })
            .toArray(),
          db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .find(parentFilter)
            .project({ id: 1 })
            .toArray(),
        ]);

        const childIds = [
          ...agentChildren.map(
            (document) => (document as Record<string, unknown>).id as string,
          ),
          ...modelChildren.map(
            (document) => (document as Record<string, unknown>).id as string,
          ),
        ].filter(Boolean);

        if (childIds.length === 0) break;

        // Bulk-delete children from both collections
        const [agentDeletion, modelDeletion] = await Promise.all([
          db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .deleteMany({ id: { $in: childIds }, ...ownershipFilter }),
          db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .deleteMany({ id: { $in: childIds }, ...ownershipFilter }),
        ]);

        descendantDeletedCount +=
          (agentDeletion.deletedCount || 0) + (modelDeletion.deletedCount || 0);
        frontier = childIds;
      }

      if (descendantDeletedCount > 0) {
        logger.info(
          `Cascade-deleted ${descendantDeletedCount} descendant conversation(s) for ${conversationId}`,
        );
      }

      return res.json({
        success: true,
        id: conversationId,
        type: deletedType,
        descendantsDeleted: descendantDeletedCount,
      });
    } catch (error: unknown) {
      logger.error(`Error deleting conversation: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /conversations/:id/timers
 * List all active scheduled timers for this conversation.
 */
router.get(
  "/:id/timers",
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project || "any";
    const username = req.username || "any";
    const conversationId = req.params.id as string;

    const activeTimers = await ConversationTimerService.listActiveTimers(
      conversationId,
      project,
      username,
    );
    res.json(activeTimers);
  }),
);

/**
 * POST /conversations/:id/timers/:timerId/cancel
 * Cancel a specific scheduled timer.
 */
router.post(
  "/:id/timers/:timerId/cancel",
  asyncHandler(async (req: Request, res: Response) => {
    const project = req.project || "any";
    const username = req.username || "any";
    const timerId = req.params.timerId as string;

    const wasCancelled = await ConversationTimerService.cancelTimer(
      timerId,
      project,
      username,
    );
    res.json({ success: wasCancelled });
  }),
);

export default router;

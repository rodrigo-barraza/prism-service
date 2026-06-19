import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId, type Document } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import ConversationService, {
  buildConversationPatchFields,
  type ConversationPatchInput,
  enrichConversationsWithRequestCosts,
  enrichSingleConversationCost,
} from "../services/ConversationService.ts";
import { COLLECTIONS, COST_SUM_EXPR } from "../constants.ts";
import logger from "../utils/logger.ts";
import ConversationTimerService from "../services/ConversationTimerService.ts";
import AgenticLoopService from "../services/AgenticLoopService.ts";
import {
  GetConversationsQuerySchema,
  PostConversationMessagesBodySchema,
  PatchConversationBodySchema,
} from "../types/index.ts";

const router = express.Router();
router.use(requireDb);

const CONVERSATION_LIST_PROJECTION: import("mongodb").Document = {
  id: 1,
  project: 1,
  username: 1,
  title: 1,
  createdAt: 1,
  updatedAt: 1,
  modalities: 1,
  providers: 1,
  totalCost: 1,
  isGenerating: 1,
  traceId: 1,
  synthetic: 1,
  agent: 1,
  systemPrompt: 1,
  model: 1,
  modelNames: 1,
  settings: 1,
  parentAgentSessionId: 1,
  hasSubAgents: 1,
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
 * List both direct conversations and agent sessions, merged and sorted by updatedAt.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const parsed = GetConversationsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const { limit, cursor, agent, type = "all", taskId } = parsed.data;

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

      const fetchAgentConversations = () => {
        const agentFilter = { ...filter };
        if (agent) {
          agentFilter.agent = agent;
        }
        return db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .find(agentFilter)
          .project(CONVERSATION_LIST_PROJECTION)
          .sort({ updatedAt: -1 })
          .limit(limit + 1)
          .toArray();
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
          .map((session) => (session as Record<string, unknown>).id as string)
          .filter(Boolean);
        if (conversationIds.length === 0) return;

        try {
          const matchCondition = isAgentType
            ? {
                $or: [
                  { agentSessionId: { $in: conversationIds } },
                  { conversationId: { $in: conversationIds } },
                  { parentAgentSessionId: { $in: conversationIds } },
                ],
              }
            : { conversationId: { $in: conversationIds } };

          const groupId = isAgentType
            ? {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$parentAgentSessionId", null] },
                      { $in: ["$parentAgentSessionId", conversationIds] },
                    ],
                  },
                  "$parentAgentSessionId",
                  { $ifNull: ["$conversationId", "$agentSessionId"] },
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
                  totalCost: COST_SUM_EXPR,
                  requestErrorCount: {
                    $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
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
            `Failed to enrich ${isAgentType ? "agent session" : "conversation"} costs: ${errorMessage(costError)}`,
          );
        }
      };

      // Enrich agent sessions with `hasSubAgents` by cross-referencing
      // child sessions that point back via `parentAgentSessionId`.
      // The stored flag may be missing on sessions created before the flag
      // was introduced or when the write failed silently at spawn time.
      const enrichAgentSessionsWithSubAgentFlag = async (
        agentSessions: Document[],
      ) => {
        if (agentSessions.length === 0) return;
        const sessionIds = agentSessions
          .map((session) => (session as Record<string, unknown>).id as string)
          .filter(Boolean);
        if (sessionIds.length === 0) return;

        try {
          const parentIdsWithChildren = await db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .distinct("parentAgentSessionId", {
              parentAgentSessionId: { $in: sessionIds },
              project,
              username,
            });

          if (parentIdsWithChildren.length > 0) {
            const parentIdSet = new Set(parentIdsWithChildren);
            for (const session of agentSessions) {
              const sessionRecord = session as Record<string, unknown>;
              if (parentIdSet.has(sessionRecord.id)) {
                sessionRecord.hasSubAgents = true;
              }
            }
          }
        } catch (enrichmentError: unknown) {
          logger.warn(
            `Failed to enrich agent sessions with hasSubAgents flag: ${errorMessage(enrichmentError)}`,
          );
        }
      };

      await Promise.all([
        queryAndEnrichConversationsWithRequestCosts(modelConversations, false),
        queryAndEnrichConversationsWithRequestCosts(agentConversations, true),
        enrichAgentSessionsWithSubAgentFlag(agentConversations),
      ]);

      // Merge and sort in memory by updatedAt descending
      const merged = [
        ...modelConversations.map((conversation) => ({
          ...conversation,
          type: "direct" as const,
        })),
        ...agentConversations.map((session) => ({
          ...session,
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
      logger.error(`Error fetching unified conversations: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /conversations/:id
 * Get a specific conversation or agent session.
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

      // Check conversations first
      const chat = await db
        .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
        .findOne({ id: conversationId, project, username });

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
                $match: { conversationId, project, username },
              },
              {
                $group: {
                  _id: "$conversationId",
                  totalCost: COST_SUM_EXPR,
                  requestErrorCount: {
                    $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
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
        return res.json({
          ...chat,
          type: "direct",
          pendingApproval: pendingApproval.isPending
            ? pendingApproval
            : undefined,
          pendingQuestion: pendingQuestion.isPending
            ? pendingQuestion
            : undefined,
        });
      }

      // Check agent sessions next
      const agentChat = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: conversationId, project, username });

      if (agentChat) {
        const stats = await ConversationService.getSessionStats(
          conversationId,
          project,
          username,
        );
        const pendingApproval =
          AgenticLoopService.getPendingApproval(conversationId);
        const pendingQuestion =
          AgenticLoopService.getPendingQuestion(conversationId);

        return res.json({
          ...agentChat,
          stats: stats || undefined,
          type: "agent",
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
      logger.error(`Error fetching specific conversation: ${errorMessage(error)}`);
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
      logger.error(`Error fetching conversation workflows: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /conversations/:id/messages
 * Append messages to an existing conversation or agent session.
 */
router.post(
  "/:id/messages",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

      const parsed = PostConversationMessagesBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const { messages, conversationMeta } = parsed.data;

      // Determine which collection has this chat
      let isAgent = false;
      const directExists = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .countDocuments({ id: conversationId, project, username });

      if (directExists === 0) {
        const agentExists = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .countDocuments({ id: conversationId, project, username });
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
      logger.error(`Error appending messages to conversation: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * PATCH /conversations/:id
 * Update specific fields of a conversation or agent session.
 */
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

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
          { id: conversationId, project, username },
          {
            $set: setFields as import("mongodb").UpdateFilter<ConversationDocument>,
          },
        );

      if (result.matchedCount > 0) {
        const conversation = await db
          .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
          .findOne({ id: conversationId, project, username });
        return res.json({ ...conversation, type: "direct" });
      }

      // Try updating agent sessions next
      result = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).updateOne(
        { id: conversationId, project, username },
        {
          $set: setFields as import("mongodb").UpdateFilter<
            import("mongodb").Document
          >,
        },
      );

      if (result.matchedCount > 0) {
        const session = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .findOne({ id: conversationId, project, username });
        return res.json({ ...session, type: "agent" });
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
 * Delete a specific conversation or agent session.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

      // Try deleting from conversations first
      let result = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .deleteOne({ id: conversationId, project, username });

      if (result.deletedCount > 0) {
        return res.json({ success: true, id: conversationId, type: "direct" });
      }

      // Try deleting from agent sessions next
      result = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .deleteOne({ id: conversationId, project, username });

      if (result.deletedCount > 0) {
        return res.json({ success: true, id: conversationId, type: "agent" });
      }

      res.status(404).json({ error: "Conversation not found" });
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

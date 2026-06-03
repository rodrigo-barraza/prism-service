import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId, type Document } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import ConversationService, {
  buildConversationPatchFields,
  type ConversationPatchInput,
} from "../services/ConversationService.ts";
import { COLLECTIONS } from "../constants.ts";
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

const CONVERSATION_LIST_PROJECTION = {
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
} as const;

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

      const { limit, cursor, agent, type = "all" } = parsed.data;

      const filter: Record<string, unknown> = { project, username };
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
            CONVERSATION_LIST_PROJECTION as unknown as import("mongodb").Document
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
          .project(CONVERSATION_LIST_PROJECTION as unknown as import("mongodb").Document)
          .sort({ updatedAt: -1 })
          .limit(limit + 1)
          .toArray();
      };

      if (type === "all") {
        const [fetchedModelConversations, fetchedAgentConversations] = await Promise.all([
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

      // Enrich agent sessions with authoritative totalCost from request logs.
      // The document-level totalCost (from message estimatedCost sums) can be
      // stale or incomplete — the requests collection is the source of truth.
      if (agentConversations.length > 0) {
        const sessionIds = agentConversations
          .map((s) => (s as Record<string, unknown>).id as string)
          .filter(Boolean);

        if (sessionIds.length > 0) {
          try {
            const costAgg = await db
              .collection(COLLECTIONS.REQUESTS)
              .aggregate<{ _id: string; totalCost: number }>([
                {
                  $match: {
                    $or: [
                      { agentSessionId: { $in: sessionIds } },
                      { parentAgentSessionId: { $in: sessionIds } },
                    ],
                    project,
                    username,
                  },
                },
                {
                  // Group under the parent session when present, otherwise
                  // use the request's own agentSessionId (top-level request).
                  $group: {
                    _id: {
                      $cond: [
                        {
                          $and: [
                            { $ne: ["$parentAgentSessionId", null] },
                            { $in: ["$parentAgentSessionId", sessionIds] },
                          ],
                        },
                        "$parentAgentSessionId",
                        "$agentSessionId",
                      ],
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                  },
                },
              ])
              .toArray();

            if (costAgg.length > 0) {
              const costMap = new Map(costAgg.map((costEntry) => [costEntry._id, costEntry.totalCost]));
              for (const session of agentConversations) {
                const sessionId = (session as Record<string, unknown>).id as string;
                const requestLogCost = costMap.get(sessionId);
                if (requestLogCost !== undefined && requestLogCost > 0) {
                  (session as Record<string, unknown>).totalCost = Math.max(
                    (session.totalCost as number) || 0,
                    requestLogCost,
                  );
                }
              }
            }
          } catch (costError: unknown) {
            // Non-fatal — fall back to document-level totalCost
            logger.warn(`Failed to enrich agent session costs: ${costError instanceof Error ? costError.message : String(costError)}`);
          }
        }
      }

      // Merge and sort in memory by updatedAt descending
      const merged = [
        ...modelConversations.map((conversation) => ({ ...conversation, type: "direct" as const })),
        ...agentConversations.map((session) => ({ ...session, type: "agent" as const })),
      ] as (Document & { type: string })[];
      merged.sort(
        (firstConversation, secondConversation) =>
          new Date(secondConversation.updatedAt as string).getTime() - new Date(firstConversation.updatedAt as string).getTime()
      );

      const hasMore = merged.length > limit;
      const items = hasMore ? merged.slice(0, limit) : merged;
      const nextCursor = hasMore ? (items[items.length - 1].updatedAt as string) : null;

      res.json({ items, nextCursor, hasMore });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching unified conversations: ${errorMessage}`);
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
      let chat = await db
        .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
        .findOne({ id: conversationId, project, username });

      if (chat) {
        const pendingApproval = AgenticLoopService.getPendingApproval(conversationId);
        const pendingQuestion = AgenticLoopService.getPendingQuestion(conversationId);
        return res.json({
          ...chat,
          type: "direct",
          pendingApproval: pendingApproval.pending ? pendingApproval : undefined,
          pendingQuestion: pendingQuestion.pending ? pendingQuestion : undefined,
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
        const pendingApproval = AgenticLoopService.getPendingApproval(conversationId);
        const pendingQuestion = AgenticLoopService.getPendingQuestion(conversationId);

        return res.json({
          ...agentChat,
          stats: stats || undefined,
          type: "agent",
          pendingApproval: pendingApproval.pending ? pendingApproval : undefined,
          pendingQuestion: pendingQuestion.pending ? pendingQuestion : undefined,
        });
      }

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching specific conversation: ${errorMessage}`);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching conversation workflows: ${errorMessage}`);
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
        { collection: isAgent ? COLLECTIONS.AGENT_CONVERSATIONS : undefined }
      );

      res.json({ ...conversation, type: isAgent ? "agent" : "direct" });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error appending messages to conversation: ${errorMessage}`);
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

      const setFields = buildConversationPatchFields(parsed.data as unknown as ConversationPatchInput);

      // Try updating conversations first
      let result = await db
        .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
        .updateOne(
          { id: conversationId, project, username },
          { $set: setFields }
        );

      if (result.matchedCount > 0) {
        const conversation = await db
          .collection<ConversationDocument>(COLLECTIONS.MODEL_CONVERSATIONS)
          .findOne({ id: conversationId, project, username });
        return res.json({ ...conversation, type: "direct" });
      }

      // Try updating agent sessions next
      result = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateOne(
          { id: conversationId, project, username },
          { $set: setFields }
        );

      if (result.matchedCount > 0) {
        const session = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .findOne({ id: conversationId, project, username });
        return res.json({ ...session, type: "agent" });
      }

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error patching conversation: ${errorMessage}`);
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error deleting conversation: ${errorMessage}`);
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

    const activeTimers = await ConversationTimerService.listActiveTimers(conversationId, project, username);
    res.json(activeTimers);
  })
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

    const wasCancelled = await ConversationTimerService.cancelTimer(timerId, project, username);
    res.json({ success: wasCancelled });
  })
);

export default router;

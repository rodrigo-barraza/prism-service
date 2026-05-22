import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import ConversationService, {
  buildConversationPatchFields,
  type ConversationPatchInput,
} from "../services/ConversationService.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";
import {
  GetConversationsQuerySchema,
  PostConversationMessagesBodySchema,
  PatchConversationBodySchema,
} from "../types/index.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.CONVERSATIONS;

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
 * List conversations for the given project with cursor-based pagination.
 *
 * Query params:
 *   limit  — page size (default 50, max 200)
 *   cursor — ISO date string (updatedAt of last item from previous page)
 *
 * Returns: { items, nextCursor, hasMore }
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

      const { limit, cursor } = parsed.data;

      const filter: Record<string, unknown> = { project, username };
      if (cursor) {
        // updatedAt is stored as ISO-8601 strings — compare string-to-string
        // to match BSON type and allow index range scan
        filter.updatedAt = { $lt: cursor };
      }

      // Fetch limit + 1 to detect if there's a next page
      const rows = await db
        .collection<ConversationDocument>(COLLECTION)
        .find(filter)
        .project<Omit<ConversationDocument, "messages" | "systemPrompt" | "settings">>({
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
        })
        .sort({ updatedAt: -1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].updatedAt : null;

      res.json({ items, nextCursor, hasMore });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching conversations: ${errorMessage}`);
      next(error);
    }
  }),
);

/**
 * GET /conversations/:id
 * Get a specific conversation.
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

      const conversation = await db
        .collection<ConversationDocument>(COLLECTION)
        .findOne({ id: conversationId, project, username });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      res.json(conversation);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error fetching conversation: ${errorMessage}`);
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
 * Append messages to an existing conversation (e.g. tool results after execution).
 */
router.post(
  "/:id/messages",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const conversationId = req.params.id as string;

      const parsed = PostConversationMessagesBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const { messages, conversationMeta } = parsed.data;

      const conversation = await ConversationService.appendMessages(
        conversationId,
        project,
        username,
        messages as import("../types/admin.ts").ChatMessage[],
        conversationMeta || null,
      );

      res.json(conversation);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error appending messages: ${errorMessage}`);
      next(error);
    }
  }),
);

/**
 * PATCH /conversations/:id
 * Update specific fields of a conversation (messages, title, systemPrompt, settings).
 * Used for non-generation mutations (edit/delete messages, rename, etc.).
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

      const result = await db
        .collection<ConversationDocument>(COLLECTION)
        .updateOne(
          { id: conversationId, project, username },
          { $set: setFields },
        );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const conversation = await db
        .collection<ConversationDocument>(COLLECTION)
        .findOne({ id: conversationId, project, username });

      res.json(conversation);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error patching conversation: ${errorMessage}`);
      next(error);
    }
  }),
);

/**
 * DELETE /conversations/:id
 * Delete a specific conversation.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const conversationId = req.params.id as string;

      const result = await db
        .collection<ConversationDocument>(COLLECTION)
        .deleteOne({ id: conversationId, project, username });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      res.json({ success: true, id: conversationId });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error deleting conversation: ${errorMessage}`);
      next(error);
    }
  }),
);

export default router;

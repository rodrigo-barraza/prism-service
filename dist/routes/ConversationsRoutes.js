// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import ConversationService, { buildConversationPatchFields, } from "../services/ConversationService.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";
const router = express.Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.CONVERSATIONS;
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
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const limit = Math.min(
        // @ts-ignore - TODO: strict typing
        Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const cursor = req.query.cursor || null;
        const filter = { project, username };
        if (cursor) {
            // updatedAt is stored as ISO-8601 strings — compare string-to-string
            // to match BSON type and allow index range scan
            // @ts-ignore
            filter.updatedAt = { $lt: cursor };
        }
        // Fetch limit + 1 to detect if there's a next page
        const rows = await db
            .collection(COLLECTION)
            .find(filter)
            .project({
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
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error fetching conversations: ${error.message}`);
        next(error);
    }
}));
/**
 * GET /conversations/:id
 * Get a specific conversation.
 */
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const conversation = await db
            .collection(COLLECTION)
            .findOne({ id: req.params.id, project, username });
        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }
        res.json(conversation);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error fetching conversation: ${error.message}`);
        next(error);
    }
}));
/**
 * GET /conversations/:id/workflows
 * Find workflows that include this conversation ID.
 */
router.get("/:id/workflows", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { db } = req;
        const workflows = await db
            .collection("workflows")
            .find({ conversationIds: req.params.id })
            .project({ workflowName: 1, updatedAt: 1 })
            .toArray();
        res.json(workflows);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error fetching conversation workflows: ${error.message}`);
        next(error);
    }
}));
/**
 * POST /conversations/:id/messages
 * Append messages to an existing conversation (e.g. tool results after execution).
 */
router.post("/:id/messages", asyncHandler(async (req, res, next) => {
    try {
        const { project, username } = req;
        const { messages, conversationMeta } = req.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res
                .status(400)
                .json({ error: "messages must be a non-empty array" });
        }
        const conversation = await ConversationService.appendMessages(
        // @ts-ignore - TODO: strict typing
        req.params.id, project, username, messages, conversationMeta || null);
        res.json(conversation);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error appending messages: ${error.message}`);
        next(error);
    }
}));
/**
 * PATCH /conversations/:id
 * Update specific fields of a conversation (messages, title, systemPrompt, settings).
 * Used for non-generation mutations (edit/delete messages, rename, etc.).
 */
router.patch("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const setFields = buildConversationPatchFields(req.body);
        const result = await db
            .collection(COLLECTION)
            .updateOne({ id: req.params.id, project, username }, { $set: setFields });
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Conversation not found" });
        }
        const conversation = await db
            .collection(COLLECTION)
            .findOne({ id: req.params.id, project, username });
        res.json(conversation);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error patching conversation: ${error.message}`);
        next(error);
    }
}));
/**
 * DELETE /conversations/:id
 * Delete a specific conversation.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const result = await db
            .collection(COLLECTION)
            .deleteOne({ id: req.params.id, project, username });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Conversation not found" });
        }
        res.json({ success: true, id: req.params.id });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error deleting conversation: ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=ConversationsRoutes.js.map
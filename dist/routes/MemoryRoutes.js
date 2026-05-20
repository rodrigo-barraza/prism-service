// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import MemoryService from "../services/MemoryService.js";
import logger from "../utils/logger.js";
const router = express.Router();
/**
 * POST /memory/extract
 * Extract and store memories from a conversation chunk.
 * Body: { guildId, channelId, messages, participants, sourceMessageId? }
 */
router.post("/extract", asyncHandler(async (req, res, next) => {
    try {
        const { guildId, channelId, messages, participants, sourceMessageId, traceId, } = req.body;
        if (!guildId || !messages || !participants) {
            return res.status(400).json({
                error: "Missing required fields: guildId, messages, participants",
            });
        }
        const memories = await MemoryService.extractAndStore({
            guildId,
            channelId,
            messages,
            participants,
            sourceMessageId,
            traceId: traceId || null,
            project: req.project,
            endpoint: "/memory/extract",
        });
        res.json({ memories, count: memories.length });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[memory/extract] ${error.message}`);
        next(error);
    }
}));
/**
 * POST /memory/search
 * Search for relevant memories using vector similarity.
 * Body: { guildId, userIds?, queryText, limit? }
 */
router.post("/search", asyncHandler(async (req, res, next) => {
    try {
        const { guildId, userIds, queryText, limit, traceId } = req.body;
        if (!guildId || !queryText) {
            return res.status(400).json({
                error: "Missing required fields: guildId, queryText",
            });
        }
        const memories = await MemoryService.search({
            agent: "LUPOS",
            guildId,
            userIds,
            queryText,
            limit: limit || 10,
            traceId: traceId || null,
            project: req.project,
            endpoint: "/memory/search",
        });
        res.json({ memories, count: memories.length });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[memory/search] ${error.message}`);
        next(error);
    }
}));
/**
 * GET /memory/list/:guildId/:userId
 * List all memories for a user in a guild.
 */
router.get("/list/:guildId/:userId", asyncHandler(async (req, res, next) => {
    try {
        const { guildId, userId } = req.params;
        // @ts-ignore - TODO: strict typing
        const limit = parseInt(req.query.limit) || 50;
        // @ts-ignore - TODO: strict typing
        const skip = parseInt(req.query.skip) || 0;
        const result = await MemoryService.list({
            agent: "LUPOS",
            guildId,
            userId,
            limit,
            skip,
        });
        res.json(result);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[memory/list] ${error.message}`);
        next(error);
    }
}));
/**
 * DELETE /memory/:id
 * Delete a specific memory.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const deleted = await MemoryService.delete(req.params.id);
        res.json({ deleted });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[memory/delete] ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=MemoryRoutes.js.map
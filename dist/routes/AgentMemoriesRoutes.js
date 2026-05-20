// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import MemoryService from "../services/MemoryService.js";
import MemoryConsolidationService from "../services/MemoryConsolidationService.js";
import logger from "../utils/logger.js";
const router = express.Router();
/**
 * POST /agent-memories
 * Create a new memory via MemoryService.store() (embedding + dedup).
 * Called by tools-api's upsert_memory route.
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const { agent, project, username, content, type, title, agentSessionId } = req.body;
        if (!content) {
            return res.status(400).json({ error: "content is required" });
        }
        const result = await MemoryService.store({
            agent: agent || "CODING",
            project: project || "default",
            username: username || null,
            content,
            type: type || "project",
            title: title || null,
            sessionId: agentSessionId || null,
            endpoint: "/agent-memories",
        });
        if (!result) {
            // Duplicate detected
            return res.json({
                duplicate: true,
                message: "Near-duplicate memory already exists",
            });
        }
        // Strip embedding from response (large vector, not needed by caller)
        const { embedding: _emb, ...safe } = result;
        res.json(safe);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[agent-memories] POST ${error.message}`);
        next(error);
    }
}));
/**
 * GET /agent-memories?project=<project>&agent=<agent>&limit=100&skip=0
 * List all agent memories for a project (read-only).
 * Defaults to agent="CODING" for backward compatibility.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project;
        const agent = req.query.agent || null;
        // @ts-ignore - TODO: strict typing
        const limit = parseInt(req.query.limit) || 100;
        // @ts-ignore - TODO: strict typing
        const skip = parseInt(req.query.skip) || 0;
        const result = await MemoryService.list({ agent, project, limit, skip });
        res.json(result);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[agent-memories] ${error.message}`);
        next(error);
    }
}));
/**
 * DELETE /agent-memories/:id
 * Delete a specific agent memory.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const deleted = await MemoryService.remove(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: "Memory not found" });
        }
        res.json({ success: true });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[agent-memories] DELETE ${error.message}`);
        next(error);
    }
}));
/**
 * GET /agent-memories/discover
 * Aggregate all distinct project/agent combinations with memory counts.
 * Bypasses project scoping — used by the consolidation CLI's --all sweep.
 */
router.get("/discover", asyncHandler(async (req, res, next) => {
    try {
        const combos = await MemoryService.discoverCombos();
        res.json({ combos });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[agent-memories] DISCOVER ${error.message}`);
        next(error);
    }
}));
/**
 * GET /agent-memories/consolidation-history?project=<project>&limit=10
 * Retrieve consolidation run history for a project.
 */
router.get("/consolidation-history", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project;
        // @ts-ignore - TODO: strict typing
        const limit = parseInt(req.query.limit) || 10;
        const history = await MemoryConsolidationService.getHistory(
        // @ts-ignore - TODO: strict typing
        project, limit);
        res.json({ history });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[agent-memories] HISTORY ${error.message}`);
        next(error);
    }
}));
/**
 * POST /agent-memories/consolidate
 * Trigger on-demand memory consolidation for a project.
 */
router.post("/consolidate", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project;
        const agent = req.body.agent || "CODING";
        const username = req.body.username || "system";
        const result = await MemoryConsolidationService.consolidate({
            agent,
            project,
            username,
            trigger: "manual",
            endpoint: "/agent-memories/consolidate",
        });
        res.json(result);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`[agent-memories] CONSOLIDATE ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AgentMemoriesRoutes.js.map
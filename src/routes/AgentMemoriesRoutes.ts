import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import MemoryService from "../services/MemoryService.ts";
import MemoryConsolidationService from "../services/MemoryConsolidationService.ts";
import logger from "../utils/logger.ts";

const router = express.Router();

/**
 * POST /agent-memories
 * Create a new memory via MemoryService.store() (embedding + dedup).
 * Called by tools-api's upsert_memory route.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { agent, project, username, content, type, title, agentSessionId } =
        req.body;
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
    } catch (error: unknown) {
            logger.error(`[agent-memories] POST ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories?project=<project>&agent=<agent>&limit=100&skip=0
 * List all agent memories for a project (read-only).
 * Defaults to agent="CODING" for backward compatibility.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = req.query.agent || null;
            const limit = parseInt((req.query.limit as any)) || 100;
            const skip = parseInt((req.query.skip as any)) || 0;

      const result = await MemoryService.list({ agent, project, limit, skip });
      res.json(result);
    } catch (error: unknown) {
            logger.error(`[agent-memories] ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * DELETE /agent-memories/:id
 * Delete a specific agent memory.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const deleted = await MemoryService.remove((req.params.id as any));
      if (!deleted) {
        return res.status(404).json({ error: "Memory not found" });
      }
      res.json({ success: true });
    } catch (error: unknown) {
            logger.error(`[agent-memories] DELETE ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories/discover
 * Aggregate all distinct project/agent combinations with memory counts.
 * Bypasses project scoping — used by the consolidation CLI's --all sweep.
 */
router.get(
  "/discover",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const combos = await MemoryService.discoverCombos();
      res.json({ combos });
    } catch (error: unknown) {
            logger.error(`[agent-memories] DISCOVER ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories/consolidation-history?project=<project>&limit=10
 * Retrieve consolidation run history for a project.
 */
router.get(
  "/consolidation-history",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
            const limit = parseInt((req.query.limit as any)) || 10;

      const history = await MemoryConsolidationService.getHistory(
                (project as any),
        (limit as any),
      );
      res.json({ history });
    } catch (error: unknown) {
            logger.error(`[agent-memories] HISTORY ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * POST /agent-memories/consolidate
 * Trigger on-demand memory consolidation for a project.
 */
router.post(
  "/consolidate",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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
    } catch (error: unknown) {
            logger.error(`[agent-memories] CONSOLIDATE ${(error as Error).message}`);
      next(error);
    }
  }),
);

export default router;

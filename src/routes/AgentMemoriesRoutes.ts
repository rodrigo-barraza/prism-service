import {
  AGENT_IDS,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import MemoryService from "#src/services/MemoryService";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

const router = express.Router();

/**
 * POST /agent-memories
 * Create a new memory via MemoryService.store() (embedding + dedup).
 * Called by tools-api's save_memory route.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        agent,
        project,
        username,
        content,
        type,
        title,
        agentConversationId,
      } = req.body;
      if (!content) {
        return res.status(400).json({ error: "content is required" });
      }

      const result = await MemoryService.store({
        agent: agent || AGENT_IDS.CODING,
        project: project || DEFAULT_PROJECT,
        username: username || null,
        content,
        type: type || "project",
        title: title || null,
        agentConversationId: agentConversationId || null,
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
      logger.error(`[agent-memories] POST ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories?project=<project>&agent=<agent>&limit=100&skip=0
 * List all agent memories for a project (read-only).
 * Optional aboutUserId/sourceUserId narrow to Discord memories about or
 * revealed by a specific user (LUPOS-style memories).
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = req.query.agent || null;
      const limit = parseInt(req.query.limit as string) || 100;
      const skip = parseInt(req.query.skip as string) || 0;
      const type = (req.query.type as string) || null;
      const aboutUserId = (req.query.aboutUserId as string) || undefined;
      const sourceUserId = (req.query.sourceUserId as string) || undefined;
      // History view: include soft-closed (superseded/invalidated) rows
      const includeSuperseded = req.query.includeSuperseded === "true";

      const result = await MemoryService.list({
        agent: agent as string,
        project: project as string,
        limit: Number(limit),
        skip: Number(skip),
        type: type ? String(type) : undefined,
        aboutUserId,
        sourceUserId,
        includeSuperseded,
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories/facets?project=<project>&agent=<agent>
 * Distinct memory types and Discord users (about/source) with counts,
 * for populating the Memories tab filter dropdown.
 */
router.get(
  "/facets",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = (req.query.agent as string) || undefined;

      const result = await MemoryService.facets({
        agent,
        project: project as string,
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] FACETS ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /agent-memories/all?project=<project>&agent=<agent>
 * Delete ALL memories for a specific project (optionally scoped to an agent).
 */
router.delete(
  "/all",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = (req.query.agent as string) || undefined;

      if (!project) {
        return res.status(400).json({ error: "project is required" });
      }

      const result = await MemoryService.removeAllByAgent(
        project as string,
        agent,
      );
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error: unknown) {
      logger.error(`[agent-memories] DELETE ALL ${getErrorMessage(error)}`);
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
      const deleted = await MemoryService.remove(String(req.params.id));
      if (!deleted) {
        return res.status(404).json({ error: "Memory not found" });
      }
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error(`[agent-memories] DELETE ${getErrorMessage(error)}`);
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
      logger.error(`[agent-memories] DISCOVER ${getErrorMessage(error)}`);
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
      const limit = parseInt(req.query.limit as string) || 10;

      const history = await MemoryConsolidationService.getHistory(
        project as string,
        limit,
      );
      res.json({ history });
    } catch (error: unknown) {
      logger.error(`[agent-memories] HISTORY ${getErrorMessage(error)}`);
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
      const agent = req.body.agent || AGENT_IDS.CODING;
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
      logger.error(`[agent-memories] CONSOLIDATE ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /agent-memories/consolidation-rollback
 * Undo a consolidation run by runId (from consolidation-history): reopens
 * the memories it soft-closed and invalidates the merged docs it created.
 */
router.post(
  "/consolidation-rollback",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const runId = req.body.runId as string;
      if (!runId) {
        res.status(400).json({ error: "runId is required" });
        return;
      }
      const result = await MemoryConsolidationService.rollbackRun(runId);
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] ROLLBACK ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

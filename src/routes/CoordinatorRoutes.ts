import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response, NextFunction } from "express";
import CoordinatorService from "../services/CoordinatorService.ts";
import logger from "../utils/logger.ts";

const router = Router();

// ═══════════════════════════════════════════════════════════════
// Coordinator Routes — Multi-Agent Orchestration
// ═══════════════════════════════════════════════════════════════

/**
 * POST /coordinator/plan
 * Decompose a task into parallel sub-tasks for review.
 *
 * Body: { task: string, files: string[], repoPath?: string }
 */
router.post(
  "/plan",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { task, files, repoPath } = req.body;

      if (!task || typeof task !== "string") {
        return res.status(400).json({ error: "'task' (string) is required" });
      }
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res
          .status(400)
          .json({ error: "'files' (non-empty array) is required" });
      }

      const plan = await CoordinatorService.decompose({
        task,
        files,
        repoPath,
        endpoint: "/coordinator/plan",
      });
      res.json(plan);
    } catch (error: unknown) {
            logger.error(`[coordinator] PLAN ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * POST /coordinator/execute
 * Execute an approved plan — spawn workers in git worktrees.
 *
 * Body: { plan: object, provider?: string, model?: string }
 */
router.post(
  "/execute",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { plan, provider, model } = req.body;

      if (!plan || !plan.taskId || !plan.subTasks) {
        return res.status(400).json({
          error: "'plan' object with taskId and subTasks is required",
        });
      }

      // Fire and respond immediately — progress via polling or WebSocket
      const result = await CoordinatorService.execute(plan, {
        provider,
        model,
        project: req.project,
        username: req.username,
      });

      res.json(result);
    } catch (error: unknown) {
            logger.error(`[coordinator] EXECUTE ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /coordinator/status/:taskId
 * Get the current status of a coordinator task.
 */
router.get("/status/:taskId", (req: Request, res: Response) => {
    const status = CoordinatorService.getStatus((req.params.taskId as any));
  if (!status) {
    return res.status(404).json({ error: "Task not found" });
  }
  res.json(status);
});

/**
 * GET /coordinator/tasks
 * List all active coordinator tasks.
 */
router.get("/tasks", (_req: Request, res: Response) => {
  res.json({ tasks: CoordinatorService.listTasks() });
});

/**
 * POST /coordinator/approve-merge/:taskId
 * Approve and merge completed worker branches.
 */
router.post(
  "/approve-merge/:taskId",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const result = await CoordinatorService.approveMerge((req.params.taskId as any));
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error: unknown) {
            logger.error(`[coordinator] APPROVE-MERGE ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * POST /coordinator/abort/:taskId
 * Abort a running task — kill workers and clean up worktrees.
 */
router.post(
  "/abort/:taskId",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const result = await CoordinatorService.abort((req.params.taskId as any));
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error: unknown) {
            logger.error(`[coordinator] ABORT ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ═══════════════════════════════════════════════════════════════
// Chat-Spawned Worker Endpoints
// ═══════════════════════════════════════════════════════════════

/**
 * GET /coordinator/workers
 * List all active workers spawned via chat tools.
 * Optional query: ?agentSessionId=xxx to filter by parent coordinator session.
 */
router.get(
  "/workers",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentSessionId } = req.query;
    let workers = CoordinatorService.listWorkers({
      parentAgentSessionId: agentSessionId,
    });

    // Fall back to persisted workers from the agent_session document
    // when in-memory is empty (page refresh, server restart)
    if (workers.length === 0 && agentSessionId) {
      try {
        const { default: MongoWrapper } =
          await import("../wrappers/MongoWrapper.js");
                const { MONGO_DB_NAME } = await import("../../config.js");
        const { COLLECTIONS } = await import("../constants.js");
        const col = MongoWrapper.getCollection(
          MONGO_DB_NAME,
          COLLECTIONS.AGENT_SESSIONS,
        );
        const session = await col.findOne(
          { id: agentSessionId },
          { projection: { workers: 1 } },
        );
        if (session && session.workers && session.workers.length > 0) {
          workers = session.workers;
        }
      } catch (error: unknown) {
        logger.warn(
                    `[coordinator] Failed to load persisted workers: ${(error as Error).message}`,
        );
      }
    }

    res.json({ workers });
  }),
);

/**
 * POST /coordinator/workers/stop
 * Abort all running workers for a given parent agent session.
 * Called by the frontend when the user presses stop.
 *
 * Body: { agentSessionId: string }
 */
router.post(
  "/workers/stop",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentSessionId } = req.body;
    if (!agentSessionId) {
      return res.status(400).json({ error: "'agentSessionId' is required" });
    }

    const result =
      await CoordinatorService.abortWorkersBySession(agentSessionId);
    res.json(result);
  }),
);

/**
 * GET /coordinator/workers/:agentId
 * Get the status of a specific chat-spawned worker.
 */
router.get("/workers/:agentId", (req: Request, res: Response) => {
    const status = CoordinatorService.getWorkerStatus((req.params.agentId as any));
  if (!status) {
    return res.status(404).json({ error: "Worker not found" });
  }
  res.json(status);
});

export default router;

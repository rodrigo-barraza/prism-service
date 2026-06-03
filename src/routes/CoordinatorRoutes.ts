import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response } from "express";
import CoordinatorService from "../services/CoordinatorService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = Router();




// ═══════════════════════════════════════════════════════════════
// Chat-Spawned Worker Endpoints
// ═══════════════════════════════════════════════════════════════

/**
 * GET /coordinator/workers
 * List all active workers spawned via chat tools.
 * Optional query: ?conversationId=xxx to filter by parent conversation.
 */
router.get(
  "/workers",
  asyncHandler(async (req: Request, res: Response) => {
    const conversationIdentifier = req.query.conversationId as string | undefined;
    const activeWorkersList = CoordinatorService.listWorkers({
      parentConversationId: conversationIdentifier,
    });

    let persistedWorkersList: any[] = [];
    if (conversationIdentifier) {
      try {
        const { default: MongoWrapper } =
          await import("../wrappers/MongoWrapper.js");
        const { MONGO_DB_NAME } = await import("../../config.js");
        const { COLLECTIONS } = await import("../constants.js");
        const collection = MongoWrapper.getCollection(
          MONGO_DB_NAME,
          COLLECTIONS.AGENT_CONVERSATIONS,
        );
        const agentSessionDocument = await collection.findOne(
          { id: conversationIdentifier },
          { projection: { workers: 1 } },
        );
        if (
          agentSessionDocument &&
          agentSessionDocument.workers &&
          agentSessionDocument.workers.length > 0
        ) {
          persistedWorkersList = agentSessionDocument.workers;
        }
      } catch (error: unknown) {
        logger.warn(
          `[coordinator] Failed to load persisted workers: ${getErrorMessage(error)}`,
        );
      }
    }

    const mergedWorkersMap = new Map<string, any>();
    for (const worker of persistedWorkersList) {
      mergedWorkersMap.set(worker.agentId, worker);
    }
    for (const worker of activeWorkersList) {
      mergedWorkersMap.set(worker.agentId, worker);
    }
    const finalWorkersList = Array.from(mergedWorkersMap.values());

    res.json({ workers: finalWorkersList });
  }),
);

/**
 * POST /coordinator/workers/stop
 * Abort all running workers for a given parent conversation.
 * Called by the frontend when the user presses stop.
 *
 * Body: { conversationId: string }
 */
router.post(
  "/workers/stop",
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "'conversationId' is required" });
    }

    const result =
      await CoordinatorService.abortWorkersByConversation(conversationId);
    res.json(result);
  }),
);

/**
 * GET /coordinator/workers/:agentId
 * Get the status of a specific chat-spawned worker.
 */
router.get("/workers/:agentId", (req: Request, res: Response) => {
  const status = CoordinatorService.getWorkerStatus(req.params.agentId as string);
  if (!status) {
    return res.status(404).json({ error: "Worker not found" });
  }
  res.json(status);
});

export default router;

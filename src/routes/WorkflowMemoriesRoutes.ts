import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import { ObjectId } from "mongodb";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { DEFAULT_PROFILE_ID, profileFilter } from "#src/utils/ProfileScope";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

const router = express.Router();

/**
 * GET /workflow-memories?project=<project>&agent=<agent>&limit=20&skip=0
 * Paginated list of workflow memories for the UI panel.
 * Projection excludes the embedding vector (large, not needed for display).
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = (req.query.agent as string) || null;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const skip = parseInt(req.query.skip as string) || 0;

      const database = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!database) {
        return res.status(503).json({ error: "Database not available" });
      }

      const collection = database.collection(COLLECTIONS.WORKFLOW_MEMORIES);

      const filter: Record<string, unknown> = {
        profileId: profileFilter(req.profileId || DEFAULT_PROFILE_ID),
      };
      if (project) filter.project = project;
      if (agent) filter.agent = agent;

      const [workflows, total] = await Promise.all([
        collection
          .find(filter, {
            projection: { embedding: 0 },
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        collection.countDocuments(filter),
      ]);

      res.json({ workflows, total });
    } catch (error: unknown) {
      logger.error(`[workflow-memories] GET ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /workflow-memories/all?project=<project>&agent=<agent>
 * Bulk delete all workflow memories for a project/agent scope.
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

      const database = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!database) {
        return res.status(503).json({ error: "Database not available" });
      }

      const collection = database.collection(COLLECTIONS.WORKFLOW_MEMORIES);

      const filter: Record<string, unknown> = {
        project,
        profileId: profileFilter(req.profileId || DEFAULT_PROFILE_ID),
      };
      if (agent) filter.agent = agent;

      const result = await collection.deleteMany(filter);
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error: unknown) {
      logger.error(`[workflow-memories] DELETE ALL ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /workflow-memories/:id
 * Delete a single workflow memory by ObjectId.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workflowId = String(req.params.id);

      const database = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!database) {
        return res.status(503).json({ error: "Database not available" });
      }

      const collection = database.collection(COLLECTIONS.WORKFLOW_MEMORIES);

      let filter: Record<string, unknown>;
      try {
        filter = { _id: new ObjectId(workflowId) };
      } catch {
        return res.status(400).json({ error: "Invalid workflow ID" });
      }

      const result = await collection.deleteOne(filter);
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Workflow memory not found" });
      }
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error(`[workflow-memories] DELETE ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.FAVORITES;

/**
 * GET /favorites?type=model
 * List favorites, optionally filtered by type.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { project, username, db } = req;
      const filter = { project, username };
      // @ts-ignore
      if (req.query.type) filter.type = req.query.type;

      const favorites = await db
        .collection(COLLECTION)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(favorites);
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`Error fetching favorites: ${error.message}`);
      next(error);
    }
  }),
);

/**
 * POST /favorites
 * Add a favorite. Body: { type, key, meta? }
 * - type: "model", "workflow", "conversation", etc.
 * - key: unique identifier within the type (e.g. "openai:gpt-4o")
 * - meta: optional metadata object (e.g. { provider, name })
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { project, username, db } = req;
      const { type, key, meta } = req.body;

      if (!type || !key) {
        return res.status(400).json({ error: "type and key are required" });
      }

      const document = {
        project,
        username,
        type,
        key,
        meta: meta || {},
        createdAt: new Date().toISOString(),
      };

      // Upsert to prevent duplicates
      await db
        .collection(COLLECTION)
        .updateOne(
          { project, username, type, key },
          { $set: document },
          { upsert: true },
        );

      res.json({ success: true, favorite: document });
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`Error adding favorite: ${error.message}`);
      next(error);
    }
  }),
);

/**
 * DELETE /favorites?type=model&key=openai:gpt-4o
 * Remove a specific favorite by type + key.
 */
router.delete(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { project, username, db } = req;
      const { type, key } = req.query;

      if (!type || !key) {
        return res
          .status(400)
          .json({ error: "type and key query params are required" });
      }

      const result = await db
        .collection(COLLECTION)
        .deleteOne({ project, username, type, key });

      res.json({ success: true, deleted: result.deletedCount });
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`Error removing favorite: ${error.message}`);
      next(error);
    }
  }),
);

export default router;

import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { COLLECTIONS } from "#src/constants";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  GetFavoritesQuerySchema,
  PostFavoritesBodySchema,
  DeleteFavoritesQuerySchema,
} from "#src/types/index";
import {
  profileFilter,
  resolveScope,
  scopeFilter,
} from "#src/utils/ProfileScope";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.FAVORITES;

interface FavoriteDocument {
  project: string;
  username: string;
  /** Legacy docs lack it (default profile). Writes always stamp a string. */
  profileId?: string | null;
  type: string;
  key: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

/**
 * GET /favorites?type=model
 * List favorites, optionally filtered by type.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = req.db;

      const parseResult = GetFavoritesQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const filter: Record<string, unknown> = { ...scopeFilter(req) };
      if (parseResult.data.type) {
        filter.type = parseResult.data.type;
      }

      const favorites = await db
        .collection<FavoriteDocument>(COLLECTION)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(favorites);
    } catch (error: unknown) {
      logger.error(`Error fetching favorites: ${getErrorMessage(error)}`);
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
      const db = req.db;
      const { project, username, profileId } = resolveScope(req);

      const parseResult = PostFavoritesBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const { type, key, meta } = parseResult.data;

      const document: FavoriteDocument = {
        project,
        username,
        profileId,
        type,
        key,
        meta: meta || {},
        createdAt: new Date().toISOString(),
      };

      // Upsert to prevent duplicates. The filter uses profileFilter so a
      // legacy (pre-profile) favorite in the default profile is updated in
      // place — and stamped — rather than duplicated.
      await db
        .collection<FavoriteDocument>(COLLECTION)
        .updateOne(
          { project, username, profileId: profileFilter(profileId), type, key },
          { $set: document },
          { upsert: true },
        );

      res.json({ success: true, favorite: document });
    } catch (error: unknown) {
      logger.error(`Error adding favorite: ${getErrorMessage(error)}`);
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
      const db = req.db;

      const parseResult = DeleteFavoritesQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const { type, key } = parseResult.data;

      const result = await db
        .collection<FavoriteDocument>(COLLECTION)
        .deleteOne({ ...scopeFilter(req), type, key });

      res.json({ success: true, deleted: result.deletedCount });
    } catch (error: unknown) {
      logger.error(`Error removing favorite: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

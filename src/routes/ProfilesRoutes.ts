import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { COLLECTIONS } from "#src/constants";
import { DEFAULT_PROFILE_ID } from "#src/utils/ProfileScope";
import { z } from "zod";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.PROFILES;

/**
 * Profiles registry — the roster of switchable identities for a
 * {project, username} pair. A profile's `profileId` is the value clients send
 * in the x-profile-id header; all profile-partitioned collections key on it.
 *
 * The default profile is implicit: it always exists, owns all pre-profile
 * data, and is never stored as a document here.
 */
interface ProfileDocument {
  project: string;
  username: string;
  profileId: string;
  name: string;
  emoji?: string;
  color?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PostProfileSchema = z.object({
  name: z.string().trim().min(1).max(64),
  profileId: z.string().regex(PROFILE_ID_PATTERN).optional(),
  emoji: z.string().max(8).optional(),
  color: z.string().max(32).optional(),
});

const PatchProfileSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  emoji: z.string().max(8).optional(),
  color: z.string().max(32).optional(),
});

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return PROFILE_ID_PATTERN.test(slug) ? slug : "";
}

function rosterScope(req: Request) {
  // The roster itself is keyed by {project, username} only — profiles are
  // what partition everything else, so they cannot be profile-scoped.
  return { project: req.project || "any", username: req.username || "any" };
}

/**
 * GET /profiles
 * List profiles for this {project, username}, with the implicit default first.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const profiles = await db
        .collection<ProfileDocument>(COLLECTION)
        .find(rosterScope(req))
        .sort({ createdAt: 1 })
        .toArray();

      res.json([
        { profileId: DEFAULT_PROFILE_ID, name: "Default", builtIn: true },
        ...profiles.map(({ _id, ...profile }) => profile),
      ]);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /profiles
 * Create a profile. profileId defaults to a slug of the name.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const validated = PostProfileSchema.parse(req.body);
      const profileId = validated.profileId || slugify(validated.name);

      if (!profileId) {
        return res
          .status(400)
          .json({ error: "Profile name yields no valid id; pass profileId" });
      }
      if (profileId === DEFAULT_PROFILE_ID) {
        return res
          .status(409)
          .json({ error: `"${DEFAULT_PROFILE_ID}" is the built-in profile` });
      }

      const document: ProfileDocument = {
        ...rosterScope(req),
        profileId,
        name: validated.name,
        ...(validated.emoji && { emoji: validated.emoji }),
        ...(validated.color && { color: validated.color }),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const existing = await db
        .collection<ProfileDocument>(COLLECTION)
        .findOne({ ...rosterScope(req), profileId });
      if (existing) {
        return res
          .status(409)
          .json({ error: `Profile "${profileId}" already exists` });
      }

      await db.collection<ProfileDocument>(COLLECTION).insertOne(document);
      logger.info(`Profile created: ${profileId} (${document.name})`);
      res.status(201).json(document);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PATCH /profiles/:profileId
 * Rename / restyle a profile. The id itself is immutable (it keys data).
 */
router.patch(
  "/:profileId",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const profileId = req.params.profileId as string;
      if (profileId === DEFAULT_PROFILE_ID) {
        return res
          .status(400)
          .json({ error: "The built-in default profile cannot be edited" });
      }
      const validated = PatchProfileSchema.parse(req.body);

      const result = await db
        .collection<ProfileDocument>(COLLECTION)
        .findOneAndUpdate(
          { ...rosterScope(req), profileId },
          { $set: { ...validated, updatedAt: new Date() } },
          { returnDocument: "after" },
        );
      if (!result) {
        return res.status(404).json({ error: "Profile not found" });
      }
      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /profiles/:profileId
 * Remove a profile from the roster. Its data is NOT deleted — recreating a
 * profile with the same id regains access to it.
 */
router.delete(
  "/:profileId",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const profileId = req.params.profileId as string;
      if (profileId === DEFAULT_PROFILE_ID) {
        return res
          .status(400)
          .json({ error: "The built-in default profile cannot be deleted" });
      }
      const result = await db
        .collection<ProfileDocument>(COLLECTION)
        .findOneAndDelete({ ...rosterScope(req), profileId });
      if (!result) {
        return res.status(404).json({ error: "Profile not found" });
      }
      logger.info(`Profile deleted from roster: ${profileId} (data retained)`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;

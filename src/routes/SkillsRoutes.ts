// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import EmbeddingService from "../services/EmbeddingService.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.AGENT_SKILLS;

/**
 * Generate an embedding vector for skill content.
 * Combines name + description + content for richer semantic representation.
 */
async function generateSkillEmbedding(skill: Record<string, unknown>) {
  const text = [skill.name, skill.description, skill.content]
    .filter(Boolean)
    .join("\n");
  // @ts-ignore - TODO: strict typing
  return EmbeddingService.embed(text, {
    source: "skill-creation",
    endpoint: "/skills",
  });
}

/**
 * GET /skills
 * List all skills for the given project + username.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { project, username, db } = req;

      const skills = await db
        .collection(COLLECTION)
        .find({ project, username })
        .sort({ createdAt: -1 })
        // Don't return embedding vectors to the client — they're large
        .project({ embedding: 0 })
        .toArray();

      // @ts-ignore - TODO: strict typing
      res.json(skills.map((s: Record<string, unknown>) => ({ ...s, id: s._id.toString() })));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /skills
 * Create a new skill. Generates an embedding vector at creation time.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { project, username, db } = req;

      const document = {
        project,
        username,
        name: req.body.name,
        description: req.body.description || "",
        content: req.body.content || "",
        enabled: req.body.enabled !== false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Generate embedding for semantic similarity search
      try {
        // @ts-ignore
        document.embedding = await generateSkillEmbedding(document);
      } catch (error: unknown) {
        // @ts-ignore - TODO: strict typing
        logger.warn(`[Skills] Embedding generation failed: ${error.message}`);
        // @ts-ignore
        document.embedding = null;
      }

      const result = await db.collection(COLLECTION).insertOne(document);

      logger.info(`Skill created: ${document.name} (${result.insertedId})`);
      // @ts-ignore
      const { embedding: _, ...response } = document;
      res.status(201).json({ ...response, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /skills/:id
 * Update an existing skill. Re-generates embedding if content changes.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { db } = req;

      const updates = {
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.description !== undefined && {
          description: req.body.description,
        }),
        ...(req.body.content !== undefined && { content: req.body.content }),
        ...(req.body.enabled !== undefined && { enabled: req.body.enabled }),
        updatedAt: new Date(),
      };

      // Re-generate embedding if any semantic content changed
      const contentChanged =
        req.body.name !== undefined ||
        req.body.description !== undefined ||
        req.body.content !== undefined;

      if (contentChanged) {
        try {
          // Need current doc to merge fields for embedding
          const current = await db
            .collection(COLLECTION)
            // @ts-ignore - TODO: strict typing
            .findOne({ _id: new ObjectId(req.params.id) });

          if (current) {
            const merged = {
              name: updates.name ?? current.name,
              description: updates.description ?? current.description,
              content: updates.content ?? current.content,
            };
            // @ts-ignore
            updates.embedding = await generateSkillEmbedding(merged);
          }
        } catch (error: unknown) {
          logger.warn(
            // @ts-ignore - TODO: strict typing
            `[Skills] Embedding re-generation failed: ${error.message}`,
          );
        }
      }

      const result = await db
        .collection(COLLECTION)
        .findOneAndUpdate(
          // @ts-ignore - TODO: strict typing
          { _id: new ObjectId(req.params.id) },
          { $set: updates },
          { returnDocument: "after", projection: { embedding: 0 } },
        );

      if (!result) {
        return res.status(404).json({ error: "Skill not found" });
      }

      logger.info(`Skill updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /skills/:id
 * Delete a skill.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { db } = req;

      const result = await db
        .collection(COLLECTION)
        // @ts-ignore - TODO: strict typing
        .findOneAndDelete({ _id: new ObjectId(req.params.id) });

      if (!result) {
        return res.status(404).json({ error: "Skill not found" });
      }

      logger.info(`Skill deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;

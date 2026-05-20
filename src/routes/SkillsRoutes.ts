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
async function generateSkillEmbedding(skill: any) {
  const text = [skill.name, skill.description, skill.content]
    .filter(Boolean)
    .join("\n");
    return EmbeddingService.embed((text as any), {
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
            const { project, username, db } = req;

      const skills = await db
        .collection(COLLECTION)
        .find({ project, username })
        .sort({ createdAt: -1 })
        // Don't return embedding vectors to the client — they're large
        .project({ embedding: 0 })
        .toArray();

            res.json(skills.map((s: any) => ({ ...s, id: (s as any)._id.toString() })));
    } catch (error: any) {
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
                (document as any).embedding = await generateSkillEmbedding(document);
      } catch (error: any) {
                logger.warn(`[Skills] Embedding generation failed: ${(error as Error).message}`);
                (document as any).embedding = null;
      }

      const result = await db.collection(COLLECTION).insertOne(document);

      logger.info(`Skill created: ${document.name} (${result.insertedId})`);
            const { embedding: _, ...response } = document;
      res.status(201).json({ ...response, id: result.insertedId.toString() });
    } catch (error: any) {
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
                        .findOne({ _id: new ObjectId(req.params.id) });

          if (current) {
            const merged = {
              name: updates.name ?? current.name,
              description: updates.description ?? current.description,
              content: updates.content ?? current.content,
            };
                        (updates as any).embedding = await generateSkillEmbedding(merged);
          }
        } catch (error: any) {
          logger.warn(
                        `[Skills] Embedding re-generation failed: ${(error as Error).message}`,
          );
        }
      }

      const result = await db
        .collection(COLLECTION)
        .findOneAndUpdate(
                    { _id: new ObjectId(req.params.id) },
          { $set: updates },
          { returnDocument: "after", projection: { embedding: 0 } },
        );

      if (!result) {
        return res.status(404).json({ error: "Skill not found" });
      }

      logger.info(`Skill updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id.toString() });
    } catch (error: any) {
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
            const { db } = req;

      const result = await db
        .collection(COLLECTION)
                .findOneAndDelete({ _id: new ObjectId(req.params.id) });

      if (!result) {
        return res.status(404).json({ error: "Skill not found" });
      }

      logger.info(`Skill deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: any) {
      next(error);
    }
  }),
);

export default router;

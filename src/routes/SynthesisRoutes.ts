import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS } from "../constants.ts";
import {
  PostSynthesisBodySchema,
  PatchSynthesisBodySchema,
} from "../types/index.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.SYNTHESIS;

interface SynthesisDocument {
  id: string;
  project: string;
  username: string;
  title: string;
  systemPrompt: string;
  assistantPersona?: string;
  userPersona: string;
  category: string;
  targetTurns: number;
  seedMessages: Record<string, unknown>[];
  settings: Record<string, unknown>;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /synthesis
 * List all synthesis runs for the current project/user.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const runs = await db
        .collection<SynthesisDocument>(COLLECTION)
        .find({ project, username })
        .sort({ updatedAt: -1 })
        .toArray();

      res.json(runs);
    } catch (error: unknown) {
      logger.error(`Error fetching synthesis runs: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /synthesis/:id
 * Get a specific synthesis run.
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const runId = req.params.id as string;

      const run = await db
        .collection<SynthesisDocument>(COLLECTION)
        .findOne({ id: runId, project, username });

      if (!run) {
        return res.status(404).json({ error: "Synthesis run not found" });
      }

      res.json(run);
    } catch (error: unknown) {
      logger.error(`Error fetching synthesis run: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /synthesis
 * Create a new synthesis run.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const parsed = PostSynthesisBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const {
        id,
        title,
        systemPrompt,
        userPersona,
        category,
        targetTurns,
        seedMessages,
        settings,
        conversationId,
      } = parsed.data;

      const now = new Date().toISOString();
      const document: SynthesisDocument = {
        id,
        project,
        username,
        title,
        systemPrompt,
        userPersona,
        category,
        targetTurns,
        seedMessages,
        settings,
        conversationId,
        createdAt: now,
        updatedAt: now,
      };

      await db.collection<SynthesisDocument>(COLLECTION).insertOne(document);

      res.json(document);
    } catch (error: unknown) {
      logger.error(`Error creating synthesis run: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * PATCH /synthesis/:id
 * Update specific fields of a synthesis run.
 */
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const runId = req.params.id as string;

      const parsed = PatchSynthesisBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const setFields: Record<string, unknown> = {
        ...parsed.data,
        updatedAt: new Date().toISOString(),
      };

      // Filter out undefined values from updates to only update provided fields
      Object.keys(setFields).forEach((key) => {
        if (setFields[key] === undefined) {
          delete setFields[key];
        }
      });

      const result = await db
        .collection<SynthesisDocument>(COLLECTION)
        .updateOne({ id: runId, project, username }, { $set: setFields });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Synthesis run not found" });
      }

      const updated = await db
        .collection<SynthesisDocument>(COLLECTION)
        .findOne({ id: runId, project, username });

      res.json(updated);
    } catch (error: unknown) {
      logger.error(`Error patching synthesis run: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /synthesis/:id
 * Delete a specific synthesis run.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const runId = req.params.id as string;

      const result = await db
        .collection<SynthesisDocument>(COLLECTION)
        .deleteOne({ id: runId, project, username });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Synthesis run not found" });
      }

      res.json({ success: true, id: runId });
    } catch (error: unknown) {
      logger.error(`Error deleting synthesis run: ${errorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

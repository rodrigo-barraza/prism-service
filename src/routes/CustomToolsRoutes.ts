import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { PostCustomToolSchema, PutCustomToolSchema } from "../types/index.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.CUSTOM_TOOLS;

interface CustomToolDocument {
  _id: ObjectId;
  project: string;
  username: string;
  name: string;
  description: string;
  code: string;
  endpoint: string;
  method: string;
  parameters: unknown[];
  execution: "privileged" | "sandboxed";
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * GET /custom-tools
 * List all custom tools for the given project + username.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = req.db!;
      const project = req.project || "any";
      const username = req.username || "any";

      const tools = await db
        .collection<CustomToolDocument>(COLLECTION)
        .find({ project, username })
        .sort({ createdAt: -1 })
        .toArray();

      res.json(tools.map((t) => ({ ...t, id: t._id.toString() })));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /custom-tools
 * Create a new custom tool.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = req.db!;
      const project = req.project || "any";
      const username = req.username || "any";

      const parseResult = PostCustomToolSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const validated = parseResult.data;
      const document: Omit<CustomToolDocument, "_id"> = {
        project,
        username,
        name: validated.name,
        description: validated.description,
        code: validated.code,
        endpoint: validated.endpoint,
        method: validated.method,
        parameters: validated.parameters,
        execution: validated.execution as "sandboxed" | "privileged",
        enabled: validated.enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db.collection(COLLECTION).insertOne(document);

      logger.info(`Custom tool created: ${document.name} (${result.insertedId})`);
      res.status(201).json({ ...document, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /custom-tools/:id
 * Update an existing custom tool.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = req.db!;

      const parseResult = PutCustomToolSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const updates = {
        ...parseResult.data,
        updatedAt: new Date(),
      };

      const result = await db
        .collection<CustomToolDocument>(COLLECTION)
        .findOneAndUpdate(
          { _id: new ObjectId(req.params.id as string) },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json({ error: "Tool not found" });
      }

      logger.info(`Custom tool updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /custom-tools/:id
 * Delete a custom tool.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = req.db!;

      const result = await db
        .collection<CustomToolDocument>(COLLECTION)
        .findOneAndDelete({ _id: new ObjectId(req.params.id as string) });

      if (!result) {
        return res.status(404).json({ error: "Tool not found" });
      }

      logger.info(`Custom tool deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;

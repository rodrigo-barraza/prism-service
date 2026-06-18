import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";
import { GetTextQuerySchema } from "../types/index.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = express.Router();
router.use(requireDb);

interface AggregateTextItem {
  convId: string;
  convTitle?: string;
  project: string;
  username: string;
  role: string;
  content: string;
  timestamp: string | Date;
  model?: string;
  estimatedCost?: number;
  images: number;
}

// ─── GET /text — extract text content from the caller's project conversations ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = req.db;

      const parseResult = GetTextQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
      }

      const { page, limit, origin, search, provider, model, from, to } =
        parseResult.data;

      const skip = (page - 1) * limit;

      // Always scope to the caller's project
      const preMatch: Record<string, unknown> = { project: req.project };
      if (from || to) {
        const updatedAtFilter: Record<string, unknown> = {};
        if (from) updatedAtFilter.$gte = from;
        if (to) updatedAtFilter.$lte = to;
        preMatch.updatedAt = updatedAtFilter;
      }

      const pipeline: Record<string, unknown>[] = [
        { $match: preMatch },
        { $unwind: "$messages" },
        {
          $match: {
            "messages.content": { $exists: true, $nin: [null, ""] },
          },
        },
        {
          $project: {
            convId: "$id",
            convTitle: "$title",
            project: 1,
            username: 1,
            role: "$messages.role",
            content: "$messages.content",
            timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
            model: "$messages.model",
            estimatedCost: "$messages.estimatedCost",
            images: { $size: { $ifNull: ["$messages.images", []] } },
          },
        },
        { $sort: { timestamp: -1 } },
      ];

      if (origin === "user") {
        pipeline.push({ $match: { role: "user" } });
      } else if (origin === "ai") {
        pipeline.push({ $match: { role: "assistant" } });
      }

      if (search) {
        pipeline.push({
          $match: { content: { $regex: search, $options: "i" } },
        });
      }

      if (provider) {
        pipeline.push({
          $match: { model: { $regex: `^${provider}/`, $options: "i" } },
        });
      }

      if (model) {
        pipeline.push({ $match: { model } });
      }

      const countPipeline = [...pipeline, { $count: "total" }];
      const [countResult] = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .aggregate<{ total: number }>(countPipeline)
        .toArray();
      const total = countResult?.total || 0;

      pipeline.push({ $skip: skip }, { $limit: limit });

      const items = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .aggregate<AggregateTextItem>(pipeline)
        .toArray();

      const data = items.map((item) => ({
        content: item.content,
        origin: item.role === "assistant" ? "ai" : "user",
        role: item.role,
        convId: item.convId,
        convTitle: item.convTitle || "Untitled",
        project: item.project,
        username: item.username,
        model: item.model,
        estimatedCost: item.estimatedCost,
        hasImages: item.images > 0,
        timestamp: item.timestamp,
      }));

      res.json({
        data,
        total,
        page,
        limit,
        providers: [
          ...new Set(
            data.map((item) => item.model?.split("/")[0]).filter(Boolean),
          ),
        ].sort(),
        models: [
          ...new Set(data.map((item) => item.model).filter(Boolean)),
        ].sort(),
      });
    } catch (error: unknown) {
      logger.error(`GET /text error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

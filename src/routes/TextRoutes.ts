// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";

const router = express.Router();
router.use(requireDb);

// ─── GET /text — extract text content from the caller's project conversations ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // @ts-ignore - TODO: strict typing
      const { db } = req;

      const {
        page = 1,
        limit = 50,
        origin,
        search,
        provider,
        model,
        from,
        to,
      } = req.query;
      // @ts-ignore - TODO: strict typing
      const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
      // @ts-ignore - TODO: strict typing
      const lim = parseInt(limit, 10);

      // Always scope to the caller's project
      const preMatch = { project: req.project };
      if (from || to) {
        // @ts-ignore
        preMatch.updatedAt = {};
        // @ts-ignore
        if (from) preMatch.updatedAt.$gte = from;
        // @ts-ignore
        if (to) preMatch.updatedAt.$lte = to;
      }

      const pipeline = [
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
        // @ts-ignore
        pipeline.push({ $match: { role: "user" } });
      } else if (origin === "ai") {
        // @ts-ignore
        pipeline.push({ $match: { role: "assistant" } });
      }
      if (search) {
        pipeline.push({
          // @ts-ignore
          $match: { content: { $regex: search, $options: "i" } },
        });
      }
      if (provider) {
        pipeline.push({
          // @ts-ignore
          $match: { model: { $regex: `^${provider}/`, $options: "i" } },
        });
      }
      if (model) {
        // @ts-ignore
        pipeline.push({ $match: { model } });
      }

      const countPipeline = [...pipeline, { $count: "total" }];
      const [countResult] = await db
        .collection(COLLECTIONS.CONVERSATIONS)
        .aggregate(countPipeline)
        .toArray();
      const total = countResult?.total || 0;

      // @ts-ignore
      pipeline.push({ $skip: skip }, { $limit: lim });

      const items = await db
        .collection(COLLECTIONS.CONVERSATIONS)
        .aggregate(pipeline)
        .toArray();

      const data = items.map((item: Record<string, unknown>) => ({
        content: item.content,
        origin: item.role === "assistant" ? "ai" : "user",
        role: item.role,
        convId: item.convId,
        convTitle: item.convTitle || "Untitled",
        project: item.project,
        username: item.username,
        model: item.model,
        estimatedCost: item.estimatedCost,
        // @ts-ignore - TODO: strict typing
        hasImages: item.images > 0,
        timestamp: item.timestamp,
      }));

      res.json({
        data,
        total,
        // @ts-ignore - TODO: strict typing
        page: parseInt(page, 10),
        limit: lim,
        providers: [
          ...new Set(
            // @ts-ignore - TODO: strict typing
            data.map((d: Record<string, unknown>) => d.model?.split("/")[0]).filter(Boolean),
          ),
        ].sort(),
        models: [
          ...new Set(data.map((d: Record<string, unknown>) => d.model).filter(Boolean)),
        ].sort(),
      });
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.error(`GET /text error: ${error.message}`);
      next(error);
    }
  }),
);

export default router;

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
            const skip = (parseInt((page as any), 10) - 1) * parseInt((limit as any), 10);
            const lim = parseInt((limit as any), 10);

      // Always scope to the caller's project
      const preMatch: any = { project: req.project };
      if (from || to) {
                preMatch.updatedAt = {};
                if (from) preMatch.updatedAt.$gte = from;
                if (to) preMatch.updatedAt.$lte = to;
      }

      const pipeline: any[] = [
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

      const countPipeline: any[] = [...pipeline, { $count: "total" }];
      const [countResult] = await db
        .collection(COLLECTIONS.CONVERSATIONS)
        .aggregate(countPipeline)
        .toArray();
      const total = countResult?.total || 0;

            pipeline.push({ $skip: skip }, { $limit: lim });

      const items = await db
        .collection(COLLECTIONS.CONVERSATIONS)
        .aggregate(pipeline)
        .toArray();

      const data = items.map((item: any) => ({
        content: item.content,
        origin: item.role === "assistant" ? "ai" : "user",
        role: item.role,
        convId: item.convId,
        convTitle: item.convTitle || "Untitled",
        project: item.project,
        username: item.username,
        model: item.model,
        estimatedCost: item.estimatedCost,
                hasImages: (item as any).images > 0,
        timestamp: item.timestamp,
      }));

      res.json({
        data,
        total,
                page: parseInt((page as any), 10),
        limit: lim,
        providers: [
          ...new Set(
                        data.map((d: any) => (d.model as any)?.split("/")[0]).filter(Boolean),
          ),
        ].sort(),
        models: [
          ...new Set(data.map((d: any) => d.model).filter(Boolean)),
        ].sort(),
      });
    } catch (error: any) {
            logger.error(`GET /text error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

export default router;

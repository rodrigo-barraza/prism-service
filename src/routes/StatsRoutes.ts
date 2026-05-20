import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response, NextFunction } from "express";
import logger from "../utils/logger.ts";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import {
  COLLECTIONS,
  COST_SUM_EXPR,
  AVG_TOKENS_PER_SEC_EXPR,
} from "../constants.ts";

const router = Router();
router.use(requireDb);

/**
 * GET /stats/models
 * Per-model lifetime usage stats scoped to the current user (req.username).
 * Returns comprehensive aggregated stats for every model the user has used.
 */
router.get(
  "/models",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            // @ts-ignore - TODO: strict typing
            const { db, username } = req;
      if (!username) return res.json([]);

      const pipeline: any[] = [
        { $match: { username } },
        {
          $group: {
            _id: { model: "$model", provider: "$provider" },
            totalRequests: { $sum: 1 },
            totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
            totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
            totalTokens: {
              $sum: {
                $add: [
                  { $ifNull: ["$inputTokens", 0] },
                  { $ifNull: ["$outputTokens", 0] },
                ],
              },
            },
            totalCost: COST_SUM_EXPR,
            avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
            avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
            firstUsed: { $min: "$timestamp" },
            lastUsed: { $max: "$timestamp" },
            successCount: {
              $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
            },
            errorCount: {
              $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
            },
          },
        },
        { $sort: { totalRequests: -1 } },
      ];

      const results = await db
        .collection(COLLECTIONS.REQUESTS)
        .aggregate(pipeline)
        .toArray();

      res.json(
        results.map((r: any) => ({
                    model: (r as any)._id.model,
                    provider: (r as any)._id.provider,
          totalRequests: r.totalRequests,
          totalInputTokens: r.totalInputTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          avgLatency: r.avgLatency,
          avgTokensPerSec: r.avgTokensPerSec,
          firstUsed: r.firstUsed,
          lastUsed: r.lastUsed,
          successCount: r.successCount,
          errorCount: r.errorCount,
        })),
      );
    } catch (error: any) {
            logger.error(`GET /stats/models error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

export default router;

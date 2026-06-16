import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response, NextFunction } from "express";
import logger from "../utils/logger.ts";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
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
      const db = req.db;
      const username = req.username;
      if (!username) return res.json([]);

      interface ModelStatAggregateResult {
        _id: { model: string; provider: string };
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalTokens: number;
        totalCost: number;
        avgLatency: number;
        avgTokensPerSec: number;
        firstUsed: Date | string;
        lastUsed: Date | string;
        successCount: number;
        errorCount: number;
      }

      const pipeline: Record<string, unknown>[] = [
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
        .aggregate<ModelStatAggregateResult>(pipeline)
        .toArray();

      res.json(
        results.map((resultEntry) => ({
          model: resultEntry._id.model,
          provider: resultEntry._id.provider,
          totalRequests: resultEntry.totalRequests,
          totalInputTokens: resultEntry.totalInputTokens,
          totalOutputTokens: resultEntry.totalOutputTokens,
          totalTokens: resultEntry.totalTokens,
          totalCost: resultEntry.totalCost,
          avgLatency: resultEntry.avgLatency,
          avgTokensPerSec: resultEntry.avgTokensPerSec,
          firstUsed: resultEntry.firstUsed,
          lastUsed: resultEntry.lastUsed,
          successCount: resultEntry.successCount,
          errorCount: resultEntry.errorCount,
        })),
      );
    } catch (error: unknown) {
      logger.error(`GET /stats/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

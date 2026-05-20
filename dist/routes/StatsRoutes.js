// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router } from "express";
import logger from "../utils/logger.js";
import requireDb from "../middleware/RequireDbMiddleware.js";
import { COLLECTIONS, COST_SUM_EXPR, AVG_TOKENS_PER_SEC_EXPR, } from "../constants.js";
const router = Router();
router.use(requireDb);
/**
 * GET /stats/models
 * Per-model lifetime usage stats scoped to the current user (req.username).
 * Returns comprehensive aggregated stats for every model the user has used.
 */
router.get("/models", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { db, username } = req;
        if (!username)
            return res.json([]);
        const pipeline = [
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
        res.json(results.map((r) => ({
            // @ts-ignore - TODO: strict typing
            model: r._id.model,
            // @ts-ignore - TODO: strict typing
            provider: r._id.provider,
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
        })));
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`GET /stats/models error: ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=StatsRoutes.js.map
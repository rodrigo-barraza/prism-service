import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS } from "../../constants.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import { applyDateRangeFilter, parsePaginationParams } from "../../utils/QueryBuilders.ts";
import { discoverDescendantSessionIds } from "../../utils/SessionDiscovery.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";

const sessionRouter = express.Router();
const agentSessionRouter = express.Router();
const { REQUESTS: REQUESTS_COL } = COLLECTIONS;

sessionRouter.use(requireDb);
agentSessionRouter.use(requireDb);

// ─── GET /sessions/:id/stats — aggregate stats for an agent session ─
sessionRouter.get(
  "/:id/stats",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params.id as string;
      const allSessionIds = await discoverDescendantSessionIds(req.db, sessionId);

      const requests = await req.db
        .collection(REQUESTS_COL)
        .find({ agentSessionId: { $in: [...allSessionIds] } })
        .project({
          estimatedCost: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 1,
          provider: 1,
          model: 1,
          operation: 1,
          timestamp: 1,
          modalities: 1,
          toolApiNames: 1,
          success: 1,
          agentSessionId: 1,
          parentAgentSessionId: 1,
        })
        .toArray();

      if (requests.length === 0) {
        return res
          .status(404)
          .json({ error: "No requests found for this session" });
      }

      const providers = new Set();
      const models = new Set();
      const operations = new Set();
      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheReadInputTokens = 0;
      let totalCacheCreationInputTokens = 0;
      let totalReasoningOutputTokens = 0;
      const mergedModalities: Record<string, boolean> = {};
      const toolCounts: Record<string, number> = {};

      for (const requestItem of requests) {
        totalCost += requestItem.estimatedCost || 0;
        totalInputTokens += requestItem.inputTokens || 0;
        totalOutputTokens += requestItem.outputTokens || 0;
        totalCacheReadInputTokens += requestItem.cacheReadInputTokens || 0;
        totalCacheCreationInputTokens += requestItem.cacheCreationInputTokens || 0;
        totalReasoningOutputTokens += requestItem.reasoningOutputTokens || 0;
        if (requestItem.provider) providers.add(requestItem.provider);
        if (requestItem.model) models.add(requestItem.model);
        if (requestItem.operation) operations.add(requestItem.operation);
        if (requestItem.modalities) {
          for (const [key, value] of Object.entries(requestItem.modalities)) {
            if (value) mergedModalities[key] = true;
          }
        }
        if (requestItem.toolApiNames?.length > 0) {
          for (const name of requestItem.toolApiNames) {
            toolCounts[name] = (toolCounts[name] || 0) + 1;
          }
        }
      }

      const workerRequestCount = requests.filter(
        (requestItem) => requestItem.agentSessionId !== sessionId,
      ).length;

      const createdAt = (requests as Record<string, unknown>[]).reduce(
        (min: string | null, requestItem) =>
          !min || (requestItem.timestamp as string) < min ? (requestItem.timestamp as string) : min,
        null as string | null,
      );
      const updatedAt = (requests as Record<string, unknown>[]).reduce(
        (max: string | null, requestItem) =>
          !max || (requestItem.timestamp as string) > max ? (requestItem.timestamp as string) : max,
        null as string | null,
      );

      const totalElapsedTime =
        createdAt && updatedAt
          ? Math.max(
              0,
              (new Date(updatedAt as string).getTime() - new Date(createdAt as string).getTime()) /
                1000,
            )
          : 0;

      res.json({
        agentSessionId: sessionId,
        requestCount: requests.length,
        workerRequestCount,
        totalCost,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCacheReadInputTokens,
        totalCacheCreationInputTokens,
        totalReasoningOutputTokens,
        providers: [...providers],
        models: [...models],
        operations: [...operations],
        modalities: mergedModalities,
        toolCounts,
        totalElapsedTime,
        createdAt,
        updatedAt,
      });
    } catch (error: unknown) {
      logger.error(`Admin /sessions/:id/stats error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /sessions/:id/requests — all requests for a session (recursive) ─
sessionRouter.get(
  "/:id/requests",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rootSessionId = req.params.id as string;
      const allSessionIds = await discoverDescendantSessionIds(req.db, rootSessionId);

      const requests = await req.db
        .collection(REQUESTS_COL)
        .find({ agentSessionId: { $in: [...allSessionIds] } })
        .project({
          requestId: 1,
          timestamp: 1,
          provider: 1,
          model: 1,
          operation: 1,
          endpoint: 1,
          success: 1,
          errorMessage: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 1,
          estimatedCost: 1,
          tokensPerSec: 1,
          totalTime: 1,
          toolsUsed: 1,
          toolDisplayNames: 1,
          toolApiNames: 1,
          modalities: 1,
          agentSessionId: 1,
          parentAgentSessionId: 1,
          traceId: 1,
          agent: 1,
        })
        .sort({ timestamp: 1 })
        .toArray();

      res.json({
        rootSessionId,
        sessionIds: [...allSessionIds],
        total: requests.length,
        requests,
      });
    } catch (error: unknown) {
      logger.error(`Admin /sessions/:id/requests error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /agent-sessions — list all agent sessions (cross-user) ─
agentSessionRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        agent,
        search,
        from,
        to,
        sort = "updatedAt",
      } = req.query;

      const { skip, limit, page, sortDirection } = parsePaginationParams(req.query);

      const queryFilter: Record<string, unknown> = {};
      if (project) queryFilter.project = project;
      if (agent) queryFilter.agent = agent;
      if (search) {
        const regex = { $regex: search, $options: "i" };
        queryFilter.$or = [
          { title: regex },
          { project: regex },
          { agent: regex },
        ];
      }
      applyDateRangeFilter(queryFilter, from as string, to as string, "updatedAt");

      const [sessionDocuments, totalSessionsCount] = await Promise.all([
        req.db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .find(queryFilter, {
            projection: { messages: 0 },
          })
          .sort({ [sort as string]: sortDirection })
          .skip(skip)
          .limit(limit)
          .toArray(),
        req.db.collection(COLLECTIONS.AGENT_CONVERSATIONS).countDocuments(queryFilter),
      ]);

      if (sessionDocuments.length > 0) {
        const sessionIds = sessionDocuments
          .map((session) => (session as Record<string, unknown>).id as string)
          .filter(Boolean);

        if (sessionIds.length > 0) {
          try {
            const costAggregation = await req.db
              .collection(COLLECTIONS.REQUESTS)
              .aggregate<{ _id: string; totalCost: number }>([
                {
                  $match: {
                    $or: [
                      { agentSessionId: { $in: sessionIds } },
                      { conversationId: { $in: sessionIds } },
                      { parentAgentSessionId: { $in: sessionIds } },
                    ],
                  },
                },
                {
                  $group: {
                    _id: {
                      $cond: [
                        {
                          $and: [
                            { $ne: ["$parentAgentSessionId", null] },
                            { $in: ["$parentAgentSessionId", sessionIds] },
                          ],
                        },
                        "$parentAgentSessionId",
                        { $ifNull: ["$conversationId", "$agentSessionId"] },
                      ],
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                  },
                },
              ])
              .toArray();

            if (costAggregation.length > 0) {
              const costMap = new Map(
                costAggregation.map((costEntry) => [costEntry._id, costEntry.totalCost])
              );
              for (const session of sessionDocuments) {
                const sessionId = (session as Record<string, unknown>).id as string;
                const requestLogCost = costMap.get(sessionId);
                if (requestLogCost !== undefined && requestLogCost > 0) {
                  (session as Record<string, unknown>).totalCost = Math.max(
                    (session.totalCost as number) || 0,
                    requestLogCost,
                  );
                }
              }
            }
          } catch (costError: unknown) {
            logger.warn(
              `Failed to enrich admin agent session costs: ${
                costError instanceof Error ? costError.message : String(costError)
              }`
            );
          }
        }
      }

      res.json({ data: sessionDocuments, total: totalSessionsCount, page, limit });
    } catch (error: unknown) {
      logger.error(`Admin /agent-sessions error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /agent-sessions/:id — single agent session (with messages) ─
agentSessionRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await req.db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: req.params.id });

      if (!document)
        return res.status(404).json({ error: "Agent session not found" });

      res.json(document);
    } catch (error: unknown) {
      logger.error(`Admin /agent-sessions/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export { sessionRouter, agentSessionRouter };

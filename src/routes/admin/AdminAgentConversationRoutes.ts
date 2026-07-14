import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  applyDateRangeFilter,
  parsePaginationParams,
} from "#src/utils/QueryBuilders";
import { discoverDescendantConversationIds } from "#src/utils/ConversationDiscovery";
import { buildConversationGraph } from "#src/services/conversation/buildConversationGraph";
import {
  buildGraphCacheKey,
  getGraphFromCache,
  setGraphInCache,
} from "#src/services/conversation/ConversationGraphCache";
import requireDb from "#src/middleware/RequireDbMiddleware";
import { prepareDisplayMessages } from "#src/services/ConversationService";
import type { ChatMessage } from "#src/types/admin";

const conversationStatsRouter = express.Router();
const agentConversationRouter = express.Router();
const { REQUESTS: REQUESTS_COLLECTION } = COLLECTIONS;

conversationStatsRouter.use(requireDb);
agentConversationRouter.use(requireDb);

// ─── GET /agent-conversations/:id/stats — aggregate stats for an agent conversation ─
conversationStatsRouter.get(
  "/:id/stats",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const conversationId = req.params.id as string;
      const allConversationIds = await discoverDescendantConversationIds(
        req.db,
        conversationId,
      );

      const requests = await req.db
        .collection(REQUESTS_COLLECTION)
        .find({
          agentConversationId: { $in: [...allConversationIds] },
        })
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
          createdAt: 1,
          modalities: 1,
          toolApiNames: 1,
          success: 1,
          agentConversationId: 1,
          parentAgentConversationId: 1,
        })
        .toArray();

      if (requests.length === 0) {
        return res
          .status(404)
          .json({ error: "No requests found for this conversation" });
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
        totalCacheCreationInputTokens +=
          requestItem.cacheCreationInputTokens || 0;
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

      const subAgentRequestCount = requests.filter(
        (requestItem) => requestItem.agentConversationId !== conversationId,
      ).length;

      const createdAt = (requests as Record<string, unknown>[]).reduce(
        (min: string | null, requestItem) =>
          !min || (requestItem.createdAt as string) < min
            ? (requestItem.createdAt as string)
            : min,
        null as string | null,
      );
      const updatedAt = (requests as Record<string, unknown>[]).reduce(
        (max: string | null, requestItem) =>
          !max || (requestItem.createdAt as string) > max
            ? (requestItem.createdAt as string)
            : max,
        null as string | null,
      );

      const totalElapsedTime =
        createdAt && updatedAt
          ? Math.max(
              0,
              (new Date(updatedAt as string).getTime() -
                new Date(createdAt as string).getTime()) /
                1000,
            )
          : 0;

      res.json({
        agentConversationId: conversationId,
        requestCount: requests.length,
        subAgentRequestCount,
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
      logger.error(
        `Admin /sessions/:id/stats error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /agent-conversations/:id/requests — all requests for a conversation (recursive) ─
conversationStatsRouter.get(
  "/:id/requests",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rootConversationId = req.params.id as string;
      const allConversationIds = await discoverDescendantConversationIds(
        req.db,
        rootConversationId,
      );

      const requests = await req.db
        .collection(REQUESTS_COLLECTION)
        .find({
          agentConversationId: { $in: [...allConversationIds] },
        })
        .project({
          requestId: 1,
          createdAt: 1,
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
          agentConversationId: 1,
          parentAgentConversationId: 1,
          traceId: 1,
          agent: 1,
          username: 1,
        })
        .sort({ createdAt: 1 })
        .toArray();

      res.json({
        rootConversationId,
        conversationIds: [...allConversationIds],
        total: requests.length,
        requests,
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /sessions/:id/requests error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /agent-conversations/:id/graph — pre-computed graph with layout ─
conversationStatsRouter.get(
  "/:id/graph",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rootConversationId = req.params.id as string;
      const canvasWidth = parseInt(req.query.width as string, 10) || 1600;
      const canvasHeight = parseInt(req.query.height as string, 10) || 900;

      // Fast path: discover descendant IDs and count requests to build
      // the cache key. countDocuments is cheaper than fetching all fields.
      const allConversationIds = await discoverDescendantConversationIds(
        req.db,
        rootConversationId,
      );

      const requestCount = await req.db
        .collection(REQUESTS_COLLECTION)
        .countDocuments({
          agentConversationId: { $in: [...allConversationIds] },
        });

      const cacheKey = buildGraphCacheKey(
        rootConversationId,
        requestCount,
        canvasWidth,
        canvasHeight,
      );

      const cachedGraphData = getGraphFromCache(cacheKey);
      if (cachedGraphData) {
        return res.json(cachedGraphData);
      }

      // Cache miss — full pipeline: fetch conversation + request documents
      const [conversationDocument, requests] = await Promise.all([
        req.db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .findOne({ id: rootConversationId }),
        req.db
          .collection(REQUESTS_COLLECTION)
          .find({
            agentConversationId: { $in: [...allConversationIds] },
          })
          .project({
            requestId: 1,
            createdAt: 1,
            provider: 1,
            model: 1,
            operation: 1,
            success: 1,
            inputTokens: 1,
            outputTokens: 1,
            estimatedCost: 1,
            toolApiNames: 1,
            agentConversationId: 1,
            parentAgentConversationId: 1,
            agent: 1,
            username: 1,
            status: 1,
            duration: 1,
            timestamp: 1,
          })
          .sort({ createdAt: 1 })
          .toArray(),
      ]);

      if (!conversationDocument) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const graphData = buildConversationGraph(
        conversationDocument as Record<string, unknown>,
        null,
        requests as Record<string, unknown>[],
        canvasWidth,
        canvasHeight,
      );

      setGraphInCache(cacheKey, graphData);
      res.json(graphData);
    } catch (error: unknown) {
      logger.error(
        `Admin /agent-conversations/:id/graph error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /agent-conversations — list all agent conversations (cross-user) ─
agentConversationRouter.get(
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

      const { skip, limit, page, sortDirection } = parsePaginationParams(
        req.query,
      );

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
      applyDateRangeFilter(
        queryFilter,
        from as string,
        to as string,
        "updatedAt",
      );

      const [conversationDocuments, totalConversationsCount] =
        await Promise.all([
          req.db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .find(queryFilter, {
              projection: { messages: 0 },
            })
            .sort({ [sort as string]: sortDirection })
            .skip(skip)
            .limit(limit)
            .toArray(),
          req.db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .countDocuments(queryFilter),
        ]);

      if (conversationDocuments.length > 0) {
        const conversationIds = conversationDocuments
          .map(
            (conversation) =>
              (conversation as Record<string, unknown>).id as string,
          )
          .filter(Boolean);

        if (conversationIds.length > 0) {
          try {
            const costAggregation = await req.db
              .collection(COLLECTIONS.REQUESTS)
              .aggregate<{ _id: string; totalCost: number }>([
                {
                  $match: {
                    $or: [
                      { agentConversationId: { $in: conversationIds } },
                      { conversationId: { $in: conversationIds } },
                      { parentAgentConversationId: { $in: conversationIds } },
                    ],
                  },
                },
                {
                  $group: {
                    _id: {
                      $cond: [
                        {
                          $and: [
                            { $ne: ["$parentAgentConversationId", null] },
                            {
                              $in: [
                                "$parentAgentConversationId",
                                conversationIds,
                              ],
                            },
                          ],
                        },
                        "$parentAgentConversationId",
                        {
                          $ifNull: ["$conversationId", "$agentConversationId"],
                        },
                      ],
                    },
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                  },
                },
              ])
              .toArray();

            if (costAggregation.length > 0) {
              const costMap = new Map(
                costAggregation.map((costEntry) => [
                  costEntry._id,
                  costEntry.totalCost,
                ]),
              );
              for (const conversation of conversationDocuments) {
                const conversationId = (conversation as Record<string, unknown>)
                  .id as string;
                const requestLogCost = costMap.get(conversationId);
                if (requestLogCost !== undefined && requestLogCost > 0) {
                  (conversation as Record<string, unknown>).totalCost =
                    Math.max(
                      (conversation.totalCost as number) || 0,
                      requestLogCost,
                    );
                }
              }
            }
          } catch (costError: unknown) {
            logger.warn(
              `Failed to enrich admin agent conversation costs: ${getErrorMessage(
                costError,
              )}`,
            );
          }
        }
      }

      res.json({
        data: conversationDocuments,
        total: totalConversationsCount,
        page,
        limit,
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /agent-conversations error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /agent-conversations/:id — single agent conversation (with messages) ─
agentConversationRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await req.db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: req.params.id });

      if (!document)
        return res.status(404).json({ error: "Agent conversation not found" });

      res.json({
        ...document,
        displayMessages: prepareDisplayMessages(
          (document.messages as ChatMessage[]) || [],
        ),
      });
    } catch (error: unknown) {
      logger.error(
        `Admin /agent-conversations/:id error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

export { conversationStatsRouter, agentConversationRouter };

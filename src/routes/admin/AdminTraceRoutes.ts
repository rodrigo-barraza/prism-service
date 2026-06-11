import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS, COST_SUM_EXPR } from "../../constants.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import { applyDateRangeFilter, parsePaginationParams } from "../../utils/QueryBuilders.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";

const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION } = COLLECTIONS;

router.use(requireDb);

// ─── GET /traces — paginated trace list (derived from requests) ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        username,
        from,
        to,
        sort = "createdAt",
        provider,
        model,
        agent,
        workspace,
      } = req.query;

      const { skip, limit, page, sortDirection } = parsePaginationParams(req.query);

      const match: Record<string, unknown> = { traceId: { $ne: null } };
      if (project) match.project = project;
      if (username) match.username = username;

      if (agent) {
        const agentIds = String(agent).split(",").filter(Boolean);
        if (agentIds.length === 1) {
          match.agent = agentIds[0];
        } else if (agentIds.length > 1) {
          match.agent = { $in: agentIds };
        }
      }

      if (provider) {
        const providerNames = String(provider).split(",").filter(Boolean);
        if (providerNames.length === 1) {
          match.provider = providerNames[0];
        } else if (providerNames.length > 1) {
          match.provider = { $in: providerNames };
        }
      }

      if (model) {
        const modelNames = String(model).split(",").filter(Boolean);
        if (modelNames.length === 1) {
          match.model = modelNames[0];
        } else if (modelNames.length > 1) {
          match.model = { $in: modelNames };
        }
      }

      applyDateRangeFilter(match, from as string, to as string);

      if (workspace) {
        const [convDocs, agentConvDocs] = await Promise.all([
          req.db
            .collection(COLLECTIONS.MODEL_CONVERSATIONS)
            .find({ workspaceRoot: workspace })
            .project({ id: 1 })
            .toArray(),
          req.db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .find({ workspaceRoot: workspace })
            .project({ id: 1 })
            .toArray(),
        ]);
        const convIds = convDocs.map((document) => document.id);
        const agentSessionIds = agentConvDocs.map((document) => document.id);
        match.$or = [
          { conversationId: { $in: convIds } },
          { agentSessionId: { $in: agentSessionIds } },
          { parentAgentSessionId: { $in: agentSessionIds } },
        ];
      }

      const pipeline: Record<string, unknown>[] = [
        { $match: match },
        {
          $group: {
            _id: "$traceId",
            project: { $first: "$project" },
            username: { $first: "$username" },
            createdAt: { $min: "$timestamp" },
            updatedAt: { $max: "$timestamp" },
            requestCount: { $sum: 1 },
            totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
            totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
            totalCost: COST_SUM_EXPR,
            totalLatency: { $sum: { $ifNull: ["$totalTime", 0] } },
            totalMessages: { $sum: { $ifNull: ["$messageCount", 0] } },
            _models: { $addToSet: "$model" },
            _providers: { $addToSet: "$provider" },
            _agents: { $addToSet: "$agent" },
            _toolArrays: { $push: { $ifNull: ["$toolDisplayNames", []] } },
            _toolCallArrays: { $push: { $ifNull: ["$toolApiNames", []] } },
            _tpsValues: { $push: "$tokensPerSec" },
            _modalities: { $push: "$modalities" },
            _requests: {
              $push: {
                requestId: "$requestId",
                conversationId: "$conversationId",
                traceId: "$traceId",
                inputTokens: "$inputTokens",
                outputTokens: "$outputTokens",
                model: "$model",
                provider: "$provider",
                project: "$project",
                username: "$username",
                endpoint: "$endpoint",
                operation: "$operation",
                estimatedCost: "$estimatedCost",
                success: "$success",
                modalities: "$modalities",
                messageCount: "$messageCount",
                tokensPerSec: "$tokensPerSec",
                totalTime: "$totalTime",
                toolsUsed: "$toolsUsed",
                toolDisplayNames: "$toolDisplayNames",
                toolApiNames: "$toolApiNames",
                agent: "$agent",
                timestamp: "$timestamp",
              },
            },
          },
        },
        {
          $addFields: {
            id: "$_id",
            models: { $setDifference: ["$_models", [null]] },
            providers: { $setDifference: ["$_providers", [null]] },
            agents: { $setDifference: ["$_agents", [null]] },
            toolDisplayNames: {
              $setUnion: {
                $reduce: {
                  input: "$_toolArrays",
                  initialValue: [],
                  in: { $concatArrays: ["$$value", "$$this"] },
                },
              },
            },
            toolApiNames: {
              $setUnion: {
                $reduce: {
                  input: "$_toolCallArrays",
                  initialValue: [],
                  in: { $concatArrays: ["$$value", "$$this"] },
                },
              },
            },
            avgTokensPerSec: {
              $avg: {
                $filter: {
                  input: "$_tpsValues",
                  as: "tps",
                  cond: {
                    $and: [{ $ne: ["$$tps", null] }, { $gt: ["$$tps", 0] }],
                  },
                },
              },
            },
            startedAt: "$createdAt",
            finishedAt: "$updatedAt",
            modalities: {
              $reduce: {
                input: "$_modalities",
                initialValue: {},
                in: {
                  $mergeObjects: [
                    "$$value",
                    {
                      $cond: [
                        { $ne: ["$$this", null] },
                        {
                          $arrayToObject: {
                            $filter: {
                              input: { $objectToArray: "$$this" },
                              as: "kv",
                              cond: { $eq: ["$$kv.v", true] },
                            },
                          },
                        },
                        {},
                      ],
                    },
                  ],
                },
              },
            },
            requests: "$_requests",
          },
        },
        {
          $project: {
            _id: 0,
            _models: 0,
            _providers: 0,
            _agents: 0,
            _toolArrays: 0,
            _toolCallArrays: 0,
            _tpsValues: 0,
            _modalities: 0,
            _requests: 0,
          },
        },
        { $sort: { [sort as string]: sortDirection } },
      ];

      const countPipeline: Record<string, unknown>[] = [...pipeline, { $count: "total" }];
      pipeline.push({ $skip: skip }, { $limit: limit });

      const [docs, countResult] = await Promise.all([
        req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
        req.db.collection(REQUESTS_COLLECTION).aggregate(countPipeline).toArray(),
      ]);
      const total = countResult[0]?.total || 0;

      res.json({ data: docs, total, page, limit });
    } catch (error: unknown) {
      logger.error(`Admin /traces error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /traces/:id — single trace derived from requests ─
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requests = await req.db
        .collection(REQUESTS_COLLECTION)
        .find({ traceId: req.params.id })
        .toArray();

      if (requests.length === 0) {
        return res.status(404).json({ error: "Trace not found" });
      }

      const trace = {
        id: req.params.id,
        project: requests[0].project,
        username: requests[0].username,
        requestCount: requests.length,
        totalCost: requests.reduce(
          (sum: number, r: Record<string, unknown>) => sum + ((r.estimatedCost as number) || 0),
          0,
        ),
        totalInputTokens: requests.reduce(
          (sum: number, r: Record<string, unknown>) => sum + ((r.inputTokens as number) || 0),
          0,
        ),
        totalOutputTokens: requests.reduce(
          (sum: number, r: Record<string, unknown>) => sum + ((r.outputTokens as number) || 0),
          0,
        ),
        createdAt: (requests as Record<string, unknown>[]).reduce(
          (min: string | null, r) => (!min || (r.timestamp as string) < min ? (r.timestamp as string) : min),
          null as string | null,
        ),
        updatedAt: (requests as Record<string, unknown>[]).reduce(
          (max: string | null, r) => (!max || (r.timestamp as string) > max ? (r.timestamp as string) : max),
          null as string | null,
        ),
        requests,
      };

      res.json(trace);
    } catch (error: unknown) {
      logger.error(`Admin /traces/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

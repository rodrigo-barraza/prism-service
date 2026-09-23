import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { COLLECTIONS, COST_SUMMATION_EXPRESSION, AGGREGATE_MAX_TIME_MILLISECONDS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  applyDateRangeFilter,
  parsePaginationParams,
} from "#src/utils/QueryBuilders";
import requireDb from "#src/middleware/RequireDbMiddleware";
import { StatsCache } from "#src/caches/StatsCache";
import {
  aggregateRequestStats,
  isCoveredMatch,
} from "#src/services/RequestStatsIndex";

const router = express.Router();
const { REQUESTS: REQUESTS_COLLECTION } = COLLECTIONS;

router.use(requireDb);

/**
 * Trace sort keys the stats covering index can compute on its own. Sorting by
 * one of them pages in two passes: pick the page's trace ids from index keys
 * alone, then build the full summaries for those traces only. The one-pass
 * pipeline grouped every request in range — ~17 KB each — to show a page of
 * 5 or 50 (11.6 s all-time on prod, 2026-09-23).
 */
const INDEX_SORT_ACCUMULATORS: Record<string, Record<string, unknown>> = {
  createdAt: { $min: "$createdAt" },
  startedAt: { $min: "$createdAt" },
  updatedAt: { $max: "$createdAt" },
  finishedAt: { $max: "$createdAt" },
  requestCount: { $sum: 1 },
  totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
  totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
  totalCost: COST_SUMMATION_EXPRESSION,
  totalLatency: { $sum: { $ifNull: ["$totalTime", 0] } },
};

/**
 * First pass: one page of trace ids plus the trace total, from index keys.
 * The trace list's `traceId: { $ne: null }` is applied to the group key
 * inside the `$facet` — in the query it makes Mongo FETCH every row, and a
 * `$match` on the group key outside a `$facet` is moved back into the query.
 */
export function buildTracePagePipeline(
  match: Record<string, unknown>,
  {
    sortAccumulator,
    sortDirection,
    skip,
    limit,
  }: {
    sortAccumulator: Record<string, unknown>;
    sortDirection: 1 | -1;
    skip: number;
    limit: number;
  },
) {
  const indexMatch = { ...match };
  delete indexMatch.traceId;
  const pipeline = [
    ...(Object.keys(indexMatch).length ? [{ $match: indexMatch }] : []),
    { $group: { _id: "$traceId", sortValue: sortAccumulator } },
    {
      $facet: {
        ids: [
          { $match: { _id: { $ne: null } } },
          { $sort: { sortValue: sortDirection, _id: 1 } },
          { $skip: skip },
          { $limit: limit },
        ],
        metadata: [{ $match: { _id: { $ne: null } } }, { $count: "total" }],
      },
    },
  ];
  return { pipeline, covered: isCoveredMatch(indexMatch) };
}

// ─── GET /traces — paginated trace list (derived from requests) ─
// Lightweight summary-only aggregate: no $push of full documents.
// Full request details are fetched lazily via GET /traces/:id.
// AGGREGATE_MAX_TIME_MILLISECONDS imported from constants.ts

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/traces", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
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

        const { skip, limit, page, sortDirection } = parsePaginationParams(
          req.query,
        );

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
          const agentConversationIds = agentConvDocs.map(
            (document) => document.id,
          );
          match.$or = [
            { conversationId: { $in: convIds } },
            { agentConversationId: { $in: agentConversationIds } },
            { parentAgentConversationId: { $in: agentConversationIds } },
          ];
        }

        const groupStage = {
          $group: {
            _id: "$traceId",
            project: { $first: "$project" },
            username: { $first: "$username" },
            createdAt: { $min: "$createdAt" },
            updatedAt: { $max: "$createdAt" },
            requestCount: { $sum: 1 },
            totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
            totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
            totalCost: COST_SUMMATION_EXPRESSION,
            totalLatency: { $sum: { $ifNull: ["$totalTime", 0] } },
            totalMessages: { $sum: { $ifNull: ["$messageCount", 0] } },
            _models: { $addToSet: "$model" },
            _providers: { $addToSet: "$provider" },
            _agents: { $addToSet: "$agent" },
            _toolDisplayNames: { $addToSet: "$toolDisplayNames" },
            _toolApiNames: { $addToSet: "$toolApiNames" },
            _hasAudio: { $max: { $ifNull: ["$modalities.audio", false] } },
            _hasVision: { $max: { $ifNull: ["$modalities.vision", false] } },
            _hasImage: { $max: { $ifNull: ["$modalities.image", false] } },
            _tpsSum: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$tokensPerSec", null] },
                      { $gt: ["$tokensPerSec", 0] },
                    ],
                  },
                  "$tokensPerSec",
                  0,
                ],
              },
            },
            _tpsCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ["$tokensPerSec", null] },
                      { $gt: ["$tokensPerSec", 0] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        };

        const projectStage = {
          $addFields: {
            id: "$_id",
            models: { $setDifference: ["$_models", [null]] },
            providers: { $setDifference: ["$_providers", [null]] },
            agents: { $setDifference: ["$_agents", [null]] },
            toolDisplayNames: {
              $setDifference: [
                {
                  $reduce: {
                    input: {
                      $filter: {
                        input: "$_toolDisplayNames",
                        as: "array",
                        cond: { $isArray: "$$array" },
                      },
                    },
                    initialValue: [],
                    in: { $setUnion: ["$$value", "$$this"] },
                  },
                },
                [null],
              ],
            },
            toolApiNames: {
              $setDifference: [
                {
                  $reduce: {
                    input: {
                      $filter: {
                        input: "$_toolApiNames",
                        as: "array",
                        cond: { $isArray: "$$array" },
                      },
                    },
                    initialValue: [],
                    in: { $setUnion: ["$$value", "$$this"] },
                  },
                },
                [null],
              ],
            },
            avgTokensPerSec: {
              $cond: [
                { $gt: ["$_tpsCount", 0] },
                { $divide: ["$_tpsSum", "$_tpsCount"] },
                null,
              ],
            },
            startedAt: "$createdAt",
            finishedAt: "$updatedAt",
            modalities: {
              $arrayToObject: {
                $filter: {
                  input: [
                    { k: "audio", v: "$_hasAudio" },
                    { k: "vision", v: "$_hasVision" },
                    { k: "image", v: "$_hasImage" },
                  ],
                  as: "entry",
                  cond: { $eq: ["$$entry.v", true] },
                },
              },
            },
          },
        };

        const cleanupStage = {
          $project: {
            _id: 0,
            _models: 0,
            _providers: 0,
            _agents: 0,
            _toolDisplayNames: 0,
            _toolApiNames: 0,
            _tpsSum: 0,
            _tpsCount: 0,
            _hasAudio: 0,
            _hasVision: 0,
            _hasImage: 0,
          },
        };

        const sortKey = String(sort);
        const indexSortAccumulator = INDEX_SORT_ACCUMULATORS[sortKey];
        if (indexSortAccumulator) {
          const { pipeline, covered } = buildTracePagePipeline(match, {
            sortAccumulator: indexSortAccumulator,
            sortDirection,
            skip,
            limit,
          });
          const [pageResult] = await aggregateRequestStats(req.db, pipeline, {
            covered,
            maxTimeMS: AGGREGATE_MAX_TIME_MILLISECONDS,
          });
          const traceIds: string[] = (pageResult?.ids || []).map(
            (row: { _id: string }) => row._id,
          );
          const total = pageResult?.metadata?.[0]?.total || 0;
          if (traceIds.length === 0) return { data: [], total, page, limit };

          const summaries = await req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(
              [
                { $match: { ...match, traceId: { $in: traceIds } } },
                groupStage,
                projectStage,
                cleanupStage,
              ],
              { maxTimeMS: AGGREGATE_MAX_TIME_MILLISECONDS },
            )
            .toArray();
          const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
          const data = traceIds
            .map((traceId) => summaryById.get(traceId))
            .filter(Boolean);
          return { data, total, page, limit };
        }

        // Any other sort key needs every trace's full summary to order them.
        const sortStage = { $sort: { [sortKey]: sortDirection, id: 1 } };

        const facetPipeline = [
          { $match: match },
          groupStage,
          projectStage,
          cleanupStage,
          {
            $facet: {
              data: [sortStage, { $skip: skip }, { $limit: limit }],
              metadata: [{ $count: "total" }],
            },
          },
        ];

        const [result] = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(facetPipeline, { maxTimeMS: AGGREGATE_MAX_TIME_MILLISECONDS })
          .toArray();

        const docs = result?.data || [];
        const total = result?.metadata?.[0]?.total || 0;

        return { data: docs, total, page, limit };
      });

      res.json(responseData);
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
        .find(
          { traceId: req.params.id },
          {
            projection: { requestPayload: 0, responsePayload: 0 },
            maxTimeMS: AGGREGATE_MAX_TIME_MILLISECONDS,
          },
        )
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
          (sum: number, r: Record<string, unknown>) =>
            sum + ((r.estimatedCost as number) || 0),
          0,
        ),
        totalInputTokens: requests.reduce(
          (sum: number, r: Record<string, unknown>) =>
            sum + ((r.inputTokens as number) || 0),
          0,
        ),
        totalOutputTokens: requests.reduce(
          (sum: number, r: Record<string, unknown>) =>
            sum + ((r.outputTokens as number) || 0),
          0,
        ),
        createdAt: (requests as Record<string, unknown>[]).reduce(
          (min: string | null, r) =>
            !min || (r.createdAt as string) < min
              ? (r.createdAt as string)
              : min,
          null as string | null,
        ),
        updatedAt: (requests as Record<string, unknown>[]).reduce(
          (max: string | null, r) =>
            !max || (r.createdAt as string) > max
              ? (r.createdAt as string)
              : max,
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

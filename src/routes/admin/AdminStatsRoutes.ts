import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import {
  COLLECTIONS,
  COST_SUMMATION_EXPRESSION,
  TOTAL_TOKENS_EXPRESSION,
  AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
} from "#src/constants";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import logger from "#src/utils/logger";
import { getErrorMessage } from "#src/utils/ErrorHelpers";
import {
  applyDateRangeFilter,
} from "#src/utils/QueryBuilders";
import requireDb from "#src/middleware/RequireDbMiddleware";
import { hours as hoursToMilliseconds } from "@rodrigo-barraza/utilities-library";
import { StatsCache } from "#src/caches/StatsCache";

export interface TransformedStatsMatchFilter {
  project?: unknown;
  agent?: unknown;
  provider?: unknown;
  model?: unknown;
  createdAt?: { $gte?: Date; $lte?: Date };
  workspaceId?: unknown;
  [key: string]: unknown;
}

const router = express.Router();
const {
  REQUESTS: REQUESTS_COLLECTION,
  MODEL_CONVERSATIONS: CONVERSATIONS_COLLECTION,
  WORKFLOWS: WORKFLOWS_COLLECTION,
} = COLLECTIONS;

router.use(requireDb);

async function buildMatchFilter(
  req: Request,
): Promise<TransformedStatsMatchFilter> {
  const { from, to, project, agent, provider, model, workspace } = req.query;
  const match: TransformedStatsMatchFilter = {};

  if (project) {
    match.project = project;
  }

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
    const agentConversationIds = agentConvDocs.map((document) => document.id);
    match.$or = [
      { conversationId: { $in: convIds } },
      { agentConversationId: { $in: agentConversationIds } },
      { parentAgentConversationId: { $in: agentConversationIds } },
    ];
  }

  return match;
}

// ─── GET /stats — aggregate stats ─────────────────────
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        const { from, to, project, provider, model, workspace } = req.query;

        const pipeline: Record<string, unknown>[] = [
          ...(Object.keys(match).length ? [{ $match: match }] : []),
          {
            $group: {
              _id: null,
              totalRequests: { $sum: 1 },
              totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
              totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
              totalCost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
              totalDuration: { $sum: { $ifNull: ["$totalTime", 0] } },
              successCount: {
                $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
              },
              errorCount: {
                $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
              },
              totalToolCalls: {
                $sum: { $size: { $ifNull: ["$toolApiNames", []] } },
              },
            },
          },
        ];

        const convMatch: Record<string, unknown> = {};
        if (project) convMatch.project = project;
        if (workspace) convMatch.workspaceRoot = workspace;
        if (provider) {
          const providerNames = String(provider).split(",").filter(Boolean);
          if (providerNames.length === 1) convMatch.providers = providerNames[0];
          else if (providerNames.length > 1)
            convMatch.providers = { $in: providerNames };
        }
        if (model) {
          const modelNames = String(model).split(",").filter(Boolean);
          if (modelNames.length === 1)
            convMatch["messages.model"] = modelNames[0];
          else if (modelNames.length > 1)
            convMatch["messages.model"] = { $in: modelNames };
        }
        applyDateRangeFilter(
          convMatch,
          from as string,
          to as string,
          "createdAt",
        );

        const traceMatch = { ...match, traceId: { $ne: null } };

        const traceCountPipeline: Record<string, unknown>[] = [
          { $match: traceMatch },
          { $group: { _id: "$traceId" } },
          { $count: "total" },
        ];

        const agentCount = AgentPersonaRegistry.list().length;
        const workspaceCount = ToolOrchestratorService.getWorkspaceRoots().length;

        const [resultDocs, traceResult, conversationCount] =
          await Promise.all([
            req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
            req.db
              .collection(REQUESTS_COLLECTION)
              .aggregate(traceCountPipeline)
              .toArray(),
            Object.keys(convMatch).length === 0
              ? req.db.collection(CONVERSATIONS_COLLECTION).estimatedDocumentCount()
              : req.db.collection(CONVERSATIONS_COLLECTION).countDocuments(convMatch),
          ]);
        const result = (resultDocs[0] || {}) as Record<string, unknown>;
        const traceCount = traceResult[0]?.total || 0;
        const totalToolCalls = (result.totalToolCalls as number) || 0;

        return {
          totalRequests: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCost: 0,
          avgLatency: 0,
          avgTokensPerSec: 0,
          totalDuration: 0,
          successCount: 0,
          errorCount: 0,
          ...result,
          traceCount,
          conversationCount,
          totalToolCalls,
          agentCount,
          workspaceCount,
        };
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/projects — per-project breakdown ──────
router.get(
  "/projects",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/projects", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        const { from, to, project, provider, model, workspace } = req.query;

        const pipeline: Record<string, unknown>[] = [
          ...(Object.keys(match).length ? [{ $match: match }] : []),
          {
            $group: {
              _id: "$project",
              totalRequests: { $sum: 1 },
              totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
              totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
              totalTokens: TOTAL_TOKENS_EXPRESSION,
              totalCost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
              lastRequest: { $max: "$createdAt" },
              _models: { $addToSet: "$model" },
              _providers: { $addToSet: "$provider" },
              _traceIds: { $addToSet: "$traceId" },
            },
          },
          {
            $project: {
              totalRequests: 1,
              totalInputTokens: 1,
              totalOutputTokens: 1,
              totalTokens: 1,
              totalCost: 1,
              avgLatency: 1,
              avgTokensPerSec: 1,
              lastRequest: 1,
              _models: 1,
              _providers: 1,
              traceCount: {
                $size: {
                  $filter: {
                    input: "$_traceIds",
                    as: "id",
                    cond: { $ne: ["$$id", null] },
                  },
                },
              },
            },
          },
          {
            $addFields: {
              modelCount: { $size: "$_models" },
              providerCount: { $size: "$_providers" },
            },
          },
          { $sort: { totalRequests: -1 } },
        ];

        const workflowPipeline: Record<string, unknown>[] = [
          { $match: { conversationIds: { $exists: true, $ne: [] } } },
          {
            $lookup: {
              from: CONVERSATIONS_COLLECTION,
              localField: "conversationIds",
              foreignField: "id",
              as: "_convs",
              pipeline: [{ $project: { project: 1 } }],
            },
          },
          { $unwind: "$_convs" },
          {
            $group: {
              _id: "$_convs.project",
              workflowIds: { $addToSet: "$_id" },
            },
          },
          { $project: { _id: 1, workflowCount: { $size: "$workflowIds" } } },
        ];

        const convMatch: Record<string, unknown> = {};
        if (project) convMatch.project = project;
        if (workspace) convMatch.workspaceRoot = workspace;
        if (provider) {
          const providerNames = String(provider).split(",").filter(Boolean);
          if (providerNames.length === 1) convMatch.providers = providerNames[0];
          else if (providerNames.length > 1)
            convMatch.providers = { $in: providerNames };
        }
        if (model) {
          const modelNames = String(model).split(",").filter(Boolean);
          if (modelNames.length === 1)
            convMatch["messages.model"] = modelNames[0];
          else if (modelNames.length > 1)
            convMatch["messages.model"] = { $in: modelNames };
        }
        applyDateRangeFilter(
          convMatch,
          from as string,
          to as string,
          "updatedAt",
        );

        const convPipeline: Record<string, unknown>[] = [
          ...(Object.keys(convMatch).length ? [{ $match: convMatch }] : []),
          { $group: { _id: "$project", conversationCount: { $sum: 1 } } },
        ];

        const [results, workflowCounts, convCounts] =
          await Promise.all([
            req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
            req.db
              .collection(WORKFLOWS_COLLECTION)
              .aggregate(workflowPipeline)
              .toArray(),
            req.db
              .collection(CONVERSATIONS_COLLECTION)
              .aggregate(convPipeline)
              .toArray(),
          ]);

        const wfMap: Record<string, number> = {};
        for (const wc of workflowCounts) {
          wfMap[wc._id || "any"] = wc.workflowCount;
        }

        const convMap: Record<string, number> = {};
        for (const cc of convCounts) {
          convMap[cc._id || "any"] = cc.conversationCount;
        }

        return results.map((r: Record<string, unknown>) => ({
          project: r._id || "any",
          totalRequests: r.totalRequests,
          totalInputTokens: r.totalInputTokens,
          totalOutputTokens: r.totalOutputTokens,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          avgLatency: r.avgLatency,
          avgTokensPerSec: r.avgTokensPerSec,
          lastRequest: r.lastRequest,
          modelCount: r.modelCount,
          providerCount: r.providerCount,
          models: ((r._models || []) as string[]).filter(Boolean),
          providers: ((r._providers || []) as string[]).filter(Boolean),
          workflowCount: wfMap[(r._id as string) || "any"] || 0,
          conversationCount: convMap[(r._id as string) || "any"] || 0,
          traceCount: (r.traceCount as number) || 0,
        }));
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/projects error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/users — per-user breakdown ────────────
router.get(
  "/users",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/users", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        const pipeline: Record<string, unknown>[] = [
          ...(Object.keys(match).length ? [{ $match: match }] : []),
          {
            $group: {
              _id: "$username",
              totalRequests: { $sum: 1 },
              totalTokens: TOTAL_TOKENS_EXPRESSION,
              totalCost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              lastRequest: { $max: "$createdAt" },
            },
          },
          { $sort: { totalRequests: -1 } },
        ];

        const results = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(pipeline)
          .toArray();

        return results.map((r: Record<string, unknown>) => ({
          username: r._id || "any",
          totalRequests: r.totalRequests,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          avgLatency: r.avgLatency,
          lastRequest: r.lastRequest,
        }));
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/users error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/models — per-model breakdown ──────────
router.get(
  "/models",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/models", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);

        const pipeline: Record<string, unknown>[] = [
          ...(Object.keys(match).length ? [{ $match: match }] : []),
          {
            $group: {
              _id: { model: "$model", provider: "$provider" },
              totalRequests: { $sum: 1 },
              totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
              totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
              totalTokens: TOTAL_TOKENS_EXPRESSION,
              totalCost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
              toolsUsed: {
                $max: { $cond: [{ $eq: ["$toolsUsed", true] }, true, false] },
              },
              _conversationIds: { $addToSet: "$conversationId" },
              _traceIds: { $addToSet: "$traceId" },
            },
          },
          {
            $project: {
              totalRequests: 1,
              totalInputTokens: 1,
              totalOutputTokens: 1,
              totalTokens: 1,
              totalCost: 1,
              avgLatency: 1,
              avgTokensPerSec: 1,
              toolsUsed: 1,
              conversationCount: {
                $size: {
                  $filter: {
                    input: "$_conversationIds",
                    as: "id",
                    cond: { $ne: ["$$id", null] },
                  },
                },
              },
              traceCount: {
                $size: {
                  $filter: {
                    input: "$_traceIds",
                    as: "id",
                    cond: { $ne: ["$$id", null] },
                  },
                },
              },
            },
          },
          { $sort: { totalRequests: -1 } },
        ];

        const results = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(pipeline)
          .toArray();

        return results.map((r: Record<string, unknown>) => {
          const modelKey = `${(r._id as { model: string }).model}|${(r._id as { provider: string }).provider}`;
          return {
            model: (r._id as { model: string }).model,
            provider: (r._id as { provider: string }).provider,
            totalRequests: r.totalRequests,
            totalInputTokens: r.totalInputTokens,
            totalOutputTokens: r.totalOutputTokens,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            avgTokensPerSec: r.avgTokensPerSec,
            toolsUsed: r.toolsUsed || false,
            conversationCount: (r.conversationCount as number) || 0,
            workflowCount: 0,
            traceCount: (r.traceCount as number) || 0,
          };
        });
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/tools — per-tool lifetime usage breakdown ─
router.get(
  "/tools",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/tools", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        match.toolApiNames = { $exists: true, $ne: [] };
        const { tool } = req.query;

        const pipeline: Record<string, unknown>[] = [
          { $match: match },
          {
            $addFields: {
              toolCount: { $size: { $ifNull: ["$toolApiNames", []] } },
            },
          },
          { $unwind: "$toolApiNames" },
          ...(tool ? [{ $match: { toolApiNames: tool } }] : []),
          {
            $group: {
              _id: "$toolApiNames",
              totalCalls: { $sum: 1 },
              totalRequests: { $addToSet: "$requestId" },
              totalCost: {
                $sum: {
                  $cond: [
                    { $gt: ["$toolCount", 0] },
                    {
                      $divide: [{ $ifNull: ["$estimatedCost", 0] }, "$toolCount"],
                    },
                    0,
                  ],
                },
              },
              totalInputTokens: {
                $sum: {
                  $cond: [
                    { $gt: ["$toolCount", 0] },
                    { $divide: [{ $ifNull: ["$inputTokens", 0] }, "$toolCount"] },
                    0,
                  ],
                },
              },
              totalOutputTokens: {
                $sum: {
                  $cond: [
                    { $gt: ["$toolCount", 0] },
                    {
                      $divide: [{ $ifNull: ["$outputTokens", 0] }, "$toolCount"],
                    },
                    0,
                  ],
                },
              },
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              firstUsed: { $min: "$createdAt" },
              lastUsed: { $max: "$createdAt" },
              _models: { $push: "$model" },
              _agents: { $push: "$agent" },
              _providers: { $addToSet: "$provider" },
              successCount: {
                $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
              },
              failureCount: {
                $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
              },
            },
          },
          {
            $addFields: {
              totalRequests: { $size: "$totalRequests" },
            },
          },
          { $sort: { totalCalls: -1 } },
        ];

        const results = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(pipeline)
          .toArray();

        return results.map((result: Record<string, unknown>) => {
          const modelCounts: Record<string, number> = {};
          for (const model of (result._models as string[]) || []) {
            if (model) modelCounts[model] = (modelCounts[model] || 0) + 1;
          }
          const topModels = Object.entries(modelCounts)
            .sort((firstItem, secondItem) => secondItem[1] - firstItem[1])
            .slice(0, 5)
            .map(([model, count]) => ({ model, count }));

          const agentCounts: Record<string, number> = {};
          for (const agent of (result._agents as string[]) || []) {
            if (agent) agentCounts[agent] = (agentCounts[agent] || 0) + 1;
          }
          const topAgents = Object.entries(agentCounts)
            .sort((firstItem, secondItem) => secondItem[1] - firstItem[1])
            .slice(0, 5)
            .map(([agent, count]) => ({ agent, count }));

          return {
            tool: result._id,
            totalCalls: result.totalCalls,
            totalRequests: result.totalRequests,
            totalCost: result.totalCost,
            totalInputTokens: result.totalInputTokens,
            totalOutputTokens: result.totalOutputTokens,
            avgLatency: result.avgLatency,
            firstUsed: result.firstUsed,
            lastUsed: result.lastUsed,
            providers: (result._providers as string[])?.filter(Boolean) || [],
            topModels,
            topAgents,
            successCount: result.successCount,
            failureCount: result.failureCount,
          };
        });
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/tools error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/endpoints — per-endpoint breakdown ────
router.get(
  "/endpoints",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/endpoints", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);

        const pipeline: Record<string, unknown>[] = [
          ...(Object.keys(match).length ? [{ $match: match }] : []),
          {
            $group: {
              _id: "$endpoint",
              totalRequests: { $sum: 1 },
              totalTokens: TOTAL_TOKENS_EXPRESSION,
              totalCost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              successRate: {
                $avg: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
              },
            },
          },
          { $sort: { totalRequests: -1 } },
        ];

        const results = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(pipeline)
          .toArray();

        return results.map((result: Record<string, unknown>) => ({
          endpoint: result._id || "any",
          totalRequests: result.totalRequests,
          totalTokens: result.totalTokens,
          totalCost: result.totalCost,
          avgLatency: result.avgLatency,
          successRate: result.successRate,
        }));
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/endpoints error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/costs — comprehensive cost breakdown ──
router.get(
  "/costs",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/costs", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        const matchStage = Object.keys(match).length ? [{ $match: match }] : [];

        const groupFields = {
          totalCost: COST_SUMMATION_EXPRESSION,
          totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          totalRequests: { $sum: 1 },
          avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
        };

        const [result] = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate([
            ...matchStage,
            {
              $facet: {
                totals: [{ $group: { _id: null, ...groupFields } }],
                byProject: [
                  { $group: { _id: "$project", ...groupFields } },
                  { $sort: { totalCost: -1 } },
                ],
                byProvider: [
                  { $group: { _id: "$provider", ...groupFields } },
                  { $sort: { totalCost: -1 } },
                ],
                byModel: [
                  {
                    $group: {
                      _id: { model: "$model", provider: "$provider" },
                      ...groupFields,
                    },
                  },
                  { $sort: { totalCost: -1 } },
                ],
                byEndpoint: [
                  { $group: { _id: "$endpoint", ...groupFields } },
                  { $sort: { totalCost: -1 } },
                ],
                byProjectProvider: [
                  {
                    $group: {
                      _id: { project: "$project", provider: "$provider" },
                      ...groupFields,
                    },
                  },
                  { $sort: { totalCost: -1 } },
                ],
                byProjectEndpoint: [
                  {
                    $group: {
                      _id: { project: "$project", endpoint: "$endpoint" },
                      ...groupFields,
                    },
                  },
                  { $sort: { totalCost: -1 } },
                ],
                byProjectModel: [
                  {
                    $group: {
                      _id: {
                        project: "$project",
                        model: "$model",
                        provider: "$provider",
                      },
                      ...groupFields,
                    },
                  },
                  { $sort: { totalCost: -1 } },
                ],
              },
            },
          ])
          .toArray();

        const {
          totals,
          byProject,
          byProvider,
          byModel,
          byEndpoint,
          byProjectProvider,
          byProjectEndpoint,
          byProjectModel,
        } = result;

        const providersByProject: Record<string, Record<string, unknown>[]> = {};
        for (const row of byProjectProvider) {
          const proj = row._id.project || "any";
          if (!providersByProject[proj]) providersByProject[proj] = [];
          providersByProject[proj].push({
            provider: row._id.provider || "any",
            totalCost: row.totalCost,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalRequests: row.totalRequests,
            avgTokensPerSec: row.avgTokensPerSec,
          });
        }

        const endpointsByProject: Record<string, Record<string, unknown>[]> = {};
        for (const row of byProjectEndpoint) {
          const proj = row._id.project || "any";
          if (!endpointsByProject[proj]) endpointsByProject[proj] = [];
          endpointsByProject[proj].push({
            endpoint: row._id.endpoint || "any",
            totalCost: row.totalCost,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalRequests: row.totalRequests,
            avgTokensPerSec: row.avgTokensPerSec,
          });
        }

        const modelsByProject: Record<string, Record<string, unknown>[]> = {};
        for (const row of byProjectModel) {
          const proj = row._id.project || "any";
          if (!modelsByProject[proj]) modelsByProject[proj] = [];
          modelsByProject[proj].push({
            model: row._id.model || "any",
            provider: row._id.provider || "any",
            totalCost: row.totalCost,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalRequests: row.totalRequests,
            avgTokensPerSec: row.avgTokensPerSec,
          });
        }

        return {
          totals: totals[0]
            ? {
                totalCost: totals[0].totalCost,
                totalInputTokens: totals[0].totalInputTokens,
                totalOutputTokens: totals[0].totalOutputTokens,
                totalRequests: totals[0].totalRequests,
                avgTokensPerSec: totals[0].avgTokensPerSec,
              }
            : null,
          projects: byProject.map((row: Record<string, any>) => {
            const proj = row._id || "any";
            return {
              project: proj,
              totalCost: row.totalCost,
              totalInputTokens: row.totalInputTokens,
              totalOutputTokens: row.totalOutputTokens,
              totalRequests: row.totalRequests,
              avgTokensPerSec: row.avgTokensPerSec,
              providers: providersByProject[proj] || [],
              endpoints: endpointsByProject[proj] || [],
              models: modelsByProject[proj] || [],
            };
          }),
          providers: byProvider.map((row: Record<string, any>) => ({
            provider: row._id || "any",
            totalCost: row.totalCost,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalRequests: row.totalRequests,
            avgTokensPerSec: row.avgTokensPerSec,
          })),
          models: byModel.map((row: Record<string, any>) => ({
            model: row._id.model || "any",
            provider: row._id.provider || "any",
            totalCost: row.totalCost,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalRequests: row.totalRequests,
            avgTokensPerSec: row.avgTokensPerSec,
          })),
          endpoints: byEndpoint.map((row: Record<string, any>) => ({
            endpoint: row._id || "any",
            totalCost: row.totalCost,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalRequests: row.totalRequests,
            avgTokensPerSec: row.avgTokensPerSec,
          })),
        };
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/costs error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/timeline — requests grouped by adaptive granularity ─
// Supports an optional `granularity` query param for user-selected resolution.
// Returns `validGranularities` and `defaultGranularity` so the frontend can
// render a resolution picker constrained to sane bounds per time span.
router.get(
  "/timeline",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/timeline", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const {
          hours = 24,
          from,
          to,
          granularity: requestedGranularity,
        } = req.query;

        let sinceDate: Date;
        let untilDate: Date | undefined;
        if (typeof from === "string") {
          sinceDate = new Date(from);
        } else {
          sinceDate = new Date(
            Date.now() - hoursToMilliseconds(parseInt(hours as string, 10)),
          );
        }
        if (typeof to === "string") {
          untilDate = new Date(to);
        }

        const spanMilliseconds =
          (untilDate ? untilDate.getTime() : Date.now()) - sinceDate.getTime();

        // ── Granularity tier definitions (ordered finest → coarsest) ──
        const TIER_KEYS = [
          "1s",
          "5s",
          "15s",
          "30s",
          "1min",
          "5min",
          "15min",
          "1hr",
          "4hr",
          "1day",
          "1week",
        ];
        const TIER_INDEX: Record<string, number> = {};
        TIER_KEYS.forEach((key, index) => {
          TIER_INDEX[key] = index;
        });

        const MINUTES_MILLISECONDS = 60_000;
        const HOURS_MILLISECONDS = 3_600_000;
        const DAYS_MILLISECONDS = 86_400_000;

        const SPAN_RULES = [
          {
            maxSpanMilliseconds: 2 * MINUTES_MILLISECONDS,
            defaultGranularity: "1s",
            minGranularity: "1s",
            maxGranularity: "15s",
          },
          {
            maxSpanMilliseconds: 10 * MINUTES_MILLISECONDS,
            defaultGranularity: "5s",
            minGranularity: "1s",
            maxGranularity: "1min",
          },
          {
            maxSpanMilliseconds: 30 * MINUTES_MILLISECONDS,
            defaultGranularity: "15s",
            minGranularity: "5s",
            maxGranularity: "5min",
          },
          {
            maxSpanMilliseconds: 1 * HOURS_MILLISECONDS,
            defaultGranularity: "30s",
            minGranularity: "15s",
            maxGranularity: "5min",
          },
          {
            maxSpanMilliseconds: 6 * HOURS_MILLISECONDS,
            defaultGranularity: "1min",
            minGranularity: "15s",
            maxGranularity: "15min",
          },
          {
            maxSpanMilliseconds: 1 * DAYS_MILLISECONDS,
            defaultGranularity: "5min",
            minGranularity: "1min",
            maxGranularity: "1hr",
          },
          {
            maxSpanMilliseconds: 3 * DAYS_MILLISECONDS,
            defaultGranularity: "15min",
            minGranularity: "5min",
            maxGranularity: "1day",
          },
          {
            maxSpanMilliseconds: 7 * DAYS_MILLISECONDS,
            defaultGranularity: "1day",
            minGranularity: "1hr",
            maxGranularity: "1day",
          },
          {
            maxSpanMilliseconds: 14 * DAYS_MILLISECONDS,
            defaultGranularity: "1day",
            minGranularity: "4hr",
            maxGranularity: "1day",
          },
          {
            maxSpanMilliseconds: 30 * DAYS_MILLISECONDS,
            defaultGranularity: "1day",
            minGranularity: "4hr",
            maxGranularity: "1week",
          },
          {
            maxSpanMilliseconds: 90 * DAYS_MILLISECONDS,
            defaultGranularity: "1day",
            minGranularity: "1day",
            maxGranularity: "1week",
          },
          {
            maxSpanMilliseconds: Infinity,
            defaultGranularity: "1week",
            minGranularity: "1day",
            maxGranularity: "1week",
          },
        ];

        const rule =
          SPAN_RULES.find((r) => spanMilliseconds <= r.maxSpanMilliseconds) ||
          SPAN_RULES[SPAN_RULES.length - 1];

        const defaultGranularity = rule.defaultGranularity;
        const validGranularities = TIER_KEYS.slice(
          TIER_INDEX[rule.minGranularity],
          TIER_INDEX[rule.maxGranularity] + 1,
        );

        let granularity = defaultGranularity;
        if (
          typeof requestedGranularity === "string" &&
          validGranularities.includes(requestedGranularity)
        ) {
          granularity = requestedGranularity;
        }

        // ── MongoDB $group _id expressions per granularity ──

        const floorSecondsExpr = (interval: number) => ({
          $concat: [
            {
              $dateToString: {
                format: "%Y-%m-%dT%H:%M:",
                date: { $toDate: "$createdAt" },
                timezone: "UTC",
              },
            },
            {
              $cond: [
                {
                  $lt: [
                    {
                      $multiply: [
                        {
                          $floor: {
                            $divide: [
                              { $second: { $toDate: "$createdAt" } },
                              interval,
                            ],
                          },
                        },
                        interval,
                      ],
                    },
                    10,
                  ],
                },
                {
                  $concat: [
                    "0",
                    {
                      $toString: {
                        $multiply: [
                          {
                            $floor: {
                              $divide: [
                                { $second: { $toDate: "$createdAt" } },
                                interval,
                              ],
                            },
                          },
                          interval,
                        ],
                      },
                    },
                  ],
                },
                {
                  $toString: {
                    $multiply: [
                      {
                        $floor: {
                          $divide: [
                            { $second: { $toDate: "$createdAt" } },
                            interval,
                          ],
                        },
                      },
                      interval,
                    ],
                  },
                },
              ],
            },
          ],
        });

        const floorMinutesExpr = (interval: number) => ({
          $concat: [
            {
              $dateToString: {
                format: "%Y-%m-%dT%H:",
                date: { $toDate: "$createdAt" },
                timezone: "UTC",
              },
            },
            {
              $cond: [
                {
                  $lt: [
                    {
                      $multiply: [
                        {
                          $floor: {
                            $divide: [
                              { $minute: { $toDate: "$createdAt" } },
                              interval,
                            ],
                          },
                        },
                        interval,
                      ],
                    },
                    10,
                  ],
                },
                {
                  $concat: [
                    "0",
                    {
                      $toString: {
                        $multiply: [
                          {
                            $floor: {
                              $divide: [
                                { $minute: { $toDate: "$createdAt" } },
                                interval,
                              ],
                            },
                          },
                          interval,
                        ],
                      },
                    },
                  ],
                },
                {
                  $toString: {
                    $multiply: [
                      {
                        $floor: {
                          $divide: [
                            { $minute: { $toDate: "$createdAt" } },
                            interval,
                          ],
                        },
                      },
                      interval,
                    ],
                  },
                },
              ],
            },
          ],
        });

        const floorHoursExpr = (interval: number) => ({
          $concat: [
            {
              $dateToString: {
                format: "%Y-%m-%dT",
                date: { $toDate: "$createdAt" },
                timezone: "UTC",
              },
            },
            {
              $cond: [
                {
                  $lt: [
                    {
                      $multiply: [
                        {
                          $floor: {
                            $divide: [
                              { $hour: { $toDate: "$createdAt" } },
                              interval,
                            ],
                          },
                        },
                        interval,
                      ],
                    },
                    10,
                  ],
                },
                {
                  $concat: [
                    "0",
                    {
                      $toString: {
                        $multiply: [
                          {
                            $floor: {
                              $divide: [
                                { $hour: { $toDate: "$createdAt" } },
                                interval,
                              ],
                            },
                          },
                          interval,
                        ],
                      },
                    },
                  ],
                },
                {
                  $toString: {
                    $multiply: [
                      {
                        $floor: {
                          $divide: [
                            { $hour: { $toDate: "$createdAt" } },
                            interval,
                          ],
                        },
                      },
                      interval,
                    ],
                  },
                },
              ],
            },
          ],
        });

        // ISO week start (Monday) expression
        const weekStartExpr = {
          $dateToString: {
            format: "%Y-%m-%d",
            date: {
              $dateSubtract: {
                startDate: { $toDate: "$createdAt" },
                unit: "day",
                amount: {
                  $mod: [
                    {
                      $add: [
                        {
                          $subtract: [
                            { $dayOfWeek: { $toDate: "$createdAt" } },
                            2,
                          ],
                        },
                        7,
                      ],
                    },
                    7,
                  ],
                },
              },
            },
            timezone: "UTC",
          },
        };

        let groupId: Record<string, unknown> | string;
        switch (granularity) {
          case "1s":
            groupId = {
              $dateToString: {
                format: "%Y-%m-%dT%H:%M:%S",
                date: { $toDate: "$createdAt" },
                timezone: "UTC",
              },
            };
            break;
          case "5s":
            groupId = floorSecondsExpr(5);
            break;
          case "15s":
            groupId = floorSecondsExpr(15);
            break;
          case "30s":
            groupId = floorSecondsExpr(30);
            break;
          case "1min":
            groupId = {
              $dateToString: {
                format: "%Y-%m-%dT%H:%M",
                date: { $toDate: "$createdAt" },
                timezone: "UTC",
              },
            };
            break;
          case "5min":
            groupId = floorMinutesExpr(5);
            break;
          case "15min":
            groupId = floorMinutesExpr(15);
            break;
          case "1hr":
            groupId = { $substr: ["$createdAt", 0, 13] };
            break;
          case "4hr":
            groupId = floorHoursExpr(4);
            break;
          case "1day":
            groupId = { $substr: ["$createdAt", 0, 10] };
            break;
          case "1week":
            groupId = weekStartExpr;
            break;
          default:
            groupId = { $substr: ["$createdAt", 0, 10] };
        }

        const timeMatch: Record<string, string> = {
          $gte: sinceDate.toISOString(),
        };
        if (untilDate) timeMatch.$lte = untilDate!.toISOString();

        const matchFilter = await buildMatchFilter(req);
        matchFilter.createdAt = timeMatch;

        const timelinePipeline: Record<string, unknown>[] = [
          { $match: matchFilter },
          {
            $group: {
              _id: groupId,
              requests: { $sum: 1 },
              tokens: {
                $sum: {
                  $add: [
                    { $ifNull: ["$inputTokens", 0] },
                    { $ifNull: ["$outputTokens", 0] },
                  ],
                },
              },
              cost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", null] } },
              successes: {
                $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ];

        const results = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(timelinePipeline)
          .toArray();

        // ── Gap Filling Logic ─────────────────────────────────
        // We iterate from sinceDate to untilDate based on granularity
        // and fill missing buckets with zeroed data.

        const getStepMs = (g: string): number => {
          switch (g) {
            case "1s": return 1000;
            case "5s": return 5000;
            case "15s": return 15000;
            case "30s": return 30000;
            case "1min": return 60000;
            case "5min": return 300000;
            case "15min": return 900000;
            case "1hr": return 3600000;
            case "4hr": return 14400000;
            case "1day": return 86400000;
            case "1week": return 604800000;
            default: return 86400000;
          }
        };

        const getBucketIdFromDate = (date: Date, g: string): string => {
          const iso = date.toISOString();
          switch (g) {
            case "1s": return iso.slice(0, 19);
            case "5s":
            case "15s":
            case "30s": {
              const interval = parseInt(g.replace("s", ""), 10);
              const s = Math.floor(date.getUTCSeconds() / interval) * interval;
              return iso.slice(0, 17) + String(s).padStart(2, "0");
            }
            case "1min": return iso.slice(0, 16);
            case "5min":
            case "15min": {
              const interval = parseInt(g.replace("min", ""), 10);
              const m = Math.floor(date.getUTCMinutes() / interval) * interval;
              return iso.slice(0, 14) + String(m).padStart(2, "0");
            }
            case "1hr": return iso.slice(0, 13);
            case "4hr": {
              const h = Math.floor(date.getUTCHours() / 4) * 4;
              return iso.slice(0, 11) + String(h).padStart(2, "0");
            }
            case "1day": return iso.slice(0, 10);
            case "1week": {
              const day = date.getUTCDay();
              const diff = (day === 0 ? 6 : day - 1);
              const monday = new Date(date);
              monday.setUTCDate(date.getUTCDate() - diff);
              return monday.toISOString().slice(0, 10);
            }
            default: return iso.slice(0, 10);
          }
        };

        const resultsMap = new Map(results.map((r) => [r._id, r]));
        const filledData = [];
        const stepMs = getStepMs(granularity);

        // Align sinceDate to bucket start to avoid missing the first bucket
        const alignedSince = new Date(sinceDate);
        alignedSince.setUTCMilliseconds(0);
        if (stepMs >= 1000) alignedSince.setUTCSeconds(0);
        if (stepMs >= 60000) alignedSince.setUTCMinutes(0);
        // For hourly or larger granularities, floor to the hour (but NOT to UTC midnight unless it's a day-long bin)
        if (stepMs >= 3600000 && stepMs < 86400000) {
          // If it's a 4hr bin, floor to nearest 4 hours of the day
          const hourInterval = stepMs / 3600000;
          alignedSince.setUTCHours(Math.floor(alignedSince.getUTCHours() / hourInterval) * hourInterval);
        } else if (stepMs >= 86400000) {
          // Daily or weekly, floor to midnight
          alignedSince.setUTCHours(0);
        }

        // Re-calculate alignment based on granularity specifically
        const startId = getBucketIdFromDate(alignedSince, granularity);
        let cursor = new Date(alignedSince);
        // Ensure the cursor starts exactly at the bucket start for sub-hourly granularities
        if (granularity.endsWith("s")) {
          const interval = parseInt(granularity.replace("s", ""), 10);
          cursor.setUTCSeconds(Math.floor(cursor.getUTCSeconds() / interval) * interval);
        } else if (granularity.endsWith("min")) {
          const interval = parseInt(granularity.replace("min", ""), 10);
          cursor.setUTCMinutes(Math.floor(cursor.getUTCMinutes() / interval) * interval);
        } else if (granularity === "4hr") {
          cursor.setUTCHours(Math.floor(cursor.getUTCHours() / 4) * 4);
        } else if (granularity === "1week") {
          const day = cursor.getUTCDay();
          const diff = (day === 0 ? 6 : day - 1);
          cursor.setUTCDate(cursor.getUTCDate() - diff);
        }

        const endLimitDate = untilDate || new Date();
        const endId = getBucketIdFromDate(endLimitDate, granularity);

        // Safety break to prevent infinite loops or huge payloads (max 1000 points)
        let iterations = 0;
        const MAX_ITERATIONS = 1000;

        while (iterations < MAX_ITERATIONS) {
          const bucketId = getBucketIdFromDate(cursor, granularity);
          const result = resultsMap.get(bucketId);

          filledData.push({
            hour: bucketId,
            requests: result ? result.requests : 0,
            tokens: result ? result.tokens : 0,
            cost: result ? result.cost : 0,
            avgLatency: result && result.avgLatency ? Math.round(result.avgLatency as number) : 0,
            successRate: result && result.requests > 0
              ? Math.round(((result.successes as number) / (result.requests as number)) * 100)
              : 100,
          });

          if (bucketId === endId) break;
          cursor.setTime(cursor.getTime() + stepMs);
          iterations++;
        }

        return {
          granularity,
          defaultGranularity,
          validGranularities,
          data: filledData,
        };
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/timeline error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/agents — per-agent breakdown ──────────
router.get(
  "/agents",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/agents", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        match.agent = { $exists: true, $ne: null };

        const pipeline: Record<string, unknown>[] = [
          { $match: match },
          {
            $group: {
              _id: "$agent",
              totalRequests: { $sum: 1 },
              totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
              totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
              totalTokens: TOTAL_TOKENS_EXPRESSION,
              totalCost: COST_SUMMATION_EXPRESSION,
              avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
              avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
              _models: { $addToSet: "$model" },
              _providers: { $addToSet: "$provider" },
              _convIds: { $addToSet: "$conversationId" },
              _traceIds: { $addToSet: "$traceId" },
              lastRequest: { $max: "$createdAt" },
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

        const results = await req.db
          .collection(REQUESTS_COLLECTION)
          .aggregate(pipeline)
          .toArray();

        return results.map((result: Record<string, unknown>) => {
          const agentId = (result._id as string) || "";
          const persona = AgentPersonaRegistry.get(agentId);
          const models = ((result._models || []) as string[]).filter(Boolean);
          const providers = ((result._providers || []) as string[]).filter(Boolean);
          const conversationIds = ((result._convIds || []) as string[]).filter(
            Boolean,
          );
          const traceIds = ((result._traceIds || []) as string[]).filter(Boolean);

          return {
            agent: agentId,
            name: persona?.name || agentId,
            type: persona?.type || "",
            custom: persona?.custom || false,
            totalRequests: result.totalRequests,
            totalInputTokens: result.totalInputTokens,
            totalOutputTokens: result.totalOutputTokens,
            totalTokens: result.totalTokens,
            totalCost: result.totalCost,
            avgLatency: result.avgLatency,
            avgTokensPerSec: result.avgTokensPerSec,
            modelCount: models.length,
            models,
            providerCount: providers.length,
            providers,
            conversationCount: conversationIds.length,
            sessionCount: traceIds.length,
            lastRequest: result.lastRequest,
            successCount: result.successCount,
            errorCount: result.errorCount,
          };
        });
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/agents error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Db } from "mongodb";
import {
  COLLECTIONS,
  COST_SUMMATION_EXPRESSION,
  TOTAL_TOKENS_EXPRESSION,
  AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
} from "#src/constants";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  applyDateRangeFilter,
} from "#src/utils/QueryBuilders";
import requireDb from "#src/middleware/RequireDbMiddleware";
import { hours as hoursToMilliseconds } from "@rodrigo-barraza/utilities-library";
import { StatsCache } from "#src/caches/StatsCache";
import {
  computeCacheStats,
  DEFAULT_MAX_GAP_SECONDS,
  type CacheStatsRow,
} from "#src/services/PromptCacheStats";
import {
  aggregateRequestStats,
  aggregateWithIndex,
  isCoveredMatch,
} from "#src/services/RequestStatsIndex";
import {
  agentsFacet,
  matchStages,
  modelsFacet,
  projectsFacet,
  providersFacet,
  toAgentRows,
  toModelRow,
  toProjectRow,
  toProviderRow,
  totalsFacet,
  toTotals,
  traceCountFacet,
} from "#src/services/RequestStatsFacets";
import {
  buildTimeline,
  resolveGranularity,
  resolveTimeZone,
  timelineGroupStage,
  type TimelineBaseBucket,
} from "#src/services/StatsTimeline";

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

/** `a` → "a", `a,b` → `{ $in: ["a", "b"] }`, empty → undefined. */
function listFilter(value: unknown): string | { $in: string[] } | undefined {
  if (!value) return undefined;
  const values = String(value).split(",").filter(Boolean);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : { $in: values };
}

async function buildMatchFilter(
  req: Request,
): Promise<TransformedStatsMatchFilter> {
  const { from, to, project, agent, provider, model, workspace } = req.query;
  const match: TransformedStatsMatchFilter = {};

  if (project) {
    match.project = project;
  }
  const agentFilter = listFilter(agent);
  if (agentFilter) match.agent = agentFilter;
  const providerFilter = listFilter(provider);
  if (providerFilter) match.provider = providerFilter;
  const modelFilter = listFilter(model);
  if (modelFilter) match.model = modelFilter;

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

/**
 * The conversation-side filter for the same query. Dated by `updatedAt`, as
 * the Chat page is: a conversation counts for a range it was active in.
 */
function buildConversationMatch(query: Request["query"]): Record<string, unknown> {
  const { from, to, project, provider, model, workspace } = query;
  const match: Record<string, unknown> = {};
  if (project) match.project = project;
  if (workspace) match.workspaceRoot = workspace;
  const providerFilter = listFilter(provider);
  if (providerFilter) match.providers = providerFilter;
  const modelFilter = listFilter(model);
  if (modelFilter) match["messages.model"] = modelFilter;
  applyDateRangeFilter(match, from as string, to as string, "updatedAt");
  return match;
}

/** Answers a project/updatedAt-only conversation filter from index keys. */
const CONVERSATION_PROJECT_INDEX = {
  name: "project_1_username_1_profileId_1_updatedAt_-1",
  leadingField: "project",
};

function isCoveredConversationMatch(match: Record<string, unknown>): boolean {
  return Object.keys(match).every((field) => field === "project" || field === "updatedAt");
}

/** Conversations per project (`"any"` for none) under the conversation filter. */
async function conversationCountsByProject(
  db: Db,
  match: Record<string, unknown>,
): Promise<Record<string, number>> {
  const rows = await aggregateWithIndex(
    db,
    CONVERSATIONS_COLLECTION,
    CONVERSATION_PROJECT_INDEX,
    [...matchStages(match), { $group: { _id: "$project", conversationCount: { $sum: 1 } } }],
    { covered: isCoveredConversationMatch(match) },
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const project = (row._id as string) || "any";
    counts[project] = (counts[project] || 0) + (row.conversationCount as number);
  }
  return counts;
}

function countConversations(db: Db, match: Record<string, unknown>): Promise<number> {
  const conversations = db.collection(CONVERSATIONS_COLLECTION);
  return Object.keys(match).length === 0
    ? conversations.estimatedDocumentCount()
    : conversations.countDocuments(match);
}

/** Workflows per project, through the conversations each workflow ran in. */
async function workflowCountsByProject(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .collection(WORKFLOWS_COLLECTION)
    .aggregate([
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
      { $group: { _id: "$_convs.project", workflowIds: { $addToSet: "$_id" } } },
      { $project: { _id: 1, workflowCount: { $size: "$workflowIds" } } },
    ])
    .toArray();
  const counts: Record<string, number> = {};
  for (const row of rows) counts[(row._id as string) || "any"] = row.workflowCount;
  return counts;
}

function registryCounts() {
  return {
    agentCount: AgentPersonaRegistry.list().length,
    workspaceCount: ToolOrchestratorService.getWorkspaceRoots().length,
  };
}

// ─── GET /stats — aggregate stats ─────────────────────
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        const [[facets], conversationCount] = await Promise.all([
          aggregateRequestStats(
            req.db,
            [...matchStages(match), { $facet: { totals: totalsFacet, traceCount: traceCountFacet } }],
            { covered: isCoveredMatch(match) },
          ),
          countConversations(req.db, buildConversationMatch(req.query)),
        ]);
        return {
          ...toTotals(facets.totals, facets.traceCount),
          conversationCount,
          ...registryCounts(),
        };
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/dashboard — everything the admin dashboard shows ──
// Totals, projects, providers, models and agents in ONE `$facet` over the
// covering index: one scan of `requests`, where the separate endpoints
// scanned it five times.
router.get(
  "/dashboard",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/dashboard", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        const [[facets], conversations, workflows] = await Promise.all([
          aggregateRequestStats(
            req.db,
            [
              ...matchStages(match),
              {
                $facet: {
                  totals: totalsFacet,
                  traceCount: traceCountFacet,
                  projects: projectsFacet,
                  providers: providersFacet,
                  models: modelsFacet,
                  agents: agentsFacet,
                },
              },
            ],
            { covered: isCoveredMatch(match) },
          ),
          conversationCountsByProject(req.db, buildConversationMatch(req.query)),
          workflowCountsByProject(req.db),
        ]);
        return {
          stats: {
            ...toTotals(facets.totals, facets.traceCount),
            conversationCount: Object.values(conversations).reduce(
              (sum, count) => sum + count,
              0,
            ),
            ...registryCounts(),
          },
          projects: facets.projects.map((row: Record<string, unknown>) =>
            toProjectRow(row, { conversations, workflows }),
          ),
          providers: facets.providers.map(toProviderRow),
          models: facets.models.map(toModelRow),
          agents: toAgentRows(facets.agents),
        };
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/dashboard error: ${getErrorMessage(error)}`);
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
        const [rows, conversations, workflows] = await Promise.all([
          aggregateRequestStats(req.db, [...matchStages(match), ...projectsFacet], {
            covered: isCoveredMatch(match),
          }),
          conversationCountsByProject(req.db, buildConversationMatch(req.query)),
          workflowCountsByProject(req.db),
        ]);
        return rows.map((row) => toProjectRow(row, { conversations, workflows }));
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
        const rows = await aggregateRequestStats(req.db, [...matchStages(match), ...modelsFacet], {
          covered: isCoveredMatch(match),
        });
        return rows.map(toModelRow);
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/tools — per-tool lifetime usage breakdown ─
// Cost and tokens are the calling model requests', shared among the tools
// each request asked for. Latency (ms) and error rate are the tools' own,
// from the `toolExecutions` agent iterations record; rows logged before
// those existed count as calls but are never timed.
router.get(
  "/tools",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/tools", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const baseMatch = await buildMatchFilter(req);
        const match = { ...baseMatch, toolApiNames: { $exists: true, $ne: [] } };
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

        const executionPipeline: Record<string, unknown>[] = [
          { $match: { ...baseMatch, "toolExecutions.0": { $exists: true } } },
          { $unwind: "$toolExecutions" },
          ...(tool ? [{ $match: { "toolExecutions.name": tool } }] : []),
          {
            $group: {
              _id: "$toolExecutions.name",
              timedCalls: { $sum: 1 },
              avgLatency: { $avg: "$toolExecutions.durationMilliseconds" },
              minLatency: { $min: "$toolExecutions.durationMilliseconds" },
              maxLatency: { $max: "$toolExecutions.durationMilliseconds" },
              errorCount: {
                $sum: { $cond: [{ $eq: ["$toolExecutions.success", false] }, 1, 0] },
              },
            },
          },
        ];

        const [results, executionResults] = await Promise.all([
          req.db.collection(REQUESTS_COLLECTION).aggregate(pipeline).toArray(),
          req.db
            .collection(REQUESTS_COLLECTION)
            .aggregate(executionPipeline)
            .toArray(),
        ]);
        const executionsByTool = new Map(
          executionResults.map((execution: Record<string, unknown>) => [
            execution._id as string,
            execution,
          ]),
        );

        return results.map((result: Record<string, unknown>) => {
          const execution = executionsByTool.get(result._id as string);
          const timedCalls = (execution?.timedCalls as number) || 0;
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
            timedCalls,
            avgLatency: timedCalls > 0 ? (execution!.avgLatency as number) : null,
            minLatency: timedCalls > 0 ? (execution!.minLatency as number) : null,
            maxLatency: timedCalls > 0 ? (execution!.maxLatency as number) : null,
            // Percent of timed calls that failed — tools-service's convention.
            errorRate:
              timedCalls > 0
                ? Math.round(((execution!.errorCount as number) / timedCalls) * 10000) / 100
                : null,
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
          ...matchStages(match),
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

        const results = await aggregateRequestStats(req.db, pipeline, {
          covered: isCoveredMatch(match),
        });

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

        const groupFields = {
          totalCost: COST_SUMMATION_EXPRESSION,
          totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          totalRequests: { $sum: 1 },
          // True per-request weighted average over raw docs — NOT a
          // request-weighted average of per-model averages (which is what the
          // client used to compute and is not arithmetically equivalent).
          avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
          avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
        };

        const [result] = await aggregateRequestStats(
          req.db,
          [
            ...matchStages(match),
            {
              $facet: {
                totals: [{ $group: { _id: null, ...groupFields } }],
                byProject: [
                  { $group: { _id: "$project", ...groupFields } },
                  { $sort: { totalCost: -1 } },
                ],
                // Also the dashboard's providers table (RequestStatsFacets).
                byProvider: providersFacet,
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
          ],
          { covered: isCoveredMatch(match) },
        );

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
                avgLatency: totals[0].avgLatency,
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
              avgLatency: row.avgLatency,
              avgTokensPerSec: row.avgTokensPerSec,
              providers: providersByProject[proj] || [],
              endpoints: endpointsByProject[proj] || [],
              models: modelsByProject[proj] || [],
            };
          }),
          providers: byProvider.map(toProviderRow),
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
// `hours` (default 24) or `from`/`to` set the span; `hours=all` starts at the
// first request the filters match. `granularity` picks a resolution from the
// returned `validGranularities`; `tz` (IANA) sets the calendar day and week
// buckets. Bucketing and gap-filling live in StatsTimeline.
router.get(
  "/timeline",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { hours, from, to, granularity: requestedGranularity, tz } = req.query;
      const since = typeof from === "string" && from ? new Date(from) : null;
      const until = typeof to === "string" && to ? new Date(to) : null;
      const hoursBack = hours === undefined ? 24 : Number(hours);
      if (
        (since && Number.isNaN(since.getTime())) ||
        (until && Number.isNaN(until.getTime())) ||
        (!since && hours !== "all" && !(hoursBack > 0))
      ) {
        res.status(400).json({ error: "Invalid timeline range" });
        return;
      }

      const cacheKey = StatsCache.buildCacheKey("/stats/timeline", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        delete match.createdAt;
        const covered = isCoveredMatch(match);
        const end = until ?? new Date();

        let start = since;
        if (!start && hours === "all") {
          const [first] = await aggregateRequestStats<{ createdAt: string }>(
            req.db,
            [
              // `$gt: ""` skips rows without a createdAt (null sorts first).
              { $match: { ...match, createdAt: { $gt: "" } } },
              { $sort: { createdAt: 1 } },
              { $limit: 1 },
              { $project: { _id: 0, createdAt: 1 } },
            ],
            { covered },
          );
          start = first ? new Date(first.createdAt) : null;
        }
        start ??= new Date(end.getTime() - hoursToMilliseconds(hours === "all" ? 24 : hoursBack));

        const { granularity, defaultGranularity, validGranularities } = resolveGranularity(
          end.getTime() - start.getTime(),
          requestedGranularity,
        );
        const timeZone = resolveTimeZone(tz);

        const createdAt: Record<string, string> = { $gte: start.toISOString() };
        if (until) createdAt.$lte = until.toISOString();
        const baseBuckets = await aggregateRequestStats<TimelineBaseBucket>(
          req.db,
          [{ $match: { ...match, createdAt } }, timelineGroupStage(granularity)],
          { covered },
        );

        return {
          granularity,
          defaultGranularity,
          validGranularities,
          timezone: timeZone,
          data: buildTimeline(baseBuckets, { granularity, since: start, until: end, timeZone }),
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
        const rows = await aggregateRequestStats(req.db, [...matchStages(match), ...agentsFacet], {
          covered: isCoveredMatch(match),
        });
        return toAgentRows(rows);
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/agents error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /stats/cache — prompt-cache effectiveness ────
// Agent iterations only (the rows that carry prefix hashes). Without
// from/to the window is the last 30 days. `maxGapSeconds` bounds which
// consecutive requests count as a pair (default 300 s — the shortest
// provider cache TTL).
const CACHE_STATS_DEFAULT_WINDOW_DAYS = 30;
const CACHE_STATS_MAX_ROWS = 200_000;

router.get(
  "/cache",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cacheKey = StatsCache.buildCacheKey("/stats/cache", req.query);
      const responseData = await StatsCache.getOrFetch(cacheKey, async () => {
        const match = await buildMatchFilter(req);
        if (!req.query.from && !req.query.to) {
          match.createdAt = {
            $gte: new Date(
              Date.now() - CACHE_STATS_DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000,
            ).toISOString(),
          } as unknown as { $gte: Date };
        }
        match.operation = "agent:iteration";
        match.status = "completed";
        const requestedGap = Number(req.query.maxGapSeconds);
        const maxGapSeconds =
          Number.isFinite(requestedGap) && requestedGap > 0
            ? requestedGap
            : DEFAULT_MAX_GAP_SECONDS;

        const rows = (await req.db
          .collection(REQUESTS_COLLECTION)
          .find(match, {
            projection: {
              _id: 0,
              requestId: 1,
              agentConversationId: 1,
              conversationId: 1,
              createdAt: 1,
              provider: 1,
              model: 1,
              agenticIteration: 1,
              inputTokens: 1,
              cacheReadInputTokens: 1,
              cacheCreationInputTokens: 1,
              estimatedCost: 1,
              "cacheTelemetry.prefixChange": 1,
              "cacheTelemetry.declaredBoundary": 1,
              "cacheTelemetry.providerDiagnostics.source": 1,
              "cacheTelemetry.providerDiagnostics.status": 1,
              "cacheTelemetry.providerDiagnostics.reason": 1,
            },
          })
          .sort({ createdAt: 1 })
          .limit(CACHE_STATS_MAX_ROWS)
          .toArray()) as unknown as CacheStatsRow[];

        return {
          window: {
            from: (match.createdAt as { $gte?: unknown })?.$gte ?? null,
            to: (match.createdAt as { $lte?: unknown })?.$lte ?? null,
          },
          ...computeCacheStats(rows, { maxGapSeconds }),
        };
      });

      res.json(responseData);
    } catch (error: unknown) {
      logger.error(`Admin /stats/cache error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

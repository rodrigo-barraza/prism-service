/**
 * RequestStatsFacets — the `requests` breakdowns behind the admin stats
 * routes, written once so `/admin/stats/dashboard` can run them all as one
 * `$facet` (one covered scan) while `/stats`, `/stats/projects`,
 * `/stats/models`, `/stats/agents` and `/stats/costs` keep serving the same
 * rows on their own.
 *
 * Every field read here is in the covering index (RequestStatsIndex): add a
 * field to a pipeline and it must be added to REQUEST_STATS_INDEX_KEYS too,
 * or the hinted query fetches every row. Distinct-id sets are reduced to
 * counts inside Mongo, so id arrays never leave the database.
 */
import type { Document } from "mongodb";
import {
  COST_SUMMATION_EXPRESSION,
  TOTAL_TOKENS_EXPRESSION,
  AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
} from "#src/constants";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";

type Row = Record<string, any>;

/** `$size` of an `$addToSet` result, not counting the `null` of rows without the field. */
function distinctCount(setField: string) {
  return { $size: { $setDifference: [setField, [null]] } };
}

function distinctValues(setField: string) {
  return { $setDifference: [setField, [null]] };
}

/** `$addToSet` order is arbitrary; sorted, a row reads the same every time. */
function sortedValues(values: unknown): string[] {
  return ((values || []) as string[]).filter(Boolean).sort();
}

const USAGE_ACCUMULATORS = {
  totalRequests: { $sum: 1 },
  totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
  totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
  totalCost: COST_SUMMATION_EXPRESSION,
  // A true per-request average over the raw rows — not an average of
  // per-model averages, which is not arithmetically the same thing.
  avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
  avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION,
};

const SUCCESS_ACCUMULATORS = {
  successCount: { $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] } },
  errorCount: { $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] } },
};

// ── Totals (GET /stats) ─────────────────────────────────────

export const totalsFacet: Document[] = [
  {
    $group: {
      _id: null,
      ...USAGE_ACCUMULATORS,
      totalDuration: { $sum: { $ifNull: ["$totalTime", 0] } },
      ...SUCCESS_ACCUMULATORS,
      totalToolCalls: { $sum: { $ifNull: ["$toolApiNameCount", 0] } },
    },
  },
];

/**
 * "Not null" is tested on the GROUP key, after the scan: a `{ $ne: null }` in
 * the query makes Mongo 7 FETCH every row, covering index or not. Only ever
 * run inside a `$facet` — outside one, the optimizer moves a `$match` on a
 * group key back in front of the `$group`, into the query.
 */
export const traceCountFacet: Document[] = [
  { $group: { _id: "$traceId" } },
  { $match: { _id: { $ne: null } } },
  { $count: "total" },
];

export interface RequestTotals {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgLatency: number;
  avgTokensPerSec: number;
  totalDuration: number;
  successCount: number;
  errorCount: number;
  totalToolCalls: number;
  traceCount: number;
}

export function toTotals(
  totalsRows: Row[] | undefined,
  traceCountRows: Row[] | undefined,
): RequestTotals {
  const totals = { ...totalsRows?.[0] };
  delete totals._id;
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
    totalToolCalls: 0,
    ...totals,
    traceCount: traceCountRows?.[0]?.total || 0,
  };
}

// ── Projects (GET /stats/projects) ──────────────────────────

export const projectsFacet: Document[] = [
  {
    $group: {
      _id: "$project",
      ...USAGE_ACCUMULATORS,
      totalTokens: TOTAL_TOKENS_EXPRESSION,
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
      models: distinctValues("$_models"),
      providers: distinctValues("$_providers"),
      traceCount: distinctCount("$_traceIds"),
    },
  },
  { $sort: { totalRequests: -1, _id: 1 } },
];

/** Per-project counts that live outside `requests` (conversations, workflows). */
export interface ProjectSideCounts {
  conversations: Record<string, number>;
  workflows: Record<string, number>;
}

export function toProjectRow(row: Row, sideCounts: ProjectSideCounts) {
  const project = row._id || "any";
  const models = sortedValues(row.models);
  const providers = sortedValues(row.providers);
  return {
    project,
    totalRequests: row.totalRequests,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalTokens: row.totalTokens,
    totalCost: row.totalCost,
    avgLatency: row.avgLatency,
    avgTokensPerSec: row.avgTokensPerSec,
    lastRequest: row.lastRequest,
    modelCount: models.length,
    providerCount: providers.length,
    models,
    providers,
    workflowCount: sideCounts.workflows[project] || 0,
    conversationCount: sideCounts.conversations[project] || 0,
    traceCount: row.traceCount || 0,
  };
}

// ── Models (GET /stats/models) ──────────────────────────────

export const modelsFacet: Document[] = [
  {
    $group: {
      _id: { model: "$model", provider: "$provider" },
      ...USAGE_ACCUMULATORS,
      totalTokens: TOTAL_TOKENS_EXPRESSION,
      toolsUsed: { $max: { $gt: [{ $ifNull: ["$toolApiNameCount", 0] }, 0] } },
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
      conversationCount: distinctCount("$_conversationIds"),
      traceCount: distinctCount("$_traceIds"),
    },
  },
  { $sort: { totalRequests: -1, "_id.provider": 1, "_id.model": 1 } },
];

export function toModelRow(row: Row) {
  return {
    model: row._id.model,
    provider: row._id.provider,
    totalRequests: row.totalRequests,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalTokens: row.totalTokens,
    totalCost: row.totalCost,
    avgLatency: row.avgLatency,
    avgTokensPerSec: row.avgTokensPerSec,
    toolsUsed: row.toolsUsed || false,
    conversationCount: row.conversationCount || 0,
    workflowCount: 0,
    traceCount: row.traceCount || 0,
  };
}

// ── Agents (GET /stats/agents) ──────────────────────────────

/** Composes with the caller's filter: an `agent` filter narrows, never widens. */
export const agentsFacet: Document[] = [
  {
    $group: {
      _id: "$agent",
      ...USAGE_ACCUMULATORS,
      totalTokens: TOTAL_TOKENS_EXPRESSION,
      ...SUCCESS_ACCUMULATORS,
      lastRequest: { $max: "$createdAt" },
      _models: { $addToSet: "$model" },
      _providers: { $addToSet: "$provider" },
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
      successCount: 1,
      errorCount: 1,
      lastRequest: 1,
      models: distinctValues("$_models"),
      providers: distinctValues("$_providers"),
      conversationCount: distinctCount("$_conversationIds"),
      traceCount: distinctCount("$_traceIds"),
    },
  },
  { $sort: { totalRequests: -1, _id: 1 } },
];

/**
 * Agent rows, without the group of rows that ran with no agent. That group is
 * dropped here rather than by a `{ agent: { $ne: null } }` in the query,
 * which would make Mongo FETCH every row (see traceCountFacet).
 */
export function toAgentRows(rows: Row[]) {
  return rows.filter((row) => row._id != null).map(toAgentRow);
}

function toAgentRow(row: Row) {
  const agentId = (row._id as string) || "";
  const persona = AgentPersonaRegistry.get(agentId);
  const models = sortedValues(row.models);
  const providers = sortedValues(row.providers);
  return {
    agent: agentId,
    name: persona?.name || agentId,
    type: persona?.type || "",
    custom: persona?.custom || false,
    totalRequests: row.totalRequests,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalTokens: row.totalTokens,
    totalCost: row.totalCost,
    avgLatency: row.avgLatency,
    avgTokensPerSec: row.avgTokensPerSec,
    modelCount: models.length,
    models,
    providerCount: providers.length,
    providers,
    conversationCount: row.conversationCount || 0,
    traceCount: row.traceCount || 0,
    lastRequest: row.lastRequest,
    successCount: row.successCount,
    errorCount: row.errorCount,
  };
}

// ── Providers (GET /stats/costs `providers`) ────────────────

export const providersFacet: Document[] = [
  {
    $group: {
      _id: "$provider",
      ...USAGE_ACCUMULATORS,
      _models: { $addToSet: "$model" },
      _conversationIds: { $addToSet: "$conversationId" },
      _traceIds: { $addToSet: "$traceId" },
    },
  },
  {
    $project: {
      totalRequests: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalCost: 1,
      avgLatency: 1,
      avgTokensPerSec: 1,
      models: distinctValues("$_models"),
      conversationCount: distinctCount("$_conversationIds"),
      traceCount: distinctCount("$_traceIds"),
    },
  },
  { $sort: { totalCost: -1, _id: 1 } },
];

export function toProviderRow(row: Row) {
  const models = sortedValues(row.models);
  return {
    provider: row._id || "any",
    totalCost: row.totalCost,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalRequests: row.totalRequests,
    avgLatency: row.avgLatency,
    avgTokensPerSec: row.avgTokensPerSec,
    modelCount: models.length,
    models,
    conversationCount: row.conversationCount || 0,
    traceCount: row.traceCount || 0,
  };
}

/** `[{ $match }]` when the filter has anything in it, else nothing. */
export function matchStages(match: Record<string, unknown>): Document[] {
  return Object.keys(match).length ? [{ $match: match }] : [];
}

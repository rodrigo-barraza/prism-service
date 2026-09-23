/**
 * RequestStatsIndex — the covering index behind the admin dashboard.
 *
 * A `requests` row averages ~17 KB (it carries the request and response
 * payloads), and a stats aggregation without a selective `$match` reads every
 * row of the collection. Measured on prod (147K rows, 2.5 GB, 2026-09-23):
 * an all-time `/stats/costs` took 57 s, `/stats`, `/stats/projects` and
 * `/stats/models` ~15 s each. Every field the dashboard groups, sums or
 * filters on is in this one index, so a hinted aggregation reads index keys
 * only (PROJECTION_COVERED, no FETCH), a few MB instead of the collection.
 *
 * Two things keep it coverable:
 * - `toolApiNames` is an array, and a multikey index covers nothing, so the
 *   index carries the scalar `toolApiNameCount` instead. RequestLogger writes
 *   it with every row; `prepareRequestStatsIndex` backfills older rows once.
 * - A covered scan cannot tell a missing field from `null`. Every stats
 *   expression reads fields through `$ifNull` or drops `null`s, so the two
 *   read alike.
 */
import { MinKey, type Db, type Document, type AggregateOptions } from "mongodb";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

export const REQUEST_STATS_INDEX_NAME = "requests_stats_covering";

/** Leading `createdAt` serves the date-range scans; the rest is covered payload. */
export const REQUEST_STATS_INDEX_KEYS = {
  createdAt: -1,
  project: 1,
  provider: 1,
  model: 1,
  agent: 1,
  endpoint: 1,
  success: 1,
  estimatedCost: 1,
  inputTokens: 1,
  outputTokens: 1,
  totalTime: 1,
  tokensPerSec: 1,
  toolApiNameCount: 1,
  traceId: 1,
  conversationId: 1,
  agentConversationId: 1,
  parentAgentConversationId: 1,
} as const;

const COVERED_FIELDS = new Set<string>(Object.keys(REQUEST_STATS_INDEX_KEYS));

/**
 * Whether a `$match` filter can be answered from the index keys. An `$or`
 * (the workspace filter) or any field outside the index makes the planner
 * FETCH, and a hinted full-index scan that fetches every row is slower than
 * the collection scan it replaces.
 */
export function isCoveredMatch(match: Record<string, unknown>): boolean {
  return Object.keys(match).every((field) => COVERED_FIELDS.has(field));
}

/** A hint to an index that is missing or still building fails the query. */
const HINT_RETRY_MILLISECONDS = 60_000;
const hintUnavailableUntil = new Map<string, number>();

function isMissingHintIndex(error: unknown): boolean {
  return /hint provided does not correspond to an existing index/i.test(
    getErrorMessage(error),
  );
}

/** An index a stats query is hinted to, and the first field of its key. */
export interface CoveringIndex {
  name: string;
  leadingField: string;
}

export const REQUEST_STATS_INDEX: CoveringIndex = {
  name: REQUEST_STATS_INDEX_NAME,
  leadingField: "createdAt",
};

/**
 * The pipeline as a hinted index answers it. Without a predicate on the
 * index's LEADING field, Mongo applies a filter on a later key
 * (`agent: "CODING"` all time, `updatedAt` on a project-first index) on
 * FETCH instead of the index keys. A `>= MinKey` range on the leading field —
 * every row, one missing the field included — lets it bound the later keys
 * and stay covered.
 */
export function anchorToIndex(pipeline: Document[], leadingField: string): Document[] {
  const anchor = { [leadingField]: { $gte: new MinKey() } };
  const [first, ...rest] = pipeline;
  if (!first?.$match) return [{ $match: anchor }, ...pipeline];
  if (leadingField in first.$match) return pipeline;
  return [{ $match: { ...anchor, ...first.$match } }, ...rest];
}

/**
 * Run an aggregation hinted to a covering index, falling back to an unhinted
 * run while the index is missing or still building — the hint is retried a
 * minute later. `covered: false` (a filter the index cannot answer) skips the
 * hint and the anchor.
 */
export async function aggregateWithIndex<T extends Document = Document>(
  db: Db,
  collectionName: string,
  index: CoveringIndex,
  pipeline: Document[],
  { covered = true, ...options }: AggregateOptions & { covered?: boolean } = {},
): Promise<T[]> {
  const collection = db.collection(collectionName);
  if (!covered || Date.now() < (hintUnavailableUntil.get(index.name) ?? 0)) {
    return collection.aggregate<T>(pipeline, options).toArray();
  }
  try {
    return await collection
      .aggregate<T>(anchorToIndex(pipeline, index.leadingField), {
        ...options,
        hint: index.name,
      })
      .toArray();
  } catch (error: unknown) {
    if (!isMissingHintIndex(error)) throw error;
    hintUnavailableUntil.set(index.name, Date.now() + HINT_RETRY_MILLISECONDS);
    logger.warn(`${collectionName}: index ${index.name} not available yet — running unhinted`);
    return collection.aggregate<T>(pipeline, options).toArray();
  }
}

/** A stats aggregation over `requests` through the covering index. */
export function aggregateRequestStats<T extends Document = Document>(
  db: Db,
  pipeline: Document[],
  options: AggregateOptions & { covered?: boolean } = {},
): Promise<T[]> {
  return aggregateWithIndex<T>(db, COLLECTIONS.REQUESTS, REQUEST_STATS_INDEX, pipeline, options);
}

const TOOL_API_NAME_COUNT_MIGRATION = "requests.toolApiNameCount";

/**
 * One-time backfill of `toolApiNameCount` on rows logged before the field
 * existed. Only rows that called a tool need it: a missing count reads as 0.
 * Recorded in `migrations` so later boots skip the multikey scan.
 */
async function backfillToolApiNameCount(db: Db): Promise<void> {
  const migrations = db.collection<{ _id: string }>(COLLECTIONS.MIGRATIONS);
  if (await migrations.findOne({ _id: TOOL_API_NAME_COUNT_MIGRATION })) return;
  const { modifiedCount } = await db.collection(COLLECTIONS.REQUESTS).updateMany(
    { "toolApiNames.0": { $exists: true }, toolApiNameCount: { $exists: false } },
    [{ $set: { toolApiNameCount: { $size: "$toolApiNames" } } }],
  );
  await migrations.updateOne(
    { _id: TOOL_API_NAME_COUNT_MIGRATION },
    { $set: { completedAt: new Date().toISOString(), modifiedCount } },
    { upsert: true },
  );
  logger.info(
    `RequestStatsIndex: backfilled toolApiNameCount on ${modifiedCount} request(s)`,
  );
}

/**
 * Backfill, then build the covering index. Boot does not wait for it: on a
 * large `requests` collection the first build takes minutes, and the stats
 * routes fall back to unhinted queries until it is there.
 */
export async function prepareRequestStatsIndex(db: Db): Promise<void> {
  try {
    await backfillToolApiNameCount(db);
    await db
      .collection(COLLECTIONS.REQUESTS)
      .createIndex(REQUEST_STATS_INDEX_KEYS, { name: REQUEST_STATS_INDEX_NAME });
    hintUnavailableUntil.delete(REQUEST_STATS_INDEX_NAME);
  } catch (error: unknown) {
    logger.error(
      `RequestStatsIndex: preparing ${REQUEST_STATS_INDEX_NAME} failed: ${getErrorMessage(error)}`,
    );
  }
}

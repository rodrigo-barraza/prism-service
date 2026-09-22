/**
 * PromptCacheStats — prompt-cache effectiveness over `agent:iteration`
 * rows (GET /admin/stats/cache). Pure: the route queries, this computes.
 *
 * - cache-read share per provider/model (cache read ÷ cache-inclusive
 *   input), overall and "within a turn" (iterations after a turn's first);
 * - consecutive pairs: each request against the previous request of the
 *   same agent conversation, when it came within `maxGapSeconds` (a pair
 *   further apart than any cache TTL says nothing about prefix stability).
 *   A zero-cache pair read no cached tokens at all;
 * - first requests of each conversation, and how many hit a cache;
 * - a histogram of why zero-cache pairs missed: the provider's own
 *   diagnosis when it gave one, else what the prefix hashes say changed
 *   (`append_only` = the prefix Prism sent was stable, the provider still
 *   missed), else `no_telemetry` for rows older than the hashes.
 */

export interface CacheStatsRow {
  requestId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  createdAt: string | Date;
  provider?: string | null;
  model?: string | null;
  agenticIteration?: number | null;
  inputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  estimatedCost?: number | null;
  cacheTelemetry?: {
    prefixChange?: string | null;
    providerDiagnostics?: {
      source?: string;
      status?: string;
      reason?: string | null;
    } | null;
  } | null;
}

interface CacheTotals {
  requests: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadShare: number | null;
  withinTurnInputTokens: number;
  withinTurnCacheReadInputTokens: number;
  withinTurnCacheReadShare: number | null;
  estimatedCost: number;
  pairs: number;
  zeroCachePairs: number;
  zeroCacheShare: number | null;
  firstRequests: number;
  firstRequestsWithCacheRead: number;
  firstRequestCacheHitShare: number | null;
  telemetryRows: number;
}

export interface CacheStats {
  maxGapSeconds: number;
  totals: CacheTotals & {
    conversations: number;
    pairsBeyondGap: number;
    /** How much the next request read, relative to the previous one's prompt. */
    carry: { zero: number; underHalf: number; underThreeQuarters: number; atLeastThreeQuarters: number };
  };
  byModel: Array<CacheTotals & { provider: string | null; model: string | null }>;
  missReasons: Array<{ reason: string; source: "provider" | "prefix_hashes" | "none"; count: number; share: number }>;
}

export const DEFAULT_MAX_GAP_SECONDS = 300;

function emptyTotals(): CacheTotals {
  return {
    requests: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadShare: null,
    withinTurnInputTokens: 0,
    withinTurnCacheReadInputTokens: 0,
    withinTurnCacheReadShare: null,
    estimatedCost: 0,
    pairs: 0,
    zeroCachePairs: 0,
    zeroCacheShare: null,
    firstRequests: 0,
    firstRequestsWithCacheRead: 0,
    firstRequestCacheHitShare: null,
    telemetryRows: 0,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

function finishTotals<T extends CacheTotals>(totals: T): T {
  totals.cacheReadShare = ratio(totals.cacheReadInputTokens, totals.inputTokens);
  totals.withinTurnCacheReadShare = ratio(
    totals.withinTurnCacheReadInputTokens,
    totals.withinTurnInputTokens,
  );
  totals.zeroCacheShare = ratio(totals.zeroCachePairs, totals.pairs);
  totals.firstRequestCacheHitShare = ratio(
    totals.firstRequestsWithCacheRead,
    totals.firstRequests,
  );
  totals.estimatedCost = Math.round(totals.estimatedCost * 1e6) / 1e6;
  return totals;
}

function missReason(row: CacheStatsRow): {
  reason: string;
  source: "provider" | "prefix_hashes" | "none";
} {
  const diagnostics = row.cacheTelemetry?.providerDiagnostics;
  if (diagnostics?.status === "cache_miss" && diagnostics.reason) {
    return { reason: diagnostics.reason, source: "provider" };
  }
  const prefixChange = row.cacheTelemetry?.prefixChange;
  if (prefixChange) return { reason: prefixChange, source: "prefix_hashes" };
  return { reason: "no_telemetry", source: "none" };
}

/** Rows must be sorted by createdAt ascending. */
export function computeCacheStats(
  rows: CacheStatsRow[],
  { maxGapSeconds = DEFAULT_MAX_GAP_SECONDS }: { maxGapSeconds?: number } = {},
): CacheStats {
  const overall = {
    ...emptyTotals(),
    conversations: 0,
    pairsBeyondGap: 0,
    carry: { zero: 0, underHalf: 0, underThreeQuarters: 0, atLeastThreeQuarters: 0 },
  };
  const byModel = new Map<string, CacheTotals & { provider: string | null; model: string | null }>();
  const reasons = new Map<string, { reason: string; source: "provider" | "prefix_hashes" | "none"; count: number }>();
  const previousByConversation = new Map<string, CacheStatsRow>();

  for (const row of rows) {
    const provider = row.provider ?? null;
    const model = row.model ?? null;
    const modelKey = `${provider}\u0000${model}`;
    let modelTotals = byModel.get(modelKey);
    if (!modelTotals) {
      modelTotals = { provider, model, ...emptyTotals() };
      byModel.set(modelKey, modelTotals);
    }
    const inputTokens = Number(row.inputTokens) || 0;
    const cacheRead = Number(row.cacheReadInputTokens) || 0;
    const cacheWrite = Number(row.cacheCreationInputTokens) || 0;
    const isWithinTurn = (Number(row.agenticIteration) || 1) > 1;
    for (const totals of [overall, modelTotals]) {
      totals.requests += 1;
      totals.inputTokens += inputTokens;
      totals.cacheReadInputTokens += cacheRead;
      totals.cacheCreationInputTokens += cacheWrite;
      totals.estimatedCost += Number(row.estimatedCost) || 0;
      if (isWithinTurn) {
        totals.withinTurnInputTokens += inputTokens;
        totals.withinTurnCacheReadInputTokens += cacheRead;
      }
      if (row.cacheTelemetry?.prefixChange) totals.telemetryRows += 1;
    }

    const conversationKey =
      row.agentConversationId || row.conversationId || row.requestId || "";
    const previous = conversationKey ? previousByConversation.get(conversationKey) : undefined;
    if (conversationKey) previousByConversation.set(conversationKey, row);
    if (!previous) {
      overall.conversations += 1;
      for (const totals of [overall, modelTotals]) {
        totals.firstRequests += 1;
        if (cacheRead > 0) totals.firstRequestsWithCacheRead += 1;
      }
      continue;
    }

    const gapSeconds =
      (new Date(row.createdAt).getTime() - new Date(previous.createdAt).getTime()) / 1000;
    if (!(gapSeconds <= maxGapSeconds)) {
      overall.pairsBeyondGap += 1;
      continue;
    }
    const isZeroCache = cacheRead === 0;
    for (const totals of [overall, modelTotals]) {
      totals.pairs += 1;
      if (isZeroCache) totals.zeroCachePairs += 1;
    }
    const previousInput = Number(previous.inputTokens) || 0;
    const carry = previousInput > 0 ? Math.min(1, cacheRead / previousInput) : 0;
    if (carry === 0) overall.carry.zero += 1;
    else if (carry < 0.5) overall.carry.underHalf += 1;
    else if (carry < 0.75) overall.carry.underThreeQuarters += 1;
    else overall.carry.atLeastThreeQuarters += 1;

    if (isZeroCache) {
      const { reason, source } = missReason(row);
      const key = `${source}\u0000${reason}`;
      const entry = reasons.get(key) ?? { reason, source, count: 0 };
      entry.count += 1;
      reasons.set(key, entry);
    }
  }

  const zeroCachePairs = overall.zeroCachePairs;
  return {
    maxGapSeconds,
    totals: finishTotals(overall),
    byModel: [...byModel.values()]
      .map(finishTotals)
      .sort((left, right) => right.requests - left.requests),
    missReasons: [...reasons.values()]
      .sort((left, right) => right.count - left.count)
      .map((entry) => ({ ...entry, share: ratio(entry.count, zeroCachePairs) ?? 0 })),
  };
}

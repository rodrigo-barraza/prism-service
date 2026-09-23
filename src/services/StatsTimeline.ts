/**
 * StatsTimeline — GET /admin/stats/timeline bucketing.
 *
 * Mongo groups `requests` by a prefix of the ISO `createdAt` string
 * (second, minute or hour), which the covering index answers without parsing
 * a date per row (`$toDate` + `$dateTrunc` measured 4–5× slower). The rest is
 * pure and happens here: rolling those base buckets up to the requested
 * granularity, zero-filling the gaps, and the span rules that bound how many
 * points one timeline can have.
 *
 * Sub-day buckets are UTC instants, keyed as before ("2026-04-02T22:05:30",
 * "2026-04-02T22:05", "2026-04-02T14"). Day and week buckets are calendar
 * dates in the viewer's `timezone` ("2026-04-02"; weeks start on Monday),
 * rolled up from hour buckets — exact for whole-hour UTC offsets, within 30
 * minutes of a day's edge for half-hour ones.
 */
import type { Document } from "mongodb";
import { COST_SUMMATION_EXPRESSION } from "#src/constants";

export const TIMELINE_GRANULARITIES = [
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
] as const;

export type TimelineGranularity = (typeof TIMELINE_GRANULARITIES)[number];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const STEP_MILLISECONDS: Record<TimelineGranularity, number> = {
  "1s": SECOND,
  "5s": 5 * SECOND,
  "15s": 15 * SECOND,
  "30s": 30 * SECOND,
  "1min": MINUTE,
  "5min": 5 * MINUTE,
  "15min": 15 * MINUTE,
  "1hr": HOUR,
  "4hr": 4 * HOUR,
  "1day": DAY,
  "1week": 7 * DAY,
};

/** Length of the `createdAt` prefix each granularity is grouped by in Mongo. */
const BASE_PREFIX_LENGTH: Record<TimelineGranularity, 13 | 16 | 19> = {
  "1s": 19,
  "5s": 19,
  "15s": 19,
  "30s": 19,
  "1min": 16,
  "5min": 16,
  "15min": 16,
  "1hr": 13,
  "4hr": 13,
  "1day": 13,
  "1week": 13,
};

const PREFIX_TO_INSTANT_SUFFIX = { 13: ":00:00Z", 16: ":00Z", 19: "Z" } as const;

interface SpanRule {
  maxSpanMilliseconds: number;
  defaultGranularity: TimelineGranularity;
  minGranularity: TimelineGranularity;
  maxGranularity: TimelineGranularity;
}

const SPAN_RULES: SpanRule[] = [
  { maxSpanMilliseconds: 2 * MINUTE, defaultGranularity: "1s", minGranularity: "1s", maxGranularity: "15s" },
  { maxSpanMilliseconds: 10 * MINUTE, defaultGranularity: "5s", minGranularity: "1s", maxGranularity: "1min" },
  { maxSpanMilliseconds: 30 * MINUTE, defaultGranularity: "15s", minGranularity: "5s", maxGranularity: "5min" },
  { maxSpanMilliseconds: HOUR, defaultGranularity: "30s", minGranularity: "15s", maxGranularity: "5min" },
  { maxSpanMilliseconds: 6 * HOUR, defaultGranularity: "1min", minGranularity: "15s", maxGranularity: "15min" },
  { maxSpanMilliseconds: DAY, defaultGranularity: "5min", minGranularity: "1min", maxGranularity: "1hr" },
  { maxSpanMilliseconds: 3 * DAY, defaultGranularity: "15min", minGranularity: "5min", maxGranularity: "1day" },
  { maxSpanMilliseconds: 7 * DAY, defaultGranularity: "1day", minGranularity: "1hr", maxGranularity: "1day" },
  { maxSpanMilliseconds: 14 * DAY, defaultGranularity: "1day", minGranularity: "4hr", maxGranularity: "1day" },
  { maxSpanMilliseconds: 30 * DAY, defaultGranularity: "1day", minGranularity: "4hr", maxGranularity: "1week" },
  { maxSpanMilliseconds: 90 * DAY, defaultGranularity: "1day", minGranularity: "1day", maxGranularity: "1week" },
  { maxSpanMilliseconds: Infinity, defaultGranularity: "1week", minGranularity: "1day", maxGranularity: "1week" },
];

/**
 * Most points one timeline returns. A granularity that would need more for
 * the span is not offered (6 h at 15 s is 1,441 points). The old fixed cap of
 * 1,000 cut those timelines off at the END, so the newest data never showed.
 */
export const MAX_TIMELINE_BUCKETS = 1500;

function bucketCount(spanMilliseconds: number, granularity: TimelineGranularity): number {
  // +2: a span rarely starts or ends on a bucket edge.
  return Math.ceil(spanMilliseconds / STEP_MILLISECONDS[granularity]) + 2;
}

export interface ResolvedGranularity {
  granularity: TimelineGranularity;
  defaultGranularity: TimelineGranularity;
  validGranularities: TimelineGranularity[];
}

export function resolveGranularity(
  spanMilliseconds: number,
  requested: unknown,
): ResolvedGranularity {
  const rule =
    SPAN_RULES.find((spanRule) => spanMilliseconds <= spanRule.maxSpanMilliseconds) ??
    SPAN_RULES[SPAN_RULES.length - 1];
  const tiers = TIMELINE_GRANULARITIES.slice(
    TIMELINE_GRANULARITIES.indexOf(rule.minGranularity),
    TIMELINE_GRANULARITIES.indexOf(rule.maxGranularity) + 1,
  );
  const fitting = tiers.filter(
    (granularity) => bucketCount(spanMilliseconds, granularity) <= MAX_TIMELINE_BUCKETS,
  );
  // A span so long that even weeks overflow still gets weeks.
  const validGranularities = fitting.length ? fitting : [rule.maxGranularity];
  const defaultIndex = TIMELINE_GRANULARITIES.indexOf(rule.defaultGranularity);
  const defaultGranularity =
    validGranularities.find(
      (granularity) => TIMELINE_GRANULARITIES.indexOf(granularity) >= defaultIndex,
    ) ?? validGranularities[validGranularities.length - 1];
  const granularity = validGranularities.includes(requested as TimelineGranularity)
    ? (requested as TimelineGranularity)
    : defaultGranularity;
  return { granularity, defaultGranularity, validGranularities };
}

/** An IANA zone the runtime knows, else UTC. */
export function resolveTimeZone(requested: unknown): string {
  if (typeof requested !== "string" || !requested) return "UTC";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: requested }).resolvedOptions()
      .timeZone;
  } catch {
    return "UTC";
  }
}

/** `$group` over `requests` by the `createdAt` prefix `granularity` rolls up from. */
export function timelineGroupStage(granularity: TimelineGranularity): Document {
  return {
    $group: {
      _id: { $substrBytes: ["$createdAt", 0, BASE_PREFIX_LENGTH[granularity]] },
      requests: { $sum: 1 },
      tokens: {
        $sum: {
          $add: [{ $ifNull: ["$inputTokens", 0] }, { $ifNull: ["$outputTokens", 0] }],
        },
      },
      cost: COST_SUMMATION_EXPRESSION,
      // Sum + count rather than $avg, so buckets can be merged exactly.
      latencySum: { $sum: "$totalTime" },
      latencyCount: { $sum: { $cond: [{ $isNumber: "$totalTime" }, 1, 0] } },
      successes: { $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] } },
    },
  };
}

export interface TimelineBaseBucket {
  _id: string;
  requests: number;
  tokens: number;
  cost: number;
  latencySum: number;
  latencyCount: number;
  successes: number;
}

export interface TimelinePoint {
  /** Bucket key — see the module comment for its two forms. */
  hour: string;
  requests: number;
  tokens: number;
  cost: number;
  /** Mean end-to-end request time in SECONDS (`requests.totalTime`). */
  avgLatency: number;
  successRate: number;
}

function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function mondayOf(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addCalendarDays(dateKey, -((weekday + 6) % 7));
}

/** Maps an instant to its bucket key; also enumerates keys in order. */
function bucketing(granularity: TimelineGranularity, timeZone: string) {
  if (granularity === "1day" || granularity === "1week") {
    const calendarDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const toDay = (instant: number) => calendarDate.format(instant);
    const keyOf =
      granularity === "1day" ? toDay : (instant: number) => mondayOf(toDay(instant));
    const stepDays = granularity === "1day" ? 1 : 7;
    return { keyOf, next: (key: string) => addCalendarDays(key, stepDays) };
  }
  const step = STEP_MILLISECONDS[granularity];
  const keyLength = BASE_PREFIX_LENGTH[granularity];
  const keyOf = (instant: number) =>
    new Date(Math.floor(instant / step) * step).toISOString().slice(0, keyLength);
  const next = (key: string) =>
    keyOf(Date.parse(key + PREFIX_TO_INSTANT_SUFFIX[keyLength]) + step);
  return { keyOf, next };
}

/**
 * Roll Mongo's base buckets up to `granularity` and zero-fill every bucket
 * from `since` to `until`, oldest first. Never more than
 * MAX_TIMELINE_BUCKETS points: if a caller asks for more, the OLDEST go.
 */
export function buildTimeline(
  baseBuckets: TimelineBaseBucket[],
  {
    granularity,
    since,
    until,
    timeZone,
  }: { granularity: TimelineGranularity; since: Date; until: Date; timeZone: string },
): TimelinePoint[] {
  const { keyOf, next } = bucketing(granularity, timeZone);
  const suffix = PREFIX_TO_INSTANT_SUFFIX[BASE_PREFIX_LENGTH[granularity]];

  const merged = new Map<string, Omit<TimelineBaseBucket, "_id">>();
  for (const baseBucket of baseBuckets) {
    if (typeof baseBucket._id !== "string") continue;
    const key = keyOf(Date.parse(baseBucket._id + suffix));
    const bucket = merged.get(key) ?? {
      requests: 0,
      tokens: 0,
      cost: 0,
      latencySum: 0,
      latencyCount: 0,
      successes: 0,
    };
    bucket.requests += baseBucket.requests || 0;
    bucket.tokens += baseBucket.tokens || 0;
    bucket.cost += baseBucket.cost || 0;
    bucket.latencySum += baseBucket.latencySum || 0;
    bucket.latencyCount += baseBucket.latencyCount || 0;
    bucket.successes += baseBucket.successes || 0;
    merged.set(key, bucket);
  }

  // Start no earlier than the newest MAX_TIMELINE_BUCKETS need, so an
  // absurd `from` costs nothing.
  const earliest = until.getTime() - (MAX_TIMELINE_BUCKETS + 1) * STEP_MILLISECONDS[granularity];
  const keys: string[] = [];
  const lastKey = keyOf(until.getTime());
  for (let key = keyOf(Math.max(since.getTime(), earliest)); key <= lastKey; ) {
    keys.push(key);
    const following = next(key);
    if (following <= key) break;
    key = following;
  }

  return keys.slice(-MAX_TIMELINE_BUCKETS).map((key) => {
    const bucket = merged.get(key);
    if (!bucket) {
      return { hour: key, requests: 0, tokens: 0, cost: 0, avgLatency: 0, successRate: 100 };
    }
    return {
      hour: key,
      requests: bucket.requests,
      tokens: bucket.tokens,
      cost: bucket.cost,
      avgLatency: bucket.latencyCount
        ? Math.round((bucket.latencySum / bucket.latencyCount) * 1000) / 1000
        : 0,
      successRate: bucket.requests
        ? Math.round((bucket.successes / bucket.requests) * 100)
        : 100,
    };
  });
}

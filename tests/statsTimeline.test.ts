import { describe, it, expect } from "vitest";
import {
  buildTimeline,
  MAX_TIMELINE_BUCKETS,
  resolveGranularity,
  resolveTimeZone,
  type TimelineBaseBucket,
} from "#src/services/StatsTimeline";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function base(id: string, fields: Partial<TimelineBaseBucket> = {}): TimelineBaseBucket {
  return {
    _id: id,
    requests: 1,
    tokens: 10,
    cost: 0.01,
    latencySum: 2,
    latencyCount: 1,
    successes: 1,
    ...fields,
  };
}

describe("resolveGranularity", () => {
  it("offers 15 s bins over 6 h — 1,441 points, above the old 1,000 cap", () => {
    const resolved = resolveGranularity(6 * HOUR, "15s");
    expect(resolved.granularity).toBe("15s");
    expect(resolved.validGranularities).toContain("15s");
    expect(resolved.defaultGranularity).toBe("1min");
  });

  it("falls back to the span's default for a granularity it does not offer", () => {
    expect(resolveGranularity(DAY, "1s").granularity).toBe("5min");
    expect(resolveGranularity(DAY, undefined).granularity).toBe("5min");
    expect(resolveGranularity(DAY, "nonsense").granularity).toBe("5min");
  });

  it("never offers a granularity that would exceed the point cap", () => {
    // 5 years: days would be ~1,827 points, so only weeks remain.
    const resolved = resolveGranularity(5 * 365 * DAY, "1day");
    expect(resolved.validGranularities).toEqual(["1week"]);
    expect(resolved.granularity).toBe("1week");
  });
});

describe("resolveTimeZone", () => {
  it("keeps a real IANA zone and falls back to UTC otherwise", () => {
    expect(resolveTimeZone("America/Vancouver")).toBe("America/Vancouver");
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone(["America/Vancouver"])).toBe("UTC");
  });
});

describe("buildTimeline", () => {
  it("rolls second buckets up into 15 s bins and zero-fills the gaps", () => {
    const since = new Date("2026-09-23T10:00:00Z");
    const until = new Date("2026-09-23T10:01:00Z");
    const points = buildTimeline(
      [
        base("2026-09-23T10:00:03"),
        base("2026-09-23T10:00:14", { latencySum: 4, successes: 0 }),
        base("2026-09-23T10:00:45"),
      ],
      { granularity: "15s", since, until, timeZone: "UTC" },
    );
    expect(points.map((point) => point.hour)).toEqual([
      "2026-09-23T10:00:00",
      "2026-09-23T10:00:15",
      "2026-09-23T10:00:30",
      "2026-09-23T10:00:45",
      "2026-09-23T10:01:00",
    ]);
    expect(points[0]).toMatchObject({ requests: 2, tokens: 20, avgLatency: 3, successRate: 50 });
    expect(points[1]).toMatchObject({ requests: 0, avgLatency: 0, successRate: 100 });
    expect(points[3].requests).toBe(1);
  });

  it("keys minute and hour bins exactly as before", () => {
    const since = new Date("2026-09-23T10:00:00Z");
    const until = new Date("2026-09-23T10:20:00Z");
    const minutes = buildTimeline([base("2026-09-23T10:07")], {
      granularity: "5min",
      since,
      until,
      timeZone: "UTC",
    });
    expect(minutes.map((point) => point.hour)).toEqual([
      "2026-09-23T10:00",
      "2026-09-23T10:05",
      "2026-09-23T10:10",
      "2026-09-23T10:15",
      "2026-09-23T10:20",
    ]);
    expect(minutes[1].requests).toBe(1);

    const fourHours = buildTimeline([base("2026-09-23T06")], {
      granularity: "4hr",
      since: new Date("2026-09-23T01:00:00Z"),
      until: new Date("2026-09-23T09:00:00Z"),
      timeZone: "UTC",
    });
    expect(fourHours.map((point) => point.hour)).toEqual([
      "2026-09-23T00",
      "2026-09-23T04",
      "2026-09-23T08",
    ]);
    expect(fourHours[1].requests).toBe(1);
  });

  it("puts day bins on the viewer's calendar, not UTC's", () => {
    // 05:00 UTC on the 23rd is still the evening of the 22nd in Vancouver.
    const points = buildTimeline([base("2026-09-23T05"), base("2026-09-23T08")], {
      granularity: "1day",
      since: new Date("2026-09-22T07:00:00Z"),
      until: new Date("2026-09-24T06:59:59Z"),
      timeZone: "America/Vancouver",
    });
    expect(points.map((point) => [point.hour, point.requests])).toEqual([
      ["2026-09-22", 1],
      ["2026-09-23", 1],
    ]);
  });

  it("starts week bins on the local Monday", () => {
    const points = buildTimeline(
      [base("2026-09-20T12"), base("2026-09-21T12"), base("2026-09-27T12")],
      {
        granularity: "1week",
        since: new Date("2026-09-14T12:00:00Z"),
        until: new Date("2026-09-28T12:00:00Z"),
        timeZone: "UTC",
      },
    );
    expect(points.map((point) => [point.hour, point.requests])).toEqual([
      ["2026-09-14", 1],
      ["2026-09-21", 2],
      ["2026-09-28", 0],
    ]);
  });

  it("steps day bins across a DST change without skipping or repeating a day", () => {
    const points = buildTimeline([], {
      granularity: "1day",
      since: new Date("2026-10-31T12:00:00Z"),
      until: new Date("2026-11-03T12:00:00Z"),
      timeZone: "America/Vancouver",
    });
    expect(points.map((point) => point.hour)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });

  it("reports latency in seconds, unrounded to the millisecond", () => {
    const [point] = buildTimeline(
      [base("2026-09-23T10", { requests: 2, latencySum: 0.9, latencyCount: 2 })],
      {
        granularity: "1hr",
        since: new Date("2026-09-23T10:00:00Z"),
        until: new Date("2026-09-23T10:30:00Z"),
        timeZone: "UTC",
      },
    );
    expect(point.avgLatency).toBe(0.45);
  });

  it("keeps the NEWEST bucket when a span needs more than 1,000 points", () => {
    const until = new Date("2026-09-23T16:00:00Z");
    const since = new Date(until.getTime() - 6 * HOUR);
    const points = buildTimeline([base("2026-09-23T15:59:50")], {
      granularity: "15s",
      since,
      until,
      timeZone: "UTC",
    });
    expect(points.length).toBe(1441);
    expect(points.length).toBeLessThanOrEqual(MAX_TIMELINE_BUCKETS);
    expect(points[points.length - 1].hour).toBe("2026-09-23T16:00:00");
    expect(points[points.length - 2]).toMatchObject({ hour: "2026-09-23T15:59:45", requests: 1 });
  });

  it("drops the OLDEST buckets, not the newest, if asked for too many", () => {
    const until = new Date("2026-09-23T16:00:00Z");
    const points = buildTimeline([], {
      granularity: "1s",
      since: new Date(until.getTime() - DAY),
      until,
      timeZone: "UTC",
    });
    expect(points.length).toBe(MAX_TIMELINE_BUCKETS);
    expect(points[points.length - 1].hour).toBe("2026-09-23T16:00:00");
  });
});

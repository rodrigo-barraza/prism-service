import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";
import adminRouter from "#src/routes/AdminRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { StatsCache } from "#src/caches/StatsCache";

app.use("/admin", adminRouter);

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 22, 12, 0, seconds)).toISOString();

describe("GET /admin/stats/cache", () => {
  let findCalls: Array<{ filter: Record<string, any>; options: Record<string, any> }>;
  let sortCalls: Array<Record<string, number>>;

  beforeEach(() => {
    StatsCache.clear();
    findCalls = [];
    sortCalls = [];
    const rows = [
      {
        requestId: "t1-1", agentConversationId: "conv-1", createdAt: at(0), provider: "google", model: "gemini-3.6-flash",
        agenticIteration: 1, inputTokens: 10000, cacheReadInputTokens: 0, estimatedCost: 0.0075,
        cacheTelemetry: { prefixChange: "no_previous_request" },
      },
      {
        requestId: "t1-2", agentConversationId: "conv-1", createdAt: at(8), provider: "google", model: "gemini-3.6-flash",
        agenticIteration: 2, inputTokens: 11000, cacheReadInputTokens: 9500, estimatedCost: 0.002,
        cacheTelemetry: { prefixChange: "append_only" },
      },
      {
        requestId: "t1-3", agentConversationId: "conv-1", createdAt: at(16), provider: "google", model: "gemini-3.6-flash",
        agenticIteration: 3, inputTokens: 12000, cacheReadInputTokens: 0, estimatedCost: 0.009,
        cacheTelemetry: { prefixChange: "tools_changed" },
      },
      {
        requestId: "t2-1", agentConversationId: "conv-2", createdAt: at(20), provider: "anthropic", model: "claude-sonnet-5",
        agenticIteration: 1, inputTokens: 8000, cacheReadInputTokens: 6000, estimatedCost: 0.004,
        cacheTelemetry: { prefixChange: "no_previous_request" },
      },
      {
        requestId: "t2-2", agentConversationId: "conv-2", createdAt: at(30), provider: "anthropic", model: "claude-sonnet-5",
        agenticIteration: 2, inputTokens: 9000, cacheReadInputTokens: 0, estimatedCost: 0.018,
        cacheTelemetry: {
          prefixChange: "append_only",
          providerDiagnostics: { source: "anthropic", status: "cache_miss", reason: "messages_changed" },
        },
      },
    ];
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => ({
        find: (filter: Record<string, any>, options: Record<string, any>) => {
          findCalls.push({ filter, options });
          const cursor = {
            sort: (sort: Record<string, number>) => {
              sortCalls.push(sort);
              return cursor;
            },
            limit: () => cursor,
            toArray: async () => rows,
          };
          return cursor;
        },
      }),
    } as any);
  });

  it("reports cache-read share, zero-cache pairs, first requests and miss reasons", async () => {
    const response = await request(app).get("/admin/stats/cache").expect(200);
    const body = response.body;

    expect(body.maxGapSeconds).toBe(300);
    expect(body.totals).toMatchObject({
      requests: 5,
      conversations: 2,
      firstRequests: 2,
      firstRequestsWithCacheRead: 1,
      firstRequestCacheHitShare: 0.5,
      pairs: 3,
      zeroCachePairs: 2,
      zeroCacheShare: 0.6667,
      telemetryRows: 5,
    });
    expect(body.totals.cacheReadShare).toBeCloseTo(15500 / 50000, 4);
    expect(body.totals.withinTurnCacheReadShare).toBeCloseTo(9500 / 32000, 4);
    expect(body.missReasons).toEqual([
      { reason: "tools_changed", source: "prefix_hashes", count: 1, share: 0.5 },
      { reason: "messages_changed", source: "provider", count: 1, share: 0.5 },
    ]);
    const gemini = body.byModel.find((entry: any) => entry.model === "gemini-3.6-flash");
    expect(gemini).toMatchObject({ provider: "google", requests: 3, pairs: 2, zeroCachePairs: 1 });
    expect(gemini.estimatedCost).toBeCloseTo(0.0185, 6);
  });

  it("queries completed agent iterations in time order, last 30 days by default", async () => {
    await request(app).get("/admin/stats/cache").expect(200);
    const { filter, options } = findCalls[0];
    expect(filter.operation).toBe("agent:iteration");
    expect(filter.status).toBe("completed");
    const windowStart = Date.parse(filter.createdAt.$gte);
    expect(Date.now() - windowStart).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(Date.now() - windowStart).toBeLessThan(31 * 24 * 3600 * 1000);
    // Never pulls message payloads or the per-message hashes
    expect(options.projection.requestPayload).toBeUndefined();
    expect(options.projection.prefixHashes).toBeUndefined();
    expect(sortCalls[0]).toEqual({ createdAt: 1 });
  });

  it("honours from/to, provider and maxGapSeconds", async () => {
    const response = await request(app)
      .get("/admin/stats/cache")
      .query({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z", provider: "google", maxGapSeconds: "5" })
      .expect(200);
    const { filter } = findCalls[0];
    expect(filter.createdAt).toEqual({ $gte: "2026-09-01T00:00:00Z", $lte: "2026-09-30T00:00:00Z" });
    expect(filter.provider).toBe("google");
    expect(response.body.maxGapSeconds).toBe(5);
    // Every consecutive pair in the fixture is 8 s or more apart
    expect(response.body.totals.pairs).toBe(0);
    expect(response.body.totals.pairsBeyondGap).toBe(3);
  });
});

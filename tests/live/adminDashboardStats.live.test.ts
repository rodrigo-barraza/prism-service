/**
 * Admin dashboard stats against a REAL MongoDB — the unit suite's fakes
 * cannot run a `$facet`, and only a real planner says whether a query is
 * covered. Seeds a throwaway database with synthetic requests and checks:
 * the one-scan dashboard against an independent JS computation and against
 * the separate endpoints, the covered plans, the timeline, and the two-pass
 * traces list.
 *
 *   PRISM_STATS_LIVE_MONGO_URI=mongodb://127.0.0.1:27017 \
 *     pnpm test:live tests/live/adminDashboardStats.live.test.ts
 *
 * Drops its database (`prism_stats_live`) when done: never point it at a
 * server whose user cannot, or at a database that matters.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "mongodb";
import type { Express } from "express";

const MONGO_URI = process.env.PRISM_STATS_LIVE_MONGO_URI;
const DB_NAME = "prism_stats_live";
const describeLive = MONGO_URI ? describe : describe.skip;

type Doc = Record<string, any>;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.now();
const DAY = 86_400_000;

function seedRequests(): Doc[] {
  const random = mulberry32(42);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const projects = ["prism-client", "lupos", "tools", null];
  const providers = ["openai", "anthropic", "google"];
  const models = ["model-a", "model-b", "model-c", "model-d"];
  const agents = ["CODING", "LUPOS", null, null];
  const traces = Array.from({ length: 120 }, (_, index) => `trace-${index}`);
  const conversations = Array.from({ length: 60 }, (_, index) => `conv-${index}`);
  const docs: Doc[] = [];
  for (let index = 0; index < 3000; index++) {
    const legacy = index < 400; // rows from before the timestamp → createdAt rename
    const at = new Date(NOW - random() * 40 * DAY).toISOString();
    const toolApiNames = random() < 0.2 ? ["read_file", "grep", "bash"].slice(0, 1 + Math.floor(random() * 3)) : [];
    const doc: Doc = {
      requestId: `req-${index}`,
      [legacy ? "timestamp" : "createdAt"]: at,
      endpoint: pick(["/chat", "/agent"]),
      project: pick(projects),
      agent: pick(agents),
      provider: pick(providers),
      model: pick(models),
      username: pick(["alice", "bob"]),
      conversationId: random() < 0.7 ? pick(conversations) : null,
      traceId: random() < 0.85 ? pick(traces) : null,
      toolApiNames,
      toolsUsed: toolApiNames.length > 0,
      success: random() < 0.9,
      inputTokens: Math.floor(random() * 5000),
      outputTokens: Math.floor(random() * 500),
      estimatedCost: random() < 0.2 ? null : Math.round(random() * 1e6) / 1e7,
      tokensPerSec: random() < 0.2 ? null : random() * 150,
      totalTime: random() < 0.05 ? null : random() * 20,
      requestPayload: "x".repeat(2000),
    };
    // The newest rows already carry the count, as RequestLogger now writes it.
    if (index >= 2500) doc.toolApiNameCount = toolApiNames.length;
    docs.push(doc);
  }
  // The newest request, pinned 10 s ago — the timeline must show it.
  docs.push({ ...docs[2999], requestId: "req-newest", createdAt: new Date(NOW - 10_000).toISOString() });
  return docs;
}

function groupBy(docs: Doc[], key: (doc: Doc) => string | null | undefined) {
  const groups = new Map<string, Doc[]>();
  for (const doc of docs) {
    const groupKey = String(key(doc) ?? "any");
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), doc]);
  }
  return groups;
}

const distinct = (docs: Doc[], field: string) =>
  new Set(docs.map((doc) => doc[field]).filter((value) => value != null)).size;
const sum = (docs: Doc[], field: string) =>
  docs.reduce((total, doc) => total + (typeof doc[field] === "number" ? doc[field] : 0), 0);

describeLive("admin dashboard stats against a real MongoDB", () => {
  let db: Db;
  let closeDatabase: () => Promise<unknown>;
  let app: Express;
  let requests: Doc[];
  let supertest: typeof import("supertest").default;
  let StatsCache: typeof import("#src/caches/StatsCache").StatsCache;
  let RequestStatsIndex: typeof import("#src/services/RequestStatsIndex");
  let Facets: typeof import("#src/services/RequestStatsFacets");
  let TraceRoutes: typeof import("#src/routes/admin/AdminTraceRoutes");
  let TimelineModule: typeof import("#src/services/StatsTimeline");

  const get = async (path: string) => {
    const response = await supertest(app).get(path);
    expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body;
  };

  beforeAll(async () => {
    process.env.MONGO_URI = MONGO_URI;
    process.env.PRISM_SERVICE_MONGO_DB_NAME = DB_NAME;
    const { default: MongoWrapper } = await import("#src/wrappers/MongoWrapper");
    await MongoWrapper.createClient(DB_NAME, MONGO_URI!);
    db = MongoWrapper.getDb(DB_NAME)!;
    closeDatabase = () => MongoWrapper.closeClient(DB_NAME);
    await db.dropDatabase();

    requests = seedRequests();
    await db.collection("requests").insertMany(requests.map((doc) => ({ ...doc })));
    const conversations = Array.from({ length: 60 }, (_, index) => ({
      id: `conv-${index}`,
      project: ["prism-client", "lupos", "tools", null][index % 4],
      updatedAt: new Date(NOW - (index % 40) * DAY).toISOString(),
      username: "alice",
      profileId: null,
    }));
    await db.collection("model_conversations").insertMany(conversations);
    await db.collection("workflows").insertMany([
      { conversationIds: ["conv-0", "conv-4"] },
      { conversationIds: ["conv-1"] },
    ]);
    await db.collection("requests").createIndex({ traceId: 1 });

    const express = (await import("express")).default;
    supertest = (await import("supertest")).default;
    ({ StatsCache } = await import("#src/caches/StatsCache"));
    RequestStatsIndex = await import("#src/services/RequestStatsIndex");
    Facets = await import("#src/services/RequestStatsFacets");
    const { default: statsRouter } = await import("#src/routes/admin/AdminStatsRoutes");
    TraceRoutes = await import("#src/routes/admin/AdminTraceRoutes");
    TimelineModule = await import("#src/services/StatsTimeline");
    const tracesRouter = TraceRoutes.default;
    app = express();
    app.use("/admin/stats", statsRouter);
    app.use("/admin/traces", tracesRouter);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await closeDatabase?.();
  });

  it("answers before the covering index exists (unhinted fallback)", async () => {
    StatsCache.clear();
    const dashboard = await get("/admin/stats/dashboard");
    expect(dashboard.stats.totalRequests).toBe(requests.length);
  });

  it("backfills toolApiNameCount once, then builds the covering index", async () => {
    await RequestStatsIndex.prepareRequestStatsIndex(db);
    expect(
      await db.collection("requests").countDocuments({
        "toolApiNames.0": { $exists: true },
        toolApiNameCount: { $exists: false },
      }),
    ).toBe(0);
    const marker = await db
      .collection<{ _id: string; completedAt: string }>("migrations")
      .findOne({ _id: "requests.toolApiNameCount" });
    expect(marker?.completedAt).toBeTruthy();

    await RequestStatsIndex.prepareRequestStatsIndex(db); // a later boot
    const again = await db
      .collection<{ _id: string; completedAt: string }>("migrations")
      .findOne({ _id: "requests.toolApiNameCount" });
    expect(again?.completedAt).toBe(marker?.completedAt);

    const indexes = await db.collection("requests").indexes();
    expect(indexes.map((index) => index.name)).toContain(RequestStatsIndex.REQUEST_STATS_INDEX_NAME);
    await db
      .collection("model_conversations")
      .createIndex({ project: 1, username: 1, profileId: 1, updatedAt: -1 });
    StatsCache.clear();
  });

  it("matches an independent computation over the raw rows", async () => {
    const dashboard = await get("/admin/stats/dashboard");
    const { stats } = dashboard;
    expect(stats.totalRequests).toBe(requests.length);
    expect(stats.totalInputTokens).toBe(sum(requests, "inputTokens"));
    expect(stats.totalCost).toBeCloseTo(sum(requests, "estimatedCost"), 9);
    expect(stats.successCount).toBe(requests.filter((doc) => doc.success === true).length);
    expect(stats.errorCount).toBe(requests.filter((doc) => doc.success === false).length);
    expect(stats.totalToolCalls).toBe(
      requests.reduce((total, doc) => total + doc.toolApiNames.length, 0),
    );
    expect(stats.traceCount).toBe(distinct(requests, "traceId"));
    expect(stats.totalDuration).toBeCloseTo(sum(requests, "totalTime"), 6);
    expect(stats.conversationCount).toBe(60);

    for (const [project, docs] of groupBy(requests, (doc) => doc.project)) {
      const row = dashboard.projects.find((entry: Doc) => entry.project === project);
      expect(row, project).toBeTruthy();
      expect(row.totalRequests).toBe(docs.length);
      expect(row.modelCount).toBe(distinct(docs, "model"));
      expect(row.traceCount).toBe(distinct(docs, "traceId"));
    }
    const lupos = dashboard.projects.find((entry: Doc) => entry.project === "lupos");
    expect(lupos.conversationCount).toBe(15);
    expect(dashboard.projects.find((entry: Doc) => entry.project === "prism-client").workflowCount).toBe(1);

    for (const [key, docs] of groupBy(requests, (doc) => `${doc.provider}:${doc.model}`)) {
      const row = dashboard.models.find((entry: Doc) => `${entry.provider}:${entry.model}` === key);
      expect(row.totalRequests).toBe(docs.length);
      expect(row.conversationCount).toBe(distinct(docs, "conversationId"));
      expect(row.traceCount).toBe(distinct(docs, "traceId"));
      expect(row.toolsUsed).toBe(docs.some((doc) => doc.toolApiNames.length > 0));
    }
    for (const [agent, docs] of groupBy(
      requests.filter((doc) => doc.agent),
      (doc) => doc.agent,
    )) {
      const row = dashboard.agents.find((entry: Doc) => entry.agent === agent);
      expect(row.totalRequests).toBe(docs.length);
      expect(row.traceCount).toBe(distinct(docs, "traceId"));
      expect(row.conversationCount).toBe(distinct(docs, "conversationId"));
    }
    expect(dashboard.agents).toHaveLength(2);
    for (const [provider, docs] of groupBy(requests, (doc) => doc.provider)) {
      const row = dashboard.providers.find((entry: Doc) => entry.provider === provider);
      expect(row.totalRequests).toBe(docs.length);
      expect(row.modelCount).toBe(distinct(docs, "model"));
      expect(row.traceCount).toBe(distinct(docs, "traceId"));
    }
  });

  it("returns what the separate endpoints return", async () => {
    for (const query of ["", "?project=lupos", `?from=${new Date(NOW - 7 * DAY).toISOString()}`]) {
      const dashboard = await get(`/admin/stats/dashboard${query}`);
      expect(await get(`/admin/stats${query}`)).toEqual(dashboard.stats);
      expect(await get(`/admin/stats/projects${query}`)).toEqual(dashboard.projects);
      expect(await get(`/admin/stats/models${query}`)).toEqual(dashboard.models);
      expect(await get(`/admin/stats/agents${query}`)).toEqual(dashboard.agents);
      expect((await get(`/admin/stats/costs${query}`)).providers).toEqual(dashboard.providers);
    }
  });

  it("narrows the agents table by the agent filter", async () => {
    const dashboard = await get("/admin/stats/dashboard?agent=CODING");
    expect(dashboard.agents.map((row: Doc) => row.agent)).toEqual(["CODING"]);
    const agents = await get("/admin/stats/agents?agent=CODING");
    expect(agents.map((row: Doc) => row.agent)).toEqual(["CODING"]);
  });

  it("applies date and project filters like the raw rows say", async () => {
    const from = new Date(NOW - 10 * DAY).toISOString();
    const dashboard = await get(`/admin/stats/dashboard?project=tools&from=${from}`);
    const expected = requests.filter(
      (doc) => doc.project === "tools" && doc.createdAt && doc.createdAt >= from,
    );
    expect(dashboard.stats.totalRequests).toBe(expected.length);
    expect(dashboard.stats.traceCount).toBe(distinct(expected, "traceId"));
  });

  it("reads index keys only (covered plans, no FETCH)", async () => {
    const hint = { hint: RequestStatsIndex.REQUEST_STATS_INDEX_NAME };
    const plans = [
      [
        {
          $facet: {
            totals: Facets.totalsFacet,
            traceCount: Facets.traceCountFacet,
            projects: Facets.projectsFacet,
            providers: Facets.providersFacet,
            models: Facets.modelsFacet,
            agents: Facets.agentsFacet,
          },
        },
      ],
      [{ $match: { project: "lupos", createdAt: { $gte: new Date(NOW - 7 * DAY).toISOString() } } }, ...Facets.agentsFacet],
      Facets.agentsFacet,
      TraceRoutes.buildTracePagePipeline(
        { traceId: { $ne: null }, agent: "CODING" },
        { sortAccumulator: { $min: "$createdAt" }, sortDirection: -1, skip: 0, limit: 5 },
      ).pipeline,
      [
        { $match: { createdAt: { $gte: new Date(NOW - DAY).toISOString() } } },
        TimelineModule.timelineGroupStage("5min"),
      ],
    ];
    for (const pipeline of plans) {
      const explained = JSON.stringify(
        await db
          .collection("requests")
          .aggregate(RequestStatsIndex.anchorToIndex(pipeline, "createdAt"), hint)
          .explain(),
      );
      expect(explained).not.toContain('"FETCH"');
      expect(explained).not.toContain("COLLSCAN");
    }
  });

  it("counts conversations per project from index keys, dated or not", async () => {
    const collection = db.collection("model_conversations");
    for (const match of [{}, { updatedAt: { $gte: new Date(NOW - 7 * DAY).toISOString() } }, { project: "lupos" }]) {
      const pipeline = [
        ...(Object.keys(match).length ? [{ $match: match }] : []),
        { $group: { _id: "$project", conversationCount: { $sum: 1 } } },
      ];
      const explained = JSON.stringify(
        await collection
          .aggregate(RequestStatsIndex.anchorToIndex(pipeline, "project"), {
            hint: "project_1_username_1_profileId_1_updatedAt_-1",
          })
          .explain(),
      );
      expect(explained, JSON.stringify(match)).not.toContain('"FETCH"');
    }
  });

  it("builds a timeline whose buckets add up to the rows in range", async () => {
    const timeline = await get("/admin/stats/timeline?hours=all&tz=America/Vancouver");
    const dated = requests.filter((doc) => doc.createdAt);
    expect(timeline.timezone).toBe("America/Vancouver");
    expect(timeline.data.reduce((total: number, point: Doc) => total + point.requests, 0)).toBe(dated.length);
    // ~40 days of rows: calendar-day buckets, the first one holding the
    // first request's day in the viewer's zone.
    expect(timeline.granularity).toBe("1day");
    const firstDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(
      new Date(dated.map((doc) => doc.createdAt).sort()[0]),
    );
    expect(timeline.data[0].hour).toBe(firstDay);
    expect(timeline.data[0].requests).toBeGreaterThan(0);

    const recent = await get("/admin/stats/timeline?hours=6&granularity=15s");
    expect(recent.granularity).toBe("15s");
    expect(recent.data.length).toBeGreaterThan(1000);
    const newest = recent.data.slice(-3).reduce((total: number, point: Doc) => total + point.requests, 0);
    expect(newest).toBeGreaterThanOrEqual(1);
  });

  it("pages traces in two passes exactly as the rows order them", async () => {
    const traces = [...groupBy(requests.filter((doc) => doc.traceId), (doc) => doc.traceId)].map(
      ([id, docs]) => ({
        id,
        requestCount: docs.length,
        totalCost: sum(docs, "estimatedCost"),
        // Legacy rows have no createdAt; $min ignores them.
        createdAt: docs.map((doc) => doc.createdAt).filter(Boolean).sort()[0] ?? null,
      }),
    );
    const cases: Array<[keyof (typeof traces)[number], "asc" | "desc"]> = [
      ["createdAt", "desc"],
      ["requestCount", "desc"],
      ["requestCount", "asc"],
      ["totalCost", "desc"],
    ];
    for (const [key, order] of cases) {
      const direction = order === "desc" ? -1 : 1;
      const expected = [...traces].sort((left, right) => {
        const [a, b] = [left[key], right[key]];
        if (a !== b) {
          if (a === null) return -direction;
          if (b === null) return direction;
          return (a < b ? -1 : 1) * direction;
        }
        return left.id < right.id ? -1 : 1;
      });
      for (const page of [1, 2]) {
        const body = await get(`/admin/traces?sort=${key}&order=${order}&page=${page}&limit=5`);
        const slice = expected.slice((page - 1) * 5, page * 5);
        expect(body.total).toBe(traces.length);
        expect(body.data.map((row: Doc) => row.id), `${key} ${order} p${page}`).toEqual(
          slice.map((trace) => trace.id),
        );
        for (const [index, row] of body.data.entries()) {
          expect(row.requestCount).toBe(slice[index].requestCount);
          expect(row.totalCost).toBeCloseTo(slice[index].totalCost, 9);
        }
      }
    }
    // A sort key the index cannot compute still pages (one pass).
    const byProject = await get("/admin/traces?sort=project&order=asc&limit=5");
    expect(byProject.data).toHaveLength(5);
  });
});

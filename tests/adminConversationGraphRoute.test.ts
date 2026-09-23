/**
 * GET /agent-conversations/:id/graph — the nodes view's data source.
 *
 * A request's pending → completed/failed transition does not change the
 * request COUNT, which was the whole cache key: a rebuild inside the TTL
 * was served the pending graph and the node never left "in flight". The
 * client now sends its fingerprint of the rows it holds as `v`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import { conversationStatsRouter } from "#src/routes/admin/AdminAgentConversationRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { clearGraphCache } from "#src/services/conversation/ConversationGraphCache";

app.use("/graph-route-test", conversationStatsRouter);

type Row = Record<string, unknown>;

describe("GET /agent-conversations/:id/graph", () => {
  const agent = supertest(app);
  const conversation = {
    id: "conv-graph",
    title: "Graph route",
    project: "prism-chat",
    agent: "CODING",
    messages: [{ role: "user", content: "Audit the payments stack" }],
  };
  let requestRows: Row[] = [];

  const requestsCollection = {
    distinct: async (field: string, query: Row) =>
      field === "agentConversationId" && query.conversationId ? ["agent-turn-1"] : [],
    countDocuments: async () => requestRows.length,
    find: () => {
      const cursor = {
        project: () => cursor,
        sort: () => cursor,
        toArray: async () => requestRows.map((row) => ({ ...row })),
      };
      return cursor;
    },
  };
  const mockDb = {
    collection: (collectionName: string) =>
      collectionName === COLLECTIONS.AGENT_CONVERSATIONS
        ? { findOne: async () => conversation }
        : requestsCollection,
  };

  const requestNode = (body: { nodes: { id: string; metadata?: Row }[] }) =>
    body.nodes.find((node) => node.id === "request:req-1")!;

  beforeEach(() => {
    // A frozen clock keeps every request inside the cache's 500 ms TTL, so
    // a stale-cache regression fails deterministically, even under load.
    vi.useFakeTimers({ toFake: ["Date"] });
    clearGraphCache();
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as never);
    requestRows = [{
      _id: "req-1",
      agentConversationId: "agent-turn-1",
      conversationId: "conv-graph",
      createdAt: "2026-09-23T15:00:00Z",
      operation: "agent:iteration",
      status: "pending",
      success: null,
    }];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the failed request, not the cached pending one, once the client's version moves", async () => {
    const pending = await agent.get("/graph-route-test/conv-graph/graph?width=1600&height=1000&v=one");
    expect(pending.status).toBe(200);
    expect(requestNode(pending.body).metadata?.status).toBe("pending");

    // Fails fast: same row, same count, inside the TTL (the clock is frozen).
    requestRows[0] = { ...requestRows[0], status: "completed", success: false, errorMessage: "400 invalid_request", totalTime: 0.3 };
    const failed = await agent.get("/graph-route-test/conv-graph/graph?width=1600&height=1000&v=two");

    const metadata = requestNode(failed.body).metadata!;
    expect(metadata.status).toBe("completed");
    expect(metadata.success).toBe(false);
    expect(metadata.errorMessage).toBe("400 invalid_request");
    expect(metadata.duration).toBe(0.3);
  });

  it("still answers a burst at the same version from the cache", async () => {
    await agent.get("/graph-route-test/conv-graph/graph?width=1600&height=1000&v=same");
    requestRows[0] = { ...requestRows[0], status: "completed", success: true };
    const again = await agent.get("/graph-route-test/conv-graph/graph?width=1600&height=1000&v=same");

    expect(requestNode(again.body).metadata?.status).toBe("pending");
  });

  it("totals the conversation node from the rows it fetched", async () => {
    requestRows = [
      { ...requestRows[0], status: "completed", success: true, estimatedCost: 0.02, inputTokens: 900, outputTokens: 100 },
      { ...requestRows[0], _id: "req-2", createdAt: "2026-09-23T15:00:30Z", status: "completed", success: true, estimatedCost: 0.03, inputTokens: 1000, outputTokens: 200 },
    ];
    const response = await agent.get("/graph-route-test/conv-graph/graph?v=totals");

    const sessionNode = response.body.nodes.find((node: { category: string }) => node.category === "session");
    expect(sessionNode.metadata.requestCount).toBe(2);
    expect(sessionNode.metadata.totalCost).toBeCloseTo(0.05);
    expect(sessionNode.metadata.totalTokens).toBe(2200);
    expect(sessionNode.metadata.totalElapsedTime).toBe(30);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { COLLECTIONS } from "../src/constants.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
  GATEWAY_SECRET: "test-secret",
}));

describe("hasSubAgents Derivation — Defense-in-Depth Tests", () => {
  let mockAgentConversations: Record<string, unknown>[] = [];
  let mockModelConversations: Record<string, unknown>[] = [];
  let mockAgentDistinctParents: string[] = [];
  let mockModelDistinctParents: string[] = [];
  let shouldDistinctFail = false;

  beforeEach(async () => {
    const { app } = await import("./setup.ts");
    const conversationsRouter = (
      await import("../src/routes/ConversationsRoutes.ts")
    ).default;
    const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts"))
      .default;

    try {
      app.use("/conversations", conversationsRouter);
    } catch {
      // Router already mounted from a previous test run — safe to ignore
    }

    mockAgentConversations = [];
    mockModelConversations = [];
    mockAgentDistinctParents = [];
    mockModelDistinctParents = [];
    shouldDistinctFail = false;

    const mockDatabase = {
      collection: (collectionName: string) => {
        return {
          find: () => {
            let documents: Record<string, unknown>[] = [];
            if (collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
              documents = mockAgentConversations;
            } else if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
              documents = mockModelConversations;
            }

            const queryChain = {
              project: () => queryChain,
              sort: () => queryChain,
              skip: () => queryChain,
              limit: () => queryChain,
              toArray: async () => documents,
            };
            return queryChain;
          },
          countDocuments: async () => {
            if (collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
              return mockAgentConversations.length;
            }
            if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
              return mockModelConversations.length;
            }
            return 0;
          },
          distinct: async () => {
            if (shouldDistinctFail) {
              throw new Error("Simulated database failure for distinct query");
            }
            if (collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
              return mockAgentDistinctParents;
            }
            if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
              return mockModelDistinctParents;
            }
            return [];
          },
          aggregate: () => ({
            toArray: async () => [],
          }),
        };
      },
    };

    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDatabase as never);
  });

  // ── subAgents array derivation (the primary source of truth) ─────────

  it("should derive hasSubAgents=true from a non-empty subAgents array even when distinct enrichment finds nothing", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "session-with-subagents-array",
        title: "Team Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        subAgents: [
          { sessionId: "child-1", agent: "RESEARCHER" },
          { sessionId: "child-2", agent: "CODER" },
        ],
      },
    ];

    // Distinct returns nothing — simulates the old broken enrichment
    mockAgentDistinctParents = [];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "session-with-subagents-array",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBe(true);
  });

  it("should strip the subAgents array from the list response payload to avoid sending heavy data", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "session-with-subagents-array",
        title: "Team Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        subAgents: [
          { sessionId: "child-1", agent: "RESEARCHER" },
          { sessionId: "child-2", agent: "CODER" },
        ],
      },
    ];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "session-with-subagents-array",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.subAgents).toBeUndefined();
  });

  it("should NOT set hasSubAgents when subAgents array is empty and distinct enrichment finds nothing", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "session-empty-subagents",
        title: "Solo Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        subAgents: [],
      },
    ];

    mockAgentDistinctParents = [];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "session-empty-subagents",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBeUndefined();
  });

  it("should NOT set hasSubAgents when subAgents field is absent and distinct enrichment finds nothing", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "session-no-subagents-field",
        title: "Legacy Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
      },
    ];

    mockAgentDistinctParents = [];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "session-no-subagents-field",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBeUndefined();
  });

  // ── Belt-and-suspenders: distinct enrichment still works as fallback ─

  it("should still set hasSubAgents=true via distinct enrichment when subAgents array is absent (pre-migration sessions)", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "legacy-parent-session",
        title: "Legacy Parent",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        // No subAgents array — pre-migration document
      },
    ];

    // Distinct finds a child pointing to this parent
    mockAgentDistinctParents = ["legacy-parent-session"];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "legacy-parent-session",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBe(true);
  });

  // ── Resilience: distinct fails but subAgents array provides truth ────

  it("should derive hasSubAgents from subAgents array even when the distinct query throws an error", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "resilient-session",
        title: "Resilient Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        subAgents: [{ sessionId: "child-1", agent: "RESEARCHER" }],
      },
    ];

    // Force the distinct query to fail
    shouldDistinctFail = true;

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) => item.id === "resilient-session",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBe(true);
  });

  // ── Both sources agree — no double-write side effects ───────────────

  it("should produce hasSubAgents=true (not duplicated or conflicting) when both distinct and subAgents array agree", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "both-sources-session",
        title: "Both Sources",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        subAgents: [{ sessionId: "child-1", agent: "RESEARCHER" }],
      },
    ];

    // Distinct also knows about this parent
    mockAgentDistinctParents = ["both-sources-session"];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) => item.id === "both-sources-session",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBe(true);
    // subAgents array must still be stripped
    expect(sessionItem.subAgents).toBeUndefined();
  });

  // ── Model (direct) conversations: subAgents derivation applies too ──

  it("should derive hasSubAgents from subAgents array on model (direct) conversations", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockModelConversations = [
      {
        id: "direct-chat-with-team",
        title: "Direct Chat with Team",
        updatedAt: new Date().toISOString(),
        subAgents: [{ sessionId: "child-1", agent: "RESEARCHER" }],
      },
    ];

    mockModelDistinctParents = [];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "direct-chat-with-team",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBe(true);
    expect(sessionItem.subAgents).toBeUndefined();
    expect(sessionItem.type).toBe("direct");
  });

  // ── Pre-existing hasSubAgents boolean is preserved ──────────────────

  it("should preserve an already-true hasSubAgents boolean even if subAgents array is absent", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "pre-existing-flag-session",
        title: "Pre-existing Flag",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
        hasSubAgents: true,
        // No subAgents array — the boolean was set by OrchestratorService
      },
    ];

    mockAgentDistinctParents = [];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const sessionItem = apiResponse.body.items.find(
      (item: Record<string, unknown>) =>
        item.id === "pre-existing-flag-session",
    );
    expect(sessionItem).toBeDefined();
    expect(sessionItem.hasSubAgents).toBe(true);
  });
});

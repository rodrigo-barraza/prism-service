import { describe, it, expect, vi, beforeEach } from "vitest";
import { COLLECTIONS } from "../src/constants.ts";

// Mock logger
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
}));

describe("Conversation Sub-agents Enrichment Integration Tests", () => {
  let mockAgentConversations: any[] = [];
  let mockModelConversations: any[] = [];
  let mockAgentDistinctParents: string[] = [];
  let mockModelDistinctParents: string[] = [];
  let shouldDistinctFail = false;

  beforeEach(async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");
    const conversationsRouter = (await import("../src/routes/ConversationsRoutes.ts")).default;
    const MongoWrapper = (await import("../src/wrappers/MongoWrapper.ts")).default;

    try {
      app.use("/conversations", conversationsRouter);
    } catch (ignoreError) {}

    // Reset default mock data
    mockAgentConversations = [];
    mockModelConversations = [];
    mockAgentDistinctParents = [];
    mockModelDistinctParents = [];
    shouldDistinctFail = false;

    const mockDb = {
      collection: (collectionName: string) => {
        return {
          find: (queryFilter: any) => {
            let documents: any[] = [];
            if (queryFilter && queryFilter.parentConversationId) {
              if (collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
                documents = mockAgentDistinctParents.map((parentId) => ({ parentConversationId: parentId }));
              } else if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
                documents = mockModelDistinctParents.map((parentId) => ({ parentConversationId: parentId }));
              }
            } else {
              if (collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
                documents = mockAgentConversations;
              } else if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
                documents = mockModelConversations;
              }
            }

            const chain = {
              project: () => chain,
              sort: () => chain,
              skip: () => chain,
              limit: () => chain,
              toArray: async () => {
                if (shouldDistinctFail && queryFilter && queryFilter.parentConversationId) {
                  throw new Error("Simulated database failure for child lookup query");
                }
                return documents;
              },
            };
            return chain;
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
          distinct: async (field: string, queryFilter: any) => {
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
          aggregate: (pipeline: any[]) => {
            return {
              toArray: async () => [],
            };
          },
        };
      },
    };

    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  it("should enrich both model and agent conversations with hasSubAgents flag when matches are found in distinct parent lists", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "parent-agent-session",
        title: "Agent Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
      },
      {
        id: "other-agent-session",
        title: "Other Agent",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
      },
    ];

    mockModelConversations = [
      {
        id: "parent-model-session",
        title: "Direct Chat",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "other-model-session",
        title: "Other Chat",
        updatedAt: new Date().toISOString(),
      },
    ];

    // Mock parent IDs that have children in the database
    mockAgentDistinctParents = ["parent-agent-session"];
    mockModelDistinctParents = ["parent-model-session"];

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const items = apiResponse.body.items;
    expect(items).toBeDefined();

    const parentAgentItem = items.find((item: any) => item.id === "parent-agent-session");
    const otherAgentItem = items.find((item: any) => item.id === "other-agent-session");
    const parentModelItem = items.find((item: any) => item.id === "parent-model-session");
    const otherModelItem = items.find((item: any) => item.id === "other-model-session");

    expect(parentAgentItem).toBeDefined();
    expect(parentAgentItem.hasSubAgents).toBe(true);

    expect(otherAgentItem).toBeDefined();
    expect(otherAgentItem.hasSubAgents).toBeUndefined();

    expect(parentModelItem).toBeDefined();
    expect(parentModelItem.hasSubAgents).toBe(true);

    expect(otherModelItem).toBeDefined();
    expect(otherModelItem.hasSubAgents).toBeUndefined();
  });

  it("should not crash and still return items when the database distinct call fails", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "agent-session",
        title: "Agent Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
      },
    ];
    shouldDistinctFail = true;

    const apiResponse = await request(app)
      .get("/conversations?type=all&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const items = apiResponse.body.items;
    expect(items).toBeDefined();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("agent-session");
    expect(items[0].hasSubAgents).toBeUndefined();
  });

  it("should handle the type filter correctly when type=direct or type=agent", async () => {
    const request = (await import("supertest")).default;
    const { app } = await import("./setup.ts");

    mockAgentConversations = [
      {
        id: "parent-agent-session",
        title: "Agent Session",
        updatedAt: new Date().toISOString(),
        agent: "OMNI",
      },
    ];

    mockModelConversations = [
      {
        id: "parent-model-session",
        title: "Direct Chat",
        updatedAt: new Date().toISOString(),
      },
    ];

    mockAgentDistinctParents = ["parent-agent-session"];
    mockModelDistinctParents = ["parent-model-session"];

    // type=direct
    const directApiResponse = await request(app)
      .get("/conversations?type=direct&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    expect(directApiResponse.body.items).toHaveLength(1);
    expect(directApiResponse.body.items[0].id).toBe("parent-model-session");
    expect(directApiResponse.body.items[0].hasSubAgents).toBe(true);

    // type=agent
    const agentApiResponse = await request(app)
      .get("/conversations?type=agent&limit=20")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    expect(agentApiResponse.body.items).toHaveLength(1);
    expect(agentApiResponse.body.items[0].id).toBe("parent-agent-session");
    expect(agentApiResponse.body.items[0].hasSubAgents).toBe(true);
  });
});

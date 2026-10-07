/**
 * "Auto-approve this conversation" is stored where the conversation lives.
 *
 * The real `POST /agent/approve` handler, behind the real identity
 * middleware, writing through the real ConversationApprovalSettings into an
 * in-memory stand-in for Mongo. The decision itself is mocked
 * (AgenticLoopService.decideApproval) — what is under test is where the flag
 * lands. Seen live 2026-10-03: the Prism client sends its own project
 * (`prism-client`) while an agent's conversation lives under the agent's
 * (`prism-chat`), so every save matched nothing and the card toasted
 * "auto-approve could not be saved, so later turns will ask again".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

type Row = Record<string, any>;
const tables = new Map<string, Row[]>();

function rowsOf(name: string): Row[] {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name)!;
}

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => row[key] === value);
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () => ({
      collection: (name: string) => ({
        findOne: async (filter: Row) => rowsOf(name).find((row) => matches(row, filter)) ?? null,
        updateOne: async (filter: Row, update: { $set?: Row }) => {
          const row = rowsOf(name).find((candidate) => matches(candidate, filter));
          if (!row) return { matchedCount: 0, modifiedCount: 0 };
          for (const [path, value] of Object.entries(update.$set ?? {})) {
            const [field, key] = path.split(".");
            if (key) row[field] = { ...(row[field] ?? {}), [key]: value };
            else row[field] = value;
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
      }),
    }),
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const decideApproval = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: { decideApproval: (...args: unknown[]) => decideApproval(...args) },
}));
vi.mock("#src/services/ConversationAttentionRegistry", () => ({ default: { forget: vi.fn() } }));
vi.mock("#src/services/PendingDecisionStore", () => ({ default: { find: vi.fn(async () => []) } }));

const { handleApprovalDecision } = await import("#src/routes/ApprovalDecisionRoute");
const { authMiddleware } = await import("#src/middleware/AuthMiddleware");
const { default: ConversationApprovalSettings } = await import("#src/services/ConversationApprovalSettings");
const { COLLECTIONS } = await import("#src/constants");
const { userHeaders } = await import("../../../tests/helpers/auth.ts");

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.post("/agent/approve", (request, response) => handleApprovalDecision(request, response, "[agent/approve]"));
const http = supertest(app);

/** The turn that asked, as its decision recorded it. */
function decidedBy(owner: Row) {
  return {
    status: "decided",
    type: "tool",
    batchId: "batch-1",
    decidedToolCallIds: ["call-1"],
    remaining: 0,
    delivered: true,
    owner: {
      agent: "OMNI",
      agentConversationId: "server-minted",
      parentConversationId: null,
      conversationCollection: COLLECTIONS.AGENT_CONVERSATIONS,
      ...owner,
    },
  };
}

/** What the Prism client sends: its own project, and its signed-in user's token. */
function approveAsTheClient(body: Row, username = "anonymous") {
  return http
    .post("/agent/approve")
    .set("x-project", "prism-client")
    .set(userHeaders(username))
    .send({ toolCallId: "call-1", decision: "allow", ...body });
}

const agentConversations = () => rowsOf(COLLECTIONS.AGENT_CONVERSATIONS);

describe('"auto-approve this conversation" is stored on the conversation the user is in', () => {
  beforeEach(() => {
    tables.clear();
    decideApproval.mockReset();
  });

  it("an agent conversation under the agent's project, though the client sends its own (seen live 2026-10-03)", async () => {
    agentConversations().push({ id: "conv-a", project: "prism-chat", username: "anonymous" });
    decideApproval.mockResolvedValue(decidedBy({ project: "prism-chat", username: "anonymous" }));

    const response = await approveAsTheClient({ conversationId: "conv-a", scope: "conversation" });

    expect(response.status).toBe(200);
    expect(response.body.persisted).toBe(true);
    expect(agentConversations()[0].approvals).toMatchObject({ autoApprove: true });
    // ...which is what the conversation's next turn reads (AgenticLoopService).
    expect(await ConversationApprovalSettings.isAutoApproveEnabled("conv-a", "prism-chat", "anonymous")).toBe(true);
  });

  it("a sub-agent's card sets it on the root of the delegation tree, whose later turns read it", async () => {
    agentConversations().push(
      { id: "root", project: "coding", username: "rodrigo" },
      { id: "child", project: "coding", username: "rodrigo", isSubAgent: true, parentConversationId: "root" },
      { id: "grandchild", project: "coding", username: "rodrigo", isSubAgent: true, parentConversationId: "child" },
    );
    decideApproval.mockResolvedValue(
      decidedBy({ project: "coding", username: "rodrigo", parentConversationId: "child" }),
    );

    const response = await approveAsTheClient({ conversationId: "grandchild", scope: "conversation" }, "rodrigo");

    expect(response.body.persisted).toBe(true);
    const [root, child, grandchild] = agentConversations();
    expect(root.approvals).toMatchObject({ autoApprove: true });
    expect(child.approvals).toBeUndefined();
    expect(grandchild.approvals).toBeUndefined();
  });

  it("a decision from someone other than the turn's user is not stored", async () => {
    agentConversations().push({ id: "conv-b", project: "prism-chat", username: "rodrigo" });
    decideApproval.mockResolvedValue(decidedBy({ project: "prism-chat", username: "rodrigo" }));

    const response = await approveAsTheClient({ conversationId: "conv-b", scope: "conversation" }, "mallory");

    expect(response.status).toBe(200);
    expect(response.body.persisted).toBe(false);
    expect(agentConversations()[0].approvals).toBeUndefined();
  });

  it("a conversation that is not stored says so (the card's warning stays honest)", async () => {
    decideApproval.mockResolvedValue(decidedBy({ project: "prism-chat", username: "anonymous" }));
    const response = await approveAsTheClient({ conversationId: "never-stored", scope: "conversation" });
    expect(response.body.persisted).toBe(false);
  });

  it("a chain that loops back on itself stores nothing", async () => {
    agentConversations().push(
      { id: "a", project: "coding", username: "rodrigo", isSubAgent: true, parentConversationId: "b" },
      { id: "b", project: "coding", username: "rodrigo", isSubAgent: true, parentConversationId: "a" },
    );
    expect(await ConversationApprovalSettings.enableAutoApprove("a", "coding", "rodrigo")).toBe(false);
    expect(agentConversations().every((row) => row.approvals === undefined)).toBe(true);
  });

  it("an allow for one call stores nothing", async () => {
    agentConversations().push({ id: "conv-c", project: "prism-chat", username: "anonymous" });
    decideApproval.mockResolvedValue(decidedBy({ project: "prism-chat", username: "anonymous" }));

    const response = await approveAsTheClient({ conversationId: "conv-c" });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("persisted");
    expect(agentConversations()[0].approvals).toBeUndefined();
  });
});

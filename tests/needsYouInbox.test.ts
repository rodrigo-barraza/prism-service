/**
 * "Needs you" inbox — the conversation list and single-conversation
 * responses carry what each conversation is waiting on from its user.
 *
 * The waits are driven through the REAL event path: a turn's events go
 * through withDirectViewerBroadcast (the wrap every agent request gets), so
 * an `approval_required` or `user_question` the harness emits is what the
 * list reports — no registry is seeded by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import conversationsRouter from "#src/routes/ConversationsRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { withDirectViewerBroadcast } from "#src/utils/DirectViewerBroadcast";

app.use("/conversations", conversationsRouter);

const HEADERS = { "x-project": "test", "x-username": "testuser" };

function chainOf(list: unknown[]) {
  const chain: Record<string, unknown> = {
    project: () => chain,
    sort: () => chain,
    limit: () => chain,
    skip: () => chain,
    toArray: async () => list,
  };
  return chain;
}

function collectionOf(documents: Array<Record<string, unknown>>) {
  return {
    find: (query: Record<string, unknown> = {}) =>
      chainOf(
        query.id ? documents.filter((document) => document.id === query.id) : documents,
      ),
    findOne: async (query: Record<string, unknown>) =>
      documents.find((document) => document.id === query.id) ?? null,
  };
}

/** The emit a turn's events go through — the same wrap handleSseRequest applies. */
function turnEmitFor(conversationId: string) {
  return withDirectViewerBroadcast(conversationId, () => {});
}

describe("needs-you inbox — conversation list attention fields", () => {
  const agent = supertest(app);
  let agentConversations: Array<Record<string, unknown>>;
  let modelConversations: Array<Record<string, unknown>>;

  beforeEach(() => {
    const now = Date.now();
    agentConversations = [
      {
        id: "waiting-approval",
        project: "test",
        username: "testuser",
        title: "Writes files",
        isGenerating: true,
        isActive: true,
        updatedAt: new Date(now).toISOString(),
        messages: [],
      },
      {
        id: "idle",
        project: "test",
        username: "testuser",
        title: "Nothing pending",
        isActive: false,
        updatedAt: new Date(now - 1000).toISOString(),
        messages: [],
      },
    ];
    modelConversations = [];
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: (name: string) => {
        if (name === COLLECTIONS.AGENT_CONVERSATIONS) return collectionOf(agentConversations);
        if (name === COLLECTIONS.MODEL_CONVERSATIONS) return collectionOf(modelConversations);
        if (name === COLLECTIONS.REQUESTS) return { aggregate: () => chainOf([]) };
        return collectionOf([]);
      },
    } as never);
  });

  afterEach(() => {
    // End every turn this test opened so no wait leaks into the next test.
    turnEmitFor("waiting-approval")({ type: "done" });
    turnEmitFor("idle")({ type: "done" });
  });

  it("a conversation with a pending approval exposes pendingApprovalCount = 1 and state awaiting-approval", async () => {
    turnEmitFor("waiting-approval")({
      type: "approval_required",
      toolCall: { id: "call-1", name: "write_file", args: { path: "a.txt" } },
      tier: 2,
    });

    const response = await agent.get("/conversations?limit=10").set(HEADERS).expect(200);
    const byId = Object.fromEntries(
      response.body.items.map((item: { id: string }) => [item.id, item]),
    );

    expect(byId["waiting-approval"]).toMatchObject({
      pendingApprovalCount: 1,
      pendingQuestionCount: 0,
      state: "awaiting-approval",
    });
    expect(typeof byId["waiting-approval"].awaitingSince).toBe("string");
    expect(byId.idle).toMatchObject({
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      awaitingSince: null,
      state: "completed",
    });
  });

  it("the single-conversation GET carries the same fields", async () => {
    turnEmitFor("waiting-approval")({
      type: "approval_required",
      toolCall: { id: "call-1", name: "write_file", args: {} },
    });

    const response = await agent
      .get("/conversations/waiting-approval")
      .set(HEADERS)
      .expect(200);
    expect(response.body).toMatchObject({
      pendingApprovalCount: 1,
      pendingQuestionCount: 0,
      state: "awaiting-approval",
    });
  });

  it("a pending question reads awaiting-answer, and the answer clears it", async () => {
    const emit = turnEmitFor("waiting-approval");
    emit({ type: "user_question", questionId: "q-1", blocking: true, questions: [] });

    let response = await agent.get("/conversations/waiting-approval").set(HEADERS).expect(200);
    expect(response.body).toMatchObject({
      pendingApprovalCount: 0,
      pendingQuestionCount: 1,
      state: "awaiting-answer",
    });

    // The blocking ask_user call returns once answered.
    emit({
      type: "tool_execution",
      status: "done",
      tool: { id: "ask-1", name: "ask_user", result: { questionId: "q-1", answers: [] } },
    });
    response = await agent.get("/conversations/waiting-approval").set(HEADERS).expect(200);
    expect(response.body).toMatchObject({
      pendingQuestionCount: 0,
      awaitingSince: null,
      state: "generating",
    });
  });

  it("executing (or rejecting) the approved call ends the wait", async () => {
    const emit = turnEmitFor("waiting-approval");
    emit({ type: "approval_required", toolCall: { id: "call-1", name: "write_file" } });
    emit({ type: "approval_required", toolCall: { id: "call-2", name: "write_file" } });
    emit({ type: "tool_execution", status: "done", tool: { id: "call-1", name: "write_file", result: {} } });

    let response = await agent.get("/conversations/waiting-approval").set(HEADERS).expect(200);
    expect(response.body.pendingApprovalCount).toBe(1);

    emit({ type: "tool_execution", status: "error", tool: { id: "call-2", name: "write_file", result: { error: "USER_REJECTED" } } });
    response = await agent.get("/conversations/waiting-approval").set(HEADERS).expect(200);
    expect(response.body).toMatchObject({ pendingApprovalCount: 0, state: "generating" });
  });
});

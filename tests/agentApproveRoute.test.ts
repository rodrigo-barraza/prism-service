/**
 * POST /agent/approve — per-call decisions that fail closed.
 *
 * Pending write_file calls are parked at the REAL ApprovalGate (real
 * AutoApprovalEngine, so the tier decides they need a human). A body that
 * does not say "allow" in so many words must be refused with 400 and must
 * leave the call pending; a string "false" is not a boolean and is not a yes.
 * Unknown ids are 404, already-decided ones 409, and edited arguments are
 * held to the tool's schema.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import agentRouter from "#src/routes/AgentRoutes";
import conversationExecutionRouter from "#src/routes/ConversationExecutionRoute";
import AgenticLoopService from "#src/services/AgenticLoopService";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { checkAndWaitForApproval } from "#src/services/harnesses/lifecycle/ApprovalGate";
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import ConversationApprovalSettings from "#src/services/ConversationApprovalSettings";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";

app.use("/agent", agentRouter);
app.use("/conversation", conversationExecutionRouter);

const http = supertest(app);

const WRITE_FILE_SCHEMA = {
  name: "write_file",
  description: "Write a file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
};

/** Park WRITE-tier calls at the gate and wait for their approval_required events. */
async function parkWriteCalls(conversationId: string, toolCallIds: string[]) {
  const events: Array<Record<string, unknown>> = [];
  let settled = false;
  const verdict = checkAndWaitForApproval(
    toolCallIds.map((id) => ({ id, name: "write_file", args: { path: `${id}.txt`, content: id } })),
    {
      conversationId,
      agentConversationId: `agent-${conversationId}`,
      emit: (event: Record<string, unknown>) => events.push(event),
      options: {},
    } as never,
    new AutoApprovalEngine({ fullAuto: false }),
    { toolSchemas: [WRITE_FILE_SCHEMA] },
  ).then((value) => {
    settled = true;
    return value;
  });
  await expect
    .poll(() => events.filter((event) => event.type === "approval_required").length)
    .toBe(toolCallIds.length);
  const batchId = events.find((event) => event.type === "approval_required")?.batchId as string;
  return { verdict, events, batchId, isSettled: () => settled };
}

async function parkWriteCall(conversationId: string, toolCallId = "call-w") {
  return parkWriteCalls(conversationId, [toolCallId]);
}

describe("POST /agent/approve — fails closed", () => {
  const parked: Array<{ conversationId: string }> = [];

  afterEach(async () => {
    // Release anything a test left parked (an explicit deny, strict boolean).
    for (const { conversationId } of parked.splice(0)) {
      await http.post("/agent/approve").send({ conversationId, approved: false });
    }
  });

  it("400 when neither `decision` nor `approved` is given — and the call stays pending", async () => {
    const conversationId = "approve-missing-field";
    const { isSettled } = await parkWriteCall(conversationId);
    parked.push({ conversationId });

    const response = await http.post("/agent/approve").send({ conversationId });

    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isSettled()).toBe(false);
    expect(AgenticLoopService.getPendingApproval(conversationId).isPending).toBe(true);
  });

  it('400 for `approved: "false"` (a string is not a boolean) — and the call stays pending', async () => {
    const conversationId = "approve-string-false";
    const { isSettled } = await parkWriteCall(conversationId);
    parked.push({ conversationId });

    const response = await http
      .post("/agent/approve")
      .send({ conversationId, approved: "false" });

    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isSettled()).toBe(false);
  });

  it("the legacy /conversation/approve alias fails closed the same way", async () => {
    const conversationId = "conversation-approve-missing-field";
    const { isSettled } = await parkWriteCall(conversationId);
    parked.push({ conversationId });

    const response = await http.post("/conversation/approve").send({ conversationId });

    expect(response.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isSettled()).toBe(false);
  });
});

describe("POST /agent/approve — one decision per call", () => {
  afterEach(() => {
    ApprovalRegistry._clearAll();
    vi.mocked(MongoWrapper.getDb).mockReset();
  });

  it("404 when nothing is pending for the conversation, or the toolCallId was never issued", async () => {
    const nothing = await http
      .post("/agent/approve")
      .send({ conversationId: "approve-nothing-pending", toolCallId: "x", decision: "allow" });
    expect(nothing.status).toBe(404);

    await parkWriteCall("approve-unknown-id", "known");
    const unknown = await http
      .post("/agent/approve")
      .send({ conversationId: "approve-unknown-id", toolCallId: "never-issued", decision: "allow" });
    expect(unknown.status).toBe(404);
    expect(AgenticLoopService.getPendingApproval("approve-unknown-id").isPending).toBe(true);
  });

  it("409 for a toolCallId from an earlier batch, and for a card of a superseded batch", async () => {
    const conversationId = "approve-stale";
    const first = await parkWriteCall(conversationId, "early");
    expect(
      (await http.post("/agent/approve").send({ conversationId, toolCallId: "early", decision: "allow" })).status,
    ).toBe(200);
    await first.verdict;

    // The next batch is waiting; a late click on the first batch's card:
    const second = await parkWriteCall(conversationId, "later");
    const late = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "early", decision: "deny" });
    expect(late.status).toBe(409);
    // A card whose batchId is not the pending batch's is stale too.
    const wrongBatch = await http
      .post("/agent/approve")
      .send({ conversationId, toolCallId: "later", batchId: first.batchId, decision: "allow" });
    expect(wrongBatch.status).toBe(409);
    expect(second.isSettled()).toBe(false);
  });

  it("400 when several calls are pending and the body names none — nothing is decided", async () => {
    const conversationId = "approve-ambiguous";
    const { isSettled } = await parkWriteCalls(conversationId, ["a", "b"]);

    const response = await http.post("/agent/approve").send({ conversationId, approved: true });

    expect(response.status).toBe(400);
    expect(response.body.pendingToolCallIds).toEqual(["a", "b"]);
    expect(AgenticLoopService.getPendingApproval(conversationId).toolCalls).toHaveLength(2);
    expect(isSettled()).toBe(false);
  });

  it("editedArgs: 400 when they break the tool's schema; applied and recorded when valid", async () => {
    const conversationId = "approve-edited";
    const { verdict } = await parkWriteCall(conversationId, "edit-me");

    const invalid = await http.post("/agent/approve").send({
      conversationId,
      toolCallId: "edit-me",
      decision: "allow",
      editedArgs: { path: 7 },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/path|content/);
    expect(AgenticLoopService.getPendingApproval(conversationId).isPending).toBe(true);

    const valid = await http.post("/agent/approve").send({
      conversationId,
      toolCallId: "edit-me",
      decision: "allow",
      editedArgs: { path: "renamed.txt", content: "edited" },
    });
    expect(valid.status).toBe(200);

    const { executableToolCalls } = await verdict;
    expect(executableToolCalls[0].args).toEqual({ path: "renamed.txt", content: "edited" });
    expect(executableToolCalls[0]._approval).toMatchObject({
      isApproved: true,
      editedByUser: true,
      originalArgs: { path: "edit-me.txt", content: "edit-me" },
    });
  });

  it('scope "conversation" allows the batch and persists on THAT conversation only, past the turn end', async () => {
    const agentConversations = createMockCollection([
      { id: "conversation-a", project: "test", username: "testuser", settings: { model: "m" } },
      { id: "conversation-b", project: "test", username: "testuser", settings: { model: "m" } },
    ]);
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: (name: string) =>
        name === COLLECTIONS.AGENT_CONVERSATIONS ? agentConversations : createMockCollection(),
    } as never);

    const { verdict } = await parkWriteCalls("conversation-a", ["one", "two"]);
    const response = await http
      .post("/agent/approve")
      .set("x-project", "test")
      .set("x-username", "testuser")
      .send({ conversationId: "conversation-a", toolCallId: "one", decision: "allow", scope: "conversation" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ persisted: true, decidedToolCallIds: ["one", "two"] });
    const { executableToolCalls, shouldApproveAll } = await verdict;
    expect(executableToolCalls.map((toolCall) => toolCall.id)).toEqual(["one", "two"]);
    expect(shouldApproveAll).toBe(true);

    expect(agentConversations._docs.get("conversation-a").approvals).toMatchObject({ autoApprove: true });
    expect(agentConversations._docs.get("conversation-b").approvals).toBeUndefined();
    expect(await ConversationApprovalSettings.isAutoApproveEnabled("conversation-a", "test", "testuser")).toBe(true);
    expect(await ConversationApprovalSettings.isAutoApproveEnabled("conversation-b", "test", "testuser")).toBe(false);

    // The turn finalizer rewrites `settings` wholesale when the turn ends
    // (ConversationService.appendMessages). The flag must survive that —
    // live, it did not while it lived inside `settings`.
    await agentConversations.updateOne(
      { id: "conversation-a" },
      { $set: { settings: { provider: "google", model: "gemini-3.6-flash" } } },
    );
    expect(await ConversationApprovalSettings.isAutoApproveEnabled("conversation-a", "test", "testuser")).toBe(true);
  });
});

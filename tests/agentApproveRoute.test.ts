/**
 * POST /agent/approve fails closed.
 *
 * A pending write_file call is parked at the REAL ApprovalGate (real
 * AutoApprovalEngine, so the tier decides it needs a human). A body that does
 * not say "allow" in so many words must be refused with 400 and must leave
 * the call pending; a string "false" is not a boolean and is not a yes.
 */
import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import agentRouter from "#src/routes/AgentRoutes";
import conversationExecutionRouter from "#src/routes/ConversationExecutionRoute";
import AgenticLoopService from "#src/services/AgenticLoopService";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { checkAndWaitForApproval } from "#src/services/harnesses/lifecycle/ApprovalGate";

app.use("/agent", agentRouter);
app.use("/conversation", conversationExecutionRouter);

const http = supertest(app);

/** Park one WRITE-tier call at the gate and wait for its approval_required event. */
async function parkWriteCall(conversationId: string, toolCallId = "call-w") {
  const events: Array<Record<string, unknown>> = [];
  let settled = false;
  const verdict = checkAndWaitForApproval(
    [{ id: toolCallId, name: "write_file", args: { path: "a.txt", content: "a" } }],
    {
      conversationId,
      agentConversationId: `agent-${conversationId}`,
      emit: (event: Record<string, unknown>) => events.push(event),
      options: {},
    } as never,
    new AutoApprovalEngine({ fullAuto: false }),
  ).then((value) => {
    settled = true;
    return value;
  });
  await expect
    .poll(() => events.some((event) => event.type === "approval_required"))
    .toBe(true);
  return { verdict, events, isSettled: () => settled };
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

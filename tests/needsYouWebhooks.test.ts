/**
 * "Needs you" webhooks — approval.required, question.asked, turn.completed,
 * turn.failed (from the turn's own events, through the same wrap every
 * agent request gets) and goal.updated (from ConversationGoalService).
 * Each is emitted exactly once per occurrence, with the payload a
 * subscriber needs to act on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import WebhookEventBus, { type WebhookEvent } from "#src/services/WebhookEventBus";
import { withDirectViewerBroadcast } from "#src/utils/DirectViewerBroadcast";
import { requestContext } from "#src/utils/RequestContext";
import { resetTurnAttentionObserver } from "#src/services/TurnAttentionObserver";
import ConversationAttentionRegistry from "#src/services/ConversationAttentionRegistry";
import ConversationGoalService from "#src/services/ConversationGoalService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";

const OWNER = {
  project: "prism-test",
  username: "rodrigo",
  profileId: "default",
  clientIp: null,
  agent: "CODING",
};

const NEEDS_YOU_TYPES = new Set([
  "approval.required",
  "question.asked",
  "budget.reached",
  "goal.updated",
  "turn.completed",
  "turn.failed",
]);

/** Emit events the way a turn does: inside its request, through the wrap. */
function runTurn(conversationId: string, events: Array<Record<string, unknown>>) {
  requestContext.run(OWNER, () => {
    const emit = withDirectViewerBroadcast(conversationId, () => {});
    for (const event of events) emit(event);
  });
}

describe("needs-you webhook events", () => {
  let received: WebhookEvent[];
  const listener = vi.fn((event: WebhookEvent) => {
    if (NEEDS_YOU_TYPES.has(event.eventType)) received.push(event);
  });

  beforeEach(() => {
    received = [];
    listener.mockClear();
    resetTurnAttentionObserver();
    ConversationAttentionRegistry.reset();
    WebhookEventBus.subscribe(listener);
  });

  afterEach(() => {
    WebhookEventBus.unsubscribe(listener);
  });

  it("approval.required — once per call, with the call and its owner", () => {
    runTurn("conversation-approval", [
      {
        type: "approval_required",
        toolCall: { id: "call-1", name: "write_file", args: { path: "a.txt" } },
        tier: 2,
        tierLabel: "Write",
      },
      {
        type: "approval_required",
        toolCall: { id: "call-2", name: "execute_command", args: { command: "ls" } },
        tier: 3,
      },
    ]);

    expect(received.map((event) => event.eventType)).toEqual([
      "approval.required",
      "approval.required",
    ]);
    expect(received[0].data).toEqual({
      conversationId: "conversation-approval",
      project: "prism-test",
      username: "rodrigo",
      profileId: "default",
      agent: "CODING",
      toolCallId: "call-1",
      toolName: "write_file",
      args: { path: "a.txt" },
      tier: 2,
      tierLabel: "Write",
      batchId: null,
    });
    expect(received[1].data).toMatchObject({ toolCallId: "call-2", toolName: "execute_command" });
  });

  it("question.asked — once, with the question texts", () => {
    runTurn("conversation-question", [
      {
        type: "user_question",
        questionId: "q-1",
        blocking: false,
        context: "Picking a colour",
        questions: [{ question: "Which colour?", options: [{ label: "red" }] }],
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventType: "question.asked",
      data: {
        conversationId: "conversation-question",
        username: "rodrigo",
        questionId: "q-1",
        blocking: false,
        questions: ["Which colour?"],
        context: "Picking a colour",
      },
    });
  });

  it("budget.reached — once per pause, with the spend against the cap", () => {
    runTurn("conversation-budget", [
      { type: "status", message: "budget_reached", pauseId: "pause-1", spentDollars: 2, maxCostDollars: 1.5, limitedBy: "goal", iteration: 3 },
      { type: "status", message: "budget_resolved", pauseId: "pause-1", action: "raise", source: "user", maxCostDollars: 5 },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventType: "budget.reached",
      data: {
        conversationId: "conversation-budget",
        username: "rodrigo",
        pauseId: "pause-1",
        spentDollars: 2,
        maxCostDollars: 1.5,
        limitedBy: "goal",
      },
    });
  });

  it("turn.completed — once per turn, even when the turn emits `done` twice", () => {
    runTurn("conversation-done", [
      { type: "chunk", content: "hi" },
      { type: "done", provider: "anthropic", model: "claude-sonnet-5", estimatedCost: 0.01, totalTime: 2.5 },
      { type: "done" },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventType: "turn.completed",
      data: {
        conversationId: "conversation-done",
        provider: "anthropic",
        model: "claude-sonnet-5",
        estimatedCost: 0.01,
        totalTime: 2.5,
      },
    });

    // The next turn of the same conversation reports its own end.
    runTurn("conversation-done", [{ type: "user_message" }, { type: "done" }]);
    expect(received).toHaveLength(2);
  });

  it("turn.failed — once, with the error message", () => {
    runTurn("conversation-failed", [
      { type: "chunk", content: "…" },
      { type: "error", message: "Provider returned 529", code: "OVERLOADED" },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventType: "turn.failed",
      data: {
        conversationId: "conversation-failed",
        message: "Provider returned 529",
        code: "OVERLOADED",
      },
    });
  });

  it("ordinary events emit nothing", () => {
    runTurn("conversation-quiet", [
      { type: "chunk", content: "hello" },
      { type: "tool_execution", status: "calling", tool: { id: "call-1", name: "read_file" } },
      { type: "status", message: "thinking" },
    ]);
    expect(received).toHaveLength(0);
  });

  describe("goal.updated", () => {
    let agentConversations: ReturnType<typeof createMockCollection>;

    beforeEach(() => {
      agentConversations = createMockCollection([
        { id: "conversation-goal", project: "prism-test", username: "rodrigo" },
      ]);
      vi.mocked(MongoWrapper.getDb).mockReturnValue({
        collection: (name: string) =>
          name === COLLECTIONS.AGENT_CONVERSATIONS ? agentConversations : createMockCollection(),
      } as never);
    });

    it("fires once per meaningful change, with or without a turn stream", async () => {
      await ConversationGoalService.set("conversation-goal", "prism-test", "rodrigo", {
        objective: "Ship the inbox",
      });
      // Not meaningful (percent moves < 10 points): no event.
      await ConversationGoalService.update("conversation-goal", "prism-test", "rodrigo", {
        percent: 4,
      });
      await ConversationGoalService.update(
        "conversation-goal",
        "prism-test",
        "rodrigo",
        { status: "completed" },
        { emit: vi.fn() },
      );

      expect(received.map((event) => [event.eventType, event.data.change])).toEqual([
        ["goal.updated", "set"],
        ["goal.updated", "status"],
      ]);
      expect(received[1].data).toMatchObject({
        conversationId: "conversation-goal",
        project: "prism-test",
        username: "rodrigo",
        goal: { objective: "Ship the inbox", status: "completed" },
      });
    });
  });
});

/**
 * ConversationAttentionRegistry — which events open and close a wait, and
 * that every change (and only a change) is published on the change stream.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import ConversationAttentionRegistry, {
  ATTENTION_CHANGE_COLLECTION,
} from "#src/services/ConversationAttentionRegistry";
import ChangeStreamService, {
  type ChangeStreamEventPayload,
} from "#src/services/ChangeStreamService";

const CONVERSATION = "conversation-attention";

describe("ConversationAttentionRegistry", () => {
  let published: ChangeStreamEventPayload[];
  const listener = (payload: ChangeStreamEventPayload) => published.push(payload);
  const observe = (event: Record<string, unknown>) =>
    ConversationAttentionRegistry.observeEvent(CONVERSATION, event);
  const attention = () => ConversationAttentionRegistry.get(CONVERSATION);

  beforeEach(() => {
    published = [];
    ConversationAttentionRegistry.reset();
    ChangeStreamService.subscribe(listener);
  });

  afterEach(() => {
    ChangeStreamService.unsubscribe(listener);
    ConversationAttentionRegistry.reset();
    vi.useRealTimers();
  });

  it("counts one approval per call and reports the oldest wait", () => {
    vi.useFakeTimers({ now: new Date("2026-09-22T10:00:00.000Z") });
    observe({ type: "approval_required", toolCall: { id: "call-1", name: "write_file" } });
    vi.setSystemTime(new Date("2026-09-22T10:00:05.000Z"));
    observe({ type: "approval_required", toolCall: { id: "call-2", name: "write_file" } });

    expect(attention()).toEqual({
      pendingApprovalCount: 2,
      pendingQuestionCount: 0,
      awaitingSince: "2026-09-22T10:00:00.000Z",
    });
  });

  it("keys an approval by the event's toolCallId when present (per-call approvals)", () => {
    observe({
      type: "approval_required",
      toolCallId: "call-9",
      batchSize: 1,
      toolCall: { id: "call-9", name: "write_file" },
    });
    observe({ type: "approval_decided", toolCallId: "call-9", decision: "allow" });
    expect(attention().pendingApprovalCount).toBe(0);
  });

  it("an approved call's first streamed output ends its wait", () => {
    observe({ type: "approval_required", toolCall: { id: "call-1", name: "execute_command" } });
    observe({ type: "tool_output", toolCallId: "call-1", event: "stdout", data: "…" });
    expect(attention().pendingApprovalCount).toBe(0);
  });

  it("resolves calls without ids by tool name", () => {
    observe({ type: "approval_required", toolCall: { name: "write_file" } });
    observe({ type: "tool_execution", status: "done", tool: { name: "write_file", result: {} } });
    expect(attention().pendingApprovalCount).toBe(0);
  });

  it("ignores the streaming/calling tool_execution events that precede approval", () => {
    observe({ type: "approval_required", toolCall: { id: "call-1", name: "write_file" } });
    observe({ type: "tool_execution", status: "calling", tool: { id: "call-1", name: "write_file" } });
    expect(attention().pendingApprovalCount).toBe(1);
  });

  it("a plan proposal waits until the plan is decided", () => {
    observe({ type: "plan_proposal", plan: "1. do it", autoApproved: false });
    expect(attention().pendingApprovalCount).toBe(1);
    observe({ type: "status", message: "plan_mode_exited" });
    expect(attention().pendingApprovalCount).toBe(0);
  });

  it("an auto-approved plan never waits", () => {
    observe({ type: "plan_proposal", plan: "1. do it", autoApproved: true });
    expect(attention().pendingApprovalCount).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("a non-blocking question stays pending past its tool result and ends when its answer is delivered", () => {
    observe({ type: "user_question", questionId: "q-a", blocking: false });
    observe({ type: "user_question", questionId: "q-b", blocking: false });
    observe({
      type: "tool_execution",
      status: "done",
      tool: { name: "ask_user", result: { questionId: "q-a", status: "pending", blocking: false } },
    });
    expect(attention().pendingQuestionCount).toBe(2);

    // The <user-answer> text names its card; q-b is answered first.
    observe({
      type: "turn_input",
      kind: "question_answer",
      content: "Answers to question card q-b:\n- Q: colour?\n  A: blue",
    });
    expect(attention().pendingQuestionCount).toBe(1);
    observe({ type: "turn_input", kind: "question_answer", content: "Answers to question card q-a:" });
    expect(attention().pendingQuestionCount).toBe(0);
  });

  it("steering input is not an answer", () => {
    observe({ type: "user_question", questionId: "q-a", blocking: false });
    observe({ type: "turn_input", kind: "steer", content: "also check the tests" });
    expect(attention().pendingQuestionCount).toBe(1);
  });

  it("a blocking question that timed out (no questionId in the result) ends the oldest blocking wait", () => {
    observe({ type: "user_question", questionId: "q-1", blocking: true });
    observe({
      type: "tool_execution",
      status: "done",
      tool: { name: "ask_user", result: { answers: null, timedOut: true } },
    });
    expect(attention().pendingQuestionCount).toBe(0);
  });

  it("the end of the turn clears every wait", () => {
    observe({ type: "approval_required", toolCall: { id: "call-1", name: "write_file" } });
    observe({ type: "user_question", questionId: "q-1", blocking: false });
    observe({ type: "error", message: "boom" });
    expect(attention()).toEqual({
      pendingApprovalCount: 0,
      pendingQuestionCount: 0,
      awaitingSince: null,
    });
    expect(ConversationAttentionRegistry.size).toBe(0);
  });

  it("publishes each change once, with the new counts, and nothing for unrelated events", () => {
    observe({ type: "chunk", content: "hello" });
    expect(published).toHaveLength(0);

    observe({ type: "approval_required", toolCall: { id: "call-1", name: "write_file" } });
    observe({ type: "chunk", content: "still waiting" });
    observe({ type: "tool_execution", status: "done", tool: { id: "call-1", name: "write_file" } });
    observe({ type: "done" });

    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      collection: ATTENTION_CHANGE_COLLECTION,
      operationType: "update",
      id: CONVERSATION,
      attention: { pendingApprovalCount: 1, pendingQuestionCount: 0 },
    });
    expect(published[1]).toMatchObject({
      id: CONVERSATION,
      attention: { pendingApprovalCount: 0, pendingQuestionCount: 0, awaitingSince: null },
    });
  });

  it("a turn paused at its cost cap waits as one approval until the pause is resolved", () => {
    observe({ type: "status", message: "budget_reached", pauseId: "pause-1", spentDollars: 2, maxCostDollars: 1.5 });
    expect(attention().pendingApprovalCount).toBe(1);
    observe({ type: "status", message: "budget_resolved", pauseId: "pause-1", action: "raise", source: "user" });
    expect(attention()).toEqual({ pendingApprovalCount: 0, pendingQuestionCount: 0, awaitingSince: null });

    // Restored from the store after a restart, forgotten once raised with no turn running.
    const record = {
      id: "p", loopKey: CONVERSATION, kind: "budget", itemId: "pause-2", batchId: null, position: 0,
      status: "pending", createdAt: "2026-09-22T09:00:00.000Z",
    };
    ConversationAttentionRegistry.restore([record] as never);
    expect(attention().pendingApprovalCount).toBe(1);
    ConversationAttentionRegistry.forget([record] as never);
    expect(attention().pendingApprovalCount).toBe(0);
  });

  it("keeps conversations apart", () => {
    observe({ type: "approval_required", toolCall: { id: "call-1", name: "write_file" } });
    expect(ConversationAttentionRegistry.get("another-conversation").pendingApprovalCount).toBe(0);
  });

  it("restores the waits of stored decisions (a restart) and forgets them once settled without a turn", () => {
    const createdAt = "2026-09-22T09:00:00.000Z";
    const stored = [
      { id: "a", loopKey: CONVERSATION, kind: "tool", itemId: "call-1", batchId: "b-1", position: 0, status: "pending", createdAt, name: "write_file" },
      { id: "q", loopKey: CONVERSATION, kind: "question", itemId: "q-1", batchId: null, position: 0, status: "pending", createdAt, blocking: true },
      // A sub-agent's card is the parent conversation's "needs you".
      { id: "s", loopKey: "sub-agent-1", parentConversationId: CONVERSATION, kind: "tool", itemId: "call-9", batchId: "b-9", position: 0, status: "pending", createdAt },
      { id: "done", loopKey: CONVERSATION, kind: "tool", itemId: "call-0", batchId: "b-0", position: 0, status: "decided", createdAt },
    ] as const;

    ConversationAttentionRegistry.restore(stored as never);
    expect(attention()).toEqual({ pendingApprovalCount: 2, pendingQuestionCount: 1, awaitingSince: createdAt });
    expect(published.at(-1)).toMatchObject({ id: CONVERSATION, attention: { pendingApprovalCount: 2 } });

    ConversationAttentionRegistry.forget([stored[0], stored[2]] as never);
    expect(attention()).toMatchObject({ pendingApprovalCount: 0, pendingQuestionCount: 1 });
    ConversationAttentionRegistry.forget([stored[1]] as never);
    expect(attention()).toEqual({ pendingApprovalCount: 0, pendingQuestionCount: 0, awaitingSince: null });
  });
});

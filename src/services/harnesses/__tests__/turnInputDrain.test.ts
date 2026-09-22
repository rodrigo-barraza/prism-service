import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AgenticLoopState from "#src/services/AgenticLoopState";
import {
  buildTurnInputMessage,
  drainTurnInput,
  hasPendingTurnInput,
  sealTurnInput,
} from "#src/services/harnesses/lifecycle/TurnInputDrain";
import { NOTIFICATION_SOURCES, TURN_INPUT } from "#src/constants";
import type { ConversationMessage, AgenticContext } from "#src/services/harnesses/types";

function makeContext(conversationId = "conv-1") {
  const emit = vi.fn();
  return { context: { conversationId, emit } as unknown as AgenticContext, emit };
}

describe("TurnInputDrain", () => {
  beforeEach(() => TurnInputMailbox._clearAll());

  it("builds a tagged user message for a steering update, keeping the raw text", () => {
    const message = buildTurnInputMessage({
      id: "input-1", kind: "user_update", text: "focus on the tests", receivedAt: 5, images: ["img"],
    });
    expect(message.role).toBe("user");
    expect(message.content).toContain("<user-update>");
    expect(message.content).toContain("focus on the tests");
    expect(message.rawContent).toBe("focus on the tests");
    expect(message.images).toEqual(["img"]);
    expect(message._notificationSource).toBe(NOTIFICATION_SOURCES.USER_UPDATE);
    expect(message[TURN_INPUT.MESSAGE_KEY]).toEqual({ id: "input-1", kind: "user_update", receivedAt: 5 });
  });

  it("builds a <user-answer> message for a non-blocking answer and passes notifications verbatim", () => {
    const answer = buildTurnInputMessage({ id: "i", kind: "question_answer", text: "A: blue", receivedAt: 1, meta: { questionId: "q-1" } });
    expect(answer.content).toContain("<user-answer>");
    expect(answer.questionId).toBe("q-1");
    expect(answer._notificationSource).toBe(NOTIFICATION_SOURCES.USER_ANSWER);

    const completion = buildTurnInputMessage({
      id: "i2", kind: "task_completion", text: "<task-notification>done</task-notification>", receivedAt: 1,
      meta: { _notificationSource: NOTIFICATION_SOURCES.ASYNC_TASK, _notificationId: "async-task:t1:1" },
    });
    expect(completion.content).toBe("<task-notification>done</task-notification>");
    expect(completion._notificationSource).toBe(NOTIFICATION_SOURCES.ASYNC_TASK);
    expect(completion._notificationId).toBe("async-task:t1:1");
  });

  it("is a no-op when nothing is pending", () => {
    const { context, emit } = makeContext();
    const messages: ConversationMessage[] = [];
    const state = new AgenticLoopState();
    TurnInputMailbox.open("conv-1");
    expect(hasPendingTurnInput(context)).toBe(false);
    expect(drainTurnInput(messages, state, context, "iteration_start")).toBe(0);
    expect(messages).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("appends every pending entry to the turn and acknowledges each on the stream", () => {
    const { context, emit } = makeContext();
    const messages: ConversationMessage[] = [{ role: "user", content: "original prompt" }];
    const state = new AgenticLoopState();
    state.iterations = 3;
    TurnInputMailbox.open("conv-1");
    const first = TurnInputMailbox.post("conv-1", { kind: "user_update", text: "also lint" });
    TurnInputMailbox.post("conv-1", { kind: "question_answer", text: "A: yes" });
    expect(hasPendingTurnInput(context)).toBe(true);

    const applied = drainTurnInput(messages, state, context, "after_tools");

    expect(applied).toBe(2);
    expect(state.turnInputApplied).toBe(2);
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toContain("also lint");
    expect(messages[2].content).toContain("<user-answer>");
    expect(TurnInputMailbox.pendingCount("conv-1")).toBe(0);

    const events = emit.mock.calls.map((call) => call[0]);
    expect(events[0]).toMatchObject({ type: TURN_INPUT.EVENT_TYPE, id: first.id, kind: "user_update", content: "also lint", boundary: "after_tools", iteration: 3 });
    expect(events[1]).toMatchObject({ type: "status", message: TURN_INPUT.STATUS_APPLIED, inputId: first.id, boundary: "after_tools" });
    expect(events).toHaveLength(4);
  });

  it("does nothing for a context without a conversation id", () => {
    const { context } = makeContext("");
    const state = new AgenticLoopState();
    expect(drainTurnInput([], state, context, "iteration_start")).toBe(0);
    expect(hasPendingTurnInput(context)).toBe(false);
    expect(sealTurnInput([], state, context)).toBe(0);
  });

  it("sealTurnInput seals the box and keeps what it had already accepted in the transcript", () => {
    const { context, emit } = makeContext();
    const state = new AgenticLoopState();
    TurnInputMailbox.open("conv-1");
    TurnInputMailbox.post("conv-1", {
      kind: "task_completion",
      text: "<task-notification>team done</task-notification>",
      meta: { _notificationSource: NOTIFICATION_SOURCES.ORCHESTRATOR },
    });
    const messages: ConversationMessage[] = [];

    expect(sealTurnInput(messages, state, context)).toBe(1);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("<task-notification>team done</task-notification>");
    expect(emit.mock.calls[0][0]).toMatchObject({ type: TURN_INPUT.EVENT_TYPE, kind: "task_completion", boundary: "turn_end" });
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "late" }).accepted).toBe(false);
  });
});

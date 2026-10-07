import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import TurnInputMailbox, {
  TURN_INPUT_MAXIMUM_PENDING,
  TURN_INPUT_MAXIMUM_TEXT_LENGTH,
} from "#src/services/TurnInputMailbox";

describe("TurnInputMailbox", () => {
  beforeEach(() => TurnInputMailbox._clearAll());

  it("rejects input when no turn is open, so the caller queues it as the next turn", () => {
    const posted = TurnInputMailbox.post("conv-1", { kind: "user_update", text: "hi" });
    expect(posted).toEqual({ accepted: false, reason: "no_active_turn" });
    expect(TurnInputMailbox.isOpen("conv-1")).toBe(false);
  });

  it("accepts input while a turn is open and drains it in arrival order", () => {
    TurnInputMailbox.open("conv-1");
    const first = TurnInputMailbox.post("conv-1", { kind: "user_update", text: "first" });
    const second = TurnInputMailbox.post("conv-1", { kind: "task_completion", text: "second", meta: { taskId: "t1" } });
    expect(first.accepted).toBe(true);
    expect(second.position).toBe(2);
    expect(TurnInputMailbox.pendingCount("conv-1")).toBe(2);

    const drained = TurnInputMailbox.drain("conv-1");
    expect(drained.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(drained[1].meta).toEqual({ taskId: "t1" });
    expect(drained[0].id).toMatch(/^input-/);
    expect(TurnInputMailbox.pendingCount("conv-1")).toBe(0);
    expect(TurnInputMailbox.drain("conv-1")).toEqual([]);
  });

  it("keeps mailboxes per conversation", () => {
    TurnInputMailbox.open("a");
    TurnInputMailbox.open("b");
    TurnInputMailbox.post("a", { kind: "user_update", text: "for a" });
    expect(TurnInputMailbox.pendingCount("b")).toBe(0);
    expect(TurnInputMailbox.drain("b")).toEqual([]);
    expect(TurnInputMailbox.drain("a")).toHaveLength(1);
  });

  it("rejects empty input, caps text length and pending count", () => {
    TurnInputMailbox.open("conv-1");
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "   " }).reason).toBe("empty_input");
    // Images alone are enough
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "", images: ["data:image/png;base64,x"] }).accepted).toBe(true);
    const long = "x".repeat(TURN_INPUT_MAXIMUM_TEXT_LENGTH + 10);
    TurnInputMailbox.post("conv-1", { kind: "user_update", text: long });
    const drained = TurnInputMailbox.drain("conv-1");
    expect(drained[1].text).toHaveLength(TURN_INPUT_MAXIMUM_TEXT_LENGTH);

    for (let index = 0; index < TURN_INPUT_MAXIMUM_PENDING; index++) {
      expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: `m${index}` }).accepted).toBe(true);
    }
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "overflow" }).reason).toBe("mailbox_full");
  });

  it("close() returns whatever was undelivered and stops accepting", () => {
    TurnInputMailbox.open("conv-1");
    TurnInputMailbox.post("conv-1", { kind: "user_update", text: "late" });
    const leftovers = TurnInputMailbox.close("conv-1");
    expect(leftovers).toHaveLength(1);
    expect(TurnInputMailbox.isOpen("conv-1")).toBe(false);
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "x" }).accepted).toBe(false);
    expect(TurnInputMailbox.close("conv-1")).toEqual([]);
  });

  it("open() is idempotent and keeps pending entries", () => {
    TurnInputMailbox.open("conv-1");
    TurnInputMailbox.post("conv-1", { kind: "user_update", text: "keep" });
    TurnInputMailbox.open("conv-1");
    expect(TurnInputMailbox.pendingCount("conv-1")).toBe(1);
  });

  it("seal() refuses every later post as no_active_turn and keeps what was accepted drainable", () => {
    TurnInputMailbox.open("conv-1");
    TurnInputMailbox.post("conv-1", { kind: "task_completion", text: "accepted before" });
    TurnInputMailbox.seal("conv-1");

    expect(TurnInputMailbox.isOpen("conv-1")).toBe(false);
    expect(TurnInputMailbox.post("conv-1", { kind: "task_completion", text: "too late" })).toEqual({
      accepted: false,
      reason: "no_active_turn",
    });
    expect(TurnInputMailbox.drain("conv-1").map((entry) => entry.text)).toEqual(["accepted before"]);
  });

  it("a new turn opening a sealed box accepts input again", () => {
    TurnInputMailbox.open("conv-1");
    TurnInputMailbox.seal("conv-1");
    TurnInputMailbox.open("conv-1");
    expect(TurnInputMailbox.isOpen("conv-1")).toBe(true);
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "next turn" }).accepted).toBe(true);
  });
});

describe("TurnInputMailbox — background task notifications", () => {
  beforeEach(() => TurnInputMailbox._clearAll());

  const notification = (text: string, taskId = "monitor-aaaa1111") => ({
    kind: "task_notification" as const,
    text,
    meta: { _notificationSource: "workspace_task", taskId },
  });

  it("joins notifications that arrive before the turn looks into the one waiting", () => {
    TurnInputMailbox.open("conv-1");
    const first = TurnInputMailbox.post("conv-1", notification("<task-notification>one</task-notification>"));
    const second = TurnInputMailbox.post(
      "conv-1",
      notification("<task-notification>two</task-notification>", "shell-bbbb2222"),
    );
    expect(second).toMatchObject({ accepted: true, id: first.id, position: 1 });
    expect(TurnInputMailbox.pendingCount("conv-1")).toBe(1);

    const [entry] = TurnInputMailbox.drain("conv-1");
    expect(entry.text).toBe("<task-notification>one</task-notification>\n<task-notification>two</task-notification>");
    // The first notification's meta stays: its source names the whole message.
    expect(entry.meta).toEqual({ _notificationSource: "workspace_task", taskId: "monitor-aaaa1111" });
  });

  it("starts a new entry once the waiting one was drained, and never joins other kinds", () => {
    TurnInputMailbox.open("conv-1");
    TurnInputMailbox.post("conv-1", notification("one"));
    TurnInputMailbox.drain("conv-1");
    TurnInputMailbox.post("conv-1", { kind: "user_update", text: "steer" });
    TurnInputMailbox.post("conv-1", notification("two"));
    TurnInputMailbox.post("conv-1", { kind: "task_completion", text: "async done" });
    const drained = TurnInputMailbox.drain("conv-1");
    expect(drained.map((entry) => [entry.kind, entry.text])).toEqual([
      ["user_update", "steer"],
      ["task_notification", "two"],
      ["task_completion", "async done"],
    ]);
  });

  it("starts a new entry when joining would pass the text cap, and a full box still takes a join", () => {
    TurnInputMailbox.open("conv-1");
    const big = "x".repeat(TURN_INPUT_MAXIMUM_TEXT_LENGTH - 5);
    TurnInputMailbox.post("conv-1", notification(big));
    const separate = TurnInputMailbox.post("conv-1", notification("long enough"));
    expect(separate.position).toBe(2);

    for (let index = 2; index < TURN_INPUT_MAXIMUM_PENDING; index++) {
      TurnInputMailbox.post("conv-1", { kind: "user_update", text: `m${index}` });
    }
    expect(TurnInputMailbox.post("conv-1", { kind: "user_update", text: "overflow" }).reason).toBe("mailbox_full");
    // A notification joins the second (still roomy) one instead of needing a slot.
    expect(TurnInputMailbox.post("conv-1", notification("joins")).accepted).toBe(true);
    expect(TurnInputMailbox.drain("conv-1")[1].text).toBe("long enough\njoins");
  });
});

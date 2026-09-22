import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import AgentHooks from "#src/services/AgentHooks";
import HookSessionTracker, {
  _resetSessionsForTests,
} from "#src/services/hooks/HookSessionTracker";

// ────────────────────────────────────────────────────────────
// What "session" means for SessionStart / SessionEnd: a run of
// turns with no idle gap past the timeout.
// ────────────────────────────────────────────────────────────

function recordingHooks() {
  const hooks = new AgentHooks();
  const ended: Array<Record<string, unknown>> = [];
  hooks.register("sessionEnd", async (payload: unknown) => {
    ended.push(payload as Record<string, unknown>);
  }, "recorder", "inspect");
  return { hooks, ended };
}

const IDENTITY = { conversationId: "c-1", project: "p", username: "u" };

describe("HookSessionTracker", () => {
  beforeEach(() => {
    _resetSessionsForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSessionsForTests();
  });

  it("opens a session on the first turn only, as startup or resume", () => {
    const { hooks } = recordingHooks();
    expect(HookSessionTracker.beginSessionTurn("c-1", hooks, IDENTITY, false)).toEqual({ isNewSession: true, source: "startup" });
    HookSessionTracker.endSessionTurn("c-1", 1_000);
    expect(HookSessionTracker.beginSessionTurn("c-1", hooks, IDENTITY, true)).toEqual({ isNewSession: false, source: "resume" });
    expect(HookSessionTracker.beginSessionTurn("c-2", hooks, IDENTITY, true)).toEqual({ isNewSession: true, source: "resume" });
  });

  it("fires SessionEnd once the conversation has idled past the timeout — not before, and not while a turn runs", async () => {
    const { hooks, ended } = recordingHooks();
    HookSessionTracker.beginSessionTurn("c-1", hooks, IDENTITY, false);
    HookSessionTracker.endSessionTurn("c-1", 1_000);

    await vi.advanceTimersByTimeAsync(900);
    HookSessionTracker.beginSessionTurn("c-1", hooks, IDENTITY, true); // a new turn resets the clock
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toHaveLength(0);

    HookSessionTracker.endSessionTurn("c-1", 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ hook_event_name: "SessionEnd", reason: "idle", turns: 2, session_id: "c-1" });
    expect(HookSessionTracker.openSessionCount()).toBe(0);
  });

  it("closes every open session at shutdown under one budget", async () => {
    vi.useRealTimers();
    const fast = recordingHooks();
    const slow = new AgentHooks();
    slow.register("sessionEnd", () => new Promise(() => {}), "never-returns", "transform");

    HookSessionTracker.beginSessionTurn("fast", fast.hooks, IDENTITY, false);
    HookSessionTracker.beginSessionTurn("slow", slow, IDENTITY, false);

    const started = Date.now();
    await HookSessionTracker.endAllSessions("shutdown", 200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fast.ended).toEqual([expect.objectContaining({ reason: "shutdown" })]);
  });
});

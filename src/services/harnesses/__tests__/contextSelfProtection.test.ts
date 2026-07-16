import { describe, it, expect } from "vitest";
import {
  hasUnreadToolResults,
  evaluateCompactionDeferral,
} from "#src/services/harnesses/lifecycle/CompactionDeferralGuard";
import {
  collectLedgerEntries,
  buildLedgerText,
} from "#src/services/harnesses/lifecycle/ContextLedgerInjector";
import compactContextTool from "#src/services/tool-definitions/CompactContextTool";
import AgenticLoopState from "#src/services/AgenticLoopState";
import AutoCompactionTrigger from "#src/services/compact/AutoCompactionTrigger";
import { OFFLOAD_STUB_HEADER } from "#src/services/compact/ToolResultOffloadService";
import { AGENT_DIRECTIVES, HARNESS } from "#src/constants";
import type { ConversationMessage } from "#src/services/harnesses/types";

// ────────────────────────────────────────────────────────────
// Context self-protection suite (survey items A1 + A3):
//  - CompactionDeferralGuard: unread-tail + recent-stall suppression
//  - compact_context tool: REQUEST_COMPACTION directive
//  - AutoCompactionTrigger: model-requested bypass
//  - ContextLedgerInjector: proprioceptive ledger rendering
// ────────────────────────────────────────────────────────────

function assistantWithResults(): ConversationMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call-1", name: "read_file", args: {}, result: "file contents" },
    ],
  } as ConversationMessage;
}

describe("CompactionDeferralGuard", () => {
  it("detects unread tool results at the tail", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      assistantWithResults(),
    ] as ConversationMessage[];
    expect(hasUnreadToolResults(messages)).toBe(true);
  });

  it("skips injected system messages when finding the tail", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      assistantWithResults(),
      { role: "system", content: "[retry guidance]" },
    ] as ConversationMessage[];
    expect(hasUnreadToolResults(messages)).toBe(true);
  });

  it("does not defer after the model has replied with text", () => {
    const messages = [
      { role: "user", content: "do the thing" },
      assistantWithResults(),
      { role: "assistant", content: "Done — here's the answer." },
    ] as ConversationMessage[];
    expect(hasUnreadToolResults(messages)).toBe(false);
    const state = new AgenticLoopState();
    expect(evaluateCompactionDeferral(messages, state).defer).toBe(false);
  });

  it("defers with reason unread_tool_results", () => {
    const state = new AgenticLoopState();
    const verdict = evaluateCompactionDeferral(
      [{ role: "user", content: "q" }, assistantWithResults()],
      state,
    );
    expect(verdict).toEqual({ defer: true, reason: "unread_tool_results" });
  });

  it("defers after a recent stall warning, then releases", () => {
    const cleanTail = [
      { role: "user", content: "q" },
      { role: "assistant", content: "text answer" },
    ] as ConversationMessage[];
    const state = new AgenticLoopState();
    state.lastStallWarningIteration = 10;

    state.iterations = 12; // within the suppression window
    expect(evaluateCompactionDeferral(cleanTail, state)).toEqual({
      defer: true,
      reason: "recent_stall",
    });

    state.iterations =
      10 + HARNESS.COMPACTION_STALL_SUPPRESSION_ITERATIONS + 1; // past it
    expect(evaluateCompactionDeferral(cleanTail, state).defer).toBe(false);
  });
});

describe("compact_context tool", () => {
  it("returns the REQUEST_COMPACTION directive with the reason", async () => {
    const result = (await compactContextTool.execute(
      { reason: "sub-task complete" },
      {},
    )) as Record<string, unknown>;
    expect(result._directive).toBe(AGENT_DIRECTIVES.REQUEST_COMPACTION);
    expect(result.reason).toBe("sub-task complete");
    expect(result.acknowledged).toBe(true);
  });
});

describe("AutoCompactionTrigger model-requested bypass", () => {
  it("compacts below the token threshold when the model requested it", () => {
    const result = AutoCompactionTrigger.evaluate(1_000, 128_000, 8_192, 10, true);
    expect(result.shouldCompact).toBe(true);
  });

  it("still honors the minimum-message floor on a requested compaction", () => {
    const result = AutoCompactionTrigger.evaluate(1_000, 128_000, 8_192, 2, true);
    expect(result.shouldCompact).toBe(false);
  });

  it("does not compact below threshold without a request", () => {
    const result = AutoCompactionTrigger.evaluate(1_000, 128_000, 8_192, 10, false);
    expect(result.shouldCompact).toBe(false);
  });
});

describe("ContextLedgerInjector rendering", () => {
  const offloadedStub =
    `${OFFLOAD_STUB_HEADER}\n` +
    `offload_id: call-off-1 (search_web, 300 lines, ~5000 tokens)\n` +
    `Preview...`;

  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", args: {}, result: "x".repeat(4000) },
        { id: "b", name: "search_web", args: {}, result: offloadedStub },
      ],
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c", name: "execute_shell", args: {}, result: "ok" }],
    },
  ] as ConversationMessage[];

  it("collects inline and offloaded entries with token weights", () => {
    const entries = collectLedgerEntries(messages);
    expect(entries).toHaveLength(3);
    const offloaded = entries.filter((entry) => entry.offloadId !== null);
    expect(offloaded).toHaveLength(1);
    expect(offloaded[0].offloadId).toBe("call-off-1");
    const inline = entries.filter((entry) => entry.offloadId === null);
    expect(inline.map((entry) => entry.toolName).sort()).toEqual([
      "execute_shell",
      "read_file",
    ]);
  });

  it("renders a ledger with pressure, largest-first inline list, and recovery ids", () => {
    const text = buildLedgerText(messages, 8, 50_000, 100_000);
    expect(text).not.toBeNull();
    expect(text!).toContain("iteration 8");
    expect(text!).toContain("50%");
    expect(text!).toContain("offload_id: call-off-1");
    expect(text!).toContain("retrieve_offloaded_content");
    // Largest inline result listed before smaller ones
    expect(text!.indexOf("read_file")).toBeLessThan(
      text!.indexOf("execute_shell"),
    );
  });

  it("returns null when there are no tool results to report", () => {
    const bare = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ] as ConversationMessage[];
    expect(buildLedgerText(bare, 8, 1_000, 100_000)).toBeNull();
  });
});

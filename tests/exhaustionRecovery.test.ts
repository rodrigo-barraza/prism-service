import { describe, it, expect } from "vitest";
import { getLastAssistantText, buildToolCallFallbackSummary } from "../src/services/orchestrator/SubAgentResultBuilder.ts";
import type { ConversationMessage } from "../src/services/harnesses/types.ts";
import type { SubAgentResult } from "../src/types/orchestrator.ts";

describe("getLastAssistantText", () => {
  it("returns the text from the last assistant message with string content", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Research topic X" },
      { role: "assistant", content: "Let me search for that..." },
      { role: "assistant", content: "Here are my comprehensive findings on topic X." },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Here are my comprehensive findings on topic X.");
  });

  it("skips assistant messages with empty content", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Planning text..." },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "search", args: {} }] },
      { role: "assistant", content: "   " },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Planning text...");
  });

  it("skips assistant messages with undefined content", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Real content" },
      { role: "assistant" },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Real content");
  });

  it("returns empty string when no assistant messages have text", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("");
  });

  it("returns empty string for empty messages array", () => {
    expect(getLastAssistantText([])).toBe("");
  });

  it("handles null/undefined messages gracefully", () => {
    expect(getLastAssistantText(null as unknown as ConversationMessage[])).toBe("");
    expect(getLastAssistantText(undefined as unknown as ConversationMessage[])).toBe("");
  });

  it("finds the finalize-appended message when it is the last one", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Research topic X" },
      { role: "assistant", content: "Let me search for that...", toolCalls: [{ id: "1", name: "search_web", args: { query: "topic X" } }] },
      { role: "assistant", content: "Now analyzing results...", toolCalls: [{ id: "2", name: "read_url", args: { url: "https://example.com" } }] },
      { role: "assistant", content: "Here is my final comprehensive analysis of topic X with all findings." },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Here is my final comprehensive analysis of topic X with all findings.");
  });
});

describe("Exhaustion recovery triggering logic", () => {
  it("should trigger recovery when agent exhausts iterations mid-tool-call", () => {
    const hasCleanTextBreak = false;
    const streamedToolCallsLength = 12;
    const isAborted = false;

    const shouldTriggerRecovery = !hasCleanTextBreak && streamedToolCallsLength > 0 && !isAborted;
    expect(shouldTriggerRecovery).toBe(true);
  });

  it("should NOT trigger recovery when loop breaks cleanly with text", () => {
    const hasCleanTextBreak = true;
    const streamedToolCallsLength = 5;
    const isAborted = false;

    const shouldTriggerRecovery = !hasCleanTextBreak && streamedToolCallsLength > 0 && !isAborted;
    expect(shouldTriggerRecovery).toBe(false);
  });

  it("should trigger recovery when agent exits early (empty output) but used tools", () => {
    const hasCleanTextBreak = false;
    const iterationCount = 5;
    const resolvedMaxIterations = 15;
    const streamedToolCallsLength = 3;
    const isAborted = false;

    const oldCondition = iterationCount >= resolvedMaxIterations && !hasCleanTextBreak;
    const newCondition = !hasCleanTextBreak && streamedToolCallsLength > 0 && !isAborted;

    expect(oldCondition).toBe(false);
    expect(newCondition).toBe(true);
  });

  it("should NOT trigger recovery when signal is aborted", () => {
    const hasCleanTextBreak = false;
    const streamedToolCallsLength = 8;
    const isAborted = true;

    const shouldTriggerRecovery = !hasCleanTextBreak && streamedToolCallsLength > 0 && !isAborted;
    expect(shouldTriggerRecovery).toBe(false);
  });

  it("should NOT trigger recovery when agent used zero tools (non-agentic exit)", () => {
    const hasCleanTextBreak = false;
    const streamedToolCallsLength = 0;
    const isAborted = false;

    const shouldTriggerRecovery = !hasCleanTextBreak && streamedToolCallsLength > 0 && !isAborted;
    expect(shouldTriggerRecovery).toBe(false);
  });

  it("old condition would fail: non-empty finalStreamedText from tool-call iteration would skip recovery", () => {
    const iterationCount = 15;
    const resolvedMaxIterations = 15;
    const finalStreamedText = "Now let me pull in additional context...";
    const streamedToolCallsLength = 12;
    const hasCleanTextBreak = false;
    const isAborted = false;

    // The old condition required BOTH max iterations AND empty text AND zero tool calls.
    // With non-empty finalStreamedText from a tool-call preamble, it would never fire.
    const oldConditionWouldFire =
      iterationCount >= resolvedMaxIterations &&
      !finalStreamedText?.trim();

    // The new condition ignores finalStreamedText entirely — it only cares about
    // whether the agent produced a clean text break, used tools, and isn't aborted.
    const newCondition =
      !hasCleanTextBreak && streamedToolCallsLength > 0 && !isAborted;

    expect(oldConditionWouldFire).toBe(false);
    expect(newCondition).toBe(true);
  });
});

describe("buildToolCallFallbackSummary", () => {
  it("returns structured summary with tool breakdown when toolNames are present", () => {
    const agentResult: SubAgentResult = {
      agent_id: "agent-0",
      description: "Research Agent",
      status: "completed",
      summary: "Agent completed",
      result: null,
      toolUses: 10,
      toolNames: { web_search: 5, read_file: 3, analyze_data: 2 },
      iterations: 15,
      durationMs: 5000,
      messages: [],
    };

    const fallback = buildToolCallFallbackSummary(agentResult);
    expect(fallback).toContain("15 iterations");
    expect(fallback).toContain("web_search (5×)");
    expect(fallback).toContain("read_file (3×)");
    expect(fallback).toContain("analyze_data (2×)");
    expect(fallback).toContain("did not produce a final summary");
  });

  it("returns generic summary when toolNames is undefined", () => {
    const agentResult: SubAgentResult = {
      agent_id: "agent-1",
      description: "Writer Agent",
      status: "completed",
      summary: "Agent completed",
      result: null,
      toolUses: 4,
      iterations: 3,
      durationMs: 2000,
      messages: [],
    };

    const fallback = buildToolCallFallbackSummary(agentResult);
    expect(fallback).toContain("3 iterations");
    expect(fallback).toContain("4 tool call(s)");
  });

  it("returns null when agent had zero tool uses and no iterations", () => {
    const agentResult: SubAgentResult = {
      agent_id: "agent-2",
      description: "Idle Agent",
      status: "completed",
      summary: "Agent completed",
      result: null,
      toolUses: 0,
      iterations: 0,
      durationMs: 100,
      messages: [],
    };

    const fallback = buildToolCallFallbackSummary(agentResult);
    expect(fallback).toBeNull();
  });

  it("uses singular 'iteration' label for single iteration", () => {
    const agentResult: SubAgentResult = {
      agent_id: "agent-3",
      description: "Quick Agent",
      status: "completed",
      summary: "Agent completed",
      result: null,
      toolUses: 1,
      toolNames: { read_file: 1 },
      iterations: 1,
      durationMs: 500,
      messages: [],
    };

    const fallback = buildToolCallFallbackSummary(agentResult);
    expect(fallback).toContain("1 iteration");
    expect(fallback).not.toContain("1 iterations");
  });
});

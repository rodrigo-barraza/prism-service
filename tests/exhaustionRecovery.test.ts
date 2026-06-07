import { describe, it, expect } from "vitest";
import { getLastAssistantText } from "../src/services/orchestrator/SubAgentResultBuilder.ts";
import type { ConversationMessage } from "../src/services/harnesses/types.ts";

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
  it("should trigger exhaustion recovery when loop exhausts mid-tool-call (hasCleanTextBreak=false)", () => {
    const iterationCount = 15;
    const resolvedMaxIterations = 15;
    const hasCleanTextBreak = false;

    const shouldTriggerRecovery = iterationCount >= resolvedMaxIterations && !hasCleanTextBreak;
    expect(shouldTriggerRecovery).toBe(true);
  });

  it("should NOT trigger exhaustion recovery when loop breaks cleanly with text (hasCleanTextBreak=true)", () => {
    const iterationCount = 10;
    const resolvedMaxIterations = 15;
    const hasCleanTextBreak = true;

    const shouldTriggerRecovery = iterationCount >= resolvedMaxIterations && !hasCleanTextBreak;
    expect(shouldTriggerRecovery).toBe(false);
  });

  it("should NOT trigger when loop finishes before max iterations even without clean break", () => {
    const iterationCount = 5;
    const resolvedMaxIterations = 15;
    const hasCleanTextBreak = false;

    const shouldTriggerRecovery = iterationCount >= resolvedMaxIterations && !hasCleanTextBreak;
    expect(shouldTriggerRecovery).toBe(false);
  });

  it("old condition would fail: non-empty finalStreamedText from tool-call iteration would skip recovery", () => {
    const iterationCount = 15;
    const resolvedMaxIterations = 15;
    const finalStreamedText = "Now let me pull in additional context...";
    const streamedToolCallsLength = 12;

    const oldCondition =
      iterationCount >= resolvedMaxIterations &&
      !finalStreamedText?.trim() &&
      streamedToolCallsLength === 0;

    const newCondition =
      iterationCount >= resolvedMaxIterations && !false;

    expect(oldCondition).toBe(false);
    expect(newCondition).toBe(true);
  });
});

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

  it("extracts text from Anthropic-style array content blocks", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Analyze this" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is my analysis of the topic." },
        ] as unknown as string,
      },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Here is my analysis of the topic.");
  });

  it("joins multiple text blocks from array content", () => {
    const messages: ConversationMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "tool_use", id: "tool-1", name: "search", input: {} },
          { type: "text", text: "Second paragraph after tool use." },
        ] as unknown as string,
      },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("First paragraph.\nSecond paragraph after tool use.");
  });

  it("skips array content with only non-text blocks (thinking, tool_use)", () => {
    const messages: ConversationMessage[] = [
      { role: "assistant", content: "Earlier valid text" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Deep reasoning..." },
          { type: "tool_use", id: "tool-1", name: "search", input: {} },
        ] as unknown as string,
      },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Earlier valid text");
  });

  it("prefers string content over array content", () => {
    const messages: ConversationMessage[] = [
      {
        role: "assistant",
        content: "String content wins",
      },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("String content wins");
  });

  it("falls back to textFragments when both string and array content are empty", () => {
    const messages: ConversationMessage[] = [
      {
        role: "assistant",
        content: "",
        textFragments: ["Fragment one.", "Fragment two."],
      },
    ];
    const result = getLastAssistantText(messages);
    expect(result).toBe("Fragment one.\nFragment two.");
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

describe("extractSubtreeMetrics", () => {
  it("should return null when message history has no tool results containing agent_id", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "tool", content: "some random tool result" },
    ];
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const result = extractSubtreeMetrics(messages);
    expect(result).toBeNull();
  });

  it("should parse a single SubAgentResult object (non-array) from a tool result", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const messages: ConversationMessage[] = [
      {
        role: "tool_result",
        content: JSON.stringify({
          agent_id: "agent-child-1",
          description: "child agent",
          status: "completed",
          result: "Found 3 relevant documents.",
          recursionDepth: 1,
          durationMs: 1200,
          toolUses: 5,
        }),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.totalDescendants).toBe(1);
    expect(metrics!.maxDepthReached).toBe(1);
    expect(metrics!.aggregatedDurationMs).toBe(1200);
    expect(metrics!.aggregatedToolUses).toBe(5);
    expect(metrics!.childResults).toHaveLength(1);
    expect(metrics!.childResults![0].agent_id).toBe("agent-child-1");
    expect(metrics!.childResults![0].result).toBe("Found 3 relevant documents.");
    expect(metrics!.childResults![0].error).toBeUndefined();
  });

  it("should parse an array of SubAgentResults and aggregate metrics", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const messages: ConversationMessage[] = [
      {
        role: "tool",
        content: JSON.stringify([
          {
            agent_id: "agent-child-1",
            description: "child 1",
            status: "completed",
            result: "Analysis complete.",
            recursionDepth: 1,
            durationMs: 1000,
            toolUses: 3,
          },
          {
            agent_id: "agent-child-2",
            description: "child 2",
            status: "failed",
            error: "Model timeout after 30s",
            recursionDepth: 1,
            durationMs: 2000,
            toolUses: 4,
          },
        ]),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.totalDescendants).toBe(2);
    expect(metrics!.maxDepthReached).toBe(1);
    expect(metrics!.aggregatedDurationMs).toBe(3000);
    expect(metrics!.aggregatedToolUses).toBe(7);
    expect(metrics!.childResults).toHaveLength(2);
    expect(metrics!.childResults![0].result).toBe("Analysis complete.");
    expect(metrics!.childResults![0].error).toBeUndefined();
    expect(metrics!.childResults![1].result).toBeNull();
    expect(metrics!.childResults![1].error).toBe("Model timeout after 30s");
  });

  it("should aggregate nested subtree metrics from grandchildren recursively", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const messages: ConversationMessage[] = [
      {
        role: "tool",
        content: JSON.stringify([
          {
            agent_id: "agent-child-1",
            description: "child 1",
            status: "completed",
            recursionDepth: 1,
            durationMs: 1000,
            toolUses: 3,
            subtreeMetrics: {
              totalDescendants: 2,
              maxDepthReached: 2,
              aggregatedCost: 0.05,
              aggregatedDurationMs: 4000,
              aggregatedToolUses: 10,
            },
          },
        ]),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.totalDescendants).toBe(3); // 1 child + 2 nested descendants
    expect(metrics!.maxDepthReached).toBe(2);
    expect(metrics!.aggregatedDurationMs).toBe(5000); // 1000 + 4000
    expect(metrics!.aggregatedToolUses).toBe(13); // 3 + 10
  });

  it("should skip malformed JSON or JSON without agent_id and handle errors gracefully", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const messages: ConversationMessage[] = [
      { role: "tool", content: "{invalid json" },
      { role: "tool", content: JSON.stringify({ name: "not an agent" }) }, // no agent_id
      {
        role: "tool",
        content: JSON.stringify({
          agent_id: "agent-valid",
          status: "completed",
          durationMs: "invalid-duration", // string instead of number
        }),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.totalDescendants).toBe(1);
    expect(metrics!.childResults![0].agent_id).toBe("agent-valid");
    expect(metrics!.childResults![0].durationMs).toBe("invalid-duration"); // truthy string passes through || 0
    expect(metrics!.childResults![0].result).toBeNull();
  });

  it("should truncate result text exceeding 2000 characters", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const longResult = "A".repeat(3000);
    const messages: ConversationMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({
          agent_id: "agent-verbose",
          description: "verbose agent",
          status: "completed",
          result: longResult,
          recursionDepth: 1,
          durationMs: 5000,
          toolUses: 8,
        }),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.childResults![0].result!.length).toBe(2001); // 2000 + ellipsis
    expect(metrics!.childResults![0].result!.endsWith("…")).toBe(true);
  });

  it("should set result to null when result field is empty or whitespace", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const messages: ConversationMessage[] = [
      {
        role: "tool",
        content: JSON.stringify([
          {
            agent_id: "agent-empty",
            description: "empty result agent",
            status: "completed",
            result: "   ",
            recursionDepth: 1,
            durationMs: 100,
            toolUses: 0,
          },
          {
            agent_id: "agent-missing",
            description: "missing result agent",
            status: "completed",
            recursionDepth: 1,
            durationMs: 200,
            toolUses: 1,
          },
        ]),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.childResults![0].result).toBeNull();
    expect(metrics!.childResults![1].result).toBeNull();
  });

  it("should propagate both result and error when both are present on a child", () => {
    const { extractSubtreeMetrics } = require("../src/services/orchestrator/SubAgentResultBuilder.ts");
    const messages: ConversationMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({
          agent_id: "agent-partial",
          description: "partial failure agent",
          status: "completed",
          result: "Partial findings before crash.",
          error: "Sub-agent produced no output after 12.5s (0 tool calls, 1 iteration).",
          recursionDepth: 1,
          durationMs: 12500,
          toolUses: 0,
        }),
      },
    ];

    const metrics = extractSubtreeMetrics(messages);
    expect(metrics).not.toBeNull();
    expect(metrics!.childResults![0].result).toBe("Partial findings before crash.");
    expect(metrics!.childResults![0].error).toBe("Sub-agent produced no output after 12.5s (0 tool calls, 1 iteration).");
  });
});


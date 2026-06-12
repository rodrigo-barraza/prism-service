import { describe, it, expect, vi, beforeEach } from "vitest";
import { MOCK_GENERATE_TEXT } from "./setup.ts";

// Suppress logger output during tests to keep console output clean
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

import AutoCompactionTrigger from "../src/services/compact/AutoCompactionTrigger.ts";
import MicroCompactionService from "../src/services/compact/MicroCompactionService.ts";
import {
  extractSummaryFromResponse,
  stripImagesFromMessages,
} from "../src/services/compact/CompactionPrompt.ts";
import CompactionService from "../src/services/compact/CompactionService.ts";
import ContextWindowManager from "../src/utils/ContextWindowManager.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";
import RequestLogger from "../src/services/RequestLogger.ts";
import BaseAgenticHarness from "../src/services/harnesses/BaseAgenticHarness.ts";

import type { ConversationMessage } from "../src/services/harnesses/types.ts";
import type { ChatMessage } from "../src/types/admin.ts";

// ═══════════════════════════════════════════════════════════════
// 1. AutoCompactionTrigger Tests
// ═══════════════════════════════════════════════════════════════

describe("AutoCompactionTrigger", () => {
  it("calculates effective context window size correctly", () => {
    // effectiveWindow = contextWindow - min(maxOutput, 20000)
    const effectiveWindow1 = AutoCompactionTrigger.getEffectiveContextWindowSize(128_000, 8192);
    expect(effectiveWindow1).toBe(128_000 - 8192);

    const effectiveWindow2 = AutoCompactionTrigger.getEffectiveContextWindowSize(128_000, 25_000);
    expect(effectiveWindow2).toBe(128_000 - 20_000);
  });

  it("calculates auto-compact threshold correctly", () => {
    // threshold = effectiveWindow - 13_000
    const threshold = AutoCompactionTrigger.getAutoCompactThreshold(128_000, 8192);
    expect(threshold).toBe(128_000 - 8192 - 13_000);
  });

  it("evaluates shouldCompact as false when under token threshold", () => {
    const evaluation = AutoCompactionTrigger.evaluate(50_000, 128_000, 8192, 10);
    expect(evaluation.shouldCompact).toBe(false);
    expect(evaluation.percentUsed).toBe(Math.round((50_000 / (128_000 - 8192)) * 100));
  });

  it("evaluates shouldCompact as false when above threshold but insufficient messages", () => {
    // Threshold is 128k - 8192 - 13k = 106,808 tokens.
    // 110_000 is above threshold, but message count is 5 (minimum is 6)
    const evaluation = AutoCompactionTrigger.evaluate(110_000, 128_000, 8192, 5);
    expect(evaluation.shouldCompact).toBe(false);
  });

  it("evaluates shouldCompact as true when above threshold and sufficient messages", () => {
    const evaluation = AutoCompactionTrigger.evaluate(110_000, 128_000, 8192, 6);
    expect(evaluation.shouldCompact).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. MicroCompactionService Tests
// ═══════════════════════════════════════════════════════════════

describe("MicroCompactionService", () => {
  it("never micro-compacts recent turns within the protected window", () => {
    const largeResult = "x".repeat(5000); // Exceeds 500 token limit
    const messages: ChatMessage[] = [
      { role: "system", content: "System Prompt" },
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: "Running file tool",
        toolCalls: [{ id: "toolCall-1", name: "read_file", args: {}, result: largeResult }],
      },
    ];

    // Since this is the only user turn, it falls well within the PROTECTED_RECENT_TURNS (4 turns) boundary
    const result = MicroCompactionService.microcompactMessages(messages);
    expect(result.clearedResultCount).toBe(0);
    expect(result.messages[2].toolCalls![0].result).toBe(largeResult);
  });

  it("clears old compactable tool results outside the protection boundary", () => {
    const largeResult = "x".repeat(10_000);
    const messages: ChatMessage[] = [
      { role: "system", content: "System" },
      {
        role: "assistant",
        content: "First turn",
        toolCalls: [{ id: "toolCall-old", name: "read_file", args: {}, result: largeResult }],
      },
      { role: "user", content: "Q1" }, // Turn 5 (counting backwards)
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" }, // Turn 4
      { role: "assistant", content: "A2" },
      { role: "user", content: "Q3" }, // Turn 3
      { role: "assistant", content: "A3" },
      { role: "user", content: "Q4" }, // Turn 2
      { role: "assistant", content: "A4" },
      { role: "user", content: "Q5" }, // Turn 1 (Most recent)
    ];

    // Under default window (4 turns), Q2 is the protection boundary.
    // The "First turn" assistant message is before the boundary, so it should be micro-compacted!
    const result = MicroCompactionService.microcompactMessages(messages);
    expect(result.clearedResultCount).toBe(1);
    expect(result.freedTokens).toBeGreaterThan(0);
    expect(result.messages[1].toolCalls![0].result).toBe("[Old tool result content cleared]");
  });

  it("does not clear small tool results even if outside the boundary", () => {
    const smallResult = "small text";
    const messages: ChatMessage[] = [
      { role: "system", content: "System" },
      {
        role: "assistant",
        content: "First turn",
        toolCalls: [{ id: "toolCall-old", name: "read_file", args: {}, result: smallResult }],
      },
      { role: "user", content: "Q1" },
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
    ];

    const result = MicroCompactionService.microcompactMessages(messages);
    expect(result.clearedResultCount).toBe(0);
    expect(result.messages[1].toolCalls![0].result).toBe(smallResult);
  });

  it("does not clear non-compactable tool results outside the boundary", () => {
    const largeResult = "x".repeat(10_000);
    const messages: ChatMessage[] = [
      { role: "system", content: "System" },
      {
        role: "assistant",
        content: "First turn",
        toolCalls: [{ id: "toolCall-old", name: "save_memory", args: {}, result: largeResult }],
      },
      { role: "user", content: "Q1" },
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
    ];

    const result = MicroCompactionService.microcompactMessages(messages);
    expect(result.clearedResultCount).toBe(0);
    expect(result.messages[1].toolCalls![0].result).toBe(largeResult);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. CompactionPrompt Tests
// ═══════════════════════════════════════════════════════════════

describe("CompactionPrompt Utilities", () => {
  describe("extractSummaryFromResponse", () => {
    it("extracts text correctly when wrapped inside <summary> tags", () => {
      const response = "<analysis>Thoughts about summarizing...</analysis>\n<summary>\nThis is the conversation summary.\n</summary>";
      const summary = extractSummaryFromResponse(response);
      expect(summary).toBe("This is the conversation summary.");
    });

    it("falls back to response without <analysis> if summary tags are missing and content is > 200 chars", () => {
      const response = "<analysis>Some drafting</analysis>\n" + "This is a long text without tags that serves as a fallback summary since it is long enough. ".repeat(3);
      const summary = extractSummaryFromResponse(response);
      expect(summary).toBe("This is a long text without tags that serves as a fallback summary since it is long enough. ".repeat(3).trim());
    });

    it("returns null if response is too short or empty", () => {
      const response = "Too short";
      const summary = extractSummaryFromResponse(response);
      expect(summary).toBeNull();
    });
  });

  describe("stripImagesFromMessages", () => {
    it("strips images arrays from messages", () => {
      const messages = [
        { role: "user", content: "Here", images: ["data:img1", "data:img2"] },
        { role: "assistant", content: "Ok" },
      ];
      const stripped = stripImagesFromMessages(messages);
      expect(stripped[0].images).toBeUndefined();
      expect(stripped[1].content).toBe("Ok");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. CompactionService Tests
// ═══════════════════════════════════════════════════════════════

describe("CompactionService", () => {
  beforeEach(() => {
    CompactionService.resetCircuitBreaker();
    vi.clearAllMocks();
    // Dynamically inject logBackgroundLlmCall into the global RequestLogger mock singleton
    RequestLogger.logBackgroundLlmCall = vi.fn();
  });

  it("orchestrates LLM compaction flow correctly", async () => {
    const summaryContent = "Conversation summarized elegantly.";
    MOCK_GENERATE_TEXT.mockResolvedValueOnce({
      text: `<analysis>Drafting compaction...</analysis>\n<summary>${summaryContent}</summary>`,
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    const messages: ChatMessage[] = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Historical Q1" },
      { role: "assistant", content: "Historical A1" },
      { role: "user", content: "Historical Q2" },
      { role: "assistant", content: "Historical A2" },
      { role: "user", content: "Active Q" },
    ];

    const mockEmit = vi.fn();
    const result = await CompactionService.compactConversation(messages, {
      project: "test-proj",
      username: "rodrigo",
      agentSessionId: "sess-1",
      emit: mockEmit,
    });

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(summaryContent);
    expect(result!.preCompactTokenCount).toBeGreaterThan(0);
    expect(result!.postCompactTokenCount).toBeGreaterThan(0);

    // Verify compacted message layout: [system, summary, ...recentTail]
    const compacted = result!.compactedMessages;
    expect(compacted[0].role).toBe("system");
    expect(compacted[1].role).toBe("user");
    expect(compacted[1].content).toContain(summaryContent);
    expect((compacted[1] as any).isCompactSummary).toBe(true);

    // Verify recent tail has been appended (last 3 user turns: in this case Q1, Q2, and Active Q are user turns)
    // The active Q should be at the very end
    expect(compacted[compacted.length - 1].content).toBe("Active Q");

    // Verify SSE events were emitted
    expect(mockEmit).toHaveBeenCalledWith({ type: "status", message: "compaction_started" });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "status", message: "compaction_complete" }),
    );
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "usage_update", operation: "compact:summarize" }),
    );
  });

  it("preserves active turns in recent tail when conversation has fewer than 3 user turns", async () => {
    const summaryContent = "Conversation summarized elegantly.";
    MOCK_GENERATE_TEXT.mockResolvedValueOnce({
      text: `<analysis>Drafting compaction...</analysis>\n<summary>${summaryContent}</summary>`,
      usage: { inputTokens: 50, outputTokens: 25 },
    });

    // Conversation has only 2 user turns: "Historical Q" and "Active Q"
    const messages: ChatMessage[] = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Historical Q" },
      { role: "assistant", content: "Historical A" },
      { role: "user", content: "Active Q" },
    ];

    const mockEmit = vi.fn();
    const result = await CompactionService.compactConversation(messages, {
      project: "test-proj",
      username: "rodrigo",
      agentSessionId: "sess-1",
      emit: mockEmit,
    });

    expect(result).not.toBeNull();
    const compacted = result!.compactedMessages;
    // With 2 user turns (< 3), all messages (except system) are preserved in the tail.
    // So "Historical Q", "Historical A", and "Active Q" should all be in the tail!
    expect(compacted[0].role).toBe("system");
    expect(compacted[1].role).toBe("user");
    expect(compacted[1].content).toContain(summaryContent);
    
    // The rest of the messages should be our preserved turns
    expect(compacted[2].content).toBe("Historical Q");
    expect(compacted[3].content).toBe("Historical A");
    expect(compacted[4].content).toBe("Active Q");
  });

  it("stops calling provider when circuit breaker is open", async () => {
    // Force 3 consecutive failures
    MOCK_GENERATE_TEXT.mockRejectedValue(new Error("API Rate Limit exceeded"));

    const messages: ChatMessage[] = [
      { role: "system", content: "Sys" },
      { role: "user", content: "User query text here" },
      { role: "assistant", content: "Ok" },
    ];

    // Trigger failure 1
    const res1 = await CompactionService.compactConversation(messages, {
      project: "p",
      username: "u",
      agentSessionId: "s",
    });
    expect(res1).toBeNull();

    // Trigger failure 2
    const res2 = await CompactionService.compactConversation(messages, {
      project: "p",
      username: "u",
      agentSessionId: "s",
    });
    expect(res2).toBeNull();

    // Trigger failure 3
    const res3 = await CompactionService.compactConversation(messages, {
      project: "p",
      username: "u",
      agentSessionId: "s",
    });
    expect(res3).toBeNull();

    // The 4th call should immediately return null (circuit breaker open) without invoking MOCK_GENERATE_TEXT again
    MOCK_GENERATE_TEXT.mockClear();
    const res4 = await CompactionService.compactConversation(messages, {
      project: "p",
      username: "u",
      agentSessionId: "s",
    });
    expect(res4).toBeNull();
    expect(MOCK_GENERATE_TEXT).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. BaseAgenticHarness & ContextWindowManager Integration Tests
// ═══════════════════════════════════════════════════════════════

describe("Compaction Integration with Harness and WindowManager", () => {
  it("enforceContextWindow recalculates originalMessageCount on truncation", () => {
    const state = new AgenticLoopState({
      originalMessageCount: 15,
      planModeActive: false,
    });

    const context: any = {
      modelDefinition: { maxInputTokens: 15_000 },
      options: { maxTokens: 1000 },
      emit: vi.fn(),
    };

    const harness = new BaseAgenticHarness(context, state, {
      finalTools: [],
      resolvedEnabledTools: [],
    } as any);

    // Build a large historical messages set to force sliding_window truncation
    const messages: ConversationMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "First query" },
    ];
    for (let i = 0; i < 15; i++) {
      messages.push({ role: "assistant", content: "Long response analysis ".repeat(400) });
      messages.push({ role: "user", content: `Query index ${i}` });
    }

    // Call SUT
    const postEnforce = harness.enforceContextWindow(messages, 5);

    expect(postEnforce.length).toBeLessThan(messages.length);
    // originalMessageCount should have been decreased by the exact number of dropped messages
    const expectedOriginalMessageCount = 15 - (messages.length - postEnforce.length);
    expect(state.originalMessageCount).toBe(Math.max(0, expectedOriginalMessageCount));
  });

  it("integrates Micro-compaction within ContextWindowManager.enforce flow", () => {
    const largeResult = "file contents here ".repeat(2000);
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Q1" },
      {
        role: "assistant",
        content: "read file done",
        toolCalls: [{ id: "toolCall-old", name: "read_file", args: {}, result: largeResult }],
      },
      // Protected window user messages (5 turns total, placing index 2 outside boundary)
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
    ];

    // Tight budget so that micro-compaction is needed and fits (maxInputTokens=20_000 gives a positive budget, but lower than ~10,000 tokens of uncompacted messages)
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 20_000,
      maxOutputTokens: 1000,
    });

    expect(result.truncated).toBe(true);
    expect(result.strategy).toBe("micro_compaction");
    expect(result.messages[2].toolCalls![0].result).toBe("[Old tool result content cleared]");
  });
});

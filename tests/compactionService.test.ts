import { describe, it, expect, vi, beforeEach } from "vitest";
import CompactionService from "../src/services/compact/CompactionService.ts";
import AutoCompactionTrigger from "../src/services/compact/AutoCompactionTrigger.ts";
import MicroCompactionService from "../src/services/compact/MicroCompactionService.ts";
import SettingsService from "../src/services/SettingsService.ts";
import RequestLogger from "../src/services/RequestLogger.ts";
import { TOOL_NAMES } from "../src/services/ToolTaxonomyConstants.ts";

const mockGenerateText = vi.fn();

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      extractionProvider: "google",
      extractionModel: "gemini-3-flash-preview",
    }),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logBackgroundLlmCall: vi.fn(),
  },
}));

describe("AutoCompactionTrigger", () => {
  it("should calculate effective context window correctly", () => {
    const effectiveWindowSmaller = AutoCompactionTrigger.getEffectiveContextWindowSize(100000, 10000);
    expect(effectiveWindowSmaller).toBe(90000);

    const effectiveWindowLarger = AutoCompactionTrigger.getEffectiveContextWindowSize(100000, 30000);
    expect(effectiveWindowLarger).toBe(80000); // capped at 20_000 reserve
  });

  it("should calculate auto compact threshold correctly", () => {
    const threshold = AutoCompactionTrigger.getAutoCompactThreshold(100000, 10000);
    expect(threshold).toBe(77000); // 90000 - 13000
  });

  it("should evaluate shouldCompact correctly", () => {
    // Under threshold, enough messages -> false
    const evaluationUnder = AutoCompactionTrigger.evaluate(50000, 100000, 10000, 10);
    expect(evaluationUnder.shouldCompact).toBe(false);
    expect(evaluationUnder.percentUsed).toBe(56); // 50000 / 90000 = 56%

    // Over threshold, not enough messages -> false
    const evaluationOverFewMessages = AutoCompactionTrigger.evaluate(80000, 100000, 10000, 4);
    expect(evaluationOverFewMessages.shouldCompact).toBe(false);

    // Over threshold, enough messages -> true
    const evaluationOver = AutoCompactionTrigger.evaluate(80000, 100000, 10000, 10);
    expect(evaluationOver.shouldCompact).toBe(true);
    expect(evaluationOver.threshold).toBe(77000);
  });
});

describe("MicroCompactionService", () => {
  it("should protect recent turns and compact old large tool results", () => {
    const messages = [
      {
        role: "user",
        content: "First turn user message",
      },
      {
        role: "assistant",
        content: "First turn assistant message",
        toolCalls: [
          {
            id: "call-1",
            name: TOOL_NAMES.READ_FILE,
            args: { path: "test.js" },
            result: "a".repeat(3000), // ~750 tokens (well over 500 threshold)
          },
          {
            id: "call-2",
            name: TOOL_NAMES.SHELL,
            args: { command: "ls" },
            result: "short", // too short to compact
          },
          {
            id: "call-3",
            name: "non-compactable-tool",
            args: {},
            result: "a".repeat(2000), // large but tool not compactable
          },
        ],
      },
      {
        role: "user",
        content: "Protected turn 1",
      },
      {
        role: "assistant",
        content: "Protected turn 1 response",
      },
      {
        role: "user",
        content: "Protected turn 2",
      },
      {
        role: "assistant",
        content: "Protected turn 2 response",
      },
      {
        role: "user",
        content: "Protected turn 3",
      },
      {
        role: "assistant",
        content: "Protected turn 3 response",
        toolCalls: [
          {
            id: "call-4",
            name: TOOL_NAMES.READ_FILE,
            args: { path: "another.js" },
            result: "a".repeat(5000), // protected, should not be cleared
          },
        ],
      },
      {
        role: "user",
        content: "Protected turn 4",
      },
      {
        role: "assistant",
        content: "Protected turn 4 response",
      },
    ];

    const result = MicroCompactionService.microcompactMessages(messages, 4);

    expect(result.clearedResultCount).toBe(1);
    expect(result.freedTokens).toBeGreaterThan(0);

    const firstMessageToolCalls = result.messages[1].toolCalls;
    expect(firstMessageToolCalls).toBeDefined();
    if (firstMessageToolCalls) {
      // First tool call result in old turn should be cleared
      expect(firstMessageToolCalls[0].result).toBe("[Old tool result content cleared]");
      // Second tool call (short) should remain
      expect(firstMessageToolCalls[1].result).toBe("short");
      // Third tool call (non-compactable tool) should remain
      expect(firstMessageToolCalls[2].result).toBe("a".repeat(2000));
    }

    const protectedMessageToolCalls = result.messages[7].toolCalls;
    expect(protectedMessageToolCalls).toBeDefined();
    if (protectedMessageToolCalls) {
      // Protected recent turn tool call should remain
      expect(protectedMessageToolCalls[0].result).toBe("a".repeat(5000));
    }

    // Ensure we did not mutate the original message array
    expect(messages[1].toolCalls?.[0].result).toBe("a".repeat(3000));
  });
});

describe("CompactionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CompactionService.resetCircuitBreaker();
  });

  const sampleMessages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "User turn 1" },
    { role: "assistant", content: "Assistant response 1", toolCalls: [] },
    { role: "user", content: "User turn 2" },
    { role: "assistant", content: "Assistant response 2" },
    { role: "user", content: "User turn 3" },
    { role: "assistant", content: "Assistant response 3" },
    { role: "user", content: "User turn 4" },
    { role: "assistant", content: "Assistant response 4" },
  ];

  it("should return null if settings are not configured or missing provider/model", async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValueOnce(null as any);
    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });
    expect(result).toBeNull();

    vi.mocked(SettingsService.getSection).mockResolvedValueOnce({
      extractionProvider: "",
      extractionModel: "",
    });
    const resultEmpty = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });
    expect(resultEmpty).toBeNull();
  });

  it("should return null if settings check throws", async () => {
    vi.mocked(SettingsService.getSection).mockRejectedValueOnce(new Error("Database disconnected"));
    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });
    expect(result).toBeNull();
  });

  it("should return null if circuit breaker is open", async () => {
    // Trigger 3 failures
    mockGenerateText.mockRejectedValue(new Error("LLM failure"));
    for (let i = 0; i < 3; i++) {
      await CompactionService.compactConversation(sampleMessages, {
        project: "test-proj",
        username: "rodrigo",
      });
    }

    // Fourth run should skip instantly without calling SettingsService or LLM
    vi.mocked(SettingsService.getSection).mockClear();
    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });

    expect(result).toBeNull();
    expect(SettingsService.getSection).not.toHaveBeenCalled();
  });

  it("should compact conversation successfully on LLM success", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "<analysis>Thinking about the summary...</analysis><summary>This is the conversation summary.</summary>",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const emitFunctionSpy = vi.fn();

    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
      emit: emitFunctionSpy,
    });

    expect(result).not.toBeNull();
    if (result) {
      expect(result.summaryText).toBe("This is the conversation summary.");
      expect(result.compactedMessages[0]).toEqual({
        role: "system",
        content: "You are an assistant.",
      });
      // Compact summary is index 1
      expect(result.compactedMessages[1]).toEqual(expect.objectContaining({
        role: "user",
        isCompactSummary: true,
      }));
      expect(result.compactedMessages[1].content).toContain("This is the conversation summary.");

      // Recent tail should be preserved. RECENT_TAIL_TURN_COUNT = 3.
      // Last 3 user turns: "User turn 2", "User turn 3", "User turn 4".
      // They and their assistant responses should be kept.
      const userTurnTwoIndex = result.compactedMessages.findIndex(
        (message) => message.role === "user" && message.content === "User turn 2"
      );
      expect(userTurnTwoIndex).toBeGreaterThan(1);
      expect(result.compactedMessages[userTurnTwoIndex + 1].content).toBe("Assistant response 2");
    }

    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledTimes(1);
    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      provider: "google",
      model: "gemini-3-flash-preview",
    }));

    // Expecting statuses and usage updates
    expect(emitFunctionSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "status",
      message: "compaction_started",
    }));
    expect(emitFunctionSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "status",
      message: "compaction_complete",
    }));
    expect(emitFunctionSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "usage_update",
    }));
  });

  it("should handle LLM failure, incrementing circuit breaker and emitting status", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("Quota exceeded"));
    const emitFunctionSpy = vi.fn();

    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
      emit: emitFunctionSpy,
    });

    expect(result).toBeNull();
    expect(emitFunctionSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "status",
      message: "compaction_failed",
    }));
    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      errorMessage: "Quota exceeded",
    }));
  });

  it("should handle LLM missing summary tag correctly by fallback to whole response", async () => {
    // Response with no tags but long enough text
    mockGenerateText.mockResolvedValueOnce({
      text: "This is a direct, long summary of the user requests without tags. ".repeat(10),
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });

    expect(result).not.toBeNull();
    expect(result?.summaryText).toContain("This is a direct, long summary");
  });

  it("should handle LLM returning no summary content by failing gracefully", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "short",
      usage: { inputTokens: 100, outputTokens: 5 },
    });

    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });

    expect(result).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import CompactionService from "#src/services/compact/CompactionService";
import AutoCompactionTrigger from "#src/services/compact/AutoCompactionTrigger";
import MicroCompactionService from "#src/services/compact/MicroCompactionService";
import { OFFLOAD_STUB_HEADER } from "#src/services/compact/ToolResultOffloadService";
import SettingsService from "#src/services/SettingsService";
import RequestLogger from "#src/services/RequestLogger";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";

const mockGenerateText = vi.fn();

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      extractionProvider: PROVIDERS.GOOGLE,
      extractionModel: "gemini-3-flash-preview",
    }),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
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
    expect(result.offloadedResultCount).toBe(1);
    expect(result.freedTokens).toBeGreaterThan(0);

    const firstMessageToolCalls = result.messages[1].toolCalls;
    expect(firstMessageToolCalls).toBeDefined();
    if (firstMessageToolCalls) {
      // First tool call result in old turn should be evicted to a
      // recoverable pointer stub carrying the offload id
      expect(firstMessageToolCalls[0].result).toContain(OFFLOAD_STUB_HEADER);
      expect(firstMessageToolCalls[0].result).toContain("offload_id: call-1");
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

  // Long filler makes the history genuinely large — the shrink guard
  // discards compactions that don't reduce token count, so fixtures must
  // represent a conversation actually worth compacting.
  const filler = " lorem ipsum dolor sit amet".repeat(400);
  const sampleMessages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: `User turn 1${filler}` },
    { role: "assistant", content: `Assistant response 1${filler}`, toolCalls: [] },
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

  it("should append judge additions when the summary drops critical facts", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "<summary>A summary that forgot the config path.</summary>",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    // Judge flags a missing fact (Slipstream trajectory-grounded judge)
    mockGenerateText.mockResolvedValueOnce({
      text: "<additions>\n- Config lives at /etc/prism/config.yaml\n</additions>",
      usage: { inputTokens: 50, outputTokens: 20 },
    });

    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });

    expect(result).not.toBeNull();
    expect(result!.summaryText).toContain("A summary that forgot the config path.");
    expect(result!.summaryText).toContain("Validation additions");
    expect(result!.summaryText).toContain("/etc/prism/config.yaml");
  });

  it("offloads large dropped-span tool results and indexes them in the summary", async () => {
    const bigResult = "ROW ".repeat(2000); // well over the offload threshold
    const messagesWithDroppedResult = [
      { role: "system", content: "You are an assistant." },
      {
        role: "assistant",
        content: `Fetched the data${filler}`,
        toolCalls: [
          { id: "call-dropped", name: "read_web_page", args: {}, result: bigResult },
        ],
      },
      { role: "user", content: "User turn 2" },
      { role: "assistant", content: "Assistant response 2" },
      { role: "user", content: "User turn 3" },
      { role: "assistant", content: "Assistant response 3" },
      { role: "user", content: "User turn 4" },
      { role: "assistant", content: "Assistant response 4" },
    ];
    mockGenerateText.mockResolvedValueOnce({
      text: "<summary>Data was fetched and processed.</summary>",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    mockGenerateText.mockResolvedValueOnce({ text: "<ok/>", usage: { inputTokens: 10, outputTokens: 2 } });

    const result = await CompactionService.compactConversation(
      messagesWithDroppedResult,
      { project: "test-proj", username: "rodrigo", agentConversationId: "conv-x" },
    );

    expect(result).not.toBeNull();
    const summaryMessage = result!.compactedMessages.find(
      (message) => (message as { isCompactSummary?: boolean }).isCompactSummary,
    );
    expect(summaryMessage!.content).toContain("Recoverable offloaded tool results");
    expect(summaryMessage!.content).toContain("offload_id: call-dropped");
    expect(summaryMessage!.content).toContain("read_web_page");
  });

  it("keeps the original summary when the judge call fails (fail-open)", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "<summary>Original summary text that is long enough to survive.</summary>",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    mockGenerateText.mockRejectedValueOnce(new Error("judge model down"));

    const result = await CompactionService.compactConversation(sampleMessages, {
      project: "test-proj",
      username: "rodrigo",
    });

    expect(result).not.toBeNull();
    expect(result!.summaryText).toBe(
      "Original summary text that is long enough to survive.",
    );
  });

  it("should compact conversation successfully on LLM success", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "<analysis>Thinking about the summary...</analysis><summary>This is the conversation summary.</summary>",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    // Second call is the summary judge (Slipstream) — approves as-is
    mockGenerateText.mockResolvedValueOnce({
      text: "<ok/>",
      usage: { inputTokens: 50, outputTokens: 5 },
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

    // Two background calls: compact:summarize + compact:judge
    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledTimes(2);
    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledWith(expect.objectContaining({
      operation: "compact:summarize",
      success: true,
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3-flash-preview",
    }));
    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledWith(expect.objectContaining({
      operation: "compact:judge",
      success: true,
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

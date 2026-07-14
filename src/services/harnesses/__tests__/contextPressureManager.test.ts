import { describe, it, expect, vi, beforeEach } from "vitest";
import { manageContextPressure } from "#src/services/harnesses/lifecycle/ContextPressureManager";
import type { ConversationMessage, AgenticContext } from "#src/services/harnesses/types";
import type AgenticLoopState from "#src/services/AgenticLoopState";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@rodrigo-barraza/utilities-library", () => ({
  errorMessage: vi.fn((error: unknown) => String(error)),
}));

const mockMicrocompactMessages = vi.fn().mockReturnValue({
  messages: [],
  clearedResultCount: 0,
  freedTokens: 0,
});

vi.mock("#src/services/compact/MicroCompactionService", () => ({
  default: {
    microcompactMessages: (...arguments_: unknown[]) => mockMicrocompactMessages(...arguments_),
  },
}));

const mockEvaluate = vi.fn().mockReturnValue({ shouldCompact: false });

vi.mock("#src/services/compact/AutoCompactionTrigger", () => ({
  default: {
    evaluate: (...arguments_: unknown[]) => mockEvaluate(...arguments_),
  },
}));

const mockCompactConversation = vi.fn().mockResolvedValue(null);

vi.mock("#src/services/compact/CompactionService", () => ({
  default: {
    compactConversation: (...arguments_: unknown[]) => mockCompactConversation(...arguments_),
  },
}));

const mockPersistCompactionSummary = vi.fn().mockResolvedValue(undefined);

vi.mock("#src/services/ConversationEmbeddingService", () => ({
  default: {
    persistCompactionSummary: (...arguments_: unknown[]) => mockPersistCompactionSummary(...arguments_),
  },
}));

const mockEstimateTokens = vi.fn().mockReturnValue(5000);

vi.mock("#src/services/ContextWindowManager", () => ({
  default: {
    estimateTokens: (...arguments_: unknown[]) => mockEstimateTokens(...arguments_),
  },
}));

describe("ContextPressureManager — manageContextPressure", () => {
  let mockContext: AgenticContext;
  let mockState: AgenticLoopState;

  function createMessages(count: number): ConversationMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Message ${index}`,
    })) as ConversationMessage[];
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockEstimateTokens.mockReturnValue(5000);
    mockMicrocompactMessages.mockReturnValue({
      messages: [],
      clearedResultCount: 0,
      freedTokens: 0,
    });
    mockEvaluate.mockReturnValue({ shouldCompact: false });
    mockCompactConversation.mockResolvedValue(null);

    mockContext = {
      project: "test",
      username: "user",
      agent: "CODING",
      providerName: "google",
      resolvedModel: "gemini-3.5-flash",
      traceId: "trace-cpm",
      agentConversationId: "session-cpm",
      conversationId: "conv-cpm",
      emit: vi.fn(),
      signal: undefined,
      options: { maxTokens: 8192 },
      modelDefinition: { maxInputTokens: 128000 },
    } as unknown as AgenticContext;

    mockState = {
      originalMessageCount: 10,
      compactionPerformed: false,
      preCompactTokenCount: null,
      postCompactTokenCount: null,
    } as unknown as AgenticLoopState;
  });

  describe("no pressure scenario (under 70% threshold)", () => {
    it("should return original messages when context pressure is low", async () => {
      const messages = createMessages(10);
      mockEstimateTokens.mockReturnValue(50000);

      const result = await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(result.messages).toBe(messages);
      expect(result.tokenEstimate).toBe(50000);
      expect(mockMicrocompactMessages).not.toHaveBeenCalled();
    });

    it("should still evaluate auto-compaction even at low pressure", async () => {
      const messages = createMessages(5);
      mockEstimateTokens.mockReturnValue(10000);

      await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(mockEvaluate).toHaveBeenCalledWith(10000, 128000, 8192, 5);
    });
  });

  describe("micro-compaction at high pressure (> 70%)", () => {
    it("should trigger micro-compaction when pressure exceeds 70%", async () => {
      const messages = createMessages(20);
      // availableInputBudget = 128000 - 8192 = 119808
      // 70% of 119808 = 83866
      // Setting token estimate to 90000 → ratio = ~0.75 (> 0.7)
      mockEstimateTokens
        .mockReturnValueOnce(90000)
        .mockReturnValueOnce(70000);

      const compactedMessages = createMessages(15);
      mockMicrocompactMessages.mockReturnValue({
        messages: compactedMessages,
        clearedResultCount: 5,
        freedTokens: 20000,
      });

      const result = await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(mockMicrocompactMessages).toHaveBeenCalledTimes(1);
      expect(result.messages).toEqual(compactedMessages);
      expect(result.tokenEstimate).toBe(70000);
    });

    it("should not replace messages when micro-compaction clears zero results", async () => {
      const messages = createMessages(10);
      mockEstimateTokens.mockReturnValue(100000);
      mockMicrocompactMessages.mockReturnValue({
        messages: createMessages(10),
        clearedResultCount: 0,
        freedTokens: 0,
      });

      const result = await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(result.messages).toBe(messages);
    });

    it("should not trigger micro-compaction when available input budget is zero", async () => {
      const messages = createMessages(5);
      mockEstimateTokens.mockReturnValue(5000);
      // maxInputTokens not set → fallback to 128000, maxTokens = 8192
      // But if context window were tiny (e.g., model with 8192 input), budget = 0

      const tinyContext = {
        ...mockContext,
        modelDefinition: { maxInputTokens: 8192 },
        options: { maxTokens: 8192 },
      } as unknown as AgenticContext;

      await manageContextPressure(messages, tinyContext, mockState, "TestHarness");

      // availableInputBudget = 8192 - 8192 = 0
      // contextPressureRatio = 5000/0 = 0 (guarded by > 0 check)
      expect(mockMicrocompactMessages).not.toHaveBeenCalled();
    });
  });

  describe("auto-compaction trigger", () => {
    it("should execute full compaction when auto-compaction triggers", async () => {
      const messages = createMessages(30);
      mockEstimateTokens
        .mockReturnValueOnce(50000)
        .mockReturnValueOnce(20000);
      mockEvaluate.mockReturnValue({ shouldCompact: true });

      const compactedMessages = createMessages(5);
      mockCompactConversation.mockResolvedValue({
        compactedMessages,
        preCompactTokenCount: 50000,
        postCompactTokenCount: 20000,
        summaryText: "Session summary: Built authentication module.",
      });

      const result = await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(mockCompactConversation).toHaveBeenCalledTimes(1);
      expect(result.messages).toEqual(compactedMessages);
      expect(result.tokenEstimate).toBe(20000);
      expect(mockState.compactionPerformed).toBe(true);
      expect(mockState.preCompactTokenCount).toBe(50000);
      expect(mockState.postCompactTokenCount).toBe(20000);
    });

    it("should persist compaction summary to embedding service", async () => {
      const messages = createMessages(20);
      mockEstimateTokens.mockReturnValue(30000);
      mockEvaluate.mockReturnValue({ shouldCompact: true });
      mockCompactConversation.mockResolvedValue({
        compactedMessages: createMessages(5),
        preCompactTokenCount: 30000,
        postCompactTokenCount: 10000,
        summaryText: "User built a REST API with Express.",
      });

      await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(mockPersistCompactionSummary).toHaveBeenCalledWith(
        "conv-cpm",
        "test",
        "user",
        "User built a REST API with Express.",
      );
    });

    it("should skip summary persistence when conversationId is null", async () => {
      const contextWithoutConversationId = {
        ...mockContext,
        conversationId: null,
      } as unknown as AgenticContext;

      const messages = createMessages(20);
      mockEstimateTokens.mockReturnValue(30000);
      mockEvaluate.mockReturnValue({ shouldCompact: true });
      mockCompactConversation.mockResolvedValue({
        compactedMessages: createMessages(5),
        preCompactTokenCount: 30000,
        postCompactTokenCount: 10000,
        summaryText: "Summary text",
      });

      await manageContextPressure(messages, contextWithoutConversationId, mockState, "TestHarness");

      expect(mockPersistCompactionSummary).not.toHaveBeenCalled();
    });

    it("should skip summary persistence when summaryText is empty", async () => {
      const messages = createMessages(20);
      mockEstimateTokens.mockReturnValue(30000);
      mockEvaluate.mockReturnValue({ shouldCompact: true });
      mockCompactConversation.mockResolvedValue({
        compactedMessages: createMessages(5),
        preCompactTokenCount: 30000,
        postCompactTokenCount: 10000,
        summaryText: "",
      });

      await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(mockPersistCompactionSummary).not.toHaveBeenCalled();
    });

    it("should handle auto-compaction returning null (no compaction needed)", async () => {
      const messages = createMessages(10);
      mockEstimateTokens.mockReturnValue(20000);
      mockEvaluate.mockReturnValue({ shouldCompact: true });
      mockCompactConversation.mockResolvedValue(null);

      const result = await manageContextPressure(messages, mockContext, mockState, "TestHarness");

      expect(result.messages).toBe(messages);
      expect(mockState.compactionPerformed).toBe(false);
    });
  });

  describe("pipeline integration — micro then auto compaction", () => {
    it("should run both micro and auto compaction sequentially", async () => {
      const originalMessages = createMessages(40);
      const afterMicroMessages = createMessages(30);
      const afterAutoMessages = createMessages(10);

      mockEstimateTokens
        .mockReturnValueOnce(100000) // initial estimate
        .mockReturnValueOnce(85000)  // after micro-compaction
        .mockReturnValueOnce(25000); // after auto-compaction

      mockMicrocompactMessages.mockReturnValue({
        messages: afterMicroMessages,
        clearedResultCount: 10,
        freedTokens: 15000,
      });

      mockEvaluate.mockReturnValue({ shouldCompact: true });
      mockCompactConversation.mockResolvedValue({
        compactedMessages: afterAutoMessages,
        preCompactTokenCount: 85000,
        postCompactTokenCount: 25000,
        summaryText: "Full pipeline compaction summary.",
      });

      const result = await manageContextPressure(originalMessages, mockContext, mockState, "TestHarness");

      expect(mockMicrocompactMessages).toHaveBeenCalledTimes(1);
      expect(mockCompactConversation).toHaveBeenCalledTimes(1);
      expect(result.messages).toEqual(afterAutoMessages);
      expect(result.tokenEstimate).toBe(25000);
    });
  });

  describe("default fallbacks", () => {
    it("should use 128000 as default context window when modelDefinition is null", async () => {
      const contextWithoutModelDefinition = {
        ...mockContext,
        modelDefinition: null,
      } as unknown as AgenticContext;

      const messages = createMessages(5);
      mockEstimateTokens.mockReturnValue(5000);

      await manageContextPressure(messages, contextWithoutModelDefinition, mockState, "TestHarness");

      // Should have evaluated with 128000 context window
      expect(mockEvaluate).toHaveBeenCalledWith(5000, 128000, 8192, 5);
    });

    it("should use 16384 as default maxTokens when not configured", async () => {
      const contextWithoutMaxTokens = {
        ...mockContext,
        options: {},
      } as unknown as AgenticContext;

      const messages = createMessages(5);
      mockEstimateTokens.mockReturnValue(5000);

      await manageContextPressure(messages, contextWithoutMaxTokens, mockState, "TestHarness");

      expect(mockEvaluate).toHaveBeenCalledWith(5000, 128000, 16384, 5);
    });
  });
});

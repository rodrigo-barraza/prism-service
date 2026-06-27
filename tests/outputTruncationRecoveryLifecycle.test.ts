import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isOutputTruncated,
  calculateEscalatedMaxTokens,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "../src/services/harnesses/lifecycle/OutputTruncationRecovery.ts";
import type { ConversationMessage, PassState, AgenticContext } from "../src/services/harnesses/types.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("OutputTruncationRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isOutputTruncated", () => {
    it("should return true when stopReason is 'length'", () => {
      const pass = { stopReason: "length" } as PassState;
      expect(isOutputTruncated(pass)).toBe(true);
    });

    it("should return true when stopReason is 'max_tokens'", () => {
      const pass = { stopReason: "max_tokens" } as PassState;
      expect(isOutputTruncated(pass)).toBe(true);
    });

    it("should return false when stopReason is 'end_turn'", () => {
      const pass = { stopReason: "end_turn" } as PassState;
      expect(isOutputTruncated(pass)).toBe(false);
    });

    it("should return false when stopReason is 'stop'", () => {
      const pass = { stopReason: "stop" } as PassState;
      expect(isOutputTruncated(pass)).toBe(false);
    });

    it("should return false when stopReason is undefined", () => {
      const pass = {} as PassState;
      expect(isOutputTruncated(pass)).toBe(false);
    });

    it("should return false when stopReason is null", () => {
      const pass = { stopReason: null } as unknown as PassState;
      expect(isOutputTruncated(pass)).toBe(false);
    });
  });

  describe("calculateEscalatedMaxTokens", () => {
    it("should multiply by 1.5 for recovery attempt 1", () => {
      const escalated = calculateEscalatedMaxTokens(8192, 1);
      expect(escalated).toBe(Math.ceil(8192 * 1.5));
    });

    it("should multiply by 1.5^2 for recovery attempt 2", () => {
      const escalated = calculateEscalatedMaxTokens(8192, 2);
      expect(escalated).toBe(Math.ceil(8192 * Math.pow(1.5, 2)));
    });

    it("should multiply by 1.5^3 for recovery attempt 3", () => {
      const escalated = calculateEscalatedMaxTokens(8192, 3);
      expect(escalated).toBe(Math.ceil(8192 * Math.pow(1.5, 3)));
    });

    it("should return the same value for attempt 0 (1.5^0 = 1)", () => {
      const escalated = calculateEscalatedMaxTokens(4096, 0);
      expect(escalated).toBe(4096);
    });

    it("should handle small maxTokens values", () => {
      const escalated = calculateEscalatedMaxTokens(100, 1);
      expect(escalated).toBe(150);
    });
  });

  describe("injectContinuationContext", () => {
    function createMockPass(overrides?: Partial<PassState>): PassState {
      return {
        streamedText: overrides?.streamedText ?? "partial output that was truncated",
        streamedThinking: overrides?.streamedThinking ?? "",
        thinkingSignature: overrides?.thinkingSignature ?? null,
        stopReason: overrides?.stopReason ?? "length",
        usage: overrides?.usage ?? { inputTokens: 0, outputTokens: 0 },
      } as PassState;
    }

    function createMockContext(overrides?: Partial<AgenticContext>): AgenticContext {
      return {
        emit: vi.fn(),
        options: { maxTokens: overrides?.options?.maxTokens ?? 8192 },
        resolvedModel: "gemini-3.5-flash",
        project: "test",
        username: "user",
        agent: "CODING",
        providerName: "google",
        traceId: "trace-1",
        agentConversationId: "session-1",
        conversationId: "conv-1",
        ...overrides,
      } as AgenticContext;
    }

    it("should push truncated text as assistant message and continuation prompt as system message", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass({ streamedText: "This was cut short..." });
      const context = createMockContext();

      injectContinuationContext(currentMessages, pass, context, 1);

      expect(currentMessages).toHaveLength(2);
      expect(currentMessages[0].role).toBe("assistant");
      expect(currentMessages[0].content).toBe("This was cut short...");
      expect(currentMessages[1].role).toBe("system");
      expect(currentMessages[1].content).toContain("truncated");
      expect(currentMessages[1].content).toContain("Continue exactly where you left off");
    });

    it("should include thinking content in assistant message when present", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass({
        streamedText: "Output text",
        streamedThinking: "Internal reasoning here",
      });
      const context = createMockContext();

      injectContinuationContext(currentMessages, pass, context, 1);

      expect(currentMessages[0].thinking).toBe("Internal reasoning here");
    });

    it("should include thinkingSignature when present", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass({
        streamedText: "Output text",
        streamedThinking: "reasoning",
        thinkingSignature: "sig-abc-123",
      });
      const context = createMockContext();

      injectContinuationContext(currentMessages, pass, context, 1);

      expect(currentMessages[0].thinkingSignature).toBe("sig-abc-123");
    });

    it("should skip assistant message when truncated content is empty", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass({ streamedText: "", streamedThinking: "" });
      const context = createMockContext();

      injectContinuationContext(currentMessages, pass, context, 1);

      // Only the system continuation prompt should be added
      expect(currentMessages).toHaveLength(1);
      expect(currentMessages[0].role).toBe("system");
    });

    it("should return escalated maxTokens based on recovery attempt", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass();
      const context = createMockContext({ options: { maxTokens: 4096 } } as any);

      const escalatedMaxTokens = injectContinuationContext(currentMessages, pass, context, 2);

      expect(escalatedMaxTokens).toBe(Math.ceil(4096 * Math.pow(1.5, 2)));
    });

    it("should use default maxTokens (8192) when not configured", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass();
      const context = createMockContext({ options: {} } as any);

      const escalatedMaxTokens = injectContinuationContext(currentMessages, pass, context, 1);

      expect(escalatedMaxTokens).toBe(Math.ceil(8192 * 1.5));
    });

    it("should emit output_truncation_recovery status event", () => {
      const currentMessages: ConversationMessage[] = [];
      const pass = createMockPass();
      const context = createMockContext();

      injectContinuationContext(currentMessages, pass, context, 2);

      expect(context.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          message: "output_truncation_recovery",
          attempt: 2,
          maxAttempts: MAX_OUTPUT_TRUNCATION_RECOVERIES,
        }),
      );
    });
  });

  describe("injectErrorAsConversationMessage", () => {
    it("should push error message as assistant role with error indicator", () => {
      const currentMessages: ConversationMessage[] = [];
      const context = {
        emit: vi.fn(),
      } as unknown as AgenticContext;

      injectErrorAsConversationMessage(currentMessages, "Something went wrong", context);

      expect(currentMessages).toHaveLength(1);
      expect(currentMessages[0].role).toBe("assistant");
      expect(currentMessages[0].content).toContain("⚠️");
      expect(currentMessages[0].content).toContain("Something went wrong");
      expect(currentMessages[0]._isErrorIndicator).toBe(true);
    });

    it("should emit the error content as a chunk event", () => {
      const currentMessages: ConversationMessage[] = [];
      const emitSpy = vi.fn();
      const context = { emit: emitSpy } as unknown as AgenticContext;

      injectErrorAsConversationMessage(currentMessages, "Provider timeout", context);

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chunk",
          content: expect.stringContaining("Provider timeout"),
        }),
      );
    });
  });

  describe("buildExhaustedRecoveryMessage", () => {
    it("should include max attempts count and configured token limit", () => {
      const message = buildExhaustedRecoveryMessage(3, 8192);

      expect(message).toContain("3");
      expect(message).toContain("8192");
      expect(message).toContain("max_tokens");
      expect(message).toContain("Max Tokens");
    });

    it("should work with string token limit", () => {
      const message = buildExhaustedRecoveryMessage(2, "16384");

      expect(message).toContain("2");
      expect(message).toContain("16384");
    });
  });

  describe("buildProviderErrorMessage", () => {
    it("should include error text and iteration number", () => {
      const message = buildProviderErrorMessage(new Error("Connection refused"), 5);

      expect(message).toContain("Connection refused");
      expect(message).toContain("iteration 5");
      expect(message).toContain("preserved");
    });

    it("should handle non-Error objects", () => {
      const message = buildProviderErrorMessage("raw string error", 3);

      expect(message).toContain("raw string error");
      expect(message).toContain("iteration 3");
    });

    it("should handle null/undefined errors", () => {
      const message = buildProviderErrorMessage(null, 1);
      expect(message).toContain("iteration 1");
    });
  });

  describe("MAX_OUTPUT_TRUNCATION_RECOVERIES constant", () => {
    it("should be 3", () => {
      expect(MAX_OUTPUT_TRUNCATION_RECOVERIES).toBe(3);
    });
  });
});

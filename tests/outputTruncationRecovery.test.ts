/**
 * Tests for OutputTruncationRecovery lifecycle module.
 *
 * Verifies:
 *   1. Truncation detection via stopReason
 *   2. Token escalation math
 *   3. Continuation context injection into message array
 *   4. Error-as-context injection for provider failures
 *   5. Exhaustion message formatting
 *   6. End-to-end recovery flow in ReActHarness
 */
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

import type {
  PassState,
  AgenticContext,
  ConversationMessage,
} from "../src/services/harnesses/types.ts";

// ── Helper: create a minimal PassState ────────────────────────────────
function createMockPassState(overrides: Partial<PassState> = {}): PassState {
  return {
    streamedText: "",
    finalStreamedText: "",
    streamedThinking: "",
    thinkingSignature: "",
    pendingToolCalls: [],
    streamedImages: [],
    start: performance.now(),
    firstTokenTime: null,
    generationEnd: null,
    outputCharacters: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    options: {},
    requestId: null,
    ...overrides,
  };
}

// ── Helper: create a minimal AgenticContext ───────────────────────────
function createMockContext(overrides: Partial<AgenticContext> = {}): AgenticContext {
  return {
    options: { maxTokens: 8192 },
    agent: null,
    project: "test-project",
    username: "test-user",
    modelDef: null,
    messages: [],
    agentSessionId: "test-session",
    provider: {
      generateTextStream: vi.fn(),
    },
    providerName: "test-provider",
    resolvedModel: "test-model",
    emit: vi.fn(),
    ...overrides,
  } as unknown as AgenticContext;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Unit Tests: Pure Functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("OutputTruncationRecovery", () => {
  describe("isOutputTruncated", () => {
    it("should return true when stopReason is 'length'", () => {
      const pass = createMockPassState({ stopReason: "length" });
      expect(isOutputTruncated(pass)).toBe(true);
    });

    it("should return true when stopReason is 'max_tokens'", () => {
      const pass = createMockPassState({ stopReason: "max_tokens" });
      expect(isOutputTruncated(pass)).toBe(true);
    });

    it("should return false when stopReason is 'stop' (natural end)", () => {
      const pass = createMockPassState({ stopReason: "stop" });
      expect(isOutputTruncated(pass)).toBe(false);
    });

    it("should return false when stopReason is undefined", () => {
      const pass = createMockPassState({ stopReason: undefined });
      expect(isOutputTruncated(pass)).toBe(false);
    });

    it("should return false when stopReason is 'end_turn'", () => {
      const pass = createMockPassState({ stopReason: "end_turn" });
      expect(isOutputTruncated(pass)).toBe(false);
    });
  });

  describe("calculateEscalatedMaxTokens", () => {
    it("should escalate by 1.5x on first recovery", () => {
      const result = calculateEscalatedMaxTokens(8192, 1);
      expect(result).toBe(Math.ceil(8192 * 1.5));
    });

    it("should escalate by 1.5^2 on second recovery", () => {
      const result = calculateEscalatedMaxTokens(8192, 2);
      expect(result).toBe(Math.ceil(8192 * 1.5 * 1.5));
    });

    it("should escalate by 1.5^3 on third recovery", () => {
      const result = calculateEscalatedMaxTokens(8192, 3);
      expect(result).toBe(Math.ceil(8192 * Math.pow(1.5, 3)));
    });

    it("should handle small token values without rounding errors", () => {
      const result = calculateEscalatedMaxTokens(100, 1);
      expect(result).toBe(150);
    });
  });

  describe("MAX_OUTPUT_TRUNCATION_RECOVERIES", () => {
    it("should be set to 3 (matching Claude Code's MAX_OUTPUT_TOKENS_RECOVERY_LIMIT)", () => {
      expect(MAX_OUTPUT_TRUNCATION_RECOVERIES).toBe(3);
    });
  });

  describe("injectContinuationContext", () => {
    let currentMessages: ConversationMessage[];
    let mockContext: AgenticContext;

    beforeEach(() => {
      currentMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Write a very long essay." },
      ];
      mockContext = createMockContext();
    });

    it("should append the truncated assistant message to the conversation", () => {
      const pass = createMockPassState({
        streamedText: "The beginning of a very long essay about...",
        stopReason: "length",
      });

      injectContinuationContext(currentMessages, pass, mockContext, 1);

      const assistantMessage = currentMessages.find(
        (message) =>
          message.role === "assistant" &&
          message.content === "The beginning of a very long essay about...",
      );
      expect(assistantMessage).toBeDefined();
    });

    it("should append a continuation user message after the truncated output", () => {
      const pass = createMockPassState({
        streamedText: "Partial output...",
        stopReason: "length",
      });

      injectContinuationContext(currentMessages, pass, mockContext, 1);

      const lastMessage = currentMessages[currentMessages.length - 1];
      expect(lastMessage.role).toBe("user");
      expect(lastMessage.content).toContain("cut short");
      expect(lastMessage.content).toContain("continue exactly where you left off");
    });

    it("should return the escalated maxTokens value", () => {
      const pass = createMockPassState({
        streamedText: "output",
        stopReason: "max_tokens",
      });

      const escalatedMaxTokens = injectContinuationContext(
        currentMessages,
        pass,
        mockContext,
        1,
      );

      expect(escalatedMaxTokens).toBe(Math.ceil(8192 * 1.5));
    });

    it("should emit a status event with recovery metadata", () => {
      const pass = createMockPassState({
        streamedText: "output",
        stopReason: "length",
      });

      injectContinuationContext(currentMessages, pass, mockContext, 2);

      expect(mockContext.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "status",
          message: "output_truncation_recovery",
          attempt: 2,
          maxAttempts: MAX_OUTPUT_TRUNCATION_RECOVERIES,
        }),
      );
    });

    it("should preserve thinking content when present", () => {
      const pass = createMockPassState({
        streamedText: "text output",
        streamedThinking: "reasoning about the problem...",
        thinkingSignature: "sig-123",
        stopReason: "length",
      });

      injectContinuationContext(currentMessages, pass, mockContext, 1);

      const assistantMessage = currentMessages.find(
        (message) => message.role === "assistant" && message.content === "text output",
      );
      expect(assistantMessage?.thinking).toBe("reasoning about the problem...");
      expect(assistantMessage?.thinkingSignature).toBe("sig-123");
    });

    it("should use default maxTokens (8192) when context.options.maxTokens is not set", () => {
      mockContext.options.maxTokens = undefined;
      const pass = createMockPassState({ streamedText: "x", stopReason: "length" });

      const escalatedMaxTokens = injectContinuationContext(
        currentMessages,
        pass,
        mockContext,
        1,
      );

      expect(escalatedMaxTokens).toBe(Math.ceil(8192 * 1.5));
    });

    it("should not inject an empty assistant message when there is no text", () => {
      const pass = createMockPassState({
        streamedText: "",
        streamedThinking: "",
        stopReason: "length",
      });

      injectContinuationContext(currentMessages, pass, mockContext, 1);

      // Should only have the original 2 messages + continuation prompt (no empty assistant)
      expect(currentMessages).toHaveLength(3);
      expect(currentMessages[2].role).toBe("user");
    });
  });

  describe("injectErrorAsConversationMessage", () => {
    let currentMessages: ConversationMessage[];
    let mockContext: AgenticContext;

    beforeEach(() => {
      currentMessages = [
        { role: "user", content: "Do something" },
      ];
      mockContext = createMockContext();
    });

    it("should append an assistant-role error message to the conversation", () => {
      injectErrorAsConversationMessage(
        currentMessages,
        "Provider timed out after 30 seconds.",
        mockContext,
      );

      expect(currentMessages).toHaveLength(2);
      const errorMessage = currentMessages[1];
      expect(errorMessage.role).toBe("assistant");
      expect(errorMessage.content).toContain("⚠️ **Error:**");
      expect(errorMessage.content).toContain("Provider timed out");
    });

    it("should mark the message with _isErrorIndicator", () => {
      injectErrorAsConversationMessage(
        currentMessages,
        "Something went wrong.",
        mockContext,
      );

      const errorMessage = currentMessages[1];
      expect((errorMessage as any)._isErrorIndicator).toBe(true);
    });

    it("should emit the error text as a chunk event for the UI", () => {
      injectErrorAsConversationMessage(
        currentMessages,
        "API returned 529 Overloaded.",
        mockContext,
      );

      expect(mockContext.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chunk",
          content: expect.stringContaining("API returned 529 Overloaded"),
        }),
      );
    });
  });

  describe("buildExhaustedRecoveryMessage", () => {
    it("should include the number of attempts", () => {
      const message = buildExhaustedRecoveryMessage(3, 8192);
      expect(message).toContain("3 automatic");
    });

    it("should include the configured maxTokens value", () => {
      const message = buildExhaustedRecoveryMessage(3, 16384);
      expect(message).toContain("16384");
    });

    it("should suggest increasing the Max Tokens setting", () => {
      const message = buildExhaustedRecoveryMessage(3, "default");
      expect(message).toContain("Max Tokens");
    });

    it("should suggest breaking the task into smaller steps", () => {
      const message = buildExhaustedRecoveryMessage(3, 8192);
      expect(message).toContain("smaller steps");
    });
  });

  describe("buildProviderErrorMessage", () => {
    it("should include the error message from an Error object", () => {
      const error = new Error("Connection timed out");
      const message = buildProviderErrorMessage(error, 5);
      expect(message).toContain("Connection timed out");
    });

    it("should include the iteration number", () => {
      const error = new Error("Server error");
      const message = buildProviderErrorMessage(error, 3);
      expect(message).toContain("iteration 3");
    });

    it("should handle non-Error values gracefully", () => {
      const message = buildProviderErrorMessage("raw string error", 1);
      expect(message).toContain("raw string error");
    });

    it("should mention that conversation history is preserved", () => {
      const error = new Error("Timeout");
      const message = buildProviderErrorMessage(error, 1);
      expect(message).toContain("preserved");
    });

    it("should suggest retrying or switching provider", () => {
      const error = new Error("Rate limited");
      const message = buildProviderErrorMessage(error, 2);
      expect(message).toContain("retry");
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Integration: Recovery Flow Sequence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Recovery Flow Sequence", () => {
  it("should allow up to 3 recoveries before exhaustion", () => {
    const currentMessages: ConversationMessage[] = [
      { role: "user", content: "Write a long story" },
    ];
    const mockContext = createMockContext();

    for (let attempt = 1; attempt <= MAX_OUTPUT_TRUNCATION_RECOVERIES; attempt++) {
      const pass = createMockPassState({
        streamedText: `Part ${attempt} of the story...`,
        stopReason: "length",
      });

      expect(isOutputTruncated(pass)).toBe(true);

      const escalatedMaxTokens = injectContinuationContext(
        currentMessages,
        pass,
        mockContext,
        attempt,
      );

      // maxTokens should be escalating each time
      const expectedMaxTokens = Math.ceil(8192 * Math.pow(1.5, attempt));
      expect(escalatedMaxTokens).toBe(expectedMaxTokens);
    }

    // After 3 recoveries, conversation should have:
    // 1 original user + (3 assistant + 3 continuation user) = 7 messages
    expect(currentMessages).toHaveLength(7);

    // Verify the message sequence: user, assistant, user, assistant, user, assistant, user
    expect(currentMessages[0].role).toBe("user");
    expect(currentMessages[1].role).toBe("assistant");
    expect(currentMessages[2].role).toBe("user"); // continuation
    expect(currentMessages[3].role).toBe("assistant");
    expect(currentMessages[4].role).toBe("user"); // continuation
    expect(currentMessages[5].role).toBe("assistant");
    expect(currentMessages[6].role).toBe("user"); // continuation
  });

  it("should inject error-as-context after recovery exhaustion", () => {
    const currentMessages: ConversationMessage[] = [
      { role: "user", content: "Generate a huge file" },
    ];
    const mockContext = createMockContext({ options: { maxTokens: 4096 } });

    // Simulate 3 failed recovery attempts
    for (let attempt = 1; attempt <= MAX_OUTPUT_TRUNCATION_RECOVERIES; attempt++) {
      const pass = createMockPassState({
        streamedText: `chunk-${attempt}`,
        stopReason: "max_tokens",
      });
      injectContinuationContext(currentMessages, pass, mockContext, attempt);
    }

    // Now inject the exhaustion error
    const exhaustionMessage = buildExhaustedRecoveryMessage(
      MAX_OUTPUT_TRUNCATION_RECOVERIES,
      4096,
    );
    injectErrorAsConversationMessage(currentMessages, exhaustionMessage, mockContext);

    // The last message should be the error indicator
    const lastMessage = currentMessages[currentMessages.length - 1];
    expect(lastMessage.role).toBe("assistant");
    expect((lastMessage as any)._isErrorIndicator).toBe(true);
    expect(lastMessage.content).toContain("3 automatic");
    expect(lastMessage.content).toContain("4096");
  });

  it("should inject provider error as conversation context on crash", () => {
    const currentMessages: ConversationMessage[] = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: "I'll start by...",
        toolCalls: [{ id: "toolCall-1", name: "read_file", args: { path: "/tmp/file.txt" } }],
      },
    ];
    const mockContext = createMockContext();

    const providerError = new Error("ECONNRESET: Connection reset by peer");
    const errorDescription = buildProviderErrorMessage(providerError, 3);
    injectErrorAsConversationMessage(currentMessages, errorDescription, mockContext);

    // Should have: user, assistant+tool, error-assistant
    expect(currentMessages).toHaveLength(3);

    const errorMessage = currentMessages[2];
    expect(errorMessage.role).toBe("assistant");
    expect(errorMessage.content).toContain("ECONNRESET");
    expect(errorMessage.content).toContain("iteration 3");
    expect(errorMessage.content).toContain("preserved");
    expect((errorMessage as any)._isErrorIndicator).toBe(true);
  });

  it("should preserve token escalation across multiple recovery cycles", () => {
    const mockContext = createMockContext({ options: { maxTokens: 1000 } });
    const messages: ConversationMessage[] = [];

    // Attempt 1: 1000 → 1500
    const escalation1 = injectContinuationContext(
      messages,
      createMockPassState({ streamedText: "a", stopReason: "length" }),
      mockContext,
      1,
    );
    expect(escalation1).toBe(1500);

    // Attempt 2: 1000 → 2250 (base stays at original 1000)
    const escalation2 = injectContinuationContext(
      messages,
      createMockPassState({ streamedText: "b", stopReason: "length" }),
      mockContext,
      2,
    );
    expect(escalation2).toBe(2250);

    // Attempt 3: 1000 → 3375
    const escalation3 = injectContinuationContext(
      messages,
      createMockPassState({ streamedText: "c", stopReason: "length" }),
      mockContext,
      3,
    );
    expect(escalation3).toBe(3375);
  });
});

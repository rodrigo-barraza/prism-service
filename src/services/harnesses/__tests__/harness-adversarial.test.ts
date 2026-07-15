import { describe, it, expect, vi, beforeEach } from "vitest";
import ReActHarness from "#src/services/harnesses/ReActHarness";
import AgenticLoopState from "#src/services/AgenticLoopState";

import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";

vi.mock("#src/services/conversation/ConversationService");
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: {
    set: vi.fn(),
    patch: vi.fn(),
  },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    getStats: vi.fn(() => ({ activeRequests: 0, totalOutputTokens: 0 })),
    incrementActiveRequests: vi.fn(),
    decrementActiveRequests: vi.fn(),
    trackUsage: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    recordChunkTiming: vi.fn(),
    getConversationStats: vi.fn(() => ({ activeRequests: 0, totalOutputTokens: 0 })),
    complete: vi.fn(),
  },
}));

function createStream(chunks: any[]) {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

describe("ReActHarness Adversarial Tests", () => {
  let context: any;
  let state: AgenticLoopState;
  let tools: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    context = {
      provider: {
        generateTextStream: vi.fn(),
      },
      providerName: "test-provider",
      resolvedModel: "test-model",
      emit: vi.fn(),
      options: {},
      messages: [],
      systemPrompt: "You are a helpful assistant.",
      signal: new AbortController().signal,
    };

    state = new AgenticLoopState();
    tools = {
      finalTools: [],
      resolvedEnabledTools: [],
    };
  });

  describe("Repetition Detection", () => {
    it("should stop and emit a warning when repetition recovery is exhausted", async () => {
      const harness = new ReActHarness(context, state, tools);
      
      // Long repeated text to trigger detector (needs > 500 chars)
      const repeatedText = "This is a long repetitive block that will be repeated many times to trigger the repetition detector. ".repeat(20);
      
      // Mock responses as strings to trigger detector and exhaust recovery
      context.provider.generateTextStream.mockReturnValue(createStream([repeatedText]));

      // Run harness
      await harness.run();

      // Verify repetition was detected and recovery attempted
      expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: "repetition_detected",
      }));
      
      // Should have tried 1 original + 3 retries = 4 calls total for the first iteration
      expect(context.provider.generateTextStream.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Truncation Recovery (Perturbation Pass)", () => {
    it("should trigger perturbation when stopReason is max_tokens", async () => {
      const harness = new ReActHarness(context, state, tools);
      
      // First stream indicates truncation
      const stream1 = createStream([
        "Part of a response...",
        { type: "stopReason", stopReason: "max_tokens" },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 50 } },
      ]);

      // Second stream (after recovery) is clean
      const stream2 = createStream([
        " ...continued response.",
        { type: "usage", usage: { inputTokens: 50, outputTokens: 25 } },
      ]);

      context.provider.generateTextStream
        .mockReturnValueOnce(stream1)
        .mockReturnValueOnce(stream2);

      // Run harness with 1 max iteration to ensure recovery doesn't count as a new iteration
      // Wait, truncation recovery DOES count as a new iteration because it calls 'continue'
      context.options.maxIterations = 2;

      await harness.run();

      // Verify generateTextStream was called twice (Iteration 1 + Recovery Pass)
      expect(context.provider.generateTextStream).toHaveBeenCalledTimes(2);

      // Verify perturbation nudge was injected
      const lastCallMessages = context.provider.generateTextStream.mock.calls[1][0];
      const lastMessage = lastCallMessages[lastCallMessages.length - 1];
      expect(lastMessage.content).toContain("truncated at the output token limit");
    });
  });
});

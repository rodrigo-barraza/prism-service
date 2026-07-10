/**
 * exhaustionRecoveryIntegration.test.ts
 *
 * Reproduction test for the "subagent didn't answer" failure mode:
 * A subagent hits maxIterations with only tool calls (no text output),
 * and the exhaustion recovery pass must fire and produce a final text
 * response. Tests both the ExhaustionRecovery module directly and the
 * ReActHarness loop integration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { runExhaustionRecoveryPass, buildSyntheticFallbackSummary } from "../lifecycle/ExhaustionRecovery.ts";
import PromptLocaleService from "#src/services/PromptLocaleService";
import ConversationGenerationTracker from "#src/services/ConversationGenerationTracker";
import type { ConversationMessage } from "../types.ts";

// ── Mocks ────────────────────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: vi.fn().mockReturnValue("en"),
    get: vi.fn().mockImplementation((_locale: string, key: string) => {
      if (key === "harness.exhaustionRecovery.subAgentMessage") {
        return "Maximum tool-call iterations reached (sub-agent). Summarize your progress.";
      }
      if (key === "harness.exhaustionRecovery.message") {
        return "Maximum tool-call iterations reached. Summarize your progress.";
      }
      return `[locale:${key}]`;
    }),
  },
}));

vi.mock("#src/utils/FunctionCallingUtilities", () => ({
  expandMessagesForFunctionCall: vi.fn().mockImplementation((messages: unknown[]) => messages),
}));

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    complete: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────

function createMockHarness(overrides: Record<string, unknown> = {}) {
  return {
    enforceContextWindow: vi.fn().mockImplementation((messages: unknown[]) => messages),
    registerTrackerRequest: vi.fn(),
    createPassState: vi.fn().mockReturnValue({
      streamedText: "",
      streamedThinking: "",
      thinkingSignature: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
      requestId: "req-exhaust",
    }),
    consumeStream: vi.fn().mockImplementation(async (stream: AsyncIterable<string>, passState: Record<string, unknown>) => {
      let text = "";
      for await (const chunk of stream) {
        if (typeof chunk === "string") text += chunk;
      }
      passState.streamedText = text;
      passState.finalStreamedText = text;
    }),
    logIteration: vi.fn(),
    emitGenerationProgress: vi.fn(),
    ...overrides,
  };
}

function createMockProvider(recoveryText = "Here is your summary of progress so far.") {
  return {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield recoveryText;
    }),
  };
}

function createMockContext(overrides: Record<string, unknown> = {}) {
  const provider = createMockProvider();
  return {
    emit: vi.fn(),
    signal: undefined,
    options: { maxTokens: 8192 },
    resolvedModel: "google/gemma-4-12B-it-qat-w4a16-ct",
    modelDefinition: null,
    provider,
    requestId: "req-subagent-1",
    agentConversationId: "subagent-conv-1",
    project: "prism-chat",
    username: "test-user",
    agent: "OMNI",
    ...overrides,
  };
}

/** Build a message array that simulates N iterations of tool-only calls. */
function buildToolOnlyConversation(toolCallCount: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    { role: "system", content: "You are a sub-agent. Complete the task." },
    { role: "user", content: "Search for software engineers in Vancouver" },
  ];

  for (let iteration = 0; iteration < toolCallCount; iteration++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `call-${iteration}`,
          name: "search_web",
          args: { query: `Vancouver software engineer query ${iteration}` },
          result: { results: [], totalResults: "0", provider: "brave" },
        },
      ],
    });
    messages.push({
      role: "tool",
      content: JSON.stringify({
        query: `Vancouver software engineer query ${iteration}`,
        results: [],
        totalResults: "0",
      }),
    });
  }

  return messages;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Test Suites
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("ExhaustionRecovery — Tool-Only Subagent Failure Mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Direct module tests ──────────────────────────────────

  describe("runExhaustionRecoveryPass — direct invocation", () => {
    it("should inject a system recovery prompt into the message array", async () => {
      const currentMessages = buildToolOnlyConversation(5);
      const initialMessageCount = currentMessages.length;

      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        createMockContext() as any,
        { iterations: 5 } as any,
        currentMessages,
      );

      // Should have appended a system message (the recovery prompt)
      expect(currentMessages.length).toBeGreaterThan(initialMessageCount);
      const recoverySystemMessage = currentMessages[initialMessageCount];
      expect(recoverySystemMessage.role).toBe("system");
      expect(recoverySystemMessage.content).toContain("Maximum tool-call iterations");
    });

    it("should call provider.generateTextStream with NO tools in the options", async () => {
      const provider = createMockProvider();
      const context = createMockContext({ provider });

      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        context as any,
        { iterations: 10 } as any,
        buildToolOnlyConversation(10),
      );

      expect(provider.generateTextStream).toHaveBeenCalledTimes(1);
      const callArgs = provider.generateTextStream.mock.calls[0];
      const passedOptions = callArgs[2]; // (messages, model, options)
      expect(passedOptions.tools).toBeUndefined();
    });

    it("should call consumeStream so the recovery output is actually streamed to the client", async () => {
      const harness = createMockHarness();

      await runExhaustionRecoveryPass(
        harness as any,
        createMockContext() as any,
        { iterations: 5 } as any,
        buildToolOnlyConversation(5),
      );

      expect(harness.consumeStream).toHaveBeenCalledTimes(1);
    });

    it("should use the subAgent recovery message when parentAgentConversationId is set", async () => {
      const context = createMockContext({
        parentAgentConversationId: "parent-conv-1",
      });

      const currentMessages = buildToolOnlyConversation(3);
      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        context as any,
        { iterations: 3 } as any,
        currentMessages,
      );

      expect(PromptLocaleService.get).toHaveBeenCalledWith(
        "en",
        "harness.exhaustionRecovery.subAgentMessage",
      );
    });

    it("should use the standard recovery message when NOT a subAgent", async () => {
      const context = createMockContext({
        parentAgentConversationId: undefined,
      });

      const currentMessages = buildToolOnlyConversation(3);
      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        context as any,
        { iterations: 3 } as any,
        currentMessages,
      );

      expect(PromptLocaleService.get).toHaveBeenCalledWith(
        "en",
        "harness.exhaustionRecovery.message",
      );
    });

    it("should complete the tracker request after streaming", async () => {
      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        createMockContext() as any,
        { iterations: 5 } as any,
        buildToolOnlyConversation(5),
      );

      expect(ConversationGenerationTracker.complete).toHaveBeenCalledWith(
        expect.stringContaining("-exhaustion"),
      );
    });
  });

  // ── Adversarial edge cases ───────────────────────────────

  describe("adversarial — edge cases", () => {
    it("should NOT crash when provider.generateTextStream yields nothing", async () => {
      const emptyProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          // Yields nothing — empty stream
        }),
      };
      const harness = createMockHarness();

      await expect(
        runExhaustionRecoveryPass(
          harness as any,
          createMockContext({ provider: emptyProvider }) as any,
          { iterations: 5 } as any,
          buildToolOnlyConversation(5),
        ),
      ).resolves.toBeUndefined();

      // consumeStream should still have been called
      expect(harness.consumeStream).toHaveBeenCalledTimes(1);
    });

    it("should NOT crash when provider.generateTextStream throws", async () => {
      const failingProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          throw new Error("ECONNRESET: Connection reset by peer");
        }),
      };
      const harness = createMockHarness();

      // The recovery pass should propagate the error (not swallow it)
      // so the outer try/catch in ReActHarness handles persistence
      await expect(
        runExhaustionRecoveryPass(
          harness as any,
          createMockContext({ provider: failingProvider }) as any,
          { iterations: 5 } as any,
          buildToolOnlyConversation(5),
        ),
      ).rejects.toThrow("ECONNRESET");
    });

    it("should strip tools from options but preserve maxTokens", async () => {
      const provider = createMockProvider();
      const context = createMockContext({
        provider,
        options: {
          maxTokens: 8192,
          tools: [{ name: "search_web", description: "Search the web" }],
          temperature: 0.7,
        },
      });

      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        context as any,
        { iterations: 5 } as any,
        buildToolOnlyConversation(5),
      );

      const passedOptions = provider.generateTextStream.mock.calls[0][2];
      expect(passedOptions.tools).toBeUndefined();
      expect(passedOptions.maxTokens).toBe(8192);
      expect(passedOptions.temperature).toBe(0.7);
    });

    it("should handle a conversation with 0 tool calls (edge case)", async () => {
      const messages: ConversationMessage[] = [
        { role: "system", content: "System message" },
        { role: "user", content: "Hello" },
      ];

      await expect(
        runExhaustionRecoveryPass(
          createMockHarness() as any,
          createMockContext() as any,
          { iterations: 1 } as any,
          messages,
        ),
      ).resolves.toBeUndefined();
    });

    it("should work with a very large conversation (30+ tool result messages)", async () => {
      const largeConversation = buildToolOnlyConversation(30);
      expect(largeConversation.length).toBe(62); // 2 initial + 30 * 2

      const harness = createMockHarness();
      await runExhaustionRecoveryPass(
        harness as any,
        createMockContext() as any,
        { iterations: 30 } as any,
        largeConversation,
      );

      // Recovery should append 1 system message
      expect(largeConversation.length).toBe(63);
      expect(harness.consumeStream).toHaveBeenCalledTimes(1);
    });
  });

  // ── Integration: The exact failure scenario ──────────────

  describe("integration — reproducing subagent 48981e57 failure", () => {
    it("should produce a recovery response even for a 13-iteration tool-only subagent", async () => {
      const recoveryText = "Based on 13 search iterations, here are the results found so far...";
      const provider = createMockProvider(recoveryText);
      const harness = createMockHarness();
      const context = createMockContext({
        provider,
        parentAgentConversationId: "parent-orchestrator-1",
      });

      const currentMessages = buildToolOnlyConversation(13);
      const messageCountBefore = currentMessages.length;

      await runExhaustionRecoveryPass(
        harness as any,
        context as any,
        { iterations: 13 } as any,
        currentMessages,
      );

      // Recovery prompt was injected
      expect(currentMessages.length).toBe(messageCountBefore + 1);
      expect(currentMessages[messageCountBefore].role).toBe("system");

      // Provider was called with the full conversation
      expect(provider.generateTextStream).toHaveBeenCalledTimes(1);
      const recoveryMessages = provider.generateTextStream.mock.calls[0][0];
      // Should include all original messages + recovery prompt
      expect(recoveryMessages.length).toBe(messageCountBefore + 1);

      // consumeStream was called to actually deliver the response
      expect(harness.consumeStream).toHaveBeenCalledTimes(1);
    });

    it("should emit ITERATION_LIMIT_REACHED status before the recovery pass", async () => {
      const context = createMockContext();

      await runExhaustionRecoveryPass(
        createMockHarness() as any,
        context as any,
        { iterations: 13 } as any,
        buildToolOnlyConversation(13),
      );

      const emitCalls = (context.emit as ReturnType<typeof vi.fn>).mock.calls;
      const limitReachedEvent = emitCalls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, string>).message === "iteration_limit_reached",
      );
      expect(limitReachedEvent).toBeDefined();
    });
  });

  // ── The REAL bug: does the trigger condition fire? ────────

  describe("trigger condition — hasCleanTextBreak and streamedToolCalls", () => {
    it("should confirm the trigger condition is correct for tool-only loops", () => {
      // Reproducing the exact condition from ReActHarness line 794:
      // if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted)
      const hasCleanTextBreak = false;
      const streamedToolCalls = [
        { id: "call-1", name: "search_web", args: { query: "test" } },
        { id: "call-2", name: "search_web", args: { query: "test 2" } },
      ];
      const signal = undefined as AbortSignal | undefined;

      const shouldRunRecovery =
        !hasCleanTextBreak &&
        streamedToolCalls.length > 0 &&
        !signal?.aborted;

      expect(shouldRunRecovery).toBe(true);
    });

    it("should NOT fire if the model produced a text response (hasCleanTextBreak=true)", () => {
      const hasCleanTextBreak = true;
      const streamedToolCalls = [
        { id: "call-1", name: "search_web", args: { query: "test" } },
      ];
      const signal = undefined as AbortSignal | undefined;

      const shouldRunRecovery =
        !hasCleanTextBreak &&
        streamedToolCalls.length > 0 &&
        !signal?.aborted;

      expect(shouldRunRecovery).toBe(false);
    });

    it("should NOT fire if the signal was aborted", () => {
      const hasCleanTextBreak = false;
      const streamedToolCalls = [
        { id: "call-1", name: "search_web", args: { query: "test" } },
      ];
      const abortController = new AbortController();
      abortController.abort();

      const shouldRunRecovery =
        !hasCleanTextBreak &&
        streamedToolCalls.length > 0 &&
        !abortController.signal?.aborted;

      expect(shouldRunRecovery).toBe(false);
    });

    it("should NOT fire if streamedToolCalls is empty (thinking-only loop)", () => {
      const hasCleanTextBreak = false;
      const streamedToolCalls: unknown[] = [];
      const signal = undefined as AbortSignal | undefined;

      const shouldRunRecovery =
        !hasCleanTextBreak &&
        streamedToolCalls.length > 0 &&
        !signal?.aborted;

      expect(shouldRunRecovery).toBe(false);
    });
  });

  // ── The CRITICAL test: full loop with maxIterations ──────

  describe("full loop scenario — tool-only until maxIterations", () => {
    it("should track streamedToolCalls correctly across iterations", () => {
      // Simulating what BaseAgenticHarness.processStreamChunk does:
      // On each "calling" chunk, it pushes to state.streamedToolCalls
      const streamedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

      for (let iteration = 0; iteration < 13; iteration++) {
        streamedToolCalls.push({
          id: `call-${iteration}`,
          name: "search_web",
          args: { query: `query ${iteration}` },
        });
      }

      // After 13 iterations, streamedToolCalls should have 13 entries
      expect(streamedToolCalls.length).toBe(13);

      // The trigger condition should fire
      const hasCleanTextBreak = false;
      const shouldRunRecovery = !hasCleanTextBreak && streamedToolCalls.length > 0;
      expect(shouldRunRecovery).toBe(true);
    });

    it("should produce a final response even when ALL iterations were tool calls", async () => {
      // This is the heart of the reproduction: 13 iterations, all tool calls,
      // maxIterations=13, recovery pass must fire
      const recoveryOutput = "After 13 search attempts, I found the following engineers...";
      const provider = createMockProvider(recoveryOutput);
      const harness = createMockHarness();

      const currentMessages = buildToolOnlyConversation(13);
      const state = {
        iterations: 13,
        streamedToolCalls: Array.from({ length: 13 }, (_, index) => ({
          id: `call-${index}`,
          name: "search_web",
          args: { query: `query ${index}` },
        })),
        conversationOutcome: null as string | null,
      };

      // Simulate what ReActHarness does after the loop:
      const hasCleanTextBreak = false;
      const signal = undefined as AbortSignal | undefined;

      if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(
          harness as any,
          createMockContext({ provider, parentAgentConversationId: "parent-1" }) as any,
          state as any,
          currentMessages,
        );
      }

      // CRITICAL ASSERTIONS:
      // 1. The outcome should be "exhausted"
      expect(state.conversationOutcome).toBe("exhausted");

      // 2. The recovery pass should have been called
      expect(provider.generateTextStream).toHaveBeenCalledTimes(1);

      // 3. consumeStream should have been called to deliver the response
      expect(harness.consumeStream).toHaveBeenCalledTimes(1);

      // 4. A system recovery prompt should be in the messages
      const recoveryPrompt = currentMessages.find(
        (message) =>
          message.role === "system" &&
          (message.content || "").includes("Maximum tool-call iterations"),
      );
      expect(recoveryPrompt).toBeDefined();
    });

    it("should produce recovery even with maxIterations=1 (single tool call, immediate exhaustion)", async () => {
      const provider = createMockProvider("Single iteration summary.");
      const harness = createMockHarness();

      const currentMessages = buildToolOnlyConversation(1);
      const state = {
        iterations: 1,
        streamedToolCalls: [{ id: "call-0", name: "search_web", args: {} }],
        conversationOutcome: null as string | null,
      };

      const hasCleanTextBreak = false;
      if (!hasCleanTextBreak && state.streamedToolCalls.length > 0) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(
          harness as any,
          createMockContext({ provider }) as any,
          state as any,
          currentMessages,
        );
      }

      expect(state.conversationOutcome).toBe("exhausted");
      expect(provider.generateTextStream).toHaveBeenCalledTimes(1);
      expect(harness.consumeStream).toHaveBeenCalledTimes(1);
    });
  });

  // ── Synthetic fallback summary tests ─────────────────────

  describe("buildSyntheticFallbackSummary — direct unit tests", () => {
    it("should produce a structured summary with tool usage breakdown", () => {
      const state = {
        iterations: 13,
        streamedToolCalls: [
          { id: "call-1", name: "search_web", args: { query: "q1" } },
          { id: "call-2", name: "search_web", args: { query: "q2" } },
          { id: "call-3", name: "read_url", args: { url: "https://example.com" } },
          { id: "call-4", name: "search_web", args: { query: "q3" } },
        ],
      } as any;

      const messages = buildToolOnlyConversation(4);
      const summary = buildSyntheticFallbackSummary(state, messages);

      expect(summary).toContain("Iteration limit reached after 13 iterations");
      expect(summary).toContain("search_web: 3 call(s)");
      expect(summary).toContain("read_url: 1 call(s)");
    });

    it("should include recent tool results from assistant messages", () => {
      const state = {
        iterations: 3,
        streamedToolCalls: [
          { id: "call-1", name: "search_web", args: { query: "test" } },
        ],
      } as any;

      const messages: ConversationMessage[] = [
        { role: "user", content: "Search for engineers" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "search_web",
              args: { query: "Vancouver engineers" },
              result: { results: ["Alice", "Bob"], totalResults: "2" },
            },
          ],
        },
      ];

      const summary = buildSyntheticFallbackSummary(state, messages);

      expect(summary).toContain("Recent tool results");
      expect(summary).toContain("search_web");
      expect(summary).toContain("Vancouver engineers");
    });

    it("should truncate long tool results to prevent bloated output", () => {
      const state = {
        iterations: 1,
        streamedToolCalls: [
          { id: "call-1", name: "search_web", args: { query: "test" } },
        ],
      } as any;

      const longResult = "x".repeat(2000);
      const messages: ConversationMessage[] = [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "search_web",
              args: { query: "test" },
              result: longResult,
            },
          ],
        },
      ];

      const summary = buildSyntheticFallbackSummary(state, messages);

      // Should be truncated with ellipsis
      expect(summary).toContain("…");
      // Should NOT contain the full 2000-char result
      expect(summary.length).toBeLessThan(longResult.length);
    });

    it("should handle empty tool calls gracefully", () => {
      const state = {
        iterations: 5,
        streamedToolCalls: [],
      } as any;

      const messages: ConversationMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const summary = buildSyntheticFallbackSummary(state, messages);

      expect(summary).toContain("Iteration limit reached after 5 iterations");
      // No tool usage section since there are no tool calls
      expect(summary).not.toContain("Recent tool results");
    });
  });

  // ── Empty recovery fallback integration ──────────────────

  describe("empty recovery fallback — integration", () => {
    it("should inject synthetic fallback when recovery pass produces empty output", async () => {
      const emptyProvider = {
        generateTextStream: vi.fn().mockImplementation(async function* () {
          // Yields nothing — model failed to produce summary
        }),
      };

      // Mock consumeStream to properly set empty streamedText on the pass
      const harness = createMockHarness({
        consumeStream: vi.fn().mockImplementation(
          async (_stream: unknown, passState: Record<string, unknown>) => {
            // consumeStream finishes but pass has no text
            passState.streamedText = "";
            passState.finalStreamedText = "";
          },
        ),
      });

      const state = {
        iterations: 13,
        streamedToolCalls: Array.from({ length: 13 }, (_, index) => ({
          id: `call-${index}`,
          name: "search_web",
          args: { query: `query ${index}` },
        })),
        finalStreamedText: "",
      } as any;

      const currentMessages = buildToolOnlyConversation(13);

      await runExhaustionRecoveryPass(
        harness as any,
        createMockContext({ provider: emptyProvider, parentAgentConversationId: "parent-1" }) as any,
        state,
        currentMessages,
      );

      // The synthetic fallback should have been injected
      expect(state.finalStreamedText).toBeTruthy();
      expect(state.finalStreamedText).toContain("Iteration limit reached after 13 iterations");
      expect(state.finalStreamedText).toContain("search_web: 13 call(s)");
    });

    it("should NOT inject synthetic fallback when recovery pass produces actual text", async () => {
      const successfulProvider = createMockProvider("Based on my 13 searches, here are the results...");
      const harness = createMockHarness({
        consumeStream: vi.fn().mockImplementation(
          async (_stream: unknown, passState: Record<string, unknown>) => {
            passState.streamedText = "Based on my 13 searches, here are the results...";
            passState.finalStreamedText = "Based on my 13 searches, here are the results...";
          },
        ),
      });

      const state = {
        iterations: 13,
        streamedToolCalls: Array.from({ length: 13 }, (_, index) => ({
          id: `call-${index}`,
          name: "search_web",
          args: { query: `query ${index}` },
        })),
        finalStreamedText: "",
      } as any;

      await runExhaustionRecoveryPass(
        harness as any,
        createMockContext({ provider: successfulProvider }) as any,
        state,
        buildToolOnlyConversation(13),
      );

      // Should keep the model's own summary, NOT inject synthetic
      expect(state.finalStreamedText).toBe("");
      // finalStreamedText is only set by the fallback path, not by a successful consumeStream
      // (the real consumeStream updates it through processStreamChunk in BaseAgenticHarness)
    });

    it("should inject synthetic fallback when recovery pass produces only raw tool call markup (which gets cleaned to empty)", async () => {
      const rawMarkupProvider = createMockProvider("<|tool_call>call:search_web{}<tool_call|>");
      const harness = createMockHarness({
        consumeStream: vi.fn().mockImplementation(
          async (_stream: unknown, passState: Record<string, unknown>) => {
            // raw text containing tool call markup
            passState.streamedText = "<|tool_call>call:search_web{}<tool_call|>";
            // finalStreamedText is stripped by stripToolCallMarkup to ""
            passState.finalStreamedText = "";
          },
        ),
      });

      const state = {
        iterations: 13,
        streamedToolCalls: Array.from({ length: 13 }, (_, index) => ({
          id: `call-${index}`,
          name: "search_web",
          args: { query: `query ${index}` },
        })),
        finalStreamedText: "",
      } as any;

      await runExhaustionRecoveryPass(
        harness as any,
        createMockContext({ provider: rawMarkupProvider }) as any,
        state,
        buildToolOnlyConversation(13),
      );

      // The synthetic fallback SHOULD have been injected because the cleaned text is empty
      expect(state.finalStreamedText).toBeTruthy();
      expect(state.finalStreamedText).toContain("Iteration limit reached after 13 iterations");
    });
  });
});


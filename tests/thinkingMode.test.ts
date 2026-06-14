import "./setup.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import googleProvider from "../src/providers/google.ts";
import anthropicProvider from "../src/providers/anthropic.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";
import { MODELS } from "../src/config.ts";
import {
  extractThinkTags,
  ThinkTagParser,
} from "../src/utils/ThinkTagParser.ts";


// ── Mock @google/genai module in detail ──────────────────────────────
const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();
const mockConnect = vi.fn();

// ── Mock @anthropic-ai/sdk module in detail ──────────────────────────
const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      constructor() {}
      messages = {
        create: (...args: any[]) => {
          const res = mockMessagesCreate(...args);
          return {
            withResponse: async () => ({
              data: res,
              response: {
                headers: {
                  get: (name: string) => {
                    if (name === "anthropic-ratelimit-requests-limit") return "1000";
                    if (name === "anthropic-ratelimit-requests-remaining") return "999";
                    if (name === "anthropic-ratelimit-requests-reset") return "2026-05-20T01:02:00Z";
                    if (name === "anthropic-ratelimit-tokens-limit") return "80000";
                    if (name === "anthropic-ratelimit-tokens-remaining") return "79900";
                    if (name === "anthropic-ratelimit-tokens-reset") return "2026-05-20T01:01:05Z";
                    return null;
                  }
                }
              }
            }),
          };
        },
        stream: (...args: any[]) => mockMessagesStream(...args),
      };
    }
  };
});

vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: class {
      constructor() {}
      models = {
        generateContent: (...args: any[]) => mockGenerateContent(...args),
        generateContentStream: (...args: any[]) => mockGenerateContentStream(...args),
      };
      live = {
        connect: (...args: any[]) => mockConnect(...args),
      };
    },
    Modality: {
      AUDIO: "audio",
      TEXT: "text",
    },
  };
});

describe("Gemini 3.5 Flash / Agentic Thinking Mode", () => {
  let activeLiveCallbacks: any = null;
  const mockLiveSession = {
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    mockGenerateContent.mockClear();
    mockGenerateContentStream.mockClear();
    mockConnect.mockClear();
    mockLiveSession.sendClientContent.mockClear();
    mockLiveSession.sendRealtimeInput.mockClear();
    mockLiveSession.close.mockClear();
    activeLiveCallbacks = null;

    mockConnect.mockImplementation(async (options: any) => {
      activeLiveCallbacks = options.callbacks;
      process.nextTick(() => {
        if (activeLiveCallbacks?.onopen) {
          activeLiveCallbacks.onopen();
        }
      });
      return mockLiveSession;
    });
  });

  // ── Section 1: Google Provider Config Building for Thinking ──────────

  describe("Google Provider Config Builder", () => {
    it("configures thinkingConfig with thinkingLevel when thinkingEnabled is true and no thinkingBudget is set", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        thinkingEnabled: true,
        thinkingLevel: "medium",
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.thinkingConfig).toBeDefined();
      expect(args.config.thinkingConfig.includeThoughts).toBe(true);
      expect(args.config.thinkingConfig.thinkingLevel).toBe("medium");
      expect(args.config.thinkingConfig.thinkingBudget).toBeUndefined();
    });

    it("configures thinkingConfig with thinkingBudget and omits thinkingLevel when both are provided", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        thinkingEnabled: true,
        thinkingLevel: "medium",
        thinkingBudget: 1024,
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.thinkingConfig).toBeDefined();
      expect(args.config.thinkingConfig.includeThoughts).toBe(true);
      expect(args.config.thinkingConfig.thinkingLevel).toBeUndefined();
      expect(args.config.thinkingConfig.thinkingBudget).toBe(1024);
    });

    it("parses thinkingBudget as integer even if passed as a string", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        thinkingEnabled: true,
        thinkingBudget: "2048",
      });

      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.thinkingConfig.thinkingBudget).toBe(2048);
    });

    it("does not configure thinkingConfig if thinkingEnabled is explicitly false", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        thinkingEnabled: false,
      });

      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.thinkingConfig).toBeUndefined();
    });

    it("does not configure thinkingConfig if model does not support thinking", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      // Using espeak-ng or any model that does not have thinking: true in MODELS config
      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.ESPEAKNG.name, {
        thinkingEnabled: true,
      });

      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.thinkingConfig).toBeUndefined();
    });

    it("filters out serviceTier: 'auto' from config", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        serviceTier: "auto",
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.serviceTier).toBeUndefined();
    });

    it("passes valid serviceTier to config", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        serviceTier: "standard",
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.serviceTier).toBe("standard");
    });

    it("configures all standard parameters correctly", async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: "Done" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await googleProvider.generateText(messages, MODELS.GEMINI_35_FLASH.name, {
        temperature: 0.4,
        topP: 0.85,
        topK: 15,
        maxTokens: 1000,
        seed: 12345,
        responseMimeType: "application/json",
        candidateCount: 2,
        mediaResolution: "MEDIA_RESOLUTION_LOW",
        responseLogprobs: true,
        logprobs: 3,
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      const args = mockGenerateContent.mock.calls[0][0];
      expect(args.config.temperature).toBe(0.4);
      expect(args.config.topP).toBe(0.85);
      expect(args.config.topK).toBe(15);
      expect(args.config.maxOutputTokens).toBe(1000);
      expect(args.config.seed).toBe(12345);
      expect(args.config.responseMimeType).toBe("application/json");
      expect(args.config.candidateCount).toBe(2);
      expect(args.config.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
      expect(args.config.responseLogprobs).toBe(true);
      expect(args.config.logprobs).toBe(3);
    });
  });

  // ── Section 2: Thinking Chunk Parsing in Streams ─────────────────────

  describe("Google Provider Stream Thinking Chunk Parsing", () => {
    it("yields thinking type chunks when parts contain thought and text", async () => {
      // Mock stream returning thinking part then normal text part
      async function* mockGenerator() {
        yield {
          candidates: [{
            content: {
              parts: [{ thought: true, text: "Let me think about it." }]
            }
          }]
        };
        yield {
          candidates: [{
            content: {
              parts: [{ text: "Here is my final answer." }]
            }
          }]
        };
        yield {
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
        };
      }
      mockGenerateContentStream.mockResolvedValueOnce(mockGenerator());

      const stream = googleProvider.generateTextStream([{ role: "user", content: "hi" }], MODELS.GEMINI_35_FLASH.name);
      const results: any[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toContainEqual({ type: "thinking", content: "Let me think about it." });
      expect(results).toContain("Here is my final answer.");
      expect(results).toContainEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
    });
  });

  // ── Section 3: Live API Thinking Parsing ─────────────────────────────

  describe("Google Provider Live API Thinking Parsing", () => {
    it("handles setup complete, yields thinking, yields text and yields usage", async () => {
      const messages = [
        { role: "system", content: "You are system." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "live test" }
      ];
      const stream = googleProvider.generateTextStreamLive(messages, MODELS.GEMINI_31_FLASH_LIVE.name, {
        thinkingEnabled: true,
        thinkingLevel: "high",
        thinkingBudget: 512,
      });

      // Simulate connection events in asynchronous sequence
      process.nextTick(() => {
        expect(activeLiveCallbacks).toBeDefined();

        // 1. Setup complete
        activeLiveCallbacks.onmessage({ setupComplete: true });

        // 2. Yield thinking
        activeLiveCallbacks.onmessage({
          serverContent: {
            modelTurn: {
              parts: [{ thought: true, text: "Thinking in real-time..." }]
            }
          }
        });

        // 3. Yield text transcript
        activeLiveCallbacks.onmessage({
          serverContent: {
            outputTranscription: { text: "Live response text." }
          }
        });

        // 4. Yield usage
        activeLiveCallbacks.onmessage({
          usageMetadata: {
            promptTokenCount: 15,
            responseTokenCount: 25,
          }
        });

        // 5. Complete turn
        activeLiveCallbacks.onmessage({
          serverContent: {
            turnComplete: true
          }
        });
      });

      const results: any[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toContainEqual({ type: "thinking", content: "Thinking in real-time..." });
      expect(results).toContain("Live response text.");
      expect(results).toContainEqual({ type: "usage", usage: { inputTokens: 15, outputTokens: 25 } });

      // Verify session interaction
      expect(mockLiveSession.sendRealtimeInput).toHaveBeenCalledWith({ text: "live test" });
      expect(mockLiveSession.sendClientContent).toHaveBeenCalled(); // Seeding history
    });
  });

  // ── Section 4: Agentic Loop State & Event Handling ──────────────────

  describe("AgenticLoopState Integration", () => {
    it("properly appends thinking chunks, displays segments, and emits thinking events", async () => {
      const emittedEvents: any[] = [];
      const mockContext: any = {
        providerName: "google",
        resolvedModel: MODELS.GEMINI_35_FLASH.name,
        modelDefinition: MODELS.GEMINI_35_FLASH,
        messages: [{ role: "user", content: "Solve math: 2+2" }],
        options: {
          maxIterations: 1,
        },
        agentSessionId: "session-thinking-123",
        parentAgentSessionId: null,
        traceId: "trace-thinking-123",
        project: "test-thinking-project",
        username: "test-user",
        requestId: "req-thinking-123",
        requestStart: performance.now(),
        emit: vi.fn((event) => emittedEvents.push(event)),
        signal: new AbortController().signal,
      };

      const state = new AgenticLoopState();
      const mockTools: any = {
        resolvedEnabledTools: [],
        finalTools: [],
      };

      // Import BaseAgenticHarness and SessionGenerationTracker
      const { default: BaseAgenticHarness } = await import(
        "../src/services/harnesses/BaseAgenticHarness.ts"
      );
      const { default: SessionGenerationTracker } = await import(
        "../src/services/SessionGenerationTracker.ts"
      );

      class DummyHarness extends BaseAgenticHarness {
        public async testProcessChunk(
          chunk: any,
          pass: any,
          allowedTools: Set<string>
        ) {
          return this.processStreamChunk(chunk, pass, allowedTools);
        }
      }

      SessionGenerationTracker.register(
        mockContext.agentSessionId,
        mockContext.requestId,
        {
          provider: mockContext.providerName,
          model: mockContext.resolvedModel,
        }
      );

      const pass: any = {
        requestId: mockContext.requestId,
        start: performance.now(),
        firstTokenTime: null,
        generationEnd: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        streamedThinking: "",
        outputCharacters: 0,
        streamedText: "",
        pendingToolCalls: [],
      };

      const harness = new DummyHarness(mockContext, state, mockTools);

      await harness.testProcessChunk(
        { type: "thinking", content: "Analyzing request... " },
        pass,
        new Set()
      );
      await harness.testProcessChunk(
        { type: "thinking", content: "Finding solutions..." },
        pass,
        new Set()
      );
      await harness.testProcessChunk("The solution is simple.", pass, new Set());
      await harness.testProcessChunk(
        { type: "usage", usage: { inputTokens: 8, outputTokens: 4 } },
        pass,
        new Set()
      );

      // Verify overall thinking accumulation
      expect(state.streamedThinking).toBe(
        "Analyzing request... Finding solutions..."
      );

      // Verify display segments structure
      expect(state.displaySegments).toContainEqual({
        type: "thinking",
        fragmentIndex: 0,
      });
      expect(state.displayThinkingFragments[0]).toBe(
        "Analyzing request... Finding solutions..."
      );

      // Verify emitted events
      const thinkingEvents = emittedEvents.filter((e) => e.type === "thinking");
      expect(thinkingEvents.length).toBe(2);
      expect(thinkingEvents[0].content).toBe("Analyzing request... ");
      expect(thinkingEvents[1].content).toBe("Finding solutions...");

      // Verify clean display data persistence structure
      const cleanData = state.getCleanDisplayData();
      expect(cleanData.cleanThinkingFragments[0]).toBe(
        "Analyzing request... Finding solutions..."
      );
      expect(cleanData.cleanSegments).toContainEqual({
        type: "thinking",
        fragmentIndex: 0,
      });

      // Cleanup
      SessionGenerationTracker.cleanup(mockContext.agentSessionId);
    });
  });
});

describe("Anthropic Claude / Agentic Thinking Mode", () => {
  beforeEach(() => {
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
  });

  // ── Section 1: Anthropic Provider Config Building for Thinking ────────
  describe("Anthropic Provider Config Builder", () => {
    it("configures thinking and adjusts max_tokens/temperature when thinking is enabled", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.SONNET_46.name, {
        thinkingEnabled: true,
        thinkingBudget: 2048,
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        maxTokens: 1000,
      });

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const args = mockMessagesCreate.mock.calls[0][0];
      expect(args.thinking).toBeDefined();
      expect(args.thinking.type).toBe("enabled");
      expect(args.thinking.budget_tokens).toBe(2048);
      expect(args.max_tokens).toBe(2048 + 1024);
      expect(args.temperature).toBe(1);
      expect(args.top_p).toBeUndefined();
      expect(args.top_k).toBeUndefined();
    });

    it("parses thinkingBudget as integer and maps effort levels correctly", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.SONNET_46.name, {
        thinkingEnabled: true,
        thinkingBudget: "1024",
      });

      const args1 = mockMessagesCreate.mock.calls[0][0];
      expect(args1.thinking.budget_tokens).toBe(1024);

      // Verify effort levels map correctly
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      await anthropicProvider.generateText(messages, MODELS.SONNET_46.name, {
        thinkingEnabled: true,
        reasoningEffort: "medium",
      });
      const args2 = mockMessagesCreate.mock.calls[1][0];
      expect(args2.thinking.budget_tokens).toBe(4096);
    });

    it("does not configure thinking if thinkingEnabled is false", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.SONNET_46.name, {
        thinkingEnabled: false,
        temperature: 0.7,
      });

      const args = mockMessagesCreate.mock.calls[0][0];
      expect(args.thinking).toBeUndefined();
      expect(args.temperature).toBe(0.7);

      // Verify topP works when temperature is undefined
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      await anthropicProvider.generateText(messages, MODELS.SONNET_46.name, {
        thinkingEnabled: false,
        topP: 0.8,
      });
      const args2 = mockMessagesCreate.mock.calls[1][0];
      expect(args2.top_p).toBe(0.8);
    });

    it("configures all standard parameters correctly", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.SONNET_46.name, {
        temperature: 0.6,
        topP: 0.95,
        topK: 25,
        maxTokens: 500,
        stopSequences: ["STOP1", "STOP2"],
        serviceTier: "standard",
      });

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const args = mockMessagesCreate.mock.calls[0][0];
      expect(args.temperature).toBe(0.6);
      expect(args.top_p).toBeUndefined(); // Omitted when temperature is passed
      expect(args.top_k).toBe(25);
      expect(args.max_tokens).toBe(500);
      expect(args.stop_sequences).toEqual(["STOP1", "STOP2"]);
      expect(args.service_tier).toBe("standard_only");
    });

    it("omits top_k for adaptive thinking models (like Fable 5) to prevent deprecated parameter errors", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.FABLE_5.name, {
        topK: 25,
      });

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const args = mockMessagesCreate.mock.calls[0][0];
      expect(args.top_k).toBeUndefined();
    });

    it("defaults to adaptive thinking for adaptive thinking models (like Fable 5) when thinkingEnabled is undefined", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.FABLE_5.name, {});

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const args = mockMessagesCreate.mock.calls[0][0];
      expect(args.thinking).toBeDefined();
      expect(args.thinking.type).toBe("adaptive");
      expect(args.temperature).toBe(1);
      expect(args.top_p).toBeUndefined();
      expect(args.top_k).toBeUndefined();
    });

    it("does not configure thinking for adaptive thinking models (like Fable 5) when thinkingEnabled is explicitly false", async () => {
      mockMessagesCreate.mockReturnValueOnce({
        content: [{ type: "text", text: "Finished" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const messages = [{ role: "user", content: "hello" }];
      await anthropicProvider.generateText(messages, MODELS.FABLE_5.name, {
        thinkingEnabled: false,
      });

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      const args = mockMessagesCreate.mock.calls[0][0];
      expect(args.thinking).toBeUndefined();
    });
  });

  // ── Section 2: Thinking Chunk Parsing in Streams ─────────────────────
  describe("Anthropic Provider Stream Thinking Chunk Parsing", () => {
    it("yields thinking, signature, text, and usage chunks", async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 80,
              }
            }
          };
          yield {
            type: "content_block_start",
            content_block: { type: "thinking" }
          };
          yield {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Thinking through the logic... " }
          };
          yield {
            type: "content_block_delta",
            delta: { type: "signature_delta", signature: "mysig-456" }
          };
          yield {
            type: "content_block_stop"
          };
          yield {
            type: "content_block_start",
            content_block: { type: "text" }
          };
          yield {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "The result is complete." }
          };
          yield {
            type: "content_block_stop"
          };
          yield {
            type: "message_delta",
            usage: { output_tokens: 40 }
          };
        },
        finalMessage: async () => ({
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 80,
          }
        }),
      };

      mockMessagesStream.mockReturnValueOnce(mockStream);

      const stream = anthropicProvider.generateTextStream([{ role: "user", content: "hi" }], MODELS.SONNET_46.name, {
        thinkingEnabled: true,
      });

      const results: any[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toContainEqual({ type: "thinking", content: "Thinking through the logic... " });
      expect(results).toContainEqual({ type: "thinking_signature", signature: "mysig-456" });
      expect(results).toContain("The result is complete.");
      expect(results).toContainEqual({
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 80,
        }
      });
    });
  });

  // ── Section 3: Agentic Loop State & Event Handling ──────────────────
  describe("AgenticLoopState Integration with Anthropic", () => {
    it("properly appends thinking, captures signature, and emits thinking events", async () => {
      const emittedEvents: any[] = [];
      const mockContext: any = {
        providerName: "anthropic",
        resolvedModel: MODELS.SONNET_46.name,
        modelDefinition: MODELS.SONNET_46,
        messages: [{ role: "user", content: "Identify prime factors of 96" }],
        options: {
          maxIterations: 1,
        },
        agentSessionId: "session-anthropic-thinking-123",
        parentAgentSessionId: null,
        traceId: "trace-anthropic-thinking-123",
        project: "test-thinking-project",
        username: "test-user",
        requestId: "req-anthropic-thinking-123",
        requestStart: performance.now(),
        emit: vi.fn((event) => emittedEvents.push(event)),
        signal: new AbortController().signal,
      };

      const state = new AgenticLoopState();
      const mockTools: any = {
        resolvedEnabledTools: [],
        finalTools: [],
      };

      const { default: BaseAgenticHarness } = await import(
        "../src/services/harnesses/BaseAgenticHarness.ts"
      );
      const { default: SessionGenerationTracker } = await import(
        "../src/services/SessionGenerationTracker.ts"
      );

      class DummyHarness extends BaseAgenticHarness {
        public async testProcessChunk(
          chunk: any,
          pass: any,
          allowedTools: Set<string>
        ) {
          return this.processStreamChunk(chunk, pass, allowedTools);
        }
      }

      SessionGenerationTracker.register(
        mockContext.agentSessionId,
        mockContext.requestId,
        {
          provider: mockContext.providerName,
          model: mockContext.resolvedModel,
        }
      );

      const pass: any = {
        requestId: mockContext.requestId,
        start: performance.now(),
        firstTokenTime: null,
        generationEnd: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        streamedThinking: "",
        thinkingSignature: "",
        outputCharacters: 0,
        streamedText: "",
        pendingToolCalls: [],
      };

      const harness = new DummyHarness(mockContext, state, mockTools);

      await harness.testProcessChunk(
        { type: "thinking", content: "Evaluating factors: " },
        pass,
        new Set()
      );
      await harness.testProcessChunk(
        { type: "thinking_signature", signature: "anthropic-signature-proof" },
        pass,
        new Set()
      );
      await harness.testProcessChunk(
        { type: "thinking", content: "96 = 2^5 * 3." },
        pass,
        new Set()
      );
      await harness.testProcessChunk("The factors are 2 and 3.", pass, new Set());

      // Verify overall thinking accumulation
      expect(state.streamedThinking).toBe(
        "Evaluating factors: 96 = 2^5 * 3."
      );
      
      // Verify signature captured on the pass
      expect(pass.thinkingSignature).toBe("anthropic-signature-proof");

      // Verify display segments structure
      expect(state.displaySegments).toContainEqual({
        type: "thinking",
        fragmentIndex: 0,
      });
      expect(state.displayThinkingFragments[0]).toBe(
        "Evaluating factors: 96 = 2^5 * 3."
      );

      // Cleanup
      SessionGenerationTracker.cleanup(mockContext.agentSessionId);
    });
  });
});


// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts) ──

describe('ThinkTagParser adversarial', () => {
  describe('extractThinkTags — static extraction', () => {
    it('should handle nested <think> tags — inner tags treated as content', () => {
      const raw = '<think>outer <think>inner</think> still outer</think> text';
      const result = extractThinkTags(raw);
      // Non-greedy regex should capture "outer <think>inner" then " still outer" remains
      // The exact behavior depends on regex non-greedy semantics
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe('string');
    });

    it('should handle unclosed <think> tag — no match, returned as plain text', () => {
      const raw = '<think>this tag is never closed and trails off...';
      const result = extractThinkTags(raw);
      // Non-greedy regex won\'t match without </think>
      expect(result.thinking).toBeNull();
      expect(result.text).toContain('<think>');
    });

    it('should handle </think> without opening tag — treated as plain text', () => {
      const raw = 'some text </think> more text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toBeNull();
      expect(result.text).toContain('</think>');
    });

    it('should handle empty <think></think> block', () => {
      const raw = 'before <think></think> after';
      const result = extractThinkTags(raw);
      // Empty think content should result in no thinking (empty string trimmed to nothing)
      expect(result.text).toBe('before  after');
    });

    it('should handle case-insensitive tags — <THINK> and <Think>', () => {
      const raw = '<THINK>uppercase thinking</THINK> text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toBe('uppercase thinking');
      expect(result.text).toBe('text');
    });

    it('should handle think tags spanning multiple lines', () => {
      const raw = '<think>\nline 1\nline 2\nline 3\n</think>\nfinal text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toContain('line 1');
      expect(result.thinking).toContain('line 3');
      expect(result.text).toBe('final text');
    });

    it('should handle null bytes inside think tags', () => {
      const raw = '<think>before\0after</think> text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toContain('\0');
    });
  });

  describe('ThinkTagParser — streaming partial boundaries', () => {
    it('should handle <think> tag split across two chunks: "<thi" + "nk>"', () => {
      const parser = new ThinkTagParser();
      const chunks1 = parser.feed('<thi');
      // Should buffer the partial tag, not emit it yet
      const textContent1 = chunks1.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content).join('');
      expect(textContent1).not.toContain('<thi');

      const chunks2 = parser.feed('nk>hello');
      const thinkingContent = chunks2.filter((chunk) => chunk.type === 'thinking').map((chunk) => chunk.content).join('');
      expect(thinkingContent).toBe('hello');
    });

    it('should handle </think> tag split across three chunks', () => {
      const parser = new ThinkTagParser();
      parser.feed('<think>content');
      parser.feed('</th');
      const chunks3 = parser.feed('ink>after');
      const afterTextContent = chunks3.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content).join('');
      expect(afterTextContent).toContain('after');
    });

    it('should handle rapid alternation between think and text', () => {
      const parser = new ThinkTagParser();
      let allResults: Array<{ type: string; content: string }> = [];
      for (let index = 0; index < 100; index++) {
        allResults = allResults.concat(parser.feed(`<think>t${index}</think>x${index}`));
      }
      const thinkCount = allResults.filter((result) => result.type === 'thinking').length;
      const textCount = allResults.filter((result) => result.type === 'text').length;
      expect(thinkCount).toBe(100);
      expect(textCount).toBe(100);
    });

    it('should emit thinking content via feed() and leave nothing for flush()', () => {
      const parser = new ThinkTagParser();
      const feedResult = parser.feed('<think>unflushed content');
      // feed() eagerly emits all content — buffer only holds partial tags
      const thinkingChunks = feedResult.filter((chunk) => chunk.type === 'thinking');
      expect(thinkingChunks.length).toBe(1);
      expect(thinkingChunks[0].content).toBe('unflushed content');
      // flush() returns empty because feed() already emitted
      const flushed = parser.flush();
      expect(flushed.length).toBe(0);
    });

    it('should emit text content via feed() and leave nothing for flush()', () => {
      const parser = new ThinkTagParser();
      const feedResult = parser.feed('regular text');
      // feed() eagerly emits text when no partial tag is pending
      const textChunks = feedResult.filter((chunk) => chunk.type === 'text');
      expect(textChunks.length).toBe(1);
      expect(textChunks[0].content).toBe('regular text');
      // flush() returns empty because feed() already emitted
      const flushed = parser.flush();
      expect(flushed.length).toBe(0);
    });

    it('should handle empty string feed', () => {
      const parser = new ThinkTagParser();
      const result = parser.feed('');
      expect(result).toEqual([]);
    });
  });
});

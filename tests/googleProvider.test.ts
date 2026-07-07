import { vi, describe, it, expect, beforeEach } from "vitest";
import "./setup.ts";
import googleProvider, { convertToolsToGoogle } from "#src/providers/google";
import { ConversationMessage } from "#src/providers/google";
import { ProviderError } from "#src/utils/errors";
import { Readable } from "stream";
import { MODEL_TYPES } from "#src/constants";

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();
const mockEmbedContent = vi.fn();
const mockLiveConnect = vi.fn();

vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: (...invocationArguments: any[]) => {
          return mockGenerateContent(...invocationArguments);
        },
        generateContentStream: (...invocationArguments: any[]) => {
          return mockGenerateContentStream(...invocationArguments);
        },
        embedContent: (...invocationArguments: any[]) => {
          return mockEmbedContent(...invocationArguments);
        },
      };
      live = {
        connect: (...invocationArguments: any[]) => {
          return mockLiveConnect(...invocationArguments);
        },
      };
    },
    Modality: {
      AUDIO: "AUDIO",
      TEXT: "TEXT",
    },
    MediaResolution: {
      LOW: "LOW",
      HIGH: "HIGH",
    },
    ServiceTier: {
      AUTO: "AUTO",
      STANDARD: "STANDARD",
    },
  };
});

describe("Google Provider Adapter", () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockGenerateContentStream.mockReset();
    mockEmbedContent.mockReset();
    mockLiveConnect.mockReset();

    // Sensible defaults
    mockGenerateContent.mockResolvedValue({
      text: "Google response text",
      candidates: [
        {
          content: {
            parts: [{ text: "Google response text" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 60,
        cachedContentTokenCount: 10,
      },
    });

    mockGenerateContentStream.mockResolvedValue({
      [Symbol.asyncIterator]: () => {
        async function* generator() {
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: "Hello" }],
                },
              },
            ],
          };
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: " world" }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 150,
              candidatesTokenCount: 70,
              cachedContentTokenCount: 10,
            },
          };
        }
        return generator();
      },
    });
  });

  describe("convertToolsToGoogle helper", () => {
    it("converts custom tools to Google format with parameter schema sanitization", () => {
      const tools = [
        {
          name: "get_user_info",
          description: "Get user info",
          parameters: {
            type: "object",
            properties: {
              roles: {
                type: "array",
                items: { type: "string", enum: ["admin", "user"] },
              },
              title: { type: "string" },
            },
            required: ["title"],
          },
        },
      ];

      const result = convertToolsToGoogle(tools);
      expect(result).toBeDefined();
      expect(result).toHaveLength(1);
      expect(result![0].functionDeclarations).toHaveLength(1);

      const functionDeclaration = result![0].functionDeclarations[0];
      expect(functionDeclaration.name).toBe("get_user_info");
      expect(functionDeclaration.description).toBe("Get user info");
      expect(functionDeclaration.parameters.type).toBe("object");
      expect((functionDeclaration.parameters as any).properties.title).toBeDefined();
    });
  });

  describe("generateText", () => {
    it("builds text content parts correctly and parses response", async () => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Explain quantum physics" },
      ];

      const result = await googleProvider.generateText(messages, "gemini-3.5-flash");

      expect(mockGenerateContent).toHaveBeenCalled();
      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.model).toBe("gemini-3.5-flash");
      expect(callArguments.contents).toEqual([
        { role: "user", parts: [{ text: "Explain quantum physics" }] },
      ]);

      expect(result.text).toBe("Google response text");
      expect(result.usage).toEqual({
        inputTokens: 150,
        outputTokens: 60,
        cacheReadInputTokens: 10,
      });
    });

    it("builds image and multimodal content parts correctly", async () => {
      const messages: ConversationMessage[] = [
        {
          role: "user",
          content: "Look at this picture",
          images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"],
        },
      ];

      await googleProvider.generateText(messages, "gemini-3.5-flash");

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.contents[0].parts).toHaveLength(2);
      expect(callArguments.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAUA" },
      });
      expect(callArguments.contents[0].parts[1]).toEqual({ text: "Look at this picture" });
    });

    it("submits tools in config when option tools are passed", async () => {
      const messages: ConversationMessage[] = [{ role: "user", content: "Call tool" }];
      const tools = [
        {
          name: "do_action",
          parameters: { type: "object", properties: {} },
        },
      ];

      await googleProvider.generateText(messages, "gemini-3.5-flash", { tools, webSearch: true });

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.config.tools).toHaveLength(2);
      expect(callArguments.config.tools[0]).toEqual({ googleSearch: {} });
      expect(callArguments.config.tools[1]).toHaveProperty("functionDeclarations");
    });

    it("merges consecutive tool result messages into a single user turn", async () => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Hello" },
        { role: "tool", name: "tool_a", content: "result A" },
        { role: "tool", name: "tool_b", content: { val: 42 } as any },
      ];

      await googleProvider.generateText(messages, "gemini-3.5-flash");

      const callArguments = mockGenerateContent.mock.calls[0][0];
      const contents = callArguments.contents;
      expect(contents).toHaveLength(2);
      expect(contents[1].role).toBe("user");
      expect(contents[1].parts).toHaveLength(2);
      expect(contents[1].parts[0]).toEqual({
        functionResponse: { name: "tool_a", response: { result: "result A" } },
      });
      expect(contents[1].parts[1]).toEqual({
        functionResponse: { name: "tool_b", response: { result: '{"val":42}' } },
      });
    });

    it("converts system messages mid-conversation to user role", async () => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Hello" },
        { role: "system", content: "system-directive" },
      ];

      await googleProvider.generateText(messages, "gemini-3.5-flash");

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.contents[1]).toEqual({
        role: "user",
        parts: [{ text: "system-directive" }],
      });
    });

    it("preserves thoughtSignature and maps toolCalls correctly in the response candidates", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "custom_tool", args: { param: "value" } },
                  thoughtSignature: "thought-signature-xyz",
                },
              ],
            },
          },
        ],
      });

      const result = await googleProvider.generateText(
        [{ role: "user", content: "Run tool" }],
        "gemini-3.5-flash"
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe("custom_tool");
      expect(result.toolCalls![0].args).toEqual({ param: "value" });
      expect(result.toolCalls![0].thoughtSignature).toBe("thought-signature-xyz");
    });

    it("resolves and fetches http URLs when passed in image reference lists", async () => {
      const messages: ConversationMessage[] = [
        {
          role: "user",
          content: "look",
          images: ["http://example.com/test.jpg"],
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "image/jpeg" : null),
        },
        arrayBuffer: async () => Buffer.from("downloaded-data"),
      } as any);

      await googleProvider.generateText(messages, "gemini-3.5-flash");

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.contents[0].parts[0]).toEqual({
        inlineData: {
          mimeType: "image/jpeg",
          data: Buffer.from("downloaded-data").toString("base64"),
        },
      });

      fetchSpy.mockRestore();
    });

    it("sets responseModalities: ['IMAGE'] when forceImageGeneration is true and model definition outputTypes has image", async () => {
      const messages: ConversationMessage[] = [{ role: "user", content: "make image" }];

      await googleProvider.generateText(messages, "gemini-3-pro-image-preview", {
        forceImageGeneration: true,
      });

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.config.responseModalities).toEqual(["IMAGE"]);
    });

    it("sets includesThoughts config when thinking is enabled and model supports thinking", async () => {
      const messages: ConversationMessage[] = [{ role: "user", content: "think" }];

      await googleProvider.generateText(messages, "gemini-3-pro-image-preview", {
        thinkingEnabled: true,
        thinkingBudget: 1000,
      });

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.config.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 1000,
      });
    });

    it("sets thinkingBudget to 0 when thinkingEnabled is false and model supports thinking", async () => {
      const messages: ConversationMessage[] = [{ role: "user", content: "think fast" }];

      await googleProvider.generateText(messages, "gemini-3-pro-image-preview", {
        thinkingEnabled: false,
      });

      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.config.thinkingConfig).toEqual({
        thinkingBudget: 0,
      });
    });

    it("handles content safety block error gracefully and returns safetyBlock property", async () => {
      mockGenerateContent.mockRejectedValue(new Error("Blocked by image_safety policy"));

      const result = await googleProvider.generateText(
        [{ role: "user", content: "flagged content" }],
        "gemini-3.5-flash"
      );

      expect(result.text).toBe("");
      expect(result.safetyBlock).toBe(true);
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it("propagates non-safety errors as ProviderError", async () => {
      const errorObject = new Error("Quota exceeded");
      (errorObject as any).status = 429;
      mockGenerateContent.mockRejectedValue(errorObject);

      await expect(
        googleProvider.generateText([{ role: "user", content: "test" }], "gemini-3.5-flash")
      ).rejects.toThrow(ProviderError);
    });
  });

  describe("generateTextStream", () => {
    it("yields streamed text content and usage chunks", async () => {
      const messages: ConversationMessage[] = [{ role: "user", content: "Stream this" }];
      const stream = googleProvider.generateTextStream(messages, "gemini-3.5-flash");

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(mockGenerateContentStream).toHaveBeenCalled();
      expect(chunks).toContain("Hello");
      expect(chunks).toContain(" world");
      const usageChunk = chunks.find(
        (chunkItem) => typeof chunkItem === "object" && chunkItem.type === "usage"
      );
      expect(usageChunk).toBeDefined();
      expect(usageChunk.usage).toEqual({
        inputTokens: 150,
        outputTokens: 70,
        cacheReadInputTokens: 10,
      });
    });

    it("supports AbortSignal to break out of generator loop early", async () => {
      const messages: ConversationMessage[] = [{ role: "user", content: "Abort this" }];
      const controller = new AbortController();

      mockGenerateContentStream.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          async function* generator() {
            yield { candidates: [{ content: { parts: [{ text: "first" }] } }] };
            controller.abort();
            yield { candidates: [{ content: { parts: [{ text: "second" }] } }] };
          }
          return generator();
        },
      });

      const stream = googleProvider.generateTextStream(messages, "gemini-3.5-flash", {
        signal: controller.signal,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContain("first");
      expect(chunks).not.toContain("second");
    });

    it("yields thinking, executableCode, and codeExecutionResult parts", async () => {
      mockGenerateContentStream.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          async function* generator() {
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      { thought: true, text: "I am thinking" },
                      {
                        executableCode: { code: 'print("hello")', language: "python" },
                      },
                      {
                        codeExecutionResult: { output: "hello", outcome: "OK" },
                      },
                    ],
                  },
                },
              ],
            };
          }
          return generator();
        },
      });

      const stream = googleProvider.generateTextStream(
        [{ role: "user", content: "run python" }],
        "gemini-3.5-flash"
      );

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: "thinking", content: "I am thinking" });
      expect(chunks).toContainEqual({
        type: "executableCode",
        code: 'print("hello")',
        language: "python",
      });
      expect(chunks).toContainEqual({
        type: "codeExecutionResult",
        output: "hello",
        outcome: "OK",
      });
    });

    it("yields stopReason stopReason: 'max_tokens' when finishReason is MAX_TOKENS", async () => {
      mockGenerateContentStream.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          async function* generator() {
            yield {
              candidates: [
                {
                  finishReason: "MAX_TOKENS",
                  content: { parts: [{ text: "limit reached" }] },
                },
              ],
            };
          }
          return generator();
        },
      });

      const stream = googleProvider.generateTextStream(
        [{ role: "user", content: "limit" }],
        "gemini-3.5-flash"
      );

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: "stopReason", stopReason: "max_tokens" });
    });

    it("yields default zero usage block if stream terminates without usageMetadata", async () => {
      mockGenerateContentStream.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          async function* generator() {
            yield {
              candidates: [{ content: { parts: [{ text: "done" }] } }],
            };
          }
          return generator();
        },
      });

      const stream = googleProvider.generateTextStream(
        [{ role: "user", content: "no usage" }],
        "gemini-3.5-flash"
      );

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } });
    });

    it("handles safety block error on stream and yields safetyBlock", async () => {
      mockGenerateContentStream.mockRejectedValue(new Error("Response was blocked by content filter"));

      const stream = googleProvider.generateTextStream(
        [{ role: "user", content: "unsafe stream" }],
        "gemini-3.5-flash"
      );

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual({
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 0 },
        safetyBlock: true,
      });
    });
  });

  describe("generateTextStreamLive", () => {
    it("manages Live API session WebSocket, handles callbacks, and yields items", async () => {
      const mockSession = {
        sendClientContent: vi.fn(),
        sendRealtimeInput: vi.fn(),
        close: vi.fn(),
      };

      let registeredCallbacks: any = null;
      mockLiveConnect.mockImplementation((config: any) => {
        registeredCallbacks = config.callbacks;
        return Promise.resolve(mockSession);
      });

      const messages: ConversationMessage[] = [
        { role: "user", content: "seed message" },
        { role: "user", content: "live question" },
      ];

      const stream = googleProvider.generateTextStreamLive(
        messages,
        "gemini-2.0-flash-live-001"
      );

      // Start pulling from the generator in the background
      const pullPromise = (async () => {
        const chunks: any[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      // Wait a tick for live.connect to be called
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockLiveConnect).toHaveBeenCalled();
      expect(registeredCallbacks).toBeDefined();

      // Simulate connection open and setup complete
      registeredCallbacks.onopen();
      registeredCallbacks.onmessage({ setupComplete: true });

      // Wait a tick for the setupComplete wait loop to resolve and seed messages to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSession.sendClientContent).toHaveBeenCalled();
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({ text: "live question" });

      // Push content messages
      registeredCallbacks.onmessage({
        serverContent: {
          modelTurn: {
            parts: [
              { thought: true, text: "Let me think" },
              { inlineData: { mimeType: "audio/pcm", data: "base64audio" } },
              { text: "transcribed text" },
            ],
          },
        },
      });

      registeredCallbacks.onmessage({
        serverContent: {
          outputTranscription: { text: "audio text output" },
        },
      });

      registeredCallbacks.onmessage({
        usageMetadata: {
          promptTokenCount: 120,
          responseTokenCount: 50,
        },
      });

      registeredCallbacks.onmessage({
        serverContent: { turnComplete: true },
      });

      registeredCallbacks.onclose();

      const yieldedChunks = await pullPromise;
      expect(yieldedChunks).toContain("audio text output");
      expect(yieldedChunks).toContainEqual({ type: "thinking", content: "Let me think" });
      expect(yieldedChunks).toContainEqual({ type: MODEL_TYPES.AUDIO, data: "base64audio", mimeType: "audio/pcm" });
      expect(yieldedChunks).toContainEqual({
        type: "usage",
        usage: { inputTokens: 120, outputTokens: 50 },
      });

      expect(mockSession.close).toHaveBeenCalled();
    });

    it("handles error callback by throwing ProviderError", async () => {
      mockLiveConnect.mockResolvedValue({
        sendClientContent: vi.fn(),
        sendRealtimeInput: vi.fn(),
        close: vi.fn(),
      });

      const stream = googleProvider.generateTextStreamLive(
        [{ role: "user", content: "test" }],
        "gemini-2.0-flash-live-001"
      );

      const pullPromise = (async () => {
        const chunks: any[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        return chunks;
      })();

      await new Promise((resolve) => setTimeout(resolve, 10));
      const registeredCallbacks = mockLiveConnect.mock.calls[0][0].callbacks;

      registeredCallbacks.onopen();
      registeredCallbacks.onerror({ error: { message: "connection refused" } });

      await expect(pullPromise).rejects.toThrow(ProviderError);
    });
  });

  describe("captionImage", () => {
    it("handles mixed base64 and HTTP URL inputs to caption image", async () => {
      mockGenerateContent.mockResolvedValue({
        text: "Beautiful description",
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50 },
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "image/jpeg" : null),
        },
        arrayBuffer: async () => Buffer.from("image-bytes"),
      } as any);

      const result = await googleProvider.captionImage(
        ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA", "http://example.com/other.png"],
        "What is this?",
        "gemini-3.5-flash",
        "custom system instruction"
      );

      expect(mockGenerateContent).toHaveBeenCalled();
      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.config.systemInstruction).toBe("custom system instruction");
      expect(callArguments.contents[0].parts).toHaveLength(3);
      expect(callArguments.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAUA" },
      });

      expect(result.text).toBe("Beautiful description");
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 50 });

      fetchSpy.mockRestore();
    });
  });

  describe("generateImage", () => {
    it("sends generation command and returns image details", async () => {
      mockGenerateContentStream.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          async function* generator() {
            yield {
              text: "starting...",
              candidates: [
                {
                  content: {
                    parts: [{ text: "starting..." }]
                  }
                }
              ]
            };
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: { mimeType: "image/png", data: "generated-image-base64" },
                      },
                    ],
                  },
                },
              ],
            };
          }
          return generator();
        },
      });

      const result = await googleProvider.generateImage(
        "a photorealistic cat",
        ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"],
        "imagen-3.0-generate-002"
      );

      expect(mockGenerateContentStream).toHaveBeenCalled();
      expect(result.imageData).toBe("generated-image-base64");
      expect(result.mimeType).toBe("image/png");
      expect(result.text).toBe("starting...");
    });

    it("throws error if prohibited content flag is encountered during image generation", async () => {
      mockGenerateContentStream.mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          async function* generator() {
            yield {
              candidates: [
                {
                  finishReason: "PROHIBITED_CONTENT",
                  content: {
                    parts: [{ text: "" }]
                  }
                },
              ],
            };
          }
          return generator();
        },
      });

      await expect(
        googleProvider.generateImage("unsafe prompt", [], "imagen-3.0-generate-002")
      ).rejects.toThrow("Content was flagged as prohibited by Google AI");
    });
  });

  describe("generateSpeech", () => {
    it("handles mp3 generation and streams the output directly", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: { mimeType: "audio/mpeg", data: Buffer.from("audio-bytes").toString("base64") },
                },
              ],
            },
          },
        ],
      });

      const result = await googleProvider.generateSpeech(
        "Hello world",
        "Puck",
        { prompt: "say this:", model: "gemini-3.5-flash" }
      );

      expect(mockGenerateContent).toHaveBeenCalled();
      expect(result.contentType).toBe("audio/mpeg");

      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk as Buffer);
      }
      const combined = Buffer.concat(chunks);
      expect(combined.toString()).toBe("audio-bytes");
    });

    it("handles wav audio by adding a valid WAV header", async () => {
      mockGenerateContent.mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: { mimeType: "audio/pcm", data: Buffer.from("rawpcm").toString("base64") },
                },
              ],
            },
          },
        ],
      });

      const result = await googleProvider.generateSpeech("wav test", "Puck");
      expect(result.contentType).toBe("audio/wav");

      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk as Buffer);
      }
      const combined = Buffer.concat(chunks);
      // WAV header is 44 bytes, rawpcm is 6 bytes -> 50 bytes total
      expect(combined).toHaveLength(50);
      expect(combined.subarray(0, 4).toString()).toBe("RIFF");
      expect(combined.subarray(8, 12).toString()).toBe("WAVE");
    });
  });

  describe("transcribeAudio", () => {
    it("submits prompt and audio buffer for transcription", async () => {
      mockGenerateContent.mockResolvedValue({
        text: "This is a transcribed sentence.",
        usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 30 },
      });

      const result = await googleProvider.transcribeAudio(
        Buffer.from("raw-audio-bytes"),
        "audio/wav",
        "gemini-3.5-flash",
        { language: "en", prompt: "custom transcription instruction" }
      );

      expect(mockGenerateContent).toHaveBeenCalled();
      const callArguments = mockGenerateContent.mock.calls[0][0];
      expect(callArguments.config.systemInstruction).toBe("Transcribe in en.");
      expect(callArguments.contents[0].parts[0].inlineData.data).toBe(
        Buffer.from("raw-audio-bytes").toString("base64")
      );
      expect(callArguments.contents[0].parts[1].text).toBe("custom transcription instruction");

      expect(result.text).toBe("This is a transcribed sentence.");
      expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
    });
  });

  describe("generateEmbedding", () => {
    it("handles simple text embedding and parses single response values", async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.1, 0.2, 0.3] }],
      });

      const result = await googleProvider.generateEmbedding("hello world");

      expect(mockEmbedContent).toHaveBeenCalled();
      expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(result.dimensions).toBe(3);
    });

    it("handles batch multimodal array inputs and returns parsed values from embeddings array", async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [0.9, 0.8, 0.7] }],
      });

      const result = await googleProvider.generateEmbedding(
        [{ text: "hello" }, { inlineData: { mimeType: "image/png", data: "..." } }],
        "text-embedding-004",
        { taskType: "RETRIEVAL_DOCUMENT", dimensions: 3 }
      );

      expect(mockEmbedContent).toHaveBeenCalled();
      const callArguments = mockEmbedContent.mock.calls[0][0];
      expect(callArguments.config).toEqual({
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 3,
      });
      expect(result.embedding).toEqual([0.9, 0.8, 0.7]);
    });
  });
});

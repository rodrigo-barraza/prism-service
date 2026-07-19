import { vi, describe, it, expect, beforeEach } from "vitest";
import "./setup.ts";
import openaiProvider, {
  normalizeResponsesUsage,
  prepareResponsesInput,
} from "#src/providers/openai";
import { OpenAIMessage } from "#src/providers/openai";
import { PROVIDERS, MODALITY_TYPES, MESSAGE_ROLES } from "#src/constants";

const mockChatCreate = vi.fn();
const mockResponsesCreate = vi.fn();
const mockSpeechCreate = vi.fn();
const mockImagesGenerate = vi.fn();
const mockImagesEdit = vi.fn();
const mockEmbeddingsCreate = vi.fn();
const mockTranscriptionsCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: (...args: any[]) => {
            const mockResult = mockChatCreate(...args);
            if (mockResult) return mockResult;
            const options = args[1];
            if (options?.signal?.aborted) {
              const abortError = new Error("The user aborted a request.");
              abortError.name = "AbortError";
              throw abortError;
            }
            const isStream = args[0]?.stream;
            if (isStream) {
              const asyncGenerator = async function* () {
                yield {
                  choices: [{ delta: { content: "Hello" } }],
                };
                yield {
                  choices: [
                    {
                      delta: {
                        content: "",
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_123",
                            function: {
                              name: "test_tool",
                              arguments: '{"arg"',
                            },
                          },
                        ],
                      },
                    },
                  ],
                };
                yield {
                  choices: [
                    {
                      delta: {
                        content: "",
                        tool_calls: [
                          {
                            index: 0,
                            function: {
                              arguments: ':"value"}',
                            },
                          },
                        ],
                      },
                    },
                  ],
                };
                yield {
                  choices: [
                    {
                      delta: { content: " world" },
                      finish_reason: "tool_calls",
                    },
                  ],
                  usage: { prompt_tokens: 110, completion_tokens: 55 },
                };
              };
              return {
                [Symbol.asyncIterator]: () => asyncGenerator(),
                withResponse: async () => ({
                  data: asyncGenerator(),
                  response: {
                    headers: {
                      get: (headerName: string) => {
                        const headers: Record<string, string> = {
                          "x-ratelimit-limit-requests": "2000",
                          "x-ratelimit-remaining-requests": "1999",
                        };
                        return headers[headerName.toLowerCase()] || null;
                      },
                    },
                  },
                }),
              };
            }

            const mockData = {
              choices: [
                {
                  message: {
                    role: MESSAGE_ROLES.ASSISTANT,
                    content: "OpenAI Chat completions response",
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 110,
                completion_tokens: 55,
                prompt_tokens_details: { cached_tokens: 15 },
                completion_tokens_details: { reasoning_tokens: 25 },
              },
            };
            const rawResponse = {
              headers: {
                get: (headerName: string) => {
                  const headers: Record<string, string> = {
                    "x-ratelimit-limit-requests": "1000",
                    "x-ratelimit-remaining-requests": "999",
                    "x-ratelimit-reset-requests": "10s",
                    "x-ratelimit-limit-tokens": "100000",
                    "x-ratelimit-remaining-tokens": "99900",
                    "x-ratelimit-reset-tokens": "10s",
                  };
                  return headers[headerName.toLowerCase()] || null;
                },
              },
            };
            return {
              ...mockData,
              withResponse: async () => ({
                data: mockData,
                response: rawResponse,
              }),
            };
          },
        },
      };

      responses = {
        create: (...args: any[]) => {
          mockResponsesCreate(...args);
          const options = args[1];
          if (options?.signal?.aborted) {
            const abortError = new Error("The user aborted a request.");
            abortError.name = "AbortError";
            throw abortError;
          }
          const isStream = args[0]?.stream;
          if (isStream) {
            const asyncGenerator = async function* () {
              yield {
                type: "response.output_text.delta",
                delta: "Hello",
              };
              yield {
                type: "response.reasoning_summary_text.delta",
                delta: "thought summary text",
                item_id: "reasoning_item_1",
              };
              yield {
                type: "response.output_item.added",
                item: {
                  type: "reasoning",
                  id: "reasoning_item_1",
                  summary: [],
                },
              };
              yield {
                type: "response.output_item.added",
                item: {
                  type: "function_call",
                  id: "fc_1",
                  name: "get_user",
                  call_id: "call_1",
                },
              };
              yield {
                type: "response.function_call_arguments.delta",
                item_id: "fc_1",
                delta: '{"id": 42}',
              };
              yield {
                type: "response.function_call_arguments.done",
                item_id: "fc_1",
                name: "get_user",
                arguments: '{"id": 42}',
              };
              yield {
                type: "response.completed",
                response: {
                  usage: {
                    input_tokens: 200,
                    output_tokens: 100,
                    input_tokens_details: { cached_tokens: 30 },
                    output_tokens_details: { reasoning_tokens: 40 },
                  },
                },
              };
            };
            return {
              [Symbol.asyncIterator]: () => asyncGenerator(),
              withResponse: async () => ({
                data: asyncGenerator(),
                response: {
                  headers: {
                    get: () => null,
                  },
                },
              }),
            };
          }

          const mockData = {
            status: "completed",
            output_text: "OpenAI Responses API response",
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              input_tokens_details: { cached_tokens: 30 },
              output_tokens_details: { reasoning_tokens: 40 },
            },
            output: [
              {
                type: "text",
                text: "OpenAI Responses API response",
              },
              {
                type: "reasoning",
                id: "reasoning_item_1",
                summary: [{ type: "text", text: "Reasoned content" }],
              },
              {
                type: "function_call",
                id: "fc_1",
                name: "get_user",
                call_id: "call_1",
                arguments: '{"id": 42}',
              },
              {
                type: "image_generation_call",
                result: "image-gen-base64",
              },
            ],
          };
          const rawResponse = {
            headers: {
              get: (headerName: string) => {
                const headers: Record<string, string> = {
                  "x-ratelimit-limit-requests": "1500",
                  "x-ratelimit-remaining-requests": "1499",
                };
                return headers[headerName.toLowerCase()] || null;
              },
            },
          };
          return {
            ...mockData,
            withResponse: async () => ({
              data: mockData,
              response: rawResponse,
            }),
          };
        },
      };

      audio = {
        speech: {
          create: (...args: any[]) => {
            mockSpeechCreate(...args);
            return {
              body: "audio-stream-mock",
            };
          },
        },
        transcriptions: {
          create: (...args: any[]) => {
            const mockedValue = mockTranscriptionsCreate(...args);
            if (mockedValue) return mockedValue;
            return {
              text: "transcribed audio text",
              usage: {
                type: "tokens",
                input_tokens: 50,
                output_tokens: 25,
              },
            };
          },
        },
      };

      images = {
        generate: (...args: any[]) => {
          const mockedValue = mockImagesGenerate(...args);
          if (mockedValue) return mockedValue;
          return {
            data: [
              {
                b64_json: "generated-image-base64",
                revised_prompt: "revised prompt text",
              },
            ],
          };
        },
        edit: (...args: any[]) => {
          mockImagesEdit(...args);
          return {
            data: [{ b64_json: "edited-image-base64" }],
          };
        },
      };

      embeddings = {
        create: (...args: any[]) => {
          mockEmbeddingsCreate(...args);
          return {
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          };
        },
      };
    },
    toFile: async (buffer: Buffer, filename: string, options?: any) => {
      return {
        buffer,
        filename,
        type: options?.type,
      };
    },
  };
});

describe("OpenAI Provider Adapter", () => {
  beforeEach(() => {
    mockChatCreate.mockClear();
    mockResponsesCreate.mockClear();
    mockSpeechCreate.mockClear();
    mockImagesGenerate.mockClear();
    mockImagesEdit.mockClear();
    mockEmbeddingsCreate.mockClear();
    mockTranscriptionsCreate.mockClear();
  });

  describe("normalizeResponsesUsage", () => {
    it("correctly maps raw usage structure to normalized token usage", () => {
      const rawUsage = {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 10 },
      };

      const result = normalizeResponsesUsage(rawUsage);
      expect(result).toEqual({
        inputTokens: 80, // input_tokens - cached_tokens
        outputTokens: 50,
        cacheReadInputTokens: 20,
        reasoningOutputTokens: 10,
      });
    });
  });

  describe("prepareResponsesInput helper", () => {
    it("correctly maps system message to developer role and handles standard content", () => {
      const messages: OpenAIMessage[] = [
        { role: MESSAGE_ROLES.SYSTEM, content: "You are an agent" },
        { role: MESSAGE_ROLES.USER, content: "Hello" },
      ];

      const result = prepareResponsesInput(messages);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: "developer", content: "You are an agent" });
      expect(result[1]).toEqual({ role: MESSAGE_ROLES.USER, content: "Hello" });
    });

    it("maps user images and files properly", () => {
      const messages: OpenAIMessage[] = [
        {
          role: MESSAGE_ROLES.USER,
          content: "Here is content",
          images: [
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
            "data:application/pdf;base64,JVBERi0xLjQK",
            "http://example.com/image.jpg",
          ],
        },
      ];

      const result = prepareResponsesInput(messages);
      expect(result).toHaveLength(1);
      const userMessageContent = (result[0] as any).content as any[];
      expect(userMessageContent).toHaveLength(4);
      expect(userMessageContent[0]).toEqual({
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
        detail: "auto",
      });
      expect(userMessageContent[1]).toEqual({
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBERi0xLjQK",
        filename: "document.pdf",
      });
      expect(userMessageContent[2]).toEqual({
        type: "input_image",
        image_url: "http://example.com/image.jpg",
        detail: "auto",
      });
      expect(userMessageContent[3]).toEqual({
        type: "input_text",
        text: "Here is content",
      });
    });

    it("handles text file inline decoding and other data URLs", () => {
      const messages: OpenAIMessage[] = [
        {
          role: MESSAGE_ROLES.USER,
          images: [
            "data:text/plain;base64,SGVsbG8gV29ybGQ=", // "Hello World"
            "data:application/octet-stream;base64,SGVsbG8=",
          ],
        },
      ];
      const result = prepareResponsesInput(messages);
      expect(result).toHaveLength(1);
      const content = (result[0] as any).content as any[];
      expect(content[0]).toEqual({
        type: "input_text",
        text: "[Attached file (text/plain)]:\nHello World",
      });
      expect(content[1]).toEqual({
        type: "input_file",
        file_data: "data:application/octet-stream;base64,SGVsbG8=",
        filename: "attachment",
      });
    });

    it("supports assistant and tool messages in responses input format", () => {
      const messages: OpenAIMessage[] = [
        {
          role: MESSAGE_ROLES.ASSISTANT,
          content: "Hello",
          toolCalls: [
            {
              id: "call_1",
              name: "get_user",
              args: { id: 1 },
              responsesItemId: "fc_1",
              result: "User loaded",
            },
          ],
        },
        {
          role: MESSAGE_ROLES.TOOL,
          tool_call_id: "fc_1",
          content: "User loaded",
        },
      ];
      const result = prepareResponsesInput(messages);
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ role: MESSAGE_ROLES.ASSISTANT, content: "Hello" });
      expect(result[1]).toEqual({
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_user",
        arguments: '{"id":1}',
      });
      expect(result[2]).toEqual({
        type: "function_call_output",
        call_id: "call_1",
        output: "User loaded",
      });
      expect(result[3]).toEqual({
        type: "function_call_output",
        call_id: "fc_1",
        output: "User loaded",
      });
    });
  });

  describe("generateText", () => {
    it("uses chat.completions when Responses API is not supported by model", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Hello" }];
      const result = await openaiProvider.generateText(messages, "gpt-4o");

      expect(mockChatCreate).toHaveBeenCalled();
      expect(mockResponsesCreate).not.toHaveBeenCalled();
      expect(result?.text).toBe("OpenAI Chat completions response");
      expect(result?.usage).toEqual({
        inputTokens: 95, // 110 - 15 cache
        outputTokens: 55,
        cacheReadInputTokens: 15,
        reasoningOutputTokens: 25,
      });
      expect(result?.rateLimits).toEqual({
        provider: PROVIDERS.OPENAI,
        requests: {
          limit: 1000,
          remaining: 999,
          reset: "10s",
        },
        tokens: {
          limit: 100000,
          remaining: 99900,
          reset: "10s",
        },
      });
    });

    it("uses responses API when Responses API is supported by model", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Hello" }];
      const result = await openaiProvider.generateText(messages, "gpt-5.5", {
        reasoningEffort: "medium",
        reasoningSummary: "concise",
        maxTokens: 50,
        seed: 42,
        serviceTier: "priority",
        responseFormat: "json_object",
      });

      expect(mockResponsesCreate).toHaveBeenCalled();
      expect(result?.text).toBe("OpenAI Responses API response");
      expect(result?.usage).toEqual({
        inputTokens: 170, // 200 - 30 cache
        outputTokens: 100,
        cacheReadInputTokens: 30,
        reasoningOutputTokens: 40,
      });
      expect(result?.toolCalls).toHaveLength(1);
      expect((result as any).toolCalls[0]).toEqual({
        id: "call_1",
        responsesItemId: "fc_1",
        name: "get_user",
        args: { id: 42 },
        reasoningItem: {
          id: "reasoning_item_1",
          summary: [{ type: MODALITY_TYPES.TEXT, text: "Reasoned content" }],
        },
      });
    });

    it("applies strict schema sanitization for responses API with complex tools", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Action" }];
      const result = await openaiProvider.generateText(messages, "gpt-5.5", {
        responseFormat: "json_schema",
        responseSchema: {
          name: "schema",
          schema: {
            type: "object",
            properties: {
              constField: { const: "constantValue" },
              disallowedField: { type: "string", default: "defaultVal" },
              unionField: { type: ["string", "null"] },
            },
          },
        },
        tools: [
          {
            name: "test_tool",
            description: "A tool to test schema sanitization",
            parameters: {
              type: "object",
              properties: {
                nestedObject: {
                  type: "object",
                  properties: {
                    flag: { type: "boolean" },
                  },
                },
              },
            },
          },
        ],
      });

      expect(mockResponsesCreate).toHaveBeenCalled();
      const payload = mockResponsesCreate.mock.calls[0][0];
      expect(payload.text.format.type).toBe("json_schema");
      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0].strict).toBe(true);
    });

    it("triggers parameter retry on 400 error status", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Error retry" }];
      const mockCompletionsError = new Error("Unsupported parameter: 'temperature'");
      (mockCompletionsError as any).status = 400;

      mockChatCreate.mockImplementationOnce(() => {
        throw mockCompletionsError;
      });

      const result = await openaiProvider.generateText(messages, "gpt-4o", {
        temperature: 0.7,
      });

      expect(mockChatCreate).toHaveBeenCalledTimes(2);
      expect(result?.text).toBe("OpenAI Chat completions response");
    });
  });

  describe("generateTextStream", () => {
    it("streams chat completions correctly with delta accumulation", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Hello Stream" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o");

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContain("Hello");
      expect(chunks).toContain(" world");
      const toolCallStart = chunks.find((c) => c.type === "toolCallStart");
      expect(toolCallStart).toEqual({
        type: "toolCallStart",
        id: "call_123",
        name: "test_tool",
      });
      const toolCall = chunks.find((c) => c.type === "toolCall");
      expect(toolCall).toEqual({
        type: "toolCall",
        id: "call_123",
        name: "test_tool",
        args: { arg: "value" },
      });
    });

    it("streams responses API correctly with thinking and completed events", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Responses Stream" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-5.5", {
        parallelToolCalls: false,
        store: false,
        topLogprobs: 5,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContain("Hello");
      const thinking = chunks.find((c) => c.type === "thinking");
      expect(thinking).toEqual({
        type: "thinking",
        content: "thought summary text",
      });
      const toolCall = chunks.find((c) => c.type === "toolCall");
      expect(toolCall).toBeDefined();
      expect(toolCall.responsesItemId).toBe("fc_1");
    });
  });

  describe("generateSpeech", () => {
    it("calls speech create with correct options", async () => {
      const result = await openaiProvider.generateSpeech("Hello world", "alloy", {
        instructions: "Speak clearly",
        model: "tts-1",
      });

      expect(mockSpeechCreate).toHaveBeenCalled();
      const payload = mockSpeechCreate.mock.calls[0][0];
      expect(payload.input).toBe("Hello world");
      expect(payload.voice).toBe("alloy");
      expect(payload.instructions).toBe("Speak clearly");
      expect(result?.stream).toBe("audio-stream-mock");
      expect(result?.contentType).toBe("audio/mpeg");
    });
  });

  describe("generateImage", () => {
    it("generates a new image when no input images are provided", async () => {
      const result = await openaiProvider.generateImage("A cute cat");

      expect(mockImagesGenerate).toHaveBeenCalled();
      const payload = mockImagesGenerate.mock.calls[0][0];
      expect(payload.prompt).toBe("A cute cat");
      expect(result?.imageData).toBe("generated-image-base64");
    });

    it("edits an image when input images are provided", async () => {
      const result = await openaiProvider.generateImage(
        "Add a party hat",
        ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"],
      );

      expect(mockImagesEdit).toHaveBeenCalled();
      expect(result?.imageData).toBe("edited-image-base64");
    });

    it("handles custom object format for editing images", async () => {
      const result = await openaiProvider.generateImage(
        "Add a party hat",
        [{ imageData: "iVBORw0KGgoAAAANSUhEUgAAAAUA", mimeType: "image/png" }],
      );
      expect(result?.imageData).toBe("edited-image-base64");
    });

    it("throws error on invalid image string format", async () => {
      await expect(
        openaiProvider.generateImage("edit", ["not-a-data-url"])
      ).rejects.toThrow("Invalid image data format");
    });

    it("throws error on invalid image object structure", async () => {
      await expect(
        openaiProvider.generateImage("edit", [{ invalid: true } as any])
      ).rejects.toThrow("Invalid image data format");
    });

    it("throws error when no image data is received from OpenAI", async () => {
      mockImagesGenerate.mockImplementationOnce(() => ({
        data: [],
      }));

      await expect(
        openaiProvider.generateImage("A cute cat")
      ).rejects.toThrow("No image data received from OpenAI");
    });
  });

  describe("captionImage", () => {
    it("calls chat.completions with image url contents", async () => {
      const result = await openaiProvider.captionImage(
        ["http://example.com/img.jpg"],
        "What is in this picture?",
      );

      expect(mockChatCreate).toHaveBeenCalled();
      const payload = mockChatCreate.mock.calls[0][0];
      expect(payload.messages[0].content).toHaveLength(2);
      expect(result?.text).toBe("OpenAI Chat completions response");
    });

    it("includes system instruction when systemPrompt is passed", async () => {
      const result = await openaiProvider.captionImage(
        ["http://example.com/img.jpg"],
        "Describe",
        "gpt-5.5",
        "A system prompt"
      );
      expect(mockChatCreate).toHaveBeenCalled();
      const payload = mockChatCreate.mock.calls[0][0];
      expect(payload.messages[0]).toEqual({ role: MESSAGE_ROLES.SYSTEM, content: "A system prompt" });
    });
  });

  describe("generateEmbedding", () => {
    it("calls embeddings create and returns vectors", async () => {
      const result = await openaiProvider.generateEmbedding("Embedding content");

      expect(mockEmbeddingsCreate).toHaveBeenCalled();
      expect(result?.embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("transcribeAudio", () => {
    it("calls transcription create with audio buffer file", async () => {
      const result = await openaiProvider.transcribeAudio(
        Buffer.from("fake-audio"),
        "audio/wav",
        "whisper-1",
        { language: "en", prompt: "Transcribe it" },
      );

      expect(mockTranscriptionsCreate).toHaveBeenCalled();
      expect(result?.text).toBe("transcribed audio text");
      expect(result?.usage).toEqual({
        inputTokens: 50,
        outputTokens: 25,
      });
    });

    it("parses transcription usage type duration", async () => {
      mockTranscriptionsCreate.mockImplementationOnce(() => ({
        text: "duration transcription",
        usage: {
          type: "duration",
          seconds: 120,
        },
      }));

      const result = await openaiProvider.transcribeAudio(
        Buffer.from("fake-audio"),
        "audio/wav",
        "whisper-1",
      );

      expect(result?.usage).toEqual({
        durationSeconds: 120,
      });
    });
  });

  describe("Error Pathways & abort handling", () => {
    it("throws ProviderError on generateText failure", async () => {
      mockChatCreate.mockImplementationOnce(() => {
        const error = new Error("API Connection Error");
        (error as any).status = 502;
        throw error;
      });

      await expect(
        openaiProvider.generateText([{ role: MESSAGE_ROLES.USER, content: "Hello" }], "gpt-4o")
      ).rejects.toThrow("API Connection Error");
    });

    it("throws ProviderError on generateSpeech failure", async () => {
      mockSpeechCreate.mockImplementationOnce(() => {
        throw new Error("Speech generation failed");
      });

      await expect(
        openaiProvider.generateSpeech("Hello", "alloy")
      ).rejects.toThrow("Speech generation failed");
    });

    it("throws ProviderError on generateImage failure", async () => {
      mockImagesGenerate.mockImplementationOnce(() => {
        throw new Error("DALL-E error");
      });

      await expect(
        openaiProvider.generateImage("Cat")
      ).rejects.toThrow("DALL-E error");
    });

    it("throws ProviderError on captionImage failure", async () => {
      mockChatCreate.mockImplementationOnce(() => {
        throw new Error("Captioning failed");
      });

      await expect(
        openaiProvider.captionImage(["http://example.com/img.jpg"])
      ).rejects.toThrow("Captioning failed");
    });

    it("throws ProviderError on generateEmbedding failure", async () => {
      mockEmbeddingsCreate.mockImplementationOnce(() => {
        throw new Error("Embedding failed");
      });

      await expect(
        openaiProvider.generateEmbedding("Text")
      ).rejects.toThrow("Embedding failed");
    });

    it("throws ProviderError on transcribeAudio failure", async () => {
      mockTranscriptionsCreate.mockImplementationOnce(() => {
        throw new Error("Whisper failed");
      });

      await expect(
        openaiProvider.transcribeAudio(Buffer.from(""), "audio/wav")
      ).rejects.toThrow("Whisper failed");
    });

    it("handles chat completion stream retry on 400 status error", async () => {
      const mockCompletionsError = new Error("Unsupported parameter: 'temperature'");
      (mockCompletionsError as any).status = 400;

      mockChatCreate.mockImplementationOnce(() => {
        throw mockCompletionsError;
      });

      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Retry stream" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o", {
        temperature: 0.8,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(mockChatCreate).toHaveBeenCalledTimes(2);
      expect(chunks).toContain("Hello");
    });

    it("handles aborted signal in generateTextStream chat completions", async () => {
      const controller = new AbortController();
      controller.abort();

      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "Abort stream" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o", {
        signal: controller.signal,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });

    it("propagates 400 error in generateTextStream if parameter stripping does not match any unsupported parameters", async () => {
      const badRequestError = new Error("Invalid request parameter structure");
      (badRequestError as any).status = 400;
      mockChatCreate.mockImplementationOnce(() => {
        throw badRequestError;
      });

      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "stream error trigger" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o");

      await expect(async () => {
        for await (const chunk of stream) {
          // pull
        }
      }).rejects.toThrow("Invalid request parameter structure");
    });

    it("yields stopReason stopReason: 'length' when finish_reason is length", async () => {
      const asyncGenerator = async function* () {
        yield {
          choices: [
            {
              delta: { content: "truncated response" },
              finish_reason: "length",
            },
          ],
        };
      };

      const mockStream = {
        [Symbol.asyncIterator]: () => asyncGenerator(),
      };

      mockChatCreate.mockReturnValueOnce({
        ...mockStream,
        withResponse: async () => ({
          data: mockStream,
          response: {
            headers: {
              get: () => null,
            },
          },
        }),
      });

      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "stream length stop" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o");

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContain("truncated response");
      expect(chunks).toContainEqual({ type: "stopReason", stopReason: "length" });
    });

    it("yields default zero usage block if stream terminates without usage info", async () => {
      const asyncGenerator = async function* () {
        yield {
          choices: [{ delta: { content: "some text" } }],
        };
      };

      const mockStream = {
        [Symbol.asyncIterator]: () => asyncGenerator(),
      };

      mockChatCreate.mockReturnValueOnce({
        ...mockStream,
        withResponse: async () => ({
          data: mockStream,
          response: {
            headers: {
              get: () => null,
            },
          },
        }),
      });

      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "stream no usage" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o");

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toContain("some text");
      expect(chunks).toContainEqual({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } });
    });

    it("submits and formats custom tools in generateTextStream options", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "stream tools test" }];
      const tools = [
        {
          name: "get_weather",
          description: "Get weather details",
          parameters: { type: "object", properties: {} },
        },
      ];

      const stream = openaiProvider.generateTextStream(messages, "gpt-4o", {
        tools,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(mockChatCreate).toHaveBeenCalled();
      const payload = mockChatCreate.mock.calls[0][0];
      expect(payload.tools).toBeDefined();
      expect(payload.tools).toHaveLength(1);
      expect(payload.tools[0].function.name).toBe("get_weather");
    });

    it("sets response_format and web_search tool in generateTextStream payload when options are specified", async () => {
      const messages: OpenAIMessage[] = [{ role: MESSAGE_ROLES.USER, content: "stream options test" }];
      const stream = openaiProvider.generateTextStream(messages, "gpt-4o", {
        responseFormat: "json_object",
        webSearch: true,
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(mockChatCreate).toHaveBeenCalled();
      const payload = mockChatCreate.mock.calls[0][0];
      expect(payload.response_format).toEqual({ type: "json_object" });
      expect(payload.tools).toContainEqual({ type: "web_search" });
    });
  });

  describe("prepareOpenAIMessages multimodal inputs", () => {
    it("converts multimodal message structures properly", async () => {
      const messages: OpenAIMessage[] = [
        {
          role: MESSAGE_ROLES.USER,
          content: "Multimodal user",
          images: [
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
            "data:application/pdf;base64,JVBERi0xLjQK",
            "data:text/plain;base64,SGVsbG8=",
            "data:application/zip;base64,UEsDBB",
            "http://example.com/image.png",
            "http://example.com/file.zip",
            "minio://bucket/image.png",
          ],
        },
      ];

      await openaiProvider.generateText(messages, "gpt-4o");

      expect(mockChatCreate).toHaveBeenCalled();
      const payload = mockChatCreate.mock.calls[0][0];
      const userMessage = payload.messages[0];
      expect(userMessage.role).toBe(MESSAGE_ROLES.USER);
      // 6 valid parts + 1 unresolved-ref placeholder + 1 content text
      expect(userMessage.content).toHaveLength(8);
      // Unresolved minio:// refs surface as visible placeholders, never silent drops
      const placeholder = userMessage.content.find(
        (part: { type: string; text?: string }) =>
          part.type === "text" && part.text?.includes("unresolved reference"),
      );
      expect(placeholder?.text).toContain("minio://bucket/image.png");
    });
  });
});


/**
 * Tests for telemetry / message separation.
 *
 * Asserts that persisted conversation messages contain ONLY semantic content
 * (role, content, thinking, toolCalls, images, audio) plus a `requestId`
 * foreign key linking to the `requests` collection for telemetry data.
 *
 * Telemetry fields (usage, estimatedCost, totalTime, tokensPerSec, model,
 * provider, generationSettings) must NOT appear on persisted messages.
 */

import { describe, it, expect } from "vitest";
import {
  assembleMessagesToAppend as assembleMessagesToAppendReal,
  sanitizeMessagesForPersistence,
} from "../lifecycle/Finalizer.ts";
import { PROVIDERS } from "../../../constants.ts";
import type { MessagePayload, ToolCallPayload } from "../../conversation/types.ts";
import type { ConversationMessage } from "../types.ts";

// ── Telemetry fields that must NEVER appear on persisted messages ────
const TELEMETRY_FIELDS = [
  "usage",
  "estimatedCost",
  "totalTime",
  "tokensPerSec",
  "generationSettings",
  "model",
  "provider",
] as const;

type TestPayload = ConversationMessage & { rawContent?: string };
type FinalizerInput = Parameters<typeof assembleMessagesToAppendReal>[0];

type TestAssemblyInput = Omit<
  FinalizerInput,
  "text" | "thinking" | "audioReference" | "overrideMessagesToAppend" | "toolCalls"
> & {
  overrideMessagesToAppend?: TestPayload[];
  finalText: string;
  finalThinking: string;
  audioRef: string | null;
  toolCalls: ToolCallPayload[];
  requestId?: string;
};

/**
 * Convenience wrapper: maps test-friendly names → production parameter names,
 * then runs the full pipeline (assemble + sanitize).
 */
function assembleAndSanitize(input: TestAssemblyInput): MessagePayload[] {
  const messages = assembleMessagesToAppendReal({
    ...input,
    text: input.finalText,
    thinking: input.finalThinking,
    audioReference: input.audioRef,
  });

  return sanitizeMessagesForPersistence(messages);
}

/**
 * Assert that no telemetry fields exist on any message in the array.
 */
function assertNoTelemetry(messages: MessagePayload[]) {
  for (const message of messages) {
    for (const field of TELEMETRY_FIELDS) {
      expect(
        (message as Record<string, unknown>)[field],
        `Message with role="${message.role}" should NOT have "${field}" — ` +
          `telemetry belongs in the requests collection`,
      ).toBeUndefined();
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Test Suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Telemetry / Message Separation", () => {
  // ────────────────────────────────────────────────────────────
  // 1. No telemetry on persisted messages (agentic flow)
  // ────────────────────────────────────────────────────────────
  describe("No telemetry fields on persisted messages", () => {
    it("should NOT include telemetry on agentic messages with tool calls", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "search for events" },
          {
            role: "assistant",
            content: "",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_1",
                name: "search_events",
                args: { query: "concerts" },
                result: '{"events": []}',
                durationMilliseconds: 500,
              },
            ],
          },
        ],
        finalText: "I found some events!",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gpt-4.1",
        providerName: PROVIDERS.OPENAI,
        requestId: "req-iter-1",
        usage: { inputTokens: 100, outputTokens: 50 },
        estimatedCost: 0.005,
        totalSeconds: 2.5,
        tokensPerSecond: 20,
        temperature: 0.7,
        maxTokens: 4096,
      });

      assertNoTelemetry(result);
    });

    it("should NOT include telemetry on single-shot (non-agentic) messages", () => {
      const result = assembleAndSanitize({
        finalText: "Hello! How can I help?",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gemini-2.5-flash",
        providerName: PROVIDERS.GOOGLE,
        requestId: "req-single",
        usage: { inputTokens: 50, outputTokens: 30 },
        estimatedCost: 0.001,
        totalSeconds: 1.2,
        tokensPerSecond: 25,
        temperature: 1.0,
        maxTokens: 8192,
      });

      assertNoTelemetry(result);
    });

    it("should NOT include telemetry on multi-iteration agentic flow", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "draw me and say something" },
          {
            role: "assistant",
            content: "Let me draw you!",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_img",
                name: "generate_image",
                args: { prompt: "wolf warrior" },
                result: '{"url": "https://cdn/img.png"}',
                durationMilliseconds: 15000,
              },
            ],
          },
          {
            role: "assistant",
            content: "",
            requestId: "req-iter-1",
            toolCalls: [
              {
                id: "call_tts",
                name: "synthesize_speech",
                args: { text: "Rise warrior!" },
                result: '{"url": "https://cdn/speech.wav"}',
                durationMilliseconds: 4000,
              },
            ],
          },
        ],
        finalText: "There you go!",
        finalThinking: "",
        images: ["https://cdn/img.png"],
        audioRef: "https://cdn/speech.wav",
        toolCalls: [],
        resolvedModel: "gemini-2.5-flash",
        providerName: PROVIDERS.GOOGLE,
        requestId: "req-iter-2",
        usage: { inputTokens: 200, outputTokens: 80 },
        estimatedCost: 0.012,
        totalSeconds: 3.5,
        tokensPerSecond: 22.8,
      });

      assertNoTelemetry(result);
    });
  });

  // ────────────────────────────────────────────────────────────
  // 2. requestId on assistant and tool messages
  // ────────────────────────────────────────────────────────────
  describe("requestId as foreign key", () => {
    it("should stamp requestId on the final assistant message", () => {
      const result = assembleAndSanitize({
        finalText: "Hello!",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gpt-4.1",
        providerName: PROVIDERS.OPENAI,
        requestId: "req-single-shot",
      });

      const assistantMessage = result.find(
        (message) => message.role === "assistant",
      );
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage!.requestId).toBe("req-single-shot");
    });

    it("should preserve requestId on intermediate assistant messages", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "search" },
          {
            role: "assistant",
            content: "",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_1",
                name: "search_web",
                args: {},
                result: "results",
                durationMilliseconds: 300,
              },
            ],
          },
        ],
        finalText: "Found it!",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gpt-4.1",
        providerName: PROVIDERS.OPENAI,
        requestId: "req-iter-1",
      });

      const assistantMessages = result.filter(
        (message) => message.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(2);
      expect(assistantMessages[0].requestId).toBe("req-iter-0");
      expect(assistantMessages[1].requestId).toBe("req-iter-1");
    });

    it("should propagate requestId from parent assistant to generated tool messages", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "get weather" },
          {
            role: "assistant",
            content: "",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_w1",
                name: "get_weather",
                args: { city: "Tokyo" },
                result: '{"temp": "22°C"}',
                durationMilliseconds: 450,
              },
              {
                id: "call_w2",
                name: "get_weather",
                args: { city: "Vancouver" },
                result: '{"temp": "15°C"}',
                durationMilliseconds: 380,
              },
            ],
          },
        ],
        finalText: "Tokyo is 22°C, Vancouver is 15°C",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gpt-4.1",
        providerName: PROVIDERS.OPENAI,
        requestId: "req-iter-1",
      });

      const toolMessages = result.filter((message) => message.role === "tool");
      expect(toolMessages).toHaveLength(2);
      // Both tool messages should inherit requestId from their parent assistant
      expect(toolMessages[0].requestId).toBe("req-iter-0");
      expect(toolMessages[1].requestId).toBe("req-iter-0");
    });

    it("should NOT stamp requestId on user or system messages", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "hello" },
        ],
        finalText: "Hi!",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gpt-4.1",
        providerName: PROVIDERS.OPENAI,
        requestId: "req-0",
      });

      const systemMessage = result.find(
        (message) => message.role === "system",
      );
      const userMessage = result.find((message) => message.role === "user");
      expect(systemMessage?.requestId).toBeUndefined();
      expect(userMessage?.requestId).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────
  // 3. Empty final text → no empty assistant stub
  // ────────────────────────────────────────────────────────────
  describe("Empty final text handling", () => {
    it("should NOT push an empty assistant stub when final text is empty in agentic flow", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "make a song" },
          {
            role: "assistant",
            content: "Creating your song now!",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_audio",
                name: "generate_audio",
                args: { title: "Epic Song" },
                result: '{"url": "https://cdn/song.wav"}',
                durationMilliseconds: 20000,
              },
            ],
          },
        ],
        finalText: "",
        finalThinking: "",
        images: [],
        audioRef: "https://cdn/song.wav",
        toolCalls: [],
        resolvedModel: "gemini-3.5-flash",
        providerName: PROVIDERS.GOOGLE,
        requestId: "req-iter-1",
      });

      // Should NOT have any empty content assistant messages
      const assistantMessages = result.filter(
        (message) => message.role === "assistant",
      );
      for (const assistantMessage of assistantMessages) {
        const hasContent = assistantMessage.content?.toString().trim();
        const hasToolCalls =
          assistantMessage.toolCalls && assistantMessage.toolCalls.length > 0;
        expect(
          hasContent || hasToolCalls,
          "Every assistant message must have either content or toolCalls — no empty stubs",
        ).toBeTruthy();
      }

      // No consecutive assistant messages
      for (let index = 1; index < result.length; index++) {
        if (result[index].role === "assistant" && result[index - 1].role === "assistant") {
          throw new Error(
            `Consecutive assistant messages at index ${index - 1} and ${index} — ` +
              `this violates the alternating-role protocol`,
          );
        }
      }
    });

    it("should merge audio/images into the last assistant when final text is empty", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "make me a song" },
          {
            role: "assistant",
            content: "On it!",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_1",
                name: "generate_audio",
                args: {},
                result: '{"url": "audio.wav"}',
              },
            ],
          },
        ],
        finalText: "",
        finalThinking: "",
        images: [],
        audioRef: "audio.wav",
        toolCalls: [],
        resolvedModel: "gemini-3.5-flash",
        providerName: PROVIDERS.GOOGLE,
        requestId: "req-iter-1",
      });

      // The audio should be merged into the last assistant message
      const assistantMessages = result.filter(
        (message) => message.role === "assistant",
      );
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      expect(lastAssistant.audio).toBe("audio.wav");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 4. Semantic content preservation
  // ────────────────────────────────────────────────────────────
  describe("Semantic content preservation", () => {
    it("should preserve all semantic fields on messages", () => {
      const result = assembleAndSanitize({
        overrideMessagesToAppend: [
          { role: "user", content: "draw me as a wolf" },
          {
            role: "assistant",
            content: "I'll draw you!",
            thinking: "The user wants a wolf warrior drawing.",
            thinkingSignature: "sig_1",
            requestId: "req-iter-0",
            toolCalls: [
              {
                id: "call_img",
                name: "generate_image",
                args: { prompt: "wolf warrior" },
                result: '{"url": "wolf.png"}',
                durationMilliseconds: 10000,
              },
            ],
          },
        ],
        finalText: "Here's your wolf warrior!",
        finalThinking: "Wrapping up with the final message.",
        images: ["wolf.png"],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gemini-2.5-flash",
        providerName: PROVIDERS.GOOGLE,
        requestId: "req-iter-1",
      });

      // Intermediate assistant: thinking, thinkingSignature, toolCalls preserved
      const firstAssistant = result.find(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls &&
          message.toolCalls.length > 0,
      );
      expect(firstAssistant).toBeDefined();
      expect(firstAssistant!.thinking).toBe(
        "The user wants a wolf warrior drawing.",
      );
      expect(firstAssistant!.thinkingSignature).toBe("sig_1");
      expect(firstAssistant!.toolCalls![0].name).toBe("generate_image");

      // Tool message preserved
      const toolMessage = result.find((message) => message.role === "tool");
      expect(toolMessage).toBeDefined();
      expect(toolMessage!.content).toContain("wolf.png");

      // Final assistant: content, images preserved
      const finalAssistant = result[result.length - 1];
      expect(finalAssistant.role).toBe("assistant");
      expect(finalAssistant.content).toBe("Here's your wolf warrior!");
      expect(finalAssistant.images).toEqual(["wolf.png"]);
    });

    it("should preserve timestamp on messages", () => {
      const result = assembleAndSanitize({
        finalText: "Hello!",
        finalThinking: "",
        images: [],
        audioRef: null,
        toolCalls: [],
        resolvedModel: "gpt-4.1",
        providerName: PROVIDERS.OPENAI,
        requestId: "req-0",
      });

      const assistantMessage = result.find(
        (message) => message.role === "assistant",
      );
      expect(assistantMessage?.timestamp).toBeDefined();
      expect(typeof assistantMessage!.timestamp).toBe("string");
    });
  });
});

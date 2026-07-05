import { describe, it, expect } from "vitest";
import { prepareDisplayMessages } from "../conversation/prepareDisplayMessages.ts";
import type { ChatMessage } from "../../types/admin.ts";

describe("prepareDisplayMessages", () => {
  it("returns empty array for null/undefined/empty input", () => {
    expect(prepareDisplayMessages([])).toEqual([]);
    expect(prepareDisplayMessages(null as unknown as ChatMessage[])).toEqual([]);
    expect(prepareDisplayMessages(undefined as unknown as ChatMessage[])).toEqual([]);
  });

  it("passes through user and assistant messages without tool calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("merges tool results into assistant toolCalls by tool_call_id", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_123", name: "get_weather", args: { city: "Tokyo" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: '{"temp": 25, "unit": "celsius"}',
      },
      { role: "assistant", content: "It's 25°C in Tokyo." },
    ];

    const result = prepareDisplayMessages(messages);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    // Tool-role messages should be filtered out
    expect(result.every((message) => message.role !== "tool")).toBe(true);
    // Tool result should be merged into the assistant's toolCall
    const assistantWithTools = result[1];
    expect(assistantWithTools.toolCalls?.[0].result).toBe(
      '{"temp": 25, "unit": "celsius"}',
    );
    expect(result[2].content).toBe("It's 25°C in Tokyo.");
  });

  it("merges durations from tool-role messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_abc", name: "search", args: { query: "test" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_abc",
        content: "results here",
        durationMilliseconds: 1250,
      } as ChatMessage,
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
    expect(
      (result[0].toolCalls?.[0] as unknown as Record<string, unknown>)
        ?.durationMilliseconds,
    ).toBe(1250);
  });

  it("handles multiple tool calls per assistant message", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "tool_a", args: {} },
          { id: "call_2", name: "tool_b", args: {} },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result_a" },
      { role: "tool", tool_call_id: "call_2", content: "result_b" },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].toolCalls?.[0].result).toBe("result_a");
    expect(result[0].toolCalls?.[1].result).toBe("result_b");
  });

  it("filters out empty assistant stubs with no content or tools", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "  " },
      { role: "assistant", content: null },
      { role: "assistant", content: "Real response" },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Hello");
    expect(result[1].content).toBe("Real response");
  });

  it("preserves assistant messages with only thinking content", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        thinking: "Let me think about this...",
      },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].thinking).toBe("Let me think about this...");
  });

  it("preserves assistant messages with only images", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", images: ["data:image/png;base64,abc"] },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
  });

  it("preserves assistant messages with only audio", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", audio: "data:audio/wav;base64,xyz" },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
  });

  it("preserves assistant messages with error field", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", error: "Rate limit exceeded" } as ChatMessage,
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
  });

  it("passes through system messages unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
  });

  it("preserves soft-deleted messages with their deleted flag", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello", deleted: true },
      { role: "assistant", content: "Hi", deleted: true },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].deleted).toBe(true);
    expect(result[1].deleted).toBe(true);
  });

  it("handles orphan tool results gracefully (no matching assistant tool call)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Do something" },
      {
        role: "tool",
        tool_call_id: "orphan_id",
        content: "orphaned result",
      },
      { role: "assistant", content: "Done." },
    ];

    const result = prepareDisplayMessages(messages);
    // Orphan tool message is filtered; user and assistant remain
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("does not overwrite existing tool call results", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_pre",
            name: "tool_x",
            args: {},
            result: "pre-existing result",
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_pre",
        content: "should not replace",
      },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result[0].toolCalls?.[0].result).toBe("pre-existing result");
  });

  it("extracts audio references from tool call results (audioRef)", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_audio", name: "tts", args: {} },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_audio",
        content: JSON.stringify({ audioRef: "minio://audio/file.wav" }),
      },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].audio).toEqual(["minio://audio/file.wav"]);
  });

  it("extracts inline base64 audio from tool call results", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_b64", name: "tts", args: {} },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_b64",
        content: JSON.stringify({
          audio: { data: "AAAA", mimeType: "audio/mp3" },
        }),
      },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result[0].audio).toEqual(["data:audio/mp3;base64,AAAA"]);
  });

  it("does not duplicate existing audio when merging tool audio", () => {
    const existingAudioRef = "minio://existing.wav";
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        audio: existingAudioRef,
        toolCalls: [
          { id: "call_dup", name: "tts", args: {} },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_dup",
        content: JSON.stringify({ audioRef: existingAudioRef }),
      },
    ];

    const result = prepareDisplayMessages(messages);
    // Should not duplicate the existing audio ref
    expect(result[0].audio).toEqual([existingAudioRef]);
  });

  it("handles non-JSON tool result strings without crashing", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_plain", name: "echo", args: {} },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_plain",
        content: "plain text result, not JSON",
      },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].toolCalls?.[0].result).toBe(
      "plain text result, not JSON",
    );
    // Audio should not be set from non-JSON content
    expect(result[0].audio).toBeUndefined();
  });

  it("handles tool calls with null/missing id gracefully", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: null, name: "mystery_tool", args: {} },
        ],
      },
      { role: "tool", tool_call_id: "some_id", content: "won't match" },
    ];

    const result = prepareDisplayMessages(messages);
    expect(result).toHaveLength(1);
    // Result should be null since the id didn't match
    expect(result[0].toolCalls?.[0].result).toBeNull();
  });
});

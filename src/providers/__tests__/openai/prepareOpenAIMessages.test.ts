/**
 * Unit tests for the OpenAI `prepareOpenAIMessages` function.
 *
 * Validates Chat Completions message formatting for all 4 role types:
 * system, user, assistant (with/without toolCalls), and tool.
 */
import { describe, it, expect } from "vitest";

import {
  prepareOpenAIMessages,
  type OpenAIMessage,
} from "#src/providers/openai";

// ── Helpers ──────────────────────────────────────────────────
function makeMessage(overrides: Partial<OpenAIMessage>): OpenAIMessage {
  return { role: "user", content: "hello" as string, ...overrides };
}

// ── System Role ──────────────────────────────────────────────
describe("prepareOpenAIMessages — system role", () => {
  it("passes through system messages with role and content", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "system", content: "You are helpful." }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "You are helpful.",
    });
  });

  it("defaults null system content to empty string", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "system", content: undefined }),
    ]);

    expect(result[0]).toMatchObject({ role: "system", content: "" });
  });

  it("preserves name field on system messages when present", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "system", content: "Context", name: "background" }),
    ]);

    expect(result[0]).toHaveProperty("name", "background");
  });

  it("omits name field when not present", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "system", content: "No name" }),
    ]);

    expect(result[0]).not.toHaveProperty("name");
  });
});

// ── Developer Role ───────────────────────────────────────────
describe("prepareOpenAIMessages — developer role", () => {
  it("passes through developer messages", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "developer", content: "System instruction" }),
    ]);

    expect(result[0]).toMatchObject({
      role: "developer",
      content: "System instruction",
    });
  });
});

// ── User Role ────────────────────────────────────────────────
describe("prepareOpenAIMessages — user role", () => {
  it("passes through plain user messages", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "user", content: "Hello there" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      content: "Hello there",
    });
  });

  it("defaults null user content to empty string", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "user", content: undefined }),
    ]);

    expect(result[0]).toMatchObject({ role: "user", content: "" });
  });

  it("creates multimodal content array for user messages with images", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "user",
        content: "What is this?",
        images: ["data:image/png;base64,iVBORtest123"],
      }),
    ]);

    expect(result[0].role).toBe("user");
    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(Array.isArray(content)).toBe(true);
    // Should have image_url block + text block
    const imageBlock = content.find(
      (block) => block.type === "image_url",
    );
    const textBlock = content.find((block) => block.type === "text");
    expect(imageBlock).toBeDefined();
    expect(textBlock).toBeDefined();
  });

  it("handles PDF data URLs as file attachments", () => {
    const pdfDataUrl = "data:application/pdf;base64,JVBERtest";
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "user",
        content: "Summarize this",
        images: [pdfDataUrl],
      }),
    ]);

    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(Array.isArray(content)).toBe(true);
    const fileBlock = content.find((block) => block.type === "file");
    expect(fileBlock).toBeDefined();
  });

  it("decodes text file data URLs inline", () => {
    const textContent = Buffer.from("Hello world").toString("base64");
    const textDataUrl = `data:text/plain;base64,${textContent}`;
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "user",
        content: "Read this file",
        images: [textDataUrl],
      }),
    ]);

    const content = (result[0] as { content: Array<{ type: string; text?: string }> }).content;
    const textBlock = content.find(
      (block) => block.type === "text" && block.text?.includes("Hello world"),
    );
    expect(textBlock).toBeDefined();
  });

  it("handles HTTP image URLs", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "user",
        content: "Describe",
        images: ["https://example.com/photo.jpg"],
      }),
    ]);

    const content = (result[0] as { content: Array<{ type: string }> }).content;
    expect(Array.isArray(content)).toBe(true);
    const imageBlock = content.find(
      (block) => block.type === "image_url",
    );
    expect(imageBlock).toBeDefined();
  });
});

// ── Assistant Role (Without Tool Calls) ──────────────────────
describe("prepareOpenAIMessages — assistant role without toolCalls", () => {
  it("passes through plain assistant messages", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "assistant", content: "Hi there!" }),
    ]);

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: "Hi there!",
    });
  });

  it("defaults null assistant content to empty string", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "assistant", content: undefined }),
    ]);

    expect(result[0]).toMatchObject({ role: "assistant", content: "" });
  });

  it("preserves name field on assistant messages", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "assistant", content: "Response", name: "helper" }),
    ]);

    expect(result[0]).toHaveProperty("name", "helper");
  });
});

// ── Assistant Role (With Tool Calls) ─────────────────────────
describe("prepareOpenAIMessages — assistant role with toolCalls", () => {
  it("formats tool calls in OpenAI function calling format", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "assistant",
        content: "Let me check",
        toolCalls: [
          { id: "call_abc", name: "get_weather", args: { city: "London" } },
        ],
      }),
    ]);

    const assistantMessage = result[0] as {
      role: string;
      content: string | null;
      tool_calls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    expect(assistantMessage.role).toBe("assistant");
    expect(assistantMessage.content).toBe("Let me check");
    expect(assistantMessage.tool_calls).toHaveLength(1);
    expect(assistantMessage.tool_calls[0]).toMatchObject({
      id: "call_abc",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"city":"London"}',
      },
    });
  });

  it("sets content to null when assistant text is empty with tool calls", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "search", args: {} }],
      }),
    ]);

    const assistantMessage = result[0] as { content: string | null };
    expect(assistantMessage.content).toBeNull();
  });

  it("generates fallback IDs when tool call IDs are missing", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          { name: "tool_a", args: {} },
          { name: "tool_b", args: {} },
        ],
      }),
    ]);

    const assistantMessage = result[0] as {
      tool_calls: Array<{ id: string }>;
    };
    expect(assistantMessage.tool_calls[0].id).toBe("call_0");
    expect(assistantMessage.tool_calls[1].id).toBe("call_1");
  });

  it("serializes object args to JSON string", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          { id: "call_1", name: "search", args: { query: "test", limit: 10 } },
        ],
      }),
    ]);

    const assistantMessage = result[0] as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    const parsedArguments = JSON.parse(assistantMessage.tool_calls[0].function.arguments);
    expect(parsedArguments).toEqual({ query: "test", limit: 10 });
  });

  it("passes through string args without re-serialization", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          {
            id: "call_1",
            name: "search",
            args: '{"already":"serialized"}' as unknown as Record<string, unknown>,
          },
        ],
      }),
    ]);

    const assistantMessage = result[0] as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    expect(assistantMessage.tool_calls[0].function.arguments).toBe(
      '{"already":"serialized"}',
    );
  });
});

// ── Tool Role ────────────────────────────────────────────────
describe("prepareOpenAIMessages — tool role", () => {
  it("formats tool result messages with tool_call_id", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "tool",
        tool_call_id: "call_abc",
        content: '{"temperature": 72}',
      } as unknown as Partial<OpenAIMessage>),
    ]);

    expect(result[0]).toMatchObject({
      role: "tool",
      tool_call_id: "call_abc",
      content: '{"temperature": 72}',
    });
  });

  it("falls back to id field when tool_call_id is missing", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "tool",
        id: "fallback_id" as string,
        content: "result",
      } as unknown as Partial<OpenAIMessage>),
    ]);

    expect((result[0] as { tool_call_id: string }).tool_call_id).toBe(
      "fallback_id",
    );
  });

  it("serializes non-string tool content to JSON", () => {
    const result = prepareOpenAIMessages([
      makeMessage({
        role: "tool",
        tool_call_id: "call_1",
        content: undefined,
      } as unknown as Partial<OpenAIMessage>),
    ]);

    expect((result[0] as { content: string }).content).toBe('""');
  });
});

// ── Full Conversation Flow ───────────────────────────────────
describe("prepareOpenAIMessages — full conversation flow", () => {
  it("handles a multi-turn conversation with all role types", () => {
    const result = prepareOpenAIMessages([
      makeMessage({ role: "system", content: "You are helpful." }),
      makeMessage({ role: "user", content: "What's the weather?" }),
      makeMessage({
        role: "assistant",
        content: "Let me check.",
        toolCalls: [
          { id: "call_1", name: "get_weather", args: { city: "NYC" } },
        ],
      }),
      makeMessage({
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temp": 75}',
      } as unknown as Partial<OpenAIMessage>),
      makeMessage({
        role: "assistant",
        content: "It's 75°F in NYC.",
      }),
    ]);

    expect(result).toHaveLength(5);
    expect(result.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});

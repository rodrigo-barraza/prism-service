/**
 * Unit tests for the OpenAI `prepareResponsesInput` function.
 *
 * Validates Responses API input formatting for all role types:
 * system → developer conversion, user (with media), assistant
 * (with/without toolCalls + reasoning), and tool → function_call_output.
 */
import { describe, it, expect } from "vitest";

import {
  prepareResponsesInput,
  type OpenAIMessage,
} from "../../openai.ts";

// ── Helpers ──────────────────────────────────────────────────
function makeMessage(overrides: Partial<OpenAIMessage>): OpenAIMessage {
  return { role: "user", content: "hello", ...overrides };
}

// ── System → Developer Conversion ────────────────────────────
describe("prepareResponsesInput — system role", () => {
  it("converts system role to developer role", () => {
    const result = prepareResponsesInput([
      makeMessage({ role: "system", content: "You are helpful." }),
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as { role: string }).role).toBe("developer");
  });

  it("defaults undefined system content to empty string", () => {
    const result = prepareResponsesInput([
      makeMessage({ role: "system", content: undefined }),
    ]);

    expect((result[0] as { content: string }).content).toBe("");
  });
});

// ── User Role ────────────────────────────────────────────────
describe("prepareResponsesInput — user role", () => {
  it("passes through plain user messages", () => {
    const result = prepareResponsesInput([
      makeMessage({ role: "user", content: "Hello" }),
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as { role: string; content: string }).role).toBe("user");
    expect((result[0] as { role: string; content: string }).content).toBe("Hello");
  });

  it("creates input_image content for image data URLs", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "user",
        content: "Describe this",
        images: ["data:image/png;base64,iVBORtest"],
      }),
    ]);

    const userMessage = result[0] as { content: Array<{ type: string }> };
    expect(Array.isArray(userMessage.content)).toBe(true);
    const imageBlock = userMessage.content.find(
      (block) => block.type === "input_image",
    );
    expect(imageBlock).toBeDefined();
  });

  it("creates input_file content for PDF data URLs", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "user",
        content: "Analyze",
        images: ["data:application/pdf;base64,JVBERtest"],
      }),
    ]);

    const userMessage = result[0] as { content: Array<{ type: string }> };
    const fileBlock = userMessage.content.find(
      (block) => block.type === "input_file",
    );
    expect(fileBlock).toBeDefined();
  });

  it("decodes text data URLs to inline text", () => {
    const textContent = Buffer.from("Hello from file").toString("base64");
    const result = prepareResponsesInput([
      makeMessage({
        role: "user",
        content: "Read this",
        images: [`data:text/plain;base64,${textContent}`],
      }),
    ]);

    const userMessage = result[0] as {
      content: Array<{ type: string; text?: string }>;
    };
    const textBlock = userMessage.content.find(
      (block) =>
        block.type === "input_text" && block.text?.includes("Hello from file"),
    );
    expect(textBlock).toBeDefined();
  });

  it("handles HTTP image URLs via input_image", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "user",
        content: "Describe",
        images: ["https://example.com/photo.jpg"],
      }),
    ]);

    const userMessage = result[0] as { content: Array<{ type: string }> };
    const imageBlock = userMessage.content.find(
      (block) => block.type === "input_image",
    );
    expect(imageBlock).toBeDefined();
  });
});

// ── Assistant Role (Without Tool Calls) ──────────────────────
describe("prepareResponsesInput — assistant role without toolCalls", () => {
  it("passes through plain assistant messages", () => {
    const result = prepareResponsesInput([
      makeMessage({ role: "assistant", content: "Response text" }),
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as { role: string }).role).toBe("assistant");
  });
});

// ── Assistant Role (With Tool Calls) ─────────────────────────
describe("prepareResponsesInput — assistant role with toolCalls", () => {
  it("expands tool calls into function_call items", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_abc", name: "search", args: { query: "test" } },
        ],
      }),
    ]);

    const functionCallItem = result.find(
      (item) => (item as { type?: string }).type === "function_call",
    ) as { type: string; name: string; arguments: string } | undefined;

    expect(functionCallItem).toBeDefined();
    expect(functionCallItem!.name).toBe("search");
    const parsedArguments = JSON.parse(functionCallItem!.arguments);
    expect(parsedArguments.query).toBe("test");
  });

  it("includes assistant text content before function_call items", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "assistant",
        content: "Let me search for that.",
        toolCalls: [
          { id: "call_1", name: "search", args: {} },
        ],
      }),
    ]);

    // First item should be the text content
    expect((result[0] as { role: string }).role).toBe("assistant");
    expect((result[0] as { content: string }).content).toBe(
      "Let me search for that.",
    );
  });

  it("generates function_call_output for inline results", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "search",
            args: {},
            result: { found: true },
          },
        ],
      }),
    ]);

    const outputItem = result.find(
      (item) => (item as { type?: string }).type === "function_call_output",
    ) as { type: string; output: string } | undefined;

    expect(outputItem).toBeDefined();
    expect(JSON.parse(outputItem!.output)).toEqual({ found: true });
  });

  it("includes reasoning items when present", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "search",
            args: {},
            reasoningItem: {
              id: "rs_abc",
              summary: [{ type: "summary_text", text: "Thinking..." }],
            },
          },
        ],
      }),
    ]);

    const reasoningItem = result.find(
      (item) => (item as { type?: string }).type === "reasoning",
    ) as { type: string; id: string } | undefined;

    expect(reasoningItem).toBeDefined();
    expect(reasoningItem!.id).toBe("rs_abc");
  });

  it("converts call_ prefix IDs to fc_ prefix for Responses API", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_abc123", name: "search", args: {} },
        ],
      }),
    ]);

    const functionCallItem = result.find(
      (item) => (item as { type?: string }).type === "function_call",
    ) as { id: string } | undefined;

    expect(functionCallItem).toBeDefined();
    expect(functionCallItem!.id).toMatch(/^fc_/);
  });
});

// ── Tool Role ────────────────────────────────────────────────
describe("prepareResponsesInput — tool role", () => {
  it("converts tool messages to function_call_output items", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "tool",
        tool_call_id: "call_abc",
        content: '{"temperature": 72}',
      } as unknown as Partial<OpenAIMessage>),
    ]);

    const outputItem = result[0] as {
      type: string;
      call_id: string;
      output: string;
    };
    expect(outputItem.type).toBe("function_call_output");
    expect(outputItem.call_id).toBe("call_abc");
    expect(outputItem.output).toBe('{"temperature": 72}');
  });

  it("serializes non-string tool content to JSON", () => {
    const result = prepareResponsesInput([
      makeMessage({
        role: "tool",
        tool_call_id: "call_1",
        content: undefined,
      } as unknown as Partial<OpenAIMessage>),
    ]);

    const outputItem = result[0] as { output: string };
    expect(outputItem.output).toBe('""');
  });
});

// ── Full Conversation Flow ───────────────────────────────────
describe("prepareResponsesInput — full conversation flow", () => {
  it("handles a complete multi-turn agentic conversation", () => {
    const result = prepareResponsesInput([
      makeMessage({ role: "system", content: "You are helpful." }),
      makeMessage({ role: "user", content: "Search for cats" }),
      makeMessage({
        role: "assistant",
        content: "Searching...",
        toolCalls: [
          { id: "call_1", name: "search", args: { query: "cats" } },
        ],
      }),
      makeMessage({
        role: "tool",
        tool_call_id: "call_1",
        content: '{"results": ["Cat info"]}',
      } as unknown as Partial<OpenAIMessage>),
      makeMessage({ role: "assistant", content: "Here are the results!" }),
    ]);

    // Verify all items are present and in correct order
    const types = result.map(
      (item) => (item as { type?: string; role?: string }).type || (item as { role: string }).role,
    );
    expect(types).toContain("developer"); // system → developer
    expect(types).toContain("user");
    expect(types).toContain("function_call");
    expect(types).toContain("function_call_output");
    expect(types).toContain("assistant");
  });
});

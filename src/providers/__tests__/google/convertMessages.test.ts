/**
 * Unit tests for the Google `convertMessages` function.
 *
 * Validates Gemini Content[] formatting for all 4 role types:
 * system (mid-conversation → user), user (with media), assistant
 * (→ model, with toolCalls/thoughtSignature), and tool (batched functionResponse).
 */
import { describe, it, expect } from "vitest";

import {
  convertMessages,
  type ConversationMessage,
} from "#src/providers/google";
import {
  clearDocumentContextCache,
  primeDocumentContext,
} from "#src/utils/documentContext";

// ── Helpers ──────────────────────────────────────────────────
function makeMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    role: "user",
    content: "hello",
    ...overrides,
  } as ConversationMessage;
}

// ── System Role ──────────────────────────────────────────────
describe("convertMessages — system role", () => {
  it("converts mid-conversation system messages to user role", async () => {
    const result = await convertMessages([
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "assistant", content: "Hi" }),
      makeMessage({
        role: "system",
        content: "<tool-update>New tool available</tool-update>",
      }),
    ]);

    // System message should become a user message
    const systemAsUser = result.find(
      (content) =>
        content.role === "user" &&
        content.parts?.some(
          (part) =>
            "text" in part &&
            (part as { text: string }).text.includes("tool-update"),
        ),
    );
    expect(systemAsUser).toBeDefined();
    expect(systemAsUser!.role).toBe("user");
  });

  it("skips system messages with empty content", async () => {
    const result = await convertMessages([
      makeMessage({ role: "system", content: "" }),
      makeMessage({ role: "user", content: "Hello" }),
    ]);

    // Empty system should be skipped entirely
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("skips system messages with null content", async () => {
    const result = await convertMessages([
      makeMessage({ role: "system", content: null as unknown as string }),
      makeMessage({ role: "user", content: "Hello" }),
    ]);

    expect(result).toHaveLength(1);
  });
});

// ── User Role ────────────────────────────────────────────────
describe("convertMessages — user role", () => {
  it("passes through user messages with text", async () => {
    const result = await convertMessages([
      makeMessage({ role: "user", content: "Hello there" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Hello there" })]),
    );
  });

  it("includes inline data for base64 image attachments", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "user",
        content: "What is this?",
        images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="],
      }),
    ]);

    expect(result).toHaveLength(1);
    const inlineDataPart = result[0].parts?.find(
      (part) => "inlineData" in part,
    );
    expect(inlineDataPart).toBeDefined();
    expect(
      (inlineDataPart as { inlineData: { mimeType: string } }).inlineData
        .mimeType,
    ).toBe("image/png");
  });

  it("includes inline data for base64 PDF attachments", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "user",
        content: "Summarize",
        pdf: ["data:application/pdf;base64,JVBERi0xLjQ="],
      }),
    ]);

    const inlineDataPart = result[0].parts?.find(
      (part) => "inlineData" in part,
    );
    expect(inlineDataPart).toBeDefined();
    expect(
      (inlineDataPart as { inlineData: { mimeType: string } }).inlineData
        .mimeType,
    ).toBe("application/pdf");
  });

  it("includes both text and media parts in correct order", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "user",
        content: "Describe this image",
        images: ["data:image/jpeg;base64,/9j/4AAQ=="],
      }),
    ]);

    expect(result[0].parts!.length).toBe(2);
    // Image comes first, text comes last (per implementation order)
    expect(result[0].parts![0]).toHaveProperty("inlineData");
    expect(result[0].parts![1]).toHaveProperty("text");
  });
});

// ── Assistant Role ───────────────────────────────────────────
describe("convertMessages — assistant role", () => {
  it("maps assistant role to model role", async () => {
    const result = await convertMessages([
      makeMessage({ role: "assistant", content: "Hi there!" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("model");
  });

  it("includes text parts for assistant content", async () => {
    const result = await convertMessages([
      makeMessage({ role: "assistant", content: "Here is my response." }),
    ]);

    expect(result[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Here is my response." }),
      ]),
    );
  });

  it("includes functionCall parts for tool calls", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          {
            name: "get_weather",
            args: { city: "London" },
          },
        ],
      }),
    ]);

    const functionCallPart = result[0].parts?.find(
      (part) => "functionCall" in part,
    );
    expect(functionCallPart).toBeDefined();
    expect(
      (functionCallPart as { functionCall: { name: string } }).functionCall.name,
    ).toBe("get_weather");
  });

  it("preserves thoughtSignature on functionCall parts", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          {
            name: "search",
            args: {},
            thoughtSignature: "ts_abc123",
          },
        ],
      }),
    ]);

    const functionCallPart = result[0].parts?.find(
      (part) => "functionCall" in part,
    );
    expect(functionCallPart).toBeDefined();
    expect(
      (functionCallPart as { thoughtSignature: string }).thoughtSignature,
    ).toBe("ts_abc123");
  });

  it("does not include media on assistant messages", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "assistant",
        content: "Response with image",
        images: ["data:image/png;base64,shouldBeIgnored"],
      }),
    ]);

    // Should NOT include inlineData for assistant messages
    const inlineDataPart = result[0].parts?.find(
      (part) => "inlineData" in part,
    );
    expect(inlineDataPart).toBeUndefined();
  });
});

// ── Tool Role ────────────────────────────────────────────────
describe("convertMessages — tool role", () => {
  it("converts single tool message to user message with functionResponse", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "tool",
        name: "get_weather",
        content: '{"temperature": 72}',
      } as unknown as Partial<ConversationMessage>),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const functionResponsePart = result[0].parts?.find(
      (part) => "functionResponse" in part,
    );
    expect(functionResponsePart).toBeDefined();
    expect(
      (
        functionResponsePart as {
          functionResponse: { name: string; response: { result: string } };
        }
      ).functionResponse.name,
    ).toBe("get_weather");
  });

  it("batches consecutive tool messages into a single user turn", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "tool",
        name: "search",
        content: "result 1",
      } as unknown as Partial<ConversationMessage>),
      makeMessage({
        role: "tool",
        name: "fetch",
        content: "result 2",
      } as unknown as Partial<ConversationMessage>),
    ]);

    // Both tools should be merged into one user message
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    const functionResponseParts = result[0].parts?.filter(
      (part) => "functionResponse" in part,
    );
    expect(functionResponseParts).toHaveLength(2);
  });

  it("uses 'any' as fallback name when tool name is missing", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "tool",
        content: "some result",
      } as unknown as Partial<ConversationMessage>),
    ]);

    const functionResponsePart = result[0].parts?.find(
      (part) => "functionResponse" in part,
    ) as { functionResponse: { name: string } } | undefined;

    expect(functionResponsePart!.functionResponse.name).toBe("any");
  });
});

// ── Full Conversation Flow ───────────────────────────────────
describe("convertMessages — full conversation flow", () => {
  it("handles a complete multi-turn agentic conversation", async () => {
    const result = await convertMessages([
      makeMessage({ role: "user", content: "Search for cats" }),
      makeMessage({
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          { name: "web_search", args: { query: "cats" } },
        ],
      }),
      makeMessage({
        role: "tool",
        name: "web_search",
        content: '{"results": ["Cat info"]}',
      } as unknown as Partial<ConversationMessage>),
      makeMessage({
        role: "assistant",
        content: "Here are the results about cats!",
      }),
      makeMessage({ role: "user", content: "Thanks!" }),
    ]);

    // Verify role sequence: user → model → user(tool) → model → user
    const roleSequence = result.map((content) => content.role);
    expect(roleSequence).toEqual(["user", "model", "user", "model", "user"]);
  });

  it("preserves correct parts structure across all message types", async () => {
    const result = await convertMessages([
      makeMessage({
        role: "system",
        content: "<tool-update>Context update</tool-update>",
      }),
      makeMessage({ role: "user", content: "Hello" }),
    ]);

    // System → user
    expect(result[0].role).toBe("user");
    expect(result[0].parts![0]).toHaveProperty("text");
    // User
    expect(result[1].role).toBe("user");
  });
});

// ── Inline Image Cap ─────────────────────────────────────────
describe("convertMessages — inline image cap", () => {
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("caps inline reference images at the 14-image Gemini limit", async () => {
    const result = await convertMessages([
      makeMessage({ images: Array(20).fill(pixel) } as never),
    ]);

    const imageParts = result
      .flatMap((content) => content.parts ?? [])
      .filter((part) => "inlineData" in part);
    expect(imageParts.length).toBe(14);
  });

  it("keeps all images when under the limit", async () => {
    const result = await convertMessages([
      makeMessage({ images: [pixel, pixel, pixel] } as never),
    ]);

    const imageParts = result
      .flatMap((content) => content.parts ?? [])
      .filter((part) => "inlineData" in part);
    expect(imageParts.length).toBe(3);
  });
});

// ── Document Attachments ─────────────────────────────────────
describe("convertMessages — document attachments", () => {
  it("emits reader-tool pointers for unprimed document references (previously dropped silently)", async () => {
    clearDocumentContextCache();
    const result = await convertMessages([
      makeMessage({
        documents: ["https://minio.example.com/bucket/uploads/report.xlsx"],
      } as never),
    ]);
    const texts = result
      .flatMap((content) => content.parts ?? [])
      .filter((part) => "text" in part)
      .map((part) => (part as { text: string }).text);
    const pointer = texts.find((text) => text.includes("read_spreadsheet"));
    expect(pointer).toContain(
      "https://minio.example.com/bucket/uploads/report.xlsx",
    );
  });

  it("inlines primed small text documents", async () => {
    clearDocumentContextCache();
    const reference = `data:text/plain;base64,${Buffer.from("hello doc").toString("base64")}`;
    await primeDocumentContext(reference);
    const result = await convertMessages([
      makeMessage({ documents: [reference] } as never),
    ]);
    const texts = result
      .flatMap((content) => content.parts ?? [])
      .filter((part) => "text" in part)
      .map((part) => (part as { text: string }).text);
    const inline = texts.find((text) => text.includes("Attached file"));
    expect(inline).toContain("hello doc");
  });
});

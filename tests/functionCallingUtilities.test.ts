/**
 * FunctionCallingUtilities — tests for expandMessagesForFC and truncateToolResult.
 *
 * expandMessagesForFC is called on every agentic loop iteration to convert
 * the stored message format into the OpenAI Chat Completions spec format.
 * truncateToolResult prevents massive tool outputs from blowing up context windows.
 *
 * Bugs in either function can cause silent data loss, model API errors,
 * or context window overflow.
 */
import { describe, it, expect } from "vitest";
import {
  expandMessagesForFC,
  truncateToolResult,
} from "../src/utils/FunctionCallingUtilities.ts";

// ── Types ──────────────────────────────────────────────────────
type TestMessage = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════
describe("truncateToolResult", () => {
  it("should pass through non-object values unchanged", () => {
    expect(truncateToolResult("simple string")).toBe("simple string");
    expect(truncateToolResult(42)).toBe(42);
    expect(truncateToolResult(null)).toBeNull();
    expect(truncateToolResult(undefined)).toBeUndefined();
  });

  it("should cap top-level arrays at 10 items", () => {
    const largeArray = Array.from({ length: 50 }, (_, index) => ({
      name: `item-${index}`,
    }));

    const result = truncateToolResult(largeArray) as unknown[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(11); // 10 items + 1 truncation marker
    expect(result[10]).toEqual({ _truncated: "Showing 10 of 50" });
  });

  it("should spread small arrays into numbered-key objects (object path applies)", () => {
    // Arrays with ≤10 items pass the length guard and fall through to the
    // object spread path: { ...(result as Record<string, unknown>) }
    // This converts [1, 2, 3] → { "0": 1, "1": 2, "2": 3 }
    const smallArray = [1, 2, 3, 4, 5];

    const result = truncateToolResult(smallArray) as Record<string, unknown>;

    expect(result["0"]).toBe(1);
    expect(result["4"]).toBe(5);
  });

  it("should cap known truncatable array keys at 10 items", () => {
    const result = truncateToolResult({
      events: Array.from({ length: 25 }, (_, index) => ({ id: index })),
      otherData: "preserved",
    }) as Record<string, unknown>;

    expect((result.events as unknown[]).length).toBe(10);
    expect(result._eventsTruncated).toBe("Showing 10 of 25");
    expect(result.otherData).toBe("preserved");
  });

  it("should truncate serialized JSON exceeding maxChars", () => {
    const hugeObject = {
      data: "x".repeat(20000),
    };

    const result = truncateToolResult(hugeObject, 5000) as string;

    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThanOrEqual(5002); // maxChars + "…}"
    expect(result.endsWith("…}")).toBe(true);
  });

  it("should not truncate objects within maxChars", () => {
    const smallObject = { key: "value", count: 42 };

    const result = truncateToolResult(smallObject) as Record<string, unknown>;

    expect(result).toEqual(smallObject);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("expandMessagesForFC", () => {
  it("should pass through simple user messages unchanged", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded).toHaveLength(1);
    expect(expanded[0].role).toBe("user");
    expect(expanded[0].content).toBe("Hello");
  });

  it("should expand assistant messages with toolCalls into assistant + tool messages", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "Let me check.",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            args: { path: "/etc/hosts" },
            result: "127.0.0.1 localhost",
          },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages as any);

    // Should produce: [assistant(with toolCalls), tool(result)]
    expect(expanded).toHaveLength(2);
    expect(expanded[0].role).toBe("assistant");
    expect(expanded[0].toolCalls).toHaveLength(1);
    expect(expanded[0].toolCalls![0].name).toBe("read_file");
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].name).toBe("read_file");
    expect(expanded[1].tool_call_id).toBe("call-1");
    expect(expanded[1].content).toBe("127.0.0.1 localhost");
  });

  it("should truncate tool results that are objects", () => {
    const largeResult = {
      events: Array.from({ length: 50 }, (_, index) => ({ id: index })),
    };

    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "get_events", args: {}, result: largeResult },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages as any);
    const toolMessage = expanded.find((message) => message.role === "tool");

    // The content should be truncated JSON
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content as string);
    expect((parsed.events as unknown[]).length).toBe(10);
  });

  it("should filter out deleted messages by default", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi", deleted: true },
      { role: "user", content: "How are you?" },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded).toHaveLength(2);
    expect(expanded[0].content).toBe("Hello");
    expect(expanded[1].content).toBe("How are you?");
  });

  it("should keep deleted messages when filterDeleted is false", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi", deleted: true },
    ];

    const expanded = expandMessagesForFC(messages as any, {
      filterDeleted: false,
    });

    expect(expanded).toHaveLength(2);
  });

  it("should filter out assistant messages with empty content and no toolCalls", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "Continue" },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded).toHaveLength(2);
  });

  it("should preserve assistant messages with empty content but with toolCalls", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "list_files", args: {} },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded).toHaveLength(1);
    expect(expanded[0].role).toBe("assistant");
    expect(expanded[0].toolCalls).toHaveLength(1);
  });

  it("should preserve thinking and thinkingSignature on assistant messages", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "Answer",
        thinking: "Let me reason...",
        thinkingSignature: "sig-abc",
      },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded[0].thinking).toBe("Let me reason...");
    expect(expanded[0].thinkingSignature).toBe("sig-abc");
  });

  it("should include images in user messages", () => {
    const messages: TestMessage[] = [
      {
        role: "user",
        content: "What is this?",
        images: ["data:image/png;base64,abc"],
      },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded[0].images).toEqual(["data:image/png;base64,abc"]);
  });

  it("should produce a content of space for empty user messages", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "" },
    ];

    const expanded = expandMessagesForFC(messages as any);

    expect(expanded[0].content).toBe(" ");
  });

  it("should skip tool result messages when result is undefined", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "Calling...",
        toolCalls: [
          { id: "call-1", name: "pending_tool", args: {}, result: undefined },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages as any);

    // Only assistant message, no tool message (result undefined = pending)
    expect(expanded).toHaveLength(1);
    expect(expanded[0].role).toBe("assistant");
  });

  it("should handle multiple toolCalls producing multiple tool messages", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "read_file", args: { path: "/a" }, result: "content-a" },
          { id: "call-2", name: "read_file", args: { path: "/b" }, result: "content-b" },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages as any);

    // assistant + tool1 + tool2 = 3
    expect(expanded).toHaveLength(3);
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].content).toBe("content-a");
    expect(expanded[2].role).toBe("tool");
    expect(expanded[2].content).toBe("content-b");
  });
});

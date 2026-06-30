/**
 * FunctionCallingUtilities — tests for expandMessagesForFunctionCall and truncateToolResult.
 *
 * expandMessagesForFunctionCall is called on every agentic loop iteration to convert
 * the stored message format into the OpenAI Chat Completions spec format.
 * truncateToolResult prevents massive tool outputs from blowing up context windows.
 *
 * Bugs in either function can cause silent data loss, model API errors,
 * or context window overflow.
 */
import { describe, it, expect } from "vitest";
import {
  expandMessagesForFunctionCall,
  truncateToolResult,
  type ToolResultValue,
} from "../src/utils/FunctionCallingUtilities.ts";
// ── Types ──────────────────────────────────────────────────────
import type { ChatMessage as TestMessage } from "../src/types/admin.ts";
import { TYPES } from "../src/constants.ts";

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

    const result = truncateToolResult(largeArray) as ToolResultValue[];

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(11); // 10 items + 1 truncation marker
    expect(result[10]).toEqual({ _truncated: "Showing 10 of 50" });
  });

  it("should spread small arrays into numbered-key objects (object path applies)", () => {
    // Arrays with ≤10 items pass the length guard and fall through to the
    // object spread path: { ...(result as Record<string, unknown>) }
    // This converts [1, 2, 3] → { "0": 1, "1": 2, "2": 3 }
    const smallArray = [1, 2, 3, 4, 5];

    const result = truncateToolResult(smallArray) as { [key: string]: ToolResultValue };

    expect(result["0"]).toBe(1);
    expect(result["4"]).toBe(5);
  });

  it("should cap known truncatable array keys at 10 items", () => {
    const result = truncateToolResult({
      events: Array.from({ length: 25 }, (_, index) => ({ id: index })),
      otherData: "preserved",
    }) as { [key: string]: ToolResultValue };

    expect((result.events as ToolResultValue[]).length).toBe(10);
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

    const result = truncateToolResult(smallObject) as { [key: string]: ToolResultValue };

    expect(result).toEqual(smallObject);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("expandMessagesForFunctionCall", () => {
  it("should pass through simple user messages unchanged", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const expanded = expandMessagesForFunctionCall(messages);

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

    const expanded = expandMessagesForFunctionCall(messages);

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

    const expanded = expandMessagesForFunctionCall(messages);
    const toolMessage = expanded.find((message) => message.role === "tool");

    // The content should be truncated JSON
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content as string) as { [key: string]: ToolResultValue };
    expect((parsed.events as ToolResultValue[]).length).toBe(10);
  });

  it("should filter out deleted messages by default", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi", deleted: true },
      { role: "user", content: "How are you?" },
    ];

    const expanded = expandMessagesForFunctionCall(messages);

    expect(expanded).toHaveLength(2);
    expect(expanded[0].content).toBe("Hello");
    expect(expanded[1].content).toBe("How are you?");
  });

  it("should keep deleted messages when filterDeleted is false", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi", deleted: true },
    ];

    const expanded = expandMessagesForFunctionCall(messages, {
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

    const expanded = expandMessagesForFunctionCall(messages);

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

    const expanded = expandMessagesForFunctionCall(messages);

    // assistant + tool message (undefined result coalesced to null)
    expect(expanded).toHaveLength(2);
    expect(expanded[0].role).toBe("assistant");
    expect(expanded[0].toolCalls).toHaveLength(1);
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].name).toBe("list_files");
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

    const expanded = expandMessagesForFunctionCall(messages);

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

    const expanded = expandMessagesForFunctionCall(messages);

    expect(expanded[0].images).toEqual(["data:image/png;base64,abc"]);
  });

  it("should produce a content of space for empty user messages", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "" },
    ];

    const expanded = expandMessagesForFunctionCall(messages);

    expect(expanded[0].content).toBe(" ");
  });

  it("should coalesce undefined tool results to null instead of dropping them", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "Calling...",
        toolCalls: [
          { id: "call-1", name: "pending_tool", args: {}, result: undefined },
        ],
      },
    ];

    const expanded = expandMessagesForFunctionCall(messages);

    // Undefined results are coalesced to null — produces a tool message
    // to prevent orphaned tool_calls structures that providers reject.
    expect(expanded).toHaveLength(2);
    expect(expanded[0].role).toBe("assistant");
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].content).toBe("null");
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

    const expanded = expandMessagesForFunctionCall(messages);

    // assistant + tool1 + tool2 = 3
    expect(expanded).toHaveLength(3);
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].content).toBe("content-a");
    expect(expanded[2].role).toBe("tool");
    expect(expanded[2].content).toBe("content-b");
  });
});

// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts) ──

describe('FunctionCallingUtilities adversarial', () => {
  describe('truncateToolResult — edge cases', () => {
    it('should return null for null input', () => {
      expect(truncateToolResult(null)).toBeNull();
    });

    it('should return undefined for undefined input', () => {
      expect(truncateToolResult(undefined)).toBeUndefined();
    });

    it('should return primitive numbers as-is', () => {
      expect(truncateToolResult(42)).toBe(42);
    });

    it('should return primitive strings as-is', () => {
      expect(truncateToolResult('hello')).toBe('hello');
    });

    it('should truncate a top-level array with 1000 items to 10 + truncation marker', () => {
      const hugeArray = Array.from({ length: 1000 }, (_, index) => ({ id: index, data: 'x'.repeat(50) }));
      const result = truncateToolResult(hugeArray);
      if (Array.isArray(result)) {
        expect(result.length).toBe(11); // 10 items + truncation marker
        expect((result[10] as { [key: string]: ToolResultValue })._truncated).toContain('1000');
      } else {
        // If the result was further truncated to a string, it should be capped
        expect(typeof result).toBe('string');
        expect((result as string).length).toBeLessThanOrEqual(8001); // maxChars + "…}"
      }
    });

    it('should handle object with known truncatable array keys', () => {
      const result = truncateToolResult({
        events: Array.from({ length: 50 }, (_, index) => ({ id: index })),
        products: Array.from({ length: 100 }, (_, index) => ({ sku: `SKU-${index}` })),
      }) as { [key: string]: ToolResultValue };
      expect(Array.isArray(result.events)).toBe(true);
      expect((result.events as ToolResultValue[]).length).toBe(10);
      expect(result._eventsTruncated as string).toContain('50');
      expect((result.products as ToolResultValue[]).length).toBe(10);
    });

    it('should handle deeply nested circular-like structures gracefully (non-circular but very deep)', () => {
      let deepObject: { [key: string]: ToolResultValue } = { leaf: true };
      for (let depth = 0; depth < 200; depth++) {
        deepObject = { child: deepObject };
      }
      // Should not throw — JSON.stringify handles deep objects
      const result = truncateToolResult(deepObject);
      expect(result).toBeDefined();
    });

    it('should handle custom maxChars of 0 — everything truncated', () => {
      const result = truncateToolResult({ key: 'value' }, 0);
      // JSON.stringify({key:'value'}) = 15 chars > 0
      expect(typeof result).toBe('string');
      expect((result as string).endsWith('…}')).toBe(true);
    });

    it('should handle prototype pollution attempt in result object', () => {
      const maliciousResult = JSON.parse('{"__proto__": {"isAdmin": true}, "data": "safe"}') as { [key: string]: ToolResultValue };
      const result = truncateToolResult(maliciousResult) as { [key: string]: ToolResultValue };
      // Spread operator should NOT have polluted Object.prototype
      expect(({} as Record<string, boolean>).isAdmin).toBeUndefined();
      expect(result.data).toBe('safe');
    });
  });

  describe('expandMessagesForFunctionCall — malformed messages', () => {
    it('should handle empty messages array', () => {
      const result = expandMessagesForFunctionCall([]);
      expect(result).toEqual([]);
    });

    it('should handle message with null content', () => {
      const messages: TestMessage[] = [{ role: 'user', content: null }];
      const result = expandMessagesForFunctionCall(messages);
      expect(result.length).toBe(1);
      // Should convert null content to " " (space fallback)
      expect(result[0].content).toBe(' ');
    });

    it('should handle assistant message with empty toolCalls array', () => {
      const messages: TestMessage[] = [
        { role: 'assistant', content: TYPES.TEXT, toolCalls: [] },
      ];
      const result = expandMessagesForFunctionCall(messages);
      // Empty toolCalls = no expansion needed, but content is valid
      expect(result.length).toBe(1);
    });

    it('should coalesce undefined tool result to null and produce a tool message', () => {
      const messages: TestMessage[] = [
        {
          role: 'assistant',
          content: 'thinking...',
          toolCalls: [
            { id: 'tool-call-1', name: 'search', args: { query: 'test' } },
            // result is undefined — coalesced to null to avoid orphaned tool_calls
          ],
        },
      ];
      const result = expandMessagesForFunctionCall(messages);
      // Should produce assistant + 1 tool message (undefined → null)
      const toolMessages = result.filter((message) => message.role === 'tool');
      expect(toolMessages.length).toBe(1);
      expect(toolMessages[0].content).toBe('null');
    });

    it('should filter deleted messages when filterDeleted is true', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'bye', deleted: true },
        { role: 'user', content: 'still here' },
      ];
      const result = expandMessagesForFunctionCall(messages, { filterDeleted: true });
      expect(result.length).toBe(2); // deleted message removed
    });

    it('should keep deleted messages when filterDeleted is false', () => {
      const messages: TestMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'bye', deleted: true },
      ];
      const result = expandMessagesForFunctionCall(messages, { filterDeleted: false });
      expect(result.length).toBe(2);
    });

    it('should include tool messages when result is null', () => {
      const messages: TestMessage[] = [
        {
          role: "assistant",
          content: "Working",
          toolCalls: [
            {
              id: "toolCall-0",
              name: "generate_audio",
              args: {},
              result: null,
            },
          ],
        },
      ];
      const expanded = expandMessagesForFunctionCall(messages);
      const toolMessages = expanded.filter((message) => message.role === "tool");
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].content).toBe("null");
    });

    it('should handle multiple toolCalls with mixed results (undefined coalesced to null)', () => {
      const messages: TestMessage[] = [
        {
          role: "assistant",
          content: "Doing both",
          toolCalls: [
            {
              id: "toolCall-0",
              name: "search_web",
              args: {},
              result: { found: true },
            },
            {
              id: "toolCall-1",
              name: "generate_audio",
              args: {},
              result: undefined,
            },
          ],
        },
      ];
      const expanded = expandMessagesForFunctionCall(messages);
      const toolMessages = expanded.filter((message) => message.role === "tool");
      // Both tool calls produce tool messages — undefined coalesced to null
      expect(toolMessages).toHaveLength(2);
      expect(toolMessages[0].name).toBe("search_web");
      expect(toolMessages[1].name).toBe("generate_audio");
      expect(toolMessages[1].content).toBe("null");
    });

    it('should simulate the exact iteration 2 message expansion for generate_audio flow', () => {
      const messages: TestMessage[] = [
        {
          role: "system",
          content: "You are a creative assistant with many tools available.",
        },
        { role: "user", content: "hey whats up" },
        { role: "assistant", content: "Hey Rodrigo! What's good?" },
        { role: "user", content: "make a song about the war" },
        {
          role: "assistant",
          content: "I'll create an original song about war for you!",
          toolCalls: [
            {
              id: "toolCall-0",
              name: "generate_audio",
              args: {
                title: "Echoes of War",
                tracks: [{ type: "oscillator", waveform: "sawtooth" }],
              },
              result: {
                success: true,
                audioRef: "minio://generations/audio/war.wav",
                duration: 30,
                sampleRate: 44100,
              },
            },
          ],
        },
      ];

      const expanded = expandMessagesForFunctionCall(messages);

      expect(expanded).toHaveLength(6);
      expect(expanded[0].role).toBe("system");
      expect(expanded[1].role).toBe("user");
      expect(expanded[1].content).toBe("hey whats up");
      expect(expanded[2].role).toBe("assistant");
      expect(expanded[2].content).toBe("Hey Rodrigo! What's good?");
      expect(expanded[3].role).toBe("user");
      expect(expanded[3].content).toBe("make a song about the war");
      expect(expanded[4].role).toBe("assistant");
      expect(expanded[4].toolCalls).toHaveLength(1);
      expect(expanded[5].role).toBe("tool");
      expect(expanded[5].name).toBe("generate_audio");

      let lastUserIndex = -1;
      for (let i = expanded.length - 1; i >= 0; i--) {
        if (expanded[i].role === "user") {
          lastUserIndex = i;
          break;
        }
      }
      expect(lastUserIndex).toBe(3);

      const toolIndex = expanded.findIndex(
        (message) => message.role === "tool",
      );
      expect(toolIndex).toBe(5);
      expect(toolIndex).toBeGreaterThan(lastUserIndex);
    });

    it('should verify tool result content is present for the model', () => {
      const messages: TestMessage[] = [
        { role: "user", content: "make audio" },
        {
          role: "assistant",
          content: "Creating!",
          toolCalls: [
            {
              id: "toolCall-0",
              name: "generate_audio",
              args: {},
              result: {
                success: true,
                audioRef: "minio://audio.wav",
                message: "Audio generated successfully",
              },
            },
          ],
        },
      ];

      const expanded = expandMessagesForFunctionCall(messages);
      const toolMessage = expanded.find((message) => message.role === "tool");

      expect(toolMessage).toBeDefined();
      const parsedContent = JSON.parse(toolMessage!.content as string) as { [key: string]: ToolResultValue };
      expect(parsedContent.success).toBe(true);
      expect(parsedContent.message).toBe("Audio generated successfully");
    });
  });
});

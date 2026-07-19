/**
 * Tests for expandMessagesForFunctionCall — verifies correct handling of
 * both inline toolCall.result (model_conversations) and separate role:"tool"
 * messages (agent_conversations / OpenAI standard format).
 */
import { describe, it, expect } from "vitest";
import {
  expandMessagesForFunctionCall,
  truncateToolResult,
} from "#src/utils/FunctionCallingUtilities";

describe("expandMessagesForFunctionCall", () => {
  it("expands inline toolCall.result into synthetic tool messages", () => {
    // model_conversations format: result stored on toolCalls[].result
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "generate_chart",
            args: { type: "pie" },
            result: { chartImageUrl: "https://storage.rod.dev/chart.png" },
          },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });

    expect(expanded).toHaveLength(2);
    expect(expanded[0].role).toBe("assistant");
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].tool_call_id).toBe("call-1");
    expect(expanded[1].content).toContain("chartImageUrl");
    expect(expanded[1].content).toContain("https://storage.rod.dev/chart.png");
  });

  it("skips synthetic tool message when a real role:tool message already exists", () => {
    // agent_conversations format: result stored as a separate role:"tool" message
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "generate_chart",
            args: { type: "pie" },
            // No result here — it's in the separate tool message below
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "generate_chart",
        content: '{"chartImageUrl":"https://storage.rod.dev/chart.png","chartId":"abc"}',
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });

    // Should produce: [assistant, tool] — NOT [assistant, tool(null), tool(real)]
    expect(expanded).toHaveLength(2);
    expect(expanded[0].role).toBe("assistant");
    expect(expanded[0].toolCalls).toHaveLength(1);
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].tool_call_id).toBe("call-1");
    expect(expanded[1].content).toContain("chartImageUrl");
    expect(expanded[1].content).toContain("https://storage.rod.dev/chart.png");
    // Must NOT contain "null"
    expect(expanded[1].content).not.toBe("null");
  });

  it("does not produce duplicate tool messages when both inline result and separate message exist", () => {
    // Edge case: toolCall has a result AND a separate tool message exists
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "generate_chart",
            args: { type: "bar" },
            result: { chartImageUrl: "https://storage.rod.dev/inline.png" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "generate_chart",
        content: '{"chartImageUrl":"https://storage.rod.dev/separate.png"}',
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });

    // The real message takes precedence — only 2 messages total
    expect(expanded).toHaveLength(2);
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].content).toContain("separate.png");
  });

  it("handles multiple tool calls where some have separate messages and some do not", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "generate_chart",
            args: { type: "pie" },
            // No inline result — has separate tool message
          },
          {
            id: "call-2",
            name: "search_web",
            args: { query: "test" },
            result: { results: ["inline result"] },
            // Has inline result — no separate tool message
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "generate_chart",
        content: '{"chartImageUrl":"https://storage.rod.dev/chart.png"}',
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });

    // Should produce: [assistant, tool(call-2 inline), tool(call-1 real)]
    expect(expanded).toHaveLength(3);
    expect(expanded[0].role).toBe("assistant");

    // call-2 gets a synthetic tool message (no separate message exists)
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].tool_call_id).toBe("call-2");
    expect(expanded[1].content).toContain("inline result");

    // call-1 uses the real separate tool message
    expect(expanded[2].role).toBe("tool");
    expect(expanded[2].tool_call_id).toBe("call-1");
    expect(expanded[2].content).toContain("chartImageUrl");
  });

  it("coalesces undefined result to null when no separate tool message exists", () => {
    // Prevents orphaned tool_calls with no matching tool response
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-orphan",
            name: "some_tool",
            args: {},
            // No result, no separate message
          },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });

    expect(expanded).toHaveLength(2);
    expect(expanded[1].role).toBe("tool");
    expect(expanded[1].tool_call_id).toBe("call-orphan");
    expect(expanded[1].content).toBe("null");
  });

  it("preserves thinking and thinkingSignature on assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: "response text",
        thinking: "internal reasoning",
        thinkingSignature: "sig-abc",
        toolCalls: [
          {
            id: "call-1",
            name: "test_tool",
            args: {},
            result: "done",
          },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: false,
    });

    expect(expanded[0].thinking).toBe("internal reasoning");
    expect(expanded[0].thinkingSignature).toBe("sig-abc");
  });

  it("filters deleted messages when filterDeleted is true", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "response", deleted: true },
      { role: "assistant", content: "visible response" },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, {
      filterDeleted: true,
    });

    expect(expanded).toHaveLength(2);
    expect(expanded[0].content).toBe("hello");
    expect(expanded[1].content).toBe("visible response");
  });

  // ── System Role Messages ─────────────────────────────────────
  describe("system role messages", () => {
    it("passes through system messages with content", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded).toHaveLength(2);
      expect(expanded[0].role).toBe("system");
      expect(expanded[0].content).toBe("You are a helpful assistant.");
    });

    it("replaces empty system content with single space fallback", () => {
      const messages = [
        { role: "system", content: "" },
        { role: "user", content: "Hello" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].role).toBe("system");
      expect(expanded[0].content).toBe(" ");
    });

    it("replaces whitespace-only system content with single space", () => {
      const messages = [
        { role: "system", content: "   " },
        { role: "user", content: "Hello" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].role).toBe("system");
      expect(expanded[0].content).toBe(" ");
    });

    it("replaces null system content with single space", () => {
      const messages = [
        { role: "system", content: null },
        { role: "user", content: "Hello" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].role).toBe("system");
      expect(expanded[0].content).toBe(" ");
    });

    it("handles mid-conversation system messages (tool updates)", () => {
      const messages = [
        { role: "system", content: "Identity" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "system", content: "<tool-update>New tools enabled</tool-update>" },
        { role: "user", content: "Continue" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded).toHaveLength(5);
      expect(expanded[3].role).toBe("system");
      expect(expanded[3].content).toContain("tool-update");
    });
  });

  // ── User Role Messages ───────────────────────────────────────
  describe("user role messages", () => {
    it("passes through user messages with text content", () => {
      const messages = [{ role: "user", content: "Hello there" }] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded).toHaveLength(1);
      expect(expanded[0].role).toBe("user");
      expect(expanded[0].content).toBe("Hello there");
    });

    it("replaces empty user content with single space", () => {
      const messages = [{ role: "user", content: "" }] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].role).toBe("user");
      expect(expanded[0].content).toBe(" ");
    });

    it("preserves image attachments on user messages", () => {
      const messages = [
        {
          role: "user",
          content: "What is this?",
          images: ["data:image/png;base64,iVBORtest"],
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].images).toHaveLength(1);
      expect(expanded[0].images![0]).toBe("data:image/png;base64,iVBORtest");
    });

    it("preserves video attachments on user messages", () => {
      const messages = [
        {
          role: "user",
          content: "Analyze this video",
          video: ["data:video/mp4;base64,videodata"],
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].video).toHaveLength(1);
    });

    it("preserves audio attachments on user messages", () => {
      const messages = [
        {
          role: "user",
          content: "Transcribe this",
          audio: ["data:audio/wav;base64,audiodata"],
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].audio).toHaveLength(1);
    });

    it("preserves PDF attachments on user messages", () => {
      const messages = [
        {
          role: "user",
          content: "Summarize this PDF",
          pdf: ["data:application/pdf;base64,pdfdata"],
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].pdf).toHaveLength(1);
    });

    it("omits empty media arrays from output", () => {
      const messages = [
        { role: "user", content: "No attachments", images: [], video: [] },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].images).toBeUndefined();
      expect(expanded[0].video).toBeUndefined();
    });
  });

  // ── Assistant Role (Without Tool Calls) ────────────────────
  describe("assistant role messages without toolCalls", () => {
    it("passes through plain assistant messages", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded).toHaveLength(2);
      expect(expanded[1].role).toBe("assistant");
      expect(expanded[1].content).toBe("Hi there!");
    });

    it("preserves thinking and thinkingSignature on non-toolCalls assistant", () => {
      const messages = [
        {
          role: "assistant",
          content: "My answer",
          thinking: "I considered multiple options",
          thinkingSignature: "sig-xyz",
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[0].thinking).toBe("I considered multiple options");
      expect(expanded[0].thinkingSignature).toBe("sig-xyz");
    });

    it("replaces empty assistant content with single space", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded[1].content).toBe(" ");
    });

    it("filters empty assistant messages without toolCalls when filterDeleted is true", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "Actual response" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: true,
      });

      // Empty assistant without toolCalls should be filtered out
      expect(expanded).toHaveLength(2);
      expect(expanded[1].content).toBe("Actual response");
    });
  });

  // ── Standalone Tool Role Messages ──────────────────────────
  describe("standalone tool role messages", () => {
    it("passes through role:tool messages with all required fields", () => {
      const messages = [
        {
          role: "tool",
          tool_call_id: "call-1",
          name: "get_weather",
          content: '{"temperature": 72}',
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      expect(expanded).toHaveLength(1);
      expect(expanded[0]).toMatchObject({
        role: "tool",
        tool_call_id: "call-1",
        name: "get_weather",
        content: '{"temperature": 72}',
      });
    });

    it("preserves tool_call_id correlation for provider matching", () => {
      const messages = [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "call-99", name: "get_weather", args: {} }],
        },
        {
          role: "tool",
          tool_call_id: "call-99",
          name: "get_weather",
          content: "Sunny, 75°F",
        },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      // assistant expands, then the standalone tool message follows
      const toolMessages = expanded.filter((message) => message.role === "tool");
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].tool_call_id).toBe("call-99");
    });
  });

  // ── Full Conversation Flow ─────────────────────────────────
  describe("full conversation flow with all role types", () => {
    it("correctly handles a complete multi-turn conversation", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Search for cats" },
        {
          role: "assistant",
          content: "I'll search for that.",
          toolCalls: [
            { id: "call-1", name: "web_search", args: { query: "cats" }, result: { results: ["Cat info"] } },
          ],
        },
        { role: "user", content: "Now make a chart" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            { id: "call-2", name: "generate_chart", args: { type: "pie" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-2",
          name: "generate_chart",
          content: '{"chartUrl": "https://storage.rod.dev/chart.png"}',
        },
        { role: "assistant", content: "Here's your chart!" },
      ] as any;

      const expanded = expandMessagesForFunctionCall(messages, {
        filterDeleted: false,
      });

      // Verify role sequence is valid
      const roleSequence = expanded.map((message) => message.role);
      expect(roleSequence).toEqual([
        "system",     // system prompt
        "user",       // first user message
        "assistant",  // first assistant with toolCalls
        "tool",       // tool result for call-1 (synthetic from inline result)
        "user",       // second user message
        "assistant",  // second assistant with toolCalls
        "tool",       // tool result for call-2 (standalone)
        "assistant",  // final assistant text
      ]);
    });
  });
});

describe("truncateToolResult", () => {
  it("returns primitives unchanged", () => {
    expect(truncateToolResult("hello")).toBe("hello");
    expect(truncateToolResult(42)).toBe(42);
    expect(truncateToolResult(null)).toBe(null);
    expect(truncateToolResult(undefined)).toBe(undefined);
  });

  it("caps top-level arrays at 10 items", () => {
    const largeArray = Array.from({ length: 25 }, (_, index) => ({ id: index }));
    const result = truncateToolResult(largeArray) as any[];
    expect(result).toHaveLength(11);
    expect(result[10]).toEqual({ _truncated: "Showing 10 of 25" });
  });

  it("caps known array keys at 10 items", () => {
    const input = {
      events: Array.from({ length: 20 }, (_, index) => ({ name: `event-${index}` })),
      otherField: "preserved",
    };
    const result = truncateToolResult(input) as any;
    expect(result.events).toHaveLength(10);
    expect(result._eventsTruncated).toBe("Showing 10 of 20");
    expect(result.otherField).toBe("preserved");
  });
});

describe("model-visible tool media", () => {
  const snapshotResult = {
    message: "Animation updated",
    snapshot: { url: "https://tools.rod.dev/creative/vector-animation/asset?id=abc", times: [0, 1] },
  };

  it("attaches a synthetic user message with images for the latest embedded tool round", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "create_vector_animation", args: {}, result: snapshotResult },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, { filterDeleted: false });
    expect(expanded).toHaveLength(3);
    expect(expanded[2].role).toBe("user");
    expect(expanded[2].images).toEqual([
      "https://tools.rod.dev/creative/vector-animation/asset?id=abc",
    ]);
    expect(expanded[2].content).toContain("create_vector_animation");
    expect(expanded[2].content).toContain("Not a user message");
  });

  it("recognizes generate_image minioRef, screenshotRef, and explicit modelImageUrl", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "generate_image", args: {}, result: { image: { data: "AAAA", minioRef: "https://storage.rod.dev/gen.png" } } },
          { id: "c2", name: "browser_action", args: {}, result: { screenshotRef: "https://storage.rod.dev/shot.png" } },
          { id: "c3", name: "custom_tool", args: {}, result: { modelImageUrl: "https://storage.rod.dev/custom.png" } },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, { filterDeleted: false });
    const synthetic = expanded[expanded.length - 1];
    expect(synthetic.role).toBe("user");
    expect(synthetic.images).toEqual([
      "https://storage.rod.dev/gen.png",
      "https://storage.rod.dev/shot.png",
      "https://storage.rod.dev/custom.png",
    ]);
  });

  it("only attaches media for the LAST embedded round, not historical ones", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "old", name: "create_vector_animation", args: {}, result: snapshotResult },
        ],
      },
      { role: "assistant", content: "intermediate text" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "new", name: "create_vector_animation", args: {}, result: { message: "ok", snapshot: { url: "https://tools.rod.dev/asset?id=new" } } },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, { filterDeleted: false });
    const withImages = expanded.filter((m: any) => Array.isArray(m.images) && m.images.length > 0);
    expect(withImages).toHaveLength(1);
    expect(withImages[0].images).toEqual(["https://tools.rod.dev/asset?id=new"]);
  });

  it("does not attach media for non-http URLs, base64 data, or plain results", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "generate_image", args: {}, result: { image: { data: "iVBORbase64" } } },
          { id: "c2", name: "custom", args: {}, result: { modelImageUrl: "data:image/png;base64,AAAA" } },
          { id: "c3", name: "get_weather", args: {}, result: { temperature: 20 } },
        ],
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, { filterDeleted: false });
    expect(expanded.every((m: any) => !m.images || m.images.length === 0)).toBe(true);
  });

  it("leaves separate role:tool history messages untouched (no media injection)", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "create_vector_animation", args: {} }],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "create_vector_animation",
        content: JSON.stringify(snapshotResult),
      },
    ] as any;

    const expanded = expandMessagesForFunctionCall(messages, { filterDeleted: false });
    expect(expanded.every((m: any) => !m.images || m.images.length === 0)).toBe(true);
  });
});

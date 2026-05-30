import { describe, it, expect } from "vitest";
import { prepareResponsesInput, OpenAIMsg } from "../src/providers/openai.ts";

describe("OpenAI Responses API input preparation", () => {
  it("converts function call IDs to begin with 'fc' if they start with 'call_'", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        content: "Here is the audio",
        toolCalls: [
          {
            id: "call_5qUkFQfCyDCRuoCJvwJJnM7u",
            name: "generate_audio",
            args: { prompt: "Latin American song" },
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);

    // Should generate two input items: the assistant message item, and the function call item
    expect(inputItems).toHaveLength(2);

    const assistantItem = inputItems[0];
    expect(assistantItem.role).toBe("assistant");
    expect(assistantItem.content).toBe("Here is the audio");

    const functionCallItem = inputItems[1];
    expect(functionCallItem.type).toBe("function_call");

    // The Responses item ID ('id') must begin with 'fc_' or 'fc'
    expect(functionCallItem.id).toBe("fc_5qUkFQfCyDCRuoCJvwJJnM7u");

    // The underlying tool call ID ('call_id') must be preserved so the tool response can correlate
    const typedFunctionCall = functionCallItem as unknown as {
      call_id: string;
    };
    expect(typedFunctionCall.call_id).toBe("call_5qUkFQfCyDCRuoCJvwJJnM7u");
  });

  it("preserves function call IDs that already start with 'fc'", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "fc_custom_id_123",
            name: "generate_audio",
            args: {},
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);
    expect(inputItems).toHaveLength(1);

    const functionCallItem = inputItems[0];
    expect(functionCallItem.id).toBe("fc_custom_id_123");

    const typedFunctionCall = functionCallItem as unknown as {
      call_id: string;
    };
    expect(typedFunctionCall.call_id).toBe("fc_custom_id_123");
  });

  it("handles empty toolCall IDs and generates a valid 'fc_' prefixed random ID", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            name: "generate_audio",
            args: {},
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);
    expect(inputItems).toHaveLength(1);

    const functionCallItem = inputItems[0];
    expect(functionCallItem.id).toMatch(/^fc_/);

    const typedFunctionCall = functionCallItem as unknown as {
      call_id: string;
    };
    expect(typedFunctionCall.call_id).toMatch(/^fc_/);
  });

  it("handles non-standard toolCall IDs and prepends them with 'fc_'", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "my-custom-id-xyz",
            name: "generate_audio",
            args: {},
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);
    expect(inputItems).toHaveLength(1);

    const functionCallItem = inputItems[0];
    expect(functionCallItem.id).toBe("fc_my-custom-id-xyz");

    const typedFunctionCall = functionCallItem as unknown as {
      call_id: string;
    };
    expect(typedFunctionCall.call_id).toBe("my-custom-id-xyz");
  });

  it("prefers responsesItemId if it starts with 'fc'", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "call_abc",
            responsesItemId: "fc_original_item_id",
            name: "generate_audio",
            args: {},
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);
    expect(inputItems).toHaveLength(1);

    const functionCallItem = inputItems[0];
    expect(functionCallItem.id).toBe("fc_original_item_id");

    const typedFunctionCall = functionCallItem as unknown as {
      call_id: string;
    };
    expect(typedFunctionCall.call_id).toBe("call_abc");
  });

  // ── Multi-turn correlation edge cases ─────────────────────────

  it("correctly correlates function_call and function_call_output call_ids in multi-turn conversations", () => {
    const messages: OpenAIMsg[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Generate a song" },
      {
        role: "assistant",
        content: "I'll generate that for you.",
        toolCalls: [
          {
            id: "call_abc123",
            responsesItemId: "fc_xyz789",
            name: "generate_audio",
            args: { prompt: "Latin American song" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_abc123",
        content: JSON.stringify({ success: true, audioRef: "minio://audio/123.wav" }),
      },
      { role: "user", content: "Make it more upbeat" },
    ];

    const inputItems = prepareResponsesInput(messages);

    // Find the function_call and function_call_output items
    const functionCallItem = inputItems.find((item) => item.type === "function_call");
    const functionCallOutputItem = inputItems.find((item) => item.type === "function_call_output");

    expect(functionCallItem).toBeDefined();
    expect(functionCallOutputItem).toBeDefined();

    const typedFunctionCall = functionCallItem as unknown as { id: string; call_id: string };
    const typedFunctionCallOutput = functionCallOutputItem as unknown as { call_id: string };

    // The function_call item ID must use the fc-prefixed version
    expect(typedFunctionCall.id).toBe("fc_xyz789");
    // The call_id on both must match for correlation
    expect(typedFunctionCall.call_id).toBe("call_abc123");
    expect(typedFunctionCallOutput.call_id).toBe("call_abc123");
  });

  it("handles multiple tool calls in a single assistant message", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        content: "I'll do both tasks.",
        toolCalls: [
          {
            id: "call_first",
            name: "generate_audio",
            args: { prompt: "Song 1" },
          },
          {
            id: "call_second",
            name: "generate_image",
            args: { prompt: "Image 1" },
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);

    // Should be: assistant text + function_call_1 + function_call_2
    expect(inputItems).toHaveLength(3);

    const functionCallItems = inputItems.filter((item) => item.type === "function_call");
    expect(functionCallItems).toHaveLength(2);

    // Both IDs must start with fc_
    for (const functionCall of functionCallItems) {
      expect(functionCall.id).toMatch(/^fc_/);
    }

    // Each must have distinct IDs
    expect(functionCallItems[0].id).not.toBe(functionCallItems[1].id);

    // call_id values must preserve the originals
    const typedFirstCall = functionCallItems[0] as unknown as { call_id: string };
    const typedSecondCall = functionCallItems[1] as unknown as { call_id: string };
    expect(typedFirstCall.call_id).toBe("call_first");
    expect(typedSecondCall.call_id).toBe("call_second");
  });

  it("handles tool calls with reasoning items paired correctly", () => {
    const reasoningItem = {
      id: "rs_reasoning_abc",
      summary: [{ type: "summary_text", text: "Thinking about what to generate..." }],
    };

    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "call_with_reasoning",
            responsesItemId: "fc_with_reasoning",
            name: "generate_audio",
            args: { prompt: "A calm song" },
            reasoningItem,
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);

    // Should be: reasoning_item + function_call
    expect(inputItems).toHaveLength(2);

    const reasoningInputItem = inputItems[0];
    expect(reasoningInputItem.type).toBe("reasoning");
    expect(reasoningInputItem.id).toBe("rs_reasoning_abc");

    const functionCallItem = inputItems[1];
    expect(functionCallItem.type).toBe("function_call");
    expect(functionCallItem.id).toBe("fc_with_reasoning");
  });

  it("handles assistant message without text content (tool calls only)", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_no_text",
            name: "web_search",
            args: { query: "test" },
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);

    // Should NOT include an assistant text item since content is empty
    expect(inputItems).toHaveLength(1);
    expect(inputItems[0].type).toBe("function_call");
  });

  it("handles tool results loaded from database (missing tool_call_id, using id fallback)", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "call_db_loaded",
            name: "generate_audio",
            args: { prompt: "test" },
          },
        ],
      },
      {
        role: "tool",
        id: "call_db_loaded",
        content: JSON.stringify({ success: true }),
      },
    ];

    const inputItems = prepareResponsesInput(messages);

    const functionCallItem = inputItems.find((item) => item.type === "function_call");
    const functionCallOutputItem = inputItems.find((item) => item.type === "function_call_output");

    expect(functionCallItem).toBeDefined();
    expect(functionCallOutputItem).toBeDefined();

    const typedFunctionCall = functionCallItem as unknown as { call_id: string };
    const typedFunctionCallOutput = functionCallOutputItem as unknown as { call_id: string };

    // Both must reference the same call_id for proper correlation
    expect(typedFunctionCall.call_id).toBe("call_db_loaded");
    expect(typedFunctionCallOutput.call_id).toBe("call_db_loaded");
  });

  it("converts system role to developer role", () => {
    const messages: OpenAIMsg[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ];

    const inputItems = prepareResponsesInput(messages);
    expect(inputItems[0].role).toBe("developer");
    expect(inputItems[1].role).toBe("user");
  });

  it("handles responsesItemId that does NOT start with 'fc' — falls through to fallback", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "call_stale_responses_id",
            responsesItemId: "stale_corrupted_id_without_prefix",
            name: "generate_audio",
            args: {},
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);
    expect(inputItems).toHaveLength(1);

    const functionCallItem = inputItems[0];
    // responsesItemId didn't start with 'fc', so it should fallback to converting call_
    expect(functionCallItem.id).toBe("fc_stale_responses_id");
  });

  it("serializes object args to JSON string", () => {
    const messages: OpenAIMsg[] = [
      {
        role: "assistant",
        toolCalls: [
          {
            id: "fc_serialization_test",
            name: "generate_audio",
            args: { prompt: "test", volume: 0.5 },
          },
        ],
      },
    ];

    const inputItems = prepareResponsesInput(messages);
    const functionCallItem = inputItems[0] as unknown as { arguments: string };
    expect(functionCallItem.arguments).toBe(JSON.stringify({ prompt: "test", volume: 0.5 }));
  });
});

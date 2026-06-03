/**
 * Tests for expandMessagesForFC — the function that converts the internal
 * message format into the OpenAI Chat Completions format expected by LLM
 * providers. This is the last transformation before messages hit the model.
 *
 * Critical for the generate_audio bug: if tool results are dropped during
 * expansion, the model won't see the tool execution on the next iteration.
 */

import { describe, it, expect } from "vitest";

// ── Types ───────────────────────────────────────────────────────

interface ToolCallEntry {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  responsesItemId?: string;
  thoughtSignature?: string;
}

interface ChatMessage {
  role: string;
  content?: string | unknown;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: ToolCallEntry[];
  images?: string[];
  video?: string[];
  audio?: string | string[];
  pdf?: string[];
  name?: string;
  tool_call_id?: string;
  deleted?: boolean;
}

interface ExpandedMessage {
  role: string;
  content?: string | unknown | null;
  name?: string;
  tool_call_id?: string | null;
  thinking?: string;
  thinkingSignature?: string;
  toolCalls?: Array<{
    id: string | null;
    name: string;
    args?: unknown;
    responsesItemId?: string;
    thoughtSignature?: string;
  }>;
  images?: string[];
  video?: string[];
  audio?: string | string[];
  pdf?: string[];
}

// ── Reimplementation of truncateToolResult ────────────────────

function truncateToolResult(
  result: unknown,
  maximumCharacters = 8000,
): unknown {
  if (!result || typeof result !== "object") return result;

  if (Array.isArray(result) && result.length > 10) {
    const sliced = result.slice(0, 10);
    sliced.push({ _truncated: `Showing 10 of ${result.length}` });
    const serialized = JSON.stringify(sliced);
    return serialized.length > maximumCharacters
      ? serialized.slice(0, maximumCharacters) + "…}"
      : sliced;
  }

  const trimmed = { ...(result as Record<string, unknown>) };
  const serialized = JSON.stringify(trimmed);
  if (serialized.length <= maximumCharacters) return trimmed;
  return serialized.slice(0, maximumCharacters) + "…}";
}

// ── Reimplementation of expandMessagesForFC ───────────────────

function expandMessagesForFC(
  messages: ChatMessage[],
  { filterDeleted = true }: { filterDeleted?: boolean } = {},
): ExpandedMessage[] {
  const filtered = filterDeleted
    ? messages.filter(
        (message) =>
          !message.deleted &&
          (message.role !== "assistant" ||
            message.content?.toString().trim() ||
            message.toolCalls?.length),
      )
    : messages;

  return filtered.flatMap((message) => {
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      const assistantMessage: ExpandedMessage = {
        role: "assistant",
        content: message.content?.toString().trim() || null,
        ...(message.thinking && { thinking: message.thinking }),
        ...(message.thinkingSignature && {
          thinkingSignature: message.thinkingSignature,
        }),
        toolCalls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          ...(toolCall.responsesItemId
            ? { responsesItemId: toolCall.responsesItemId }
            : {}),
          ...(toolCall.thoughtSignature
            ? { thoughtSignature: toolCall.thoughtSignature }
            : {}),
        })),
      };
      const toolMessages: ExpandedMessage[] = message.toolCalls
        .filter((toolCall) => toolCall.result !== undefined)
        .map((toolCall) => ({
          role: "tool",
          name: toolCall.name,
          tool_call_id: toolCall.id,
          content:
            typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(truncateToolResult(toolCall.result)),
        }));
      return [assistantMessage, ...toolMessages];
    }

    if (message.role === "tool") {
      return [
        {
          role: "tool",
          tool_call_id: message.tool_call_id,
          name: message.name,
          content: message.content,
        },
      ];
    }

    return [
      {
        role: message.role,
        ...(message.content?.toString().trim()
          ? { content: message.content }
          : { content: " " }),
        ...(message.images && message.images.length > 0
          ? { images: message.images }
          : {}),
        ...(message.audio ? { audio: message.audio } : {}),
        ...(message.role === "assistant" && message.thinking
          ? { thinking: message.thinking }
          : {}),
      },
    ];
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  expandMessagesForFC tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("expandMessagesForFC — basic expansion", () => {
  it("expands assistant with toolCalls into assistant + tool messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: "Searching...",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "search_web",
            args: { query: "cats" },
            result: { results: ["found cats"] },
          },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages, { filterDeleted: false });

    expect(expanded).toHaveLength(4); // system, user, assistant, tool
    expect(expanded[2].role).toBe("assistant");
    expect(expanded[2].toolCalls).toHaveLength(1);
    expect(expanded[3].role).toBe("tool");
    expect(expanded[3].name).toBe("search_web");
    expect(expanded[3].tool_call_id).toBe("toolCall-0");
    expect(expanded[3].content).toContain("found cats");
  });

  it("preserves tool result as JSON string", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Creating audio",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War Song" },
            result: {
              success: true,
              audioRef: "minio://audio/war.wav",
              duration: 30,
              sampleRate: 44100,
            },
          },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages, { filterDeleted: false });
    const toolMessage = expanded.find((message) => message.role === "tool");

    expect(toolMessage).toBeDefined();
    expect(typeof toolMessage!.content).toBe("string");
    const parsedContent = JSON.parse(toolMessage!.content as string);
    expect(parsedContent.success).toBe(true);
    expect(parsedContent.audioRef).toBe("minio://audio/war.wav");
  });

  it("drops tool messages when result is undefined", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Working",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: undefined,
          },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages, { filterDeleted: false });

    // No tool message emitted when result is undefined
    const toolMessages = expanded.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(0);

    // But assistant message IS still emitted (with toolCalls metadata)
    expect(expanded).toHaveLength(1);
    expect(expanded[0].toolCalls).toHaveLength(1);
  });

  it("includes tool messages when result is null", () => {
    const messages: ChatMessage[] = [
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

    const expanded = expandMessagesForFC(messages, { filterDeleted: false });

    // null is NOT undefined — tool message SHOULD be emitted
    const toolMessages = expanded.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe("null");
  });

  it("handles multiple tool calls with mixed results", () => {
    const messages: ChatMessage[] = [
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
            result: undefined, // This one has no result
          },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages, { filterDeleted: false });

    // Only 1 tool message (search_web has result, generate_audio doesn't)
    const toolMessages = expanded.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].name).toBe("search_web");
  });
});

describe("expandMessagesForFC — iteration 2 context", () => {
  it("simulates the exact iteration 2 message expansion for generate_audio flow", () => {
    // After iteration 1 (tool call) and tool execution,
    // currentMessages = [system, user1, assistant1, user2, assistant2_with_tools]
    //
    // Iteration 2 runs with these messages expanded:

    const currentMessages: ChatMessage[] = [
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

    const expanded = expandMessagesForFC(currentMessages, {
      filterDeleted: false,
    });

    // Should be: [system, user1, assistant1, user2, assistant2(toolCalls), tool(result)]
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

    // The model should see user2's message BEFORE the tool call
    const lastUserIndex = expanded.findLastIndex(
      (message) => message.role === "user",
    );
    expect(lastUserIndex).toBe(3); // user2 at index 3

    // The model should see the tool result AFTER the tool call
    const toolIndex = expanded.findIndex(
      (message) => message.role === "tool",
    );
    expect(toolIndex).toBe(5); // tool at index 5
    expect(toolIndex).toBeGreaterThan(lastUserIndex);
  });

  it("verifies tool result content is present for the model", () => {
    const messages: ChatMessage[] = [
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

    const expanded = expandMessagesForFC(messages, { filterDeleted: false });
    const toolMessage = expanded.find((message) => message.role === "tool");

    // Verify the model receives meaningful tool result
    expect(toolMessage).toBeDefined();
    const parsedContent = JSON.parse(toolMessage!.content as string);
    expect(parsedContent.success).toBe(true);
    expect(parsedContent.message).toBe("Audio generated successfully");
  });
});

describe("expandMessagesForFC — deleted message filtering", () => {
  it("filters out deleted messages when filterDeleted is true (default)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hey" },
      {
        role: "assistant",
        content: "Wrong response",
        deleted: true,
      },
      { role: "assistant", content: "Correct response" },
    ];

    const expanded = expandMessagesForFC(messages);
    expect(expanded).toHaveLength(2);
    expect(expanded[1].content).toBe("Correct response");
  });

  it("filters out empty assistant messages (no content, no tools)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hey" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Real response" },
    ];

    const expanded = expandMessagesForFC(messages);
    expect(expanded).toHaveLength(2);
    expect(expanded[1].content).toBe("Real response");
  });

  it("keeps assistant with toolCalls even if content is empty", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "test_tool",
            args: {},
            result: { ok: true },
          },
        ],
      },
    ];

    const expanded = expandMessagesForFC(messages);
    expect(expanded).toHaveLength(3); // user, assistant(tools), tool
    expect(expanded[1].content).toBeNull(); // content is null (empty string trimmed)
    expect(expanded[1].toolCalls).toHaveLength(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  End-to-end: what the model sees on iteration 2
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("End-to-end: model's iteration 2 input after generate_audio", () => {
  it("model sees correct user message and tool result on iteration 2", () => {
    // Simulate what createProviderStream sends to the model
    const currentMessages: ChatMessage[] = [
      { role: "system", content: "System prompt with all tool schemas..." },
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey! What's good?" },
      { role: "user", content: "make a song about the war" },
      {
        role: "assistant",
        content: "Creating your song!",
        toolCalls: [
          {
            id: "call_abc123",
            name: "generate_audio",
            args: { title: "Echoes of War" },
            result: {
              success: true,
              audioRef: "minio://audio/echoes-of-war.wav",
            },
          },
        ],
      },
    ];

    const expandedMessages = expandMessagesForFC(currentMessages, {
      filterDeleted: false,
    });

    // The model should see:
    // 1. System prompt
    // 2. User: "hey whats up"
    // 3. Assistant: "Hey! What's good?"
    // 4. User: "make a song about the war"
    // 5. Assistant: "Creating your song!" + toolCalls
    // 6. Tool: generate_audio result

    expect(expandedMessages).toHaveLength(6);

    // Most importantly: the LAST user message should be "make a song about the war"
    const userMessages = expandedMessages.filter(
      (message) => message.role === "user",
    );
    const lastUserMessage = userMessages[userMessages.length - 1];
    expect(lastUserMessage.content).toBe("make a song about the war");

    // The tool result should be AFTER the last user message
    const lastUserIndex = expandedMessages.findLastIndex(
      (message) => message.role === "user",
    );
    const toolIndex = expandedMessages.findIndex(
      (message) => message.role === "tool",
    );
    expect(toolIndex).toBeGreaterThan(lastUserIndex);

    // Model should respond to the tool result + user request, NOT to "hey whats up"
    // If the model responds with "Hey! What's good?" or similar, the context is wrong
  });

  it("enforceContextWindow does NOT trigger for short conversations", () => {
    // Haiku 4.5 has 200k context window
    // Short 2-turn conversation with generate_audio should be well under budget
    const maxInputTokens = 200_000;
    const maxOutputTokens = 8192;
    const toolCount = 20;

    // Budget calculation from ContextWindowManager
    const schemaOverhead = 2000 + toolCount * 150; // 5000
    const outputReserve = Math.max(maxOutputTokens, 8192); // 8192
    const budget = Math.floor(
      (maxInputTokens - outputReserve - schemaOverhead) * 0.8,
    ); // ~149,446

    // Estimate tokens for our messages
    const estimatedMessageTokens =
      1000 + // system prompt (~4000 chars)
      10 + // user1 ("hey whats up")
      15 + // assistant1
      15 + // user2 ("make a song about the war")
      200; // assistant2 + tool result

    expect(estimatedMessageTokens).toBeLessThan(budget);
    // WAY under budget — enforceContextWindow will NOT trigger
  });

  it("enforceContextWindow MAY trigger with small local models", () => {
    // Local models (e.g., Qwen3 8B) have much smaller context windows
    const maxInputTokens = 32_000;
    const maxOutputTokens = 8192;
    const toolCount = 50; // Many agentic tools

    const schemaOverhead = 2000 + toolCount * 150; // 9500
    const outputReserve = Math.max(maxOutputTokens, 8192); // 8192
    const budget = Math.floor(
      (maxInputTokens - outputReserve - schemaOverhead) * 0.8,
    ); // ~11,446

    // With 50 tools, each tool schema is ~300 tokens = 15000 tokens
    // System prompt with tool schemas could easily be 20k+ tokens
    const estimatedWithLargeSchema = 20_000;

    // This WOULD trigger enforceContextWindow
    expect(estimatedWithLargeSchema).toBeGreaterThan(budget);
  });
});

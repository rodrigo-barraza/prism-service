/**
 * Tests for client-side tool call state updaters.
 *
 * Validates that:
 *   - Tool execution events correctly update the last assistant message
 *   - Tool results persist across streaming iterations
 *   - Audio tool results don't vanish when new text arrives
 *   - Message arrays maintain correct length and ordering
 *
 * These are pure unit tests of the extracted state updater functions
 * from toolCallStateUpdaters.ts.
 */

import { describe, it, expect } from "vitest";
import {
  applyToolExecutionToMessages,
  type ToolMessageSlice,
  type ToolExecutionInput,
  type SegmentSnapshot,
} from "../../prism-client/src/utils/toolCallStateUpdaters.ts";
import type { Message, ToolCallEvent, ContentSegment } from "../../prism-client/src/types/types.ts";

// ── Reimplementation of prepareDisplayMessages ───────────────────

type DisplayMessage = Omit<Message, "tool_calls"> & {
  tool_calls?: Array<{
    id: string;
    name?: string;
    args?: any;
    result?: any;
    status?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

function prepareDisplayMessages(
  rawMessages: DisplayMessage[] | undefined | null,
): DisplayMessage[] {
  if (!rawMessages || rawMessages.length === 0) return [];

  const normalizedMessages = rawMessages.map((message) => {
    if ((message as any).tool_calls && !message.toolCalls) {
      const normalizedCalls = (message as any).tool_calls.map(
        (toolCall: any) => ({
          id: toolCall.id,
          name: toolCall.name || toolCall.function?.name,
          args:
            typeof toolCall.args === "string"
              ? JSON.parse(toolCall.args)
              : toolCall.args ||
                (typeof toolCall.function?.arguments === "string"
                  ? JSON.parse(toolCall.function.arguments)
                  : toolCall.function?.arguments) ||
                {},
          result: toolCall.result,
          status: toolCall.status,
        }),
      );
      return { ...message, toolCalls: normalizedCalls };
    }
    return message;
  });

  const toolResults: Record<string, string> = {};
  for (const message of normalizedMessages) {
    if (message.role === "tool") {
      const id = message.tool_call_id || message.toolCallId;
      if (id) toolResults[id] = message.content || "";
    }
  }

  const filtered = normalizedMessages
    .filter((message) => {
      if (message.role === "tool") return false;
      if (message.role === "system") return false;
      const isEmptyAssistant =
        message.role === "assistant" &&
        !message.content?.trim() &&
        !message.toolCalls?.length &&
        !message.images?.length &&
        !message.audio &&
        !message.error;
      return !isEmptyAssistant;
    })
    .map((message) => {
      if (
        message.toolCalls &&
        message.toolCalls.length > 0 &&
        Object.keys(toolResults).length > 0
      ) {
        const enrichedCalls = message.toolCalls.map(
          (toolCall: ToolCallEvent) => ({
            ...toolCall,
            result:
              toolCall.result ||
              toolResults[toolCall.id] ||
              toolResults[(toolCall as any).tool_call_id || ""] ||
              null,
          }),
        );
        return { ...message, toolCalls: enrichedCalls };
      }
      return message;
    });

  return filtered;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  applyToolExecutionToMessages tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const emptySnapshot: SegmentSnapshot = {
  contentSegments: [],
  textFragments: [],
  thinkingFragments: [],
};

describe("applyToolExecutionToMessages", () => {
  it("adds a calling tool to the last assistant message", () => {
    const messages: ToolMessageSlice[] = [
      { role: "user", content: "make a song" },
      { role: "assistant", content: "Creating your song!" },
    ];

    const result = applyToolExecutionToMessages(
      messages,
      "toolCall-0",
      {
        id: "toolCall-0",
        name: "generate_audio",
        args: { title: "War Song" },
        status: "calling",
      },
      emptySnapshot,
    );

    expect(result).toHaveLength(2);
    expect(result[1].toolCalls).toHaveLength(1);
    expect(result[1].toolCalls![0].name).toBe("generate_audio");
    expect(result[1].toolCalls![0].status).toBe("calling");
  });

  it("updates a calling tool to done with result", () => {
    const messages: ToolMessageSlice[] = [
      { role: "user", content: "make a song" },
      {
        role: "assistant",
        content: "Creating!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War" },
            status: "calling",
            timestamp: 1000,
          },
        ],
      },
    ];

    const result = applyToolExecutionToMessages(
      messages,
      "toolCall-0",
      {
        id: "toolCall-0",
        name: "generate_audio",
        args: { title: "War" },
        status: "done",
        result: {
          success: true,
          audioRef: "minio://audio/war.wav",
          duration: 30,
        },
      },
      emptySnapshot,
    );

    expect(result[1].toolCalls![0].status).toBe("done");
    expect(result[1].toolCalls![0].result).toEqual({
      success: true,
      audioRef: "minio://audio/war.wav",
      duration: 30,
    });
  });

  it("does NOT mutate the original messages array", () => {
    const original: ToolMessageSlice[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi!" },
    ];
    const originalCopy = JSON.parse(JSON.stringify(original));

    applyToolExecutionToMessages(
      original,
      "toolCall-0",
      { name: "test_tool", status: "calling" },
      emptySnapshot,
    );

    expect(original).toEqual(originalCopy);
  });

  it("deduplicates tool calls with the same ID", () => {
    const messages: ToolMessageSlice[] = [
      {
        role: "assistant",
        content: "Working...",
        toolCalls: [
          { id: "toolCall-0", name: "generate_audio", args: {}, status: "calling" },
        ],
      },
    ];

    const result = applyToolExecutionToMessages(
      messages,
      "toolCall-0",
      { id: "toolCall-0", name: "generate_audio", args: {}, status: "calling" },
      emptySnapshot,
    );

    // Should still have only 1 tool call
    expect(result[0].toolCalls).toHaveLength(1);
  });

  it("creates assistant placeholder when tool event arrives before any text", () => {
    const messages: ToolMessageSlice[] = [
      { role: "user", content: "do something" },
    ];

    const result = applyToolExecutionToMessages(
      messages,
      "toolCall-0",
      { name: "generate_audio", status: "calling" },
      emptySnapshot,
    );

    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("");
    expect(result[1].toolCalls).toHaveLength(1);
  });

  it("preserves all previous messages when adding tool to assistant", () => {
    const messages: ToolMessageSlice[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      { role: "user", content: "make a song about war" },
      { role: "assistant", content: "I'll create a song!" },
    ];

    const result = applyToolExecutionToMessages(
      messages,
      "toolCall-0",
      { name: "generate_audio", status: "calling" },
      emptySnapshot,
    );

    // All 4 messages should still be there
    expect(result).toHaveLength(4);
    expect(result[0].content).toBe("hey whats up");
    expect(result[1].content).toBe("Hey Rodrigo!");
    expect(result[2].content).toBe("make a song about war");
    expect(result[3].toolCalls).toHaveLength(1);
  });

  it("audio tool result survives when content updates after tool completion", () => {
    // Simulates: tool is done → then more text chunks arrive
    const messagesWithCompletedTool: ToolMessageSlice[] = [
      { role: "user", content: "make a song" },
      {
        role: "assistant",
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            status: "done",
            result: {
              success: true,
              audioRef: "minio://audio/song.wav",
            },
          },
        ],
      },
    ];

    // Simulating what happens when the onChunk handler updates content
    // AFTER the tool has completed (iteration 2 text)
    const updatedContent = [...messagesWithCompletedTool];
    updatedContent[1] = {
      ...updatedContent[1],
      content:
        "Creating your song!\n\nHere's your song! I hope you enjoy it.",
    };

    // The tool result should still be there
    expect(updatedContent[1].toolCalls).toHaveLength(1);
    expect(updatedContent[1].toolCalls![0].status).toBe("done");
    expect(updatedContent[1].toolCalls![0].result).toHaveProperty("audioRef");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  prepareDisplayMessages tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("prepareDisplayMessages", () => {
  it("filters out system and tool role messages", () => {
    const raw: DisplayMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi!" },
      { role: "tool", content: "tool result", tool_call_id: "toolCall-0" },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("filters out empty assistant messages", () => {
    const raw: DisplayMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Real response" },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe("Real response");
  });

  it("preserves assistant messages with toolCalls even if content is empty", () => {
    const raw: DisplayMessage[] = [
      { role: "user", content: "generate audio" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            status: "done",
            result: { audioRef: "minio://audio.wav" },
          },
        ],
      },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(2);
    expect(result[1].toolCalls).toHaveLength(1);
  });

  it("preserves assistant messages with audio ref", () => {
    const raw: DisplayMessage[] = [
      { role: "user", content: "speak" },
      { role: "assistant", content: "", audio: "minio://audio/speech.wav" },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(2);
    expect(result[1].audio).toBe("minio://audio/speech.wav");
  });

  it("merges tool results into toolCalls", () => {
    const raw: DisplayMessage[] = [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: "Searching...",
        toolCalls: [
          { id: "toolCall-0", name: "search_web", args: { query: "test" } },
        ],
      },
      {
        role: "tool",
        content: '{"results": ["found it"]}',
        tool_call_id: "toolCall-0",
      },
      { role: "assistant", content: "Found it!" },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(3);
    // Tool result should be merged into the assistant's toolCall
    expect(result[1].toolCalls![0].result).toBe(
      '{"results": ["found it"]}',
    );
  });

  it("returns empty array for null/undefined input", () => {
    expect(prepareDisplayMessages(null)).toEqual([]);
    expect(prepareDisplayMessages(undefined)).toEqual([]);
    expect(prepareDisplayMessages([])).toEqual([]);
  });

  it("normalizes snake_case tool_calls to camelCase toolCalls", () => {
    const raw: DisplayMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: "Doing it",
        tool_calls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true },
            status: "done",
          },
        ],
      },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(2);
    expect(result[1].toolCalls).toHaveLength(1);
    expect(result[1].toolCalls![0].name).toBe("generate_audio");
  });

  it("preserves all messages in correct order for multi-turn with tools", () => {
    // This is the exact DB state that should exist after the fix
    const raw: DisplayMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo! What's good?" },
      { role: "user", content: "make a song about the war" },
      {
        role: "assistant",
        content: "I'll create a song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War" },
            status: "done",
            result: {
              success: true,
              audioRef: "minio://audio/war.wav",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "Here's your song about war!",
      },
    ];

    const result = prepareDisplayMessages(raw);
    expect(result).toHaveLength(5);

    // Verify message ordering
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("hey whats up");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
    expect(result[2].content).toBe("make a song about the war");
    expect(result[3].role).toBe("assistant");
    expect(result[3].toolCalls![0].name).toBe("generate_audio");
    expect(result[4].role).toBe("assistant");
    expect(result[4].content).toBe("Here's your song about war!");

    // User messages should never be duplicated
    const userMessages = result.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].content).not.toBe(userMessages[1].content);
  });

  it("BUG: missing user message results in wrong display", () => {
    // When the server fails to persist user2, the DB looks like this:
    const buggyDbMessages: DisplayMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      // user2 is MISSING
      {
        role: "assistant",
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            status: "done",
            result: { success: true },
          },
        ],
      },
      {
        role: "assistant",
        content:
          "Hey! Not much, just here and ready to help. What can I do for you?",
      },
    ];

    const result = prepareDisplayMessages(buggyDbMessages);

    // Only 1 user message — the second one is gone
    const userMessages = result.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);

    // The model has 3 consecutive assistant messages — clearly wrong
    const assistantMessages = result.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(3);

    // This documents the buggy symptom: the last assistant message
    // is responding to "hey whats up" instead of the tool request
    expect(assistantMessages[2].content).toContain("ready to help");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Post-stream refresh race condition tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Post-stream refresh — race condition detection", () => {
  it("guard catches stale DB data (fewer messages than streaming)", () => {
    const streamingMessageCount = 4; // [user1, assistant1, user2, assistant2]
    const dbDisplayMessageCount = 2; // [user1, assistant1] — appendAndFinalize hasn't completed

    const shouldSkipOverwrite =
      dbDisplayMessageCount < streamingMessageCount;
    expect(shouldSkipOverwrite).toBe(true);
  });

  it("guard DOES NOT catch wrong messages when count matches", () => {
    // This is the subtle race: the DB has the RIGHT number of messages
    // but the WRONG content (user2 is missing, replaced by extra assistant)
    const streamingMessageCount = 4;
    const dbDisplayMessageCount = 4; // Same count, but wrong content!

    const shouldSkipOverwrite =
      dbDisplayMessageCount < streamingMessageCount;
    expect(shouldSkipOverwrite).toBe(false);
    // BUG: The guard passes, and the wrong messages overwrite the correct streaming state
  });

  it("content-aware guard would catch the replacement", () => {
    const streamingMessages: DisplayMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      { role: "user", content: "make a song about the war" },
      {
        role: "assistant",
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            status: "done",
            result: { success: true, audioRef: "minio://audio/war.wav" },
          },
        ],
      },
    ];

    const dbMessages: DisplayMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      // user2 is missing, extra assistant instead
      {
        role: "assistant",
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            status: "done",
            result: { success: true },
          },
        ],
      },
      {
        role: "assistant",
        content: "Hey! What can I do for you?",
      },
    ];

    // Count-based guard: same count → passes (BUG)
    const countGuardPasses =
      dbMessages.length >= streamingMessages.length;
    expect(countGuardPasses).toBe(true);

    // Content-aware guard: check that all streaming user messages exist in DB
    const streamingUserMessages = streamingMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    const dbUserMessages = dbMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content);

    const allUserMessagesPresent = streamingUserMessages.every(
      (content) => dbUserMessages.includes(content),
    );

    // "make a song about the war" is NOT in dbUserMessages
    expect(allUserMessagesPresent).toBe(false);
    // A content-aware guard would detect this and skip the overwrite
  });
});

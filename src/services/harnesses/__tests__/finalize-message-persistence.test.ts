/**
 * Tests for the finalize() newTurnMessages slice logic in BaseAgenticHarness.
 *
 * Validates that the correct messages are extracted for DB persistence across:
 *   - Normal multi-turn conversations (no compaction)
 *   - Conversations where compaction fires mid-loop
 *   - Tool call iterations with intermediate assistant messages
 *   - Edge cases around originalMessageCount boundaries
 *
 * These are pure unit tests — no DB or network required.
 */

import { describe, it, expect } from "vitest";
import { PROMPT_DELIMITERS, MESSAGE_ROLES } from "#src/constants";
import type { ConversationMessage as TestMessage } from "#src/services/harnesses/types";
import { computeNewTurnMessages, sanitizeMessagesForPersistence } from "#src/services/harnesses/lifecycle/Finalizer";
import type { MessagePayload } from "#src/services/conversation/types";

/**
 * Delegates to the production newTurnMessages slice logic from
 * BaseAgenticHarness.finalize() / Finalizer.ts.
 */
function extractNewTurnMessages(
  currentMessages: TestMessage[],
  originalMessageCount: number,
): TestMessage[] {
  const messagesAsPayload = currentMessages.map((message, index) => ({
    ...message,
    _alreadyPersisted: index < originalMessageCount - 1 ? true : message._alreadyPersisted,
  })) as unknown as MessagePayload[];
  return computeNewTurnMessages(messagesAsPayload, messagesAsPayload, originalMessageCount) as unknown as TestMessage[];
}

/**
 * Delegates to the production sanitization filter from Finalizer.ts.
 * Filters out compaction artifacts that should never reach MongoDB.
 */
function sanitizeMessagesToAppend(
  messagesToAppend: TestMessage[],
): TestMessage[] {
  return sanitizeMessagesForPersistence(messagesToAppend as any) as unknown as TestMessage[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 1: Normal two-turn conversation without compaction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("newTurnMessages slice — normal flow (no compaction)", () => {
  it("captures user message and tool-calling assistant in a single-tool turn", () => {
    // Client sends 4 messages: [system, user1, assistant1, user2]
    // originalMessageCount = 4
    // After iteration 1 (tool call): [system, user1, assistant1, user2, assistant2_with_tools]
    // After iteration 2 (text only — breaks without pushing)
    // currentMessages.length = 5

    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are helpful." },
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo! What's good?" },
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "I'll create a song for you!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War Song" },
            result: { success: true, audioRef: "minio://audio/war.wav" },
          },
        ],
      },
    ];
    const originalMessageCount = 4;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Should capture: user2 + assistant2_with_tools (slice from index 3)
    expect(newTurnMessages).toHaveLength(2);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe("make a song about the war");
    expect(newTurnMessages[1].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(newTurnMessages[1].toolCalls).toHaveLength(1);
    expect(newTurnMessages[1].toolCalls![0].name).toBe("generate_audio");
  });

  it("captures user message in a text-only turn (no tools)", () => {
    // Client sends: [system, user1, assistant1, user2]
    // Iteration 1 produces text only → breaks without pushing
    // currentMessages stays at 4
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are helpful." },
      { role: MESSAGE_ROLES.USER, content: "hey" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hello!" },
      { role: MESSAGE_ROLES.USER, content: "how are you?" },
    ];
    const originalMessageCount = 4;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Should capture: user2 (slice from index 3)
    expect(newTurnMessages).toHaveLength(1);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe("how are you?");
  });

  it("captures user + multiple tool iterations", () => {
    // Two tool iterations before final text
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      { role: MESSAGE_ROLES.USER, content: "hello" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
      { role: MESSAGE_ROLES.USER, content: "search for X and generate audio" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Let me search first.",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "search_web",
            args: { query: "X" },
            result: { results: [] },
          },
        ],
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Now generating audio.",
        toolCalls: [
          {
            id: "toolCall-1",
            name: "generate_audio",
            args: { title: "X Song" },
            result: { success: true },
          },
        ],
      },
    ];
    const originalMessageCount = 4;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Should capture: user2, assistant_search, assistant_audio
    expect(newTurnMessages).toHaveLength(3);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe(
      "search for X and generate audio",
    );
    expect(newTurnMessages[1].toolCalls![0].name).toBe("search_web");
    expect(newTurnMessages[2].toolCalls![0].name).toBe("generate_audio");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 2: Compaction fires mid-loop
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("newTurnMessages slice — compaction mid-loop (BUG SCENARIO)", () => {
  it("BUG: compaction resets originalMessageCount to compacted length, losing the user message", () => {
    // This test documents the CURRENT BUGGY behavior:
    //
    // Before compaction: [system, user1, assistant1, user2]
    //   originalMessageCount = 4
    //
    // After compaction: [system, summaryUser, user1, assistant1, user2]
    //   state.originalMessageCount = 5  (set to compactedMessages.length in ReActHarness line 208)
    //
    // After iteration 1 (tool call): [system, summaryUser, user1, assistant1, user2, assistant2_with_tools]
    //   currentMessages.length = 6
    //
    // After iteration 2 (text only — breaks without pushing)
    //   currentMessages.length = 6 (unchanged)
    //
    // finalize() slices from Math.max(0, 5 - 1) = 4:
    //   newTurnMessages = currentMessages.slice(4)
    //                   = [user2, assistant2_with_tools]
    //
    // This is CORRECT — user2 is included!
    // But wait, the issue might be different...

    const currentMessagesAfterCompaction: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are helpful." },
      {
        role: MESSAGE_ROLES.USER,
        content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX}\nUser greeted the assistant.`,
        isCompactSummary: true,
      },
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo!" },
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War" },
            result: { success: true },
          },
        ],
      },
    ];
    // Actually, let me re-trace. Compaction happens BEFORE the iteration starts.
    // originalMessageCount is set to currentMessages.length at compaction time.
    // At compaction time, currentMessages = [system, summary, user1, assistant1, user2]
    // length = 5, so originalMessageCount = 5.
    // Then iteration 1 appends assistant2_with_tools → length = 6.
    // finalize() slices from 5 - 1 = 4:
    //   = [user2, assistant2_with_tools]
    // This IS correct.

    const newTurnMessages = extractNewTurnMessages(
      currentMessagesAfterCompaction,
      5,
    );

    // user2 IS included — so the bug is not here when compaction preserves user2.
    expect(newTurnMessages).toHaveLength(2);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe("make a song about the war");

    // But after sanitization, the compaction summary is irrelevant
    // because it wasn't in the slice anyway.
    // Split: user, assistant, tool result
    const sanitized = sanitizeMessagesToAppend(newTurnMessages);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0].content).toBe("make a song about the war");
    expect(sanitized[1].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(sanitized[2].role).toBe(MESSAGE_ROLES.TOOL);
  });

  it("BUG: compaction drops user2 from recent tail → user message lost entirely", () => {
    // The REAL bug: if extractRecentTail fails to include user2 in the tail,
    // compaction output becomes [system, summary] without user2.
    //
    // Then originalMessageCount = 2, and the loop adds assistant2_with_tools
    // at index 2. finalize() slices from 2-1=1:
    //   newTurnMessages = [summary, assistant2_with_tools]
    // After sanitization: [assistant2_with_tools] — user2 is GONE!

    const currentMessagesAfterBadCompaction: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are helpful." },
      {
        role: MESSAGE_ROLES.USER,
        content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX}\nEntire history compacted.`,
        isCompactSummary: true,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War" },
            result: { success: true },
          },
        ],
      },
    ];
    const originalMessageCountAfterBadCompaction = 2; // compaction produced only [system, summary]

    const newTurnMessages = extractNewTurnMessages(
      currentMessagesAfterBadCompaction,
      originalMessageCountAfterBadCompaction,
    );

    // Slice from 2 - 1 = 1: [summary, assistant2_with_tools]
    expect(newTurnMessages).toHaveLength(2);

    // After sanitization: summary is filtered out
    const sanitized = sanitizeMessagesToAppend(newTurnMessages);

    // BUG: Only assistant and tool remain — user message was LOST
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(sanitized[1].role).toBe(MESSAGE_ROLES.TOOL);
    // The user's "make a song about the war" is nowhere to be found!
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 3: First turn of a new conversation (1 user message)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("newTurnMessages slice — first turn", () => {
  it("captures user message on first turn with tool call", () => {
    // Client sends: [system, user1]
    // originalMessageCount = 2
    // After iteration 1 (tool call): [system, user1, assistant1_with_tools]
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      { role: MESSAGE_ROLES.USER, content: "generate an image of a cat" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating a cat image!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_image",
            args: { prompt: "cat" },
            result: { success: true },
          },
        ],
      },
    ];

    const newTurnMessages = extractNewTurnMessages(currentMessages, 2);

    // Slice from 2 - 1 = 1: [user1, assistant1_with_tools]
    expect(newTurnMessages).toHaveLength(2);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe("generate an image of a cat");
    expect(newTurnMessages[1].toolCalls![0].name).toBe("generate_image");
  });

  it("captures only user message on first turn without tools", () => {
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      { role: MESSAGE_ROLES.USER, content: "hello" },
    ];

    const newTurnMessages = extractNewTurnMessages(currentMessages, 2);
    expect(newTurnMessages).toHaveLength(1);
    expect(newTurnMessages[0].content).toBe("hello");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 4: Context window enforcement drops messages
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("newTurnMessages slice — context window enforcement", () => {
  it("correctly adjusts originalMessageCount when truncation drops messages", () => {
    // Before truncation: [system, user1, assistant1, user2, assistant2, user3]
    //   originalMessageCount = 6
    //
    // After truncation drops 2 old messages:
    //   currentMessages = [system, CONTEXT_NOTE, user2, assistant2, user3]
    //   originalMessageCount adjusted to 6 - 2 = 4
    //
    // Then iteration adds tool result:
    //   currentMessages = [system, CONTEXT_NOTE, user2, assistant2, user3, assistant3_tools]

    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      { role: MESSAGE_ROLES.USER, content: `${PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX} 2 messages truncated]` },
      { role: MESSAGE_ROLES.USER, content: "second message" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "response to second" },
      { role: MESSAGE_ROLES.USER, content: "third message" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Using tool",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true },
          },
        ],
      },
    ];

    // originalMessageCount was adjusted from 6 to 4 by enforceContextWindow
    const adjustedOriginalMessageCount = 4;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      adjustedOriginalMessageCount,
    );

    // Slice from 4 - 1 = 3: [assistant2, user3, assistant3_tools]
    // CONTEXT_NOTE should be filtered out (not in this slice anyway)
    expect(newTurnMessages).toHaveLength(3);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(newTurnMessages[1].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[1].content).toBe("third message");
    expect(newTurnMessages[2].toolCalls![0].name).toBe("generate_audio");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 5: originalMessageCount boundary edge cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("newTurnMessages slice — edge cases", () => {
  it("handles originalMessageCount = 0 (empty history)", () => {
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.USER, content: "hello" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Hi!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "test_tool",
            args: {},
            result: {},
          },
        ],
      },
    ];

    const newTurnMessages = extractNewTurnMessages(currentMessages, 0);
    // slice(0) = all messages
    expect(newTurnMessages).toHaveLength(2);
  });

  it("handles originalMessageCount = 1 (only system message)", () => {
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      { role: MESSAGE_ROLES.USER, content: "hello" },
    ];

    const newTurnMessages = extractNewTurnMessages(currentMessages, 1);
    // slice(0) = all messages
    expect(newTurnMessages).toHaveLength(2);
  });

  it("handles originalMessageCount equal to currentMessages length (no new messages)", () => {
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      { role: MESSAGE_ROLES.USER, content: "hello" },
    ];

    const newTurnMessages = extractNewTurnMessages(currentMessages, 2);
    // slice(1) = [user] — the user message IS the new turn
    expect(newTurnMessages).toHaveLength(1);
    expect(newTurnMessages[0].content).toBe("hello");
  });

  it("handles originalMessageCount exceeding currentMessages length after compaction", () => {
    // This can happen if compaction reduces the array below the original count
    // due to aggressive summarization
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      {
        role: MESSAGE_ROLES.USER,
        content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX}\nSummary`,
        isCompactSummary: true,
      },
    ];

    // originalMessageCount was set to the pre-compaction count
    const newTurnMessages = extractNewTurnMessages(currentMessages, 10);
    // slice(9) with only 2 elements = empty
    expect(newTurnMessages).toHaveLength(0);
    // BUG: This means NO messages get persisted!
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 6: The Generate Audio specific flow
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Generate Audio tool flow — second turn message persistence", () => {
  it("simulates the exact flow: turn 1 text, turn 2 with generate_audio tool", () => {
    // TURN 1 already persisted in DB: [user1:"hey whats up", assistant1:"Hey Rodrigo!"]
    //
    // TURN 2 client sends to server:
    //   messages = [system, user1, assistant1, user2:"make a song"]
    //   originalMessageCount = 4
    //
    // Iteration 1: model generates text + generate_audio tool call
    //   currentMessages = [system, user1, assistant1, user2, assistant2_with_tools]
    //
    // Iteration 2: model generates final text → breaks
    //   currentMessages = [system, user1, assistant1, user2, assistant2_with_tools]
    //   (unchanged — text-only break doesn't push)

    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are a creative assistant." },
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo! What's good?" },
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "I'll create an original song about war!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {
              title: "Echoes of War",
              tracks: [{ type: "oscillator" }],
            },
            result: {
              success: true,
              audioRef: "minio://generations/audio/war.wav",
              duration: 30,
            },
          },
        ],
      },
    ];
    const originalMessageCount = 4;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Slice from 3: [user2, assistant2_with_tools]
    expect(newTurnMessages).toHaveLength(2);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe("make a song about the war");
    expect(newTurnMessages[1].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(newTurnMessages[1].content).toBe(
      "I'll create an original song about war!",
    );
    expect(newTurnMessages[1].toolCalls![0].name).toBe("generate_audio");
    expect(newTurnMessages[1].toolCalls![0].result).toEqual({
      success: true,
      audioRef: "minio://generations/audio/war.wav",
      duration: 30,
    });

    // After sanitization (no compaction artifacts in this case)
    // Split: user, assistant, tool result
    const sanitized = sanitizeMessagesToAppend(newTurnMessages);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0].content).toBe("make a song about the war");
    expect(sanitized[1].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(sanitized[2].role).toBe(MESSAGE_ROLES.TOOL);
  });

  it("simulates generate_audio flow WITH compaction triggering (large context)", () => {
    // In this scenario, the system prompt + tool schemas + history push the
    // token count above the compaction threshold.
    //
    // Before compaction: [system, user1, assistant1, user2]
    //   originalMessageCount = 4
    //
    // Compaction produces: [system, summaryUser, user1, assistant1, user2]
    //   state.originalMessageCount = 5
    //
    // Iteration 1 with tool: [system, summaryUser, user1, assistant1, user2, assistant2_tools]
    //   length = 6
    //
    // finalize(): slice(5-1=4) → [user2, assistant2_tools] ✓ CORRECT

    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "Massive system prompt with tools..." },
      {
        role: MESSAGE_ROLES.USER,
        content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX}\nPrevious context.`,
        isCompactSummary: true,
      },
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey! What's up?" },
      { role: MESSAGE_ROLES.USER, content: "make me a song" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true },
          },
        ],
      },
    ];
    // Compaction set originalMessageCount to 5 (compacted array before tool iteration)
    const originalMessageCount = 5;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Slice from 4: [user2:"make me a song", assistant2_tools]
    expect(newTurnMessages).toHaveLength(2);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.USER);
    expect(newTurnMessages[0].content).toBe("make me a song");

    const sanitized = sanitizeMessagesToAppend(newTurnMessages);
    expect(sanitized).toHaveLength(3);
    expect(sanitized[0].content).toBe("make me a song");
    expect(sanitized[1].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(sanitized[2].role).toBe(MESSAGE_ROLES.TOOL);
  });

  it("compaction flow realistically preserves user message from the tail", () => {
    // Realistically verify that a pre-compaction messages array retains the user message
    // after compaction, and that finalize/sanitize properly extracts it for persistence.
    // Simulate compaction by preserving the recent user turn (make me a song)
    const compactedMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "System" },
      {
        role: MESSAGE_ROLES.USER,
        content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX}\nAll history.`,
        isCompactSummary: true,
      },
      { role: MESSAGE_ROLES.USER, content: "make me a song" },
    ];

    // Harness sets originalMessageCount to the length of the compactedMessages list
    const originalMessageCount = compactedMessages.length; // 3

    // During the tool iteration, assistant generates the tool call message
    const currentMessages: TestMessage[] = [
      ...compactedMessages,
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Making your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true },
          },
        ],
      },
    ];

    const newTurnMessages = extractNewTurnMessages(currentMessages, originalMessageCount);
    const sanitized = sanitizeMessagesToAppend(newTurnMessages);

    // The user message should be present in the sanitized messages to append
    const hasUserMessage = sanitized.some(
      (message) => message.role === MESSAGE_ROLES.USER && !message.isCompactSummary,
    );

    expect(hasUserMessage).toBe(true);
    expect(sanitized[0].content).toBe("make me a song");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 7: Finalizer messagesToAppend construction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Finalizer messagesToAppend — what gets $pushed to MongoDB", () => {
  it("agentic path: overrideMessagesToAppend + final assistant message", () => {
    // The Finalizer receives overrideMessagesToAppend (the newTurnMessages from finalize())
    // and appends one more assistant message with the final text + telemetry.
    //
    // DB already has from turn 1: [user1, assistant1]
    // $push: [user2, assistant2_tools, assistant_final]
    // Result: [user1, assistant1, user2, assistant2_tools, assistant_final]

    const overrideMessagesToAppend: TestMessage[] = [
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating your song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true },
          },
        ],
      },
    ];

    // Finalizer appends final assistant
    const finalAssistant: TestMessage = {
      role: MESSAGE_ROLES.ASSISTANT,
      content: "Here's your song! I created a powerful piece about war.",
    };

    const messagesToAppend = [...overrideMessagesToAppend, finalAssistant];
    const sanitized = sanitizeMessagesToAppend(messagesToAppend);

    expect(sanitized).toHaveLength(4);
    expect(sanitized[0].role).toBe(MESSAGE_ROLES.USER);
    expect(sanitized[0].content).toBe("make a song about the war");
    expect(sanitized[1].toolCalls![0].name).toBe("generate_audio");
    expect(sanitized[2].role).toBe(MESSAGE_ROLES.TOOL);
    expect(sanitized[3].content).toBe(
      "Here's your song! I created a powerful piece about war.",
    );
  });

  it("hasIntermediateToolMessages detection prevents duplicate toolCalls on final message", () => {
    const overrideMessagesToAppend: TestMessage[] = [
      { role: MESSAGE_ROLES.USER, content: "make a song" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating!",
        toolCalls: [
          { id: "toolCall-0", name: "generate_audio", args: {}, result: {} },
        ],
      },
    ];

    // Check if any intermediate message has toolCalls
    const hasIntermediateToolMessages = overrideMessagesToAppend.some(
      (message) =>
        message.role === MESSAGE_ROLES.ASSISTANT &&
        message.toolCalls &&
        message.toolCalls.length > 0,
    );

    expect(hasIntermediateToolMessages).toBe(true);

    // When true, the final assistant should NOT include toolCalls
    // (they're already in the intermediate message)
    const finalAssistant: TestMessage = {
      role: MESSAGE_ROLES.ASSISTANT,
      content: "Done!",
      // toolCalls should NOT be included when hasIntermediateToolMessages is true
    };

    expect(finalAssistant.toolCalls).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 8: DB message array after full round-trip
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Full round-trip: DB state after appendAndFinalize", () => {
  it("turn 1 text-only → turn 2 with generate_audio → correct DB state", () => {
    // Simulates the MongoDB document state after each turn

    // === TURN 1 ===
    const dbMessagesAfterTurn1: TestMessage[] = [
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo! What's good?" },
    ];

    // === TURN 2 ===
    // Server processes turn 2, finalize() produces newTurnMessages:
    const turn2AppendMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "I'll create a song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War" },
            result: {
              success: true,
              audioRef: "minio://audio/war.wav",
            },
          },
        ],
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Here's your song about the war!",
      },
    ];

    // $push: { messages: { $each: turn2AppendMessages } }
    const dbMessagesAfterTurn2 = [
      ...dbMessagesAfterTurn1,
      ...turn2AppendMessages,
    ];

    // === VERIFICATION ===
    expect(dbMessagesAfterTurn2).toHaveLength(5);

    // All user messages should be present
    const userMessages = dbMessagesAfterTurn2.filter(
      (message) => message.role === MESSAGE_ROLES.USER,
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].content).toBe("hey whats up");
    expect(userMessages[1].content).toBe("make a song about the war");

    // Tool calls should be present
    const toolCallMessages = dbMessagesAfterTurn2.filter(
      (message) => message.toolCalls && message.toolCalls.length > 0,
    );
    expect(toolCallMessages).toHaveLength(1);
    expect(toolCallMessages[0].toolCalls![0].name).toBe("generate_audio");
    expect(toolCallMessages[0].toolCalls![0].result).toHaveProperty(
      "audioRef",
    );

    // Final assistant message should have the summary text
    const lastMessage =
      dbMessagesAfterTurn2[dbMessagesAfterTurn2.length - 1];
    expect(lastMessage.role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(lastMessage.content).toBe("Here's your song about the war!");
  });

  it("the user's second message should never be a duplicate of the first", () => {
    // Bug symptom: user message 3 shows "hey whats up" instead of "make a song"
    const dbMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo!" },
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Creating!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true },
          },
        ],
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Here it is!",
      },
    ];

    // No two consecutive user messages should have the same content
    const userMessages = dbMessages.filter(
      (message) => message.role === MESSAGE_ROLES.USER,
    );
    for (let index = 1; index < userMessages.length; index++) {
      // Consecutive user messages in a multi-turn conversation
      // should not be identical (would indicate message duplication/replacement bug)
      expect(userMessages[index].content).not.toBe(
        userMessages[index - 1].content,
      );
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  SCENARIO 9: Background Timers & Scheduled Tasks (Eager Append)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("newTurnMessages slice — background timer / scheduled task", () => {
  it("skips eagerly persisted triggering message when _alreadyPersisted is true", () => {
    // Timer fires: DB eagerly appends "🔔 Notification"
    // contextMessages = [system, user1, assistant1, reminderMessage(_alreadyPersisted: true)]
    // originalMessageCount = 4
    // Model responds with "Here's your reminder"
    // currentMessages = [system, user1, assistant1, reminderMessage, assistant2]

    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are a creative assistant." },
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo! What's good?" },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Rodrigo, your 1-minute timer is up!",
        _alreadyPersisted: true,
      },
    ];
    const originalMessageCount = 4;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Should slice from 4 (skipping the reminderMessage) → newTurnMessages is empty!
    expect(newTurnMessages).toHaveLength(0);
  });

  it("handles background execution with intermediate tool calls correctly", () => {
    // Scheduled task runs: DB eagerly appends scheduled task triggering user message
    // originalMessageCount = 1
    // Loop run 1 (tool call): [userTrigger(_alreadyPersisted: true), assistant_tool]
    // Loop run 2 (breaks): [userTrigger, assistant_tool]
    // currentMessages = [userTrigger, assistant_tool]

    const currentMessages: TestMessage[] = [
      {
        role: MESSAGE_ROLES.USER,
        content: "Run database integrity check",
        _alreadyPersisted: true,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Starting database check...",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "run_integrity_check",
            args: {},
            result: { success: true },
          },
        ],
      },
    ];
    const originalMessageCount = 1;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Should slice from 1 (skipping userTrigger) → newTurnMessages contains assistant_tool
    expect(newTurnMessages).toHaveLength(1);
    expect(newTurnMessages[0].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(newTurnMessages[0].content).toBe("Starting database check...");
    expect(newTurnMessages[0].toolCalls![0].name).toBe("run_integrity_check");
  });

  it("defense-in-depth: filters _alreadyPersisted even when originalMessageCount drifts from compaction", () => {
    // Simulates the production bug: auto-compaction or context truncation
    // adjusts originalMessageCount incorrectly, causing the slice to include
    // the already-persisted reminder. The _alreadyPersisted filter catches it.
    //
    // Pre-compaction: [system, user1, assistant1, user2, assistant2, reminder(_ap)]
    // originalMessageCount = 6
    // After compaction: [system, summary, reminder(_ap)]
    // Correct adjusted originalMessageCount = 3 → sliceIndex = 3 (correct)
    // But if compaction math drifts by -1 → originalMessageCount = 2
    // Then sliceIndex = 1 (wrong) and reminder leaks into newTurnMessages

    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are a creative assistant." },
      { role: MESSAGE_ROLES.ASSISTANT, content: "[Conversation summary]" },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Drink water!",
        _alreadyPersisted: true,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Here's your water reminder! 💧",
      },
    ];
    // Simulate the drift: originalMessageCount is wrong (should be 3, but is 2)
    // lastOriginalMessage = currentMessages[2-1] = assistant summary (no _alreadyPersisted)
    // sliceIndex = Math.max(0, 2-1) = 1
    // currentMessages.slice(1) = [summary, reminder(_ap), assistant]
    // Without _alreadyPersisted filter: reminder leaks through → DUPLICATE!
    // With _alreadyPersisted filter: reminder stripped → only [summary, assistant]
    const driftedOriginalMessageCount = 2;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      driftedOriginalMessageCount,
    );

    // The summary is a non-user message so it passes through, plus the assistant
    // But critically, the _alreadyPersisted reminder is STRIPPED
    const hasReminder = newTurnMessages.some(
      (message) => message.content === "🔔 Notification: Drink water!",
    );
    expect(hasReminder).toBe(false);

    // Verify the assistant response IS included
    const hasAssistantResponse = newTurnMessages.some(
      (message) => message.content === "Here's your water reminder! 💧",
    );
    expect(hasAssistantResponse).toBe(true);

    // Also verify sanitizeMessagesToAppend catches it as a second defense layer
    const messagesWithPersisted: TestMessage[] = [
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Drink water!",
        _alreadyPersisted: true,
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Reminder delivered!" },
    ];
    const sanitized = sanitizeMessagesToAppend(messagesWithPersisted);
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].role).toBe(MESSAGE_ROLES.ASSISTANT);
  });

  it("filters multiple _alreadyPersisted messages from recurring cron timers", () => {
    // Recurring cron fires multiple times. Each fires eagerly-appends a notification
    // before the agentic loop. If the context carries history from prior fires,
    // multiple _alreadyPersisted messages may exist in currentMessages.
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are a creative assistant." },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Check build status (iteration 1)",
        _alreadyPersisted: true,
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Build still running..." },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Check build status (iteration 2)",
        _alreadyPersisted: true,
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Build complete! All tests passed." },
    ];
    // originalMessageCount = 5 (all messages were loaded as context)
    const originalMessageCount = 5;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // originalMessageCount = 5, last original is assistant (no _alreadyPersisted)
    // sliceIndex = 4, slice(4) = [last assistant] → 1 message
    expect(newTurnMessages).toHaveLength(1);
    expect(newTurnMessages[0].content).toBe("Build complete! All tests passed.");

    // But if originalMessageCount drifts to 3 (wrong):
    const driftedResult = extractNewTurnMessages(currentMessages, 3);
    // slice(2) → [notification1(filtered), assistant1, notification2(filtered), assistant2]
    // _alreadyPersisted filter strips both notifications
    const hasAnyNotification = driftedResult.some(
      (message) => (message as any)._alreadyPersisted,
    );
    expect(hasAnyNotification).toBe(false);
    // Only assistant messages survive
    expect(driftedResult.every((message) => message.role === MESSAGE_ROLES.ASSISTANT)).toBe(true);
  });

  it("preserves normal user messages while filtering _alreadyPersisted ones", () => {
    // A conversation where the user sent a real message, THEN a timer fired.
    // The real user message must NOT be filtered.
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are a creative assistant." },
      { role: MESSAGE_ROLES.USER, content: "Set a timer for 1 minute" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Timer set!",
        toolCalls: [
          { id: "toolCall-0", name: "set_timer", args: { durationSeconds: 60 }, result: { success: true } },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Your 1-minute timer is up!",
        _alreadyPersisted: true,
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Time's up! Here's your reminder." },
    ];

    // Normal case: originalMessageCount = 4 (everything before the model's response)
    const normalResult = extractNewTurnMessages(currentMessages, 4);
    // sliceIndex = 4 (because last original is _alreadyPersisted)
    // slice(4) → [assistant response]
    expect(normalResult).toHaveLength(1);
    expect(normalResult[0].content).toBe("Time's up! Here's your reminder.");

    // Drifted case: originalMessageCount = 2 (way off)
    const driftedResult = extractNewTurnMessages(currentMessages, 2);
    // slice(1) → [user msg, assistant+tool, notification(_ap filtered), assistant]
    // The REAL user message ("Set a timer...") should NOT be filtered
    const hasRealUserMessage = driftedResult.some(
      (message) => message.content === "Set a timer for 1 minute",
    );
    expect(hasRealUserMessage).toBe(true);

    // The _alreadyPersisted notification MUST be filtered
    const hasNotification = driftedResult.some(
      (message) => message.content === "🔔 Notification: Your 1-minute timer is up!",
    );
    expect(hasNotification).toBe(false);
  });

  it("handles timer fire with multi-iteration agentic tool loop", () => {
    // Timer fires → model makes tool calls across multiple iterations.
    // Only the _alreadyPersisted triggering message should be stripped;
    // all intermediate tool-calling assistant messages must survive.
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are an assistant." },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Run daily backup",
        _alreadyPersisted: true,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Starting backup...",
        toolCalls: [
          { id: "toolCall-0", name: "create_backup", args: {}, result: { success: true } },
        ],
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Verifying backup integrity...",
        toolCalls: [
          { id: "toolCall-1", name: "verify_backup", args: {}, result: { verified: true } },
        ],
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Backup complete and verified! ✅" },
    ];
    // originalMessageCount = 2 (system + notification)
    const originalMessageCount = 2;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // Notification is stripped, all 3 assistant messages survive
    expect(newTurnMessages).toHaveLength(3);
    expect(newTurnMessages.every((message) => message.role === MESSAGE_ROLES.ASSISTANT)).toBe(true);
    expect(newTurnMessages[0].content).toBe("Starting backup...");
    expect(newTurnMessages[0].toolCalls![0].name).toBe("create_backup");
    expect(newTurnMessages[1].content).toBe("Verifying backup integrity...");
    expect(newTurnMessages[2].content).toBe("Backup complete and verified! ✅");
  });

  it("sanitizeMessagesToAppend strips _alreadyPersisted regardless of message content", () => {
    // The sanitizer is the last line of defense. Even if the message doesn't
    // match any content-based filter, _alreadyPersisted alone should cause removal.
    const messagesToAppend: TestMessage[] = [
      {
        role: MESSAGE_ROLES.USER,
        content: "Totally normal looking message",
        _alreadyPersisted: true,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Some tool output",
        _alreadyPersisted: true,
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Final response" },
      { role: MESSAGE_ROLES.USER, content: "Follow-up question" },
    ];

    const sanitized = sanitizeMessagesToAppend(messagesToAppend);
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0].content).toBe("Final response");
    expect(sanitized[1].content).toBe("Follow-up question");
  });

  it("does NOT filter messages that lack _alreadyPersisted (no false positives)", () => {
    // Guard test: messages with notification-like content but WITHOUT
    // _alreadyPersisted must NOT be filtered.
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are a creative assistant." },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: This is a manual user message, not from a timer",
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Got it!" },
    ];
    const originalMessageCount = 1;

    const newTurnMessages = extractNewTurnMessages(
      currentMessages,
      originalMessageCount,
    );

    // The notification-like message does NOT have _alreadyPersisted, so it stays
    const hasNotification = newTurnMessages.some(
      (message) => message.content?.includes("🔔 Notification:"),
    );
    expect(hasNotification).toBe(true);
    // sliceIndex = 0 (system has no _alreadyPersisted), slice(0) = all 3 messages
    expect(newTurnMessages).toHaveLength(3);

    // Same for sanitizer — no false positives
    const sanitized = sanitizeMessagesToAppend(currentMessages.slice(1));
    expect(sanitized).toHaveLength(2);
  });

  it("handles context truncation drift where reminder lands exactly at slice boundary", () => {
    // Edge case: truncation drops messages and the reminder ends up at the
    // exact position where sliceIndex points. Without the filter, it would
    // be the first element in newTurnMessages.
    const currentMessages: TestMessage[] = [
      { role: MESSAGE_ROLES.SYSTEM, content: "You are an assistant." },
      {
        role: MESSAGE_ROLES.USER,
        content: "🔔 Notification: Check deployment status",
        _alreadyPersisted: true,
      },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Deployment is healthy! ✅" },
    ];
    // truncation adjusted originalMessageCount to 2, but last original
    // is the reminder. Index check works here (happy path).
    const correctCount = 2;
    const correctResult = extractNewTurnMessages(currentMessages, correctCount);
    expect(correctResult).toHaveLength(1);
    expect(correctResult[0].content).toBe("Deployment is healthy! ✅");

    // But if originalMessageCount over-corrected to 1:
    // sliceIndex = 0, slice(0) = all messages
    // System msg passes, notification gets filtered, assistant passes
    const overCorrectedResult = extractNewTurnMessages(currentMessages, 1);
    const hasNotification = overCorrectedResult.some(
      (message) => (message as any)._alreadyPersisted,
    );
    expect(hasNotification).toBe(false);
    expect(
      overCorrectedResult.some((message) => message.content === "Deployment is healthy! ✅"),
    ).toBe(true);

    // And if originalMessageCount under-corrected to 3:
    // lastOriginal = currentMessages[2] = assistant (no _alreadyPersisted)
    // sliceIndex = 2, slice(2) = [assistant] → 1 message
    const underCorrectedResult = extractNewTurnMessages(currentMessages, 3);
    expect(underCorrectedResult).toHaveLength(1);
    expect(underCorrectedResult[0].content).toBe("Deployment is healthy! ✅");
  });
});

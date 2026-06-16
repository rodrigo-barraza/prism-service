/**
 * Tests for the fire-and-forget race condition between done event emission
 * and MongoDB persistence in Finalizer.ts.
 *
 * Documents the exact timing issue where:
 *   1. The `done` SSE event fires BEFORE appendAndFinalize writes to DB
 *   2. The client fetches from DB immediately after `done`
 *   3. The DB either has stale data or incomplete data
 *   4. The count-based guard may pass even with wrong content
 *
 * Also tests the Finalizer's message assembly logic.
 */

import { describe, it, expect } from "vitest";
import { swapMessageContent, assembleMessagesToAppend as assembleMessagesToAppendReal } from "../src/services/harnesses/lifecycle/Finalizer.ts";
import { PROMPT_DELIMITERS } from "../src/constants.ts";
import type { MessagePayload } from "../src/services/conversation/types.ts";

type TestMessage = MessagePayload & {
  toolCalls?: any[];
};



// ── Simulate the Finalizer's message assembly ───────────────────

interface FinalizerAssemblyInput {
  overrideMessagesToAppend: TestMessage[];
  finalText: string;
  finalThinking: string;
  images: string[];
  audioRef: string | null;
  toolCalls: any[];
  resolvedModel: string;
  providerName: string;
}

/**
 * Replicates the messagesToAppend assembly & sanitization logic of Finalizer.ts.
 */
function assembleMessagesToAppend(input: FinalizerAssemblyInput): TestMessage[] {
  const messages = assembleMessagesToAppendReal({
    overrideMessagesToAppend: input.overrideMessagesToAppend,
    text: input.finalText,
    thinking: input.finalThinking,
    images: input.images,
    audioReference: input.audioRef,
    toolCalls: input.toolCalls,
    resolvedModel: input.resolvedModel,
    providerName: input.providerName,
  }) as TestMessage[];

  return messages.filter((message) => {
    if (message.role === "user" && typeof message.content === "string") {
      if (message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)) return false;
      if (message.content.startsWith(PROMPT_DELIMITERS.CONVERSATION_SUMMARY)) return false;
      if (message.isCompactSummary === true) return false;
    }
    return true;
  }) as TestMessage[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Finalizer message assembly tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Finalizer message assembly", () => {
  it("correctly assembles messages for a generate_audio tool turn", () => {
    const newTurnMessages: TestMessage[] = [
      { role: "user", content: "make a song about the war" },
      {
        role: "assistant",
        content: "I'll create a song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { title: "War Song" },
            result: {
              success: true,
              audioRef: "minio://audio/war.wav",
            },
          },
        ],
      },
    ];

    const messagesToAppend = assembleMessagesToAppend({
      overrideMessagesToAppend: newTurnMessages,
      finalText: "Here's your song! I hope you enjoy it.",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: "anthropic",
    });

    expect(messagesToAppend).toHaveLength(3);
    expect(messagesToAppend[0].role).toBe("user");
    expect(messagesToAppend[0].content).toBe("make a song about the war");
    expect(messagesToAppend[1].toolCalls![0].name).toBe("generate_audio");
    expect(messagesToAppend[2].content).toBe(
      "Here's your song! I hope you enjoy it.",
    );
    // Final assistant should NOT have toolCalls (hasIntermediateToolMessages = true)
    expect(messagesToAppend[2].toolCalls).toBeUndefined();
  });

  it("does NOT duplicate toolCalls when hasIntermediateToolMessages is true", () => {
    const result = assembleMessagesToAppend({
      overrideMessagesToAppend: [
        { role: "user", content: "search and make audio" },
        {
          role: "assistant",
          content: "Searching...",
          toolCalls: [
            {
              id: "toolCall-0",
              name: "search_web",
              args: {},
              result: { results: [] },
            },
          ],
        },
        {
          role: "assistant",
          content: "Making audio...",
          toolCalls: [
            {
              id: "toolCall-1",
              name: "generate_audio",
              args: {},
              result: { success: true },
            },
          ],
        },
      ],
      finalText: "Done!",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [
        { id: "toolCall-0", name: "search_web", args: {}, result: { results: [] } },
        { id: "toolCall-1", name: "generate_audio", args: {}, result: { success: true } },
      ],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: "anthropic",
    });

    // Final message should NOT have toolCalls since intermediates already have them
    const finalMessage = result[result.length - 1];
    expect(finalMessage.toolCalls).toBeUndefined();
    expect(finalMessage.content).toBe("Done!");
  });

  it("DOES include toolCalls on final message when no intermediate tool messages", () => {
    // This happens with native MCP tool calls that bypass the standard loop
    const result = assembleMessagesToAppend({
      overrideMessagesToAppend: [
        { role: "user", content: "query the database" },
      ],
      finalText: "Query results: ...",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [
        { id: "toolCall-0", name: "mcp_query", args: {}, result: { rows: [] } },
      ],
      resolvedModel: "qwen3-8b",
      providerName: "lm-studio",
    });

    // Final message SHOULD have toolCalls since no intermediate messages
    expect(result).toHaveLength(2);
    const finalMessage = result[result.length - 1];
    expect(finalMessage.toolCalls).toHaveLength(1);
    expect(finalMessage.toolCalls![0].name).toBe("mcp_query");
  });

  it("filters out compaction summary user messages from append", () => {
    const result = assembleMessagesToAppend({
      overrideMessagesToAppend: [
        {
          role: "user",
          content: "[Conversation Summary]\nPrevious context summary.",
          isCompactSummary: true,
        },
        { role: "user", content: "make a song" },
        {
          role: "assistant",
          content: "Making it!",
          toolCalls: [
            { id: "toolCall-0", name: "generate_audio", args: {}, result: {} },
          ],
        },
      ],
      finalText: "Done!",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: "anthropic",
    });

    // Summary should be filtered out
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("make a song");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  done event + appendAndFinalize race condition tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("done event → appendAndFinalize race condition", () => {
  it("documents the timing: done fires before DB write", () => {
    // In Finalizer.ts:
    // Line 328-347: emit({ type: "done" })  ← FIRES FIRST
    // Line 348-493: appendAndFinalize(...)   ← RUNS AFTER (fire-and-forget)

    const timeline: string[] = [];

    // Simulate the Finalizer execution order
    timeline.push("emit_done");
    timeline.push("appendAndFinalize_start");

    // Client receives done, resolves promise
    timeline.push("client_onDone_resolve");

    // Client starts post-stream refresh
    timeline.push("client_fetch_from_db");

    // appendAndFinalize is still running...
    timeline.push("appendAndFinalize_mongodb_write");
    timeline.push("appendAndFinalize_complete");

    // Verify the order
    const doneIndex = timeline.indexOf("emit_done");
    const writeIndex = timeline.indexOf("appendAndFinalize_mongodb_write");
    const fetchIndex = timeline.indexOf("client_fetch_from_db");

    // The client fetch happens BEFORE the MongoDB write
    expect(fetchIndex).toBeLessThan(writeIndex);
    // Done event fires BEFORE the write
    expect(doneIndex).toBeLessThan(writeIndex);
  });

  it("stale DB fetch returns only turn 1 messages", () => {
    // DB state at the time of the first fetch (before appendAndFinalize completes)
    const staleDatabaseMessages: TestMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
    ];

    // Streaming state has 4 messages
    const streamingMessageCount = 4;

    // Count guard catches this
    expect(staleDatabaseMessages.length).toBeLessThan(streamingMessageCount);
  });

  it("after retry, DB should have all messages (if appendAndFinalize succeeded)", () => {
    // DB state after appendAndFinalize completes
    const completeDatabaseMessages: TestMessage[] = [
      { role: "user", content: "hey whats up" },
      { role: "assistant", content: "Hey Rodrigo!" },
      { role: "user", content: "make a song about the war" },
      {
        role: "assistant",
        content: "I'll create a song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {},
            result: { success: true, audioRef: "minio://audio/war.wav" },
          },
        ],
      },
      {
        role: "assistant",
        content: "Here's your song!",
      },
    ];

    // Now filtering through prepareDisplayMessages equivalent
    const displayMessages = completeDatabaseMessages.filter(
      (message) => message.role !== "system" && message.role !== "tool",
    );

    const streamingMessageCount = 4;

    // DB has 5 display messages, streaming has 4 → guard passes
    expect(displayMessages.length).toBeGreaterThanOrEqual(
      streamingMessageCount,
    );

    // All user messages preserved
    const userMessages = displayMessages.filter(
      (message) => message.role === "user",
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].content).toBe("hey whats up");
    expect(userMessages[1].content).toBe("make a song about the war");

    // Tool call preserved
    const toolMessages = displayMessages.filter(
      (message) => message.toolCalls && message.toolCalls.length > 0,
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].toolCalls![0].name).toBe("generate_audio");
    expect(toolMessages[0].toolCalls![0].result).toHaveProperty("audioRef");
  });

  it("count mismatch between streaming (4) and DB (5) is expected and valid", () => {
    // During streaming: messages = [user1, assistant1, user2, assistant2_with_tools_and_final_text]
    //   count = 4 (tool calls merged into single assistant)
    //
    // After DB fetch: messages = [user1, assistant1, user2, assistant2_tools, assistant3_final]
    //   displayCount = 5 (tool calls on separate assistant, final text on another)

    const streamingCount = 4;
    const dbDisplayCount = 5;

    // The guard checks: displayMessages.length < currentCount
    // 5 < 4 → false → guard PASSES → setMessages(displayMessages)
    expect(dbDisplayCount >= streamingCount).toBe(true);

    // This is the CORRECT behavior — more DB messages means the agentic loop
    // split them properly, and the post-refresh should update the display
    // to match the DB's canonical representation.
  });

  describe("Done event emission timeline and async refresh guards", () => {
    interface TimelineEvent {
      timestamp: number;
      event: string;
    }

    function simulateFireAndForget(
      writeDelayMs: number,
    ): {
      appendAndFinalize: () => void;
      events: TimelineEvent[];
      getIsWriteComplete: () => boolean;
    } {
      const events: TimelineEvent[] = [];
      let isWriteComplete = false;

      const appendAndFinalize = () => {
        events.push({ timestamp: Date.now(), event: "appendAndFinalize_start" });
        setTimeout(() => {
          isWriteComplete = true;
          events.push({
            timestamp: Date.now(),
            event: "appendAndFinalize_complete",
          });
        }, writeDelayMs);
      };

      return {
        appendAndFinalize,
        events,
        getIsWriteComplete: () => isWriteComplete,
      };
    }

    function simulateAwaitableAppend(
      writeDelayMs: number,
    ): {
      appendAndFinalize: () => Promise<void>;
      events: TimelineEvent[];
      getIsWriteComplete: () => boolean;
    } {
      const events: TimelineEvent[] = [];
      let isWriteComplete = false;

      const appendAndFinalize = async () => {
        events.push({ timestamp: Date.now(), event: "appendAndFinalize_start" });
        await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
        isWriteComplete = true;
        events.push({
          timestamp: Date.now(),
          event: "appendAndFinalize_complete",
        });
      };

      return {
        appendAndFinalize,
        events,
        getIsWriteComplete: () => isWriteComplete,
      };
    }

    it("BUGGY: done fires before DB write completes", async () => {
      const events: string[] = [];

      const donePromise = new Promise<void>((resolve) => {
        events.push("emit_done");

        const { appendAndFinalize, getIsWriteComplete } =
          simulateFireAndForget(50);
        appendAndFinalize();

        events.push("client_resolve");
        events.push("client_db_fetch");

        expect(getIsWriteComplete()).toBe(false);
        events.push("db_still_stale");

        resolve();
      });

      await donePromise;

      expect(events).toEqual([
        "emit_done",
        "client_resolve",
        "client_db_fetch",
        "db_still_stale",
      ]);
    });

    it("FIXED: persist completes before done event", async () => {
      const events: string[] = [];

      const { appendAndFinalize, getIsWriteComplete } =
        simulateAwaitableAppend(50);

      await appendAndFinalize();
      events.push("persist_complete");
      events.push("emit_done");
      events.push("client_resolve");
      events.push("client_db_fetch");

      expect(getIsWriteComplete()).toBe(true);
      events.push("db_is_current");

      expect(events).toEqual([
        "persist_complete",
        "emit_done",
        "client_resolve",
        "client_db_fetch",
        "db_is_current",
      ]);
    });

    it("Alternative fix: Finalizer returns persist promise", async () => {
      let persistComplete = false;

      const mockFinalizeTextGeneration = async (): Promise<Promise<void>> => {
        const persistPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            persistComplete = true;
            resolve();
          }, 50);
        });

        return persistPromise;
      };

      const persistPromise = await mockFinalizeTextGeneration();
      await persistPromise;

      expect(persistComplete).toBe(true);
    });

    it("count-based guard passes even with wrong content", () => {
      const streamingCount = 4;
      const databaseCount = 4;

      const countGuardBlocks = databaseCount < streamingCount;
      expect(countGuardBlocks).toBe(false);
    });

    it("content-aware guard catches missing user messages", () => {
      interface SimpleMessage {
        role: string;
        content: string;
      }

      const streamingMessages: SimpleMessage[] = [
        { role: "user", content: "hey whats up" },
        { role: "assistant", content: "Hey Rodrigo!" },
        { role: "user", content: "make a song about the war" },
        { role: "assistant", content: "Creating your song!" },
      ];

      const databaseMessages: SimpleMessage[] = [
        { role: "user", content: "hey whats up" },
        { role: "assistant", content: "Hey Rodrigo!" },
        { role: "assistant", content: "Creating!" },
        { role: "assistant", content: "Done!" },
      ];

      expect(databaseMessages.length >= streamingMessages.length).toBe(true);

      const lastStreamingUser = [...streamingMessages]
        .reverse()
        .find((message) => message.role === "user");
      const lastDatabaseUser = [...databaseMessages]
        .reverse()
        .find((message) => message.role === "user");

      expect(lastStreamingUser?.content).toBe("make a song about the war");
      expect(lastDatabaseUser?.content).toBe("hey whats up");

      const contentGuardBlocks =
        lastStreamingUser?.content !== lastDatabaseUser?.content;
      expect(contentGuardBlocks).toBe(true);
    });

    it("improved guard: verify last user message content matches", () => {
      interface SimpleMessage {
        role: string;
        content: string;
      }

      function shouldOverwriteWithDatabaseMessages(
        streamingMessages: SimpleMessage[],
        databaseMessages: SimpleMessage[],
      ): boolean {
        if (databaseMessages.length < streamingMessages.length) {
          return false;
        }

        const lastStreamingUser = [...streamingMessages]
          .reverse()
          .find((message) => message.role === "user");

        if (lastStreamingUser) {
          const databaseUserMessages = databaseMessages
            .filter((message) => message.role === "user")
            .map((message) => message.content);

          if (!databaseUserMessages.includes(lastStreamingUser.content)) {
            return false;
          }
        }

        return true;
      }

      expect(
        shouldOverwriteWithDatabaseMessages(
          [
            { role: "user", content: "hey" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "make a song" },
            { role: "assistant", content: "Creating!" },
          ],
          [
            { role: "user", content: "hey" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "make a song" },
            { role: "assistant", content: "Creating!" },
            { role: "assistant", content: "Done!" },
          ],
        ),
      ).toBe(true);

      expect(
        shouldOverwriteWithDatabaseMessages(
          [
            { role: "user", content: "hey" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "make a song" },
            { role: "assistant", content: "Creating!" },
          ],
          [
            { role: "user", content: "hey" },
            { role: "assistant", content: "Hi!" },
          ],
        ),
      ).toBe(false);

      expect(
        shouldOverwriteWithDatabaseMessages(
          [
            { role: "user", content: "hey" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "make a song" },
            { role: "assistant", content: "Creating!" },
          ],
          [
            { role: "user", content: "hey" },
            { role: "assistant", content: "Hi!" },
            { role: "assistant", content: "Creating!" },
            { role: "assistant", content: "Done!" },
          ],
        ),
      ).toBe(false);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  swapMsgContent tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// swapMessageContent is imported from Finalizer.ts

describe("swapMsgContent — system context injection handling", () => {
  it("swaps injected system context to rawContent", () => {
    const message: TestMessage = {
      role: "user",
      content:
        `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nYou are helpful.\n\n${PROMPT_DELIMITERS.USER_MESSAGE}\nmake a song about the war`,
    };

    swapMessageContent(message);

    expect(message.content).toBe("make a song about the war");
    expect(message.rawContent).toBe(
      `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nYou are helpful.\n\n${PROMPT_DELIMITERS.USER_MESSAGE}\nmake a song about the war`,
    );
  });

  it("swaps Local Time context format", () => {
    const message: TestMessage = {
      role: "user",
      content:
        `${PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX} 2026-05-26T20:00:00-07:00]\n\nhey whats up`,
    };

    swapMessageContent(message);

    expect(message.content).toBe("hey whats up");
    expect(message.rawContent).toContain(PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX);
  });

  it("uses rawContent swap when rawContent has system context prefix", () => {
    // When rawContent already starts with [System Context], the function
    // early-returns — no swap is performed. This prevents double-swapping
    // on messages that were already processed.
    const message: TestMessage = {
      role: "user",
      content: "make a song about the war",
      rawContent:
        `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nContext\n\n${PROMPT_DELIMITERS.USER_MESSAGE}\nmake a song about the war`,
    };

    swapMessageContent(message);

    // No swap — rawContent already has the context prefix
    expect(message.content).toBe("make a song about the war");
    expect(message.rawContent).toContain(PROMPT_DELIMITERS.SYSTEM_CONTEXT);
  });

  it("no-ops when rawContent already has System Context prefix", () => {
    const message: TestMessage = {
      role: "user",
      content: "make a song",
      rawContent: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nAlready swapped`,
    };

    swapMessageContent(message);

    // Should not swap — rawContent already has the system context
    expect(message.content).toBe("make a song");
    expect(message.rawContent).toBe(`${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nAlready swapped`);
  });

  it("does nothing to assistant messages", () => {
    const message: TestMessage = {
      role: "assistant",
      content: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nThis should not be swapped`,
    };

    swapMessageContent(message);

    expect(message.content).toBe(
      `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nThis should not be swapped`,
    );
    expect(message.rawContent).toBeUndefined();
  });

  it("handles messages without system context prefix", () => {
    const message: TestMessage = {
      role: "user",
      content: "simple message",
    };

    swapMessageContent(message);

    expect(message.content).toBe("simple message");
    expect(message.rawContent).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  End-to-end DB state simulation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("End-to-end DB state after generate_audio flow", () => {
  it("full simulation: 2-turn conversation with generate_audio in turn 2", () => {
    // ════════════════════════════════════════════════
    //  TURN 1: Simple text exchange
    // ════════════════════════════════════════════════

    // Client sends: [system, user1]
    // originalMessageCount = 2
    // Iteration 1: text-only → break
    // finalize() slices from 1: [user1]
    // Finalizer appends: [user1, assistant1]
    // DB after turn 1: [user1, assistant1]

    const databaseAfterTurn1: TestMessage[] = [
      {
        role: "user",
        content: "hey whats up",
        rawContent:
          `${PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX} 2026-05-26T20:00:00]\n\nhey whats up`,
      },
      {
        role: "assistant",
        content: "Hey Rodrigo! Not much, just here and ready to help.",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
      },
    ];

    // ════════════════════════════════════════════════
    //  TURN 2: generate_audio tool call
    // ════════════════════════════════════════════════

    // Client sends: [system, user1, assistant1, user2]
    // originalMessageCount = 4
    //
    // Iteration 1: model generates text + generate_audio tool call
    //   assistant2_with_tools pushed to currentMessages
    //   currentMessages = [system, user1, assistant1, user2, assistant2_tools]
    //
    // Iteration 2: model generates final text → breaks
    //   currentMessages unchanged (text-only break)
    //
    // finalize(): newTurnMessages = currentMessages.slice(3)
    //   = [user2, assistant2_tools]
    //
    // Finalizer assembles:
    //   messagesToAppend = [user2, assistant2_tools, assistant_final]

    const turn2NewTurnMessages: TestMessage[] = [
      {
        role: "user",
        content: "make a song about the war",
        rawContent:
          `${PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX} 2026-05-26T20:00:10]\n\nmake a song about the war`,
      },
      {
        role: "assistant",
        content: "I'll create an original song about war!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: {
              title: "Echoes of War",
              duration: 30,
              tracks: [
                { type: "oscillator", waveform: "sawtooth", frequency: 220 },
              ],
            },
            result: {
              success: true,
              audioRef: "minio://generations/audio/echoes-of-war.wav",
              duration: 30,
              sampleRate: 44100,
            },
          },
        ],
      },
    ];

    const turn2AppendMessages = assembleMessagesToAppend({
      overrideMessagesToAppend: turn2NewTurnMessages,
      finalText: "Here's your song! I created 'Echoes of War' — a powerful piece.",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: "anthropic",
    });

    // Apply content swap
    for (const message of turn2AppendMessages) {
      swapMessageContent(message);
    }

    // Simulate $push to DB
    const databaseAfterTurn2 = [
      ...databaseAfterTurn1,
      ...turn2AppendMessages,
    ];

    // ════════════════════════════════════════════════
    //  VERIFICATION
    // ════════════════════════════════════════════════

    // 1. Correct message count
    expect(databaseAfterTurn2).toHaveLength(5);

    // 2. All user messages present with correct content
    const userMessages = databaseAfterTurn2.filter(
      (message) => message.role === "user",
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].content).toBe("hey whats up");
    expect(userMessages[1].content).toBe("make a song about the war");

    // 3. User messages have rawContent with system context
    expect(
      userMessages[0].rawContent?.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT) ||
      userMessages[0].rawContent?.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX)
    ).toBe(true);
    expect(
      userMessages[1].rawContent?.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT) ||
      userMessages[1].rawContent?.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX)
    ).toBe(true);

    // 4. Tool calls preserved
    const toolMessage = databaseAfterTurn2.find(
      (message) => message.toolCalls && message.toolCalls.length > 0,
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.toolCalls![0].name).toBe("generate_audio");
    expect(toolMessage!.toolCalls![0].result).toHaveProperty("audioRef");

    // 5. Audio ref in tool result
    const audioResult = toolMessage!.toolCalls![0].result as Record<
      string,
      unknown
    >;
    expect(audioResult.audioRef).toBe(
      "minio://generations/audio/echoes-of-war.wav",
    );

    // 6. Final assistant has summary text
    const lastMessage = databaseAfterTurn2[databaseAfterTurn2.length - 1];
    expect(lastMessage.role).toBe("assistant");
    expect(lastMessage.content).toContain("Echoes of War");

    // 7. No duplicate user messages
    const uniqueUserContents = new Set(
      userMessages.map((message) => message.content),
    );
    expect(uniqueUserContents.size).toBe(userMessages.length);

    // 8. Message order is correct: user, assistant alternation
    const roles = databaseAfterTurn2.map((message) => message.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
  });
});

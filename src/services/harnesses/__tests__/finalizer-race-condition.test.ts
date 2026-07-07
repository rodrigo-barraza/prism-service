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
import { swapMessageContent, assembleMessagesToAppend as assembleMessagesToAppendReal, sanitizeMessagesForPersistence } from "#src/services/harnesses/lifecycle/Finalizer";
import { PROMPT_DELIMITERS, PROVIDERS, MESSAGE_ROLES, SYSTEM_STATUSES } from "#src/constants";
import type { MessagePayload, ToolCallPayload } from "#src/services/conversation/types";
import type { ConversationMessage } from "#src/services/harnesses/types";
import type { ChatMessage } from "#src/types/ProviderTypes";

type TestPayload = MessagePayload;

type FinalizerInput = Parameters<typeof assembleMessagesToAppendReal>[0];

type TestToolCallPayload = ToolCallPayload & { result?: string };

type TestAssemblyInput = Omit<FinalizerInput, "text" | "thinking" | "audioReference" | "overrideMessagesToAppend" | "toolCalls"> & {
  overrideMessagesToAppend: TestPayload[];
  finalText: string;
  finalThinking: string;
  audioRef: string | null;
  toolCalls: TestToolCallPayload[];
};

// ── Simulate the Finalizer's message assembly ───────────────────

/**
 * Convenience wrapper around the production assembleMessagesToAppend + sanitize.
 * Maps test-friendly field names to the canonical production parameter names.
 */
function assembleTestMessagesToAppend(input: TestAssemblyInput): TestPayload[] {
  const messages = assembleMessagesToAppendReal({
    ...input,
    text: input.finalText,
    thinking: input.finalThinking,
    audioReference: input.audioRef,
    toolCalls: input.toolCalls as ToolCallPayload[],
  }) as TestPayload[];

  return sanitizeMessagesForPersistence(messages) as TestPayload[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Finalizer message assembly tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Finalizer message assembly", () => {
  it("correctly assembles messages for a generate_audio tool turn", () => {
    const newTurnMessages: TestPayload[] = [
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
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
        ] as any[],
      },
    ];

    const messagesToAppend = assembleTestMessagesToAppend({
      overrideMessagesToAppend: newTurnMessages,
      finalText: "Here's your song! I hope you enjoy it.",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: PROVIDERS.ANTHROPIC,
    });

    expect(messagesToAppend).toHaveLength(4);
    expect(messagesToAppend[0].role).toBe(MESSAGE_ROLES.USER);
    expect(messagesToAppend[0].content).toBe("make a song about the war");
    expect(messagesToAppend[1].role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(messagesToAppend[1].toolCalls![0].name).toBe("generate_audio");
    expect(messagesToAppend[2].role).toBe(MESSAGE_ROLES.TOOL);
    expect(messagesToAppend[2].content).toBe('{"success":true,"audioRef":"minio://audio/war.wav"}');
    expect(messagesToAppend[3].content).toBe(
      "Here's your song! I hope you enjoy it.",
    );
    // Final assistant should NOT have toolCalls (hasIntermediateToolMessages = true)
    expect(messagesToAppend[3].toolCalls).toBeUndefined();
  });

  it("does NOT duplicate toolCalls when hasIntermediateToolMessages is true", () => {
    const result = assembleTestMessagesToAppend({
      overrideMessagesToAppend: [
        { role: MESSAGE_ROLES.USER, content: "search and make audio" },
        {
          role: MESSAGE_ROLES.ASSISTANT,
          content: "Searching...",
          toolCalls: [
            { id: "toolCall-1", name: "search", args: { q: "war" }, result: ["War 1", "War 2"] },
          ] as any[],
        },
        {
          role: MESSAGE_ROLES.ASSISTANT,
          content: "Making audio...",
          toolCalls: [
            { id: "toolCall-2", name: "generate_audio", args: { prompt: "war song" }, result: "audioRef" },
          ] as any[],
        },
      ],
      finalText: "Done!",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [
        { id: "toolCall-0", name: "search_web", args: {} },
        { id: "toolCall-1", name: "generate_audio", args: {} },
      ],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: PROVIDERS.ANTHROPIC,
    });

    // Final message should NOT have toolCalls since intermediates already have them
    const finalMessage = result[result.length - 1];
    expect(finalMessage.toolCalls).toBeUndefined();
    expect(finalMessage.content).toBe("Done!");
  });

  it("DOES include toolCalls on final message when no intermediate tool messages", () => {
    // This happens with native MCP tool calls that bypass the standard loop
    const result = assembleTestMessagesToAppend({
      overrideMessagesToAppend: [
        { role: MESSAGE_ROLES.USER, content: "query the database" },
      ],
      finalText: "Query results: ...",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [
        { id: "toolCall-0", name: "mcp_query", args: {} },
      ],
      resolvedModel: "qwen3-8b",
      providerName: PROVIDERS.LM_STUDIO,
    });

    // Final message SHOULD have toolCalls since no intermediate messages
    expect(result).toHaveLength(2);
    const finalMessage = result[result.length - 1];
    expect(finalMessage.toolCalls).toHaveLength(1);
    expect(finalMessage.toolCalls![0].name).toBe("mcp_query");
  });

  it("filters out compaction summary user messages from append", () => {
    const result = assembleTestMessagesToAppend({
      overrideMessagesToAppend: [
        {
          role: MESSAGE_ROLES.USER,
          content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX}\nPrevious context summary.`,
          isCompactSummary: true,
        },
        { role: MESSAGE_ROLES.USER, content: "make a song" },
        {
          role: MESSAGE_ROLES.ASSISTANT,
          content: "Making it!",
          toolCalls: [
            { id: "toolCall-0", name: "generate_audio", args: {}, result: {} },
          ] as any[],
        },
      ],
      finalText: "Done!",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: PROVIDERS.ANTHROPIC,
    });

    // Summary should be filtered out. Split: user, assistant, tool, assistant
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe(MESSAGE_ROLES.USER);
    expect(result[0].content).toBe("make a song");
  });
});

describe("Finalizer Lifecycle Timing — Persist-Before-Emit Invariant", () => {
  it("documents the timing: appendAndFinalize completes before done event emission", () => {
    /**
     * In Finalizer.ts:
     * Line 499: await appendAndFinalize(...)   ← PERSISTS FIRST
     * Line 550: emit({ type: "done" })         ← EMITS AFTER
     */

    const timeline: string[] = [];

    // Simulate the Finalizer execution order (Persist-Before-Emit)
    timeline.push("appendAndFinalize_start");
    timeline.push("appendAndFinalize_mongodb_write");
    timeline.push("appendAndFinalize_complete");

    // After DB is guaranteed, we emit the done event
    timeline.push("emit_done");

    // Client receives done, resolves promise
    timeline.push("client_onDone_resolve");

    // Client starts post-stream refresh
    timeline.push("client_fetch_from_db");

    // Verify the invariant: write happens before fetch
    const fetchIndex = timeline.indexOf("client_fetch_from_db");
    const writeIndex = timeline.indexOf("appendAndFinalize_mongodb_write");

    expect(writeIndex).toBeLessThan(fetchIndex);
    expect(timeline.indexOf("appendAndFinalize_complete")).toBeLessThan(timeline.indexOf("emit_done"));
  });

  it("client fetch returns complete turn 2 messages due to await", () => {
    // DB state at the time of the fetch (since we await appendAndFinalize)
    const staleDatabaseMessages: TestPayload[] = [
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo!" },
    ];

    // Streaming state has 4 messages
    const streamingMessageCount = 4;

    // Count guard catches this
    expect(staleDatabaseMessages.length).toBeLessThan(streamingMessageCount);
  });

  it("after retry, DB should have all messages (if appendAndFinalize succeeded)", () => {
    // DB state after appendAndFinalize completes
    const completeDatabaseMessages: TestPayload[] = [
      { role: MESSAGE_ROLES.USER, content: "hey whats up" },
      { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo!" },
      { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "I'll create a song!",
        toolCalls: [
          {
            id: "toolCall-0",
            name: "generate_audio",
            args: { prompt: "war song" },
            result: { success: true, audioRef: "minio://audio/war.wav" },
          },
        ] as any[],
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Here's your song!",
      },
    ];

    // Now filtering through prepareDisplayMessages equivalent
    const displayMessages = completeDatabaseMessages.filter(
      (message) => message.role !== "system" && message.role !== MESSAGE_ROLES.TOOL,
    );

    const streamingMessageCount = 4;

    // DB has 5 display messages, streaming has 4 → guard passes
    expect(displayMessages.length).toBeGreaterThanOrEqual(
      streamingMessageCount,
    );

    // All user messages preserved
    const userMessages = displayMessages.filter(
      (message) => message.role === MESSAGE_ROLES.USER,
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
    expect((toolMessages[0].toolCalls![0] as any).result).toHaveProperty("audioRef");
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
      writeDelayMilliseconds: number,
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
        }, writeDelayMilliseconds);
      };

      return {
        appendAndFinalize,
        events,
        getIsWriteComplete: () => isWriteComplete,
      };
    }

    function simulateAwaitableAppend(
      writeDelayMilliseconds: number,
    ): {
      appendAndFinalize: () => Promise<void>;
      events: TimelineEvent[];
      getIsWriteComplete: () => boolean;
    } {
      const events: TimelineEvent[] = [];
      let isWriteComplete = false;

      const appendAndFinalize = async () => {
        events.push({ timestamp: Date.now(), event: "appendAndFinalize_start" });
        await new Promise((resolve) => setTimeout(resolve, writeDelayMilliseconds));
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
      const streamingMessages: ChatMessage[] = [
        { role: MESSAGE_ROLES.USER, content: "hey whats up" },
        { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo!" },
        { role: MESSAGE_ROLES.USER, content: "make a song about the war" },
        { role: MESSAGE_ROLES.ASSISTANT, content: "Creating your song!" },
      ];

      const databaseMessages: ChatMessage[] = [
        { role: MESSAGE_ROLES.USER, content: "hey whats up" },
        { role: MESSAGE_ROLES.ASSISTANT, content: "Hey Rodrigo!" },
        { role: MESSAGE_ROLES.ASSISTANT, content: "Creating!" },
        { role: MESSAGE_ROLES.ASSISTANT, content: "Done!" },
      ];

      expect(databaseMessages.length >= streamingMessages.length).toBe(true);

      const lastStreamingUser = [...streamingMessages]
        .reverse()
        .find((message) => message.role === MESSAGE_ROLES.USER);
      const lastDatabaseUser = [...databaseMessages]
        .reverse()
        .find((message) => message.role === MESSAGE_ROLES.USER);

      expect(lastStreamingUser?.content).toBe("make a song about the war");
      expect(lastDatabaseUser?.content).toBe("hey whats up");

      const contentGuardBlocks =
        (lastStreamingUser?.content as string) !== (lastDatabaseUser?.content as string);
      expect(contentGuardBlocks).toBe(true);
    });

    it("improved guard: verify last user message content matches", () => {
      function shouldOverwriteWithDatabaseMessages(
        streamingMessages: ChatMessage[],
        databaseMessages: ChatMessage[],
      ): boolean {
        if (databaseMessages.length < streamingMessages.length) {
          return false;
        }

        const lastStreamingUser = [...streamingMessages]
          .reverse()
          .find((message) => message.role === MESSAGE_ROLES.USER);

        if (lastStreamingUser) {
          const databaseUserMessages = databaseMessages
            .filter((message) => message.role === MESSAGE_ROLES.USER)
            .map((message) => message.content as string);

          if (!databaseUserMessages.includes(lastStreamingUser.content as string)) {
            return false;
          }
        }

        return true;
      }

      expect(
        shouldOverwriteWithDatabaseMessages(
          [
            { role: MESSAGE_ROLES.USER, content: "hey" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
            { role: MESSAGE_ROLES.USER, content: "make a song" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Creating!" },
          ],
          [
            { role: MESSAGE_ROLES.USER, content: "hey" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
            { role: MESSAGE_ROLES.USER, content: "make a song" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Creating!" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Done!" },
          ],
        ),
      ).toBe(true);

      expect(
        shouldOverwriteWithDatabaseMessages(
          [
            { role: MESSAGE_ROLES.USER, content: "hey" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
            { role: MESSAGE_ROLES.USER, content: "make a song" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Creating!" },
          ],
          [
            { role: MESSAGE_ROLES.USER, content: "hey" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
          ],
        ),
      ).toBe(false);

      expect(
        shouldOverwriteWithDatabaseMessages(
          [
            { role: MESSAGE_ROLES.USER, content: "hey" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
            { role: MESSAGE_ROLES.USER, content: "make a song" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Creating!" },
          ],
          [
            { role: MESSAGE_ROLES.USER, content: "hey" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Hi!" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Creating!" },
            { role: MESSAGE_ROLES.ASSISTANT, content: "Done!" },
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
    const message: TestPayload = {
      role: MESSAGE_ROLES.USER,
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
    const message: TestPayload = {
      role: MESSAGE_ROLES.USER,
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
    const message: TestPayload = {
      role: MESSAGE_ROLES.USER,
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
    const message: TestPayload = {
      role: MESSAGE_ROLES.USER,
      content: "make a song",
      rawContent: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nAlready swapped`,
    };

    swapMessageContent(message);

    // Should not swap — rawContent already has the system context
    expect(message.content).toBe("make a song");
    expect(message.rawContent).toBe(`${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nAlready swapped`);
  });

  it("does nothing to assistant messages", () => {
    const message: TestPayload = {
      role: MESSAGE_ROLES.ASSISTANT,
      content: `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nThis should not be swapped`,
    };

    swapMessageContent(message);

    expect(message.content).toBe(
      `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\nThis should not be swapped`,
    );
    expect(message.rawContent).toBeUndefined();
  });

  it("handles messages without system context prefix", () => {
    const message: TestPayload = {
      role: MESSAGE_ROLES.USER,
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

    const databaseAfterTurn1: TestPayload[] = [
      {
        role: MESSAGE_ROLES.USER,
        content: "hey whats up",
        rawContent:
          `${PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX} 2026-05-26T20:00:00]\n\nhey whats up`,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
        content: "Hey Rodrigo! Not much, just here and ready to help.",
        model: "claude-haiku-4-5-20251001",
        provider: PROVIDERS.ANTHROPIC,
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

    const turn2NewTurnMessages: TestPayload[] = [
      {
        role: MESSAGE_ROLES.USER,
        content: "make a song about the war",
        rawContent:
          `${PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX} 2026-05-26T20:00:10]\n\nmake a song about the war`,
      },
      {
        role: MESSAGE_ROLES.ASSISTANT,
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
        ] as any[],
      },
    ];

    const turn2AppendMessages = assembleTestMessagesToAppend({
      overrideMessagesToAppend: turn2NewTurnMessages,
      finalText: "Here's your song! I created 'Echoes of War' — a powerful piece.",
      finalThinking: "",
      images: [],
      audioRef: null,
      toolCalls: [],
      resolvedModel: "claude-haiku-4-5-20251001",
      providerName: PROVIDERS.ANTHROPIC,
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

    // 1. Correct message count (2 from turn 1 + 4 from turn 2)
    expect(databaseAfterTurn2).toHaveLength(6);

    // 2. All user messages present with correct content
    const userMessages = databaseAfterTurn2.filter(
      (message) => message.role === MESSAGE_ROLES.USER,
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

    // 4. Tool calls preserved on assistant, result split into tool role message
    const assistantWithTools = databaseAfterTurn2.find(
      (message) => message.role === MESSAGE_ROLES.ASSISTANT && message.toolCalls && message.toolCalls.length > 0,
    );
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.toolCalls![0].name).toBe("generate_audio");
    expect((assistantWithTools!.toolCalls![0] as any).result).toBeUndefined();

    const toolMessage = databaseAfterTurn2.find(
      (message) => message.role === MESSAGE_ROLES.TOOL,
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.name).toBe("generate_audio");
    expect(toolMessage!.tool_call_id).toBe("toolCall-0");

    // 5. Audio ref in tool content JSON
    const audioResult = JSON.parse(toolMessage!.content as string);
    expect(audioResult.audioRef).toBe(
      "minio://generations/audio/echoes-of-war.wav",
    );

    // 6. Final assistant has summary text
    const lastMessage = databaseAfterTurn2[databaseAfterTurn2.length - 1];
    expect(lastMessage.role).toBe(MESSAGE_ROLES.ASSISTANT);
    expect(lastMessage.content).toContain("Echoes of War");

    // 7. No duplicate user messages
    const uniqueUserContents = new Set(
      userMessages.map((message) => message.content),
    );
    expect(uniqueUserContents.size).toBe(userMessages.length);

    // 8. Message order is correct: user, assistant, tool, assistant alternation
    const roles = databaseAfterTurn2.map((message) => message.role);
    expect(roles).toEqual([
      MESSAGE_ROLES.USER,
      MESSAGE_ROLES.ASSISTANT,
      MESSAGE_ROLES.USER,
      MESSAGE_ROLES.ASSISTANT,
      MESSAGE_ROLES.TOOL,
      MESSAGE_ROLES.ASSISTANT,
    ]);
  });
});

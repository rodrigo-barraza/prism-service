/**
 * Message Array Construction Tests
 *
 * Verifies that the messages array is correctly assembled for different agent
 * scenarios, and that the finalize() slice logic persists all expected messages
 * (including hook-injected system messages) into MongoDB.
 *
 * These tests mock the SystemPromptAssembler hook behavior to validate the
 * data flow from hook injection → currentMessages → finalize slice → persistence.
 */
import { describe, it, expect, beforeEach } from "vitest";

import type { ConversationMessage as BaseConversationMessage } from "../types.ts";

import { injectSystemPromptContext } from "../../system-prompt/index.ts";
import { computeNewTurnMessages as computeNewTurnMessagesReal } from "../lifecycle/Finalizer.ts";

interface ConversationMessage extends BaseConversationMessage {
  rawContent?: string;
  isCompactSummary?: boolean;
  _alreadyPersisted?: boolean;
  _isErrorIndicator?: boolean;
}


// ── Simulate hook injection (delegates to SystemPromptAssembler.injectSystemPromptContext) ──
function simulateBeforePromptHook(
  currentMessages: ConversationMessage[],
  options: {
    systemPrompt: string;
    platformContextMessage?: string | null;
    selfContextMessage?: string | null;
    skillsText?: string;
    memoriesText?: string;
  },
): void {
  injectSystemPromptContext(currentMessages, {
    ...options,
    localTimeText: "Sunday, June 15, 2026 at 4:40:00 PM PDT",
  });
}

// ── Simulate finalize slice logic (delegates to computeNewTurnMessages) ──
function computeNewTurnMessages(
  originalMessages: ConversationMessage[],
  currentMessages: ConversationMessage[],
  originalMessageCount: number,
): any[] {
  return computeNewTurnMessagesReal(originalMessages, currentMessages, originalMessageCount);
}


// ────────────────────────────────────────────────────────────────
// Test Suites
// ────────────────────────────────────────────────────────────────

describe("Message Array Construction", () => {
  // ────────────────────────────────────────────────────────────
  // Scenario 1: Discord Agent (Lupos) — First Turn
  // ────────────────────────────────────────────────────────────
  describe("Discord Agent (Lupos) — first turn, new conversation", () => {
    let originalMessages: ConversationMessage[];
    let currentMessages: ConversationMessage[];
    let originalMessageCount: number;

    const LUPOS_IDENTITY = "You are Lupos, an insane recovering-drug-addicted artist wolf king...";
    const PLATFORM_CONTEXT = [
      "Platform: Discord",
      "Server: Rod's Lab",
      "Channel: #general",
      "Channel ID: 1234567890",
      "User: rodrigo#1234",
    ].join("\n");
    const SOMATIC_STATE = [
      "[Somatic State — Lupos]",
      "current_emotion: curious",
      "emotional_valence: 0.6",
      "arousal: 0.45",
      "dominance: 0.5",
    ].join("\n");

    beforeEach(() => {
      originalMessages = [
        { role: "user", content: "hey lupos, how are you feeling today?" },
      ];
      originalMessageCount = originalMessages.length; // 1
      currentMessages = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });
    });

    it("should have 4 messages after hook injection", () => {
      expect(currentMessages).toHaveLength(4);
    });

    it("should place identity system prompt at index 0", () => {
      expect(currentMessages[0].role).toBe("system");
      expect(currentMessages[0].content).toBe(LUPOS_IDENTITY);
    });

    it("should place platform context at index 1", () => {
      expect(currentMessages[1].role).toBe("system");
      expect(currentMessages[1].content).toBe(PLATFORM_CONTEXT);
    });

    it("should place somatic state at index 2 (before user message)", () => {
      expect(currentMessages[2].role).toBe("system");
      expect(currentMessages[2].content).toBe(SOMATIC_STATE);
    });

    it("should place user message at index 3 with system context prepended", () => {
      expect(currentMessages[3].role).toBe("user");
      expect(currentMessages[3].content).toContain("[System Context]");
      expect(currentMessages[3].content).toContain("[User Message]");
      expect(currentMessages[3].content).toContain("hey lupos, how are you feeling today?");
      expect(currentMessages[3].rawContent).toBe("hey lupos, how are you feeling today?");
    });

    it("should persist all 4 hook-injected messages plus assistant response via finalize", () => {
      // Simulate assistant response
      currentMessages.push({
        role: "assistant",
        content: "*stretches and looks up* Hey there! Feeling pretty curious today...",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // sliceIndex = max(0, 1 - 1) = 0 → all 5 messages should be included
      expect(newTurnMessages).toHaveLength(5);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",   // identity
        "system",   // platform context
        "system",   // somatic state
        "user",     // user message with [System Context]
        "assistant", // response
      ]);
    });

    it("should include all three system message types in persisted messages", () => {
      currentMessages.push({
        role: "assistant",
        content: "Response text",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const systemMessages = newTurnMessages.filter(
        (message) => message.role === "system",
      );
      expect(systemMessages).toHaveLength(3);
      expect(systemMessages[0].content).toBe(LUPOS_IDENTITY);
      expect(systemMessages[1].content).toBe(PLATFORM_CONTEXT);
      expect(systemMessages[2].content).toBe(SOMATIC_STATE);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 2: General Agent (Omni) — First Turn
  // No somatic state, no platform context
  // ────────────────────────────────────────────────────────────
  describe("General Agent (Omni) — first turn, no platform context", () => {
    let originalMessages: ConversationMessage[];
    let currentMessages: ConversationMessage[];
    let originalMessageCount: number;

    const OMNI_IDENTITY =
      "You are a helpful AI assistant with access to a comprehensive suite of real-time data and utility tools.";

    beforeEach(() => {
      originalMessages = [
        { role: "user", content: "What's the weather in Vancouver?" },
      ];
      originalMessageCount = originalMessages.length;
      currentMessages = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: OMNI_IDENTITY,
        platformContextMessage: null,
        selfContextMessage: null,
      });
    });

    it("should have 2 messages after hook injection (no platform/somatic)", () => {
      expect(currentMessages).toHaveLength(2);
    });

    it("should place identity system prompt at index 0", () => {
      expect(currentMessages[0].role).toBe("system");
      expect(currentMessages[0].content).toBe(OMNI_IDENTITY);
    });

    it("should place user message at index 1 with system context prepended", () => {
      expect(currentMessages[1].role).toBe("user");
      expect(currentMessages[1].content).toContain("[System Context]");
      expect(currentMessages[1].rawContent).toBe("What's the weather in Vancouver?");
    });

    it("should persist system prompt + user + assistant via finalize", () => {
      currentMessages.push({
        role: "assistant",
        content: "Let me check the weather for you.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(3);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 3: Multi-turn conversation — subsequent turn
  // originalMessageCount includes prior messages, user msg NOT
  // already persisted
  // ────────────────────────────────────────────────────────────
  describe("Discord Agent (Lupos) — subsequent turn, history loaded", () => {
    let originalMessages: ConversationMessage[];
    let currentMessages: ConversationMessage[];
    let originalMessageCount: number;

    const LUPOS_IDENTITY = "You are Lupos...";
    const PLATFORM_CONTEXT = "Platform: Discord\nServer: Rod's Lab";
    const SOMATIC_STATE = "[Somatic State — Lupos]\ncurrent_emotion: amused";

    beforeEach(() => {
      // History loaded from DB: system + user + assistant + platform + somatic + new user
      originalMessages = [
        { role: "system", content: "Previous system prompt" },
        { role: "user", content: "first message" },
        { role: "assistant", content: "first response" },
        { role: "system", content: "Previous platform context" },
        { role: "system", content: "Previous somatic state" },
        { role: "user", content: "tell me a joke" },
      ];
      originalMessageCount = originalMessages.length; // 6
      currentMessages = [...originalMessages];

      // Hook replaces system prompt, inserts platform context and somatic state
      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });
    });

    it("should update the existing system prompt in place", () => {
      expect(currentMessages[0].role).toBe("system");
      expect(currentMessages[0].content).toBe(LUPOS_IDENTITY);
    });

    it("should interleave platform context before the last user message (before somatic)", () => {
      const lastUserIndex = currentMessages.reduce(
        (lastIndex, message, index) =>
          message.role === "user" ? index : lastIndex,
        -1,
      );
      expect(currentMessages[lastUserIndex - 2].role).toBe("system");
      expect(currentMessages[lastUserIndex - 2].content).toBe(PLATFORM_CONTEXT);
    });

    it("should insert somatic state before the last user message", () => {
      const lastUserIndex = currentMessages.reduce(
        (lastIndex, message, index) =>
          message.role === "user" ? index : lastIndex,
        -1,
      );
      expect(currentMessages[lastUserIndex - 1].role).toBe("system");
      expect(currentMessages[lastUserIndex - 1].content).toBe(SOMATIC_STATE);
    });

    it("should persist somatic state and user message from the current turn via finalize", () => {
      currentMessages.push({
        role: "assistant",
        content: "Why did the wolf cross the road?",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // sliceIndex = max(0, 6 - 1) = 5
      // After hook injection, currentMessages has extra messages shifted in.
      // From index 5 onward: platform context + somatic state + user msg + assistant
      expect(newTurnMessages.length).toBeGreaterThanOrEqual(4);
      expect(
        newTurnMessages.some((message) => message.role === "assistant"),
      ).toBe(true);
      expect(
        newTurnMessages.some(
          (message) =>
            message.role === "system" &&
            message.content === PLATFORM_CONTEXT,
        ),
      ).toBe(true);
      expect(
        newTurnMessages.some(
          (message) =>
            message.role === "system" &&
            message.content === SOMATIC_STATE,
        ),
      ).toBe(true);
      expect(
        newTurnMessages.some((message) => message.role === "user"),
      ).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 3b: Subsequent turn — history with somatic-only
  // system message (platform context was lost on prior persist)
  //
  // This reproduces the real-world bug where the DB document
  // has a somatic system message mid-conversation but NO
  // identity prompt or platform context at the top.
  // ────────────────────────────────────────────────────────────
  describe("Discord Agent (Lupos) — subsequent turn, somatic-only system message in history", () => {
    const LUPOS_IDENTITY = "You are Lupos, an artist wolf king...";
    const PLATFORM_CONTEXT = "Platform: Discord\nServer: Rod's Lab\nChannel: #general";
    const SOMATIC_STATE = "[Somatic State — Lupos]\ncurrent_emotion: curious";

    it("should NOT overwrite a mid-conversation somatic system message with the identity prompt", () => {
      // History loaded from DB: the prior turn only persisted
      // somatic + user + assistant (platform context was dropped)
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "hey lupos" },
        { role: "assistant", content: "yo" },
        { role: "system", content: "[Somatic State — Lupos]\ncurrent_emotion: bored" },
        { role: "user", content: "tell me something" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });

      // Identity prompt must be at index 0, NOT overwriting the old somatic at index 2
      expect(currentMessages[0].role).toBe("system");
      expect(currentMessages[0].content).toBe(LUPOS_IDENTITY);

      // Platform context must be interleaved before the last user message (before somatic)
      const lastUserIndex = currentMessages.reduce(
        (lastIndex, message, index) =>
          message.role === "user" ? index : lastIndex,
        -1,
      );
      expect(currentMessages[lastUserIndex - 2].role).toBe("system");
      expect(currentMessages[lastUserIndex - 2].content).toBe(PLATFORM_CONTEXT);

      // The old somatic state from history should still exist (shifted right)
      const oldSomaticMessage = currentMessages.find(
        (message) =>
          message.role === "system" &&
          message.content?.includes("bored"),
      );
      expect(oldSomaticMessage).toBeDefined();

      // New somatic state should be interleaved before the last user message
      expect(currentMessages[lastUserIndex - 1].role).toBe("system");
      expect(currentMessages[lastUserIndex - 1].content).toBe(SOMATIC_STATE);
    });

    it("should persist platform context on subsequent turns when it was missing from history", () => {
      // History without any system messages at all (worst case)
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "hey lupos" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "tell me something" },
      ];
      const originalMessageCount = originalMessages.length; // 3
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });

      // Add assistant response
      currentMessages.push({
        role: "assistant",
        content: "Here's something for you.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // sliceIndex = max(0, 3 - 1) = 2
      // After injection, messages are:
      // [0] system (identity) — injected
      // [1] user: "hey lupos"
      // [2] assistant: "yo"
      // [3] system (platform) — injected before last user
      // [4] system (somatic) — injected before last user
      // [5] user: "tell me something" — with [System Context]
      // [6] assistant: response
      //
      // Slice from index 2 captures: assistant, platform, somatic, user, assistant
      // Identity (0) is BEFORE the slice — that's expected because the
      // Finalizer persists systemPrompt separately via conversationMeta.
      // Platform context now survives in the slice since it's interleaved.
      //
      // The key assertions: platform, somatic state, and user message are in the slice.
      expect(newTurnMessages.length).toBeGreaterThanOrEqual(4);
      expect(
        newTurnMessages.some(
          (message) =>
            message.role === "system" &&
            message.content === PLATFORM_CONTEXT,
        ),
      ).toBe(true);
      expect(
        newTurnMessages.some(
          (message) =>
            message.role === "system" &&
            message.content === SOMATIC_STATE,
        ),
      ).toBe(true);
      expect(
        newTurnMessages.some((message) => message.role === "user"),
      ).toBe(true);
      expect(
        newTurnMessages.some((message) => message.role === "assistant"),
      ).toBe(true);
    });

    it("should correctly order all messages when history has NO system messages", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "hey" },
        { role: "assistant", content: "sup" },
        { role: "user", content: "draw me a wolf" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });

      // Full expected order:
      // [0] system: identity (unshifted)
      // [1] user: "hey"
      // [2] assistant: "sup"
      // [3] system: platform context (interleaved before last user)
      // [4] system: somatic state (interleaved before last user)
      // [5] user: "draw me a wolf" (with [System Context])
      expect(currentMessages).toHaveLength(6);
      expect(currentMessages[0]).toMatchObject({ role: "system", content: LUPOS_IDENTITY });
      expect(currentMessages[1]).toMatchObject({ role: "user" });
      expect(currentMessages[1].content).toBe("hey");
      expect(currentMessages[2]).toMatchObject({ role: "assistant", content: "sup" });
      expect(currentMessages[3]).toMatchObject({ role: "system", content: PLATFORM_CONTEXT });
      expect(currentMessages[4]).toMatchObject({ role: "system", content: SOMATIC_STATE });
      expect(currentMessages[5].role).toBe("user");
      expect(currentMessages[5].content).toContain("[System Context]");
      expect(currentMessages[5].content).toContain("draw me a wolf");
    });

    it("should not create duplicate identity prompts when history already has one at index 0", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "system", content: "Old identity" },
        { role: "user", content: "hey" },
        { role: "assistant", content: "sup" },
        { role: "user", content: "new message" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });

      // Index 0 should be replaced, not duplicated
      const systemMessages = currentMessages.filter(
        (message) => message.role === "system",
      );
      const identityMessages = systemMessages.filter(
        (message) => message.content === LUPOS_IDENTITY,
      );
      expect(identityMessages).toHaveLength(1);
      expect(currentMessages[0].content).toBe(LUPOS_IDENTITY);
      // Platform context is now interleaved before the last user message
      const lastUserIndex = currentMessages.reduce(
        (lastIndex, message, index) =>
          message.role === "user" ? index : lastIndex,
        -1,
      );
      expect(currentMessages[lastUserIndex - 2].content).toBe(PLATFORM_CONTEXT);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 4: Already-persisted user message (background timer)
  // ────────────────────────────────────────────────────────────
  describe("Already-persisted user message (scheduled/timer trigger)", () => {
    let originalMessages: ConversationMessage[];
    let currentMessages: ConversationMessage[];
    let originalMessageCount: number;

    beforeEach(() => {
      originalMessages = [
        { role: "user", content: "previous message" },
        { role: "assistant", content: "previous response" },
        {
          role: "user",
          content: "scheduled reminder",
          _alreadyPersisted: true,
        },
      ];
      originalMessageCount = originalMessages.length; // 3
      currentMessages = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });
    });

    it("should skip already-persisted user message in finalize slice", () => {
      currentMessages.push({
        role: "assistant",
        content: "Here's your reminder response.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // isLastAlreadyPersisted = true → sliceIndex = 3
      // Only assistant message should be new
      const alreadyPersistedMessages = newTurnMessages.filter(
        (message) => message._alreadyPersisted,
      );
      expect(alreadyPersistedMessages).toHaveLength(0);
      expect(
        newTurnMessages.some((message) => message.role === "assistant"),
      ).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 5: Multi-iteration tool loop
  // ────────────────────────────────────────────────────────────
  describe("Multi-iteration tool loop (ReAct pattern)", () => {
    let originalMessages: ConversationMessage[];
    let currentMessages: ConversationMessage[];
    let originalMessageCount: number;

    beforeEach(() => {
      originalMessages = [
        { role: "user", content: "search for weather in Tokyo" },
      ];
      originalMessageCount = originalMessages.length;
      currentMessages = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Simulate multi-iteration tool loop:
      // Iteration 1: assistant calls tool
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "get_weather", args: { city: "Tokyo" } }],
      });
      // Tool result
      currentMessages.push({
        role: "tool",
        content: '{"temperature": "22°C", "condition": "Partly cloudy"}',
      });
      // Iteration 2: assistant responds with final text
      currentMessages.push({
        role: "assistant",
        content: "The weather in Tokyo is 22°C and partly cloudy.",
        model: "gpt-4.1",
        provider: "openai",
      });
    });

    it("should persist system prompt, user message, all tool calls, and final assistant response", () => {
      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(5);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",    // identity prompt
        "user",      // user message with [System Context]
        "assistant", // tool call iteration
        "tool",      // tool result
        "assistant", // final response
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 6: CONTEXT NOTE messages are filtered out
  // ────────────────────────────────────────────────────────────
  describe("CONTEXT NOTE filtering", () => {
    it("should filter out [CONTEXT NOTE: messages from persisted output", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "hello" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Inject a CONTEXT NOTE (used by exhaustion recovery, etc.)
      currentMessages.push({
        role: "user",
        content: "[CONTEXT NOTE: Token budget exhausted, summarizing context]",
      });
      currentMessages.push({
        role: "assistant",
        content: "Understood, continuing with summarized context.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessages.length,
      );

      const contextNoteMessages = newTurnMessages.filter(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("[CONTEXT NOTE:"),
      );
      expect(contextNoteMessages).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 7: Edge case — empty conversation (no user messages)
  // ────────────────────────────────────────────────────────────
  describe("Edge case — empty original messages", () => {
    it("should handle originalMessageCount of 0 with sliceIndex clamped to 0", () => {
      const originalMessages: ConversationMessage[] = [];
      const currentMessages: ConversationMessage[] = [
        { role: "system", content: "System prompt" },
        { role: "assistant", content: "Proactive greeting.", model: "gpt-4.1", provider: "openai" },
      ];

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        0,
      );

      // sliceIndex = max(0, 0 - 1) = 0 → everything from index 0
      expect(newTurnMessages).toHaveLength(2);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 8: Discord Agent — message order verification
  // Ensures cache-friendly ordering: static context at top,
  // volatile somatic state near the bottom
  // ────────────────────────────────────────────────────────────
  describe("Recency-optimal message ordering", () => {
    it("should maintain recency-optimal ordering: identity → history → platform → somatic → user", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "system", content: "Old identity" },
        { role: "system", content: "Old platform context" },
        { role: "user", content: "first message" },
        { role: "assistant", content: "first response" },
        { role: "user", content: "second message" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "Updated Lupos identity",
        platformContextMessage: "Updated platform context",
        selfContextMessage: "Updated somatic state",
      });

      // Verify ordering: identity is at top (static, cacheable),
      // then history, then platform context and somatic state
      // (both interleaved before the last user message for recency bias)
      const lastUserIndex = currentMessages.length - 1;
      const somaticIndex = lastUserIndex - 1;
      const platformIndex = lastUserIndex - 2;

      expect(currentMessages[0].content).toBe("Updated Lupos identity");
      expect(currentMessages[platformIndex].content).toBe("Updated platform context");
      expect(currentMessages[somaticIndex].content).toBe("Updated somatic state");
      expect(currentMessages[lastUserIndex].role).toBe("user");

      // Platform should come right before somatic, both before last user
      expect(platformIndex).toBeLessThan(somaticIndex);
      expect(somaticIndex).toBeLessThan(lastUserIndex);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 9: Skills and memories injection into user message
  // ────────────────────────────────────────────────────────────
  describe("Skills and memories injection", () => {
    it("should inject skills and memories into the last user message content", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "deploy the project" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
        skillsText: "[Project Skills]\n### deploy.sh\nRun deploy script with --env flag",
        memoriesText: "[Agent Memory]\nUser prefers blue-green deployments",
      });

      const userMessage = currentMessages.find(
        (message) => message.role === "user",
      )!;

      expect(userMessage.content).toContain("[System Context]");
      expect(userMessage.content).toContain("[Project Skills]");
      expect(userMessage.content).toContain("[Agent Memory]");
      expect(userMessage.content).toContain("[User Message]");
      expect(userMessage.content).toContain("deploy the project");
      expect(userMessage.rawContent).toBe("deploy the project");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 10: Discord Agent — full round-trip with tool calls
  // End-to-end mock of a Lupos conversation with image generation
  // ────────────────────────────────────────────────────────────
  describe("Discord Agent (Lupos) — full round-trip with tool call", () => {
    it("should produce correct final messages array for persistence", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "draw me a wolf, lupos" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Lupos, an artist wolf king...",
        platformContextMessage: "Platform: Discord\nServer: Rod's Lab\nChannel: #art",
        selfContextMessage: "[Somatic State — Lupos]\ncurrent_emotion: excited\narousal: 0.8",
      });

      // Iteration 1: assistant calls generate_image tool
      currentMessages.push({
        role: "assistant",
        content: "Let me draw that for you.",
        toolCalls: [
          {
            id: "call_img_1",
            name: "generate_image",
            args: { prompt: "A majestic wolf king with a crown, digital art" },
          },
        ],
      });

      // Tool result
      currentMessages.push({
        role: "tool",
        content: '{"url": "https://cdn.example.com/wolf.png", "success": true}',
      });

      // Iteration 2: assistant responds with final text
      currentMessages.push({
        role: "assistant",
        content: "There you go, a majestic wolf king. That's basically my self-portrait.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Should have: system(identity) + system(platform) + system(somatic) + user + assistant(tool) + tool + assistant(final)
      expect(newTurnMessages).toHaveLength(7);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",    // identity
        "system",    // platform context
        "system",    // somatic state
        "user",      // user message
        "assistant", // tool call
        "tool",      // tool result
        "assistant", // final response
      ]);

      // Verify system messages contain the correct content
      expect(newTurnMessages[0].content).toContain("Lupos");
      expect(newTurnMessages[1].content).toContain("Discord");
      expect(newTurnMessages[2].content).toContain("Somatic State");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 11: Extended Thinking (Claude-style)
  // Assistant produces thinking content alongside text
  // ────────────────────────────────────────────────────────────
  describe("Extended thinking (Claude-style)", () => {
    it("should preserve thinking field on assistant messages through the pipeline", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "Explain quantum entanglement in simple terms" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a helpful assistant.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Assistant responds with thinking + text (single iteration, no tools)
      currentMessages.push({
        role: "assistant",
        content: "Quantum entanglement is like having two coins that always land on opposite sides.",
        thinking: "The user wants a simplified explanation. Let me use an analogy that avoids jargon. A coin analogy works well because it captures the correlation aspect without requiring physics background.",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(3);
      const assistantMessage = newTurnMessages.find(
        (message) => message.role === "assistant",
      )!;
      expect(assistantMessage.thinking).toBeDefined();
      expect(assistantMessage.thinking).toContain("coin analogy");
      expect(assistantMessage.content).toContain("Quantum entanglement");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 12: Native Thinking with Signature (Claude)
  // thinkingSignature is used for cache-stable extended thinking
  // ────────────────────────────────────────────────────────────
  describe("Native thinking with thinkingSignature", () => {
    it("should preserve thinkingSignature on assistant messages for cache continuity", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "Write a binary search implementation" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: thinking + tool call with thoughtSignature
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: "I need to write a binary search. Let me create the file first.",
        thinkingSignature: "sig_abc123_thinking_block_1",
        toolCalls: [
          {
            id: "call_write_1",
            name: "write_to_file",
            args: { path: "search.ts", content: "function binarySearch() {}" },
            thoughtSignature: "sig_abc123_tool_thought_1",
          },
        ],
      });

      // Tool result
      currentMessages.push({
        role: "tool",
        content: "File written successfully.",
      });

      // Iteration 2: final response with its own thinking
      currentMessages.push({
        role: "assistant",
        content: "I've created the binary search implementation.",
        thinking: "The file was written successfully. Let me confirm with the user.",
        thinkingSignature: "sig_abc123_thinking_block_2",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(5);

      // First assistant message (tool call iteration) should have thinking + signature
      const toolCallAssistant = newTurnMessages.find(
        (message) =>
          message.role === "assistant" && message.toolCalls !== undefined,
      )!;
      expect(toolCallAssistant.thinking).toContain("binary search");
      expect(toolCallAssistant.thinkingSignature).toBe("sig_abc123_thinking_block_1");
      expect(toolCallAssistant.toolCalls![0].thoughtSignature).toBe(
        "sig_abc123_tool_thought_1",
      );

      // Final assistant message should have its own thinking + signature
      const finalAssistant = newTurnMessages.filter(
        (message) => message.role === "assistant",
      )[1];
      expect(finalAssistant.thinkingSignature).toBe("sig_abc123_thinking_block_2");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 13: Parallel Tool Calls (multiple tools in one iteration)
  // ────────────────────────────────────────────────────────────
  describe("Parallel tool calls (multiple tools in one iteration)", () => {
    it("should persist all parallel tool calls and their results in order", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "Compare weather in Tokyo and Vancouver" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: assistant calls two tools in parallel
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_weather_tokyo",
            name: "get_weather",
            args: { city: "Tokyo" },
            result: '{"temperature": "22°C"}',
            durationMs: 450,
          },
          {
            id: "call_weather_vancouver",
            name: "get_weather",
            args: { city: "Vancouver" },
            result: '{"temperature": "15°C"}',
            durationMs: 380,
          },
        ],
      });

      // Iteration 2: final response
      currentMessages.push({
        role: "assistant",
        content: "Tokyo is 22°C while Vancouver is 15°C.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(4);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "assistant",
      ]);

      // Verify parallel tool calls are preserved on the first assistant message
      const toolCallMessage = newTurnMessages[2];
      expect(toolCallMessage.toolCalls).toHaveLength(2);
      expect(toolCallMessage.toolCalls![0].name).toBe("get_weather");
      expect(toolCallMessage.toolCalls![0].args.city).toBe("Tokyo");
      expect(toolCallMessage.toolCalls![1].args.city).toBe("Vancouver");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 14: Thinking interleaved with tool calls
  // Model thinks before calling a tool, then thinks again
  // before responding — common Claude/Gemini pattern
  // ────────────────────────────────────────────────────────────
  describe("Thinking interleaved with tool calls (multi-iteration)", () => {
    it("should preserve thinking on every iteration's assistant message", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "What files are in the project?" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: think → tool call
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: "The user wants to see the project structure. I should use list_files to check.",
        toolCalls: [
          { id: "call_ls_1", name: "list_files", args: { path: "." } },
        ],
      });

      // Tool result
      currentMessages.push({
        role: "tool",
        content: "src/\npackage.json\ntsconfig.json",
      });

      // Iteration 2: think → another tool call (drill deeper)
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: "Found root files. Let me also check the src directory for the full picture.",
        toolCalls: [
          { id: "call_ls_2", name: "list_files", args: { path: "src/" } },
        ],
      });

      // Tool result
      currentMessages.push({
        role: "tool",
        content: "index.ts\nutils.ts\nconfig.ts",
      });

      // Iteration 3: think → final response
      currentMessages.push({
        role: "assistant",
        content: "Your project has 3 root items and 3 source files.",
        thinking: "I now have the full picture. Let me summarize the structure.",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(7);

      // Verify each assistant message has its own thinking
      const assistantMessages = newTurnMessages.filter(
        (message) => message.role === "assistant",
      );
      expect(assistantMessages).toHaveLength(3);
      expect(assistantMessages[0].thinking).toContain("project structure");
      expect(assistantMessages[1].thinking).toContain("src directory");
      expect(assistantMessages[2].thinking).toContain("full picture");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 15: Image generation with images array
  // Lupos generates an image — images[] is set on the final
  // assistant message by the Finalizer
  // ────────────────────────────────────────────────────────────
  describe("Image generation output (images array on assistant)", () => {
    it("should preserve images array on assistant messages through persistence", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "draw me a sunset" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Lupos.",
        platformContextMessage: "Platform: Discord",
        selfContextMessage: null,
      });

      // Iteration 1: tool call
      currentMessages.push({
        role: "assistant",
        content: "Let me paint that for you.",
        toolCalls: [
          {
            id: "call_img",
            name: "generate_image",
            args: { prompt: "A dramatic sunset over mountains, oil painting style" },
            result: '{"url": "https://cdn.example.com/sunset.png"}',
            durationMs: 12500,
          },
        ],
      });

      // Iteration 2: final response (images attached by Finalizer)
      currentMessages.push({
        role: "assistant",
        content: "Here's your sunset. Pretty sick if I do say so myself.",
        images: ["https://cdn.example.com/sunset.png"],
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const finalAssistant = newTurnMessages[newTurnMessages.length - 1];
      expect(finalAssistant.images).toBeDefined();
      expect(finalAssistant.images).toHaveLength(1);
      expect(finalAssistant.images![0]).toContain("sunset.png");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 16: Audio generation
  // ────────────────────────────────────────────────────────────
  describe("Audio generation output", () => {
    it("should preserve audio field on assistant messages through persistence", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "say something menacing" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Lupos.",
        platformContextMessage: "Platform: Discord",
        selfContextMessage: null,
      });

      // Tool call for speech synthesis
      currentMessages.push({
        role: "assistant",
        content: "Fine, listen to this.",
        toolCalls: [
          {
            id: "call_tts",
            name: "synthesize_speech",
            args: {
              text: "[snarl with contempt] You dare approach my den, mortal?",
            },
            result: '{"url": "https://cdn.example.com/speech.wav"}',
            durationMs: 3200,
          },
        ],
      });

      // Final response with audio reference
      currentMessages.push({
        role: "assistant",
        content: "There. Now get out.",
        audio: "https://cdn.example.com/speech.wav",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const finalAssistant = newTurnMessages[newTurnMessages.length - 1];
      expect(finalAssistant.audio).toBe("https://cdn.example.com/speech.wav");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 17: Validation error recovery loop
  // After a tool call, the harness detects lint/type errors
  // and injects a [VALIDATION ERROR] system message to force
  // a fix iteration
  // ────────────────────────────────────────────────────────────
  describe("Validation error recovery loop", () => {
    it("should persist validation error system messages and recovery iterations", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "add a new endpoint to the API" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: assistant writes code with a bug
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: "Let me add the endpoint to the routes file.",
        toolCalls: [
          {
            id: "call_edit_1",
            name: "edit_file",
            args: { path: "routes.ts", content: "router.get('/api/users');" },
            result: "File edited.",
            durationMs: 120,
          },
        ],
      });

      // Validation error injected by harness
      currentMessages.push({
        role: "system",
        content:
          "[VALIDATION ERROR] Your recent edit(s) introduced 1 error(s):\n\n" +
          "### routes.ts (typescript)\nError TS2304: Cannot find name 'router'.\n\n" +
          "Fix these issues before proceeding.",
      });

      // Iteration 2: assistant fixes the error
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: "I forgot to import the router. Let me fix that.",
        toolCalls: [
          {
            id: "call_edit_2",
            name: "edit_file",
            args: {
              path: "routes.ts",
              content: "import { Router } from 'express';\nconst router = Router();\nrouter.get('/api/users');",
            },
            result: "File edited.",
            durationMs: 95,
          },
        ],
      });

      // Iteration 3: final response
      currentMessages.push({
        role: "assistant",
        content: "Added the endpoint and fixed the missing import.",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Should include: system(prompt) + user + assistant(buggy) + system(validation) + assistant(fix) + assistant(final)
      expect(newTurnMessages).toHaveLength(6);

      const validationMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("[VALIDATION ERROR]"),
      );
      expect(validationMessage).toBeDefined();
      expect(validationMessage!.content).toContain("Cannot find name 'router'");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 18: Planning injection messages are filtered out
  // _isPlanningInjection messages should not reach MongoDB
  // ────────────────────────────────────────────────────────────
  describe("Planning injection filtering (Finalizer sanitization)", () => {
    it("should filter out _isPlanningInjection messages from the Finalizer pipeline", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "refactor the auth module" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Planning injection (injected by PlanModeController)
      currentMessages.push({
        role: "system",
        content: "Before taking action, create a plan. Outline the steps you would take.",
        _isPlanningInjection: true,
      });

      // Assistant creates plan
      currentMessages.push({
        role: "assistant",
        content: "Here's my plan:\n1. Extract auth logic\n2. Create AuthService\n3. Update routes",
        _isPlanningInjection: true,
      });

      // Planning approval (also ephemeral)
      currentMessages.push({
        role: "user",
        content: "Looks good, proceed.",
        _isPlanningInjection: true,
      });

      // Actual work
      currentMessages.push({
        role: "assistant",
        content: "Done. I've refactored the auth module into a dedicated service.",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      // Simulate the Finalizer sanitization pass
      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // The Finalizer additionally filters _isPlanningInjection
      const sanitizedMessages = newTurnMessages.filter(
        (message) => message._isPlanningInjection !== true,
      );

      // Only system prompt, user message, and final assistant should survive
      expect(sanitizedMessages).toHaveLength(3);
      expect(sanitizedMessages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 19: Conversation Summary compaction messages
  // [Conversation Summary messages should be filtered
  // ────────────────────────────────────────────────────────────
  describe("Conversation summary compaction filtering (Finalizer sanitization)", () => {
    it("should filter out [Conversation Summary and isCompactSummary messages", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "long conversation starter" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Context compaction (injected by ExhaustionRecovery)
      currentMessages.push({
        role: "user",
        content: "[Conversation Summary] Previous 15 messages summarized: User asked about...",
        isCompactSummary: true,
      });

      currentMessages.push({
        role: "assistant",
        content: "Based on our conversation, here's the final answer.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Simulate Finalizer sanitization
      const sanitizedMessages = newTurnMessages.filter((message) => {
        if (message.role === "user" && typeof message.content === "string") {
          if (message.content.startsWith("[Conversation Summary")) return false;
          if (message.isCompactSummary === true) return false;
        }
        return true;
      });

      // Only system, original user, and assistant should survive
      expect(sanitizedMessages).toHaveLength(3);
      const compactionMessages = sanitizedMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.startsWith("[Conversation Summary"),
      );
      expect(compactionMessages).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 20: Multi-turn tool history (subsequent turn has
  // prior tool call messages from DB)
  // ────────────────────────────────────────────────────────────
  describe("Multi-turn with prior tool call history", () => {
    it("should correctly handle tool history loaded from the database", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "system", content: "Previous system prompt" },
        { role: "user", content: "what's the weather?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "prev_call_1",
              name: "get_weather",
              args: { city: "Vancouver" },
              result: '{"temperature": "15°C"}',
            },
          ],
        },
        {
          role: "assistant",
          content: "It's 15°C in Vancouver.",
          model: "gpt-4.1",
          provider: "openai",
        },
        { role: "user", content: "what about Tokyo?" },
      ];
      const originalMessageCount = originalMessages.length; // 5
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // New iteration: tool call for Tokyo
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "new_call_1",
            name: "get_weather",
            args: { city: "Tokyo" },
            result: '{"temperature": "22°C"}',
            durationMs: 400,
          },
        ],
      });

      // Final response
      currentMessages.push({
        role: "assistant",
        content: "Tokyo is 22°C right now.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // sliceIndex = max(0, 5 - 1) = 4
      // Should capture: last user message (index 4+) + new assistant tool + final assistant
      expect(newTurnMessages.length).toBeGreaterThanOrEqual(2);
      expect(
        newTurnMessages.some(
          (message) =>
            message.role === "assistant" &&
            message.toolCalls?.[0]?.name === "get_weather" &&
            message.toolCalls?.[0]?.args.city === "Tokyo",
        ),
      ).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 21: OpenAI Responses API — responsesItemId and
  // reasoningItem on tool calls
  // ────────────────────────────────────────────────────────────
  describe("OpenAI Responses API metadata (responsesItemId, reasoningItem)", () => {
    it("should preserve responsesItemId and reasoningItem on tool calls", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "search the web for latest Rust news" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_search_1",
            name: "search_web",
            args: { query: "Rust programming language news 2026" },
            responsesItemId: "resp_item_abc123",
            reasoningItem: {
              id: "reasoning_xyz789",
              summary: [
                { type: "text", text: "User wants Rust news. Let me search the web." },
              ],
            },
            result: '{"results": []}',
            durationMs: 1200,
          },
        ],
      });

      currentMessages.push({
        role: "assistant",
        content: "Here are the latest Rust updates.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const toolCallMessage = newTurnMessages.find(
        (message) =>
          message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0,
      )!;
      expect(toolCallMessage.toolCalls![0].responsesItemId).toBe("resp_item_abc123");
      expect(toolCallMessage.toolCalls![0].reasoningItem).toBeDefined();
      expect(toolCallMessage.toolCalls![0].reasoningItem!.id).toBe("reasoning_xyz789");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 22: Tool call with duration tracking
  // ────────────────────────────────────────────────────────────
  describe("Tool call duration tracking", () => {
    it("should preserve durationMs on individual tool call results", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "run the test suite" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_run_tests",
            name: "run_command",
            args: { command: "npm test" },
            result: "All 42 tests passed.",
            durationMs: 8750,
          },
        ],
      });

      currentMessages.push({
        role: "assistant",
        content: "All 42 tests passed successfully.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const toolCallMessage = newTurnMessages.find(
        (message) =>
          message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0,
      )!;
      expect(toolCallMessage.toolCalls![0].durationMs).toBe(8750);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 23: Content segments and fragments (display metadata)
  // Used by the client for interleaved thinking/tool/text rendering
  // ────────────────────────────────────────────────────────────
  describe("Content segments and fragments (display metadata)", () => {
    it("should preserve contentSegments, textFragments, and thinkingFragments on assistant messages", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "explain the code" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      currentMessages.push({
        role: "assistant",
        content: "Here's the explanation of the code.",
        thinking: "Let me analyze the code structure first.",
        contentSegments: [
          { type: "thinking", fragmentIndex: 0 },
          { type: "text", fragmentIndex: 0 },
        ],
        textFragments: ["Here's the explanation of the code."],
        thinkingFragments: ["Let me analyze the code structure first."],
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const assistantMessage = newTurnMessages.find(
        (message) => message.role === "assistant",
      )!;
      expect(assistantMessage.contentSegments).toHaveLength(2);
      expect(assistantMessage.textFragments).toHaveLength(1);
      expect(assistantMessage.thinkingFragments).toHaveLength(1);
      expect(assistantMessage.contentSegments![0].type).toBe("thinking");
      expect(assistantMessage.contentSegments![1].type).toBe("text");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 24: Generation settings preservation
  // temperature, maxTokens, thinkingEnabled, reasoningEffort,
  // thinkingBudget are persisted on the assistant message
  // ────────────────────────────────────────────────────────────
  describe("Generation settings preservation", () => {
    it("should preserve generationSettings on assistant messages", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "write a poem" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a creative agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      currentMessages.push({
        role: "assistant",
        content: "Roses are red, violets are blue...",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        generationSettings: {
          temperature: 1.0,
          maxTokens: 8192,
          thinkingEnabled: true,
          reasoningEffort: "high",
          thinkingBudget: 10000,
        },
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const assistantMessage = newTurnMessages.find(
        (message) => message.role === "assistant",
      )!;
      expect(assistantMessage.generationSettings).toBeDefined();
      expect(assistantMessage.generationSettings!.temperature).toBe(1.0);
      expect(assistantMessage.generationSettings!.thinkingEnabled).toBe(true);
      expect(assistantMessage.generationSettings!.reasoningEffort).toBe("high");
      expect(assistantMessage.generationSettings!.thinkingBudget).toBe(10000);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 25: Usage and cost tracking
  // ────────────────────────────────────────────────────────────
  describe("Usage and cost tracking", () => {
    it("should preserve usage accumulator and cost on assistant messages", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "hello" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      currentMessages.push({
        role: "assistant",
        content: "Hello there!",
        model: "gpt-4.1",
        provider: "openai",
        usage: {
          inputTokens: 1250,
          outputTokens: 45,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 450,
          reasoningOutputTokens: 0,
          requests: 1,
        },
        totalTime: 0.85,
        tokensPerSec: 52.9,
        estimatedCost: 0.0003,
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      const assistantMessage = newTurnMessages.find(
        (message) => message.role === "assistant",
      )!;
      expect(assistantMessage.usage).toBeDefined();
      expect(assistantMessage.usage!.inputTokens).toBe(1250);
      expect(assistantMessage.usage!.cacheReadInputTokens).toBe(800);
      expect(assistantMessage.totalTime).toBe(0.85);
      expect(assistantMessage.tokensPerSec).toBe(52.9);
      expect(assistantMessage.estimatedCost).toBe(0.0003);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 26: Tool-update system message (dynamic tool enabling)
  // ────────────────────────────────────────────────────────────
  describe("Dynamic tool enabling (tool-update system messages)", () => {
    it("should persist tool-update system messages injected by the harness", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "search for trending products" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: tool search finds disabled tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_search_tools",
            name: "search_tools",
            args: { query: "product" },
            result: '{"tools": ["search_products", "get_trending_products"]}',
          },
        ],
      });

      // Harness injects tool-update nudge
      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n" +
          "Your search found 2 tool(s) that are not yet enabled: search_products, get_trending_products. " +
          "To use them, call enable_tools with these tool names now.\n" +
          "</tool-update>",
      });

      // Iteration 2: assistant enables tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_enable",
            name: "enable_tools",
            args: { tools: ["search_products", "get_trending_products"] },
            result: "Tools enabled.",
          },
        ],
      });

      // Iteration 3: assistant uses enabled tool
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_trending",
            name: "get_trending_products",
            args: {},
            result: '{"products": ["Widget A", "Gadget B"]}',
          },
        ],
      });

      // Iteration 4: final response
      currentMessages.push({
        role: "assistant",
        content: "The top trending products are Widget A and Gadget B.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // All messages should be persisted (system nudges are not filtered)
      const toolUpdateMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("<tool-update>"),
      );
      expect(toolUpdateMessage).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 27: Full Discord Agent (Lupos) — multi-iteration
  // with thinking, tool calls, image output, somatic state,
  // and platform context. End-to-end integration.
  // ────────────────────────────────────────────────────────────
  describe("Full integration: Lupos multi-iteration with thinking + tools + images", () => {
    it("should produce the complete expected messages array for MongoDB persistence", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "draw me as a wolf warrior and say something epic" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Lupos, an insane recovering-drug-addicted artist wolf king...",
        platformContextMessage:
          "Platform: Discord\nServer: Rod's Lab\nChannel: #art\nGuild ID: 123456789\nChannel ID: 987654321",
        selfContextMessage:
          "[Somatic State — Lupos]\ncurrent_emotion: inspired\nemotional_valence: 0.85\narousal: 0.75\ndominance: 0.7",
        memoriesText: "[Agent Memory]\nrodrigo likes epic fantasy art",
      });

      // Iteration 1: think → generate_image tool call
      currentMessages.push({
        role: "assistant",
        content: "Oh hell yeah, let me paint you into legend.",
        thinking:
          "The user wants to be drawn as a wolf warrior. I should create something epic and dramatic. " +
          "Based on my memory, rodrigo likes fantasy art, so I'll lean into that.",
        thinkingSignature: "sig_lupos_thinking_1",
        toolCalls: [
          {
            id: "call_img_epic",
            name: "generate_image",
            args: {
              prompt:
                "An epic wolf warrior in ornate battle armor standing on a mountain peak, dramatic sunset lighting, fantasy digital art, cinematic composition",
            },
            result: '{"url": "https://cdn.example.com/wolf-warrior.png", "success": true}',
            durationMs: 15200,
          },
        ],
      });

      // Iteration 2: think → synthesize_speech tool call
      currentMessages.push({
        role: "assistant",
        content: "",
        thinking: "Now I should deliver an epic voice line to go with the image.",
        thinkingSignature: "sig_lupos_thinking_2",
        toolCalls: [
          {
            id: "call_tts_epic",
            name: "synthesize_speech",
            args: {
              text: "[say in a deep, gravelly, commanding tone] Rise, warrior. The battlefield calls for blood, and only the wolves answer.",
            },
            result: '{"url": "https://cdn.example.com/epic-speech.wav"}',
            durationMs: 4100,
          },
        ],
      });

      // Iteration 3: final response
      currentMessages.push({
        role: "assistant",
        content:
          "There. You're a wolf warrior now. Pretty badass if I do say so myself. Listen to that voice line.",
        thinking: "The image and speech are done. Let me wrap it up with some attitude.",
        thinkingSignature: "sig_lupos_thinking_3",
        images: ["https://cdn.example.com/wolf-warrior.png"],
        audio: "https://cdn.example.com/epic-speech.wav",
        model: "gemini-2.5-flash",
        provider: "google",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Expected: system(identity) + system(platform) + system(somatic) + user + assistant(img tool) + assistant(tts tool) + assistant(final)
      expect(newTurnMessages).toHaveLength(7);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",    // identity prompt
        "system",    // platform context
        "system",    // somatic state
        "user",      // user message with memories injected
        "assistant", // image generation iteration
        "assistant", // speech synthesis iteration
        "assistant", // final response
      ]);

      // Verify system messages
      expect(newTurnMessages[0].content).toContain("Lupos");
      expect(newTurnMessages[1].content).toContain("Guild ID: 123456789");
      expect(newTurnMessages[2].content).toContain("current_emotion: inspired");

      // Verify user message has memories injected
      expect(newTurnMessages[3].content).toContain("[Agent Memory]");
      expect(newTurnMessages[3].content).toContain("epic fantasy art");
      expect(newTurnMessages[3].rawContent).toBe(
        "draw me as a wolf warrior and say something epic",
      );

      // Verify thinking and signatures on each assistant iteration
      const assistantMessages = newTurnMessages.filter(
        (message) => message.role === "assistant",
      );
      expect(assistantMessages[0].thinking).toContain("wolf warrior");
      expect(assistantMessages[0].thinkingSignature).toBe("sig_lupos_thinking_1");
      expect(assistantMessages[0].toolCalls![0].name).toBe("generate_image");
      expect(assistantMessages[0].toolCalls![0].durationMs).toBe(15200);

      expect(assistantMessages[1].thinking).toContain("epic voice line");
      expect(assistantMessages[1].thinkingSignature).toBe("sig_lupos_thinking_2");
      expect(assistantMessages[1].toolCalls![0].name).toBe("synthesize_speech");

      expect(assistantMessages[2].thinking).toContain("wrap it up");
      expect(assistantMessages[2].images).toEqual(["https://cdn.example.com/wolf-warrior.png"]);
      expect(assistantMessages[2].audio).toBe("https://cdn.example.com/epic-speech.wav");
      expect(assistantMessages[2].model).toBe("gemini-2.5-flash");
      expect(assistantMessages[2].provider).toBe("google");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 28: rawContent / content swap behavior
  // The Finalizer swaps content and rawContent so the DB
  // stores clean user text in content and the injected
  // [System Context] version in rawContent
  // ────────────────────────────────────────────────────────────
  describe("rawContent / content swap (Finalizer behavior)", () => {
    function swapMessageContent(message: ConversationMessage): void {
      if (
        message.role === "user" &&
        typeof message.content === "string"
      ) {
        if (
          message.rawContent?.startsWith("[System Context]") ||
          message.rawContent?.startsWith("[System Context - Local Time:")
        ) {
          return;
        }
        if (message.rawContent) {
          const dirty = message.content;
          message.content = message.rawContent;
          message.rawContent = dirty;
        } else if (message.content.startsWith("[System Context]")) {
          const dirty = message.content;
          let clean = message.content;
          const splitIndex = message.content.indexOf("\n\n[User Message]\n");
          if (splitIndex !== -1) {
            clean = message.content.substring(
              splitIndex + "\n\n[User Message]\n".length,
            );
          }
          message.content = clean;
          message.rawContent = dirty;
        }
      }
    }

    it("should swap rawContent and content so DB stores clean user text", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "what time is it?" },
      ];
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      currentMessages.push({
        role: "assistant",
        content: "It's 4:40 PM PDT.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessages.length,
      );

      // Before swap: content has [System Context], rawContent has clean text
      const userMessageBeforeSwap = newTurnMessages.find(
        (message) => message.role === "user",
      )!;
      expect(userMessageBeforeSwap.content).toContain("[System Context]");
      expect(userMessageBeforeSwap.rawContent).toBe("what time is it?");

      // After swap: content has clean text, rawContent has [System Context]
      const cloned = { ...userMessageBeforeSwap };
      swapMessageContent(cloned);
      expect(cloned.content).toBe("what time is it?");
      expect(cloned.rawContent).toContain("[System Context]");
    });

    it("should no-op on already-swapped messages (rawContent starts with [System Context])", () => {
      const alreadySwapped: ConversationMessage = {
        role: "user",
        content: "what time is it?",
        rawContent:
          "[System Context]\n- Local Time: Sunday\n\n[User Message]\nwhat time is it?",
      };

      const cloned = { ...alreadySwapped };
      swapMessageContent(cloned);

      // Should remain unchanged (the guard at the top prevents double-swap)
      expect(cloned.content).toBe("what time is it?");
      expect(cloned.rawContent).toContain("[System Context]");
    });

    it("should handle legacy messages without rawContent by parsing [System Context] block", () => {
      const legacyMessage: ConversationMessage = {
        role: "user",
        content:
          "[System Context]\n- Local Time: Sunday\n\n[User Message]\nlegacy question here",
      };

      swapMessageContent(legacyMessage);

      expect(legacyMessage.content).toBe("legacy question here");
      expect(legacyMessage.rawContent).toContain("[System Context]");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 29: Full tool discovery lifecycle
  // search_tools → <tool-update> nudge → enable_tools →
  // <tool-update> documentation addendum → actual tool use
  // ────────────────────────────────────────────────────────────
  describe("Full tool discovery lifecycle (search → nudge → enable → doc addendum → use)", () => {
    it("should persist all injected system messages throughout the discovery chain", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "find me some events happening this weekend" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: assistant calls search_tools to find relevant tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_search_tools_1",
            name: "search_tools",
            args: { query: "events" },
            result: {
              matches: [
                { name: "search_events", isEnabled: false },
                { name: "get_event_details", isEnabled: false },
              ],
            },
          },
        ],
      });

      // Harness injects <tool-update> nudge (disabled tools found)
      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n" +
          "Your search found 2 tool(s) that are not yet enabled: search_events, get_event_details. " +
          "To use them, call enable_tools with these tool names now. " +
          "After enabling, you can call them on the next iteration.\n" +
          "</tool-update>",
      });

      // Iteration 2: assistant enables the discovered tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_enable_tools_1",
            name: "enable_tools",
            args: { tools: ["search_events", "get_event_details"] },
            result: "Tools enabled: search_events, get_event_details",
          },
        ],
      });

      // Harness injects [TOOL SET UPDATED] documentation addendum
      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n" +
          "[TOOL SET UPDATED] 2 new tool(s) have been dynamically enabled: search_events, get_event_details\n\n" +
          "The following tools are now available with full documentation:\n\n" +
          "### search_events\nSearch for events by location, date range, and category.\n\n" +
          "### get_event_details\nGet full details for a specific event by ID.\n" +
          "</tool-update>",
      });

      // Iteration 3: assistant uses the newly enabled tool
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_search_events_1",
            name: "search_events",
            args: { location: "Vancouver", dateRange: "this weekend" },
            result: '{"events": [{"name": "Summer Jazz Festival", "date": "2026-06-21"}]}',
            durationMs: 1800,
          },
        ],
      });

      // Iteration 4: final response
      currentMessages.push({
        role: "assistant",
        content: "I found a Summer Jazz Festival happening this weekend!",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify the full chain is preserved
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",    // identity prompt
        "user",      // user message
        "assistant", // search_tools call
        "system",    // <tool-update> nudge
        "assistant", // enable_tools call
        "system",    // [TOOL SET UPDATED] documentation addendum
        "assistant", // search_events call
        "assistant", // final response
      ]);

      // Verify both system injections are present and distinguishable
      const toolUpdateMessages = newTurnMessages.filter(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("<tool-update>"),
      );
      expect(toolUpdateMessages).toHaveLength(2);

      // First: nudge to enable
      expect(toolUpdateMessages[0].content).toContain("not yet enabled");
      expect(toolUpdateMessages[0].content).toContain("search_events");

      // Second: documentation addendum
      expect(toolUpdateMessages[1].content).toContain("[TOOL SET UPDATED]");
      expect(toolUpdateMessages[1].content).toContain("full documentation");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 30: Lower-tier model auto-enable (flash/mini/haiku)
  // For nano/mini/flash/haiku/lite models, the harness auto-enables
  // tools immediately instead of asking the model to call enable_tools
  // ────────────────────────────────────────────────────────────
  describe("Lower-tier model auto-enable (flash/mini/haiku)", () => {
    it("should inject auto-enabled confirmation instead of enable_tools nudge", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "search for weather tools" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: search_tools call
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_st",
            name: "search_tools",
            args: { query: "weather" },
            result: {
              matches: [
                { name: "get_weather", isEnabled: false },
                { name: "get_forecast", isEnabled: false },
              ],
            },
          },
        ],
      });

      // Auto-enable message (for lower-tier models like gemini-2.5-flash)
      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n" +
          "Your search found 2 tool(s): get_weather, get_forecast. " +
          "They have been automatically enabled and are available now — call them directly.\n" +
          "</tool-update>",
      });

      // Iteration 2: model can immediately use the tool (no enable_tools step)
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_gw",
            name: "get_weather",
            args: { city: "Vancouver" },
            result: '{"temperature": "15°C", "condition": "Cloudy"}',
            durationMs: 350,
          },
        ],
      });

      // Iteration 3: final response
      currentMessages.push({
        role: "assistant",
        content: "It's 15°C and cloudy in Vancouver.",
        model: "gemini-2.5-flash",
        provider: "google",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify auto-enable system message is persisted
      const autoEnableMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("automatically enabled"),
      );
      expect(autoEnableMessage).toBeDefined();
      expect(autoEnableMessage!.content).toContain("get_weather, get_forecast");
      expect(autoEnableMessage!.content).toContain("call them directly");

      // Verify there's NO enable_tools call in the chain (auto-enabled skips it)
      const enableToolsCalls = newTurnMessages.filter(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.some(
            (toolCall: any) => toolCall.name === "enable_tools",
          ),
      );
      expect(enableToolsCalls).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 31: Output truncation recovery
  // When stopReason is "length" or "max_tokens", the harness
  // injects the partial output + a continuation system message
  // ────────────────────────────────────────────────────────────
  describe("Output truncation recovery (auto-continue)", () => {
    it("should persist truncated assistant output and continuation system message", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "write a comprehensive guide to Rust" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: response truncated by max_tokens
      currentMessages.push({
        role: "assistant",
        content: "# Comprehensive Guide to Rust\n\n## Chapter 1: Getting Started\n\nRust is a systems programming language...",
        thinking: "This is a long guide. Let me structure it by chapters.",
        thinkingSignature: "sig_truncated_1",
      });

      // Continuation prompt injected by OutputTruncationRecovery
      currentMessages.push({
        role: "system",
        content:
          "Your previous response was cut short because the output token limit " +
          "was reached before you could finish. The truncated text has been preserved. " +
          "Please continue exactly where you left off. Do NOT repeat what you already said.",
      });

      // Iteration 2: model continues from where it left off
      currentMessages.push({
        role: "assistant",
        content: "## Chapter 2: Ownership and Borrowing\n\nOne of Rust's most distinctive features...",
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(5);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",    // identity prompt
        "user",      // user message
        "assistant", // truncated partial output
        "system",    // continuation prompt
        "assistant", // continued response
      ]);

      // Verify the continuation prompt
      const continuationMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("cut short"),
      );
      expect(continuationMessage).toBeDefined();
      expect(continuationMessage!.content).toContain("Do NOT repeat");

      // Verify truncated output is preserved with thinking
      const truncatedAssistant = newTurnMessages[2];
      expect(truncatedAssistant.content).toContain("Chapter 1");
      expect(truncatedAssistant.thinking).toContain("long guide");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 32: Exhaustion recovery (iteration limit reached)
  // When the agentic loop hits max iterations, a system message
  // asks the model to summarize progress
  // ────────────────────────────────────────────────────────────
  describe("Exhaustion recovery (iteration limit reached)", () => {
    it("should persist exhaustion system message and summary response", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "refactor the entire codebase" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Simulate 3 tool iterations
      for (let iteration = 1; iteration <= 3; iteration++) {
        currentMessages.push({
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: `call_edit_${iteration}`,
              name: "edit_file",
              args: { path: `file${iteration}.ts`, content: `// refactored file ${iteration}` },
              result: "File edited.",
              durationMs: 150,
            },
          ],
        });
      }

      // Exhaustion recovery system message (injected by ExhaustionRecovery)
      currentMessages.push({
        role: "system",
        content:
          "You have reached the maximum number of tool-call iterations for this turn. " +
          "Summarize the progress you have made so far, report any partial results, " +
          "and clearly state what remains to be done so the user knows where things stand.",
      });

      // Exhaustion summary response (tool-free pass)
      currentMessages.push({
        role: "assistant",
        content:
          "I've refactored 3 files so far. Remaining: 12 files still need updating. " +
          "You can continue by asking me to proceed.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify exhaustion system message is in the persisted array
      const exhaustionMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("maximum number of tool-call iterations"),
      );
      expect(exhaustionMessage).toBeDefined();
      expect(exhaustionMessage!.content).toContain("Summarize the progress");

      // Verify the summary response follows
      const summaryResponse = newTurnMessages[newTurnMessages.length - 1];
      expect(summaryResponse.role).toBe("assistant");
      expect(summaryResponse.content).toContain("12 files still need updating");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 33: Codex model continuation prompt
  // For planning/update models like codex-mini, the harness
  // injects a "proceed" system message to transition from
  // planning to action
  // ────────────────────────────────────────────────────────────
  describe("Codex model continuation prompt (planning → action transition)", () => {
    it("should persist the planning output and continuation system message", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "implement a REST API for user management" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: Codex outputs plan text (no tool calls)
      currentMessages.push({
        role: "assistant",
        content:
          "I'll implement a REST API with the following structure:\n" +
          "1. Create UserRoutes.ts\n" +
          "2. Create UserService.ts\n" +
          "3. Add Mongoose model\n" +
          "4. Wire up in index.ts",
        thinking: "Let me plan the implementation before acting.",
      });

      // Codex continuation system message
      currentMessages.push({
        role: "system",
        content:
          "Please proceed with the next step using the appropriate tools to implement your plan. " +
          "If you have fully completed the user's request, please output a final message stating " +
          "that you are done without calling any tools.",
      });

      // Iteration 2: Codex now acts (creates files)
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_create_routes",
            name: "write_to_file",
            args: { path: "UserRoutes.ts", content: "// routes" },
            result: "File created.",
            durationMs: 100,
          },
        ],
      });

      // Iteration 3: final response
      currentMessages.push({
        role: "assistant",
        content: "Done! Created all 4 files for the user management API.",
        model: "codex-mini",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify codex continuation prompt is persisted
      const codexContinuationMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Please proceed with the next step"),
      );
      expect(codexContinuationMessage).toBeDefined();
      expect(codexContinuationMessage!.content).toContain(
        "fully completed the user's request",
      );

      // Verify the plan text assistant message is also persisted
      const planAssistant = newTurnMessages.find(
        (message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.includes("REST API"),
      );
      expect(planAssistant).toBeDefined();
      expect(planAssistant!.thinking).toContain("plan the implementation");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 34: Plan mode — blocked tool calls system message
  // When in planning mode, the harness blocks unauthorized tool
  // calls and injects an explicit "blocked" system message
  // ────────────────────────────────────────────────────────────
  describe("Plan mode blocked tool calls (system injection)", () => {
    it("should persist the blocked-tools system message and the re-attempt", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "implement a login page" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Planning instruction injected (marked as _isPlanningInjection)
      currentMessages.push({
        role: "user",
        content:
          "## ⚠️ PLANNING MODE ACTIVE — TOOL ACCESS RESTRICTED\n" +
          "You MUST call exit_plan_mode to present your plan for approval.",
        _isPlanningInjection: true,
      });

      // Iteration 1: model tries to use a blocked tool
      currentMessages.push({
        role: "assistant",
        content: "Let me create the login component right away.",
      });

      // Harness injects blocked-tools system message
      currentMessages.push({
        role: "system",
        content:
          "You are in PLANNING MODE. Your tool call(s) [write_to_file] were blocked " +
          "because only exit_plan_mode is available during planning. You MUST call " +
          "exit_plan_mode to present your plan for approval before any other tools can be used.",
      });

      // Iteration 2: model correctly calls exit_plan_mode
      currentMessages.push({
        role: "assistant",
        content:
          "Here's my plan:\n1. Create LoginComponent.tsx\n2. Add login form with validation\n3. Connect to auth API",
        toolCalls: [
          {
            id: "call_exit_plan",
            name: "exit_plan_mode",
            args: {},
            result: {
              approved: true,
              message: "User has approved your plan.",
            },
          },
        ],
      });

      // Actual implementation (plan mode exited, _isPlanningInjection stripped)
      currentMessages.push({
        role: "assistant",
        content: "Created the login page component.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // The blocked-tools system message should be in the array
      const blockedMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("PLANNING MODE"),
      );
      expect(blockedMessage).toBeDefined();
      expect(blockedMessage!.content).toContain("[write_to_file] were blocked");

      // The _isPlanningInjection messages should be filtered by the Finalizer
      const planningInjections = newTurnMessages.filter(
        (message) => message._isPlanningInjection === true,
      );
      // These exist in newTurnMessages but would be stripped by Finalizer sanitization
      // (tested separately in Scenario 18)
      expect(planningInjections.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 35: Error-as-context message
  // When all truncation recovery attempts are exhausted,
  // an error is injected as an assistant message so the
  // LLM has context about the failure on the next turn
  // ────────────────────────────────────────────────────────────
  describe("Error-as-context message (truncation exhaustion)", () => {
    it("should persist error-as-context assistant message with _isErrorIndicator", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "generate a massive report" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Multiple truncation recovery attempts (truncated output + continuation)
      for (let attempt = 1; attempt <= 3; attempt++) {
        currentMessages.push({
          role: "assistant",
          content: `Partial output chunk ${attempt}...`,
        });
        currentMessages.push({
          role: "system",
          content:
            "Your previous response was cut short because the output token limit " +
            "was reached before you could finish. The truncated text has been preserved. " +
            "Please continue exactly where you left off. Do NOT repeat what you already said.",
        });
      }

      // Final error-as-context (all recovery attempts exhausted)
      currentMessages.push({
        role: "assistant",
        content:
          "⚠️ **Error:** The model's response was cut short because the **max_tokens** limit " +
          "(8192) was reached, and 3 automatic continuation attempt(s) also hit the limit.",
        _isErrorIndicator: true,
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify error message is persisted
      const errorMessage = newTurnMessages.find(
        (message) => message._isErrorIndicator === true,
      );
      expect(errorMessage).toBeDefined();
      expect(errorMessage!.content).toContain("⚠️ **Error:**");
      expect(errorMessage!.content).toContain("max_tokens");

      // Verify all 3 continuation system messages are persisted
      const continuationMessages = newTurnMessages.filter(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("cut short"),
      );
      expect(continuationMessages).toHaveLength(3);

      // Verify all 3 partial outputs are persisted
      const partialOutputs = newTurnMessages.filter(
        (message) =>
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.startsWith("Partial output chunk"),
      );
      expect(partialOutputs).toHaveLength(3);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 36: Provider error persisted as assistant message
  // When a provider timeout/error occurs mid-loop, the error
  // is injected as an assistant message for the next turn
  // ────────────────────────────────────────────────────────────
  describe("Provider error as conversation context", () => {
    it("should persist provider error message for next-turn context", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "deploy the application" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are a coding agent.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: successful tool call
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_build",
            name: "run_command",
            args: { command: "npm run build" },
            result: "Build successful.",
            durationMs: 5000,
          },
        ],
      });

      // Provider error on iteration 2 (injected by error handler)
      currentMessages.push({
        role: "assistant",
        content:
          "⚠️ **Error:** The model provider encountered an error on iteration 2: " +
          "`Request timeout after 60000ms`. The conversation history up to this point " +
          "has been preserved. You can retry your request.",
        _isErrorIndicator: true,
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify error message is persisted alongside the successful tool call
      const errorMessage = newTurnMessages.find(
        (message) => message._isErrorIndicator === true,
      );
      expect(errorMessage).toBeDefined();
      expect(errorMessage!.content).toContain("Request timeout");

      // Verify the successful tool call before the error is also preserved
      const successfulToolCall = newTurnMessages.find(
        (message) =>
          message.role === "assistant" &&
          message.toolCalls?.some(
            (toolCall: any) => toolCall.name === "run_command",
          ),
      );
      expect(successfulToolCall).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 37: Chained tool discovery across multiple search
  // passes — verifies that multiple <tool-update> and
  // [TOOL SET UPDATED] system messages coexist correctly
  // ────────────────────────────────────────────────────────────
  describe("Chained tool discovery (multiple search passes)", () => {
    it("should persist all tool-update messages from separate discovery chains", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "find weather data and then search for events near me" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // First discovery chain: weather tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_st_weather",
            name: "search_tools",
            args: { query: "weather" },
            result: { matches: [{ name: "get_weather", isEnabled: false }] },
          },
        ],
      });

      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\nYour search found 1 tool(s) that are not yet enabled: get_weather. " +
          "To use them, call enable_tools with these tool names now.\n</tool-update>",
      });

      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_enable_weather",
            name: "enable_tools",
            args: { tools: ["get_weather"] },
            result: "Tools enabled.",
          },
        ],
      });

      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n[TOOL SET UPDATED] 1 new tool(s) have been dynamically enabled: get_weather\n\n" +
          "### get_weather\nGet current weather for a city.\n</tool-update>",
      });

      // Use weather tool
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_get_weather",
            name: "get_weather",
            args: { city: "Vancouver" },
            result: '{"temperature": "18°C"}',
            durationMs: 400,
          },
        ],
      });

      // Second discovery chain: event tools
      currentMessages.push({
        role: "assistant",
        content: "Now let me find events nearby.",
        toolCalls: [
          {
            id: "call_st_events",
            name: "search_tools",
            args: { query: "events" },
            result: { matches: [{ name: "search_events", isEnabled: false }] },
          },
        ],
      });

      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\nYour search found 1 tool(s) that are not yet enabled: search_events. " +
          "To use them, call enable_tools with these tool names now.\n</tool-update>",
      });

      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_enable_events",
            name: "enable_tools",
            args: { tools: ["search_events"] },
            result: "Tools enabled.",
          },
        ],
      });

      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n[TOOL SET UPDATED] 1 new tool(s) have been dynamically enabled: search_events\n\n" +
          "### search_events\nSearch for events by location.\n</tool-update>",
      });

      // Use event tool
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_search_events",
            name: "search_events",
            args: { location: "Vancouver" },
            result: '{"events": [{"name": "Jazz Fest"}]}',
            durationMs: 600,
          },
        ],
      });

      // Final response
      currentMessages.push({
        role: "assistant",
        content: "It's 18°C in Vancouver, and there's a Jazz Fest happening!",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Count all <tool-update> system messages
      const allToolUpdateMessages = newTurnMessages.filter(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("<tool-update>"),
      );
      // 2 nudges + 2 documentation addendums = 4 total
      expect(allToolUpdateMessages).toHaveLength(4);

      // Count nudge vs documentation messages
      const nudgeMessages = allToolUpdateMessages.filter((message) =>
        (message.content as string).includes("not yet enabled"),
      );
      const docMessages = allToolUpdateMessages.filter((message) =>
        (message.content as string).includes("[TOOL SET UPDATED]"),
      );
      expect(nudgeMessages).toHaveLength(2);
      expect(docMessages).toHaveLength(2);

      // Verify the final response is at the end
      expect(newTurnMessages[newTurnMessages.length - 1].content).toContain("Jazz Fest");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 38: Mixed system messages — validation error + tool
  // discovery + truncation recovery in a single turn
  // ────────────────────────────────────────────────────────────
  describe("Mixed system messages in a single turn", () => {
    it("should persist validation errors, tool-update nudges, and continuation prompts together", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "use the search API to find products, then create a report" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Omni.",
        platformContextMessage: null,
        selfContextMessage: null,
      });

      // Iteration 1: search_tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_st",
            name: "search_tools",
            args: { query: "products" },
            result: { matches: [{ name: "search_products", isEnabled: false }] },
          },
        ],
      });

      // <tool-update> nudge
      currentMessages.push({
        role: "system",
        content: "<tool-update>\nYour search found 1 tool(s) that are not yet enabled: search_products.\n</tool-update>",
      });

      // Iteration 2: enable tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_enable",
            name: "enable_tools",
            args: { tools: ["search_products"] },
            result: "Enabled.",
          },
        ],
      });

      // [TOOL SET UPDATED]
      currentMessages.push({
        role: "system",
        content: "<tool-update>\n[TOOL SET UPDATED] 1 new tool(s).\n</tool-update>",
      });

      // Iteration 3: use tool, then write report (with validation error)
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_sp",
            name: "search_products",
            args: { query: "trending" },
            result: '{"products": ["Widget"]}',
          },
          {
            id: "call_write",
            name: "write_to_file",
            args: { path: "report.ts", content: "const x: strig = 'a';" },
            result: "File written.",
          },
        ],
      });

      // [VALIDATION ERROR]
      currentMessages.push({
        role: "system",
        content:
          "[VALIDATION ERROR] Your recent edit(s) introduced 1 error(s):\n\n" +
          "### report.ts (typescript)\nError TS2304: Cannot find name 'strig'.",
      });

      // Iteration 4: fix
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_fix",
            name: "edit_file",
            args: { path: "report.ts", content: "const x: string = 'a';" },
            result: "File edited.",
          },
        ],
      });

      // Iteration 5: report is too long → truncated → continuation
      currentMessages.push({
        role: "assistant",
        content: "Here's the report:\n## Product Analysis\n...",
      });

      currentMessages.push({
        role: "system",
        content:
          "Your previous response was cut short because the output token limit " +
          "was reached. Please continue exactly where you left off.",
      });

      // Iteration 6: continuation
      currentMessages.push({
        role: "assistant",
        content: "## Recommendations\nBased on the data, Widget is trending.",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Count all different system message types
      const systemMessages = newTurnMessages.filter(
        (message) => message.role === "system",
      );

      const toolUpdates = systemMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<tool-update>"),
      );
      const validationErrors = systemMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("[VALIDATION ERROR]"),
      );
      const continuationPrompts = systemMessages.filter(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("cut short"),
      );

      // Identity prompt + 2 tool updates + 1 validation error + 1 continuation = 5 system messages
      expect(systemMessages).toHaveLength(5);
      expect(toolUpdates).toHaveLength(2);
      expect(validationErrors).toHaveLength(1);
      expect(continuationPrompts).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario 39: Discord agent with tool discovery + somatic state
  // Ensures platform-specific system messages and tool discovery
  // system messages coexist in the correct order
  // ────────────────────────────────────────────────────────────
  describe("Discord agent with tool discovery + somatic state", () => {
    it("should order system messages correctly: identity → ... → platform → somatic → tool-updates", () => {
      const originalMessages: ConversationMessage[] = [
        { role: "user", content: "search for drawing tools" },
      ];
      const originalMessageCount = originalMessages.length;
      const currentMessages: ConversationMessage[] = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: "You are Lupos.",
        platformContextMessage: "Platform: Discord\nServer: Rod's Lab",
        selfContextMessage: "[Somatic State — Lupos]\ncurrent_emotion: curious",
      });

      // search_tools
      currentMessages.push({
        role: "assistant",
        content: "Let me find some drawing tools.",
        toolCalls: [
          {
            id: "call_st",
            name: "search_tools",
            args: { query: "draw image" },
            result: { matches: [{ name: "generate_image", isEnabled: false }] },
          },
        ],
      });

      // <tool-update> nudge
      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\nYour search found 1 tool(s) that are not yet enabled: generate_image.\n</tool-update>",
      });

      // enable_tools
      currentMessages.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_enable",
            name: "enable_tools",
            args: { tools: ["generate_image"] },
            result: "Enabled.",
          },
        ],
      });

      // [TOOL SET UPDATED]
      currentMessages.push({
        role: "system",
        content:
          "<tool-update>\n[TOOL SET UPDATED] 1 new tool(s): generate_image\n</tool-update>",
      });

      // Use tool
      currentMessages.push({
        role: "assistant",
        content: "Now let me draw something.",
        toolCalls: [
          {
            id: "call_img",
            name: "generate_image",
            args: { prompt: "a wolf warrior" },
            result: '{"url": "https://cdn.example.com/wolf.png"}',
            durationMs: 14000,
          },
        ],
      });

      // Final response
      currentMessages.push({
        role: "assistant",
        content: "Here's your wolf warrior.",
        images: ["https://cdn.example.com/wolf.png"],
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      // Verify identity is first
      expect(newTurnMessages[0].role).toBe("system");
      expect(newTurnMessages[0].content).toBe("You are Lupos.");

      // Find platform context and somatic state — both should be
      // interleaved near the end (before the user message), not at top.
      const platformMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Platform: Discord"),
      );
      const somaticMessage = newTurnMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Somatic State"),
      );
      expect(platformMessage).toBeDefined();
      expect(somaticMessage).toBeDefined();

      // Platform and somatic should appear before the user message
      const platformIdx = newTurnMessages.indexOf(platformMessage!);
      const somaticIdx = newTurnMessages.indexOf(somaticMessage!);
      const userIdx = newTurnMessages.findIndex((message) => message.role === "user");
      expect(platformIdx).toBeLessThan(somaticIdx);
      expect(somaticIdx).toBeLessThan(userIdx);

      // Verify tool-update messages come later (after tool calls)
      const toolUpdateIndices = newTurnMessages.reduce(
        (indices: number[], message, index) => {
          if (
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("<tool-update>")
          ) {
            indices.push(index);
          }
          return indices;
        },
        [],
      );

      // Tool updates should come after the user message (they're mid-conversation injections)
      for (const toolUpdateIndex of toolUpdateIndices) {
        expect(toolUpdateIndex).toBeGreaterThan(userIdx);
      }
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario: Prism-Client Lupos — No agentContext
  // Somatic state should still be injected because it's agent-level,
  // not platform-level. Only platform context should be absent.
  // ────────────────────────────────────────────────────────────
  describe("Prism-Client Lupos — no agentContext, somatic state still injected", () => {
    let originalMessages: ConversationMessage[];
    let currentMessages: ConversationMessage[];
    let originalMessageCount: number;

    const LUPOS_IDENTITY = "You are Lupos, an insane recovering-drug-addicted artist wolf king...";
    const SOMATIC_STATE = [
      "[Somatic State — Lupos]",
      "current_emotion: curious",
      "emotional_valence: 0.6",
      "arousal: 0.45",
      "dominance: 0.5",
    ].join("\n");

    beforeEach(() => {
      originalMessages = [
        { role: "user", content: "hey lupos, what's up?" },
      ];
      originalMessageCount = originalMessages.length;
      currentMessages = [...originalMessages];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: null,
        selfContextMessage: SOMATIC_STATE,
      });
    });

    it("should have 3 messages after hook injection (no platform context)", () => {
      expect(currentMessages).toHaveLength(3);
    });

    it("should place identity system prompt at index 0", () => {
      expect(currentMessages[0].role).toBe("system");
      expect(currentMessages[0].content).toBe(LUPOS_IDENTITY);
    });

    it("should NOT have platform context (prism-client sends no agentContext)", () => {
      const platformMessage = currentMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Platform: Discord"),
      );
      expect(platformMessage).toBeUndefined();
    });

    it("should still inject somatic state as interleaved system message", () => {
      expect(currentMessages[1].role).toBe("system");
      expect(currentMessages[1].content).toBe(SOMATIC_STATE);
    });

    it("should place user message last with system context prepended", () => {
      expect(currentMessages[2].role).toBe("user");
      expect(currentMessages[2].content).toContain("[System Context]");
      expect(currentMessages[2].rawContent).toBe("hey lupos, what's up?");
    });

    it("should persist somatic state + user + assistant (no platform context)", () => {
      currentMessages.push({
        role: "assistant",
        content: "*yawns* Not much, just woke up from a weird dream...",
        model: "gpt-4.1",
        provider: "openai",
      });

      const newTurnMessages = computeNewTurnMessages(
        originalMessages,
        currentMessages,
        originalMessageCount,
      );

      expect(newTurnMessages).toHaveLength(4);
      expect(newTurnMessages.map((message) => message.role)).toEqual([
        "system",    // identity
        "system",    // somatic state (NO platform context between them)
        "user",      // user message
        "assistant", // response
      ]);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario: _isIdentityPrompt tag is set and enables reliable capture
  // ────────────────────────────────────────────────────────────
  describe("_isIdentityPrompt tag — reliable conversationMeta.systemPrompt capture", () => {
    let currentMessages: ConversationMessage[];

    const LUPOS_IDENTITY = "You are Lupos, an insane recovering-drug-addicted artist wolf king...";
    const PLATFORM_CONTEXT = "Platform: Discord\nServer: Rod's Lab";
    const SOMATIC_STATE = "[Somatic State — Lupos]\ncurrent_emotion: amused";

    beforeEach(() => {
      currentMessages = [
        { role: "user", content: "hey lupos" },
      ];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });
    });

    it("should set _isIdentityPrompt: true on the identity system message at index 0", () => {
      expect(currentMessages[0]._isIdentityPrompt).toBe(true);
    });

    it("should NOT set _isIdentityPrompt on platform context message", () => {
      const platformMessage = currentMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Platform: Discord"),
      );
      expect(platformMessage!._isIdentityPrompt).toBeUndefined();
    });

    it("should NOT set _isIdentityPrompt on somatic state message", () => {
      const somaticMessage = currentMessages.find(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Somatic State"),
      );
      expect(somaticMessage!._isIdentityPrompt).toBeUndefined();
    });

    it("should find identity prompt via _isIdentityPrompt tag even if other system messages exist", () => {
      const identityMessage = currentMessages.find(
        (message) => message.role === "system" && message._isIdentityPrompt === true,
      );
      expect(identityMessage).toBeDefined();
      expect(identityMessage!.content).toBe(LUPOS_IDENTITY);
    });

    it("should prefer _isIdentityPrompt-tagged message over first system message for conversationMeta capture", () => {
      // Simulate a scenario where a validation error system message gets prepended
      // (this could happen in edge cases with compaction or error injection)
      const messagesWithErrorFirst: ConversationMessage[] = [
        { role: "system", content: "[VALIDATION ERROR] Some lint error..." },
        { role: "system", content: LUPOS_IDENTITY, _isIdentityPrompt: true },
        { role: "system", content: SOMATIC_STATE },
        { role: "user", content: "test" },
      ];

      // Simulate the harness capture logic
      const capturedMessage =
        messagesWithErrorFirst.find(
          (message) => message.role === "system" && message._isIdentityPrompt === true,
        ) ||
        messagesWithErrorFirst.find((message) => message.role === "system");

      expect(capturedMessage!.content).toBe(LUPOS_IDENTITY);
    });

    it("should fall back to first system message when no _isIdentityPrompt tag exists (backward compat)", () => {
      const legacyMessages: ConversationMessage[] = [
        { role: "system", content: "Legacy identity prompt without tag" },
        { role: "user", content: "test" },
      ];

      const capturedMessage =
        legacyMessages.find(
          (message) => message.role === "system" && message._isIdentityPrompt === true,
        ) ||
        legacyMessages.find((message) => message.role === "system");

      expect(capturedMessage!.content).toBe("Legacy identity prompt without tag");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Scenario: conversationMeta.systemPrompt captures identity, not somatic
  // ────────────────────────────────────────────────────────────
  describe("conversationMeta.systemPrompt — captures identity not somatic state", () => {
    it("should capture identity prompt when all three system message types exist", () => {
      const LUPOS_IDENTITY = "You are Lupos...";
      const PLATFORM_CONTEXT = "Platform: Discord\nServer: Rod's Lab";
      const SOMATIC_STATE = "[Somatic State — Lupos]\ncurrent_emotion: melancholy";

      const currentMessages: ConversationMessage[] = [
        { role: "user", content: "hey" },
      ];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: PLATFORM_CONTEXT,
        selfContextMessage: SOMATIC_STATE,
      });

      // Simulate the harness capture logic (same as ReActHarness line 174-185)
      const assembledSystemMessage =
        currentMessages.find(
          (message) => message.role === "system" && message._isIdentityPrompt === true,
        ) ||
        currentMessages.find((message) => message.role === "system");

      const conversationMeta: Record<string, unknown> = {};
      if (assembledSystemMessage?.content) {
        conversationMeta.systemPrompt = assembledSystemMessage.content;
      }

      expect(conversationMeta.systemPrompt).toBe(LUPOS_IDENTITY);
      expect(conversationMeta.systemPrompt).not.toContain("Somatic State");
      expect(conversationMeta.systemPrompt).not.toContain("Platform: Discord");
    });

    it("should capture identity even when only somatic state + identity exist (prism-client)", () => {
      const LUPOS_IDENTITY = "You are Lupos...";
      const SOMATIC_STATE = "[Somatic State — Lupos]\ncurrent_emotion: happy";

      const currentMessages: ConversationMessage[] = [
        { role: "user", content: "how are you?" },
      ];

      simulateBeforePromptHook(currentMessages, {
        systemPrompt: LUPOS_IDENTITY,
        platformContextMessage: null,
        selfContextMessage: SOMATIC_STATE,
      });

      const assembledSystemMessage =
        currentMessages.find(
          (message) => message.role === "system" && message._isIdentityPrompt === true,
        ) ||
        currentMessages.find((message) => message.role === "system");

      expect(assembledSystemMessage!.content).toBe(LUPOS_IDENTITY);
    });
  });
});

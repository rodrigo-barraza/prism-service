/**
 * Unit tests for the Anthropic `prepareMessages` function.
 *
 * Validates system message extraction, role conversion, thinking block
 * handling, consecutive-role merging, tool_result deduplication, orphaned
 * tool_use stripping, trailing whitespace sanitization, and image handling.
 */
import { describe, it, expect } from "vitest";

import { prepareMessages } from "#src/providers/anthropic";
import type { ChatMessage } from "#src/types/ProviderTypes";

// ── Helpers ──────────────────────────────────────────────────
function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return { role: "user", content: "hello", ...overrides } as ChatMessage;
}

// ── System Message Extraction ────────────────────────────────
describe("prepareMessages — system message extraction", () => {
  it("extracts the first system message as the systemMessage field", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: "You are a helpful assistant." }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    expect(result.systemMessage).toBe("You are a helpful assistant.");
    expect(result.messages.every((message) => message.role !== "system")).toBe(
      true,
    );
  });

  it("returns undefined systemMessage when no system message exists", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    expect(result.systemMessage).toBeUndefined();
  });

  it("normalizes empty string system content to undefined", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: "" }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    expect(result.systemMessage).toBeUndefined();
  });

  it("normalizes whitespace-only system content to undefined", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: "   " }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    expect(result.systemMessage).toBeUndefined();
  });

  it("normalizes single-space system content to undefined", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: " " }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    expect(result.systemMessage).toBeUndefined();
  });

  it("preserves legitimate system content with surrounding whitespace", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: "  You are helpful.  " }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    // trim() detects non-whitespace, so the original content (with spaces) is kept
    expect(result.systemMessage).toBe("  You are helpful.  ");
  });
});

// ── Role Conversion ──────────────────────────────────────────
describe("prepareMessages — role conversion", () => {
  it("converts tool messages to user messages with tool_result content blocks", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Use the tool." }),
      makeMessage({
        role: "assistant",
        content: "Calling tool.",
        toolCalls: [
          { id: "tc_1", name: "search", args: { query: "test" } },
        ],
      } as unknown as Partial<ChatMessage>),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_1",
        name: "search",
        content: "Search results here",
      } as unknown as Partial<ChatMessage>),
    ]);

    const toolResultMessage = result.messages.find(
      (message) =>
        Array.isArray(message.content) &&
        (message.content as Array<{ type: string }>).some(
          (block) => block.type === "tool_result",
        ),
    );
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage!.role).toBe("user");
  });

  it("converts mid-conversation system messages to user role", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: "Identity prompt" }),
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "assistant", content: "Hi there" }),
      makeMessage({
        role: "system",
        content: "<tool-update>New tool available</tool-update>",
      }),
      makeMessage({ role: "user", content: "Continue" }),
    ]);

    // Mid-conversation system messages should be converted to user role
    const userMessages = result.messages.filter(
      (message) => message.role === "user",
    );
    // The mid-conv system message should now be a user message
    const containsToolUpdate = userMessages.some((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      return content.includes("tool-update");
    });
    expect(containsToolUpdate).toBe(true);
  });
});

// ── Thinking Block Handling ──────────────────────────────────
describe("prepareMessages — thinking blocks", () => {
  it("preserves thinking blocks with signatures on assistant+toolCalls messages", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Think about this" }),
      makeMessage({
        role: "assistant",
        content: "Here is my answer",
        thinking: "I need to consider...",
        thinkingSignature: "sig_abc123",
        toolCalls: [{ id: "tc_1", name: "search", args: {} }],
      } as unknown as Partial<ChatMessage>),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_1",
        name: "search",
        content: "results",
      } as unknown as Partial<ChatMessage>),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    expect(Array.isArray(assistantMessage!.content)).toBe(true);
    const thinkingBlock = (
      assistantMessage!.content as Array<{ type: string; thinking?: string }>
    ).find((block) => block.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinking).toBe("I need to consider...");
  });

  it("omits thinking blocks without signatures to avoid API 400", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Think about this" }),
      makeMessage({
        role: "assistant",
        content: "Here is my answer",
        thinking: "I need to consider...",
        // No thinkingSignature
        toolCalls: [{ id: "tc_1", name: "search", args: {} }],
      } as unknown as Partial<ChatMessage>),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_1",
        name: "search",
        content: "results",
      } as unknown as Partial<ChatMessage>),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(Array.isArray(assistantMessage!.content)).toBe(true);
    const thinkingBlock = (
      assistantMessage!.content as Array<{ type: string }>
    ).find((block) => block.type === "thinking");
    expect(thinkingBlock).toBeUndefined();
  });

  it("handles assistant messages with thinking but no toolCalls", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Think carefully" }),
      makeMessage({
        role: "assistant",
        content: "My considered answer",
        thinking: "Deep thought...",
        thinkingSignature: "sig_xyz",
      } as unknown as Partial<ChatMessage>),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    // Should produce structured content blocks when thinking+signature present
    expect(Array.isArray(assistantMessage!.content)).toBe(true);
  });
});

// ── Consecutive Same-Role Merging ────────────────────────────
describe("prepareMessages — consecutive role merging", () => {
  it("merges consecutive string-content user messages", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "First message" }),
      makeMessage({ role: "user", content: "Second message" }),
    ]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("First message");
    expect(result.messages[0].content).toContain("Second message");
  });

  it("merges consecutive array-content messages by concatenating blocks", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Before tool result" }),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_1",
        name: "search",
        content: "result 1",
      } as unknown as Partial<ChatMessage>),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_2",
        name: "fetch",
        content: "result 2",
      } as unknown as Partial<ChatMessage>),
    ]);

    // Both tool messages are converted to user role, so they merge
    // with the preceding user message
    const userMessages = result.messages.filter(
      (message) => message.role === "user",
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });
});

// ── tool_result Deduplication ────────────────────────────────
describe("prepareMessages — tool_result deduplication", () => {
  it("removes duplicate tool_result blocks with the same tool_use_id", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Do something" }),
      makeMessage({
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_dup", name: "search", args: {} }],
      } as unknown as Partial<ChatMessage>),
      // Two tool responses with the same ID (duplicate)
      makeMessage({
        role: "tool",
        tool_call_id: "tc_dup",
        name: "search",
        content: "result A",
      } as unknown as Partial<ChatMessage>),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_dup",
        name: "search",
        content: "result B",
      } as unknown as Partial<ChatMessage>),
    ]);

    // After merging, the user message with tool_results should have exactly one
    // tool_result block for tc_dup
    const userWithToolResults = result.messages.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        (message.content as Array<{ type: string }>).some(
          (block) => block.type === "tool_result",
        ),
    );
    expect(userWithToolResults).toBeDefined();
    const toolResultBlocks = (
      userWithToolResults!.content as Array<{
        type: string;
        tool_use_id: string;
      }>
    ).filter((block) => block.type === "tool_result");
    const duplicateIds = toolResultBlocks.filter(
      (block) => block.tool_use_id === "tc_dup",
    );
    expect(duplicateIds).toHaveLength(1);
  });
});

// ── Orphaned tool_use Stripping ──────────────────────────────
describe("prepareMessages — orphaned tool_use stripping", () => {
  it("strips tool_use blocks from assistant when next message has no tool_result", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Do something" }),
      makeMessage({
        role: "assistant",
        content: "I'll try the tool",
        toolCalls: [{ id: "tc_orphan", name: "search", args: {} }],
      } as unknown as Partial<ChatMessage>),
      // Next message is a user message, NOT a tool result
      makeMessage({ role: "user", content: "Nevermind" }),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();

    if (Array.isArray(assistantMessage!.content)) {
      const toolUseBlocks = (
        assistantMessage!.content as Array<{ type: string }>
      ).filter((block) => block.type === "tool_use");
      expect(toolUseBlocks).toHaveLength(0);
    }
  });

  it("keeps tool_use blocks when followed by matching tool_result", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Do something" }),
      makeMessage({
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_valid", name: "search", args: {} }],
      } as unknown as Partial<ChatMessage>),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_valid",
        name: "search",
        content: "found it",
      } as unknown as Partial<ChatMessage>),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    expect(Array.isArray(assistantMessage!.content)).toBe(true);
    const toolUseBlocks = (
      assistantMessage!.content as Array<{ type: string }>
    ).filter((block) => block.type === "tool_use");
    expect(toolUseBlocks).toHaveLength(1);
  });
});

// ── Trailing Whitespace Sanitization ─────────────────────────
describe("prepareMessages — trailing whitespace sanitization", () => {
  it("trims trailing whitespace from assistant string content", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Hi" }),
      makeMessage({ role: "assistant", content: "Hello there   " }),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    expect(typeof assistantMessage!.content).toBe("string");
    expect((assistantMessage!.content as string).endsWith(" ")).toBe(false);
  });

  it("replaces whitespace-only assistant content with single space", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Hi" }),
      makeMessage({ role: "assistant", content: "   " }),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage!.content).toBe(" ");
  });

  it("trims trailing whitespace from assistant text blocks in arrays", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Think about this" }),
      makeMessage({
        role: "assistant",
        content: "Answer with trailing space   ",
        thinking: "thoughts...",
        thinkingSignature: "sig_trim",
      } as unknown as Partial<ChatMessage>),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    if (Array.isArray(assistantMessage!.content)) {
      const textBlocks = (
        assistantMessage!.content as Array<{ type: string; text?: string }>
      ).filter((block) => block.type === "text");
      for (const block of textBlocks) {
        expect(block.text!.endsWith(" ")).toBe(false);
      }
    }
  });
});

// ── Conversation Start Enforcement ───────────────────────────
describe("prepareMessages — conversation start enforcement", () => {
  it("strips leading assistant messages so conversation starts with user", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "assistant", content: "I'm the assistant" }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    expect(result.messages[0].role).toBe("user");
  });

  it("handles conversation that starts with system then assistant by removing assistant", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "system", content: "You are helpful" }),
      makeMessage({ role: "assistant", content: "Greeting" }),
      makeMessage({ role: "user", content: "Hi" }),
    ]);

    // System is extracted, assistant at index 0 is stripped
    expect(result.messages[0].role).toBe("user");
  });
});

// ── Empty / Null Content Handling ────────────────────────────
describe("prepareMessages — empty content handling", () => {
  it("assigns fallback content for assistant messages with null content", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: "Hi" }),
      makeMessage({ role: "assistant", content: null } as unknown as Partial<ChatMessage>),
    ]);

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toBeDefined();
    // Should have fallback content (single space)
    expect(assistantMessage!.content).toBe(" ");
  });

  it("assigns fallback content for user messages with no content", async () => {
    const result = await prepareMessages([
      makeMessage({ role: "user", content: undefined } as unknown as Partial<ChatMessage>),
    ]);

    expect(result.messages).toHaveLength(1);
    // Should have some fallback
    expect(result.messages[0].content).toBeTruthy();
  });
});

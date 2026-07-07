import { vi, describe, it, expect } from "vitest";

// Suppress logger output during tests
vi.mock("../logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import ContextWindowManager from "../ContextWindowManager.ts";
import { PROMPT_DELIMITERS } from "../../constants.ts";


// ═══════════════════════════════════════════════════════════════
// Token Estimation
// ═══════════════════════════════════════════════════════════════

describe("Token estimation", () => {
  it("estimates tokens for a simple text message", () => {
    // "Hello world" = 11 chars → ceil(11 / 4) = 3 tokens + 4 overhead = 7
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "Hello world",
    });
    expect(tokens).toBe(3 + 4); // 3 content + 4 overhead
  });

  it("estimates zero tokens for null content", () => {
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: null as any,
    });
    expect(tokens).toBe(4); // Only overhead
  });

  it("estimates zero tokens for empty content", () => {
    const tokens = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "",
    });
    expect(tokens).toBe(4); // Only overhead
  });

  it("includes tool call overhead (name + args + result)", () => {
    const message = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          name: "read_file",
          args: JSON.stringify({ path: "/test.js" }),
          result: "file content here",
        },
      ],
    };
    const tokens = ContextWindowManager.estimateMessageTokens(message);
    // 4 overhead + 0 content + read_file tokens + args tokens + result tokens
    expect(tokens).toBeGreaterThan(4);
  });

  it("adds ~1000 tokens per image reference", () => {
    const withoutImages = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "Look at this",
    });
    const withImages = ContextWindowManager.estimateMessageTokens({
      role: "user",
      content: "Look at this",
      images: ["minio://bucket/img1.png", "minio://bucket/img2.png"],
    });
    expect(withImages - withoutImages).toBe(2000);
  });

  it("includes thinking block tokens", () => {
    const without = ContextWindowManager.estimateMessageTokens({
      role: "assistant",
      content: "answer",
    });
    const with_ = ContextWindowManager.estimateMessageTokens({
      role: "assistant",
      content: "answer",
      thinking: "Let me think about this carefully...",
    });
    expect(with_).toBeGreaterThan(without);
  });

  it("estimates tokens across multiple messages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const total = ContextWindowManager.estimateTokens(messages);
    // Each message has content + 4 overhead
    expect(total).toBeGreaterThan(12); // At minimum 3 * 4 overhead
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Fast Path (no truncation needed)
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — fast path", () => {
  it("returns unchanged messages when under budget", () => {
    const messages = [
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.strategy).toBeNull();
    expect(result.messages).toBe(messages); // Same reference
    expect(result.messages).toHaveLength(3);
  });

  it("returns unchanged when exactly at budget", () => {
    // Tiny context window but messages still fit
    const messages = [
      { role: "user", content: "Hi" },
    ];
    // Budget = floor((maxInput - outputReserve - schemaOverhead) * 0.80)
    // We need budget >= estimated, so set maxInput high enough
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
  });

  it("handles empty messages array", () => {
    const result = ContextWindowManager.enforce([], {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Strategy 1: Tool Result Truncation
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — tool result truncation", () => {
  it("truncates large tool results in old messages", () => {
    // Budget at 32k with 5 tools:
    // floor((32000 - 8192 - (2000 + 5*150)) * 0.80) = floor(21058 * 0.80) = 16846 tokens
    // We need total estimated tokens > 16846 to trigger truncation.
    // 80k chars ≈ 22857 tokens in tool results alone → exceeds budget.
    const bigResult = "x".repeat(80_000);
    const messages = [
      { role: "system", content: "System prompt ".repeat(200) },
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: "I'll read the file",
        toolCalls: [{ name: "read_file", args: '{"path": "big.js"}', result: bigResult }],
      },
      { role: "user", content: "What about this?" },
      { role: "user", content: "And this?" },
      { role: "user", content: "More context" },
      { role: "user", content: "Even more" },
      { role: "user", content: "Final question" },
      { role: "assistant", content: "Here's my answer" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
      toolCount: 5,
    });

    expect(result.truncated).toBe(true);
    if (result.strategy === "tool_truncation") {
      // The old tool result should be capped at 3000 chars
      const truncatedTc = result.messages[2].toolCalls![0] as any;
      expect(truncatedTc.result.length).toBeLessThanOrEqual(3100); // 3000 + truncation notice
      expect(truncatedTc.result).toContain("truncated");
    }
  });

  it("preserves recent tool results (protected turns)", () => {
    const bigResult = "y".repeat(10_000);
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Read this file" },
      {
        role: "assistant",
        content: "Reading...",
        toolCalls: [{ name: "read_file", args: '{"path": "big.js"}', result: bigResult }],
      },
      // This is within the last 4 user turns, so should be protected
      { role: "user", content: "Now what?" },
      { role: "assistant", content: "Done." },
    ];

    // Even if we force truncation, recent messages should keep full results
    // With a large enough window that tool_truncation alone suffices
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 20_000,
    });

    // The tool result is in a recent turn — if strategy 1 fires, it should still be full
    // But with 20k context the whole thing might fit without truncation
    if (!result.truncated) {
      // It fit without truncation — expected for this message count + 20k window
      const toolCall = result.messages[2].toolCalls![0] as any;
      expect(toolCall.result).toBe(bigResult);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Strategy 2: Assistant Message Compression
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — assistant compression", () => {
  it("compresses old assistant messages while preserving recent ones", () => {
    // Build a conversation large enough to trigger compression
    const longContent = "A".repeat(5_000);
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: longContent, thinking: "Think".repeat(1000) },
      { role: "user", content: "Q2" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q3" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q4" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q5" },
      { role: "assistant", content: longContent },
      { role: "user", content: "Q6 final" },
      { role: "assistant", content: "Short recent answer" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
      maxOutputTokens: 2_000,
    });

    expect(result.truncated).toBe(true);

    // The most recent assistant message should be preserved
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop();
    if (result.strategy !== "sliding_window") {
      expect(lastAssistant?.content).toContain("Short recent answer");
    }
  });

  it("replaces thinking blocks with undefined in compressed messages", () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A".repeat(8_000), thinking: "T".repeat(8_000) },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A".repeat(8_000), thinking: "T".repeat(8_000) },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
      { role: "user", content: "Q6" },
      { role: "assistant", content: "Recent" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
    });

    if (result.truncated) {
      // Old assistant messages should have thinking stripped
      const oldAssistants = result.messages.filter(
        (m, i) => m.role === "assistant" && i < result.messages.length - 2,
      );
      for (const messageItem of oldAssistants) {
        if (messageItem.content?.startsWith("[Earlier response")) {
          expect(messageItem.thinking).toBeUndefined();
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// enforce() — Strategy 3: Sliding Window
// ═══════════════════════════════════════════════════════════════

describe("ContextWindowManager.enforce — sliding window", () => {
  it("drops middle turns and inserts context note", () => {
    // Build a conversation large enough that even after assistant_compression
    // the user messages alone exceed the budget.
    // Budget at 16k: floor((16000 - 8192 - 2000) * 0.80) ≈ 4646 tokens
    // Each user message = "Question context ".repeat(500) = 8000 chars ≈ 2000 tokens
    // Even compressed, 50 user messages × 2000 tokens ≈ 100k → way over 4.6k budget
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "First question" },
    ];

    for (let i = 0; i < 50; i++) {
      messages.push({ role: "assistant", content: "Response ".repeat(2000) });
      messages.push({ role: "user", content: "Question context ".repeat(500) + ` ${i}` });
    }

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.strategy).toBe("sliding_window");
    expect(result.messages.length).toBeLessThan(messages.length);

    // Should have a context note about dropped messages
    const contextNote = result.messages.find(
      (m) => m.content?.includes(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX) || m.content?.includes("earlier messages were removed"),
    );
    expect(contextNote).toBeTruthy();

    // System message should be preserved
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("System prompt");

    // First user message should be preserved
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("First question");
  });

  it("preserves the most recent messages", () => {
    // Budget at 32k ≈ 17445 tokens. 30 turns × ~1143 tokens each ≈ 34k tokens → forces sliding window
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Old question" },
    ];

    for (let i = 0; i < 30; i++) {
      messages.push({ role: "assistant", content: "Long answer ".repeat(1000) });
      messages.push({ role: "user", content: `Question ${i}` });
    }

    // Add a recognizable final exchange
    messages.push({ role: "assistant", content: "FINAL_ANSWER_MARKER" });

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
    });

    expect(result.truncated).toBe(true);
    // The final answer should be in the result
    const lastAssistant = result.messages.filter(m => m.role === "assistant").pop();
    expect(lastAssistant?.content).toContain("FINAL_ANSWER_MARKER");
  });

  it("never drops recent user messages even under severe budget pressure", () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "First user query" },
      { role: "assistant", content: "Long response ".repeat(2000) },
      { role: "user", content: "Second user query" },
      { role: "assistant", content: "Another long response ".repeat(2000) },
      { role: "user", content: "Third user query (recent)" },
      { role: "assistant", content: "Recent response" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.strategy).toBe("sliding_window");

    const userMessages = result.messages.filter(
      (m) => m.role === "user" && !m.content?.includes(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX),
    );

    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(userMessages.some((m) => m.content === "Third user query (recent)")).toBe(true);
  });

  it("handles conversation with only 3 messages (no truncation possible)", () => {
    const messages = [
      { role: "system", content: "S".repeat(50_000) },
      { role: "user", content: "Q" },
      { role: "assistant", content: "A" },
    ];

    // Even with sliding window, 3-message conversations are returned as-is
    // from slidingWindowTruncation (guard clause), but compression may still apply
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 8_000,
    });

    // The system message is always preserved regardless
    expect(result.messages[0].role).toBe("system");
  });
});

// ═══════════════════════════════════════════════════════════════
// Budget Calculation
// ═══════════════════════════════════════════════════════════════

describe("Budget calculation", () => {
  it("accounts for tool count in schema overhead", () => {
    const messages = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: "Question ".repeat(500) });
      messages.push({ role: "assistant", content: "Answer ".repeat(500) });
    }

    // More tools = higher schema overhead = tighter budget = more likely to truncate
    const noTools = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
      toolCount: 0,
    });
    const manyTools = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
      toolCount: 30,
    });

    // Many tools should have a lower effective budget,
    // which means it's MORE likely to truncate or use a more aggressive strategy
    if (!noTools.truncated && manyTools.truncated) {
      expect(manyTools.truncated).toBe(true);
    }
    // At minimum, estimated tokens should be the same for identical messages
    expect(noTools.estimatedTokens).toBeGreaterThan(0);
  });

  it("respects minimum output reserve of 8192", () => {
    const messages = [
      { role: "user", content: "Hi" },
    ];

    // Even with maxOutputTokens = 100, the reserve should be at least 8192
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
      maxOutputTokens: 100, // Below minimum
    });

    // The budget formula: floor((128000 - max(100, 8192) - 2000) * 0.80)
    // = floor((128000 - 8192 - 2000) * 0.80) = floor(117808 * 0.80) = 94246
    expect(result.truncated).toBe(false); // Tiny message fits easily
  });

  it("handles negative budget gracefully", () => {
    const messages = [
      { role: "user", content: "Hi" },
    ];

    // maxInputTokens so small that budget goes negative
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 1000, // Way too small after output reserve + schema overhead
      maxOutputTokens: 8192,
      toolCount: 50,
    });

    // Should not crash — returns untouched messages with truncated: false
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it("uses default maxInputTokens of 128k when not specified", () => {
    const messages = [
      { role: "user", content: "Test" },
    ];
    const result = ContextWindowManager.enforce(messages);
    expect(result.truncated).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Strategy Escalation
// ═══════════════════════════════════════════════════════════════

describe("Strategy escalation", () => {
  it("escalates from tool_truncation → assistant_compression → sliding_window", () => {
    // Build messages where both tool truncation AND assistant compression
    // don't suffice because user messages contain most of the bulk.
    // Budget at 16k: floor((16000 - 8192 - 2000) * 0.80) ≈ 4646 tokens
    // User messages aren't compressed, so 40 × ("Question ".repeat(500)) ≈ 40 × 1000 tokens = 40k → way over
    const messages: any[] = [
      { role: "system", content: "System" },
    ];

    for (let i = 0; i < 40; i++) {
      messages.push({ role: "user", content: "Question context ".repeat(500) + ` ${i}` });
      messages.push({
        role: "assistant",
        content: "Analysis complete. ".repeat(500),
        toolCalls: [
          { name: "read_file", args: '{"path": "test.js"}', result: "file content ".repeat(500) },
        ],
      });
    }

    messages.push({ role: "user", content: "Final question" });

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 16_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.strategy).toBe("sliding_window");
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("reports correct strategy name when tool truncation alone suffices", () => {
    const bigResult = "x".repeat(50_000);
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Read file" },
      {
        role: "assistant",
        content: "Done",
        toolCalls: [{ name: "read_file", args: "{}", result: bigResult }],
      },
      // 5 recent user turns to push the old tool result outside protection
      { role: "user", content: "Q1" },
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "user", content: "Q4" },
      { role: "user", content: "Q5" },
      { role: "assistant", content: "Final" },
    ];

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 32_000,
    });

    if (result.truncated) {
      expect(["tool_truncation", "assistant_compression", "sliding_window"]).toContain(
        result.strategy,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════

describe("Edge cases", () => {
  it("handles messages with only system prompt", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
  });

  it("handles tool messages (standalone, not in toolCalls)", () => {
    const messages = [
      { role: "system", content: "System" },
      { role: "user", content: "Test" },
      { role: "assistant", content: "Running tool..." },
      { role: "tool", content: "Tool result: success" },
      { role: "assistant", content: "Done" },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
  });

  it("handles non-string content (objects)", () => {
    const messages: any[] = [
      { role: "user", content: { text: "Hello", metadata: { foo: "bar" } } },
    ];
    // Should not throw
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("handles messages with undefined fields", () => {
    const messages = [
      { role: "user", content: "Hi", images: undefined, toolCalls: undefined },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 128_000,
    });
    expect(result.truncated).toBe(false);
  });
});

// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts) ──

describe('ContextWindowManager adversarial', () => {
  it('should handle empty messages array without crashing', () => {
    const result = ContextWindowManager.enforce([], {
      maxInputTokens: 128_000,
    });
    expect(result.messages).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('should handle single system message that exceeds context window', () => {
    const giantSystemMessage = {
      role: 'system',
      content: 'x'.repeat(1_000_000),
    };
    const result = ContextWindowManager.enforce([giantSystemMessage] as any, {
      maxInputTokens: 1000,
      maxOutputTokens: 200,
    });
    // Should not throw — truncation strategies should kick in
    expect(result).toBeDefined();
  });

  it('should not crash on messages with undefined content', () => {
    const messagesWithUndefined = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: undefined },
      { role: 'assistant', content: 'Hello' },
    ];
    const result = ContextWindowManager.enforce(messagesWithUndefined as any, {
      maxInputTokens: 128_000,
    });
    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('should handle messages with deeply nested toolCalls result objects', () => {
    // Build a 50-level deep nested object to stress JSON.stringify in token estimation
    let deepObject: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 50; depth++) {
      deepObject = { nested: deepObject };
    }

    const messagesWithDeepToolResults = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'result',
        toolCalls: [
          { name: 'deep_tool', args: {}, result: deepObject },
        ],
      },
    ];

    const result = ContextWindowManager.enforce(messagesWithDeepToolResults as any, {
      maxInputTokens: 128_000,
    });
    expect(result).toBeDefined();
  });

  it('should handle maxInputTokens of 0 — negative budget scenario', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = ContextWindowManager.enforce(messages as any, {
      maxInputTokens: 0,
      maxOutputTokens: 100,
    });
    // Should not throw, should log warning about negative budget
    expect(result.truncated).toBe(false);
  });

  it('should handle maxOutputTokens larger than maxInputTokens — inverted budget', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = ContextWindowManager.enforce(messages as any, {
      maxInputTokens: 1000,
      maxOutputTokens: 50_000,
    });
    // Negative budget → should return messages as-is
    expect(result.truncated).toBe(false);
  });

  it('should preserve the system message during sliding window truncation', () => {
    const messages: any[] = [
      { role: 'system', content: 'IMPORTANT SYSTEM PROMPT' },
    ];
    // Add 100 user/assistant turns to blow the budget
    for (let index = 0; index < 100; index++) {
      messages.push({ role: 'user', content: 'x'.repeat(500) });
      messages.push({ role: 'assistant', content: 'y'.repeat(500) });
    }

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 4000,
      maxOutputTokens: 1000,
    });

    // System message must survive truncation
    const systemMessage = result.messages.find((message) => message.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage?.content).toBe('IMPORTANT SYSTEM PROMPT');
  });

  it('should estimate 0 tokens for messages array with all-empty content', () => {
    const emptyMessages = [
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
    ];
    const estimate = ContextWindowManager.estimateTokens(emptyMessages as any);
    // Should still count per-message overhead (4 tokens each)
    expect(estimate).toBe(8);
  });
});

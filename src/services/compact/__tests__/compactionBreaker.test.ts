/**
 * compactionBreaker.test.ts — the compaction circuit breaker is scoped to
 * ONE conversation.
 *
 * On master the breaker was a `private static consecutiveFailures` shared by
 * the whole process: three failures anywhere disabled compaction for every
 * conversation until restart, and shrink-guard bail-outs (a summary that did
 * not make the history smaller) counted as failures too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import CompactionService from "#src/services/compact/CompactionService";
import RequestLogger from "#src/services/RequestLogger";
import { COMPACTION } from "#src/constants";
import type { ChatMessage } from "#src/types/admin";

const mockGenerateText = vi.fn();

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/services/ModelRoleRouter", () => ({
  MODEL_ROLES: { UTILITY: "utility", COMPACTION: "compaction" },
  default: {
    resolveChain: vi.fn().mockResolvedValue([
      { provider: "test-provider", model: "test-model" },
    ]),
    runWithChain: vi.fn().mockImplementation(
      async (
        chain: Array<{ provider: string; model: string }>,
        run: (entry: { provider: string; model: string }) => Promise<unknown>,
      ) => ({ value: await run(chain[0]) }),
    ),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { logBackgroundLlmCall: vi.fn() },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

/**
 * A history long enough that a short summary always shrinks it — and longer
 * than the recency-protected window (4 model calls), so there is always an
 * older span to summarize.
 */
function buildHistory(turns: number, charactersPerMessage = 4_000): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ role: "user", content: `question ${turn} ${"q".repeat(charactersPerMessage)}` });
    messages.push({ role: "assistant", content: `answer ${turn} ${"a".repeat(charactersPerMessage)}` });
  }
  return messages;
}

const GOOD_SUMMARY = {
  text: "<summary>The user asked questions; the assistant answered them.</summary>",
  usage: { inputTokens: 100, outputTokens: 20 },
};

function summarizeCallCount(): number {
  return vi
    .mocked(RequestLogger.logBackgroundLlmCall)
    .mock.calls.filter(([entry]) => entry.operation === "compact:summarize").length;
}

function optionsFor(conversationId: string) {
  return {
    project: "prism-test",
    username: "test-user",
    agentConversationId: conversationId,
    fallbackProvider: "test-provider",
    fallbackModel: "test-model",
  };
}

describe("CompactionService circuit breaker — per conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CompactionService.resetCircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("three failures in conversation A leave compaction running in conversation B", async () => {
    mockGenerateText.mockRejectedValue(new Error("utility model down"));
    for (let attempt = 0; attempt < COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES; attempt++) {
      const result = await CompactionService.compactConversation(
        buildHistory(8),
        optionsFor("conversation-A"),
      );
      expect(result).toBeNull();
    }
    expect(summarizeCallCount()).toBe(COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES);

    // A's breaker is open: a fourth attempt never reaches the provider.
    await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));
    expect(summarizeCallCount()).toBe(COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES);

    // B has its own breaker, and it is closed.
    mockGenerateText.mockResolvedValue(GOOD_SUMMARY);
    const resultB = await CompactionService.compactConversation(
      buildHistory(8),
      optionsFor("conversation-B"),
    );
    expect(summarizeCallCount()).toBe(COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES + 1);
    expect(resultB).not.toBeNull();
  });

  it("a success resets that conversation's breaker", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("blip"));
    mockGenerateText.mockRejectedValueOnce(new Error("blip"));
    await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));
    await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));

    mockGenerateText.mockResolvedValue(GOOD_SUMMARY);
    expect(
      await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A")),
    ).not.toBeNull();

    // Two more failures would have opened the breaker without the reset.
    mockGenerateText.mockRejectedValue(new Error("blip"));
    await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));
    await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));
    expect(CompactionService.isCircuitBreakerOpen("conversation-A")).toBe(false);
  });

  it("shrink-guard bail-outs do not trip the breaker", async () => {
    // A summary far larger than the history: the result is discarded.
    mockGenerateText.mockResolvedValue({
      text: `<summary>${"x".repeat(200_000)}</summary>`,
      usage: { inputTokens: 100, outputTokens: 50_000 },
    });

    let history = buildHistory(8);
    for (let attempt = 0; attempt < COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES + 1; attempt++) {
      expect(
        await CompactionService.compactConversation(history, optionsFor("conversation-A")),
      ).toBeNull();
      // Let the history grow enough between attempts that it is worth
      // re-trying — a same-size history is skipped without a call.
      history = [...history, ...buildHistory(2)];
    }
    expect(CompactionService.isCircuitBreakerOpen("conversation-A")).toBe(false);
    expect(summarizeCallCount()).toBe(COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES + 1);
  });

  it("does not re-summarize a history that already failed to shrink until it grows", async () => {
    mockGenerateText.mockResolvedValue({
      text: `<summary>${"x".repeat(200_000)}</summary>`,
      usage: { inputTokens: 100, outputTokens: 50_000 },
    });
    const history = buildHistory(8);
    await CompactionService.compactConversation(history, optionsFor("conversation-A"));
    await CompactionService.compactConversation(history, optionsFor("conversation-A"));
    expect(summarizeCallCount()).toBe(1);
  });

  it("forgets a conversation's failures after the breaker TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
    mockGenerateText.mockRejectedValue(new Error("utility model down"));
    for (let attempt = 0; attempt < COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES; attempt++) {
      await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));
    }
    expect(CompactionService.isCircuitBreakerOpen("conversation-A")).toBe(true);

    vi.setSystemTime(
      new Date(Date.now() + COMPACTION.CIRCUIT_BREAKER_TTL_MILLISECONDS + 1_000),
    );
    expect(CompactionService.isCircuitBreakerOpen("conversation-A")).toBe(false);
  });

  it("resetCircuitBreaker() still clears every conversation (test helper)", async () => {
    mockGenerateText.mockRejectedValue(new Error("utility model down"));
    for (let attempt = 0; attempt < COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES; attempt++) {
      await CompactionService.compactConversation(buildHistory(8), optionsFor("conversation-A"));
    }
    CompactionService.resetCircuitBreaker();
    expect(CompactionService.isCircuitBreakerOpen("conversation-A")).toBe(false);
  });
});

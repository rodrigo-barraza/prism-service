/**
 * ConversationGenerationTracker — tests for the per-session in-memory throughput
 * tracker that powers the frontend tok/s badge.
 *
 * This is the authoritative source of token throughput data for the UI.
 * If register/update/complete lifecycle is broken, the frontend shows
 * stale or incorrect tok/s. If cleanup leaks, memory grows unbounded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const { default: ConversationGenerationTracker } = await import(
  "#src/services/ConversationGenerationTracker"
);
import { PROVIDERS } from "#src/constants";

// ═══════════════════════════════════════════════════════════════
describe("ConversationGenerationTracker — lifecycle", () => {
  beforeEach(() => {
    ConversationGenerationTracker.cleanup("session-1");
    ConversationGenerationTracker.cleanup("session-2");
  });

  it("should register a request and track it as active", () => {
    ConversationGenerationTracker.register("session-1", "req-1", {
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3.5-flash",
    });

    expect(ConversationGenerationTracker.hasActiveRequests("session-1")).toBe(true);
    expect(ConversationGenerationTracker.totalActiveRequests).toBeGreaterThanOrEqual(1);
  });

  it("should not register with empty agentConversationId", () => {
    ConversationGenerationTracker.register("", "req-empty");

    expect(ConversationGenerationTracker.hasActiveRequests("")).toBe(false);
  });

  it("should not register with empty requestId", () => {
    ConversationGenerationTracker.register("session-1", "");

    expect(ConversationGenerationTracker.hasActiveRequests("session-1")).toBe(false);
  });

  it("should remove active request on complete", () => {
    ConversationGenerationTracker.register("session-1", "req-2");

    ConversationGenerationTracker.complete("req-2");

    expect(ConversationGenerationTracker.hasActiveRequests("session-1")).toBe(false);
  });

  it("should be a no-op when completing an unknown requestId", () => {
    // Should not throw
    expect(() => {
      ConversationGenerationTracker.complete("nonexistent-req");
    }).not.toThrow();
  });

  it("should track multiple active requests per session", () => {
    ConversationGenerationTracker.register("session-1", "req-a");
    ConversationGenerationTracker.register("session-1", "req-b");

    const stats = ConversationGenerationTracker.getSessionStats("session-1");

    expect(stats.activeRequests).toBe(2);
  });

  it("should clean up all requests and accumulators for a session", () => {
    ConversationGenerationTracker.register("session-1", "req-a");
    ConversationGenerationTracker.register("session-1", "req-b");

    ConversationGenerationTracker.cleanup("session-1");

    expect(ConversationGenerationTracker.hasActiveRequests("session-1")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ConversationGenerationTracker — stats computation", () => {
  beforeEach(() => {
    ConversationGenerationTracker.cleanup("session-1");
  });

  it("should return zero stats for a session with no requests", () => {
    const stats = ConversationGenerationTracker.getSessionStats("nonexistent-session");

    expect(stats.activeRequests).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.tokPerSec).toBeNull();
    expect(stats.avgTtft).toBeNull();
  });

  it("should accumulate output tokens from active requests", () => {
    ConversationGenerationTracker.register("session-1", "req-1");
    ConversationGenerationTracker.update("req-1", { outputTokens: 100 });

    const stats = ConversationGenerationTracker.getSessionStats("session-1");

    expect(stats.totalOutputTokens).toBe(100);
  });

  it("should accumulate input tokens from active requests", () => {
    ConversationGenerationTracker.register("session-1", "req-1");
    ConversationGenerationTracker.update("req-1", { inputTokens: 500 });

    const stats = ConversationGenerationTracker.getSessionStats("session-1");

    expect(stats.totalInputTokens).toBe(500);
  });

  it("should preserve cumulative tokens across request completions", () => {
    ConversationGenerationTracker.register("session-1", "req-1");
    ConversationGenerationTracker.update("req-1", { outputTokens: 100, inputTokens: 200 });
    ConversationGenerationTracker.complete("req-1");

    ConversationGenerationTracker.register("session-1", "req-2");
    ConversationGenerationTracker.update("req-2", { outputTokens: 50, inputTokens: 150 });

    const stats = ConversationGenerationTracker.getSessionStats("session-1");

    expect(stats.totalOutputTokens).toBe(150); // 100 completed + 50 active
    expect(stats.totalInputTokens).toBe(350); // 200 completed + 150 active
    expect(stats.totalTokens).toBe(500);
  });

  it("should track TTFT samples and compute average", () => {
    ConversationGenerationTracker.register("session-1", "req-1");
    ConversationGenerationTracker.update("req-1", { ttft: 0.5 });
    ConversationGenerationTracker.complete("req-1");

    ConversationGenerationTracker.register("session-1", "req-2");
    ConversationGenerationTracker.update("req-2", { ttft: 1.0 });
    ConversationGenerationTracker.complete("req-2");

    const stats = ConversationGenerationTracker.getSessionStats("session-1");

    expect(stats.avgTtft).toBeCloseTo(0.75, 2);
  });

  it("should record chunk timing for character-based token estimation", () => {
    ConversationGenerationTracker.register("session-1", "req-1");
    ConversationGenerationTracker.recordChunkTiming("req-1", 100);
    ConversationGenerationTracker.recordChunkTiming("req-1", 200);

    // The tracker should have accumulated 300 output characters
    // When completed without provider tokens, it estimates ~75 tokens (300/4)
    ConversationGenerationTracker.complete("req-1");

    const stats = ConversationGenerationTracker.getSessionStats("session-1");

    // The character-estimated tokens should show up
    expect(stats.totalOutputTokens).toBe(75);
  });

  it("should be a no-op for recordChunkTiming with unknown requestId", () => {
    expect(() => {
      ConversationGenerationTracker.recordChunkTiming("unknown-req", 100);
    }).not.toThrow();
  });

  it("should be a no-op for update with unknown requestId", () => {
    expect(() => {
      ConversationGenerationTracker.update("unknown-req", { outputTokens: 50 });
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ConversationGenerationTracker — cross-session isolation", () => {
  beforeEach(() => {
    ConversationGenerationTracker.cleanup("session-a");
    ConversationGenerationTracker.cleanup("session-b");
  });

  it("should not leak state between sessions", () => {
    ConversationGenerationTracker.register("session-a", "req-a1");
    ConversationGenerationTracker.update("req-a1", { outputTokens: 100 });

    ConversationGenerationTracker.register("session-b", "req-b1");
    ConversationGenerationTracker.update("req-b1", { outputTokens: 200 });

    const statsA = ConversationGenerationTracker.getSessionStats("session-a");
    const statsB = ConversationGenerationTracker.getSessionStats("session-b");

    expect(statsA.totalOutputTokens).toBe(100);
    expect(statsB.totalOutputTokens).toBe(200);
  });

  it("should not affect other sessions when cleaning up one", () => {
    ConversationGenerationTracker.register("session-a", "req-a1");
    ConversationGenerationTracker.register("session-b", "req-b1");

    ConversationGenerationTracker.cleanup("session-a");

    expect(ConversationGenerationTracker.hasActiveRequests("session-a")).toBe(false);
    expect(ConversationGenerationTracker.hasActiveRequests("session-b")).toBe(true);

    ConversationGenerationTracker.cleanup("session-b");
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('ConversationGenerationTracker adversarial', () => {
  afterEach(() => {
    // Clean up any state leaked between tests
    ConversationGenerationTracker.cleanup('adversarial-session');
    ConversationGenerationTracker.cleanup('session-a');
    ConversationGenerationTracker.cleanup('session-b');
    ConversationGenerationTracker.cleanup('orphan-session');
  });

  it('should silently ignore register with empty agentConversationId', () => {
    ConversationGenerationTracker.register('', 'req-1');
    expect(ConversationGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should silently ignore register with empty requestId', () => {
    ConversationGenerationTracker.register('session-1', '');
    expect(ConversationGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should silently ignore update for non-existent requestId', () => {
    // Should not throw
    ConversationGenerationTracker.update('nonexistent-request', { outputTokens: 100 });
  });

  it('should silently ignore complete for non-existent requestId', () => {
    // Should not throw
    ConversationGenerationTracker.complete('nonexistent-request');
  });

  it('should handle double-complete of the same request — idempotent', () => {
    ConversationGenerationTracker.register('adversarial-session', 'double-req');
    ConversationGenerationTracker.complete('double-req');
    // Second complete should be a no-op (entry already deleted)
    ConversationGenerationTracker.complete('double-req');
    expect(ConversationGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should return zeroed stats for unknown session', () => {
    const stats = ConversationGenerationTracker.getSessionStats('unknown-session');
    expect(stats.activeRequests).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.tokPerSec).toBeNull();
    expect(stats.avgTtft).toBeNull();
  });

  it('should isolate stats between different sessions', () => {
    ConversationGenerationTracker.register('session-a', 'req-a', { provider: PROVIDERS.OPENAI, model: 'gpt-5' });
    ConversationGenerationTracker.register('session-b', 'req-b', { provider: PROVIDERS.GOOGLE, model: 'gemini-3-flash' });

    ConversationGenerationTracker.update('req-a', { outputTokens: 500 });
    ConversationGenerationTracker.update('req-b', { outputTokens: 1000 });

    const statsA = ConversationGenerationTracker.getSessionStats('session-a');
    const statsB = ConversationGenerationTracker.getSessionStats('session-b');

    // Each session should only see its own request's tokens
    expect(statsA.activeRequests).toBe(1);
    expect(statsB.activeRequests).toBe(1);
  });

  it('should accumulate completed tokens across iterations', () => {
    ConversationGenerationTracker.register('adversarial-session', 'iter-1');
    ConversationGenerationTracker.update('iter-1', { outputTokens: 100 });
    ConversationGenerationTracker.complete('iter-1');

    ConversationGenerationTracker.register('adversarial-session', 'iter-2');
    ConversationGenerationTracker.update('iter-2', { outputTokens: 200 });

    const stats = ConversationGenerationTracker.getSessionStats('adversarial-session');
    // 100 completed + 200 active = 300 total
    expect(stats.totalOutputTokens).toBe(300);
  });

  it('should handle cleanup of session with active requests — no orphaned entries', () => {
    ConversationGenerationTracker.register('orphan-session', 'orphan-req-1');
    ConversationGenerationTracker.register('orphan-session', 'orphan-req-2');
    ConversationGenerationTracker.cleanup('orphan-session');
    expect(ConversationGenerationTracker.hasActiveRequests('orphan-session')).toBe(false);
    expect(ConversationGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should handle recordChunkTiming on non-existent request — no throw', () => {
    ConversationGenerationTracker.recordChunkTiming('ghost-request', 100);
    // Should not throw
  });

  it('should not report tokPerSec during warm-up period (< MIN_ELAPSED_SEC)', () => {
    ConversationGenerationTracker.register('adversarial-session', 'fast-req');
    // Set firstTokenTime and lastTokenTime very close together (< 500ms)
    ConversationGenerationTracker.recordChunkTiming('fast-req', 5);
    ConversationGenerationTracker.update('fast-req', { outputTokens: 100 });

    const stats = ConversationGenerationTracker.getSessionStats('adversarial-session');
    // Should be null because elapsed time is too short
    expect(stats.tokPerSec).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ConversationGenerationTracker — live cost estimation", () => {
  // Resolve a priced model dynamically from config so the test doesn't
  // break when the model catalog changes.
  let pricedModel: string;
  let inputPerMillion: number;
  let outputPerMillion: number;

  beforeEach(async () => {
    ConversationGenerationTracker.cleanup("cost-session");
    const { getPricing, MODALITY_TYPES } = await import("#src/config");
    const pricingMap = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT);
    const entry = Object.entries(pricingMap).find(
      ([, pricing]) =>
        (pricing.inputPerMillion || 0) > 0 && (pricing.outputPerMillion || 0) > 0,
    );
    expect(entry).toBeDefined();
    pricedModel = entry![0];
    inputPerMillion = entry![1].inputPerMillion;
    outputPerMillion = entry![1].outputPerMillion;
  });

  afterEach(() => {
    ConversationGenerationTracker.cleanup("cost-session");
  });

  it("estimates cost from streamed characters + estimated input before usage arrives", () => {
    ConversationGenerationTracker.register("cost-session", "cost-req-1", {
      model: pricedModel,
    });
    ConversationGenerationTracker.setEstimatedInputTokens("cost-req-1", 1000);
    // 4000 chars ≈ 1000 output tokens via the chars/4 heuristic
    ConversationGenerationTracker.recordChunkTiming("cost-req-1", 4000);

    const stats = ConversationGenerationTracker.getConversationStats("cost-session");
    const expected =
      (1000 / 1_000_000) * inputPerMillion + (1000 / 1_000_000) * outputPerMillion;
    expect(stats.estimatedCost).toBeCloseTo(expected, 8);
  });

  it("prefers provider-reported usage over estimates once it arrives", () => {
    ConversationGenerationTracker.register("cost-session", "cost-req-2", {
      model: pricedModel,
    });
    ConversationGenerationTracker.setEstimatedInputTokens("cost-req-2", 9999);
    ConversationGenerationTracker.recordChunkTiming("cost-req-2", 4000);
    ConversationGenerationTracker.update("cost-req-2", {
      inputTokens: 2000,
      outputTokens: 500,
    });

    const stats = ConversationGenerationTracker.getConversationStats("cost-session");
    const expected =
      (2000 / 1_000_000) * inputPerMillion + (500 / 1_000_000) * outputPerMillion;
    expect(stats.estimatedCost).toBeCloseTo(expected, 8);
  });

  it("rolls cost into the accumulator on complete (monotonic across iterations)", () => {
    ConversationGenerationTracker.register("cost-session", "cost-req-3", {
      model: pricedModel,
    });
    ConversationGenerationTracker.update("cost-req-3", {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const before =
      ConversationGenerationTracker.getConversationStats("cost-session").estimatedCost;
    ConversationGenerationTracker.complete("cost-req-3");
    const after =
      ConversationGenerationTracker.getConversationStats("cost-session").estimatedCost;

    expect(before).toBeGreaterThan(0);
    expect(after).toBeCloseTo(before, 8);
  });

  it("reports zero cost for unpriced (local) models", () => {
    ConversationGenerationTracker.register("cost-session", "cost-req-4", {
      model: "some-local-unpriced-model",
    });
    ConversationGenerationTracker.setEstimatedInputTokens("cost-req-4", 5000);
    ConversationGenerationTracker.recordChunkTiming("cost-req-4", 8000);

    const stats = ConversationGenerationTracker.getConversationStats("cost-session");
    expect(stats.estimatedCost).toBe(0);
  });
});

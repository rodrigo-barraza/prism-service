/**
 * SessionGenerationTracker — tests for the per-session in-memory throughput
 * tracker that powers the frontend tok/s badge.
 *
 * This is the authoritative source of token throughput data for the UI.
 * If register/update/complete lifecycle is broken, the frontend shows
 * stale or incorrect tok/s. If cleanup leaks, memory grows unbounded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { default: SessionGenerationTracker } = await import(
  "../src/services/SessionGenerationTracker.ts"
);

// ═══════════════════════════════════════════════════════════════
describe("SessionGenerationTracker — lifecycle", () => {
  beforeEach(() => {
    SessionGenerationTracker.cleanup("session-1");
    SessionGenerationTracker.cleanup("session-2");
  });

  it("should register a request and track it as active", () => {
    SessionGenerationTracker.register("session-1", "req-1", {
      provider: "google",
      model: "gemini-3.5-flash",
    });

    expect(SessionGenerationTracker.hasActiveRequests("session-1")).toBe(true);
    expect(SessionGenerationTracker.totalActiveRequests).toBeGreaterThanOrEqual(1);
  });

  it("should not register with empty agentSessionId", () => {
    SessionGenerationTracker.register("", "req-empty");

    expect(SessionGenerationTracker.hasActiveRequests("")).toBe(false);
  });

  it("should not register with empty requestId", () => {
    SessionGenerationTracker.register("session-1", "");

    expect(SessionGenerationTracker.hasActiveRequests("session-1")).toBe(false);
  });

  it("should remove active request on complete", () => {
    SessionGenerationTracker.register("session-1", "req-2");

    SessionGenerationTracker.complete("req-2");

    expect(SessionGenerationTracker.hasActiveRequests("session-1")).toBe(false);
  });

  it("should be a no-op when completing an unknown requestId", () => {
    // Should not throw
    expect(() => {
      SessionGenerationTracker.complete("nonexistent-req");
    }).not.toThrow();
  });

  it("should track multiple active requests per session", () => {
    SessionGenerationTracker.register("session-1", "req-a");
    SessionGenerationTracker.register("session-1", "req-b");

    const stats = SessionGenerationTracker.getSessionStats("session-1");

    expect(stats.activeRequests).toBe(2);
  });

  it("should clean up all requests and accumulators for a session", () => {
    SessionGenerationTracker.register("session-1", "req-a");
    SessionGenerationTracker.register("session-1", "req-b");

    SessionGenerationTracker.cleanup("session-1");

    expect(SessionGenerationTracker.hasActiveRequests("session-1")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("SessionGenerationTracker — stats computation", () => {
  beforeEach(() => {
    SessionGenerationTracker.cleanup("session-1");
  });

  it("should return zero stats for a session with no requests", () => {
    const stats = SessionGenerationTracker.getSessionStats("nonexistent-session");

    expect(stats.activeRequests).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.tokPerSec).toBeNull();
    expect(stats.avgTtft).toBeNull();
  });

  it("should accumulate output tokens from active requests", () => {
    SessionGenerationTracker.register("session-1", "req-1");
    SessionGenerationTracker.update("req-1", { outputTokens: 100 });

    const stats = SessionGenerationTracker.getSessionStats("session-1");

    expect(stats.totalOutputTokens).toBe(100);
  });

  it("should accumulate input tokens from active requests", () => {
    SessionGenerationTracker.register("session-1", "req-1");
    SessionGenerationTracker.update("req-1", { inputTokens: 500 });

    const stats = SessionGenerationTracker.getSessionStats("session-1");

    expect(stats.totalInputTokens).toBe(500);
  });

  it("should preserve cumulative tokens across request completions", () => {
    SessionGenerationTracker.register("session-1", "req-1");
    SessionGenerationTracker.update("req-1", { outputTokens: 100, inputTokens: 200 });
    SessionGenerationTracker.complete("req-1");

    SessionGenerationTracker.register("session-1", "req-2");
    SessionGenerationTracker.update("req-2", { outputTokens: 50, inputTokens: 150 });

    const stats = SessionGenerationTracker.getSessionStats("session-1");

    expect(stats.totalOutputTokens).toBe(150); // 100 completed + 50 active
    expect(stats.totalInputTokens).toBe(350); // 200 completed + 150 active
    expect(stats.totalTokens).toBe(500);
  });

  it("should track TTFT samples and compute average", () => {
    SessionGenerationTracker.register("session-1", "req-1");
    SessionGenerationTracker.update("req-1", { ttft: 0.5 });
    SessionGenerationTracker.complete("req-1");

    SessionGenerationTracker.register("session-1", "req-2");
    SessionGenerationTracker.update("req-2", { ttft: 1.0 });
    SessionGenerationTracker.complete("req-2");

    const stats = SessionGenerationTracker.getSessionStats("session-1");

    expect(stats.avgTtft).toBeCloseTo(0.75, 2);
  });

  it("should record chunk timing for character-based token estimation", () => {
    SessionGenerationTracker.register("session-1", "req-1");
    SessionGenerationTracker.recordChunkTiming("req-1", 100);
    SessionGenerationTracker.recordChunkTiming("req-1", 200);

    // The tracker should have accumulated 300 output characters
    // When completed without provider tokens, it estimates ~75 tokens (300/4)
    SessionGenerationTracker.complete("req-1");

    const stats = SessionGenerationTracker.getSessionStats("session-1");

    // The character-estimated tokens should show up
    expect(stats.totalOutputTokens).toBe(75);
  });

  it("should be a no-op for recordChunkTiming with unknown requestId", () => {
    expect(() => {
      SessionGenerationTracker.recordChunkTiming("unknown-req", 100);
    }).not.toThrow();
  });

  it("should be a no-op for update with unknown requestId", () => {
    expect(() => {
      SessionGenerationTracker.update("unknown-req", { outputTokens: 50 });
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("SessionGenerationTracker — cross-session isolation", () => {
  beforeEach(() => {
    SessionGenerationTracker.cleanup("session-a");
    SessionGenerationTracker.cleanup("session-b");
  });

  it("should not leak state between sessions", () => {
    SessionGenerationTracker.register("session-a", "req-a1");
    SessionGenerationTracker.update("req-a1", { outputTokens: 100 });

    SessionGenerationTracker.register("session-b", "req-b1");
    SessionGenerationTracker.update("req-b1", { outputTokens: 200 });

    const statsA = SessionGenerationTracker.getSessionStats("session-a");
    const statsB = SessionGenerationTracker.getSessionStats("session-b");

    expect(statsA.totalOutputTokens).toBe(100);
    expect(statsB.totalOutputTokens).toBe(200);
  });

  it("should not affect other sessions when cleaning up one", () => {
    SessionGenerationTracker.register("session-a", "req-a1");
    SessionGenerationTracker.register("session-b", "req-b1");

    SessionGenerationTracker.cleanup("session-a");

    expect(SessionGenerationTracker.hasActiveRequests("session-a")).toBe(false);
    expect(SessionGenerationTracker.hasActiveRequests("session-b")).toBe(true);

    SessionGenerationTracker.cleanup("session-b");
  });
});

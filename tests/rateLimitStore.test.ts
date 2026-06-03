/**
 * RateLimitStore — tests for the in-memory rate limit cache.
 *
 * The rate limit store drives the admin dashboard's rate limit display.
 * If update() silently discards data or getAll() misgroups providers,
 * the admin sees stale or incorrect limits.
 */
import { describe, it, expect, beforeEach } from "vitest";

// Import the singleton — tests exercise its public interface
const { default: rateLimitStore } = await import(
  "../src/services/RateLimitStore.ts"
);

// ═══════════════════════════════════════════════════════════════
describe("RateLimitStore", () => {
  it("should always include Google static limits in getAll()", () => {
    const allLimits = rateLimitStore.getAll();

    expect(allLimits.google).toBeDefined();
    expect(allLimits.google.dynamic).toBe(false);
    expect(allLimits.google.models).toBeDefined();
    expect(allLimits.google.models["gemini-3.5-flash"]).toBeDefined();
  });

  it("should store and retrieve dynamic rate limits", () => {
    rateLimitStore.update("openai", "gpt-5.5", {
      rpm: 10000,
      tpm: 30_000_000,
      rpd: 10_000,
    });

    const allLimits = rateLimitStore.getAll();

    expect(allLimits.openai).toBeDefined();
    expect(allLimits.openai.dynamic).toBe(true);
    expect(allLimits.openai.models["gpt-5.5"]).toBeDefined();

    const modelData = allLimits.openai.models["gpt-5.5"] as Record<string, unknown>;
    const limits = modelData.rateLimits as Record<string, unknown>;
    expect(limits.rpm).toBe(10000);
  });

  it("should group multiple models under the same provider", () => {
    rateLimitStore.update("anthropic", "claude-opus-4", {
      rpm: 4000,
      tpm: 400_000,
    });
    rateLimitStore.update("anthropic", "claude-4-sonnet", {
      rpm: 4000,
      tpm: 400_000,
    });

    const allLimits = rateLimitStore.getAll();

    expect(Object.keys(allLimits.anthropic.models)).toContain("claude-opus-4");
    expect(Object.keys(allLimits.anthropic.models)).toContain("claude-4-sonnet");
  });

  it("should be a no-op when rateLimits is null", () => {
    // Should not throw
    expect(() => {
      rateLimitStore.update("openai", "gpt-5.5", null as any);
    }).not.toThrow();
  });

  it("should be a no-op when provider is empty", () => {
    expect(() => {
      rateLimitStore.update("", "model", { rpm: 100 });
    }).not.toThrow();
  });

  it("should be a no-op when model is empty", () => {
    expect(() => {
      rateLimitStore.update("openai", "", { rpm: 100 });
    }).not.toThrow();
  });

  it("should overwrite previous limits on subsequent update", () => {
    rateLimitStore.update("openai", "overwrite-test", { rpm: 100 });
    rateLimitStore.update("openai", "overwrite-test", { rpm: 200 });

    const allLimits = rateLimitStore.getAll();
    const modelData = allLimits.openai.models["overwrite-test"] as Record<string, unknown>;
    const limits = modelData.rateLimits as Record<string, unknown>;

    expect(limits.rpm).toBe(200);
  });

  it("should include updatedAt timestamp on dynamic entries", () => {
    rateLimitStore.update("openai", "timestamp-test", { rpm: 100 });

    const allLimits = rateLimitStore.getAll();
    const modelData = allLimits.openai.models["timestamp-test"] as Record<string, unknown>;

    expect(modelData.updatedAt).toBeDefined();
    expect(typeof modelData.updatedAt).toBe("string");
  });
});

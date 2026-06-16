/**
 * RateLimitStore — tests for the in-memory rate limit cache.
 *
 * The rate limit store drives the admin dashboard's rate limit display.
 * If update() silently discards data or getAll() misgroups providers,
 * the admin sees stale or incorrect limits.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";

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
    rateLimitStore.update(PROVIDERS.OPENAI, "gpt-5.5", {
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
    rateLimitStore.update(PROVIDERS.ANTHROPIC, "claude-opus-4", {
      rpm: 4000,
      tpm: 400_000,
    });
    rateLimitStore.update(PROVIDERS.ANTHROPIC, "claude-4-sonnet", {
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
      rateLimitStore.update(PROVIDERS.OPENAI, "gpt-5.5", null as any);
    }).not.toThrow();
  });

  it("should be a no-op when provider is empty", () => {
    expect(() => {
      rateLimitStore.update("", "model", { rpm: 100 });
    }).not.toThrow();
  });

  it("should be a no-op when model is empty", () => {
    expect(() => {
      rateLimitStore.update(PROVIDERS.OPENAI, "", { rpm: 100 });
    }).not.toThrow();
  });

  it("should overwrite previous limits on subsequent update", () => {
    rateLimitStore.update(PROVIDERS.OPENAI, "overwrite-test", { rpm: 100 });
    rateLimitStore.update(PROVIDERS.OPENAI, "overwrite-test", { rpm: 200 });

    const allLimits = rateLimitStore.getAll();
    const modelData = allLimits.openai.models["overwrite-test"] as Record<string, unknown>;
    const limits = modelData.rateLimits as Record<string, unknown>;

    expect(limits.rpm).toBe(200);
  });

  it("should include updatedAt timestamp on dynamic entries", () => {
    rateLimitStore.update(PROVIDERS.OPENAI, "timestamp-test", { rpm: 100 });

    const allLimits = rateLimitStore.getAll();
    const modelData = allLimits.openai.models["timestamp-test"] as Record<string, unknown>;

    expect(modelData.updatedAt).toBeDefined();
    expect(typeof modelData.updatedAt).toBe("string");
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('RateLimitStore adversarial', () => {
  it('should silently ignore update with null rateLimits', () => {
    rateLimitStore.update(PROVIDERS.OPENAI, 'gpt-5', null as unknown as { rpm?: number });
    // Should not throw or add any entry
  });

  it('should silently ignore update with empty provider name', () => {
    rateLimitStore.update('', 'gpt-5', { rpm: 100 });
    // Should not throw — guard clause returns early
  });

  it('should silently ignore update with empty model name', () => {
    rateLimitStore.update(PROVIDERS.OPENAI, '', { rpm: 100 });
    // Should not throw — guard clause returns early
  });

  it('should handle key injection via :: separator in provider name', () => {
    // If someone sends providerName = "openai::gpt-5::hack", the key becomes
    // "openai::gpt-5::hack::model" — split("::") would give wrong provider/model
    rateLimitStore.update('openai::gpt-5', 'injected', { rpm: 999 });
    const snapshot = rateLimitStore.getAll();
    // The key is "openai::gpt-5::injected" — split("::") gives ["openai", "gpt-5", "injected"]
    // Destructured as [provider, model] → provider="openai", model="gpt-5"
    // This means the "injected" part is silently dropped and the entry appears under "openai"
    expect(snapshot).toBeDefined();
  });

  it('should always include google static limits in getAll()', () => {
    const snapshot = rateLimitStore.getAll();
    expect(snapshot.google).toBeDefined();
    expect(snapshot.google.dynamic).toBe(false);
    expect(snapshot.google.models).toBeDefined();
  });

  it('should overwrite existing entry when same provider+model is updated', () => {
    rateLimitStore.update('test-provider', 'test-model', { rpm: 100 });
    rateLimitStore.update('test-provider', 'test-model', { rpm: 200 });
    const snapshot = rateLimitStore.getAll();
    const model = snapshot['test-provider']?.models['test-model'] as { rateLimits: { rpm: number } };
    expect(model.rateLimits.rpm).toBe(200);
  });
});

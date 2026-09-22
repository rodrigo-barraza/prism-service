/**
 * Anthropic catalog invariants — a new `claude-*` entry cannot regress the
 * request surface the provider derives from it (src/providers/anthropic.ts).
 * Values verified against platform.claude.com on 2026-09-22.
 */
import { describe, it, expect } from "vitest";
import { MODELS } from "#src/data/models";
import { PROVIDERS } from "#src/constants";

type CatalogEntry = Record<string, unknown> & {
  name: string;
  provider: string;
  pricing?: Record<string, number>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

const claudeEntries = (Object.values(MODELS) as unknown as CatalogEntry[]).filter(
  (entry) => entry.provider === PROVIDERS.ANTHROPIC && entry.name.startsWith("claude-"),
);

function entry(name: string): CatalogEntry {
  const found = claudeEntries.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} is not in the catalog`);
  return found;
}

/** Models whose context window is 1M tokens (platform.claude.com models overview). */
const ONE_MILLION_FAMILY = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
];

describe("Anthropic catalog invariants", () => {
  it("catalogs Opus 5.5 and Fable 5.1", () => {
    expect(entry("claude-opus-5-5")).toBeDefined();
    expect(entry("claude-fable-5-1")).toBeDefined();
  });

  it("every claude-* entry has input/output pricing and a context window", () => {
    for (const model of claudeEntries) {
      expect(model.pricing?.inputPerMillion, model.name).toBeGreaterThan(0);
      expect(model.pricing?.outputPerMillion, model.name).toBeGreaterThan(0);
      expect(model.pricing?.cachedInputPerMillion, model.name).toBeGreaterThan(0);
      expect(model.pricing?.cacheWriteInputPerMillion, model.name).toBeGreaterThan(0);
      expect(model.maxInputTokens, model.name).toBeGreaterThan(0);
      expect(model.maxOutputTokens, model.name).toBeGreaterThan(0);
    }
  });

  it("adaptive-thinking models reject sampling, so they are lockedSampling", () => {
    // Every adaptive-only model from Opus 4.7 on rejects non-default
    // temperature / top_p / top_k (Opus 4.6 / Sonnet 4.6 are not adaptive-only).
    for (const model of claudeEntries.filter((candidate) => candidate.adaptiveThinking === true)) {
      expect(model.lockedSampling, model.name).toBe(true);
    }
  });

  it("the 1M family has windows of at least 1,000,000 and 128K max output", () => {
    for (const name of ONE_MILLION_FAMILY) {
      expect(entry(name).maxInputTokens, name).toBeGreaterThanOrEqual(1_000_000);
      expect(entry(name).maxOutputTokens, name).toBe(128_000);
    }
  });

  it("every 4.6+ model rejects assistant prefill", () => {
    for (const name of ONE_MILLION_FAMILY) {
      expect(entry(name).noAssistantPrefill, name).toBe(true);
    }
  });

  it("Opus 5.5 and Fable 5.1 cannot disable thinking or force tool_choice", () => {
    for (const name of ["claude-opus-5-5", "claude-fable-5-1"]) {
      expect(entry(name).thinkingAlwaysOn, name).toBe(true);
      expect(entry(name).noForcedToolChoice, name).toBe(true);
      expect(entry(name).preservedThinking, name).toBe(true);
    }
    expect(entry("claude-fable-5").thinkingAlwaysOn).toBe(true);
    expect(entry("claude-opus-5").thinkingDisableMaxEffort).toBe("high");
  });

  it("prices Opus 5.5 and Fable 5.1 per the pricing page", () => {
    expect(entry("claude-opus-5-5").pricing).toEqual({
      inputPerMillion: 4,
      cachedInputPerMillion: 0.2,
      cacheWriteInputPerMillion: 5,
      outputPerMillion: 20,
    });
    expect(entry("claude-fable-5-1").pricing).toEqual({
      inputPerMillion: 10,
      cachedInputPerMillion: 0.25,
      cacheWriteInputPerMillion: 12.5,
      outputPerMillion: 50,
    });
  });

  it("defaults the Anthropic provider to Sonnet 5", () => {
    const defaults = claudeEntries.filter((model) => model.default === true);
    expect(defaults.map((model) => model.name)).toEqual(["claude-sonnet-5"]);
  });
});

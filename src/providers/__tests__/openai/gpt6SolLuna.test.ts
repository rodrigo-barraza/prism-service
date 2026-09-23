/**
 * gpt-6-sol / gpt-6-luna catalog entries (released 2026-09-22), the
 * catalog invariants every GPT-6 model must satisfy, and the cache-write
 * bucket GPT-6 reports in Responses usage.
 */
import { describe, it, expect } from "vitest";
import {
  MODELS,
  PROVIDERS,
  getModelByName,
  getModelNativeCapabilities,
  getModelOptions,
  MODALITY_TYPES,
} from "#src/config";
import { normalizeResponsesUsage, effortForModel } from "#src/providers/openai";
import { calculateTextCost } from "#src/utils/CostCalculator";

const ALL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

describe("gpt-6-sol and gpt-6-luna catalog entries", () => {
  it("carry the published prices (2026-09-22)", () => {
    expect(MODELS.GPT_6_SOL.pricing).toMatchObject({
      inputPerMillion: 2.0,
      cachedInputPerMillion: 0.2,
      cacheWriteInputPerMillion: 2.5,
      outputPerMillion: 10.0,
    });
    expect(MODELS.GPT_6_LUNA.pricing).toMatchObject({
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.01,
      cacheWriteInputPerMillion: 0.125,
      outputPerMillion: 0.5,
    });
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])(
    "%s: 922K input + 128K output, effort none (thinking off) … max, Responses only",
    (name) => {
      const model = getModelByName(name) as unknown as Record<string, unknown>;
      expect(model).toBeTruthy();
      expect(model.provider).toBe(PROVIDERS.OPENAI);
      expect(model.maxInputTokens).toBe(922_000);
      expect(model.maxOutputTokens).toBe(128_000);
      // "none" is thinking off — never a listed level (the catalog's shared
      // vocabulary); canDisableThinking is how the model says it takes it.
      expect(model.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(model.canDisableThinking).toBe(true);
      // Chat Completions only allows function calling at effort "none".
      expect(model.responsesAPI).toBe(true);
      expect(model.inputTypes).toEqual([MODALITY_TYPES.TEXT, MODALITY_TYPES.IMAGE]);
    },
  );

  it.each(["gpt-6-sol", "gpt-6-luna"])(
    "%s: over 272K input bills 2x input and cache, 1.5x output",
    (name) => {
      const pricing = (getModelByName(name) as unknown as {
        pricing: Record<string, number>;
      }).pricing;
      expect(pricing.inputOver272kPerMillion).toBeCloseTo(pricing.inputPerMillion * 2, 6);
      expect(pricing.cachedInputOver272kPerMillion).toBeCloseTo(
        pricing.cachedInputPerMillion * 2,
        6,
      );
      expect(pricing.cacheWriteInputOver272kPerMillion).toBeCloseTo(
        pricing.cacheWriteInputPerMillion * 2,
        6,
      );
      expect(pricing.outputOver272kPerMillion).toBeCloseTo(pricing.outputPerMillion * 1.5, 6);
    },
  );

  it.each(["gpt-6-sol", "gpt-6-luna"])("%s: every GPT-6 native feature", (name) => {
    expect(getModelNativeCapabilities(name)).toEqual({
      asyncTools: true,
      steering: true,
      programmaticToolCalling: true,
      configurationUpdate: true,
    });
  });

  it("forwards effort none on Sol/Luna and still drops it on Astra", () => {
    expect(effortForModel("gpt-6-sol", "none")).toBe("none");
    expect(effortForModel("gpt-6-luna", "none")).toBe("none");
    expect(effortForModel("gpt-6-luna", "max")).toBe("max");
    expect(effortForModel("gpt-6-astra", "none")).toBeUndefined();
  });

  it("lists both as OpenAI text models", () => {
    const names = getModelOptions(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).openai.map(
      (option) => option.name,
    );
    expect(names).toEqual(expect.arrayContaining(["gpt-6-sol", "gpt-6-luna"]));
  });
});

describe("GPT-6 catalog invariant", () => {
  const gpt6 = Object.values(MODELS).filter((model) =>
    String((model as { name?: string }).name).startsWith("gpt-6-"),
  ) as unknown as Array<Record<string, unknown> & { name: string; pricing: Record<string, number> }>;

  it("covers astra, sol and luna", () => {
    expect(gpt6.map((model) => model.name).sort()).toEqual([
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
    ]);
  });

  it.each(gpt6.map((model) => [model.name, model] as const))(
    "%s: positive prices, cache read < input < cache write, a valid effort set",
    (_name, model) => {
      const pricing = model.pricing;
      for (const key of [
        "inputPerMillion",
        "cachedInputPerMillion",
        "cacheWriteInputPerMillion",
        "outputPerMillion",
      ]) {
        expect(pricing[key], key).toBeGreaterThan(0);
      }
      expect(pricing.cachedInputPerMillion).toBeLessThan(pricing.inputPerMillion);
      expect(pricing.cacheWriteInputPerMillion).toBeGreaterThan(pricing.inputPerMillion);
      const levels = model.thinkingLevels as string[];
      expect(levels.length).toBeGreaterThan(0);
      for (const level of levels) expect(ALL_EFFORTS).toContain(level);
      // Ordered weakest → strongest, no duplicates.
      const ranks = levels.map((level) => ALL_EFFORTS.indexOf(level));
      expect([...ranks].sort((left, right) => left - right)).toEqual(ranks);
      expect(new Set(levels).size).toBe(levels.length);
      expect(model.responsesAPI).toBe(true);
    },
  );
});

describe("normalizeResponsesUsage — GPT-6 cache writes", () => {
  it("splits input_tokens into uncached, cache read and cache write", () => {
    // Live gpt-6-luna usage (2026-09-22): input_tokens counts all three.
    const usage = normalizeResponsesUsage({
      input_tokens: 7474,
      input_tokens_details: { cached_tokens: 7460, cache_write_tokens: 11 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 0 },
    } as Parameters<typeof normalizeResponsesUsage>[0]);
    expect(usage).toEqual({
      inputTokens: 3,
      outputTokens: 6,
      cacheReadInputTokens: 7460,
      cacheCreationInputTokens: 11,
    });
  });

  it("bills a first-write request at the cache-write rate", () => {
    const usage = normalizeResponsesUsage({
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_000_000 },
      output_tokens: 0,
    } as Parameters<typeof normalizeResponsesUsage>[0]);
    // $2.50 at Sol's cache-write rate, not $2.00 + $2.50.
    expect(calculateTextCost(usage, MODELS.GPT_6_SOL.pricing)).toBeCloseTo(2.5, 6);
  });
});

/**
 * Gemini 4 Argon (gemini-4-argon, GA 2026-10-13), verified that day against
 * ai.google.dev (model page, "What's new in Gemini 4 Argon", pricing) and
 * live on the API:
 *   - 1,048,576 in / 65,536 out — past 64K needs background execution on the
 *     Interactions API ("long decode"), which Prism does not use
 *   - thinking low | medium | high; "minimal" is a 400, thinkingBudget 0 is a
 *     200 with no thought tokens
 *   - temperature / top_p / top_k are ignored ("Remove … from your requests")
 *   - implicit caching only: no cachedContents
 *   - introductory rate card through 2026-11-30: $2 in / $10 out / $0.10 cached
 */
import { describe, it, expect } from "vitest";

import { buildGenerateConfig } from "#src/providers/google";
import { getModelProfile } from "#src/providers/ModelProfiles";
import {
  getDefaultModels,
  getModelByName,
  getModelOptions,
  getPricing,
  MODALITY_TYPES,
  PROVIDERS,
} from "#src/config";
import { calculateTextCost, type TextPricing } from "#src/utils/CostCalculator";
import type { ProviderOptions } from "#src/types/ProviderTypes";

type CatalogModel = Record<string, unknown> & { name: string };
const argon = () => getModelByName("gemini-4-argon") as unknown as CatalogModel;

describe("gemini-4-argon catalog entry", () => {
  it("1,048,576 in / 65,536 out, low|medium|high, thinking can be switched off", () => {
    const model = argon();
    expect(model).toBeTruthy();
    expect(model.label).toBe("Gemini 4 Argon");
    expect(model.provider).toBe(PROVIDERS.GOOGLE);
    expect(model.maxInputTokens).toBe(1_048_576);
    expect(model.maxOutputTokens).toBe(65_536);
    expect(model.thinking).toBe(true);
    expect(model.thinkingLevels).toEqual(["low", "medium", "high"]);
    expect(model.canDisableThinking).toBe(true);
    expect(model.lockedSampling).toBe(true);
    expect(model.implicitCacheOnly).toBe(true);
  });

  it("takes text, image, audio, video and PDF, and answers in text", () => {
    expect(argon().inputTypes).toEqual([
      MODALITY_TYPES.TEXT,
      MODALITY_TYPES.IMAGE,
      MODALITY_TYPES.AUDIO,
      MODALITY_TYPES.VIDEO,
      MODALITY_TYPES.PDF,
    ]);
    expect(argon().outputTypes).toEqual([MODALITY_TYPES.TEXT]);
  });

  it("is offered as a Google conversation model with its server-side tools, and changes no default", () => {
    const google = getModelOptions(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[PROVIDERS.GOOGLE] ?? [];
    const option = google.find((entry) => entry.name === "gemini-4-argon");
    expect(option).toMatchObject({
      label: "Gemini 4 Argon",
      thinking: true,
      vision: true,
      webSearch: "Google Search",
      codeExecution: true,
      urlContext: true,
      thinkingLevels: ["low", "medium", "high"],
      canDisableThinking: true,
      lockedSampling: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
    });
    expect(argon().default).toBeUndefined();
    expect(getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[PROVIDERS.GOOGLE]).not.toBe(
      "gemini-4-argon",
    );
  });
});

describe("gemini-4-argon pricing", () => {
  const pricing = () => getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)["gemini-4-argon"] as TextPricing;

  it("carries the introductory rate card, one input rate for every modality", () => {
    expect(pricing()).toEqual({
      inputPerMillion: 2.0,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 10.0,
      webSearchPer1kCalls: 14.0,
    });
  });

  it("bills thinking as output and cache hits at 95% off", () => {
    expect(calculateTextCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing())).toBe(12);
    expect(
      calculateTextCost({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 }, pricing()),
    ).toBe(0.1);
  });
});

describe("buildGenerateConfig — gemini-4-argon", () => {
  const model = () => argon() as never;

  it("sends no temperature, topP or topK", () => {
    const config = buildGenerateConfig({ temperature: 0.2, topP: 0.5, topK: 5 } as ProviderOptions, model());
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.topK).toBeUndefined();
  });

  it("switches thinking off with thinkingBudget 0 (minimal is a 400)", () => {
    expect(buildGenerateConfig({ thinkingEnabled: false } as ProviderOptions, model()).thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
  });

  it("forwards low|medium|high and never minimal", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(
        buildGenerateConfig({ thinkingLevel: level } as ProviderOptions, model()).thinkingConfig,
      ).toEqual({ includeThoughts: true, thinkingLevel: level });
    }
    expect(
      buildGenerateConfig({ thinkingLevel: "minimal" } as ProviderOptions, model()).thinkingConfig,
    ).toEqual({ includeThoughts: true });
  });
});

describe("ModelProfiles — gemini-4-argon", () => {
  it("rejects sampling, offers none|low|medium|high and only the implicit cache", () => {
    const profile = getModelProfile("gemini-4-argon", "google");
    expect(profile.rejectedParameters).toEqual(["temperature", "topP", "topK"]);
    expect(profile.efforts).toEqual(["none", "low", "medium", "high"]);
    expect(profile.caching).toEqual(["implicit"]);
    expect(profile.cacheLifeSeconds).toBe(600);
  });

  it("leaves the other Gemini models' explicit cachedContents in place", () => {
    expect(getModelProfile("gemini-3.8-flash", "google").caching).toEqual([
      "implicit",
      "explicit_cached_content",
    ]);
  });
});

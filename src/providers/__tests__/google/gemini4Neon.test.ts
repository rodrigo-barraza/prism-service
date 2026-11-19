/**
 * Gemini 4 Neon (gemini-4-neon, released 2026-11-18), verified on 2026-11-19
 * against Google's docs (model page, "What's new in Gemini 4 Neon", thinking,
 * caching, pricing) and live on the API:
 *   - 1,048,576 in / 65,536 out (models.get)
 *   - thinking low | medium | high | xhigh, Google's default high; "minimal"
 *     is a 400, and thinkingBudget 0 does NOT switch thinking off (still 104–117
 *     thought tokens on a one-word answer), so "off" sends the lowest level
 *   - temperature / top_p / top_k in range are ignored, out of range a 400
 *   - implicit caching only: no cachedContents
 *   - $3 in / $15 out / $0.15 cached, one input rate for every modality, no
 *     introductory rate card
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
const neon = () => getModelByName("gemini-4-neon") as unknown as CatalogModel;

describe("gemini-4-neon catalog entry", () => {
  it("1,048,576 in / 65,536 out, low|medium|high|xhigh, thinking cannot be switched off", () => {
    const model = neon();
    expect(model).toBeTruthy();
    expect(model.label).toBe("Gemini 4 Neon");
    expect(model.provider).toBe(PROVIDERS.GOOGLE);
    expect(model.maxInputTokens).toBe(1_048_576);
    expect(model.maxOutputTokens).toBe(65_536);
    expect(model.thinking).toBe(true);
    expect(model.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(model.canDisableThinking).toBe(false);
    expect(model.lockedSampling).toBe(true);
    expect(model.implicitCacheOnly).toBe(true);
  });

  it("takes text, image, audio, video and PDF, and answers in text", () => {
    expect(neon().inputTypes).toEqual([
      MODALITY_TYPES.TEXT,
      MODALITY_TYPES.IMAGE,
      MODALITY_TYPES.AUDIO,
      MODALITY_TYPES.VIDEO,
      MODALITY_TYPES.PDF,
    ]);
    expect(neon().outputTypes).toEqual([MODALITY_TYPES.TEXT]);
  });

  it("is offered as a Google conversation model with its server-side tools, and changes no default", () => {
    const google = getModelOptions(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[PROVIDERS.GOOGLE] ?? [];
    const option = google.find((entry) => entry.name === "gemini-4-neon");
    expect(option).toMatchObject({
      label: "Gemini 4 Neon",
      thinking: true,
      vision: true,
      webSearch: "Google Search",
      codeExecution: true,
      urlContext: true,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
      canDisableThinking: false,
      lockedSampling: true,
      contextLength: 1_048_576,
      maxOutputTokens: 65_536,
    });
    expect(neon().default).toBeUndefined();
    expect(getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[PROVIDERS.GOOGLE]).not.toBe(
      "gemini-4-neon",
    );
  });
});

describe("gemini-4-neon pricing", () => {
  const pricing = () => getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)["gemini-4-neon"] as TextPricing;

  it("carries Google's rate card, one input rate for every modality, with no schedule", () => {
    expect(pricing()).toEqual({
      inputPerMillion: 3.0,
      cachedInputPerMillion: 0.15,
      outputPerMillion: 15.0,
      webSearchPer1kCalls: 14.0,
    });
    expect(neon().pricingSchedule).toBeUndefined();
  });

  it("bills thinking as output and cache hits at 95% off", () => {
    expect(calculateTextCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing())).toBe(18);
    expect(
      calculateTextCost({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 }, pricing()),
    ).toBe(0.15);
  });
});

describe("buildGenerateConfig — gemini-4-neon", () => {
  const model = () => neon() as never;

  it("sends no temperature, topP or topK", () => {
    const config = buildGenerateConfig({ temperature: 0.2, topP: 0.5, topK: 5 } as ProviderOptions, model());
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.topK).toBeUndefined();
  });

  it("answers 'thinking off' with its lowest level, never thinkingBudget 0 or minimal", () => {
    expect(buildGenerateConfig({ thinkingEnabled: false } as ProviderOptions, model()).thinkingConfig).toEqual({
      thinkingLevel: "low",
    });
  });

  it("forwards low|medium|high|xhigh and never minimal", () => {
    for (const level of ["low", "medium", "high", "xhigh"]) {
      expect(
        buildGenerateConfig({ thinkingLevel: level } as ProviderOptions, model()).thinkingConfig,
      ).toEqual({ includeThoughts: true, thinkingLevel: level });
    }
    expect(
      buildGenerateConfig({ thinkingLevel: "minimal" } as ProviderOptions, model()).thinkingConfig,
    ).toEqual({ includeThoughts: true });
  });
});

describe("ModelProfiles — gemini-4-neon", () => {
  it("rejects sampling, offers low|medium|high|xhigh with no 'none', and only the implicit cache", () => {
    const profile = getModelProfile("gemini-4-neon", "google");
    expect(profile.rejectedParameters).toEqual(["temperature", "topP", "topK"]);
    expect(profile.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(profile.caching).toEqual(["implicit"]);
    expect(profile.cacheLifeSeconds).toBe(600);
  });
});

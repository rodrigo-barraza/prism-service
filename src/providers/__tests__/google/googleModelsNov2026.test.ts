/**
 * Google models added 2026-11-23, each probed live that day and priced from
 * Google's pricing page: Gemini 4 Carbon, Gemini 4 Hydrogen, Nano Banana 2.1,
 * Gemini 3.8 Flash TTS and Gemini 3.8 Flash-Lite TTS.
 */
import { describe, it, expect } from "vitest";

import { buildGenerateConfig } from "#src/providers/google";
import { getDefaultModels, getModelByName, MODALITY_TYPES, PROVIDERS } from "#src/config";
import type { ProviderOptions } from "#src/types/ProviderTypes";

type CatalogModel = Record<string, unknown> & { name: string };
const model = (name: string) => getModelByName(name) as unknown as CatalogModel;

describe("gemini-4-carbon", () => {
  it("1,048,576 in / 32,768 out, low|medium|high, thinking can be switched off, Dec 1 list price", () => {
    const carbon = model("gemini-4-carbon");
    expect(carbon).toMatchObject({
      label: "Gemini 4 Carbon",
      provider: PROVIDERS.GOOGLE,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 32_768,
      thinkingLevels: ["low", "medium", "high"],
      canDisableThinking: true,
      lockedSampling: true,
      implicitCacheOnly: true,
    });
    expect(carbon.pricing).toMatchObject({ inputPerMillion: 2.0, outputPerMillion: 10.0 });
    expect((carbon.pricingSchedule as { pricing: unknown }[])[0].pricing).toMatchObject({
      inputPerMillion: 4.0,
      outputPerMillion: 20.0,
    });
  });

  it("switches thinking off with thinkingBudget 0 and sends no sampling", () => {
    const config = buildGenerateConfig(
      { thinkingEnabled: false, temperature: 0.2 } as ProviderOptions,
      model("gemini-4-carbon") as never,
    );
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(config.temperature).toBeUndefined();
  });
});

describe("gemini-4-hydrogen", () => {
  it("1,048,576 in / 65,536 out, low|medium|high|xhigh, thinking cannot be switched off", () => {
    expect(model("gemini-4-hydrogen")).toMatchObject({
      label: "Gemini 4 Hydrogen",
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536,
      thinkingLevels: ["low", "medium", "high", "xhigh"],
      canDisableThinking: false,
      lockedSampling: true,
      pricing: { inputPerMillion: 1.5, cachedInputPerMillion: 0.075, outputPerMillion: 7.5 },
    });
  });

  it("answers 'thinking off' with its lowest level", () => {
    expect(
      buildGenerateConfig({ thinkingEnabled: false } as ProviderOptions, model("gemini-4-hydrogen") as never)
        .thinkingConfig,
    ).toEqual({ thinkingLevel: "low" });
  });
});

describe("nano banana 2.1 and the 3.8 TTS models", () => {
  it("Nano Banana 2.1 makes images, minimal|medium|high (LOW is a 400)", () => {
    const nb = model("gemini-nano-banana-2.1");
    expect(nb.outputTypes).toContain(MODALITY_TYPES.IMAGE);
    expect(nb.thinkingLevels).toEqual(["minimal", "medium", "high"]);
    expect(nb.pricing).toMatchObject({ imageOutputPerMillion: 30.0 });
  });

  it("both 3.8 TTS models speak, priced to double on 2027-01-01", () => {
    for (const [name, out] of [["gemini-3.8-flash-tts", 9.0], ["gemini-3.8-flash-lite-tts", 6.0]] as const) {
      const tts = model(name);
      expect(tts.outputTypes).toEqual([MODALITY_TYPES.AUDIO]);
      expect(tts.pricing).toEqual({ inputPerMillion: 0.5, audioOutputPerMillion: out });
      expect((tts.pricingSchedule as { pricing: unknown }[])[0].pricing).toEqual({
        inputPerMillion: 1.0,
        audioOutputPerMillion: out * 2,
      });
    }
  });

  it("none of them becomes a default", () => {
    const defaults = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[PROVIDERS.GOOGLE];
    expect(defaults).toBe("gemini-4-argon");
  });
});

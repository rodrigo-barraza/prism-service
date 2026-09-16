/**
 * gpt-6-astra catalog entry (released 2026-09-03) and the typed native
 * capability helper the harness branches on.
 */
import { describe, it, expect } from "vitest";
import {
  MODELS,
  getModelByName,
  getModelNativeCapabilities,
  getModelOptions,
  MODALITY_TYPES,
} from "#src/config";

describe("gpt-6-astra catalog entry", () => {
  const astra = MODELS.GPT_6_ASTRA;

  it("carries the published numbers", () => {
    expect(astra.name).toBe("gpt-6-astra");
    expect(getModelByName("gpt-6-astra")).toBe(astra);
    expect(astra.maxInputTokens).toBe(922_000);
    expect(astra.maxOutputTokens).toBe(128_000);
    expect(astra.pricing).toMatchObject({
      inputPerMillion: 10.0,
      cachedInputPerMillion: 1.0,
      cacheWriteInputPerMillion: 12.5,
      outputPerMillion: 50.0,
    });
    expect(astra.inputTypes).toEqual([MODALITY_TYPES.TEXT, MODALITY_TYPES.IMAGE]);
    expect(astra.outputTypes).toEqual([MODALITY_TYPES.TEXT]);
  });

  it("declares low…max only — never none, and thinking cannot be disabled", () => {
    expect(astra.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect("canDisableThinking" in astra).toBe(false);
    expect(astra.responsesAPI).toBe(true);
    expect(astra.verbosity).toBe(true);
    expect(astra.reasoningSummary).toBe(true);
  });

  it("is listed as an OpenAI text model", () => {
    const openaiOptions = getModelOptions(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).openai;
    const entry = openaiOptions.find((option) => option.name === "gpt-6-astra");
    expect(entry).toBeDefined();
    expect(entry!.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(entry!.responsesAPI).toBe(true);
    expect(entry!.lockedSampling).toBe(true);
  });
});

describe("getModelNativeCapabilities", () => {
  it("reports every native feature for gpt-6-astra", () => {
    expect(getModelNativeCapabilities("gpt-6-astra")).toEqual({
      asyncTools: true,
      steering: true,
      programmaticToolCalling: true,
      configurationUpdate: true,
    });
  });

  it("reports programmatic tool calling only for the GPT-5.6 family", () => {
    for (const name of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(getModelNativeCapabilities(name)).toEqual({
        asyncTools: false,
        steering: false,
        programmaticToolCalling: true,
        configurationUpdate: false,
      });
    }
  });

  it("is all-false for models without flags and for unknown names", () => {
    const allFalse = {
      asyncTools: false,
      steering: false,
      programmaticToolCalling: false,
      configurationUpdate: false,
    };
    expect(getModelNativeCapabilities("gpt-5.2-pro")).toEqual(allFalse);
    expect(getModelNativeCapabilities("not-a-catalog-model")).toEqual(allFalse);
  });
});

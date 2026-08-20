/**
 * Unit tests for the Google `buildGenerateConfig` thinking config.
 *
 * How you turn Gemini's thinking OFF is per-model, and getting it wrong is a
 * hard 400 INVALID_ARGUMENT rather than a degraded answer — that is the bug
 * these tests exist to prevent recurring. The truth table below was verified
 * against the live generateContent API on 2026-08-20:
 *
 *   model                        thinkingBudget: 0   thinkingLevel: "minimal"
 *   gemini-3.5-flash             200                 200
 *   gemini-3.6-flash             400                 200
 *   gemini-3.7-flash             200                 400
 *   gemini-3.1-flash-lite        200                 200
 *   gemini-3.5-flash-lite        400                 200
 *   gemini-3.1-pro-preview       400                 400   (cannot disable)
 *
 * The catalog's `thinkingLevels` is the switch the provider reads, so the
 * final test asserts every Google thinking model in the catalog produces a
 * disable-config that is legal for it.
 */
import { describe, it, expect } from "vitest";

import { buildGenerateConfig } from "#src/providers/google";
import { MODELS } from "#src/config";
import { PROVIDERS } from "#src/constants";
import type { ProviderOptions } from "#src/types/ProviderTypes";

interface CatalogModel {
  name: string;
  provider?: string;
  thinking?: boolean;
  thinkingLevels?: string[];
  canDisableThinking?: boolean;
}

const catalog = Object.values(MODELS) as unknown as CatalogModel[];

function model(name: string): CatalogModel {
  const found = catalog.find((entry) => entry.name === name);
  if (!found) throw new Error(`model ${name} is not in the catalog`);
  return found;
}

const options = (extra: Partial<ProviderOptions> = {}) =>
  ({ ...extra }) as ProviderOptions;

// ── Disabling thinking ───────────────────────────────────────
describe("buildGenerateConfig — thinkingEnabled: false", () => {
  it('uses thinkingLevel "minimal" on a model that declares it (3.6 Flash)', () => {
    // The regression: 3.6 Flash rejects thinkingBudget: 0 outright, which is
    // the 400 users hit whenever the thinking toggle was switched off.
    const config = buildGenerateConfig(
      options({ thinkingEnabled: false }),
      model("gemini-3.6-flash"),
    );
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(config.thinkingConfig).not.toHaveProperty("thinkingBudget");
  });

  it("uses thinkingBudget: 0 on a model with no minimal level (3.7 Flash)", () => {
    const config = buildGenerateConfig(
      options({ thinkingEnabled: false }),
      model("gemini-3.7-flash"),
    );
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("falls back to the lowest level when thinking cannot be disabled (3.1 Pro)", () => {
    const config = buildGenerateConfig(
      options({ thinkingEnabled: false }),
      model("gemini-3.1-pro-preview"),
    );
    // Neither budget 0 nor "minimal" is legal here, so the closest honest
    // answer is the lowest declared level, with thoughts left unsurfaced.
    expect(config.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(config.thinkingConfig).not.toHaveProperty("includeThoughts");
  });

  it("never sets includeThoughts when thinking is off", () => {
    for (const name of [
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.1-pro-preview",
    ]) {
      const config = buildGenerateConfig(
        options({ thinkingEnabled: false }),
        model(name),
      );
      expect(config.thinkingConfig).not.toHaveProperty("includeThoughts");
    }
  });

  it("emits no thinkingConfig at all for a non-thinking model", () => {
    const config = buildGenerateConfig(options({ thinkingEnabled: false }), {
      name: "espeak-ng",
    });
    expect(config.thinkingConfig).toBeUndefined();
  });
});

// ── Enabling thinking ────────────────────────────────────────
describe("buildGenerateConfig — thinkingEnabled: true", () => {
  it("forwards a level the model declares", () => {
    const config = buildGenerateConfig(
      options({ thinkingLevel: "high" }),
      model("gemini-3.7-flash"),
    );
    expect(config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "high",
    });
  });

  it("drops a level the model does NOT declare", () => {
    // "minimal" is a legal global setting (3.6 Flash has it) but 3.7 Flash
    // 400s on it, so it must not follow the user across models.
    const config = buildGenerateConfig(
      options({ thinkingLevel: "minimal" }),
      model("gemini-3.7-flash"),
    );
    expect(config.thinkingConfig).toEqual({ includeThoughts: true });
  });

  it("drops a level from another provider's vocabulary", () => {
    // "xhigh" is valid on OpenAI/Anthropic entries, never on Gemini.
    const config = buildGenerateConfig(
      options({ thinkingLevel: "xhigh" }),
      model("gemini-3.6-flash"),
    );
    expect(config.thinkingConfig).toEqual({ includeThoughts: true });
  });

  it("prefers an explicit budget over a level", () => {
    const config = buildGenerateConfig(
      options({ thinkingBudget: 2048, thinkingLevel: "high" }),
      model("gemini-3.6-flash"),
    );
    expect(config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    });
  });
});

// ── Catalog contract ─────────────────────────────────────────
describe("Google catalog thinking metadata", () => {
  const googleThinkers = catalog.filter(
    (entry) => entry.provider === PROVIDERS.GOOGLE && entry.thinking === true,
  );

  it("covers every Google thinking model", () => {
    expect(googleThinkers.length).toBeGreaterThan(0);
  });

  it.each(googleThinkers.map((entry) => [entry.name, entry] as const))(
    "%s produces a disable-config its own thinkingLevels allow",
    (_name, entry) => {
      const config = buildGenerateConfig(
        options({ thinkingEnabled: false }),
        entry,
      );
      const thinking = config.thinkingConfig as {
        thinkingLevel?: string;
        thinkingBudget?: number;
      };
      if (thinking.thinkingLevel !== undefined) {
        // A level was chosen — it must be one the model actually declares,
        // or the request 400s.
        expect(entry.thinkingLevels ?? []).toContain(thinking.thinkingLevel);
      } else {
        // Budget 0 was chosen — only legal for models that can disable
        // thinking and don't route through the "minimal" path.
        expect(thinking.thinkingBudget).toBe(0);
        expect(entry.canDisableThinking).not.toBe(false);
        expect(entry.thinkingLevels ?? []).not.toContain("minimal");
      }
    },
  );

  it("gives every model that cannot disable thinking at least one level", () => {
    for (const entry of googleThinkers) {
      if (entry.canDisableThinking === false) {
        expect(entry.thinkingLevels?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

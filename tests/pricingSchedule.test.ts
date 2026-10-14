/**
 * Dated prices (pricingSchedule): a model whose rate card changes on a known
 * date carries the steps, and its `pricing` reads as the card in effect when
 * it is read, through every accessor, with no deploy on the day.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getModelByName,
  getModelOptions,
  getPricing,
  MODALITY_TYPES,
  MODELS,
  PROVIDERS,
  type PricingStep,
} from "#src/config";

type ScheduledModel = { name: string; pricingSchedule: PricingStep[] };

const scheduled = (Object.values(MODELS) as unknown as Array<Record<string, unknown>>).filter((model) =>
  Array.isArray(model.pricingSchedule),
) as unknown as ScheduledModel[];

/** The catalog's `pricing` for `name` as read right now. */
const catalogPricing = (name: string) =>
  (getModelByName(name) as unknown as { pricing?: Record<string, number> }).pricing;

/** Freeze the clock at `instant` (milliseconds since the epoch). */
function clockAt(instant: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pricingSchedule — the catalog's data", () => {
  it("is carried by Gemini 4 Argon and the 3.6 / 3.7 / 3.8 Flash models", () => {
    expect(scheduled.map((model) => model.name).sort()).toEqual([
      "gemini-3.6-flash",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
      "gemini-4-argon",
    ]);
  });

  it.each(scheduled.map((model) => [model.name, model] as const))(
    "%s: every step parses, the steps run in date order, and each is a full rate card",
    (name, model) => {
      const starts = model.pricingSchedule.map((step) => Date.parse(step.from));
      for (const start of starts) expect(Number.isFinite(start)).toBe(true);
      expect(starts).toEqual([...starts].sort((left, right) => left - right));

      clockAt(starts[0] - 1);
      const base = catalogPricing(name);
      expect(base).toBeDefined();
      for (const step of model.pricingSchedule) {
        expect(Object.keys(step.pricing).sort()).toEqual(Object.keys(base!).sort());
      }
    },
  );
});

describe("pricingSchedule — every accessor reads the card in effect", () => {
  it.each(scheduled.map((model) => [model.name, model] as const))(
    "%s: the base card until the first step, that step's card from its instant on",
    (name, model) => {
      const [firstStep] = model.pricingSchedule;
      const start = Date.parse(firstStep.from);
      clockAt(start - 1);
      const base = { ...catalogPricing(name)! };
      expect(base).not.toEqual(firstStep.pricing);

      for (const [instant, expected] of [
        [start - 1, base],
        [start, firstStep.pricing],
      ] as const) {
        vi.setSystemTime(instant);
        expect(catalogPricing(name)).toEqual(expected);
        expect(getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[name]).toEqual(expected);
        // getModelOptions is what /config sends the client.
        const option = getModelOptions(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[PROVIDERS.GOOGLE]?.find(
          (entry) => entry.name === name,
        );
        expect(option?.pricing).toEqual(expected);
      }
    },
  );
});

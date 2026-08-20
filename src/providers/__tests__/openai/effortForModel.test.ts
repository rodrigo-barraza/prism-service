/**
 * Unit tests for `effortForModel`.
 *
 * Reasoning effort is a single global user setting, but each model publishes
 * its own vocabulary. Forwarding a level the target model does not declare is
 * a hard 400 from OpenAI, so the provider drops it. Verified live 2026-08-20:
 * gpt-5.2-pro rejects "low" and "minimal" by name and accepts "xhigh", while
 * gpt-5.2 accepts "low" — the two are one version apart.
 */
import { describe, it, expect } from "vitest";

import { effortForModel } from "#src/providers/openai";

describe("effortForModel", () => {
  it("keeps a level the model declares", () => {
    expect(effortForModel("gpt-5.2-pro", "high")).toBe("high");
    expect(effortForModel("gpt-5.2-pro", "xhigh")).toBe("xhigh");
  });

  it("drops a level the model rejects", () => {
    // The live API answers "Unsupported value: 'low' is not supported with
    // the 'gpt-5.2-pro' model" — a 400, not a downgrade.
    expect(effortForModel("gpt-5.2-pro", "low")).toBeUndefined();
    expect(effortForModel("gpt-5.2-pro", "minimal")).toBeUndefined();
    expect(effortForModel("gpt-5.2-pro", "max")).toBeUndefined();
  });

  it("does not confuse sibling models with different vocabularies", () => {
    // Same setting, one version apart: legal on 5.2, illegal on 5.2 Pro.
    expect(effortForModel("gpt-5.2", "low")).toBe("low");
    expect(effortForModel("gpt-5.2-pro", "low")).toBeUndefined();
  });

  it("passes through when the model declares no vocabulary", () => {
    // o1/o3 and the OpenAI-compatible passthroughs never listed levels, so
    // the guard must not change their behaviour.
    expect(effortForModel("o3-mini", "medium")).toBe("medium");
    expect(effortForModel("not-a-catalog-model", "medium")).toBe("medium");
  });

  it("returns undefined when no effort was requested", () => {
    expect(effortForModel("gpt-5.2-pro", undefined)).toBeUndefined();
    expect(effortForModel("gpt-5.2-pro", "")).toBeUndefined();
  });
});

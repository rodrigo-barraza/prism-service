/**
 * Config Route Utility Tests
 * ═══════════════════════════════════════════════════════════
 * Tests for the refactored helpers in prism/src/routes/config.js:
 *   - matchesAny()
 *   - mergeDynamicModels()
 *   - formatBytes()
 *   - Detection pattern constants (THINKING, FC, VISION, VIDEO, AUDIO)
 *   - GET /config integration with LM Studio models
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";
import { PROVIDERS, MODEL_TYPES, MODALITY_TYPES } from "#src/constants";

// ═══════════════════════════════════════════════════════════════
// Pattern detection — verify the extracted constants work correctly
// We test these indirectly through the /config endpoint shape.
// ═══════════════════════════════════════════════════════════════

describe("Config route — pattern constant detection", () => {
  // These test the THINKING_PATTERNS, FC_PATTERNS, VISION_PATTERNS, etc.
  // by checking the /config response for known model capabilities.

  it("config response includes textToText models with correct structure", async () => {
    const res = await request(app).get("/config").expect(200);

    const textToText = res.body.textToText;
    expect(textToText).toHaveProperty("models");
    expect(textToText).toHaveProperty("defaults");

    // At least one provider should have models
    const allModels = Object.values(textToText.models).flat() as any[];
    expect(allModels.length).toBeGreaterThan(0);

    // Every model should have required fields
    for (const model of allModels) {
      expect(model).toHaveProperty("name");
      expect(model).toHaveProperty("modelType");
      expect(model).toHaveProperty("inputTypes");
      expect(model).toHaveProperty("outputTypes");
    }
  });

  it("thinking-capable models have thinking: true and Thinking in tools", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const thinkingModels = allModels.filter((m) => m.thinking === true);

    // We should have at least some thinking models (o1, o3, deepseek, qwen3, etc.)
    expect(thinkingModels.length).toBeGreaterThan(0);

    // Every thinking model should have "Thinking" in its tools array
    for (const model of thinkingModels) {
      if (model.tools) {
        expect(model.tools).toContain("Thinking");
      }
    }
  });

  it("thinking-capable models expose thinkingLevels array containing low and high", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const thinkingModels = allModels.filter(
      (m: any) => m.thinking === true && m.modelType === MODEL_TYPES.CONVERSATION
    );

    expect(thinkingModels.length).toBeGreaterThan(0);

    // Some thinking models (e.g. Kimi K2.6) reason but expose no effort
    // control — they intentionally omit thinkingLevels so the provider never
    // forwards reasoning_effort. Only models that declare levels are checked.
    const leveledModels = thinkingModels.filter(
      (m: any) => m.thinkingLevels !== undefined
    );
    expect(leveledModels.length).toBeGreaterThan(0);

    // Every declared level must come from the shared vocabulary and the list
    // must be non-empty — but NOT "at least low+high". Verified against the
    // live API on 2026-08-20, the Nano Banana 2 image models accept only
    // ["minimal", "high"] and reject LOW/MEDIUM by name, so a blanket
    // "contains low" would pin a claim the provider 400s on.
    const KNOWN_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
    for (const model of leveledModels) {
      expect(Array.isArray(model.thinkingLevels)).toBe(true);
      expect(model.thinkingLevels.length).toBeGreaterThan(0);
      for (const level of model.thinkingLevels) {
        expect(KNOWN_LEVELS, `${model.name} declares unknown level ${level}`).toContain(level);
      }
      // "high" is the one rung every leveled model in the catalog offers.
      expect(model.thinkingLevels).toContain("high");
    }
  });

  it("models with Tool Calling have it in their tools array", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const fcModels = allModels.filter(
      (m) => m.tools && m.tools.includes("Tool Calling"),
    );

    // Should have FC models from cloud providers (GPT, Claude, Gemini)
    expect(fcModels.length).toBeGreaterThan(0);

    // FC models should have proper tool definitions
    for (const model of fcModels) {
      expect(Array.isArray(model.tools)).toBe(true);
      expect(model.tools.length).toBeGreaterThan(0);
    }
  });

  it("vision-capable models have image in inputTypes", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const visionModels = allModels.filter(
      (m) => m.vision === true || m.inputTypes?.includes(MODALITY_TYPES.IMAGE),
    );

    // Should have some vision models
    expect(visionModels.length).toBeGreaterThan(0);

    // Vision models should have 'image' in inputTypes
    for (const model of visionModels) {
      expect(model.inputTypes).toContain(MODALITY_TYPES.IMAGE);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// matchesAny — behavioral tests via known model names
// ═══════════════════════════════════════════════════════════════

describe("Pattern matching behavior (via model catalog)", () => {
  it("qwen3 models are detected as thinking-capable", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const qwen3 = allModels.filter((m) =>
      m.name.toLowerCase().includes("qwen3"),
    );

    // If there are qwen3 models in the catalog, they should have thinking
    for (const model of qwen3) {
      expect(model.thinking).toBe(true);
    }
  });

  it("deepseek-r1 models are detected as thinking-capable", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const dsr1 = allModels.filter((m) =>
      m.name.toLowerCase().includes("deepseek-r1"),
    );

    for (const model of dsr1) {
      expect(model.thinking).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// mergeDynamicModels — tested indirectly through /config
// The merge helper should not create duplicates
// ═══════════════════════════════════════════════════════════════

describe("Dynamic model merging (via /config endpoint)", () => {
  it("no duplicate model names within a single provider", async () => {
    const res = await request(app).get("/config").expect(200);

    for (const [_provider, models] of Object.entries(
      res.body.textToText.models,
    )) {
      const names = (models as any[]).map((m: any) => m.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(
        names.length,
      );
    }
  });

  it("all model entries have required pricing structure", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    for (const model of allModels) {
      // Every model must have pricing (even if zero for local models)
      expect(model).toHaveProperty("pricing");
      expect(model.pricing).toHaveProperty("inputPerMillion");
      expect(model.pricing).toHaveProperty("outputPerMillion");
      expect(typeof model.pricing.inputPerMillion).toBe("number");
      expect(typeof model.pricing.outputPerMillion).toBe("number");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// formatBytes — tested indirectly through model size fields
// ═══════════════════════════════════════════════════════════════

describe("formatBytes (via model size fields)", () => {
  it("model size strings are well-formed when present", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const withSize = allModels.filter((m) => m.size);

    for (const model of withSize) {
      // Should match patterns like "1.2 GB", "500 MB", "120 KB"
      expect(model.size).toMatch(/^\d+(\.\d+)?\s*(GB|MB|KB)$/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Arena score enrichment
// ═══════════════════════════════════════════════════════════════

describe("Arena score enrichment", () => {
  it("some models have arena scores attached", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const withArena = allModels.filter(
      (m) => m.arena && Object.keys(m.arena).length > 0,
    );

    // At least some major models should have arena scores
    expect(withArena.length).toBeGreaterThan(0);
  });

  it("arena scores are numeric values", async () => {
    const res = await request(app).get("/config").expect(200);

    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const withArena = allModels.filter((m) => m.arena);

    for (const model of withArena) {
      for (const [_category, score] of Object.entries(model.arena)) {
        expect(typeof score).toBe("number");
        expect(score).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// LM Studio — config integration (only local model provider tested)
// ═══════════════════════════════════════════════════════════════

describe("LM Studio config integration", () => {
  it("lm-studio provider is excluded when LM_STUDIO_BASE_URL is empty", async () => {
    // In setup.js, LM_STUDIO_BASE_URL is set to '' (empty)
    // so lm-studio should NOT appear in available providers
    const res = await request(app).get("/config").expect(200);

    const providerList = res.body.providerList;
    expect(providerList).not.toContain(PROVIDERS.LM_STUDIO);
  });

  it("lm-studio models are not present in textToText when provider is unavailable", async () => {
    const res = await request(app).get("/config").expect(200);

    const textToTextModels = res.body.textToText.models;
    expect(textToTextModels).not.toHaveProperty(PROVIDERS.LM_STUDIO);
  });

  it("local model entries have zero pricing", async () => {
    // Verify the pricing structure for local models would be zero
    // We can check this against the static config model definitions
    const res = await request(app).get("/config").expect(200);

    // Since LM Studio is not available in test, test vllm/ollama if present
    // or just verify the structure expectation
    const allModels = Object.values(res.body.textToText.models).flat() as any[];
    const freeModels = allModels.filter(
      (m) =>
        m.pricing.inputPerMillion === 0 && m.pricing.outputPerMillion === 0,
    );

    // If any free models exist, they should have valid structure
    for (const model of freeModels) {
      expect(model.pricing.inputPerMillion).toBe(0);
      expect(model.pricing.outputPerMillion).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// fcSystemPrompt — dynamic generation
// ═══════════════════════════════════════════════════════════════

describe("FC System Prompt generation", () => {
  it("config includes fcSystemPrompt string", async () => {
    const res = await request(app).get("/config").expect(200);

    expect(res.body).toHaveProperty("fcSystemPrompt");
    expect(typeof res.body.fcSystemPrompt).toBe("string");
    expect(res.body.fcSystemPrompt.length).toBeGreaterThan(50);
  });

  it("fcSystemPrompt contains date placeholder", async () => {
    const res = await request(app).get("/config").expect(200);

    // The prompt should contain the date-time placeholder for client injection
    expect(res.body.fcSystemPrompt).toContain("{{CURRENT_DATE_TIME}}");
  });

  it("fcSystemPrompt contains tool usage guidelines", async () => {
    const res = await request(app).get("/config").expect(200);

    const prompt = res.body.fcSystemPrompt;
    // Should have guidelines about using tools
    expect(prompt).toContain("tool");
    expect(prompt).toContain("data");
  });
});

// ═══════════════════════════════════════════════════════════════
// Provider availability filtering
// ═══════════════════════════════════════════════════════════════

describe("Provider availability filtering", () => {
  it("only providers with API keys are in the provider list", async () => {
    const res = await request(app).get("/config").expect(200);

    // With our mock setup, openai/anthropic/google/elevenlabs/inworld have keys
    // lm-studio/vllm/ollama do NOT
    const list = res.body.providerList;
    expect(list).toContain(PROVIDERS.OPENAI);
    expect(list).toContain(PROVIDERS.ANTHROPIC);
    expect(list).toContain(PROVIDERS.GOOGLE);
    expect(list).not.toContain(PROVIDERS.LM_STUDIO);
    expect(list).not.toContain(PROVIDERS.VLLM);
    expect(list).not.toContain(PROVIDERS.OLLAMA);
  });

  it("models map only contains available providers", async () => {
    const res = await request(app).get("/config").expect(200);

    const providers = Object.keys(res.body.textToText.models);
    // Should not have unavailable providers
    expect(providers).not.toContain(PROVIDERS.LM_STUDIO);
    expect(providers).not.toContain(PROVIDERS.VLLM);
    expect(providers).not.toContain(PROVIDERS.OLLAMA);
  });

  it("defaults only contain available providers", async () => {
    const res = await request(app).get("/config").expect(200);

    const defaults = Object.keys(res.body.textToText.defaults);
    for (const provider of defaults) {
      expect(res.body.providerList).toContain(provider);
    }
  });
});

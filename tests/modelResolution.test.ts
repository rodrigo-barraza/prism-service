/**
 * ModelResolution — tests for GGUF quantization-aware model matching.
 *
 * parseModelQuant and findBestQuantFallback determine which model variant
 * runs on which LM Studio / vLLM / llama.cpp instance. Incorrect resolution
 * silently uses the wrong quantization, affecting output quality.
 */
import { describe, it, expect } from "vitest";
import {
  parseModelQuant,
  findBestQuantFallback,
} from "../src/utils/ModelResolution.ts";

// ═══════════════════════════════════════════════════════════════
describe("parseModelQuant", () => {
  it("should parse @quant syntax (e.g. qwen3-32b@q4_k_m)", () => {
    const result = parseModelQuant("qwen3-32b@q4_k_m");

    expect(result.base).toBe("qwen3-32b");
    expect(result.quant).toBe("Q4_K_M");
  });

  it("should uppercase the quant from @quant syntax", () => {
    const result = parseModelQuant("llama-3.3-70b@iq4_xs");

    expect(result.base).toBe("llama-3.3-70b");
    expect(result.quant).toBe("IQ4_XS");
  });

  it("should parse GGUF path-style with .gguf extension", () => {
    const result = parseModelQuant(
      "lmstudio-community/qwen3-32b-GGUF/qwen3-32b-Q8_0.gguf",
    );

    expect(result.base).toBe(
      "lmstudio-community/qwen3-32b-GGUF/qwen3-32b",
    );
    expect(result.quant).toBe("Q8_0");
  });

  it("should parse GGUF path-style without .gguf extension", () => {
    const result = parseModelQuant(
      "lmstudio-community/qwen3-32b-GGUF/qwen3-32b-Q4_K_M",
    );

    expect(result.base).toBe(
      "lmstudio-community/qwen3-32b-GGUF/qwen3-32b",
    );
    expect(result.quant).toBe("Q4_K_M");
  });

  it("should handle F16 quantization suffix", () => {
    const result = parseModelQuant("my-model-F16.gguf");

    expect(result.base).toBe("my-model");
    expect(result.quant).toBe("F16");
  });

  it("should NOT parse BF16 as a quant suffix (regex limitation — only B16/F16/B32/F32 matched)", () => {
    // The GGUF_QUANT_SUFFIX_RE uses [BF](?:16|32) which matches single-char
    // prefixes (B16, F16, B32, F32) but not two-char prefix BF16.
    // This documents the actual behavior — BF16 models are treated as having
    // no quantization suffix and matched by base name instead.
    const result = parseModelQuant("my-model-BF16");

    expect(result.base).toBe("my-model-BF16");
    expect(result.quant).toBeNull();
  });

  it("should return null quant for models with no quantization suffix", () => {
    const result = parseModelQuant("gpt-4o");

    expect(result.base).toBe("gpt-4o");
    expect(result.quant).toBeNull();
  });

  it("should return null quant for API-style model names", () => {
    const result = parseModelQuant("claude-4-sonnet-20260514");

    expect(result.base).toBe("claude-4-sonnet-20260514");
    expect(result.quant).toBeNull();
  });

  it("should return null quant for gemini models", () => {
    const result = parseModelQuant("gemini-3.5-flash");

    expect(result.base).toBe("gemini-3.5-flash");
    expect(result.quant).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("findBestQuantFallback", () => {
  it("should select the largest-size variant as the best fallback", () => {
    const availableModels = [
      { key: "qwen3-32b-Q4_K_M", size_bytes: 20_000_000_000 },
      { key: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 },
      { key: "qwen3-32b-IQ4_XS", size_bytes: 17_000_000_000 },
    ];

    const result = findBestQuantFallback("qwen3-32b@q5_k_m", availableModels);

    expect(result).toBe("qwen3-32b-Q8_0");
  });

  it("should return null when no variant of the base model is found", () => {
    const availableModels = [
      { key: "llama-3.3-70b-Q4_K_M", size_bytes: 40_000_000_000 },
    ];

    const result = findBestQuantFallback("qwen3-32b@q4_k_m", availableModels);

    expect(result).toBeNull();
  });

  it("should skip the exact same key", () => {
    const availableModels = [
      { key: "qwen3-32b-Q4_K_M", size_bytes: 20_000_000_000 },
    ];

    // Target is exactly the same key — no fallback should be returned
    const result = findBestQuantFallback("qwen3-32b-Q4_K_M", availableModels);

    expect(result).toBeNull();
  });

  it("should match across path-style vs flat-style bases", () => {
    const availableModels = [
      {
        key: "lmstudio-community/Qwen3-32B-GGUF/Qwen3-32B-Q8_0.gguf",
        size_bytes: 35_000_000_000,
      },
      {
        key: "lmstudio-community/Qwen3-32B-GGUF/Qwen3-32B-Q4_K_M.gguf",
        size_bytes: 20_000_000_000,
      },
    ];

    // Flat-style target should match the GGUF path-style models by leaf segment
    const result = findBestQuantFallback("Qwen3-32B@IQ4_XS", availableModels);

    expect(result).toBe(
      "lmstudio-community/Qwen3-32B-GGUF/Qwen3-32B-Q8_0.gguf",
    );
  });

  it("should handle models with id instead of key", () => {
    const availableModels = [
      { id: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 },
      { id: "qwen3-32b-Q4_K_M", size_bytes: 20_000_000_000 },
    ];

    const result = findBestQuantFallback("qwen3-32b@iq4_xs", availableModels);

    expect(result).toBe("qwen3-32b-Q8_0");
  });

  it("should return null when available models list is empty", () => {
    const result = findBestQuantFallback("qwen3-32b@q4_k_m", []);

    expect(result).toBeNull();
  });

  it("should skip variants with the same quant as the target", () => {
    const availableModels = [
      { key: "qwen3-32b-Q4_K_M", size_bytes: 20_000_000_000 },
      { key: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 },
    ];

    // Target quant is Q4_K_M — the Q4_K_M variant should be skipped
    const result = findBestQuantFallback("qwen3-32b@q4_k_m", availableModels);

    expect(result).toBe("qwen3-32b-Q8_0");
  });
});

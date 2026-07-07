/**
 * ModelResolution — tests for GGUF quantization-aware model matching.
 *
 * parseModelQuant and findBestQuantFallback determine which model variant
 * runs on which LM Studio / vLLM / llama.cpp instance. Incorrect resolution
 * silently uses the wrong quantization, affecting output quality.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseModelQuant,
  findBestQuantFallback,
  resolveModelForInstances,
} from "#src/utils/ModelResolution";
import type { InstanceEntry } from "#src/types/ProviderTypes";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockGetProvider = vi.fn();

vi.mock("#src/providers/index", () => ({
  getProvider: (...arguments_: unknown[]) => mockGetProvider(...arguments_),
}));

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

// ═══════════════════════════════════════════════════════════════
describe("resolveModelForInstances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createInstance(id: string): InstanceEntry {
    return { id, baseUrl: `http://${id}:1234/v1` } as InstanceEntry;
  }

  it("should return instances that have an exact model match", async () => {
    const instances = [createInstance("lm-1"), createInstance("lm-2")];

    mockGetProvider.mockImplementation((id: string) => ({
      listModels: vi.fn().mockResolvedValue({
        models: id === "lm-1"
          ? [{ key: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 }]
          : [{ key: "llama-70b-Q4_K_M", size_bytes: 40_000_000_000 }],
      }),
    }));

    const result = await resolveModelForInstances("qwen3-32b-Q8_0", instances);

    expect(result.usable).toHaveLength(1);
    expect(result.usable[0].id).toBe("lm-1");
    expect(result.modelOverrides.size).toBe(0);
  });

  it("should use quant fallback when no exact match exists", async () => {
    const instances = [createInstance("lm-1")];

    mockGetProvider.mockReturnValue({
      listModels: vi.fn().mockResolvedValue({
        models: [
          { key: "qwen3-32b-Q4_K_M", size_bytes: 20_000_000_000 },
          { key: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 },
        ],
      }),
    });

    const result = await resolveModelForInstances("qwen3-32b@q5_k_m", instances);

    expect(result.usable).toHaveLength(1);
    expect(result.modelOverrides.get("lm-1")).toBe("qwen3-32b-Q8_0");
  });

  it("should exclude instances with no matching model (exact or fallback)", async () => {
    const instances = [createInstance("lm-1"), createInstance("lm-2")];

    mockGetProvider.mockReturnValue({
      listModels: vi.fn().mockResolvedValue({
        models: [{ key: "llama-70b-Q4_K_M", size_bytes: 40_000_000_000 }],
      }),
    });

    const result = await resolveModelForInstances("qwen3-32b@q4_k_m", instances);

    expect(result.usable).toHaveLength(0);
  });

  it("should handle mixed exact + fallback instances", async () => {
    const instances = [createInstance("lm-exact"), createInstance("lm-fallback")];

    mockGetProvider.mockImplementation((id: string) => ({
      listModels: vi.fn().mockResolvedValue({
        models: id === "lm-exact"
          ? [{ key: "qwen3-32b-Q4_K_M", size_bytes: 20_000_000_000 }]
          : [{ key: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 }],
      }),
    }));

    const result = await resolveModelForInstances("qwen3-32b-Q4_K_M", instances);

    expect(result.usable).toHaveLength(2);
    expect(result.modelOverrides.has("lm-exact")).toBe(false);
    expect(result.modelOverrides.get("lm-fallback")).toBe("qwen3-32b-Q8_0");
  });

  it("should skip instances when provider has no listModels method", async () => {
    const instances = [createInstance("cloud-1")];

    mockGetProvider.mockReturnValue({});

    const result = await resolveModelForInstances("gpt-4o", instances);

    expect(result.usable).toHaveLength(0);
  });

  it("should skip instances that return null provider", async () => {
    const instances = [createInstance("missing-1")];

    mockGetProvider.mockReturnValue(null);

    const result = await resolveModelForInstances("gpt-4o", instances);

    expect(result.usable).toHaveLength(0);
  });

  it("should handle listModels rejections gracefully via Promise.allSettled", async () => {
    const instances = [createInstance("lm-ok"), createInstance("lm-down")];

    mockGetProvider.mockImplementation((id: string) => ({
      listModels: id === "lm-ok"
        ? vi.fn().mockResolvedValue({ models: [{ key: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 }] })
        : vi.fn().mockRejectedValue(new Error("Connection refused")),
    }));

    const result = await resolveModelForInstances("qwen3-32b-Q8_0", instances);

    expect(result.usable).toHaveLength(1);
    expect(result.usable[0].id).toBe("lm-ok");
  });

  it("should handle responses with 'data' key instead of 'models' key", async () => {
    const instances = [createInstance("vllm-1")];

    mockGetProvider.mockReturnValue({
      listModels: vi.fn().mockResolvedValue({
        data: [{ id: "qwen3-32b-Q8_0", size_bytes: 35_000_000_000 }],
      }),
    });

    const result = await resolveModelForInstances("qwen3-32b-Q8_0", instances);

    expect(result.usable).toHaveLength(1);
  });

  it("should handle empty model lists", async () => {
    const instances = [createInstance("lm-empty")];

    mockGetProvider.mockReturnValue({
      listModels: vi.fn().mockResolvedValue({ models: [] }),
    });

    const result = await resolveModelForInstances("qwen3-32b@q4_k_m", instances);

    expect(result.usable).toHaveLength(0);
  });

  it("should exclude instances when getProvider throws (rejected promises)", async () => {
    const instances = [createInstance("lm-1"), createInstance("lm-2")];

    mockGetProvider.mockImplementation(() => {
      throw new Error("Registry corrupted");
    });

    const result = await resolveModelForInstances("qwen3-32b@q4_k_m", instances);

    // Throws inside the async map callback become rejected promises,
    // caught by Promise.allSettled as status='rejected' — skipped in the loop.
    expect(result.usable).toHaveLength(0);
    expect(result.modelOverrides.size).toBe(0);
  });
});


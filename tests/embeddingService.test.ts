import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import EmbeddingService from "../src/services/EmbeddingService.ts";
import SettingsService from "../src/services/SettingsService.ts";
import RequestLogger from "../src/services/RequestLogger.ts";

const mockGenerateEmbedding = vi.fn().mockResolvedValue({
  embedding: [0.1, 0.2, 0.3],
  dimensions: 3,
});

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation((providerName: string) => {
    if (providerName === PROVIDERS.ANTHROPIC) {
      return {}; // Anthropic doesn't support embedding in our test
    }
    return {
      generateEmbedding: mockGenerateEmbedding,
    };
  }),
  providers: {},
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getMemoryModelConfig: vi.fn().mockResolvedValue({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-embedding-2-preview",
    }),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    log: vi.fn(),
  },
}));

describe("EmbeddingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should generate embeddings using defaults from SettingsService", async () => {
    const result = await EmbeddingService.generate("hello world");
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.dimensions).toBe(3);
    expect(result.provider).toBe(PROVIDERS.GOOGLE);
    expect(result.model).toBe("gemini-embedding-2-preview");

    expect(SettingsService.getMemoryModelConfig).toHaveBeenCalledWith("embedding");
    expect(RequestLogger.log).toHaveBeenCalledTimes(1);
    expect(vi.mocked(RequestLogger.log).mock.calls[0][0]).toMatchObject({
      success: true,
      provider: PROVIDERS.GOOGLE,
      model: "gemini-embedding-2-preview"
    });
  });

  it("should respect provider and model overrides in options", async () => {
    const result = await EmbeddingService.generate("hello world", {
      provider: PROVIDERS.OPENAI,
      model: "text-embedding-3-small"
    });

    expect(result.provider).toBe(PROVIDERS.OPENAI);
    expect(result.model).toBe("text-embedding-3-small");
    expect(vi.mocked(RequestLogger.log).mock.calls[0][0]).toMatchObject({
      provider: PROVIDERS.OPENAI,
      model: "text-embedding-3-small"
    });
  });

  it("should throw ProviderError when provider does not support embeddings", async () => {
    await expect(EmbeddingService.generate("hello world", {
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-3-opus"
    })).rejects.toThrow("Provider \"anthropic\" does not support embeddings");

    expect(vi.mocked(RequestLogger.log).mock.calls[0][0]).toMatchObject({
      success: false,
      errorMessage: "Provider \"anthropic\" does not support embeddings"
    });
  });

  it("should return raw array using the embed() convenience wrapper", async () => {
    const result = await EmbeddingService.embed("hello world");
    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it("should detect multimodal content types in log payload", async () => {
    const multimodalContent = [
      { text: "Description of image" },
      { inlineData: { mimeType: "image/png", data: "base64data" } }
    ];

    await EmbeddingService.generate(multimodalContent, {
      provider: PROVIDERS.GOOGLE,
      model: "gemini-embedding-2-preview"
    });

    const loggedItem = vi.mocked(RequestLogger.log).mock.calls[0][0];
    expect(loggedItem.modalities).toMatchObject({
      embeddingOut: true,
      textIn: true,
      imageIn: true
    });
  });
});

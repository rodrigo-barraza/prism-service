import { describe, it, expect, vi, beforeEach } from "vitest";
import { getProvider } from "../src/providers/index.ts";

// Mock logger to avoid spamming the console
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockInstances = [
  { id: "lm-studio-1", type: "lm-studio", instanceNumber: 1, concurrency: 2 },
  { id: "ollama-1", type: "ollama", instanceNumber: 1, concurrency: 4 },
];

vi.mock("../src/providers/instance-registry.ts", () => ({
  listInstances: vi.fn().mockImplementation(() => mockInstances),
  getInstancesByType: vi.fn().mockImplementation((type) =>
    mockInstances.filter((instance) => instance.type === type)
  ),
  isInstance: vi.fn().mockImplementation((id) =>
    mockInstances.some((instance) => instance.id === id)
  ),
  getInstance: vi.fn().mockImplementation((id) =>
    mockInstances.find((instance) => instance.id === id)
  ),
  getInstanceType: vi.fn().mockImplementation((id) => {
    const found = mockInstances.find((instance) => instance.id === id);
    return found ? found.type : null;
  }),
  listInstanceTypes: vi.fn().mockReturnValue(["lm-studio", "ollama"]),
}));

const mockProvider = {
  listModels: vi.fn().mockResolvedValue({
    models: [
      { key: "google/gemma-4-12b-qat", loaded: true },
      { id: "openai/gpt-4o", loaded: false },
    ],
  }),
  loadModel: vi.fn().mockResolvedValue({ success: true }),
  unloadModel: vi.fn().mockResolvedValue({ success: true }),
  ensureModelLoaded: vi.fn().mockResolvedValue({ success: true }),
  generateText: vi.fn().mockResolvedValue("generated text"),
  generateTextStream: vi.fn().mockImplementation(async function* () {
    yield "stream chunk";
  }),
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
  captionImage: vi.fn().mockResolvedValue("image caption"),
  checkHealth: vi.fn().mockResolvedValue({ ok: true, status: "ok" }),
};

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockImplementation(() => mockProvider),
}));

vi.mock("../src/services/local-provider/vramEstimation.ts", () => ({
  estimateVRAM: vi.fn().mockReturnValue({ vramBytes: 12345 }),
  estimateVRAMForModel: vi.fn().mockResolvedValue({ vramBytes: 67890 }),
}));

vi.mock("../src/services/local-provider/hfMetadata.ts", () => ({
  enrichWithHuggingFace: vi.fn().mockImplementation((entry) => ({
    ...entry,
    huggingFaceEnriched: true,
  })),
}));

vi.mock("@rodrigo-barraza/utilities-library", () => ({
  withTimeoutFallback: vi.fn().mockImplementation((promise) => promise),
}));

import LocalProviderGateway from "../src/services/local-provider/index.ts";

describe("LocalProviderGateway Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProvider).mockImplementation(() => mockProvider as any);
  });

  describe("Provider Classification", () => {
    it("should correctly identify local providers", () => {
      expect(LocalProviderGateway.isLocal("lm-studio")).toBe(true);
      expect(LocalProviderGateway.isLocal("lm-studio-1")).toBe(true);
      expect(LocalProviderGateway.isLocal("openai")).toBe(false);
      expect(LocalProviderGateway.isLocal("")).toBe(false);
      expect(LocalProviderGateway.isLocal(null)).toBe(false);
    });

    it("should correctly identify native MCP providers", () => {
      expect(LocalProviderGateway.isNativeMCP("lm-studio")).toBe(true);
      expect(LocalProviderGateway.isNativeMCP("ollama")).toBe(true);
      expect(LocalProviderGateway.isNativeMCP("openai")).toBe(false);
      expect(LocalProviderGateway.isNativeMCP("")).toBe(false);
      expect(LocalProviderGateway.isNativeMCP(null)).toBe(false);
    });

    it("should correctly determine defaultsThinkingEnabled", () => {
      expect(LocalProviderGateway.defaultsThinkingEnabled("lm-studio")).toBe(true);
      expect(LocalProviderGateway.defaultsThinkingEnabled("openai")).toBe(false);
      expect(LocalProviderGateway.defaultsThinkingEnabled("")).toBe(false);
      expect(LocalProviderGateway.defaultsThinkingEnabled(null)).toBe(false);
    });

    it("should determine supportsModelManagement", () => {
      expect(LocalProviderGateway.supportsModelManagement("lm-studio")).toBe(true);
      expect(LocalProviderGateway.supportsModelManagement("ollama")).toBe(false);
      expect(LocalProviderGateway.supportsModelManagement("")).toBe(false);
      expect(LocalProviderGateway.supportsModelManagement(null)).toBe(false);
    });

    it("should resolve the correct provider type", () => {
      expect(LocalProviderGateway.getProviderType("lm-studio-1")).toBe("lm-studio");
      expect(LocalProviderGateway.getProviderType("ollama")).toBe("ollama");
      expect(LocalProviderGateway.getProviderType("openai")).toBeNull();
      expect(LocalProviderGateway.getProviderType("")).toBeNull();
      expect(LocalProviderGateway.getProviderType(null)).toBeNull();
    });
  });

  describe("Instance Enumeration", () => {
    it("should list all instances", () => {
      const instances = LocalProviderGateway.getInstances();
      expect(instances).toHaveLength(2);
      expect(instances[0].id).toBe("lm-studio-1");
    });

    it("should get instances by type", () => {
      const instances = LocalProviderGateway.getInstancesByType("lm-studio");
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe("lm-studio-1");
    });

    it("should get registered types", () => {
      const types = LocalProviderGateway.getRegisteredTypes();
      expect(types).toEqual(["lm-studio", "ollama"]);
    });

    it("should get concurrency capacity", () => {
      const capacity = LocalProviderGateway.getConcurrencyCapacity();
      expect(capacity.total).toBe(6);
      expect(capacity.byType).toEqual({ "lm-studio": 2, ollama: 4 });
      expect(capacity.byInstance).toEqual({ "lm-studio-1": 2, "ollama-1": 4 });
    });
  });

  describe("Model Discovery & Normalization", () => {
    it("should discover models across all instances", async () => {
      const modelsMap = await LocalProviderGateway.discoverModels();
      expect(modelsMap).toHaveProperty("lm-studio-1");
      expect(modelsMap).toHaveProperty("ollama-1");
      expect(modelsMap["lm-studio-1"]).toHaveLength(2);
      expect(modelsMap["lm-studio-1"][0].providerType).toBe("lm-studio");
    });

    it("should discover models for a specific instance", async () => {
      const models = await LocalProviderGateway.discoverModelsForInstance("lm-studio-1");
      expect(models).toHaveLength(2);
    });

    it("should return empty array for non-existent instance", async () => {
      const models = await LocalProviderGateway.discoverModelsForInstance("non-existent");
      expect(models).toEqual([]);
    });

    it("should handle listModels failures and log warning", async () => {
      mockProvider.listModels.mockRejectedValueOnce(new Error("Network Error"));
      const models = await LocalProviderGateway.discoverModelsForInstance("lm-studio-1");
      expect(models).toEqual([]);
    });

    it("should return empty if provider lacks listModels", async () => {
      vi.mocked(getProvider).mockImplementationOnce(() => ({}) as any);
      const models = await LocalProviderGateway.discoverModelsForInstance("lm-studio-1");
      expect(models).toEqual([]);
    });
  });

  describe("Model Search & Filtering", () => {
    it("should search and match models based on filters", async () => {
      const results = await LocalProviderGateway.searchModels({ query: "gemma" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].model.name).toContain("gemma");
    });

    it("should correctly handle boolean capability matches in _matchesFilter", () => {
      const testModel: any = {
        name: "test-model",
        label: "Test Model",
        id: "test",
        loaded: true,
        thinking: true,
        vision: true,
        tools: ["Tool Calling"],
        inputTypes: ["text", "video", "audio"],
        modelType: "conversation",
      };

      expect(LocalProviderGateway._matchesFilter(testModel, { thinking: true })).toBe(true);
      expect(LocalProviderGateway._matchesFilter(testModel, { vision: true })).toBe(true);
      expect(LocalProviderGateway._matchesFilter(testModel, { functionCalling: true })).toBe(true);
      expect(LocalProviderGateway._matchesFilter(testModel, { video: true })).toBe(true);
      expect(LocalProviderGateway._matchesFilter(testModel, { audio: true })).toBe(true);
      expect(LocalProviderGateway._matchesFilter(testModel, { loaded: true })).toBe(true);
      expect(LocalProviderGateway._matchesFilter(testModel, { modelType: "conversation" })).toBe(true);

      // Mismatch cases
      expect(LocalProviderGateway._matchesFilter(testModel, { thinking: false })).toBe(true);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, thinking: false }, { thinking: true })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, vision: false }, { vision: true })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, tools: [] }, { functionCalling: true })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, inputTypes: [] }, { video: true })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, inputTypes: [] }, { audio: true })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, modelType: "embed" }, { modelType: "conversation" })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, loaded: false }, { loaded: true })).toBe(false);
      expect(LocalProviderGateway._matchesFilter({ ...testModel, loaded: true }, { loaded: false })).toBe(false);
      expect(LocalProviderGateway._matchesFilter(testModel, { query: "not-matching" })).toBe(false);
    });
  });

  describe("Stats Generation", () => {
    it("should generate stats aggregation of all models", async () => {
      const stats = await LocalProviderGateway.getStats();
      expect(stats.totalModels).toBeGreaterThan(0);
      expect(stats.instances).toBe(2);
      expect(stats.loadedModels).toBeDefined();
    });
  });

  describe("Model Routing", () => {
    it("should resolve provider for a matching model key", async () => {
      const providerInfo = await LocalProviderGateway.resolveProvider("google/gemma-4-12b-qat");
      expect(providerInfo).not.toBeNull();
      expect(providerInfo!.instanceId).toBe("lm-studio-1");
    });

    it("should return null when model cannot be resolved", async () => {
      const providerInfo = await LocalProviderGateway.resolveProvider("unknown-model");
      expect(providerInfo).toBeNull();
    });
  });

  describe("Health Monitoring", () => {
    it("should check health of all instances using custom health probes", async () => {
      const health = await LocalProviderGateway.checkHealth();
      expect(health).toHaveProperty("lm-studio-1");
      expect(health).toHaveProperty("ollama-1");
      expect((health["lm-studio-1"] as any).ok).toBe(true);
    });

    it("should use listModels fallback check when checkHealth is absent", async () => {
      const providerWithoutHealth = {
        listModels: vi.fn().mockResolvedValue({ models: [{ id: "test" }] }),
      };
      vi.mocked(getProvider).mockImplementationOnce(() => providerWithoutHealth as any);

      const health = await LocalProviderGateway.checkHealth();
      expect((health["lm-studio-1"] as any).ok).toBe(true);
      expect((health["lm-studio-1"] as any).status).toBe("ok");
    });

    it("should handle error fallback in checkHealth when listModels fails", async () => {
      const providerWithFail = {
        listModels: vi.fn().mockRejectedValue(new Error("Connection error")),
      };
      vi.mocked(getProvider).mockImplementationOnce(() => providerWithFail as any);

      const health = await LocalProviderGateway.checkHealth();
      expect((health["lm-studio-1"] as any).ok).toBe(false);
      expect((health["lm-studio-1"] as any).status).toBe("unreachable");
    });
  });

  describe("VRAM Estimation & Model Management Delegation", () => {
    it("should delegate estimateVRAM and estimateVRAMForModel", async () => {
      const vram1 = LocalProviderGateway.estimateVRAM({} as any);
      expect(vram1).toEqual({ vramBytes: 12345 });

      const vram2 = await LocalProviderGateway.estimateVRAMForModel("lm-studio-1", "gemma");
      expect(vram2).toEqual({ vramBytes: 67890 });
    });

    it("should delegate loadModel, unloadModel, and ensureModelLoaded to provider", async () => {
      const load = await LocalProviderGateway.loadModel("lm-studio-1", "gemma");
      expect(load).toEqual({ success: true });

      const unload = await LocalProviderGateway.unloadModel("lm-studio-1", "model-inst-1");
      expect(unload).toEqual({ success: true });

      const ensure = await LocalProviderGateway.ensureModelLoaded("lm-studio-1", "gemma");
      expect(ensure).toEqual({ success: true });
    });
  });

  describe("Options Normalization & Generation Delegation", () => {
    it("should apply local defaults when isLocal is true", () => {
      const result = LocalProviderGateway.applyLocalDefaults("lm-studio-1", { temp: 0.7 }, { thinkingEnabled: undefined });
      expect(result).toBeDefined();
    });

    it("should delegate generateText, generateTextStream, generateEmbedding, and captionImage", async () => {
      const text = await LocalProviderGateway.generateText([], "google/gemma-4-12b-qat");
      expect(text).toBe("generated text");

      const stream = LocalProviderGateway.generateTextStream([], "google/gemma-4-12b-qat");
      const chunk = await stream.next();
      expect(chunk.value).toBe("stream chunk");

      const embed = await LocalProviderGateway.generateEmbedding("hello", "google/gemma-4-12b-qat");
      expect(embed).toEqual([0.1, 0.2]);

      const caption = await LocalProviderGateway.captionImage([], "prompt", "google/gemma-4-12b-qat");
      expect(caption).toBe("image caption");
    });
  });
});

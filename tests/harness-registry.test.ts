/**
 * Tests for HarnessRegistry and ReActHarness registration.
 *
 * Validates that the harness registry correctly resolves the
 * default ReAct harness, lists available harnesses, and handles
 * unknown harness IDs with graceful fallback.
 */
import { describe, it, expect, vi } from "vitest";

// ── Mock heavy dependencies that ReActHarness transitively imports ──
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("../../config.ts", () => ({
  PRISM_SERVICE_PORT: 0,
  GATEWAY_SECRET: "test-secret",
  OPENAI_API_KEY: "fake",
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_API_KEY: "fake",
  ELEVENLABS_API_KEY: "fake",
  INWORLD_BASIC: "fake",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:9999",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_URI: "mongodb://test:test@localhost:27017",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    createClient: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: "elevenlabs" } }),
    get: vi.fn().mockResolvedValue({}),
    getSection: vi.fn().mockResolvedValue({}),
    getMemoryModelConfig: vi.fn().mockResolvedValue({
      provider: "google",
      model: "gemini-embedding-2-preview",
    }),
    invalidateCache: vi.fn(),
    getDefaults: vi.fn(),
  },
}));

vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    appendMessages: vi.fn().mockResolvedValue(undefined),
    setGenerating: vi.fn().mockResolvedValue(undefined),
    getSessionStats: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    log: vi.fn(),
    logChatGeneration: vi.fn(),
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Import SUT ─────────────────────────────────────────────────
const HarnessRegistry = (
  await import("../src/services/harnesses/HarnessRegistry.ts")
).default;

// ═══════════════════════════════════════════════════════════════
describe("HarnessRegistry", () => {
  it("should resolve the ReAct harness by the 'standard' id", () => {
    const HarnessClass = HarnessRegistry.get("standard");
    expect(HarnessClass).toBeDefined();
    expect(HarnessClass!.id).toBe("standard");
    expect(HarnessClass!.label).toBe("ReAct Loop");
  });

  it("should fall back to the ReAct harness for unknown ids", () => {
    const HarnessClass = HarnessRegistry.get("nonexistent-harness-id");
    expect(HarnessClass).toBeDefined();
    expect(HarnessClass!.id).toBe("standard");
  });

  it("should list all registered harnesses", () => {
    const harnessList = HarnessRegistry.list();
    expect(harnessList).toBeInstanceOf(Array);
    expect(harnessList.length).toBeGreaterThanOrEqual(1);

    const reactHarnessEntry = harnessList.find(
      (entry: any) => entry.id === "standard",
    );
    expect(reactHarnessEntry).toBeDefined();
    expect(reactHarnessEntry!.label).toBe("ReAct Loop");
    expect(reactHarnessEntry!.description).toContain("Reason→Act→Observe");
  });

  it("should report 'standard' as a registered harness id", () => {
    expect(HarnessRegistry.has("standard")).toBe(true);
  });

  it("should report unknown ids as not registered", () => {
    expect(HarnessRegistry.has("nonexistent")).toBe(false);
  });

  it("should have TreeOfThoughtHarness registered inside HarnessRegistry", () => {
    const harnessClass = HarnessRegistry.get("tree_of_thought");
    expect(harnessClass).toBeDefined();
    expect(harnessClass!.id).toBe("tree_of_thought");
    expect(harnessClass!.label).toBe("Tree of Thought");
    expect(harnessClass!.description).toContain("backtracking");
  });

  it("should include TreeOfThoughtHarness inside the list of available harnesses", () => {
    const harnessList = HarnessRegistry.list();
    const treeOfThoughtHarnessEntry = harnessList.find((entry) => entry.id === "tree_of_thought");
    expect(treeOfThoughtHarnessEntry).toBeDefined();
    expect(treeOfThoughtHarnessEntry?.label).toBe("Tree of Thought");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("ReActHarness — static metadata", () => {
  it("should have the correct static id for backward compatibility", () => {
    const HarnessClass = HarnessRegistry.get("standard");
    // The static id MUST remain 'standard' for backward compatibility
    // with existing agent sessions in MongoDB
    expect(HarnessClass!.id).toBe("standard");
  });

  it("should extend BaseAgenticHarness", () => {
    const HarnessClass = HarnessRegistry.get("standard");
    // Verify it's a class (constructor function)
    expect(typeof HarnessClass).toBe("function");
    expect(HarnessClass!.prototype).toBeDefined();
    expect(typeof HarnessClass!.prototype.run).toBe("function");
  });

  it("should have a descriptive label and description", () => {
    const HarnessClass = HarnessRegistry.get("standard");
    expect(HarnessClass!.label).not.toBe("Standard");
    expect(HarnessClass!.label).toBe("ReAct Loop");
    expect(HarnessClass!.description).toContain("approval gating");
    expect(HarnessClass!.description).toContain("exhaustion recovery");
  });
});

// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts) ──

describe('ReActHarness maxIterations resolution (unit-level)', () => {
  /**
   * The harness resolves maxIterations with:
   *   clientMaxIterations === 0 → Infinity
   *   clientMaxIterations ? Math.min(100, Math.max(1, clientMaxIterations)) : 25
   *
   * We test the same logic inline to verify boundary handling.
   */
  function resolveMaxIterations(clientMaxIterations: number | undefined | null): number {
    const MAX_TOOL_ITERATIONS = 25;
    return clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : MAX_TOOL_ITERATIONS;
  }

  it('should resolve 0 to Infinity (unlimited mode)', () => {
    expect(resolveMaxIterations(0)).toBe(Infinity);
  });

  it('should resolve undefined to default 25', () => {
    expect(resolveMaxIterations(undefined)).toBe(25);
  });

  it('should resolve null to default 25', () => {
    expect(resolveMaxIterations(null)).toBe(25);
  });

  it('should clamp negative values to 1', () => {
    expect(resolveMaxIterations(-10)).toBe(1);
  });

  it('should clamp values above 100 to 100', () => {
    expect(resolveMaxIterations(999)).toBe(100);
  });

  it('should pass through values in valid range', () => {
    expect(resolveMaxIterations(50)).toBe(50);
  });

  it('should handle NaN — NaN is falsy for ternary, should resolve to default 25', () => {
    expect(resolveMaxIterations(NaN)).toBe(25);
  });

  it('should handle Infinity — clamped to 100', () => {
    expect(resolveMaxIterations(Infinity)).toBe(100);
  });

  it('should handle -Infinity — clamped to 1', () => {
    expect(resolveMaxIterations(-Infinity)).toBe(1);
  });

  it('should handle fractional values — Math.min/max preserve floats', () => {
    // 0.5 is truthy, so it enters the clamp branch
    expect(resolveMaxIterations(0.5)).toBe(1);
    expect(resolveMaxIterations(50.7)).toBe(50.7);
  });
});

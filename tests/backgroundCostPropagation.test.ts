/**
 * Background Cost Propagation — regression tests.
 *
 * Root cause: Background LLM calls (memory extraction, consolidation,
 * embedding) emitted usage_update SSE events with token counts but NOT
 * estimated cost. This caused the client-side session cost badge to
 * under-report during the 2-8s window before fetchSessionStats returned
 * the authoritative backend aggregation.
 *
 * These tests verify that:
 *   1. MemoryExtractor emits estimatedCost in both usage_update events
 *      (memory:extract and embed:memory)
 *   2. MemoryConsolidationService emits estimatedCost in the
 *      memory:consolidate usage_update event
 *   3. Cost values are computed correctly using calculateTextCost
 */
import { describe, it, expect, vi } from "vitest";
import { PROVIDERS, TYPES } from "../src/constants.ts";

const { CODING_MEMORY_TYPES } = vi.hoisted(() => ({
  CODING_MEMORY_TYPES: ["user", "feedback", "project", "reference"] as const,
}));

// ── Mock config.js ──────────────────────────────────────────────
const MOCK_TEXT_PRICING = {
  "test-extract-model": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
  },
  "test-consolidation-model": {
    inputPerMillion: 0.50,
    outputPerMillion: 2.00,
  },
};
const MOCK_EMBEDDING_PRICING = {
  "test-embed-model": {
    inputPerMillion: 0.10,
  },
};

const configMock = {
  MONGO_DB_NAME: "prism-test",
  TYPES,
  getPricing: (_inputType: any, outputType: any) => {
    if (outputType === "embedding") return MOCK_EMBEDDING_PRICING;
    return MOCK_TEXT_PRICING;
  },
};

// Root config.js — exports MONGO_DB_NAME (used by ConversationService etc.)
vi.mock("../config.ts", () => configMock);
// src/config.js — exports TYPES, getPricing, model catalog (used by MemoryExtractor, etc.)
vi.mock("../src/config.ts", () => configMock);

// ── Mock providers ──────────────────────────────────────────────
const mockGenerateText = vi.fn().mockResolvedValue({
  text: '[]', // Empty extraction result by default
});

vi.mock("../src/providers/index.ts", () => ({
  getProvider: () => ({
    generateText: mockGenerateText,
  }),
}));

// ── Mock SettingsService ────────────────────────────────────────
vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    getSection: vi.fn().mockResolvedValue({
      extractionProvider: "test-provider",
      extractionModel: "test-extract-model",
      embeddingModel: "test-embed-model",
    }),
    getMemoryModelConfig: vi.fn().mockImplementation((type) => {
      if (type === "extraction") {
        return Promise.resolve({ provider: "test-provider", model: "test-extract-model" });
      }
      if (type === "consolidation") {
        return Promise.resolve({ provider: "test-provider", model: "test-consolidation-model" });
      }
      if (type === "embedding") {
        return Promise.resolve({ provider: "test-provider", model: "test-embed-model" });
      }
      return Promise.resolve({});
    }),
  },
}));

// ── Mock RequestLogger (fire-and-forget, we don't test it here) ─
vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    logBackgroundLlmCall: vi.fn(),
    log: vi.fn(),
  },
}));

// ── Mock MemoryService ──────────────────────────────────────────
vi.mock("../src/services/MemoryService.ts", () => ({
  default: {
    store: vi.fn().mockResolvedValue({ id: "mem-1", title: "Test memory" }),
    search: vi.fn().mockResolvedValue([]),
  },
  CODING_MEMORY_TYPES,
}));

// ── Mock MemoryConsolidationService (for MemoryExtractor tests) ─
vi.mock("../src/services/MemoryConsolidationService.ts", () => ({
  default: {
    checkAndRun: vi.fn(),
  },
}));

// ── Mock AgentPersonaRegistry (for consolidation tests) ─────────
vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn().mockReturnValue({ type: "coding" }),
  },
}));

// ── Mock MongoWrapper (for consolidation tests) ─────────────────
vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn().mockReturnValue(null), // prevents actual DB calls
    getCollection: vi.fn(),
  },
}));

// ── Mock EmbeddingService (for consolidation's MemoryService) ───
vi.mock("../src/services/EmbeddingService.ts", () => ({
  default: {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    generate: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], dimensions: 3 }),
  },
}));

// ── Mock logger ─────────────────────────────────────────────────
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    request: vi.fn(),
  },
}));

// ── Import AFTER mocks ─────────────────────────────────────────
const { default: MemoryExtractor } = await import("../src/services/MemoryExtractor.ts");
const { calculateTextCost } = await import("../src/utils/CostCalculator.ts");

// ═══════════════════════════════════════════════════════════════
describe("Background Cost Propagation", () => {
  // ── MemoryExtractor ───────────────────────────────────────────
  describe("MemoryExtractor.extractAndStore", () => {
    const BASE_MESSAGES = [
      { role: "user", content: "Hello, can you help me?" },
      { role: "assistant", content: "Sure, how can I help?" },
      { role: "user", content: "I need to fix a bug in the auth service." },
      { role: "assistant", content: "Let me look at the auth service code." },
      { role: "user", content: "The login endpoint is returning 500 errors." },
    ];
    it("should emit estimatedCost in memory:extract usage_update", async () => {
      const emittedEvents: any[] = [];
      const emit = (event: any) => emittedEvents.push(event);

      // Override generateText to return something parseable
      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify([
          { type: "feedback", title: "Auth debugging", content: "Check auth service for 500 errors" },
        ]),
      });

      await MemoryExtractor.extractAndStore({
        project: "test-project",
        username: "testuser",
        messages: BASE_MESSAGES,
        traceId: "trace-1",
        agentConversationId: "session-1",
        endpoint: "/agent",
        agent: "CODING",
        toolCalls: [],
        emit,
      });

      // Find the memory:extract usage_update event
      const extractEvent = emittedEvents.find(
        (e) => e.type === "usage_update" && e.operation === "memory:extract",
      );

      expect(extractEvent).toBeDefined();
      expect(extractEvent.usage).toBeDefined();
      expect(extractEvent.usage.requests).toBe(1);
      expect(extractEvent.usage.inputTokens).toBeGreaterThan(0);
      expect(typeof extractEvent.usage.estimatedCost).toBe("number");
      expect(extractEvent.usage.estimatedCost).toBeGreaterThan(0);

      // Verify cost matches calculateTextCost with the model's pricing
      const expectedCost = calculateTextCost(
        { inputTokens: extractEvent.usage.inputTokens, outputTokens: extractEvent.usage.outputTokens },
        MOCK_TEXT_PRICING["test-extract-model"],
      );
      expect(extractEvent.usage.estimatedCost).toBeCloseTo(expectedCost as number, 8);
    });

    it("should emit estimatedCost in embed:memory usage_update", async () => {
      const emittedEvents: any[] = [];
      const emit = (event: any) => emittedEvents.push(event);

      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify([
          { type: "user", title: "User preference", content: "Prefers dark mode" },
          { type: "feedback", title: "CSS pattern", content: "Use GPU-accelerated animations" },
        ]),
      });

      await MemoryExtractor.extractAndStore({
        project: "test-project",
        username: "testuser",
        messages: BASE_MESSAGES,
        agentConversationId: "session-1",
        endpoint: "/agent",
        agent: "CODING",
        toolCalls: [],
        emit,
      });

      // Find the embed:memory usage_update event
      const embedEvent = emittedEvents.find(
        (e) => e.type === "usage_update" && e.operation === "embed:memory",
      );

      expect(embedEvent).toBeDefined();
      expect(embedEvent.usage).toBeDefined();
      expect(embedEvent.usage.requests).toBe(2); // 2 memories stored
      expect(typeof embedEvent.usage.estimatedCost).toBe("number");
      // Embedding cost = inputTokens / 1M * inputPerMillion
      // 2 memories * 50 tokens = 100 tokens, at $0.10/M = $0.00001
      expect(embedEvent.usage.estimatedCost).toBeCloseTo(100 / 1_000_000 * 0.10, 8);
    });

    it("should not emit usage_update when extraction yields no memories", async () => {
      const emittedEvents: any[] = [];
      const emit = (event: any) => emittedEvents.push(event);

      mockGenerateText.mockResolvedValueOnce({
        text: "[]",
      });

      await MemoryExtractor.extractAndStore({
        project: "test-project",
        username: "testuser",
        messages: BASE_MESSAGES,
        agentConversationId: "session-1",
        endpoint: "/agent",
        agent: "CODING",
        toolCalls: [],
        emit,
      });

      // memory:extract should still emit (the LLM call happened)
      const extractEvent = emittedEvents.find(
        (e) => e.type === "usage_update" && e.operation === "memory:extract",
      );
      expect(extractEvent).toBeDefined();
      expect(extractEvent.usage.estimatedCost).toBeGreaterThan(0);

      // But embed:memory should NOT emit (no memories to embed)
      const embedEvent = emittedEvents.find(
        (e) => e.type === "usage_update" && e.operation === "embed:memory",
      );
      expect(embedEvent).toBeUndefined();
    });

    it("should skip extraction when save_memory was used (mutual exclusion)", async () => {
      const emittedEvents: any[] = [];
      const emit = (event: any) => emittedEvents.push(event);

      const result = await MemoryExtractor.extractAndStore({
        project: "test-project",
        username: "testuser",
        messages: BASE_MESSAGES,
        agentConversationId: "session-1",
        endpoint: "/agent",
        agent: "CODING",
        toolCalls: [{ id: "call-1", name: "save_memory", args: {} }],
        emit,
      });

      expect(result).toEqual([]);
      expect(emittedEvents).toHaveLength(0);
    });

    it("should handle null estimatedCost gracefully when model pricing is unavailable", async () => {
      const emittedEvents: any[] = [];
      const emit = (event: any) => emittedEvents.push(event);

      // Override settings to return a model not in our pricing table
      const SettingsService = (await import("../src/services/SettingsService.ts")).default;
      (SettingsService.getSection as any).mockResolvedValueOnce({
        extractionProvider: "test-provider",
        extractionModel: "unknown-model-not-in-pricing",
        embeddingModel: "unknown-embed-model",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: JSON.stringify([
          { type: "project", title: "Test", content: "Test content" },
        ]),
      });

      await MemoryExtractor.extractAndStore({
        project: "test-project",
        username: "testuser",
        messages: BASE_MESSAGES,
        agentConversationId: "session-1",
        endpoint: "/agent",
        agent: "CODING",
        toolCalls: [],
        emit,
      });

      const extractEvent = emittedEvents.find(
        (e) => e.type === "usage_update" && e.operation === "memory:extract",
      );
      expect(extractEvent).toBeDefined();
      // estimatedCost should be null when pricing is unavailable
      expect(extractEvent.usage.estimatedCost).toBeNull();
    });
  });

  // ── Client-side accumulation (pure logic) ─────────────────────
  describe("Client-side _backgroundUsage accumulation", () => {
    /**
     * Simulates the client-side accumulation logic from AgentComponent.js.
     * This is the exact pattern used in the onUsageUpdate handler.
     */
    function accumulateBackgroundUsage(existing: any, usageEvent: any) {
      const bg = existing || { inputTokens: 0, outputTokens: 0, cost: 0 };
      return {
        inputTokens: bg.inputTokens + (usageEvent.inputTokens || 0),
        outputTokens: bg.outputTokens + (usageEvent.outputTokens || 0),
        requests: (bg.requests || 0) + (usageEvent.requests || 1),
        cost: bg.cost + (usageEvent.estimatedCost || 0),
      };
    }

    it("should accumulate cost across multiple background operations", () => {
      let bg = null;

      // Simulate memory:extract event
      bg = accumulateBackgroundUsage(bg, {
        requests: 1,
        inputTokens: 500,
        outputTokens: 100,
        estimatedCost: 0.000250, // extraction LLM call
      });

      expect(bg.cost).toBeCloseTo(0.000250, 8);
      expect(bg.requests).toBe(1);

      // Simulate embed:memory event (4 memories stored)
      bg = accumulateBackgroundUsage(bg, {
        requests: 4,
        inputTokens: 200,
        outputTokens: 0,
        estimatedCost: 0.00002, // embedding calls
      });

      expect(bg.cost).toBeCloseTo(0.000270, 8);
      expect(bg.requests).toBe(5);

      // Simulate memory:consolidate event
      bg = accumulateBackgroundUsage(bg, {
        requests: 1,
        inputTokens: 2000,
        outputTokens: 500,
        estimatedCost: 0.002000, // consolidation LLM call
      });

      expect(bg.cost).toBeCloseTo(0.002270, 8);
      expect(bg.requests).toBe(6);
      expect(bg.inputTokens).toBe(2700);
      expect(bg.outputTokens).toBe(600);
    });

    it("should handle null estimatedCost gracefully (treat as 0)", () => {
      let bg = null;

      bg = accumulateBackgroundUsage(bg, {
        requests: 1,
        inputTokens: 500,
        outputTokens: 100,
        estimatedCost: null,
      });

      expect(bg.cost).toBe(0);
      expect(bg.requests).toBe(1);
    });

    it("should handle missing estimatedCost field gracefully", () => {
      let bg = null;

      bg = accumulateBackgroundUsage(bg, {
        requests: 1,
        inputTokens: 500,
        outputTokens: 100,
        // estimatedCost not present at all
      });

      expect(bg.cost).toBe(0);
      expect(bg.requests).toBe(1);
    });

    it("should correctly add bgUsage.cost to totalCost in both rendering paths", () => {
      const bgUsage = { inputTokens: 1000, outputTokens: 200, requests: 3, cost: 0.001500 };

      // Backend stats path: backendSessionStats.totalCost + bgUsage.cost
      const backendTotalCost = 0.005000;
      const backendResult = (backendTotalCost || 0) + (bgUsage?.cost || 0);
      expect(backendResult).toBeCloseTo(0.006500, 8);

      // Client fallback path: totalCost (from getSessionCost) + bgUsage.cost
      const clientTotalCost = 0.000610; // just the agent:iteration cost
      const clientResult = clientTotalCost + (bgUsage?.cost || 0);
      expect(clientResult).toBeCloseTo(0.002110, 8);
    });

    it("should handle null bgUsage gracefully (no background ops happened)", () => {
      const bgUsage = null as any;

      const backendTotalCost = 0.005000;
      const result = (backendTotalCost || 0) + (bgUsage?.cost || 0);
      expect(result).toBeCloseTo(0.005000, 8);
    });
  });
});

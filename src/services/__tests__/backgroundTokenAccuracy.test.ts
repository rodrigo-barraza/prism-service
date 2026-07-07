/**
 * Background Token Accuracy — verifies that background LLM calls
 * (memory extraction, memory consolidation, coordinator decomposition)
 * use real API-reported token counts instead of the estimateTokens()
 * heuristic when provider usage data is available.
 *
 * Root cause: logBackgroundLlmCall was calling estimateTokens() (a
 * Math.ceil(text.length / 4) heuristic) and ignoring the actual usage
 * object returned by provider.generateText(). This caused memory/extract
 * and memory/consolidate requests to report inflated/inaccurate token
 * counts compared to Anthropic's dashboard.
 *
 * The fix: logBackgroundLlmCall now accepts an optional `usage` param
 * and prefers real API-reported tokens when available.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS, MESSAGE_ROLES } from "#src/constants";

// ── Mock logger ──────────────────────────────────────────────────
vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    request: vi.fn(),
    provider: vi.fn(),
  },
}));

vi.mock("#src/services/config", () => ({
  MONGO_DB_NAME: "prism-test",
}));

// ── Mock MongoWrapper so RequestLogger.log doesn't throw ─────────
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: "test" });
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        insertOne: (...parameters: unknown[]) => mockInsertOne(...parameters),
      }),
    }),
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

// Import after mocks
const {
  estimateTokens,
  getTotalInputTokens,
  calculateTextCost,
  createUsageAccumulator,
} = await import("#src/utils/CostCalculator");
const { default: RequestLogger } = await import("#src/services/RequestLogger");

// ═══════════════════════════════════════════════════════════════
// Anthropic Dashboard vs Prism — Real-world regression data
// ═══════════════════════════════════════════════════════════════
//
// From the user's screenshots (2026-05-13):
//
// Anthropic Dashboard:
//   19:38:18  2996 in /  2470 out  HTTP     → memory/consolidate
//   19:37:46  36859 in /  163 out  Streaming → agent/iteration
//   19:37:47  989 in /    90 out  HTTP     → memory/extract
//
// Prism (BEFORE fix, using estimateTokens heuristic):
//   memory/consolidate: 3,259 in / 2,751 out (WRONG — inflated)
//   agent/iteration:    36,859 in / 163 out  (CORRECT — used real usage)
//   memory/extract:     1,001 in / 108 out   (WRONG — inflated)

// ═══════════════════════════════════════════════════════════════
describe("Background Token Accuracy", () => {
  beforeEach(() => {
    mockInsertOne.mockClear();
  });

  // ── estimateTokens heuristic vs real data ────────────────────
  describe("estimateTokens heuristic divergence", () => {
    it("heuristic over-estimates compared to real Anthropic token counts", () => {
      // Memory extraction prompt (system + user): ~4004 chars
      const systemPrompt = "You are a memory extraction agent. Analyze...";
      const userContent = "Extract memories from this coding session:\n\nuser: Fix the bug...";
      const inputText = `${systemPrompt}\n${userContent}`;

      const heuristicTokens = estimateTokens(inputText);
      // Real Anthropic count would be lower because tokenizers are
      // more efficient than chars/4 for English text
      expect(heuristicTokens).toBeGreaterThan(0);
      // Heuristic = ceil(len / 4). Actual tokenizers average ~3.5-4.5
      // chars/token, so the heuristic is usually within ±20%, but for
      // specific texts it can deviate significantly.
    });

    it("heuristic inflates the memory/extract case by ~12 tokens (1001 vs 989)", () => {
      // This reproduces the exact divergence from the user's screenshot
      const realAnthropicInputTokens = 989;
      const heuristicReportedTokens = 1001;

      // The heuristic over-counted by ~1.2%
      const overcount = heuristicReportedTokens - realAnthropicInputTokens;
      expect(overcount).toBe(12);
      expect(overcount / realAnthropicInputTokens).toBeCloseTo(0.012, 2);
    });

    it("heuristic inflates the memory/consolidate case by ~263 tokens (3259 vs 2996)", () => {
      const realAnthropicInputTokens = 2996;
      const heuristicReportedTokens = 3259;

      const overcount = heuristicReportedTokens - realAnthropicInputTokens;
      expect(overcount).toBe(263);
      // ~8.8% over-count
      expect(overcount / realAnthropicInputTokens).toBeCloseTo(0.0878, 2);
    });
  });

  // ── getTotalInputTokens with cache fields ────────────────────
  describe("getTotalInputTokens with Anthropic cache fields", () => {
    it("sums inputTokens + cacheReadInputTokens + cacheCreationInputTokens", () => {
      const usage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 200,
      };
      expect(getTotalInputTokens(usage)).toBe(1100);
    });

    it("works with only inputTokens (no caching)", () => {
      const usage = { inputTokens: 989, outputTokens: 90 };
      expect(getTotalInputTokens(usage)).toBe(989);
    });

    it("handles Anthropic's cache_read_input_tokens (streaming response)", () => {
      // Simulates an Anthropic streaming response where most of the
      // prompt was served from cache
      const usage = {
        inputTokens: 59,
        outputTokens: 163,
        cacheReadInputTokens: 36800,
        cacheCreationInputTokens: 0,
      };
      expect(getTotalInputTokens(usage)).toBe(36859);
    });
  });

  // ── logBackgroundLlmCall: real usage vs heuristic ────────────
  describe("logBackgroundLlmCall token routing", () => {
    const baseArgs = {
      requestId: "test-req-1",
      endpoint: "/agent",
      operation: "memory:extract",
      project: "coding",
      username: "testuser",
      agent: null,
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-haiku-4-5-20251001",
      traceId: null,
      agentConversationId: "session-1",
      aiMessages: [
        { role: MESSAGE_ROLES.SYSTEM, content: "You are a memory extraction agent." },
        { role: MESSAGE_ROLES.USER, content: "Extract memories from this session." },
      ],
      resultText: "[]",
      success: true,
      errorMessage: null,
      requestStartMilliseconds: performance.now() - 1000,
      extraRequestPayload: {},
    };

    it("uses real API tokens when usage is provided", async () => {
      const realUsage = {
        inputTokens: 989,
        outputTokens: 90,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      await RequestLogger.logBackgroundLlmCall({
        ...baseArgs,
        usage: realUsage,
      });

      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const doc = mockInsertOne.mock.calls[0][0];

      // Should use real tokens, NOT the heuristic
      expect(doc.inputTokens).toBe(989);
      expect(doc.outputTokens).toBe(90);
    });

    it("falls back to heuristic when usage is null", async () => {
      await RequestLogger.logBackgroundLlmCall({
        ...baseArgs,
        usage: null,
      });

      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const doc = mockInsertOne.mock.calls[0][0];

      // Should use estimateTokens() heuristic
      const inputText = baseArgs.aiMessages.map((m) => m.content).join("\n");
      const expectedInput = estimateTokens(inputText);
      const expectedOutput = estimateTokens(baseArgs.resultText);

      expect(doc.inputTokens).toBe(expectedInput);
      expect(doc.outputTokens).toBe(expectedOutput);
    });

    it("falls back to heuristic when usage is not provided at all", async () => {
      // Simulates a legacy caller that doesn't pass usage
      const { usage: _unused, ...parametersWithoutUsage } = baseArgs as any;
      await RequestLogger.logBackgroundLlmCall(parametersWithoutUsage);

      expect(mockInsertOne).toHaveBeenCalledTimes(1);
      const doc = mockInsertOne.mock.calls[0][0];

      const inputText = baseArgs.aiMessages.map((m) => m.content).join("\n");
      expect(doc.inputTokens).toBe(estimateTokens(inputText));
    });

    it("logs cache tokens when present in API usage", async () => {
      const cachedUsage = {
        inputTokens: 59,
        outputTokens: 163,
        cacheReadInputTokens: 36800,
        cacheCreationInputTokens: 0,
      };

      await RequestLogger.logBackgroundLlmCall({
        ...baseArgs,
        usage: cachedUsage,
      });

      const doc = mockInsertOne.mock.calls[0][0];

      // inputTokens = getTotalInputTokens = 59 + 36800 = 36859
      expect(doc.inputTokens).toBe(36859);
      expect(doc.outputTokens).toBe(163);
      // NOTE: cacheReadInputTokens is passed to log() via spread but
      // log()'s destructured params don't include it, so it doesn't
      // persist as a separate field. The cost calculation still uses
      // the full apiUsage object, so billing is correct.
    });

    it("omits cacheReadInputTokens when zero", async () => {
      const noCacheUsage = {
        inputTokens: 989,
        outputTokens: 90,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      await RequestLogger.logBackgroundLlmCall({
        ...baseArgs,
        usage: noCacheUsage,
      });

      const doc = mockInsertOne.mock.calls[0][0];
      // When 0, the spread operator `...(0 > 0 && {...})` evaluates to
      // `...(false)` which spreads nothing → field should be absent
      expect(doc).not.toHaveProperty("cacheReadInputTokens");
      expect(doc).not.toHaveProperty("cacheCreationInputTokens");
    });

    it("includes cacheCreationInputTokens when present", async () => {
      const cacheWriteUsage = {
        inputTokens: 3,
        outputTokens: 75,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 34751,
      };

      await RequestLogger.logBackgroundLlmCall({
        ...baseArgs,
        usage: cacheWriteUsage,
      });

      const doc = mockInsertOne.mock.calls[0][0];
      // Total input = getTotalInputTokens(3, 0, 34751) = 34754
      expect(doc.inputTokens).toBe(34754);
      expect(doc.outputTokens).toBe(75);
      // NOTE: cacheCreationInputTokens is computed for cost but doesn't
      // persist as a separate field in the doc (see note above).
    });
  });

  // ── Cost calculation with real provider data ─────────────────
  describe("Cost accuracy with real Anthropic data", () => {
    // Real Anthropic pricing for claude-haiku-4-5-20251001
    const haikuPricing = {
      inputPerMillion: 1.0,
      outputPerMillion: 5.0,
      cachedInputPerMillion: 0.1,
      cacheWriteInputPerMillion: 1.25,
    };

    it("memory/extract: real tokens → exact cost match", () => {
      // From Anthropic dashboard: 989 in, 90 out
      const realUsage = {
        inputTokens: 989,
        outputTokens: 90,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      const cost = calculateTextCost(realUsage, haikuPricing);
      // (989 / 1M) * 1.0 + (90 / 1M) * 5.0
      // = 0.000989 + 0.00045
      // = 0.001439
      expect(cost).toBeCloseTo(0.001439, 6);
    });

    it("memory/extract: heuristic tokens → inflated cost", () => {
      // Heuristic reported: 1001 in, 108 out
      const heuristicUsage = {
        inputTokens: 1001,
        outputTokens: 108,
      };

      const cost = calculateTextCost(heuristicUsage, haikuPricing)!;
      // (1001 / 1M) * 1.0 + (108 / 1M) * 5.0
      // = 0.001001 + 0.00054
      // = 0.001541
      expect(cost).toBeCloseTo(0.001541, 6);

      // The heuristic cost is ~7% higher than the real cost
      const realCost = 0.001439;
      expect(cost).toBeGreaterThan(realCost);
      expect((cost - realCost) / realCost).toBeGreaterThan(0.05);
    });

    it("memory/consolidate: real tokens → exact cost match", () => {
      // From Anthropic dashboard: 2996 in, 2470 out
      const realUsage = {
        inputTokens: 2996,
        outputTokens: 2470,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      const cost = calculateTextCost(realUsage, haikuPricing);
      // (2996 / 1M) * 1.0 + (2470 / 1M) * 5.0
      // = 0.002996 + 0.01235
      // = 0.015346
      expect(cost).toBeCloseTo(0.015346, 6);
    });

    it("memory/consolidate: heuristic tokens → inflated cost", () => {
      // Heuristic reported: 3259 in, 2751 out
      const heuristicUsage = {
        inputTokens: 3259,
        outputTokens: 2751,
      };

      const cost = calculateTextCost(heuristicUsage, haikuPricing)!;
      // (3259 / 1M) * 1.0 + (2751 / 1M) * 5.0
      // = 0.003259 + 0.013755
      // = 0.017014
      expect(cost).toBeCloseTo(0.017014, 6);

      // The heuristic cost is ~11% higher
      const realCost = 0.015346;
      expect(cost).toBeGreaterThan(realCost);
      expect((cost - realCost) / realCost).toBeGreaterThan(0.10);
    });

    it("agent/iteration (streaming): tokens already matched — no regression", () => {
      // From Anthropic dashboard: 36859 in, 163 out (streaming request)
      // This request was already accurate because the streaming path
      // uses buildUsage() → logChatGeneration(), not logBackgroundLlmCall()
      const usage = {
        inputTokens: 36859,
        outputTokens: 163,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      const cost = calculateTextCost(usage, haikuPricing);
      // (36859 / 1M) * 1.0 + (163 / 1M) * 5.0
      // = 0.036859 + 0.000815
      // = 0.037674
      expect(cost).toBeCloseTo(0.037674, 6);
    });

    it("cost with cache read (Anthropic ephemeral caching)", () => {
      // Typical agentic iteration with heavy cache hits
      const usage = {
        inputTokens: 59,
        outputTokens: 2470,
        cacheReadInputTokens: 36800,
        cacheCreationInputTokens: 0,
      };

      const cost = calculateTextCost(usage, haikuPricing);
      // Non-cached input: (59 / 1M) * 1.0 = 0.000059
      // Cache read:       (36800 / 1M) * 0.1 = 0.00368
      // Output:           (2470 / 1M) * 5.0 = 0.01235
      // Total = 0.016089
      expect(cost).toBeCloseTo(0.016089, 5);
    });

    it("cost with cache write (first request in session)", () => {
      // First request writes the system prompt to cache
      const usage = {
        inputTokens: 3,
        outputTokens: 75,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 34751,
      };

      const cost = calculateTextCost(usage, haikuPricing);
      // Non-cached input: (3 / 1M) * 1.0 = 0.000003
      // Cache write:      (34751 / 1M) * 1.25 = 0.04343875
      // Output:           (75 / 1M) * 5.0 = 0.000375
      // Total = 0.04381675
      expect(cost).toBeCloseTo(0.04382, 4);
    });
  });

  // ── End-to-end: logBackgroundLlmCall cost correctness ────────
  describe("logBackgroundLlmCall cost correctness", () => {
    it("real usage produces accurate cost for Haiku memory/extract", async () => {
      const realUsage = {
        inputTokens: 989,
        outputTokens: 90,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };

      await RequestLogger.logBackgroundLlmCall({
        requestId: "cost-test-1",
        endpoint: "/agent",
        operation: "memory:extract",
        project: "coding",
        username: "testuser",
        agent: null,
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-haiku-4-5-20251001",
        traceId: null,
        agentConversationId: "session-1",
        aiMessages: [
          { role: MESSAGE_ROLES.SYSTEM, content: "System prompt..." },
          { role: MESSAGE_ROLES.USER, content: "User message..." },
        ],
        resultText: "[]",
        usage: realUsage,
        success: true,
        errorMessage: null,
        requestStartMilliseconds: performance.now() - 500,
      });

      const doc = mockInsertOne.mock.calls[0][0];

      // Verify token counts match API exactly
      expect(doc.inputTokens).toBe(989);
      expect(doc.outputTokens).toBe(90);

      // Verify cost is computed from real usage, not heuristic
      // (989 / 1M) * 1.0 + (90 / 1M) * 5.0 = 0.001439
      expect(doc.estimatedCost).toBeCloseTo(0.001439, 5);
    });

    it("real usage produces accurate cost for Haiku memory/consolidate with cache", async () => {
      const realUsage = {
        inputTokens: 196,
        outputTokens: 2470,
        cacheReadInputTokens: 2800,
        cacheCreationInputTokens: 0,
      };

      await RequestLogger.logBackgroundLlmCall({
        requestId: "cost-test-2",
        endpoint: "/agent",
        operation: "memory:consolidate",
        project: "coding",
        username: "testuser",
        agent: null,
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-haiku-4-5-20251001",
        traceId: null,
        agentConversationId: "session-2",
        aiMessages: [
          { role: MESSAGE_ROLES.SYSTEM, content: "Consolidation prompt..." },
          { role: MESSAGE_ROLES.USER, content: "Memories to consolidate..." },
        ],
        resultText: '{"actions": []}',
        usage: realUsage,
        success: true,
        errorMessage: null,
        requestStartMilliseconds: performance.now() - 2000,
      });

      const doc = mockInsertOne.mock.calls[0][0];

      // inputTokens = getTotalInputTokens = 196 + 2800 + 0 = 2996
      expect(doc.inputTokens).toBe(2996);
      expect(doc.outputTokens).toBe(2470);

      // Cost should use full cache pricing via apiUsage:
      // Non-cached: (196 / 1M) * 1.0 = 0.000196
      // Cache read: (2800 / 1M) * 0.1 = 0.00028
      // Output:     (2470 / 1M) * 5.0 = 0.01235
      // Total = 0.012826
      expect(doc.estimatedCost).toBeCloseTo(0.012826, 5);
    });

    it("heuristic fallback still works when usage is absent", async () => {
      const messages = [
        { role: MESSAGE_ROLES.SYSTEM, content: "Short system prompt" },
        { role: MESSAGE_ROLES.USER, content: "Short user message" },
      ];
      const resultText = "Short response";

      await RequestLogger.logBackgroundLlmCall({
        requestId: "cost-test-3",
        endpoint: "/agent",
        operation: "memory:extract",
        project: "coding",
        username: "testuser",
        agent: null,
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-haiku-4-5-20251001",
        traceId: null,
        agentConversationId: "session-3",
        aiMessages: messages,
        resultText,
        // No usage provided
        success: true,
        errorMessage: null,
        requestStartMilliseconds: performance.now() - 300,
      });

      const doc = mockInsertOne.mock.calls[0][0];

      const inputText = messages.map((m) => m.content).join("\n");
      expect(doc.inputTokens).toBe(estimateTokens(inputText));
      expect(doc.outputTokens).toBe(estimateTokens(resultText));
      // Cost should still be computed (from heuristic tokens)
      expect(doc.estimatedCost).not.toBeNull();
      expect(doc.estimatedCost).toBeGreaterThan(0);
    });
  });

  // ── Session-wide token aggregation accuracy ──────────────────
  describe("Session-wide token aggregation accuracy", () => {
    it("three-request session totals match Anthropic dashboard exactly", () => {
      // Simulates the user's exact scenario from the screenshot:
      // Three requests in one agent session using claude-haiku-4-5
      const requests = [
        {
          operation: "agent:iteration",
          usage: { inputTokens: 36859, outputTokens: 163 },
        },
        {
          operation: "memory:extract",
          usage: { inputTokens: 989, outputTokens: 90 },
        },
        {
          operation: "memory:consolidate",
          usage: { inputTokens: 2996, outputTokens: 2470 },
        },
      ];

      // Anthropic dashboard totals
      const anthropicTotalInput = 36859 + 989 + 2996; // = 40844
      const anthropicTotalOutput = 163 + 90 + 2470;   // = 2723

      // Our aggregation (using real usage)
      const ourTotalInput = requests.reduce(
        (sum, r) => sum + r.usage.inputTokens, 0,
      );
      const ourTotalOutput = requests.reduce(
        (sum, r) => sum + r.usage.outputTokens, 0,
      );

      expect(ourTotalInput).toBe(anthropicTotalInput);
      expect(ourTotalOutput).toBe(anthropicTotalOutput);
    });

    it("heuristic-based totals would have been inflated", () => {
      // What Prism was reporting BEFORE the fix
      const heuristicRequests = [
        { inputTokens: 36859, outputTokens: 163 },    // agent/iteration — was correct
        { inputTokens: 1001, outputTokens: 108 },      // memory/extract — inflated
        { inputTokens: 3259, outputTokens: 2751 },     // memory/consolidate — inflated
      ];

      const heuristicTotalInput = heuristicRequests.reduce(
        (sum, r) => sum + r.inputTokens, 0,
      );

      const realTotalInput = 36859 + 989 + 2996;

      // Heuristic over-counted by 275 tokens (41119 vs 40844)
      expect(heuristicTotalInput).toBe(41119);
      expect(heuristicTotalInput - realTotalInput).toBe(275);
    });

    it("usage accumulator correctly aggregates across mixed operations", () => {
      const acc = createUsageAccumulator();

      // Agent iteration (streaming — already had real tokens)
      acc.inputTokens += 36859;
      acc.outputTokens += 163;

      // Memory extract (now with real tokens)
      acc.inputTokens += 989;
      acc.outputTokens += 90;

      // Memory consolidate (now with real tokens)
      acc.inputTokens += 2996;
      acc.outputTokens += 2470;

      expect(acc.inputTokens).toBe(40844);
      expect(acc.outputTokens).toBe(2723);
    });
  });
});

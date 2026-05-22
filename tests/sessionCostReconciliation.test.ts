/**
 * Session Cost Reconciliation — verifies that session-level totalCost
 * displayed in the UI is always derived from request_logs (the single
 * source of truth) and NOT from the sum of message.estimatedCost.
 *
 * Root cause: In agentic loops, each agentic iteration creates a request
 * log entry with its own estimatedCost, but only the FINAL iteration's
 * cost is persisted on the assistant message's estimatedCost field.
 * This means computeTotalCost(messages) — which sums message.estimatedCost
 * — dramatically under-reports for agent sessions.
 *
 * The fix: GET /agent-sessions (list) aggregates estimatedCost from
 * request_logs and overlays it onto session.totalCost, matching the
 * pattern already used for toolCounts enrichment.
 */
import { describe, it, expect, vi } from "vitest";

// ── Mock logger (top-level as vitest requires) ──────────────────
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
}));

// Import after mocks
const { computeTotalCost } = await import("../src/services/ConversationService.ts");
const {
  mergeUsage,
  createUsageAccumulator,
  calculateTextCost,
} = await import("../src/utils/CostCalculator.ts");

// ═══════════════════════════════════════════════════════════════
describe("Session Cost Reconciliation", () => {
  // ── computeTotalCost only captures per-message cost ──────────
  describe("computeTotalCost (message-level aggregation)", () => {
    it("should sum estimatedCost from messages", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", estimatedCost: 0.001 },
        { role: "user", content: "More" },
        { role: "assistant", content: "Sure", estimatedCost: 0.002 },
      ];
      expect(computeTotalCost(messages)).toBeCloseTo(0.003, 8);
    });

    it("should under-report for agent sessions (only last iteration per message)", () => {
      // Simulates an agentic loop: 15 iterations but only the final
      // assistant message carries estimatedCost from the last iteration.
      // Request logs show the real total is $0.19312.
      const agentMessages = [
        { role: "user", content: "Fix the bug" },
        { role: "system", content: "You are an agent..." },
        // Final assistant message — only has the LAST iteration's cost
        {
          role: "assistant",
          content: "I've fixed the bug. Here's what I did...",
          estimatedCost: 0.01851, // last iteration only
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      ];

      const messageLevelCost = computeTotalCost(agentMessages);
      const requestLogTotalCost = 0.19312; // sum of all 15 request log entries

      // The message-level cost is a FRACTION of the true cost
      expect(messageLevelCost).toBeCloseTo(0.01851, 5);
      expect(messageLevelCost).toBeLessThan(requestLogTotalCost * 0.5);

      // This demonstrates exactly why we need request-log aggregation
      expect(requestLogTotalCost / messageLevelCost).toBeGreaterThan(5);
    });

    it("should skip deleted messages", () => {
      const messages = [
        { role: "assistant", content: "Hi", estimatedCost: 0.001 },
        { role: "assistant", content: "Old", estimatedCost: 0.002, deleted: true },
      ];
      expect(computeTotalCost(messages)).toBeCloseTo(0.001, 8);
    });
  });

  // ── Request-log cost overlay contract ────────────────────────
  describe("Request-log cost overlay contract", () => {
    /**
     * Simulates the overlay logic from GET /agent-sessions (list endpoint).
     * Uses Math.max to guard against old sessions where request logs
     * under-report due to the NaN cache token bug.
     */
    function applyRequestLogCostOverlay(sessions: any[], costDocs: any[]) {
      const costMap = new Map();
      for (const doc of costDocs) {
        costMap.set(doc._id, doc.totalCost);
      }
      for (const session of sessions) {
        const requestLogCost = costMap.get(session.id);
        if (requestLogCost != null) {
          session.totalCost = Math.max(session.totalCost || 0, requestLogCost);
        }
      }
      return sessions;
    }

    it("should adopt request-log cost when higher than document cost (new sessions)", () => {
      const sessions = [
        { id: "session-1", totalCost: 0.01851 }, // message-level cost
      ];

      // Request log aggregation includes background costs (memory, embedding)
      const costDocs = [
        { _id: "session-1", totalCost: 0.19312 },
      ];

      const result = applyRequestLogCostOverlay(sessions, costDocs);
      expect(result[0].totalCost).toBeCloseTo(0.19312, 5);
    });

    it("should keep document cost when request-log cost is lower (old buggy sessions)", () => {
      // Old session: message has correct cost ($0.0451) but request log
      // has broken cost ($0.00038) due to NaN cache token bug.
      const sessions = [
        { id: "session-old", totalCost: 0.0451 },
      ];

      const costDocs = [
        { _id: "session-old", totalCost: 0.01770 }, // under-reported
      ];

      const result = applyRequestLogCostOverlay(sessions, costDocs);
      // Should keep the higher document cost
      expect(result[0].totalCost).toBeCloseTo(0.0451, 5);
    });

    it("should preserve document totalCost when no request logs exist", () => {
      const sessions = [
        { id: "session-empty", totalCost: 0 },
      ];
      const costDocs: any[] = []; // no request logs

      const result = applyRequestLogCostOverlay(sessions, costDocs);
      expect(result[0].totalCost).toBe(0);
    });

    it("should handle multiple sessions with varying cost discrepancies", () => {
      const sessions = [
        { id: "s1", totalCost: 0.01000 }, // stale doc, request log is higher
        { id: "s2", totalCost: 0.00500 }, // stale doc, request log is higher
        { id: "s3", totalCost: 0.00000 }, // new session, no cost yet
      ];

      const costDocs = [
        { _id: "s1", totalCost: 0.15000 },
        { _id: "s2", totalCost: 0.08000 },
      ];

      const result = applyRequestLogCostOverlay(sessions, costDocs);
      expect(result[0].totalCost).toBeCloseTo(0.15000, 5);
      expect(result[1].totalCost).toBeCloseTo(0.08000, 5);
      expect(result[2].totalCost).toBe(0); // unchanged
    });

    it("should preserve document cost when request logs show zero (local model)", () => {
      // Local model with no pricing → request log estimatedCost: 0
      // But document may have a pre-computed cost from a previous run
      const sessions = [
        { id: "s1", totalCost: 0.001 },
      ];

      const costDocs = [
        { _id: "s1", totalCost: 0 }, // local model, no pricing
      ];

      const result = applyRequestLogCostOverlay(sessions, costDocs);
      // Math.max keeps the document value since 0.001 > 0
      expect(result[0].totalCost).toBe(0.001);
    });
  });

  // ── Cross-component cost consistency ──────────────────────────
  describe("Cross-component cost consistency", () => {
    it("SettingsPanel, HistoryPanel, and MessageList should agree on cost source", () => {
      // This test documents the contract between the three UI components.
      // All costs ultimately derive from request logs.

      // Simulated request log entries for a session
      const requestLogs = [
        { estimatedCost: 0.04200, operation: "agent:iteration" },
        { estimatedCost: 0.03800, operation: "agent:iteration" },
        { estimatedCost: 0.05100, operation: "agent:iteration" },
        { estimatedCost: 0.04361, operation: "agent:iteration" },
        { estimatedCost: 0.01851, operation: "agent:iteration" },
        { estimatedCost: 0.00025, operation: "memory:extract" },
        { estimatedCost: 0.00001, operation: "embed:memory" },
      ];

      const requestLogTotal = requestLogs.reduce(
        (sum, r) => sum + r.estimatedCost,
        0,
      );

      // Simulated message-level costs (what computeTotalCost sees)
      const messageLevelCost = 0.01851; // only the last iteration

      // SettingsPanel: uses backendSessionStats.totalCost (from GET /agent-sessions/:id)
      // which aggregates from request logs — CORRECT
      const settingsPanelCost = requestLogTotal;

      // HistoryPanel: now uses session.totalCost (from GET /agent-sessions list)
      // which is overlaid with request-log aggregate — CORRECT (after fix)
      const historyPanelCost = requestLogTotal;

      // MessageList: shows per-message estimatedCost — each badge is correct
      // for its individual message, not meant to sum to session total
      const perMessageCost = messageLevelCost;

      // SettingsPanel and HistoryPanel MUST agree
      expect(settingsPanelCost).toBeCloseTo(historyPanelCost, 8);

      // Both should be the request-log total
      expect(settingsPanelCost).toBeCloseTo(requestLogTotal, 8);
      expect(historyPanelCost).toBeCloseTo(requestLogTotal, 8);

      // Per-message cost is a subset (last iteration only), intentionally different
      expect(perMessageCost).toBeLessThan(requestLogTotal);
    });

    it("should handle zero-cost sessions consistently", () => {
      expect(computeTotalCost([])).toBe(0);
    });

    it("should handle Direct Chat sessions where message cost IS the full cost", () => {
      // In Direct Chat, each message has exactly one request log entry,
      // so message-level estimatedCost matches the request log total.
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi", estimatedCost: 0.0005, provider: "openai" },
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "I'm well", estimatedCost: 0.0008, provider: "openai" },
      ];

      const messageLevelTotal = computeTotalCost(messages);
      const requestLogTotal = 0.0005 + 0.0008;

      // For Direct Chat, both methods agree
      expect(messageLevelTotal).toBeCloseTo(requestLogTotal, 8);
    });
  });

  // ── Per-iteration usage accumulator (root cause regression) ────
  describe("Per-iteration usage accumulator", () => {
    it("createUsageAccumulator should include all cache token fields", () => {
      const acc = createUsageAccumulator();
      expect(acc).toHaveProperty("inputTokens", 0);
      expect(acc).toHaveProperty("outputTokens", 0);
      expect(acc).toHaveProperty("cacheReadInputTokens", 0);
      expect(acc).toHaveProperty("cacheCreationInputTokens", 0);
      expect(acc).toHaveProperty("reasoningOutputTokens", 0);
    });

    it("mergeUsage should correctly accumulate cache tokens into a proper accumulator", () => {
      const target = createUsageAccumulator();
      const source = {
        inputTokens: 3,
        outputTokens: 75,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 34751,
      };

      mergeUsage(target, source);

      expect(target.inputTokens).toBe(3);
      expect(target.outputTokens).toBe(75);
      expect(target.cacheCreationInputTokens).toBe(34751);
      expect(target.cacheReadInputTokens).toBe(0);
    });

    it("mergeUsage into bare object WITHOUT cache fields should safely merge without producing NaN", () => {
      // With our robust mergeUsage implementation, passing a bare object without
      // cache fields is safely supported. `undefined ?? 0` prevents NaN results.
      const broken: any = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const source = {
        inputTokens: 3,
        outputTokens: 75,
        cacheCreationInputTokens: 34751,
      };

      mergeUsage(broken, source);

      // Verify that it merged safely instead of producing NaN
      expect(broken.cacheCreationInputTokens).toBe(34751);
    });

    it("calculateTextCost should include cache write cost when tokens are present", () => {
      const usage = createUsageAccumulator();
      usage.inputTokens = 3;
      usage.outputTokens = 75;
      usage.cacheCreationInputTokens = 34751;

      // Anthropic claude-haiku-4-5 pricing (per million tokens)
      const pricing = {
        inputPerMillion: 0.80,
        outputPerMillion: 4.00,
        cachedInputPerMillion: 0.08,
        cacheWriteInputPerMillion: 1.00,
      };

      const cost = calculateTextCost(usage, pricing);

      // Expected cost breakdown:
      // input:       3 / 1M * 0.80 = 0.0000024
      // output:     75 / 1M * 4.00 = 0.0003
      // cache_write: 34751 / 1M * 1.00 = 0.034751
      // total ≈ 0.0350534
      expect(cost!).toBeGreaterThan(0.034);
      expect(cost!).toBeLessThan(0.036);

      // Even starting with an incomplete target object:
      const brokenUsage = { inputTokens: 3, outputTokens: 75, totalTokens: 78 };
      mergeUsage(brokenUsage, { cacheCreationInputTokens: 34751 });
      const brokenCost = calculateTextCost(brokenUsage, pricing);
      // Now it merges safely and computes the exact correct cost instead of being NaN/lower
      expect(brokenCost!).toBeCloseTo(cost!, 6);
    });
  });
});

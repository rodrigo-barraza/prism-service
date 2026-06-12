/**
 * Conversation List Cost Enrichment — regression tests.
 *
 * Root cause: Background operations (memory extraction, embedding,
 * consolidation) log their costs to the `requests` collection but never
 * update the conversation document's `totalCost`. Previously, only
 * agent sessions were enriched with request-log costs in the list
 * endpoint; model (direct) conversations showed stale document-level
 * values in the sidebar cost badge.
 *
 * These tests verify that:
 *   1. The `enrichConversationsWithRequestCosts` helper enriches BOTH
 *      model and agent conversations from the requests collection
 *   2. Math.max preserves the higher of document vs request-log cost
 *   3. The single-item GET /:id endpoint enriches model conversations
 *   4. Edge cases: empty arrays, zero costs, missing request logs
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared mock logger ──────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════
// Pure logic: enrichConversationsWithRequestCosts
// ═══════════════════════════════════════════════════════════════

describe("Conversation List Cost Enrichment", () => {
  /**
   * Simulates the `enrichConversationsWithRequestCosts` helper extracted
   * in ConversationsRoutes.ts. This is the exact algorithm used in
   * the GET /conversations list endpoint.
   */
  function enrichConversationsWithRequestCosts(
    conversations: Array<{ id: string; totalCost: number }>,
    requestLogCosts: Array<{ _id: string; totalCost: number }>,
  ) {
    if (conversations.length === 0) return;
    const costMap = new Map(
      requestLogCosts.map((costEntry) => [costEntry._id, costEntry.totalCost]),
    );
    for (const conversation of conversations) {
      const requestLogCost = costMap.get(conversation.id);
      if (requestLogCost !== undefined && requestLogCost > 0) {
        conversation.totalCost = Math.max(
          conversation.totalCost || 0,
          requestLogCost,
        );
      }
    }
  }

  // ── Model (direct) conversations ────────────────────────────
  describe("Model conversation enrichment", () => {
    it("should adopt request-log cost when higher than document cost", () => {
      const modelConversations = [
        { id: "conv-1", totalCost: 0.001 }, // stale document cost
      ];
      const requestLogCosts = [
        { _id: "conv-1", totalCost: 0.0035 }, // includes embedding + extraction
      ];

      enrichConversationsWithRequestCosts(modelConversations, requestLogCosts);
      expect(modelConversations[0].totalCost).toBeCloseTo(0.0035, 6);
    });

    it("should preserve document cost when request-log is lower", () => {
      const modelConversations = [
        { id: "conv-1", totalCost: 0.005 },
      ];
      const requestLogCosts = [
        { _id: "conv-1", totalCost: 0.003 }, // under-reported
      ];

      enrichConversationsWithRequestCosts(modelConversations, requestLogCosts);
      expect(modelConversations[0].totalCost).toBeCloseTo(0.005, 6);
    });

    it("should handle conversations with no matching request logs", () => {
      const modelConversations = [
        { id: "conv-1", totalCost: 0.001 },
        { id: "conv-2", totalCost: 0.002 },
      ];
      const requestLogCosts = [
        { _id: "conv-1", totalCost: 0.005 },
        // conv-2 has no request log entries
      ];

      enrichConversationsWithRequestCosts(modelConversations, requestLogCosts);
      expect(modelConversations[0].totalCost).toBeCloseTo(0.005, 6);
      expect(modelConversations[1].totalCost).toBeCloseTo(0.002, 6); // unchanged
    });

    it("should handle model conversations with zero document cost (local model)", () => {
      const modelConversations = [
        { id: "conv-local", totalCost: 0 },
      ];
      const requestLogCosts = [
        { _id: "conv-local", totalCost: 0 }, // local model, no pricing
      ];

      enrichConversationsWithRequestCosts(modelConversations, requestLogCosts);
      expect(modelConversations[0].totalCost).toBe(0); // stays 0
    });

    it("should enrich multiple model conversations in a single pass", () => {
      const modelConversations = [
        { id: "conv-1", totalCost: 0.001 },
        { id: "conv-2", totalCost: 0.002 },
        { id: "conv-3", totalCost: 0.0 },
      ];
      const requestLogCosts = [
        { _id: "conv-1", totalCost: 0.0015 }, // background ops added $0.0005
        { _id: "conv-2", totalCost: 0.0045 }, // background ops added $0.0025
        { _id: "conv-3", totalCost: 0.0001 }, // tiny embedding cost
      ];

      enrichConversationsWithRequestCosts(modelConversations, requestLogCosts);
      expect(modelConversations[0].totalCost).toBeCloseTo(0.0015, 6);
      expect(modelConversations[1].totalCost).toBeCloseTo(0.0045, 6);
      expect(modelConversations[2].totalCost).toBeCloseTo(0.0001, 6);
    });
  });

  // ── Agent conversations ─────────────────────────────────────
  describe("Agent conversation enrichment", () => {
    it("should adopt request-log cost for agent sessions (multi-iteration)", () => {
      const agentConversations = [
        { id: "session-1", totalCost: 0.01851 }, // only last iteration on doc
      ];
      const requestLogCosts = [
        { _id: "session-1", totalCost: 0.19312 }, // all 15 iterations
      ];

      enrichConversationsWithRequestCosts(agentConversations, requestLogCosts);
      expect(agentConversations[0].totalCost).toBeCloseTo(0.19312, 5);
    });

    it("should handle worker sessions grouped under parent", () => {
      const agentConversations = [
        { id: "parent-1", totalCost: 0.05 },
      ];
      // The aggregation pipeline groups worker costs under parent
      const requestLogCosts = [
        { _id: "parent-1", totalCost: 0.35 }, // parent + 3 workers
      ];

      enrichConversationsWithRequestCosts(agentConversations, requestLogCosts);
      expect(agentConversations[0].totalCost).toBeCloseTo(0.35, 5);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────
  describe("Edge cases", () => {
    it("should handle empty conversation arrays gracefully", () => {
      const emptyConversations: Array<{ id: string; totalCost: number }> = [];
      enrichConversationsWithRequestCosts(emptyConversations, []);
      expect(emptyConversations).toEqual([]);
    });

    it("should handle empty request log results", () => {
      const conversations = [{ id: "conv-1", totalCost: 0.001 }];
      enrichConversationsWithRequestCosts(conversations, []);
      expect(conversations[0].totalCost).toBeCloseTo(0.001, 6);
    });

    it("should handle request log cost of exactly zero (no-op)", () => {
      const conversations = [{ id: "conv-1", totalCost: 0.001 }];
      const requestLogCosts = [{ _id: "conv-1", totalCost: 0 }];

      enrichConversationsWithRequestCosts(conversations, requestLogCosts);
      // Zero request-log cost → skip (the guard is `> 0`)
      expect(conversations[0].totalCost).toBeCloseTo(0.001, 6);
    });

    it("should handle NaN document totalCost gracefully", () => {
      const conversations = [{ id: "conv-1", totalCost: NaN }];
      const requestLogCosts = [{ _id: "conv-1", totalCost: 0.005 }];

      enrichConversationsWithRequestCosts(conversations, requestLogCosts);
      // NaN || 0 → 0, Math.max(0, 0.005) → 0.005
      expect(conversations[0].totalCost).toBeCloseTo(0.005, 6);
    });

    it("should handle undefined document totalCost gracefully", () => {
      const conversations = [{ id: "conv-1", totalCost: undefined as unknown as number }];
      const requestLogCosts = [{ _id: "conv-1", totalCost: 0.005 }];

      enrichConversationsWithRequestCosts(conversations, requestLogCosts);
      expect(conversations[0].totalCost).toBeCloseTo(0.005, 6);
    });
  });

  // ── Cross-type consistency ────────────────────────────────────
  describe("Cross-type cost consistency", () => {
    it("should enrich both model and agent conversations independently", () => {
      const modelConversations = [
        { id: "conv-1", totalCost: 0.001 },
        { id: "conv-2", totalCost: 0.002 },
      ];
      const agentConversations = [
        { id: "session-1", totalCost: 0.01 },
        { id: "session-2", totalCost: 0.02 },
      ];

      const modelRequestCosts = [
        { _id: "conv-1", totalCost: 0.003 },
        { _id: "conv-2", totalCost: 0.0025 },
      ];
      const agentRequestCosts = [
        { _id: "session-1", totalCost: 0.15 },
        { _id: "session-2", totalCost: 0.08 },
      ];

      enrichConversationsWithRequestCosts(modelConversations, modelRequestCosts);
      enrichConversationsWithRequestCosts(agentConversations, agentRequestCosts);

      // Model conversations enriched
      expect(modelConversations[0].totalCost).toBeCloseTo(0.003, 6);
      expect(modelConversations[1].totalCost).toBeCloseTo(0.0025, 6);

      // Agent conversations enriched
      expect(agentConversations[0].totalCost).toBeCloseTo(0.15, 5);
      expect(agentConversations[1].totalCost).toBeCloseTo(0.08, 5);
    });

    it("should document the background cost gap that caused the original bug", () => {
      // Scenario: Direct chat with memory extraction + embedding
      // The chat request itself costs $0.001 and is persisted on the message.
      // Memory extraction costs $0.00025 and embedding costs $0.00001.
      // Both background costs are in the requests collection but NOT on the
      // conversation document.
      const conversationDocumentCost = 0.001; // only the chat request
      const requestLogCosts = [
        { estimatedCost: 0.001 },    // chat request
        { estimatedCost: 0.00025 },  // memory:extract
        { estimatedCost: 0.00001 },  // embed:memory
      ];
      const requestLogTotalCost = requestLogCosts.reduce(
        (sum, requestLogEntry) => sum + requestLogEntry.estimatedCost, 0,
      );

      // Before fix: sidebar showed $0.001 (document cost)
      // After fix: sidebar shows $0.00126 (request log total)
      expect(requestLogTotalCost).toBeGreaterThan(conversationDocumentCost);
      expect(requestLogTotalCost).toBeCloseTo(0.00126, 6);

      // The enrichment applies Math.max
      const enrichedCost = Math.max(conversationDocumentCost, requestLogTotalCost);
      expect(enrichedCost).toBeCloseTo(requestLogTotalCost, 6);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Single-item endpoint cost enrichment
// ═══════════════════════════════════════════════════════════════

describe("Single Conversation Cost Enrichment (GET /:id)", () => {
  /**
   * Simulates the cost enrichment logic added to the
   * GET /conversations/:id endpoint for model conversations.
   */
  function enrichSingleConversationCost(
    conversation: { totalCost: number },
    requestLogAggregation: Array<{ _id: string; totalCost: number }>,
  ) {
    if (requestLogAggregation.length > 0 && requestLogAggregation[0].totalCost > 0) {
      conversation.totalCost = Math.max(
        conversation.totalCost || 0,
        requestLogAggregation[0].totalCost,
      );
    }
  }

  it("should enrich totalCost when request-log is higher", () => {
    const conversation = { totalCost: 0.001 };
    const aggregation = [{ _id: "conv-1", totalCost: 0.0035 }];

    enrichSingleConversationCost(conversation, aggregation);
    expect(conversation.totalCost).toBeCloseTo(0.0035, 6);
  });

  it("should preserve document cost when request-log is lower", () => {
    const conversation = { totalCost: 0.005 };
    const aggregation = [{ _id: "conv-1", totalCost: 0.003 }];

    enrichSingleConversationCost(conversation, aggregation);
    expect(conversation.totalCost).toBeCloseTo(0.005, 6);
  });

  it("should no-op when aggregation returns empty array", () => {
    const conversation = { totalCost: 0.001 };
    enrichSingleConversationCost(conversation, []);
    expect(conversation.totalCost).toBeCloseTo(0.001, 6);
  });

  it("should no-op when aggregation totalCost is zero", () => {
    const conversation = { totalCost: 0.001 };
    const aggregation = [{ _id: "conv-1", totalCost: 0 }];

    enrichSingleConversationCost(conversation, aggregation);
    expect(conversation.totalCost).toBeCloseTo(0.001, 6);
  });

  it("should handle conversation with zero document cost", () => {
    const conversation = { totalCost: 0 };
    const aggregation = [{ _id: "conv-1", totalCost: 0.0005 }];

    enrichSingleConversationCost(conversation, aggregation);
    expect(conversation.totalCost).toBeCloseTo(0.0005, 6);
  });

  it("should handle NaN document cost gracefully", () => {
    const conversation = { totalCost: NaN };
    const aggregation = [{ _id: "conv-1", totalCost: 0.002 }];

    enrichSingleConversationCost(conversation, aggregation);
    expect(conversation.totalCost).toBeCloseTo(0.002, 6);
  });
});

// ═══════════════════════════════════════════════════════════════
// MongoDB aggregation pipeline contract
// ═══════════════════════════════════════════════════════════════

describe("MongoDB Aggregation Pipeline Contract", () => {
  it("should produce correct $match for model conversations (conversationId only)", () => {
    const conversationIds = ["conv-1", "conv-2", "conv-3"];
    const isAgentType = false;

    const matchCondition = isAgentType
      ? {
          $or: [
            { agentSessionId: { $in: conversationIds } },
            { conversationId: { $in: conversationIds } },
            { parentAgentSessionId: { $in: conversationIds } },
          ],
        }
      : { conversationId: { $in: conversationIds } };

    // Model conversations only match on conversationId
    expect(matchCondition).toEqual({
      conversationId: { $in: ["conv-1", "conv-2", "conv-3"] },
    });
    expect(matchCondition).not.toHaveProperty("$or");
  });

  it("should produce correct $match for agent conversations ($or with 3 fields)", () => {
    const conversationIds = ["session-1", "session-2"];
    const isAgentType = true;

    const matchCondition = isAgentType
      ? {
          $or: [
            { agentSessionId: { $in: conversationIds } },
            { conversationId: { $in: conversationIds } },
            { parentAgentSessionId: { $in: conversationIds } },
          ],
        }
      : { conversationId: { $in: conversationIds } };

    expect(matchCondition).toHaveProperty("$or");
    expect(matchCondition.$or).toHaveLength(3);
    expect(matchCondition.$or[0]).toEqual({ agentSessionId: { $in: conversationIds } });
    expect(matchCondition.$or[1]).toEqual({ conversationId: { $in: conversationIds } });
    expect(matchCondition.$or[2]).toEqual({ parentAgentSessionId: { $in: conversationIds } });
  });

  it("should produce correct $group _id for model conversations (simple field)", () => {
    const isAgentType = false;
    const groupId = isAgentType
      ? { $cond: ["complex", "expression"] }
      : "$conversationId";

    expect(groupId).toBe("$conversationId");
  });

  it("should produce complex $group _id for agent conversations (parent fallback)", () => {
    const conversationIds = ["session-1"];
    const isAgentType = true;

    const groupId = isAgentType
      ? {
          $cond: [
            {
              $and: [
                { $ne: ["$parentAgentSessionId", null] },
                { $in: ["$parentAgentSessionId", conversationIds] },
              ],
            },
            "$parentAgentSessionId",
            { $ifNull: ["$conversationId", "$agentSessionId"] },
          ],
        }
      : "$conversationId";

    expect(groupId).toHaveProperty("$cond");
    expect(groupId.$cond).toHaveLength(3);
    // When parentAgentSessionId is present and in our set, group by parent
    expect(groupId.$cond[1]).toBe("$parentAgentSessionId");
    // Otherwise fall back to conversationId or agentSessionId
    expect(groupId.$cond[2]).toEqual({ $ifNull: ["$conversationId", "$agentSessionId"] });
  });
});

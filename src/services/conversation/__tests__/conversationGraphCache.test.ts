/**
 * ConversationGraphCache — Unit Tests
 *
 * Adversarial test suite verifying the in-memory TTL graph cache:
 * cache hits, TTL expiration, composite key generation, eviction
 * under capacity pressure, and per-conversation invalidation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildGraphCacheKey,
  getGraphFromCache,
  setGraphInCache,
  invalidateGraphCacheForConversation,
  clearGraphCache,
  getGraphCacheSize,
  GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS,
} from "#src/services/conversation/ConversationGraphCache";
import type { GraphData } from "@rodrigo-barraza/utilities-library/graph";

// ── Test Fixtures ──────────────────────────────────────────────────

function createMockGraphData(nodeCount = 3): GraphData {
  return {
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      category: "request" as const,
      radius: 24,
      x: index * 100,
      y: index * 50,
      velocityX: 0,
      velocityY: 0,
      sequenceNumber: index + 1,
    })),
    edges: nodeCount > 1
      ? Array.from({ length: nodeCount - 1 }, (_, index) => ({
          source: `node-${index}`,
          target: `node-${index + 1}`,
          strength: 0.5,
        }))
      : [],
    subAgentTree: [],
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ConversationGraphCache", () => {
  beforeEach(() => {
    clearGraphCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearGraphCache();
  });

  describe("buildGraphCacheKey", () => {
    it("should produce distinct keys for different conversation IDs", () => {
      const keyAlpha = buildGraphCacheKey("conv-a", 5, 1600, 900);
      const keyBeta = buildGraphCacheKey("conv-b", 5, 1600, 900);
      expect(keyAlpha).not.toBe(keyBeta);
    });

    it("should produce distinct keys for different request counts", () => {
      const keyFive = buildGraphCacheKey("conv-a", 5, 1600, 900);
      const keySix = buildGraphCacheKey("conv-a", 6, 1600, 900);
      expect(keyFive).not.toBe(keySix);
    });

    it("should produce distinct keys for different canvas dimensions", () => {
      const keySmall = buildGraphCacheKey("conv-a", 5, 800, 600);
      const keyLarge = buildGraphCacheKey("conv-a", 5, 1600, 900);
      expect(keySmall).not.toBe(keyLarge);
    });

    it("should produce identical keys for identical parameters", () => {
      const keyFirst = buildGraphCacheKey("conv-a", 5, 1600, 900);
      const keySecond = buildGraphCacheKey("conv-a", 5, 1600, 900);
      expect(keyFirst).toBe(keySecond);
    });

    it("should include all parameters in the key string", () => {
      const key = buildGraphCacheKey("conv-abc", 42, 1920, 1080);
      expect(key).toContain("conv-abc");
      expect(key).toContain("42");
      expect(key).toContain("1920");
      expect(key).toContain("1080");
    });
  });

  describe("Cache hit / miss", () => {
    it("should return null for a key that was never cached", () => {
      const result = getGraphFromCache("nonexistent-key");
      expect(result).toBeNull();
    });

    it("should return cached data for a key that was recently stored", () => {
      const key = buildGraphCacheKey("conv-a", 5, 1600, 900);
      const graphData = createMockGraphData(4);

      setGraphInCache(key, graphData);
      const result = getGraphFromCache(key);

      expect(result).not.toBeNull();
      expect(result!.nodes).toHaveLength(4);
      expect(result!.edges).toHaveLength(3);
    });

    it("should return the exact same object reference (no deep clone)", () => {
      const key = buildGraphCacheKey("conv-a", 5, 1600, 900);
      const graphData = createMockGraphData();

      setGraphInCache(key, graphData);
      const result = getGraphFromCache(key);

      expect(result).toBe(graphData);
    });
  });

  describe("TTL expiration", () => {
    it("should return cached data within the TTL window", () => {
      const key = buildGraphCacheKey("conv-a", 5, 1600, 900);
      setGraphInCache(key, createMockGraphData());

      vi.advanceTimersByTime(GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS - 50);
      expect(getGraphFromCache(key)).not.toBeNull();
    });

    it("should return null after the TTL window expires", () => {
      const key = buildGraphCacheKey("conv-a", 5, 1600, 900);
      setGraphInCache(key, createMockGraphData());

      vi.advanceTimersByTime(GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS + 1);
      expect(getGraphFromCache(key)).toBeNull();
    });

    it("should evict the expired entry from the map on miss", () => {
      const key = buildGraphCacheKey("conv-a", 5, 1600, 900);
      setGraphInCache(key, createMockGraphData());
      expect(getGraphCacheSize()).toBe(1);

      vi.advanceTimersByTime(GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS + 1);
      getGraphFromCache(key);

      expect(getGraphCacheSize()).toBe(0);
    });

    it("should have a TTL of 500ms", () => {
      expect(GRAPH_CACHE_TIME_TO_LIVE_MILLISECONDS).toBe(500);
    });
  });

  describe("Natural invalidation via request count", () => {
    it("should miss when request count increases (new requests arrived)", () => {
      const initialKey = buildGraphCacheKey("conv-a", 5, 1600, 900);
      setGraphInCache(initialKey, createMockGraphData());

      // New request arrives → count goes from 5 → 6 → different key → miss
      const updatedKey = buildGraphCacheKey("conv-a", 6, 1600, 900);
      expect(getGraphFromCache(updatedKey)).toBeNull();
    });

    it("should still hit on the old key until TTL expires", () => {
      const staleKey = buildGraphCacheKey("conv-a", 5, 1600, 900);
      setGraphInCache(staleKey, createMockGraphData());

      // Even after a new key is used, the old entry persists until TTL
      expect(getGraphFromCache(staleKey)).not.toBeNull();
    });
  });

  describe("Eviction under capacity pressure", () => {
    it("should evict the oldest entry when exceeding 100 entries", () => {
      // Fill cache to capacity
      for (let index = 0; index < 100; index++) {
        const key = buildGraphCacheKey(`conv-${index}`, 1, 1600, 900);
        setGraphInCache(key, createMockGraphData());
        vi.advanceTimersByTime(1); // Ensure distinct timestamps
      }

      expect(getGraphCacheSize()).toBe(100);

      // Adding one more should evict the oldest (conv-0)
      const overflowKey = buildGraphCacheKey("conv-overflow", 1, 1600, 900);
      setGraphInCache(overflowKey, createMockGraphData());

      expect(getGraphCacheSize()).toBe(100);
      expect(getGraphFromCache(buildGraphCacheKey("conv-0", 1, 1600, 900))).toBeNull();
      expect(getGraphFromCache(overflowKey)).not.toBeNull();
    });
  });

  describe("invalidateGraphCacheForConversation", () => {
    it("should remove all entries for the specified conversation", () => {
      setGraphInCache(buildGraphCacheKey("conv-a", 1, 1600, 900), createMockGraphData());
      setGraphInCache(buildGraphCacheKey("conv-a", 2, 1600, 900), createMockGraphData());
      setGraphInCache(buildGraphCacheKey("conv-a", 3, 800, 600), createMockGraphData());
      setGraphInCache(buildGraphCacheKey("conv-b", 1, 1600, 900), createMockGraphData());

      expect(getGraphCacheSize()).toBe(4);

      invalidateGraphCacheForConversation("conv-a");

      expect(getGraphCacheSize()).toBe(1);
      expect(getGraphFromCache(buildGraphCacheKey("conv-a", 1, 1600, 900))).toBeNull();
      expect(getGraphFromCache(buildGraphCacheKey("conv-b", 1, 1600, 900))).not.toBeNull();
    });

    it("should not affect entries for other conversations", () => {
      setGraphInCache(buildGraphCacheKey("conv-x", 5, 1600, 900), createMockGraphData());
      setGraphInCache(buildGraphCacheKey("conv-y", 5, 1600, 900), createMockGraphData());

      invalidateGraphCacheForConversation("conv-x");

      expect(getGraphFromCache(buildGraphCacheKey("conv-y", 5, 1600, 900))).not.toBeNull();
    });
  });

  describe("clearGraphCache", () => {
    it("should remove all entries from the cache", () => {
      for (let index = 0; index < 10; index++) {
        setGraphInCache(buildGraphCacheKey(`conv-${index}`, 1, 1600, 900), createMockGraphData());
      }

      expect(getGraphCacheSize()).toBe(10);
      clearGraphCache();
      expect(getGraphCacheSize()).toBe(0);
    });
  });

  describe("Concurrent access patterns", () => {
    it("should handle overwriting the same key within TTL", () => {
      const key = buildGraphCacheKey("conv-a", 5, 1600, 900);
      const firstGraph = createMockGraphData(3);
      const secondGraph = createMockGraphData(7);

      setGraphInCache(key, firstGraph);
      setGraphInCache(key, secondGraph);

      const result = getGraphFromCache(key);
      expect(result).toBe(secondGraph);
      expect(result!.nodes).toHaveLength(7);
      expect(getGraphCacheSize()).toBe(1);
    });

    it("should handle rapid set-get cycles without corruption", () => {
      for (let cycle = 0; cycle < 50; cycle++) {
        const key = buildGraphCacheKey("conv-rapid", cycle, 1600, 900);
        const graph = createMockGraphData(cycle + 1);
        setGraphInCache(key, graph);

        const result = getGraphFromCache(key);
        expect(result).toBe(graph);
        expect(result!.nodes).toHaveLength(cycle + 1);
      }
    });
  });
});

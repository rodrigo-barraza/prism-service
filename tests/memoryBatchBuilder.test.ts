import { describe, it, expect, vi } from 'vitest';

vi.mock('@rodrigo-barraza/utilities-library', () => ({
  daysSinceIso: (isoDate: string) => {
    const millisecondsPerDay = 1000 * 60 * 60 * 24;
    return Math.floor(
      (Date.now() - new Date(isoDate).getTime()) / millisecondsPerDay,
    );
  },
}));

vi.mock('../src/utils/CostCalculator.ts', () => ({
  estimateTokens: (text: string) => Math.ceil((text || '').length / 4),
}));

import {
  buildBatches,
  BATCH_MAX_CLUSTERS,
  BATCH_MAX_STALE,
  BATCH_INPUT_TOKEN_BUDGET,
} from '../src/services/memory/BatchBuilder.ts';
import type { MemoryDoc } from '../src/services/memory/types.ts';

function createMemory(id: string, overrides: Partial<MemoryDoc> = {}): MemoryDoc {
  return {
    id,
    type: 'user',
    content: `Memory content for ${id}`,
    createdAt: new Date().toISOString(),
    title: `Title ${id}`,
    ...overrides,
  };
}

describe('BatchBuilder', () => {
  describe('constants', () => {
    it('BATCH_MAX_CLUSTERS is 5', () => {
      expect(BATCH_MAX_CLUSTERS).toBe(5);
    });

    it('BATCH_MAX_STALE is 10', () => {
      expect(BATCH_MAX_STALE).toBe(10);
    });

    it('BATCH_INPUT_TOKEN_BUDGET is 12000', () => {
      expect(BATCH_INPUT_TOKEN_BUDGET).toBe(12000);
    });
  });

  describe('buildBatches', () => {
    it('returns empty array for empty inputs', () => {
      expect(buildBatches([], [])).toEqual([]);
    });

    it('creates a single batch for one small cluster', () => {
      const clusters = [[createMemory('1'), createMemory('2')]];
      const batches = buildBatches(clusters, []);
      expect(batches).toHaveLength(1);
      expect(batches[0].clusters).toHaveLength(1);
      expect(batches[0].stale).toHaveLength(0);
    });

    it('splits clusters across batches when exceeding BATCH_MAX_CLUSTERS', () => {
      const clusters = Array.from({ length: 7 }, (_, index) => [
        createMemory(`cluster${index}-a`),
        createMemory(`cluster${index}-b`),
      ]);
      const batches = buildBatches(clusters, []);
      expect(batches.length).toBeGreaterThanOrEqual(2);
      expect(batches[0].clusters.length).toBeLessThanOrEqual(BATCH_MAX_CLUSTERS);
    });

    it('attaches stale memories to cluster batches', () => {
      const clusters = [[createMemory('1'), createMemory('2')]];
      const staleMemories = [
        createMemory('stale-1'),
        createMemory('stale-2'),
      ];
      const batches = buildBatches(clusters, staleMemories);
      expect(batches).toHaveLength(1);
      expect(batches[0].clusters).toHaveLength(1);
      expect(batches[0].stale).toHaveLength(2);
    });

    it('creates stale-only batches for leftover stale memories', () => {
      const staleMemories = Array.from({ length: 3 }, (_, index) =>
        createMemory(`stale-${index}`),
      );
      const batches = buildBatches([], staleMemories);
      expect(batches).toHaveLength(1);
      expect(batches[0].clusters).toHaveLength(0);
      expect(batches[0].stale).toHaveLength(3);
    });

    it('handles only stale memories with no clusters', () => {
      const staleMemories = [createMemory('stale-1')];
      const batches = buildBatches([], staleMemories);
      expect(batches).toHaveLength(1);
      expect(batches[0].clusters).toEqual([]);
      expect(batches[0].stale).toHaveLength(1);
    });

    it('handles large number of stale memories split into batches', () => {
      const staleMemories = Array.from({ length: 25 }, (_, index) =>
        createMemory(`stale-${index}`),
      );
      const batches = buildBatches([], staleMemories);
      expect(batches.length).toBeGreaterThanOrEqual(2);
      for (const batch of batches) {
        expect(batch.stale.length).toBeLessThanOrEqual(BATCH_MAX_STALE);
      }
    });

    it('respects token budget overflow by creating new batches', () => {
      const longContent = 'x'.repeat(50000);
      const clusters = [
        [
          createMemory('big-1', { content: longContent }),
          createMemory('big-2', { content: longContent }),
        ],
        [createMemory('small-1'), createMemory('small-2')],
      ];
      const batches = buildBatches(clusters, []);
      expect(batches.length).toBeGreaterThanOrEqual(1);
      const totalClusters = batches.reduce(
        (sum, batch) => sum + batch.clusters.length,
        0,
      );
      expect(totalClusters).toBe(2);
    });
  });
});

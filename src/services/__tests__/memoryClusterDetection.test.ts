import { describe, it, expect, vi } from 'vitest';

vi.mock('@rodrigo-barraza/utilities-library', () => ({
  cosineSimilarity: (vectorA: number[], vectorB: number[]) => {
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;
    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      magnitudeA += vectorA[i] * vectorA[i];
      magnitudeB += vectorB[i] * vectorB[i];
    }
    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
  },
}));

import {
  findClusters,
  CLUSTER_THRESHOLD,
  CONVERSATIONAL_CLUSTER_THRESHOLD,
  MAX_CLUSTER_SIZE,
} from '../memory/ClusterDetection.ts';
import type { MemoryDoc } from '../memory/types.ts';

function createMemoryWithEmbedding(
  id: string,
  embedding: number[],
): MemoryDoc {
  return {
    id,
    type: 'user',
    content: `Memory ${id}`,
    createdAt: new Date().toISOString(),
    embedding,
  };
}

describe('ClusterDetection', () => {
  describe('constants', () => {
    it('CLUSTER_THRESHOLD is 0.75', () => {
      expect(CLUSTER_THRESHOLD).toBe(0.75);
    });

    it('CONVERSATIONAL_CLUSTER_THRESHOLD is 0.8', () => {
      expect(CONVERSATIONAL_CLUSTER_THRESHOLD).toBe(0.8);
    });

    it('MAX_CLUSTER_SIZE is 8', () => {
      expect(MAX_CLUSTER_SIZE).toBe(8);
    });
  });

  describe('findClusters', () => {
    it('returns empty array for empty input', () => {
      expect(findClusters([])).toEqual([]);
    });

    it('returns empty array for single memory', () => {
      const memories = [createMemoryWithEmbedding('1', [1, 0, 0])];
      expect(findClusters(memories)).toEqual([]);
    });

    it('clusters two identical embeddings together', () => {
      const memories = [
        createMemoryWithEmbedding('1', [1, 0, 0]),
        createMemoryWithEmbedding('2', [1, 0, 0]),
      ];
      const clusters = findClusters(memories);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(2);
    });

    it('does not cluster two dissimilar embeddings', () => {
      const memories = [
        createMemoryWithEmbedding('1', [1, 0, 0]),
        createMemoryWithEmbedding('2', [0, 0, 1]),
      ];
      const clusters = findClusters(memories);
      expect(clusters).toHaveLength(0);
    });

    it('forms multiple clusters from distinct groups', () => {
      const memories = [
        createMemoryWithEmbedding('1', [1, 0, 0]),
        createMemoryWithEmbedding('2', [1, 0.01, 0]),
        createMemoryWithEmbedding('3', [0, 0, 1]),
        createMemoryWithEmbedding('4', [0, 0.01, 1]),
      ];
      const clusters = findClusters(memories);
      expect(clusters).toHaveLength(2);
    });

    it('respects custom threshold', () => {
      const memories = [
        createMemoryWithEmbedding('1', [1, 0, 0]),
        createMemoryWithEmbedding('2', [0.9, 0.4, 0]),
      ];
      const lowThresholdClusters = findClusters(memories, 0.5);
      expect(lowThresholdClusters).toHaveLength(1);

      const highThresholdClusters = findClusters(memories, 0.99);
      expect(highThresholdClusters).toHaveLength(0);
    });

    it('caps cluster size at MAX_CLUSTER_SIZE', () => {
      const baseEmbedding = [1, 0, 0, 0, 0];
      const memories = Array.from({ length: 10 }, (_, index) =>
        createMemoryWithEmbedding(
          String(index),
          baseEmbedding.map((value) => value + Math.random() * 0.001),
        ),
      );
      const clusters = findClusters(memories, 0.5);
      for (const cluster of clusters) {
        expect(cluster.length).toBeLessThanOrEqual(MAX_CLUSTER_SIZE);
      }
    });

    it('skips memories with null embeddings', () => {
      const memories: MemoryDoc[] = [
        {
          id: '1',
          type: 'user',
          content: 'Memory 1',
          createdAt: new Date().toISOString(),
          embedding: null,
        },
        createMemoryWithEmbedding('2', [1, 0, 0]),
        createMemoryWithEmbedding('3', [1, 0, 0]),
      ];
      const clusters = findClusters(memories);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(2);
      expect(clusters[0].every((memory) => memory.id !== '1')).toBe(true);
    });

    it('skips memories with undefined embeddings', () => {
      const memories: MemoryDoc[] = [
        {
          id: '1',
          type: 'user',
          content: 'Memory 1',
          createdAt: new Date().toISOString(),
        },
        createMemoryWithEmbedding('2', [1, 0, 0]),
        createMemoryWithEmbedding('3', [1, 0, 0]),
      ];
      const clusters = findClusters(memories);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(2);
    });

    it('uses union-find to transitively cluster related memories', () => {
      const memories = [
        createMemoryWithEmbedding('1', [1, 0, 0]),
        createMemoryWithEmbedding('2', [0.95, 0.3, 0]),
        createMemoryWithEmbedding('3', [0.85, 0.5, 0]),
      ];
      const clusters = findClusters(memories, 0.7);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toHaveLength(3);
    });
  });
});

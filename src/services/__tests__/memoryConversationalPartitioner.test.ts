import { describe, it, expect, vi } from 'vitest';

vi.mock('@rodrigo-barraza/utilities-library', () => ({
  daysSinceIso: (isoDate: string) => {
    const millisecondsPerDay = 1000 * 60 * 60 * 24;
    return Math.floor(
      (Date.now() - new Date(isoDate).getTime()) / millisecondsPerDay,
    );
  },
}));

import {
  partitionConversationalMemories,
  findStaleConversationalMemories,
  CONVERSATIONAL_STALENESS_CONFIG,
} from '../memory/ConversationalMemoryPartitioner.ts';
import type { MemoryDoc } from '../memory/types.ts';

function createMemory(
  id: string,
  overrides: Partial<MemoryDoc> = {},
): MemoryDoc {
  return {
    id,
    type: 'personal',
    content: `Memory ${id}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

describe('ConversationalMemoryPartitioner', () => {
  describe('CONVERSATIONAL_STALENESS_CONFIG', () => {
    it('has gaming threshold of 60', () => {
      expect(CONVERSATIONAL_STALENESS_CONFIG.gaming).toBe(60);
    });

    it('has work threshold of 90', () => {
      expect(CONVERSATIONAL_STALENESS_CONFIG.work).toBe(90);
    });

    it('has achievement threshold of 90', () => {
      expect(CONVERSATIONAL_STALENESS_CONFIG.achievement).toBe(90);
    });
  });

  describe('partitionConversationalMemories', () => {
    it('returns empty map for empty array', () => {
      const result = partitionConversationalMemories([]);
      expect(result.size).toBe(0);
    });

    it('creates a single partition for one memory', () => {
      const memories = [
        createMemory('1', {
          aboutUserId: 'user-a',
          sourceUserId: 'user-b',
        }),
      ];
      const result = partitionConversationalMemories(memories);
      expect(result.size).toBe(1);
      expect(result.has('user-a::user-b')).toBe(true);
      expect(result.get('user-a::user-b')).toHaveLength(1);
    });

    it('groups memories with same aboutUserId + sourceUserId pair', () => {
      const memories = [
        createMemory('1', {
          aboutUserId: 'user-a',
          sourceUserId: 'user-b',
        }),
        createMemory('2', {
          aboutUserId: 'user-a',
          sourceUserId: 'user-b',
        }),
      ];
      const result = partitionConversationalMemories(memories);
      expect(result.size).toBe(1);
      expect(result.get('user-a::user-b')).toHaveLength(2);
    });

    it('creates separate partitions for different user pairs', () => {
      const memories = [
        createMemory('1', {
          aboutUserId: 'user-a',
          sourceUserId: 'user-b',
        }),
        createMemory('2', {
          aboutUserId: 'user-c',
          sourceUserId: 'user-d',
        }),
      ];
      const result = partitionConversationalMemories(memories);
      expect(result.size).toBe(2);
      expect(result.has('user-a::user-b')).toBe(true);
      expect(result.has('user-c::user-d')).toBe(true);
    });

    it('defaults missing aboutUserId to _unknown', () => {
      const memories = [
        createMemory('1', {
          sourceUserId: 'user-b',
        }),
      ];
      const result = partitionConversationalMemories(memories);
      expect(result.has('_unknown::user-b')).toBe(true);
    });

    it('defaults missing sourceUserId to _unknown', () => {
      const memories = [
        createMemory('1', {
          aboutUserId: 'user-a',
        }),
      ];
      const result = partitionConversationalMemories(memories);
      expect(result.has('user-a::_unknown')).toBe(true);
    });

    it('defaults both missing user ids to _unknown', () => {
      const memories = [createMemory('1')];
      const result = partitionConversationalMemories(memories);
      expect(result.has('_unknown::_unknown')).toBe(true);
    });
  });

  describe('findStaleConversationalMemories', () => {
    it('returns empty array when no memories are stale', () => {
      const memories = [
        createMemory('1', { type: 'gaming', createdAt: daysAgoIso(30) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(0);
    });

    it('flags gaming memory older than 60 days as stale', () => {
      const memories = [
        createMemory('1', { type: 'gaming', createdAt: daysAgoIso(70) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('does not flag gaming memory at exactly 60 days', () => {
      const memories = [
        createMemory('1', { type: 'gaming', createdAt: daysAgoIso(60) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(0);
    });

    it('flags work memory older than 90 days as stale', () => {
      const memories = [
        createMemory('1', { type: 'work', createdAt: daysAgoIso(100) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(1);
    });

    it('does not flag work memory at 30 days', () => {
      const memories = [
        createMemory('1', { type: 'work', createdAt: daysAgoIso(30) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(0);
    });

    it('never flags personal type as stale (durable)', () => {
      const memories = [
        createMemory('1', { type: 'personal', createdAt: daysAgoIso(200) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(0);
    });

    it('never flags preference type as stale (durable)', () => {
      const memories = [
        createMemory('1', { type: 'preference', createdAt: daysAgoIso(500) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(0);
    });

    it('flags achievement memory older than 90 days', () => {
      const memories = [
        createMemory('1', { type: 'achievement', createdAt: daysAgoIso(95) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(1);
    });

    it('handles mixed types returning only stale ones', () => {
      const memories = [
        createMemory('1', { type: 'gaming', createdAt: daysAgoIso(70) }),
        createMemory('2', { type: 'personal', createdAt: daysAgoIso(300) }),
        createMemory('3', { type: 'work', createdAt: daysAgoIso(95) }),
        createMemory('4', { type: 'gaming', createdAt: daysAgoIso(30) }),
      ];
      const result = findStaleConversationalMemories(memories);
      expect(result).toHaveLength(2);
      expect(result.map((memory) => memory.id).sort()).toEqual(['1', '3']);
    });
  });
});

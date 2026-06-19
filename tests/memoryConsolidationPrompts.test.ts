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
  formatMemoryEntry,
  formatConversationalMemoryEntry,
  buildBatchInput,
  buildConversationalBatchInput,
} from '../src/services/memory/ConsolidationPrompts.ts';
import type { MemoryDoc, PartitionMeta } from '../src/services/memory/types.ts';

function createMemory(
  id: string,
  overrides: Partial<MemoryDoc> = {},
): MemoryDoc {
  return {
    id,
    type: 'user',
    content: `Content for ${id}`,
    createdAt: new Date().toISOString(),
    title: `Title ${id}`,
    ...overrides,
  };
}

describe('ConsolidationPrompts', () => {
  describe('formatMemoryEntry', () => {
    it('includes ID, type, title, content, and age', () => {
      const memory = createMemory('mem-1', {
        type: 'feedback',
        title: 'My Title',
        content: 'Some content here',
      });
      const formatted = formatMemoryEntry(memory);

      expect(formatted).toContain('**ID**: mem-1');
      expect(formatted).toContain('**Type**: feedback');
      expect(formatted).toContain('**Title**: My Title');
      expect(formatted).toContain('**Content**: Some content here');
      expect(formatted).toMatch(/\*\*Age\*\*: \d+ days/);
    });

    it('uses content substring when title is missing', () => {
      const memory = createMemory('mem-2', {
        title: null,
        content: 'A longer content string that should be truncated to sixty characters for the title',
      });
      const formatted = formatMemoryEntry(memory);

      expect(formatted).toContain('**Title**: A longer content string');
    });

    it('uses "untitled" when both title and content are empty-ish', () => {
      const memory: MemoryDoc = {
        id: 'mem-3',
        type: 'user',
        content: '',
        createdAt: new Date().toISOString(),
        title: null,
      };
      const formatted = formatMemoryEntry(memory);

      expect(formatted).toContain('**Title**: untitled');
    });
  });

  describe('formatConversationalMemoryEntry', () => {
    it('includes aboutUsername and sourceUsername', () => {
      const memory = createMemory('conv-1', {
        aboutUsername: 'Alice',
        aboutUserId: 'user-a',
        sourceUsername: 'Bob',
        sourceUserId: 'user-b',
      });
      const formatted = formatConversationalMemoryEntry(memory);

      expect(formatted).toContain('**ID**: conv-1');
      expect(formatted).toContain('**Category**: user');
      expect(formatted).toContain('**About**: Alice (user-a)');
      expect(formatted).toContain('**Source**: Bob (user-b)');
      expect(formatted).toMatch(/\*\*Age\*\*: \d+ days/);
    });

    it('defaults missing aboutUsername to "any"', () => {
      const memory = createMemory('conv-2', {
        sourceUsername: 'Bob',
        sourceUserId: 'user-b',
      });
      const formatted = formatConversationalMemoryEntry(memory);

      expect(formatted).toContain('**About**: any');
    });

    it('defaults missing sourceUsername to "any"', () => {
      const memory = createMemory('conv-3', {
        aboutUsername: 'Alice',
        aboutUserId: 'user-a',
      });
      const formatted = formatConversationalMemoryEntry(memory);

      expect(formatted).toContain('**Source**: any');
    });
  });

  describe('buildBatchInput', () => {
    it('returns null for empty clusters and stale', () => {
      expect(buildBatchInput([], [])).toBeNull();
    });

    it('builds output with clusters only', () => {
      const clusters = [[createMemory('1'), createMemory('2')]];
      const result = buildBatchInput(clusters, []);

      expect(result).not.toBeNull();
      expect(result).toContain('Clusters of Similar Memories');
      expect(result).toContain('Cluster 1 (2 memories');
      expect(result).toContain('mem');
    });

    it('builds output with stale only', () => {
      const staleMemories = [createMemory('stale-1')];
      const result = buildBatchInput([], staleMemories);

      expect(result).not.toBeNull();
      expect(result).toContain('Potentially Stale Memories');
    });

    it('builds output with both clusters and stale', () => {
      const clusters = [[createMemory('1'), createMemory('2')]];
      const staleMemories = [createMemory('stale-1')];
      const result = buildBatchInput(clusters, staleMemories);

      expect(result).not.toBeNull();
      expect(result).toContain('Clusters of Similar Memories');
      expect(result).toContain('Potentially Stale Memories');
    });

    it('numbers clusters sequentially', () => {
      const clusters = [
        [createMemory('1'), createMemory('2')],
        [createMemory('3'), createMemory('4')],
      ];
      const result = buildBatchInput(clusters, []);

      expect(result).toContain('Cluster 1');
      expect(result).toContain('Cluster 2');
    });
  });

  describe('buildConversationalBatchInput', () => {
    it('returns null for empty inputs without partition meta', () => {
      expect(buildConversationalBatchInput([], [])).toBeNull();
    });

    it('includes attribution context when partitionMeta is provided', () => {
      const meta: PartitionMeta = {
        aboutUserId: 'user-a',
        aboutUsername: 'Alice',
        sourceUserId: 'user-b',
        sourceUsername: 'Bob',
      };
      const clusters = [[createMemory('1'), createMemory('2')]];
      const result = buildConversationalBatchInput(clusters, [], meta);

      expect(result).not.toBeNull();
      expect(result).toContain('Attribution Context');
      expect(result).toContain('About user**: Alice');
      expect(result).toContain('Observed by**: Bob');
    });

    it('builds output without partitionMeta', () => {
      const clusters = [[createMemory('1'), createMemory('2')]];
      const result = buildConversationalBatchInput(clusters, []);

      expect(result).not.toBeNull();
      expect(result).toContain('Clusters of Similar Facts');
      expect(result).not.toContain('Attribution Context');
    });

    it('uses conversational memory formatting', () => {
      const clusters = [
        [
          createMemory('1', {
            aboutUsername: 'Alice',
            aboutUserId: 'user-a',
            sourceUsername: 'Bob',
            sourceUserId: 'user-b',
          }),
        ],
      ];
      const result = buildConversationalBatchInput(clusters, []);

      expect(result).toContain('**About**: Alice');
      expect(result).toContain('**Source**: Bob');
    });

    it('includes stale facts section', () => {
      const staleMemories = [createMemory('stale-1')];
      const result = buildConversationalBatchInput([], staleMemories);

      expect(result).not.toBeNull();
      expect(result).toContain('Potentially Stale Facts');
    });

    it('returns non-null when only partitionMeta is provided with data', () => {
      const meta: PartitionMeta = {
        aboutUserId: 'user-a',
        aboutUsername: 'Alice',
        sourceUserId: 'user-b',
        sourceUsername: 'Bob',
      };
      const result = buildConversationalBatchInput(
        [[createMemory('1')]],
        [],
        meta,
      );
      expect(result).not.toBeNull();
    });
  });
});

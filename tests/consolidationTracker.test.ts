import { describe, it, expect, vi, beforeEach } from 'vitest';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import {
  getRunCount,
  incrementRunCount,
  resetRunCount,
  recordHistory,
  canRunToday,
  getHistory,
  SESSIONS_BETWEEN_RUNS,
  DAILY_MAX_CONSOLIDATIONS
} from '../src/services/memory/ConsolidationTracker.ts';

describe('Memory Consolidation Tracker Unit Tests', () => {
  let mockRuns: Array<{ project: string; sessionsSinceLastRun: number; lastConsolidatedAt?: string }> = [];
  let mockHistory: Array<{
    project: string;
    runAt: string;
    trigger: string;
    memoriesBefore: number;
    memoriesAfter: number;
    actionsApplied: number;
    actions: any[];
    summary: string;
    durationMs: number;
  }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuns = [];
    mockHistory = [];

    const mockDb = {
      collection: vi.fn().mockImplementation((collectionName: string) => {
        if (collectionName === 'memory_consolidation_runs') {
          return {
            findOne: vi.fn().mockImplementation(async (query: { project: string }) => {
              return mockRuns.find((run) => run.project === query.project) || null;
            }),
            updateOne: vi.fn().mockImplementation(async (query: { project: string }, update: any, options?: { upsert?: boolean }) => {
              let run = mockRuns.find((item) => item.project === query.project);
              if (!run) {
                if (options?.upsert) {
                  run = { project: query.project, sessionsSinceLastRun: 0 };
                  mockRuns.push(run);
                } else {
                  return { matchedCount: 0, modifiedCount: 0 };
                }
              }

              if (update.$inc) {
                run.sessionsSinceLastRun += update.$inc.sessionsSinceLastRun || 0;
              }
              if (update.$set) {
                if (update.$set.sessionsSinceLastRun !== undefined) {
                  run.sessionsSinceLastRun = update.$set.sessionsSinceLastRun;
                }
                if (update.$set.lastConsolidatedAt !== undefined) {
                  run.lastConsolidatedAt = update.$set.lastConsolidatedAt;
                }
              }
              return { matchedCount: 1, modifiedCount: 1 };
            }),
          };
        }

        if (collectionName === 'memory_consolidation_history') {
          return {
            insertOne: vi.fn().mockImplementation(async (document: any) => {
              mockHistory.push(document);
              return { acknowledged: true, insertedId: 'mock-id' };
            }),
            countDocuments: vi.fn().mockImplementation(async (query: any) => {
              const startAt = query.runAt?.$gte || '';
              return mockHistory.filter(
                (item) => item.project === query.project && item.runAt >= startAt
              ).length;
            }),
            find: vi.fn().mockImplementation((query: { project: string }) => {
              const filtered = mockHistory.filter((item) => item.project === query.project);
              return {
                sort: vi.fn().mockReturnThis(),
                limit: vi.fn().mockImplementation((limitNumber: number) => {
                  const limited = filtered.slice(0, limitNumber);
                  return {
                    project: vi.fn().mockReturnThis(),
                    toArray: vi.fn().mockResolvedValue(limited),
                  };
                }),
              };
            }),
          };
        }

        throw new Error(`Collection "${collectionName}" not mocked`);
      }),
    };

    vi.spyOn(MongoWrapper, 'getDb').mockReturnValue(mockDb as any);
  });

  it('should verify defined constants', () => {
    expect(SESSIONS_BETWEEN_RUNS).toBe(5);
    expect(DAILY_MAX_CONSOLIDATIONS).toBe(20);
  });

  describe('getRunCount', () => {
    it('returns 0 when no runs exist for the project', async () => {
      const count = await getRunCount('non-existent-project');
      expect(count).toBe(0);
    });

    it('returns stored run count when document exists', async () => {
      mockRuns.push({ project: 'test-project', sessionsSinceLastRun: 3 });
      const count = await getRunCount('test-project');
      expect(count).toBe(3);
    });
  });

  describe('incrementRunCount', () => {
    it('creates run record if it does not exist and sets count to 1', async () => {
      await incrementRunCount('test-project');
      expect(mockRuns).toHaveLength(1);
      expect(mockRuns[0].sessionsSinceLastRun).toBe(1);
    });

    it('increments run count if record already exists', async () => {
      mockRuns.push({ project: 'test-project', sessionsSinceLastRun: 2 });
      await incrementRunCount('test-project');
      expect(mockRuns[0].sessionsSinceLastRun).toBe(3);
    });
  });

  describe('resetRunCount', () => {
    it('resets session count to 0 and records last consolidated date', async () => {
      mockRuns.push({ project: 'test-project', sessionsSinceLastRun: 4 });
      await resetRunCount('test-project');
      expect(mockRuns[0].sessionsSinceLastRun).toBe(0);
      expect(mockRuns[0].lastConsolidatedAt).toBeDefined();
    });
  });

  describe('recordHistory', () => {
    it('inserts a consolidation run history document calculating post-run memories correctly', async () => {
      const actions = [
        { type: 'merge' as const, sourceIds: ['id1', 'id2'], merged: { type: 'memory', title: 'Merged Memory', content: 'Merged Content' }, reason: 'Similarity' },
        { type: 'delete' as const, id: 'id3', reason: 'Redundant' },
      ];

      await recordHistory('test-project', 'session-count', 10, actions as any, 'Consolidated memories successfully', 150);

      expect(mockHistory).toHaveLength(1);
      const record = mockHistory[0];
      expect(record.project).toBe('test-project');
      expect(record.trigger).toBe('session-count');
      expect(record.memoriesBefore).toBe(10);
      // memoriesAfter = 10 - 2 (sourceIds in merge) - 1 (delete) + 1 (new merged memory) = 8
      expect(record.memoriesAfter).toBe(8);
      expect(record.actionsApplied).toBe(2);
      expect(record.actions).toEqual([
        { type: 'merge', sourceIds: ['id1', 'id2'], mergedTitle: 'Merged Memory', reason: 'Similarity' },
        { type: 'delete', deletedId: 'id3', reason: 'Redundant' },
      ]);
      expect(record.summary).toBe('Consolidated memories successfully');
      expect(record.durationMs).toBe(150);
      expect(record.runAt).toBeDefined();
    });
  });

  describe('canRunToday', () => {
    it('returns true if under the daily limit', async () => {
      mockHistory.push({
        project: 'test-project',
        runAt: new Date().toISOString(),
        trigger: 'session-count',
        memoriesBefore: 10,
        memoriesAfter: 9,
        actionsApplied: 1,
        actions: [],
        summary: 'Merged',
        durationMs: 100,
      });

      const allowed = await canRunToday('test-project');
      expect(allowed).toBe(true);
    });

    it('returns false if daily limit is reached', async () => {
      for (let index = 0; index < DAILY_MAX_CONSOLIDATIONS; index++) {
        mockHistory.push({
          project: 'test-project',
          runAt: new Date().toISOString(),
          trigger: 'session-count',
          memoriesBefore: 10,
          memoriesAfter: 9,
          actionsApplied: 1,
          actions: [],
          summary: 'Merged',
          durationMs: 100,
        });
      }

      const allowed = await canRunToday('test-project');
      expect(allowed).toBe(false);
    });

    it('ignores items from yesterday', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      for (let index = 0; index < DAILY_MAX_CONSOLIDATIONS; index++) {
        mockHistory.push({
          project: 'test-project',
          runAt: yesterday.toISOString(),
          trigger: 'session-count',
          memoriesBefore: 10,
          memoriesAfter: 9,
          actionsApplied: 1,
          actions: [],
          summary: 'Merged',
          durationMs: 100,
        });
      }

      const allowed = await canRunToday('test-project');
      expect(allowed).toBe(true);
    });
  });

  describe('getHistory', () => {
    it('returns sorted and limited history array', async () => {
      mockHistory.push({
        project: 'test-project',
        runAt: new Date().toISOString(),
        trigger: 'session-count',
        memoriesBefore: 10,
        memoriesAfter: 9,
        actionsApplied: 1,
        actions: [],
        summary: 'Merged 1',
        durationMs: 100,
      });
      mockHistory.push({
        project: 'test-project',
        runAt: new Date().toISOString(),
        trigger: 'session-count',
        memoriesBefore: 9,
        memoriesAfter: 8,
        actionsApplied: 1,
        actions: [],
        summary: 'Merged 2',
        durationMs: 120,
      });

      const history = await getHistory('test-project', 1);
      expect(history).toHaveLength(1);
      expect(history[0].summary).toBe('Merged 1');
    });
  });
});

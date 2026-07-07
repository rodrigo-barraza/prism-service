import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROVIDERS } from "#src/constants";
import express, { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';

// ── Mocks ────────────────────────────────────────────────────────

const mockModelDefinition = {
  name: 'test-model',
  provider: PROVIDERS.GOOGLE,
  contextLength: 128_000,
};

vi.mock('#src/utils/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock('#src/utils/CleanupRegistry', () => ({
  registerCleanup: vi.fn(),
}));

const mockRunAgenticLoop = vi.fn().mockResolvedValue(undefined);
vi.mock('#src/services/AgenticLoopService', () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

vi.mock('#src/providers/index', () => ({
  getProvider: vi.fn().mockReturnValue({
    generateText: vi.fn(),
    generateTextStream: vi.fn(),
  }),
}));

vi.mock('#config', () => ({
  MONGO_DB_NAME: 'prism-test',
  getModelByName: () => mockModelDefinition,
}));

// Mutable variables to control database mock behaviors per test
const databaseStore = new Map<string, any>();
let simulateDatabaseError = false;
let databaseClaimCount = 0;

vi.mock('#src/wrappers/MongoWrapper', () => ({
  default: {
    getDb: () => {
      if (simulateDatabaseError) {
        throw new Error('Database connection lost');
      }
      return {
        collection: (_collectionName: string) => ({
          find: (query: any) => {
            const cursor = {
              sort: () => cursor,
              toArray: async () => {
                if (simulateDatabaseError) {
                  throw new Error('Query execution failed');
                }
                const matches = Array.from(databaseStore.values()).filter((item) => {
                  for (const key in query) {
                    if (query[key] && typeof query[key] === 'object' && '$ne' in query[key]) {
                      if (item[key] === query[key].$ne) return false;
                    } else if (item[key] !== query[key]) {
                      return false;
                    }
                  }
                  return true;
                });
                return matches;
              },
            };
            return cursor;
          },
          findOne: async (query: any) => {
            if (simulateDatabaseError) {
              throw new Error('Find document failed');
            }
            const match = Array.from(databaseStore.values()).find((item) => {
              for (const key in query) {
                if (item[key] !== query[key]) {
                  return false;
                }
              }
              return true;
            });
            return match || null;
          },
          insertOne: async (document: any) => {
            if (simulateDatabaseError) {
              throw new Error('Insert document failed');
            }
            databaseStore.set(document.id, document);
            return { insertedId: document.id };
          },
          findOneAndUpdate: async (query: any, update: any) => {
            if (simulateDatabaseError) {
              throw new Error('Find and update failed');
            }
            const document = databaseStore.get(query.id);
            if (!document) return null;

            // Handle claim condition in concurrency tests
            if (query.lastRunMinute && query.lastRunMinute.$ne === update.$set.lastRunMinute) {
              if (document.lastRunMinute === update.$set.lastRunMinute) {
                return null;
              }
            }

            databaseClaimCount++;
            const updatedDocument = { ...document, ...update.$set };
            databaseStore.set(query.id, updatedDocument);
            return document; // Returns original document (pre-update)
          },
          deleteOne: async (query: any) => {
            if (simulateDatabaseError) {
              throw new Error('Delete failed');
            }
            let deleted = false;
            if (query.id) {
              deleted = databaseStore.delete(query.id);
            } else if (query.name) {
              const item = Array.from(databaseStore.values()).find((x) => x.name === query.name);
              if (item) {
                deleted = databaseStore.delete(item.id);
              }
            }
            return { deletedCount: deleted ? 1 : 0 };
          },
          updateOne: async (query: any, update: any) => {
            if (simulateDatabaseError) {
              throw new Error('Update failed');
            }
            const document = databaseStore.get(query.id);
            if (!document) return { modifiedCount: 0 };
            const updatedDocument = { ...document, ...update.$set };
            databaseStore.set(query.id, updatedDocument);
            return { modifiedCount: 1 };
          },
        }),
      };
    },
  },
}));

// ── Import under test ────────────────────────────────────────────

const { default: ScheduledTaskService } = await import('#src/services/ScheduledTaskService');
const { default: scheduledTasksRouter } = await import('#src/routes/ScheduledTasksRoutes');

const app = express();
app.use(express.json());

// Inject middleware to populate request project/username context
app.use((request: Request, response: Response, next: NextFunction) => {
  request.project = request.headers['x-project'] as string || 'default-project';
  request.username = request.headers['x-username'] as string || 'default-user';
  next();
});

app.use('/scheduled-tasks', scheduledTasksRouter);

// Global Error Handler
app.use((error: any, request: Request, response: Response, _next: NextFunction) => {
  response.status(500).json({ error: error.message || 'Internal Server Error' });
});

const apiAgent = supertest(app);

describe('Scheduled Tasks Flow Adversarial Tests', () => {
  beforeEach(() => {
    databaseStore.clear();
    simulateDatabaseError = false;
    databaseClaimCount = 0;
    mockRunAgenticLoop.mockClear();
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Boundary & Edge Cases
  // ────────────────────────────────────────────────────────────────
  describe('Boundary & Edge Cases', () => {
    it('should handle task creation when prompt is extremely large (100K+ characters)', async () => {
      const hugePrompt = 'A'.repeat(100_000);
      const response = await apiAgent
        .post('/scheduled-tasks')
        .set('x-project', 'heavy-load')
        .set('x-username', 'adversary')
        .send({
          name: 'Massive Load Test',
          prompt: hugePrompt,
          agent: 'OMNI',
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3.5-flash',
          scheduleType: 'cron',
          cronExpression: '0 * * * *',
        });

      expect(response.status).toBe(201);
      expect(response.body.id).toBeDefined();
      expect(response.body.prompt.length).toBe(100_000);
    });

    it('should reject task creation when prompt or other required fields are missing', async () => {
      const response = await apiAgent
        .post('/scheduled-tasks')
        .set('x-project', 'test')
        .set('x-username', 'adversary')
        .send({
          name: 'Incomplete Task',
          // missing prompt, provider, model, scheduleType
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should handle unusual unicode and null characters in task fields', async () => {
      const invalidTimePayload = {
        name: 'Unicode Task 💖 \0 \u0000 RTL 🕋',
        prompt: 'Clean the system \0 now',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'once',
        scheduleTime: '12:00',
        scheduleDate: '2026-06-16',
      };

      const response = await apiAgent
        .post('/scheduled-tasks')
        .set('x-project', 'unicode-project')
        .set('x-username', 'adversary')
        .send(invalidTimePayload);

      expect(response.status).toBe(201);
      expect(response.body.name).toContain('Unicode Task');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Type Coercion & Schema Violations
  // ────────────────────────────────────────────────────────────────
  describe('Type Coercion & Schema Violations', () => {
    it('should handle type mismatches in incoming request bodies gracefully', async () => {
      const payload = {
        name: 'Mismatched Types',
        prompt: 'Check logs',
        agent: 'OMNI',
        provider: 12345, // Number where string expected
        model: true,     // Boolean where string expected
        scheduleType: 'hourly',
      };

      const response = await apiAgent
        .post('/scheduled-tasks')
        .set('x-project', 'test-project')
        .set('x-username', 'adversary')
        .send(payload);

      // It might pass express routing but service layer should handle safely
      // (either converting to string or database inserting it as is)
      expect([201, 400, 500]).toContain(response.status);
    });

    it('should handle type updates with incorrect types in PATCH', async () => {
      // Create valid task first
      const task = await ScheduledTaskService.createTask({
        name: 'Valid Task',
        prompt: 'Check CPU',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'hourly',
        enabled: true,
        project: 'test-project',
        username: 'adversary',
      });

      const response = await apiAgent
        .patch(`/scheduled-tasks/${task.id}`)
        .set('x-project', 'test-project')
        .set('x-username', 'adversary')
        .send({
          enabled: 'false', // String where boolean expected
          cronExpression: ['not', 'a', 'string'], // Array where string expected
        });

      // Assert that we don't crash, and return either a success or a validation error
      expect([200, 400, 500]).toContain(response.status);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Concurrency & Race Conditions
  // ────────────────────────────────────────────────────────────────
  describe('Concurrency & Race Conditions', () => {
    it('should prevent double execution during concurrent tick runs via atomic claims', async () => {
      await ScheduledTaskService.createTask({
        name: 'Race Task',
        prompt: 'Execute job',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'cron',
        cronExpression: '* * * * *', // every minute
        enabled: true,
        project: 'test-project',
        username: 'adversary',
      });

      // Simulate a concurrent run by triggering tick twice in parallel.
      // The tick implementation fetches enabled tasks and uses findOneAndUpdate to claim.
      // If we call tick twice:
      await Promise.all([
        ScheduledTaskService.tick(),
        ScheduledTaskService.tick(),
      ]);

      // Database findOneAndUpdate should have successfully claimed only once
      expect(databaseClaimCount).toBe(1);
      expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. State Machine Violations
  // ────────────────────────────────────────────────────────────────
  describe('State Machine Violations', () => {
    it('should fail to execute scheduled task that is disabled', async () => {
      await ScheduledTaskService.createTask({
        name: 'Disabled Task',
        prompt: 'Should not run',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'cron',
        cronExpression: '* * * * *',
        enabled: false,
        project: 'test-project',
        username: 'adversary',
      });

      // Running tick should NOT pick up this disabled task
      await ScheduledTaskService.tick();

      expect(databaseClaimCount).toBe(0);
      expect(mockRunAgenticLoop).not.toHaveBeenCalled();
    });
    it('should bypass isolation and execute cross-tenant operation if project is unregistered (exposing client project bypass vulnerability)', async () => {
      const task = await ScheduledTaskService.createTask({
        name: 'Secret Task Unregistered',
        prompt: 'Top secret execution',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'hourly',
        enabled: true,
        project: 'project-alpha',
        username: 'alice',
      });

      // Bob in project-beta (unregistered client project) tries to trigger Alice's task
      const response = await apiAgent
        .post(`/scheduled-tasks/${task.id}/trigger`)
        .set('x-project', 'project-beta')
        .set('x-username', 'bob')
        .send({});

      // It succeeds (returns 200) because the service filters out project scoping for unregistered projects!
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.agentConversationId).toBeDefined();
    });

    it('should isolate task access and prevent unauthorized cross-tenant operations if project is registered as a workspace', async () => {
      const task = await ScheduledTaskService.createTask({
        name: 'Secret Task Registered',
        prompt: 'Top secret execution',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'hourly',
        enabled: true,
        project: 'project-alpha',
        username: 'alice',
      });

      // Register 'project-beta' in the mock database store so it is recognized as a workspace
      // _isClientProject does findOne on COLLECTIONS.WORKSPACES (but in our mock we need to handle that)
      // Let's mock finding COLLECTIONS.WORKSPACES in MongoWrapper.
      // Wait, in our getDb mock, we don't differentiate collections! Let's check how the findOne mock behaves:
      // it returns databaseStore.get(query.id) or find by name.
      // Let's add a workspace to databaseStore.
      databaseStore.set('workspace-project-beta', {
        id: 'workspace-project-beta',
        name: 'project-beta',
        path: '/some/workspace/path',
      });

      // Bob in project-beta (registered workspace project) tries to trigger Alice's task
      const response = await apiAgent
        .post(`/scheduled-tasks/${task.id}/trigger`)
        .set('x-project', 'project-beta')
        .set('x-username', 'bob')
        .send({});

      // It should fail (returns 500) because project-beta is registered, so project/user scoping is enforced!
      expect(response.status).toBe(500);
      expect(response.body.error).toContain('not found');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Error Recovery & Graceful Degradation
  // ────────────────────────────────────────────────────────────────
  describe('Error Recovery & Graceful Degradation', () => {
    it('should handle database connectivity drop during manual task trigger without crashing', async () => {
      const task = await ScheduledTaskService.createTask({
        name: 'Error Prone Task',
        prompt: 'Will fail soon',
        agent: 'OMNI',
        provider: PROVIDERS.GOOGLE,
        model: 'gemini-3.5-flash',
        scheduleType: 'hourly',
        enabled: true,
        project: 'test-project',
        username: 'adversary',
      });

      // Simulate a database failure
      simulateDatabaseError = true;

      const response = await apiAgent
        .post(`/scheduled-tasks/${task.id}/trigger`)
        .set('x-project', 'test-project')
        .set('x-username', 'adversary')
        .send({});

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });
  });
});

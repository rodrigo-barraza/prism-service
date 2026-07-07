import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import supertest from 'supertest';
import { ObjectId } from 'mongodb';

// ── Mocks ────────────────────────────────────────────────────────

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

vi.mock('#config', () => ({
  MONGO_DB_NAME: 'prism-test',
}));

const databaseStore = new Map<string, any>();
let simulateDatabaseError = false;

vi.mock('#src/wrappers/MongoWrapper', () => ({
  default: {
    getCollection: () => ({
      find: (_query: any) => ({
        sort: () => ({
          toArray: async () => {
            if (simulateDatabaseError) {
              throw new Error('Database query failed');
            }
            return Array.from(databaseStore.values());
          },
        }),
      }),
      findOne: async (query: any) => {
        if (simulateDatabaseError) {
          throw new Error('Database query failed');
        }
        if (query._id) {
          return databaseStore.get(query._id.toString()) || null;
        }
        if (query.agentId) {
          return Array.from(databaseStore.values()).find((item) => item.agentId === query.agentId) || null;
        }
        return null;
      },
      insertOne: async (document: any) => {
        if (simulateDatabaseError) {
          throw new Error('Database insert failed');
        }
        const id = new ObjectId().toString();
        const stored = { ...document, _id: id };
        databaseStore.set(id, stored);
        return { insertedId: id };
      },
      updateOne: async (query: any, update: any) => {
        if (simulateDatabaseError) {
          throw new Error('Database update failed');
        }
        const id = query._id.toString();
        const document = databaseStore.get(id);
        if (!document) return { modifiedCount: 0 };
        const updatedDocument = { ...document, ...update.$set };
        databaseStore.set(id, updatedDocument);
        return { modifiedCount: 1 };
      },
      deleteOne: async (query: any) => {
        if (simulateDatabaseError) {
          throw new Error('Database delete failed');
        }
        const id = query._id.toString();
        const deleted = databaseStore.delete(id);
        return { deletedCount: deleted ? 1 : 0 };
      },
    }),
  },
}));

// ── Import under test ────────────────────────────────────────────

const { default: AgentPersonaRegistry } = await import('#src/services/AgentPersonaRegistry');
const { default: customAgentsRouter } = await import('#src/routes/CustomAgentsRoutes');

const app = express();
app.use(express.json());
app.use('/custom-agents', customAgentsRouter);

// Global Error Handler
app.use((error: any, request: Request, response: Response, _next: NextFunction) => {
  response.status(500).json({ error: error.message || 'Internal Server Error' });
});

const apiAgent = supertest(app);

describe('Custom Agents Flow Adversarial Tests', () => {
  beforeEach(() => {
    databaseStore.clear();
    simulateDatabaseError = false;
    // Clear custom personas in the live registry (keep built-in ones)
    const list = AgentPersonaRegistry.list();
    for (const item of list) {
      if (item.custom) {
        AgentPersonaRegistry.unregister(item.id);
      }
    }
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────
  // 1. Boundary & Edge Cases
  // ────────────────────────────────────────────────────────────────
  describe('Boundary & Edge Cases', () => {
    it('should handle custom agent creation with exceptionally long name', async () => {
      const longName = 'A'.repeat(5000);
      const response = await apiAgent
        .post('/custom-agents')
        .send({
          name: longName,
          description: 'Too long name agent',
        });

      expect([201, 400, 500]).toContain(response.status);
      if (response.status === 201) {
        expect(response.body.agentId).toContain('CUSTOM_AAAAA');
      }
    });

    it('should handle creation when guidelines and identity are missing or empty', async () => {
      const response = await apiAgent
        .post('/custom-agents')
        .send({
          name: 'Skeleton Agent',
          description: '',
          identity: '',
          guidelines: '',
        });

      expect(response.status).toBe(201);
      expect(response.body.agentId).toBe('CUSTOM_SKELETON_AGENT');
      const persona = AgentPersonaRegistry.get('CUSTOM_SKELETON_AGENT');
      expect(persona).not.toBeNull();
      expect(persona?.identity({} as any)).toBe('');
      expect(persona?.guidelines).toBe('');
    });

    it('should reject creation when duplicate name already exists in database', async () => {
      // First creation
      await apiAgent
        .post('/custom-agents')
        .send({
          name: 'Twin Agent',
          description: 'The first twin',
        });

      // Second creation with exact same name
      const response = await apiAgent
        .post('/custom-agents')
        .send({
          name: 'Twin Agent',
          description: 'The second twin',
        });

      expect(response.status).toBe(409);
      expect(response.body.error).toContain('already exists');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Type Coercion & Schema Violations
  // ────────────────────────────────────────────────────────────────
  describe('Type Coercion & Schema Violations', () => {
    it('should handle policies parameter when it is not a valid array', async () => {
      const response = await apiAgent
        .post('/custom-agents')
        .send({
          name: 'No Policy Array Agent',
          policies: 'not-an-array-should-be-ignored-or-coerced',
        });

      expect(response.status).toBe(201);
      const persona = AgentPersonaRegistry.get('CUSTOM_NO_POLICY_ARRAY_AGENT');
      expect(persona).not.toBeNull();
      expect(persona?.policies).toBeUndefined();
    });

    it('should handle platformRules parameter when it is a string instead of object', async () => {
      const response = await apiAgent
        .post('/custom-agents')
        .send({
          name: 'String Rules Agent',
          platformRules: 'not-an-object',
        });

      expect(response.status).toBe(201);
      const persona = AgentPersonaRegistry.get('CUSTOM_STRING_RULES_AGENT');
      expect(persona).not.toBeNull();
      expect(persona?.platformRules).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Concurrency & Race Conditions
  // ────────────────────────────────────────────────────────────────
  describe('Concurrency & Race Conditions', () => {
    it('should handle rapid concurrent creation requests gracefully without crashing', async () => {
      // Parallel requests to create custom agents
      const responses = await Promise.all([
        apiAgent.post('/custom-agents').send({ name: 'Speedy Agent', description: 'Fast' }),
        apiAgent.post('/custom-agents').send({ name: 'Speedy Agent', description: 'Faster' }),
      ]);

      const statusCodes = responses.map((r) => r.status);
      expect(statusCodes).toContain(201);
      expect(statusCodes).toContain(409); // One succeeds, the other fails due to conflict check
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. State Machine Violations
  // ────────────────────────────────────────────────────────────────
  describe('State Machine Violations', () => {
    it('should refuse to unregister built-in agent personas', async () => {
      // OMNI is a built-in persona
      const omniBefore = AgentPersonaRegistry.get('OMNI');
      expect(omniBefore).not.toBeNull();
      expect(omniBefore?.custom).toBeFalsy();

      // Attempt unregister
      AgentPersonaRegistry.unregister('OMNI');

      // Built-in should NOT be deleted
      const omniAfter = AgentPersonaRegistry.get('OMNI');
      expect(omniAfter).not.toBeNull();
    });

    it('should clean up live persona registry immediately upon deleting custom agent', async () => {
      // 1. Create custom agent
      const createResponse = await apiAgent
        .post('/custom-agents')
        .send({
          name: 'Shortlived Agent',
        });
      expect(createResponse.status).toBe(201);
      const id = createResponse.body._id;

      // Ensure it is in registry
      expect(AgentPersonaRegistry.has('CUSTOM_SHORTLIVED_AGENT')).toBe(true);

      // 2. Delete custom agent
      const deleteResponse = await apiAgent
        .delete(`/custom-agents/${id}`);
      expect(deleteResponse.status).toBe(200);

      // Ensure it is unregistered from the live registry
      expect(AgentPersonaRegistry.has('CUSTOM_SHORTLIVED_AGENT')).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Error Recovery & Graceful Degradation
  // ────────────────────────────────────────────────────────────────
  describe('Error Recovery & Graceful Degradation', () => {
    it('should not mutate live registry state if database update fails', async () => {
      // 1. Create valid custom agent
      const createResponse = await apiAgent
        .post('/custom-agents')
        .send({
          name: 'Robust Agent',
          description: 'Initial description',
        });
      expect(createResponse.status).toBe(201);
      const id = createResponse.body._id;

      // 2. Simulate database failure during update
      simulateDatabaseError = true;

      const updateResponse = await apiAgent
        .put(`/custom-agents/${id}`)
        .send({
          description: 'Updated description',
        });

      expect(updateResponse.status).toBe(500);

      // 3. Disable DB error and check live registry has not mutated
      simulateDatabaseError = false;
      const persona = AgentPersonaRegistry.get('CUSTOM_ROBUST_AGENT');
      expect(persona?.description).toBe('Initial description');
    });
  });
});

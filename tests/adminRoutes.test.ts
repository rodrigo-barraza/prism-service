import { vi, describe, it, expect, beforeEach } from 'vitest';
import { app } from './setup.ts';
import adminRouter from '../src/routes/AdminRoutes.ts';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import * as providersModule from '../src/providers/index.ts';
import request from 'supertest';
import { PROVIDERS, COLLECTIONS } from "../src/constants";

// Mount the admin router
app.use('/admin', adminRouter);

describe('Admin Routes Integration Tests', () => {
  let mockDb: any;

  beforeEach(() => {
    // Stub collection query helpers
    mockDb = {
      collection: vi.fn().mockImplementation((collectionName) => {
        return {
          find: vi.fn().mockReturnValue({
            project: vi.fn().mockReturnThis(),
            sort: vi.fn().mockReturnThis(),
            skip: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            toArray: vi.fn().mockResolvedValue([
              {
                _id: 'mock-id-123',
                id: 'mock-id-123',
                name: 'Mock Record',
                title: 'Mock Record Title',
                timestamp: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                messages: [{ role: 'user', content: 'hello' }],
                conversationIds: ['mock-id-123']
              }
            ]),
          }),
          findOne: vi.fn().mockResolvedValue({
            _id: 'mock-id-123',
            id: 'mock-id-123',
            requestId: 'req-123',
            conversationId: 'conv-456',
            project: 'default',
            success: true,
            title: 'Mock Record Title',
            messages: [{ role: 'user', content: 'hello' }]
          }),
          countDocuments: vi.fn().mockResolvedValue(1),
          distinct: vi.fn().mockResolvedValue(['mock-value']),
          estimatedDocumentCount: vi.fn().mockResolvedValue(1),
          aggregate: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([
              { _id: 'gpt-4o', requestCount: 10, totalCost: 0.05 }
            ]),
          }),
          updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
          deleteMany: vi.fn().mockResolvedValue({ deletedCount: 2 }),
        };
      })
    };

    vi.spyOn(MongoWrapper, 'getDb').mockReturnValue(mockDb as any);

    vi.spyOn(providersModule, 'getProvider').mockImplementation((providerName) => {
      if (providerName === PROVIDERS.LM_STUDIO) {
        return {
          listModels: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'lm-studio-model',
                architecture: 'llama',
                params_string: '7B',
                size_bytes: 1000,
                quantization: { bits_per_weight: 4 }
              }
            ]
          }),
          ensureModelLoaded: vi.fn().mockResolvedValue({ alreadyLoaded: true }),
          unloadModel: vi.fn().mockResolvedValue({ success: true }),
        } as any;
      }
      throw new Error(`Mock provider not implemented for ${providerName}`);
    });
  });

  describe('GET /admin/requests', () => {
    it('returns paginated list of request logs', async () => {
      const response = await request(app)
        .get('/admin/requests?page=1&limit=10')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body.data).toHaveLength(1);
    });

    it('returns request details by id', async () => {
      const response = await request(app)
        .get('/admin/requests/req-123')
        .expect(200);

      expect(response.body.requestId).toBe('req-123');
    });

    it('returns associations for a request ID', async () => {
      const response = await request(app)
        .get('/admin/requests/req-123/associations')
        .expect(200);

      expect(response.body).toHaveProperty('conversations');
      expect(response.body).toHaveProperty(COLLECTIONS.WORKFLOWS);
      expect(response.body).toHaveProperty('traces');
    });
  });

  describe('GET /admin/stats', () => {
    it('returns aggregated request and cost stats', async () => {
      const response = await request(app)
        .get('/admin/stats?from=2026-06-01&to=2026-06-30')
        .expect(200);

      expect(response.body).toHaveProperty('totalRequests');
      expect(response.body).toHaveProperty('successCount');
    });
  });

  describe('GET /admin/conversations', () => {
    it('returns paginated conversations list', async () => {
      const response = await request(app)
        .get('/admin/conversations?limit=5')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveLength(2);
    });

    it('returns conversation details by id', async () => {
      const response = await request(app)
        .get('/admin/conversations/conv-456')
        .expect(200);

      expect(response.body.type).toBe('direct');
    });

    it('returns conversation filters', async () => {
      const response = await request(app)
        .get('/admin/conversations/filters')
        .expect(200);

      expect(response.body).toHaveProperty('projects');
      expect(response.body).toHaveProperty('usernames');
    });

    it('returns conversation stats summary', async () => {
      const response = await request(app)
        .get('/admin/conversations/stats')
        .expect(200);

      expect(response.body).toHaveProperty('generatingCount');
    });
  });

  describe('GET /admin/traces', () => {
    it('returns trace lists and aggregations', async () => {
      const response = await request(app)
        .get('/admin/traces')
        .expect(200);

      expect(response.body).toHaveProperty('data');
    });
  });

  describe('GET /admin/agent-conversations', () => {
    it('returns list of agent conversations', async () => {
      const response = await request(app)
        .get('/admin/agent-conversations')
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it('returns agent conversation stats', async () => {
      const response = await request(app)
        .get('/admin/agent-conversations/mock-id-123/stats')
        .expect(200);

      expect(response.body).toHaveProperty('requestCount');
    });

    it('returns agent conversation requests list', async () => {
      const response = await request(app)
        .get('/admin/agent-conversations/mock-id-123/requests')
        .expect(200);

      expect(response.body).toHaveProperty(COLLECTIONS.REQUESTS);
    });

    it('returns single agent conversation detail', async () => {
      const response = await request(app)
        .get('/admin/agent-conversations/mock-id-123')
        .expect(200);

      expect(response.body.id).toBe('mock-id-123');
    });
  });

  describe('GET /admin/lm-studio/models', () => {
    it('returns configuration for LM Studio models', async () => {
      const response = await request(app)
        .get('/admin/lm-studio/models')
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it('supports model load estimation', async () => {
      const response = await request(app)
        .post('/admin/lm-studio/estimate')
        .send({ model: 'lm-studio-model' })
        .expect(200);

      expect(response.body).toHaveProperty('totalLayers');
    });
  });

  describe('System routes nested in admin', () => {
    it('supports health check', async () => {
      const response = await request(app)
        .get('/admin/health')
        .expect(200);

      expect(response.body).toHaveProperty('status', 'healthy');
    });

    it('supports live activity check', async () => {
      const response = await request(app)
        .get('/admin/live')
        .expect(200);

      expect(response.body).toHaveProperty('conversations');
    });

    it('supports changes stream SSE', () => {
      return new Promise<void>((resolve, reject) => {
        const reqInstance = request(app)
          .get('/admin/changes/stream')
          .expect('Content-Type', /text\/event-stream/)
          .end((error) => {
            if (error && error.message !== 'socket hang up' && !error.message.includes('aborted')) {
              reject(error);
            } else {
              resolve();
            }
          });

        setTimeout(() => {
          reqInstance.abort();
        }, 100);
      });
    });
  });

  describe('Admin Content Routes', () => {
    it('returns list of workflows', async () => {
      const response = await request(app)
        .get('/admin/workflows')
        .expect(200);
      expect(response.body).toHaveProperty('data');
    });

    it('returns single workflow', async () => {
      const response = await request(app)
        .get('/admin/workflows/507f1f77bcf86cd799439011')
        .expect(200);
      expect(response.body).toHaveProperty('_id');
    });

    it('returns media listing', async () => {
      const response = await request(app)
        .get('/admin/media')
        .expect(200);
      expect(response.body).toHaveProperty('data');
    });

    it('returns text listing', async () => {
      const response = await request(app)
        .get('/admin/text')
        .expect(200);
      expect(response.body).toHaveProperty('data');
    });
  });
});

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app } from './setup.ts';
import request from 'supertest';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import { COLLECTIONS, PROVIDERS } from '../src/constants.ts';
import { errorHandler } from '../src/utils/errors.ts';
import EmbeddingService from '../src/services/EmbeddingService.ts';

// Import route modules
import mediaRouter from '../src/routes/MediaRoutes.ts';
import synthesisRouter from '../src/routes/SynthesisRoutes.ts';
import textRouter from '../src/routes/TextRoutes.ts';

// Mount routers
app.use('/media-test', mediaRouter);
app.use('/synthesis-test', synthesisRouter);
app.use('/text-test', textRouter);
app.use(errorHandler);

describe('Media and Synthesis Routes Integration Tests', () => {
  let mockDb: any;
  let mockSynthesisRuns: any[] = [];

  beforeEach(() => {
    mockSynthesisRuns = [
      {
        id: 'synthesis-run-123',
        project: 'test-project',
        username: 'test-user',
        title: 'Mock Title',
        systemPrompt: 'Mock System Prompt',
        userPersona: 'Mock User Persona',
        category: 'Chat',
        targetTurns: 4,
        seedMessages: [],
        settings: {},
        conversationId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    ];

    const mockCollection = {
      find: vi.fn().mockImplementation((query) => {
        let list = [...mockSynthesisRuns];
        if (query && query.project) {
          list = list.filter(r => r.project === query.project);
        }
        return {
          project: vi.fn().mockReturnThis(),
          sort: vi.fn().mockReturnThis(),
          skip: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue(list),
        };
      }),
      findOne: vi.fn().mockImplementation((query) => {
        const run = mockSynthesisRuns.find(r => r.id === query.id);
        return Promise.resolve(run || null);
      }),
      insertOne: vi.fn().mockImplementation((doc) => {
        mockSynthesisRuns.push(doc);
        return Promise.resolve({ insertedId: 'mock-id-123', acknowledged: true });
      }),
      updateOne: vi.fn().mockImplementation((query, update) => {
        const run = mockSynthesisRuns.find(r => r.id === query.id);
        if (run && update.$set) {
          Object.assign(run, update.$set);
          return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
        }
        return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
      }),
      findOneAndUpdate: vi.fn().mockImplementation((query, update) => {
        const run = mockSynthesisRuns.find(r => r.id === query.id);
        if (run && update.$set) {
          Object.assign(run, update.$set);
          return Promise.resolve(run);
        }
        return Promise.resolve(null);
      }),
      deleteOne: vi.fn().mockImplementation((query) => {
        const index = mockSynthesisRuns.findIndex(r => r.id === query.id);
        if (index !== -1) {
          mockSynthesisRuns.splice(index, 1);
          return Promise.resolve({ deletedCount: 1 });
        }
        return Promise.resolve({ deletedCount: 0 });
      }),
      countDocuments: vi.fn().mockResolvedValue(1),
      distinct: vi.fn().mockResolvedValue(['mock-value']),
      aggregate: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          {
            url: 'http://example.com/image.png',
            mediaType: 'image',
            convId: 'conv-123',
            convTitle: 'Mock Conv Title',
            project: 'test-project',
            username: 'test-user',
            role: 'assistant',
            timestamp: new Date().toISOString(),
            model: 'google/gemini-2.0-flash',
            provider: PROVIDERS.GOOGLE,
            total: 1
          }
        ]),
      }),
    };

    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    };

    vi.spyOn(MongoWrapper, 'getDb').mockReturnValue(mockDb as any);

    // Spy on EmbeddingService.generate to mock it dynamically
    vi.spyOn(EmbeddingService, 'generate').mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      dimensions: 3,
      provider: PROVIDERS.GOOGLE,
      model: 'gemini-embedding-2-preview'
    });
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  describe('MediaRoutes', () => {
    it('GET /media-test', async () => {
      const response = await request(app)
        .get('/media-test?page=1&limit=10&type=image&origin=ai')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body.data[0]).toHaveProperty('url');
    });
  });

  describe('SynthesisRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/synthesis-test')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);
      expect(listResponse.body).toBeInstanceOf(Array);

      // Create
      const createResponse = await request(app)
        .post('/synthesis-test')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .send({
          id: 'synthesis-run-123',
          title: 'Synthesis Run',
          systemPrompt: 'system instructions',
          userPersona: 'user profile',
          category: 'Chat',
          targetTurns: 4,
          seedMessages: [],
          settings: {},
          conversationId: null,
        })
        .expect(200);
      expect(createResponse.body).toHaveProperty('id', 'synthesis-run-123');

      // Get single
      const getResponse = await request(app)
        .get('/synthesis-test/synthesis-run-123')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);
      expect(getResponse.body).toHaveProperty('id', 'synthesis-run-123');

      // Update
      const updateResponse = await request(app)
        .patch('/synthesis-test/synthesis-run-123')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .send({ title: 'Updated Synthesis Title' })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('title', 'Updated Synthesis Title');

      // Delete
      const deleteResponse = await request(app)
        .delete('/synthesis-test/synthesis-run-123')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('TextRoutes', () => {
    it('GET /text-test', async () => {
      const response = await request(app)
        .get('/text-test?page=1&limit=10&origin=ai')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
    });
  });

  describe('EmbedRoutes', () => {
    it('POST /embed with text content', async () => {
      const response = await request(app)
        .post('/embed')
        .send({
          provider: PROVIDERS.GOOGLE,
          text: 'hello world',
          dimensions: 128
        })
        .expect(200);

      expect(response.body).toHaveProperty('embedding');
      expect(response.body).toHaveProperty('dimensions');
    });

    it('POST /embed with images content', async () => {
      const response = await request(app)
        .post('/embed')
        .send({
          provider: PROVIDERS.GOOGLE,
          images: ['data:image/jpeg;base64,123']
        })
        .expect(200);

      expect(response.body).toHaveProperty('embedding');
    });

    it('throws validation error for missing provider', async () => {
      const response = await request(app)
        .post('/embed')
        .send({
          text: 'hello'
        })
        .expect(400);

      expect(response.body.message).toContain('Missing required field');
    });
  });
});

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { app } from './setup.ts';
import request from 'supertest';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import BenchmarkService from '../src/services/BenchmarkService.ts';
import OrchestratorService from '../src/services/OrchestratorService.ts';
import AgenticLoopService from '../src/services/AgenticLoopService.ts';
import FileService from '../src/services/FileService.ts';
import SettingsService from '../src/services/SettingsService.ts';
import * as providersModule from '../src/providers/index.ts';
import { errorHandler } from '../src/utils/errors.ts';

// Import the infrastructure routers
import benchmarkRouter from '../src/routes/BenchmarkRoutes.ts';
import lmStudioRouter from '../src/routes/LmStudioRoutes.ts';
import vramBenchmarksRouter from '../src/routes/VramBenchmarksRoutes.ts';
import orchestratorRouter from '../src/routes/OrchestratorRoutes.ts';
import conversationExecutionRouter from '../src/routes/ConversationExecutionRoute.ts';
import favoritesRouter from '../src/routes/FavoritesRoutes.ts';
import filesRouter from '../src/routes/FilesRoutes.ts';
import statsRouter from '../src/routes/StatsRoutes.ts';
import settingsRouter from '../src/routes/SettingsRoutes.ts';
import ollamaRouter from '../src/routes/OllamaRoutes.ts';

// Mount routers on app
app.use('/benchmark', benchmarkRouter);
app.use('/lm-studio', lmStudioRouter);
app.use('/vram-benchmarks', vramBenchmarksRouter);
app.use('/orchestrator', orchestratorRouter);
app.use('/conversation', conversationExecutionRouter);
app.use('/favorites', favoritesRouter);
app.use('/files', filesRouter);
app.use('/stats', statsRouter);
app.use('/settings', settingsRouter);
app.use('/ollama', ollamaRouter);

// Custom error handler with stack trace logging
app.use((error: any, req: any, res: any, next: any) => {
  console.error('TEST ERROR OCCURRED:', error.stack || error);
  errorHandler(error, req, res, next);
});

// Mock services
vi.mock('../src/services/BenchmarkService.ts', () => ({
  default: {
    list: vi.fn().mockResolvedValue([{ id: 'bench-1', name: 'Test Benchmark' }]),
    getLatestRun: vi.fn().mockResolvedValue({ id: 'run-1', summary: { totalCost: 0.01 } }),
    getRuns: vi.fn().mockResolvedValue([{ id: 'run-1', summary: { totalCost: 0.01 }, models: [{ provider: 'openai', model: 'gpt-4o', passed: true, error: null, thinkingEnabled: false, toolsEnabled: false }] }]),
    getConversationModels: vi.fn().mockReturnValue([{ provider: 'openai', model: 'gpt-4o', label: 'GPT-4o' }]),
    create: vi.fn().mockImplementation((data) => Promise.resolve({ id: 'bench-1', ...data })),
    getById: vi.fn().mockResolvedValue({ id: 'bench-1', name: 'Test Benchmark', prompt: 'test prompt' }),
    remove: vi.fn().mockResolvedValue({ deleted: true }),
    runBenchmark: vi.fn().mockResolvedValue({ id: 'run-1', models: [] }),
    MATCH_MODES: {
      CONTAINS: "contains",
      EXACT: "exact",
      STARTS_WITH: "startsWith",
      REGEX: "regex",
    }
  }
}));

vi.mock('../src/services/OrchestratorService.ts', () => ({
  default: {
    listSubAgents: vi.fn().mockReturnValue([{ agentId: 'sub-1', status: 'running' }]),
    abortSubAgentsByConversation: vi.fn().mockResolvedValue({ aborted: true }),
    getSubAgentStatus: vi.fn().mockReturnValue({ agentId: 'sub-1', status: 'running' })
  }
}));

vi.mock('../src/services/AgenticLoopService.ts', () => ({
  default: {
    resolveApproval: vi.fn().mockReturnValue(true),
    resolveUserQuestion: vi.fn().mockReturnValue(true),
    listHarnesses: vi.fn().mockReturnValue(['react', 'standard'])
  }
}));

vi.mock('../src/services/FileService.ts', () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: 'file-123', size: 1000, contentType: 'image/png' }),
    getFile: vi.fn().mockResolvedValue({
      contentType: 'image/png',
      stream: {
        pipe: vi.fn((responseStream) => {
          responseStream.write(Buffer.from('fake-data'));
          responseStream.end();
        })
      }
    })
  }
}));

const originalGetProvider = providersModule.getProvider;

describe('Infrastructure Routes Integration Tests', () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Dynamically assign functions not covered in setup.ts mocks
    SettingsService.update = vi.fn().mockResolvedValue({ updated: true });

    // Stub collection query helpers
    mockDb = {
      collection: vi.fn().mockImplementation(() => {
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
                project: 'test-project',
                username: 'test-user',
                type: 'model',
                key: 'openai:gpt-4o',
                createdAt: new Date().toISOString(),
                system: { hostname: 'localhost' },
                contextLength: 4096,
                provider: 'openai',
                subAgents: [{ agentId: 'sub-1', status: 'running' }]
              }
            ]),
          }),
          findOne: vi.fn().mockResolvedValue({
            _id: 'mock-id-123',
            id: 'mock-id-123',
            project: 'test-project',
            username: 'test-user',
            type: 'model',
            key: 'openai:gpt-4o',
            subAgents: [{ agentId: 'sub-1', status: 'running' }]
          }),
          countDocuments: vi.fn().mockResolvedValue(1),
          distinct: vi.fn().mockResolvedValue(['default', 'custom']),
          estimatedDocumentCount: vi.fn().mockResolvedValue(1),
          aggregate: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([
              {
                _id: { model: 'gpt-4o', provider: 'openai' },
                totalRequests: 5,
                totalInputTokens: 100,
                totalOutputTokens: 50,
                totalTokens: 150,
                totalCost: 0.005,
                avgLatency: 1.5,
                avgTokensPerSec: 100,
                firstUsed: new Date().toISOString(),
                lastUsed: new Date().toISOString(),
                successCount: 4,
                errorCount: 1,
                // For vram machines
                gpu: 'NVIDIA RTX 4090',
                gpuVramMiB: 24576,
                gpuVendor: 'NVIDIA',
                gpuDriver: '535.104',
                cpu: 'Intel i9',
                ramGiB: 64,
                platform: 'linux',
                benchmarkCount: 10,
                lastRun: new Date().toISOString()
              }
            ]),
          }),
          updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
          deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
        };
      })
    };

    vi.spyOn(MongoWrapper, 'getDb').mockReturnValue(mockDb as any);

    vi.spyOn(providersModule, 'getProvider').mockImplementation((providerName) => {
      const baseProvider = originalGetProvider(providerName);
      return {
        ...baseProvider,
        listModels: vi.fn().mockResolvedValue({
          models: [
            {
              key: 'lm-studio-model',
              id: 'lm-studio-model',
              architecture: 'llama',
              params_string: '7B',
              size_bytes: 1000,
              quantization: { bits_per_weight: 4 },
              loaded_instances: []
            }
          ],
          data: [
            {
              key: 'lm-studio-model',
              id: 'lm-studio-model',
              architecture: 'llama',
              params_string: '7B',
              size_bytes: 1000,
              quantization: { bits_per_weight: 4 },
              loaded_instances: []
            }
          ]
        }),
        ensureModelLoaded: vi.fn().mockResolvedValue({ alreadyLoaded: true }),
        unloadModel: vi.fn().mockResolvedValue({ success: true }),
        loadModel: vi.fn().mockResolvedValue({ success: true }),
      } as any;
    });
  });

  describe('Benchmark Routes', () => {
    it('GET /benchmark - lists all benchmark tests', async () => {
      const response = await request(app)
        .get('/benchmark')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);

      expect(response.body).toHaveProperty('benchmarks');
      expect(response.body).toHaveProperty('count');
    });

    it('GET /benchmark/stats - aggregates performance stats', async () => {
      const response = await request(app)
        .get('/benchmark/stats')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);

      expect(response.body).toHaveProperty('models');
      expect(response.body).toHaveProperty('totalModels');
    });

    it('GET /benchmark/models - lists models available', async () => {
      const response = await request(app)
        .get('/benchmark/models')
        .expect(200);

      expect(response.body).toHaveProperty('models');
    });

    it('GET /benchmark/active-list - lists active benchmark runs', async () => {
      const response = await request(app)
        .get('/benchmark/active-list')
        .expect(200);

      expect(response.body).toHaveProperty('activeIds');
    });

    it('GET /benchmark/presets - gets presets list', async () => {
      const response = await request(app)
        .get('/benchmark/presets')
        .expect(200);

      expect(response.body).toHaveProperty('presets');
    });

    it('POST /benchmark - creates a benchmark', async () => {
      const response = await request(app)
        .post('/benchmark')
        .send({
          name: 'New Benchmark',
          prompt: 'Say hello',
          expectedValue: 'hello'
        })
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(201);

      expect(response.body).toHaveProperty('id');
    });

    it('POST /benchmark - returns 400 on invalid input', async () => {
      await request(app)
        .post('/benchmark')
        .send({})
        .expect(400);
    });

    it('GET /benchmark/:id - retrieves a single benchmark', async () => {
      const response = await request(app)
        .get('/benchmark/bench-1')
        .set('x-project', 'test-project')
        .expect(200);

      expect(response.body).toHaveProperty('id', 'bench-1');
    });

    it('DELETE /benchmark/:id - deletes a benchmark', async () => {
      const response = await request(app)
        .delete('/benchmark/bench-1')
        .set('x-project', 'test-project')
        .expect(200);

      expect(response.body).toHaveProperty('deleted', true);
    });

    it('POST /benchmark/:id/run - starts execution and streams SSE', async () => {
      const response = await request(app)
        .post('/benchmark/bench-1/run')
        .send({ models: [] })
        .expect('Content-Type', /text\/event-stream/)
        .expect(200);

      expect(response.text).toBeDefined();
    });

    it('POST /benchmark/:id/abort - aborts a benchmark', async () => {
      const response = await request(app)
        .post('/benchmark/bench-1/abort')
        .expect(200);

      expect(response.body).toHaveProperty('aborted');
    });

    it('GET /benchmark/:id/active - returns active state', async () => {
      const response = await request(app)
        .get('/benchmark/bench-1/active')
        .expect(200);

      expect(response.body).toHaveProperty('active');
    });
  });

  describe('LM Studio Routes', () => {
    it('GET /lm-studio/models - returns available models', async () => {
      const response = await request(app)
        .get('/lm-studio/models')
        .expect(200);

      expect(response.body).toHaveProperty('data');
    });

    it('POST /lm-studio/load - loads a model', async () => {
      const response = await request(app)
        .post('/lm-studio/load')
        .send({ model: 'lm-studio-model' })
        .expect(200);

      expect(response.body).toHaveProperty('model', 'lm-studio-model');
    });

    it('POST /lm-studio/load-stream - streams loading progress', async () => {
      const response = await request(app)
        .post('/lm-studio/load-stream')
        .send({ model: 'lm-studio-model' })
        .expect('Content-Type', /text\/event-stream/)
        .expect(200);

      expect(response.text).toContain('start');
    });

    it('POST /lm-studio/unload - unloads a model', async () => {
      const response = await request(app)
        .post('/lm-studio/unload')
        .send({ instance_id: 'inst-123' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });

    it('POST /lm-studio/estimate - estimates VRAM', async () => {
      const response = await request(app)
        .post('/lm-studio/estimate')
        .send({ model: 'lm-studio-model' })
        .expect(200);

      expect(response.body).toBeDefined();
    });
  });

  describe('VRAM Benchmarks Routes', () => {
    it('GET /vram-benchmarks - gets VRAM benchmark data', async () => {
      const response = await request(app)
        .get('/vram-benchmarks?settings=default')
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('count');
    });

    it('GET /vram-benchmarks/machines - gets machines distinct logs', async () => {
      const response = await request(app)
        .get('/vram-benchmarks/machines')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });

    it('GET /vram-benchmarks/settings - gets settings options', async () => {
      const response = await request(app)
        .get('/vram-benchmarks/settings')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });

    it('GET /vram-benchmarks/contexts - gets contexts options', async () => {
      const response = await request(app)
        .get('/vram-benchmarks/contexts')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });
  });

  describe('Orchestrator Routes', () => {
    it('GET /orchestrator/sub-agents - returns list of sub-agents', async () => {
      const response = await request(app)
        .get('/orchestrator/sub-agents?conversationId=conv-123')
        .expect(200);

      expect(response.body).toHaveProperty('subAgents');
    });

    it('POST /orchestrator/sub-agents/stop - stops all sub-agents', async () => {
      const response = await request(app)
        .post('/orchestrator/sub-agents/stop')
        .send({ conversationId: 'conv-123' })
        .expect(200);

      expect(response.body).toHaveProperty('aborted', true);
    });

    it('GET /orchestrator/sub-agents/:agentId - returns agent status', async () => {
      const response = await request(app)
        .get('/orchestrator/sub-agents/sub-1')
        .expect(200);

      expect(response.body).toHaveProperty('agentId', 'sub-1');
    });
  });

  describe('Conversation Execution Route', () => {
    it('POST /conversation/approve - resolves approval', async () => {
      const response = await request(app)
        .post('/conversation/approve')
        .send({ conversationId: 'conv-123', approved: true })
        .expect(200);

      expect(response.body).toHaveProperty('ok', true);
    });

    it('POST /conversation/answer - resolves answer', async () => {
      const response = await request(app)
        .post('/conversation/answer')
        .send({ conversationId: 'conv-123', answer: '42' })
        .expect(200);

      expect(response.body).toHaveProperty('ok', true);
    });

    it('POST /conversation - triggers completion', async () => {
      const response = await request(app)
        .post('/conversation?stream=false')
        .send({ provider: 'openai', model: 'gpt-4o', messages: [] })
        .expect(200);

      expect(response.body).toBeDefined();
    });
  });

  describe('Favorites Routes', () => {
    it('GET /favorites - returns favorites list', async () => {
      const response = await request(app)
        .get('/favorites')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });

    it('POST /favorites - registers a favorite', async () => {
      const response = await request(app)
        .post('/favorites')
        .send({ type: 'model', key: 'openai:gpt-4o' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });

    it('DELETE /favorites - deletes a favorite', async () => {
      const response = await request(app)
        .delete('/favorites?type=model&key=openai:gpt-4o')
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });
  });

  describe('Files Routes', () => {
    it('POST /files/upload - uploads a file', async () => {
      const response = await request(app)
        .post('/files/upload')
        .send({ data: 'data:image/png;base64,YWJj' })
        .expect(200);

      expect(response.body).toHaveProperty('ref');
    });

    it('GET /files/:key - retrieves files', async () => {
      const response = await request(app)
        .get('/files/test-file.png')
        .expect(200);

      expect(response.body).toBeDefined();
    });
  });

  describe('Stats Routes', () => {
    it('GET /stats/models - retrieves stats', async () => {
      const response = await request(app)
        .get('/stats/models')
        .set('x-username', 'test-user')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });
  });

  describe('Settings Routes', () => {
    it('GET /settings - returns settings', async () => {
      const response = await request(app)
        .get('/settings')
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it('PUT /settings - updates settings', async () => {
      const response = await request(app)
        .put('/settings')
        .send({ agents: { harness: 'react' } })
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it('GET /settings/defaults - returns default configurations', async () => {
      const response = await request(app)
        .get('/settings/defaults')
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it('GET /settings/harnesses - returns harnesses', async () => {
      const response = await request(app)
        .get('/settings/harnesses')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });
  });

  describe('Ollama Routes', () => {
    it('GET /ollama/models - lists models', async () => {
      const response = await request(app)
        .get('/ollama/models')
        .expect(200);

      expect(response.body).toHaveProperty('data');
    });
  });
});

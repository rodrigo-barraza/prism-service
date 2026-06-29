import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { app } from './setup.ts';
import request from 'supertest';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';

// Import route modules
import configRouter, { localConfigRouter } from '../src/routes/ConfigRoutes.ts';
import workspacesRouter from '../src/routes/WorkspacesRoutes.ts';
import mcpServersRouter from '../src/routes/McpServersRoutes.ts';
import webhookRouter from '../src/routes/WebhookRoutes.ts';
import skillsRouter from '../src/routes/SkillsRoutes.ts';
import scheduledTasksRouter from '../src/routes/ScheduledTasksRoutes.ts';
import promptsRouter from '../src/routes/PromptsRoutes.ts';
import agentRouter from '../src/routes/AgentRoutes.ts';
import agentMemoriesRouter from '../src/routes/AgentMemoriesRoutes.ts';
import rulesRouter from '../src/routes/RulesRoutes.ts';
import memoryRouter from '../src/routes/MemoryRoutes.ts';
import customAgentsRouter from '../src/routes/CustomAgentsRoutes.ts';
import { COLLECTIONS, PROVIDERS } from "../src/constants";

// Mount all routers
app.use('/config-test', configRouter);
app.use('/config-local-test', localConfigRouter);
app.use('/workspaces-test', workspacesRouter);
app.use('/mcp-servers-test', mcpServersRouter);
app.use('/webhooks-test', webhookRouter);
app.use('/skills-test', skillsRouter);
app.use('/scheduled-tasks-test', scheduledTasksRouter);
app.use('/prompts-test', promptsRouter);
app.use('/agent-test', agentRouter);
app.use('/agent-memories-test', agentMemoriesRouter);
app.use('/rules-test', rulesRouter);
app.use('/memory-test', memoryRouter);
app.use('/custom-agents-test', customAgentsRouter);

// Set up mocks
vi.mock('../src/services/ToolOrchestratorService.ts', () => ({
  default: {
    ensureSchemas: vi.fn(),
    refreshSchemas: vi.fn().mockResolvedValue(10),
    getToolSchemas: vi.fn().mockReturnValue([{ name: 'get_weather' }]),
    getClientToolSchemas: vi.fn().mockReturnValue([{ name: 'get_weather' }]),
    refreshWorkspaceRoots: vi.fn(),
    getWorkspaceRoots: vi.fn().mockReturnValue(['/home/rodrigo/development']),
    getStaticRoots: vi.fn().mockReturnValue(['/home/rodrigo/development']),
    updateWorkspaceRoots: vi.fn().mockResolvedValue({ success: true }),
    validateWorkspacePath: vi.fn().mockResolvedValue({ valid: true }),
  }
}));

vi.mock('../src/services/AgentPersonaRegistry.ts', () => ({
  default: {
    list: vi.fn().mockReturnValue([{ id: 'CODING', name: 'Coding Persona' }]),
    get: vi.fn().mockReturnValue({
      id: 'CODING',
      name: 'Coding Persona',
      description: 'Useful for coding',
      availableTools: ['*'],
      enabledByDefaultTools: ['*'],
      coreToolsLocked: true,
    }),
    registerCustom: vi.fn(),
    unregister: vi.fn(),
  }
}));

vi.mock('../src/services/CustomAgentService.ts', () => ({
  default: {
    list: vi.fn().mockResolvedValue([{ id: 'mock-agent-id', name: 'Custom Agent', agentId: 'CUSTOM_AGENT' }]),
    create: vi.fn().mockResolvedValue({ id: 'mock-agent-id', name: 'Custom Agent', agentId: 'CUSTOM_AGENT' }),
    get: vi.fn().mockResolvedValue({ id: 'mock-agent-id', name: 'Custom Agent', agentId: 'CUSTOM_AGENT' }),
    update: vi.fn().mockResolvedValue({ id: 'mock-agent-id', name: 'Custom Agent', agentId: 'CUSTOM_AGENT' }),
    delete: vi.fn().mockResolvedValue(true),
  }
}));

vi.mock('../src/services/local-provider/index.ts', () => ({
  default: {
    discoverModels: vi.fn().mockResolvedValue({
      'local-provider-1': [{ name: 'local-model-1', architecture: 'llama', params_string: '7B', size_bytes: 1000, quantization: { bits_per_weight: 4 } }]
    })
  }
}));

vi.mock('../src/services/MemoryService.ts', () => ({
  default: {
    extractAndStore: vi.fn().mockResolvedValue([{ id: 'memory-1', text: 'extracted' }]),
    search: vi.fn().mockResolvedValue([{ id: 'memory-1', text: 'searched' }]),
    list: vi.fn().mockResolvedValue({ items: [{ id: 'memory-1', text: 'listed' }], hasMore: false }),
    delete: vi.fn().mockResolvedValue(true),
    store: vi.fn().mockResolvedValue({ id: 'memory-1', content: 'stored content', type: 'project' }),
    remove: vi.fn().mockResolvedValue(true),
    discoverCombos: vi.fn().mockResolvedValue([{ project: 'default', agent: 'CODING', count: 10 }]),
  }
}));

vi.mock('../src/services/MemoryConsolidationService.ts', () => ({
  default: {
    getHistory: vi.fn().mockResolvedValue([{ id: 'history-1', project: 'default', timestamp: new Date().toISOString() }]),
    consolidate: vi.fn().mockResolvedValue({ success: true, count: 5 }),
  }
}));

vi.mock('../src/services/ScheduledTaskService.ts', () => ({
  default: {
    listTasks: vi.fn().mockResolvedValue([{ id: 'task-1', name: 'Task One' }]),
    listAllTasks: vi.fn().mockResolvedValue([{ id: 'task-1', name: 'Task One' }]),
    createTask: vi.fn().mockResolvedValue({ id: 'task-1', name: 'Task One' }),
    updateTask: vi.fn().mockResolvedValue({ id: 'task-1', name: 'Task One' }),
    deleteTask: vi.fn().mockResolvedValue(true),
    triggerTask: vi.fn().mockResolvedValue({ success: true, agentConversationId: 'exec-123' }),
  }
}));

vi.mock('../src/services/AgenticLoopService.ts', () => ({
  default: {
    resolveApproval: vi.fn().mockReturnValue(true),
    resolveUserQuestion: vi.fn().mockReturnValue(true),
  }
}));

vi.mock('../src/utils/SseUtilities.ts', () => ({
  handleSseRequest: vi.fn().mockImplementation(async (req, res, params, handler) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {}\n\n');
    res.end();
  }),
  handleJsonRequest: vi.fn().mockImplementation(async (req, res, next, params, handler) => {
    res.json({ ok: true });
  }),
}));

vi.mock('../src/services/WebhookEventBus.ts', () => ({
  default: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getReplayBuffer: vi.fn().mockReturnValue([]),
    listenerCount: 0,
  }
}));

vi.mock('../src/services/MCPClientService.ts', () => ({
  default: {
    getConnectedServers: vi.fn().mockReturnValue([
      { name: 'mock-mcp-server', status: 'connected', toolCount: 2, tools: [], transport: 'stdio', connectedAt: new Date() }
    ]),
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue({ serverName: 'mock-mcp-server', tools: [] }),
    disconnect: vi.fn().mockResolvedValue(true),
  }
}));

describe('Feature Routes Integration Tests', () => {
  let mockDb: any;

  beforeEach(() => {
    // Intercept fetch calls to Tools Service
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlString = String(url);
      if (urlString.includes('/agentic/project/summary')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ files: [] }),
        } as any;
      }
      if (urlString.includes('/agents/download/agent') || urlString.includes('/agents/download/tray-app')) {
        const bodyStream = {
          getReader: () => {
            let readCount = 0;
            return {
              read: async () => {
                if (readCount === 0) {
                  readCount++;
                  return { done: false, value: Buffer.from('mock-agent-data') };
                }
                return { done: true, value: undefined };
              }
            };
          }
        };
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: {
            get: (headerName: string) => headerName.toLowerCase() === 'content-type' ? 'application/octet-stream' : null
          },
          body: bodyStream,
        } as any;
      }
      if (urlString.includes('/admin/config')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({
            workspaceRoots: ['/home/rodrigo/development'],
            staticRoots: ['/home/rodrigo/development']
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any;
    });

    const mockDocument = {
      _id: 'mock-id-123',
      id: 'mock-id-123',
      name: 'mock-mcp-server',
      displayName: 'Mock MCP Server',
      transport: 'stdio',
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      project: 'test-project',
      username: 'test-user',
      title: 'Mock Title',
      content: 'Mock Content',
      agent: 'CODING',
      description: 'Mock Description',
    };

    const mockCollection = {
      find: vi.fn().mockReturnValue({
        project: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([mockDocument]),
      }),
      findOne: vi.fn().mockResolvedValue(mockDocument),
      insertOne: vi.fn().mockResolvedValue({ insertedId: 'mock-id-123', acknowledged: true }),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      findOneAndUpdate: vi.fn().mockImplementation((query, update) => {
        if (update && update.$set) {
          return Promise.resolve({ ...mockDocument, ...update.$set });
        }
        return Promise.resolve(mockDocument);
      }),
      findOneAndDelete: vi.fn().mockResolvedValue(mockDocument),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      countDocuments: vi.fn().mockResolvedValue(1),
      distinct: vi.fn().mockResolvedValue(['mock-value']),
    };

    mockDb = {
      collection: vi.fn().mockReturnValue(mockCollection),
    };

    vi.spyOn(MongoWrapper, 'getDb').mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  describe('ConfigRoutes', () => {
    it('GET /config-test', async () => {
      const response = await request(app)
        .get('/config-test?includeLocal=true')
        .set('x-project', 'test-project')
        .set('x-username', 'test-user')
        .expect(200);

      expect(response.body).toHaveProperty('providers');
      expect(response.body).toHaveProperty('fcSystemPrompt');
    });

    it('GET /config-local-test', async () => {
      const response = await request(app)
        .get('/config-local-test')
        .expect(200);

      expect(response.body).toHaveProperty('models');
    });

    it('GET /config-test/agents', async () => {
      const response = await request(app)
        .get('/config-test/agents')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });

    it('GET /config-test/tools', async () => {
      const response = await request(app)
        .get('/config-test/tools?agent=CODING')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });

    it('POST /config-test/tools/refresh', async () => {
      const response = await request(app)
        .post('/config-test/tools/refresh')
        .expect(200);

      expect(response.body).toHaveProperty('ok', true);
    });

    it('GET /config-test/rate-limits', async () => {
      const response = await request(app)
        .get('/config-test/rate-limits')
        .expect(200);

      expect(response.body).toBeDefined();
    });
  });

  describe('WorkspacesRoutes', () => {
    it('GET /workspaces-test', async () => {
      const response = await request(app)
        .get('/workspaces-test')
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
    });

    it('GET /workspaces-test/full', async () => {
      const response = await request(app)
        .get('/workspaces-test/full')
        .expect(200);

      expect(response.body).toHaveProperty(COLLECTIONS.WORKSPACES);
    });

    it('PUT /workspaces-test', async () => {
      const response = await request(app)
        .put('/workspaces-test')
        .send({ roots: ['/home/rodrigo/development'] })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
    });

    it('POST /workspaces-test/validate', async () => {
      const response = await request(app)
        .post('/workspaces-test/validate')
        .send({ path: '/home/rodrigo/development' })
        .expect(200);

      expect(response.body).toHaveProperty('valid', true);
    });

    it('GET /workspaces-test/tree', async () => {
      const response = await request(app)
        .get('/workspaces-test/tree?path=/home/rodrigo/development')
        .expect(200);

      expect(response.body).toBeDefined();
    });

    it('GET /workspaces-test/download/agent', async () => {
      const response = await request(app)
        .get('/workspaces-test/download/agent')
        .expect(200);

      expect(response.body.toString()).toBe('mock-agent-data');
    });

    it('GET /workspaces-test/download/tray-app', async () => {
      const response = await request(app)
        .get('/workspaces-test/download/tray-app?platform=win-x64')
        .expect(200);

      expect(response.body.toString()).toBe('mock-agent-data');
    });
  });

  describe('McpServersRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/mcp-servers-test')
        .expect(200);
      expect(listResponse.body).toBeInstanceOf(Array);

      // Create
      const createResponse = await request(app)
        .post('/mcp-servers-test')
        .send({
          name: 'mock-mcp-server',
          displayName: 'Mock MCP Server',
          transport: 'stdio',
          command: 'node',
          args: ['-e', 'console.log()'],
          enabled: true,
        })
        .expect(201);
      expect(createResponse.body).toHaveProperty('id');

      // Update
      const updateResponse = await request(app)
        .put('/mcp-servers-test/507f1f77bcf86cd799439011')
        .send({
          displayName: 'Updated Mock MCP Server',
        })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('displayName', 'Updated Mock MCP Server');

      // Connect
      const connectResponse = await request(app)
        .post('/mcp-servers-test/507f1f77bcf86cd799439011/connect')
        .expect(200);
      expect(connectResponse.body).toHaveProperty('success', true);

      // Disconnect
      const disconnectResponse = await request(app)
        .post('/mcp-servers-test/507f1f77bcf86cd799439011/disconnect')
        .expect(200);
      expect(disconnectResponse.body).toHaveProperty('success', true);

      // Delete
      const deleteResponse = await request(app)
        .delete('/mcp-servers-test/507f1f77bcf86cd799439011')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('WebhookRoutes', () => {
    it('CRUD operations', async () => {
      // Create subscription
      const createResponse = await request(app)
        .post('/webhooks-test/subscriptions')
        .send({
          url: 'http://example.com/webhook',
          events: ['*'],
          enabled: true,
        })
        .expect(201);
      expect(createResponse.body.subscription).toHaveProperty('id');

      // List subscriptions
      const listResponse = await request(app)
        .get('/webhooks-test/subscriptions')
        .expect(200);
      expect(listResponse.body).toHaveProperty('subscriptions');

      // Update subscription
      const updateResponse = await request(app)
        .patch(`/webhooks-test/subscriptions/${createResponse.body.subscription.id}`)
        .send({ enabled: false })
        .expect(200);
      expect(updateResponse.body.subscription).toHaveProperty('enabled', false);

      // Delete subscription
      const deleteResponse = await request(app)
        .delete(`/webhooks-test/subscriptions/${createResponse.body.subscription.id}`)
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('deleted', true);
    });

    it('supports changes event stream SSE', () => {
      return new Promise<void>((resolve, reject) => {
        const reqInstance = request(app)
          .get('/webhooks-test/requests/stream')
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

  describe('SkillsRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/skills-test')
        .expect(200);
      expect(listResponse.body).toBeInstanceOf(Array);

      // Create
      const createResponse = await request(app)
        .post('/skills-test')
        .send({
          name: 'test-skill',
          description: 'test skill description',
          content: 'console.log("hello")',
          enabled: true,
        })
        .expect(201);
      expect(createResponse.body).toHaveProperty('id');

      // Update
      const updateResponse = await request(app)
        .put('/skills-test/507f1f77bcf86cd799439011')
        .send({
          name: 'updated-skill',
        })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('id');

      // Delete
      const deleteResponse = await request(app)
        .delete('/skills-test/507f1f77bcf86cd799439011')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('ScheduledTasksRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/scheduled-tasks-test')
        .expect(200);
      expect(listResponse.body).toBeInstanceOf(Array);

      // List all
      const listAllResponse = await request(app)
        .get('/scheduled-tasks-test/all')
        .expect(200);
      expect(listAllResponse.body).toBeInstanceOf(Array);

      // Create
      const createResponse = await request(app)
        .post('/scheduled-tasks-test')
        .send({
          name: 'test-task',
          prompt: 'run prompt',
          provider: PROVIDERS.ANTHROPIC,
          model: 'claude-3-5-sonnet',
          scheduleType: 'cron',
          cronExpression: '0 0 * * *',
        })
        .expect(201);
      expect(createResponse.body).toHaveProperty('id');

      // Update
      const updateResponse = await request(app)
        .patch('/scheduled-tasks-test/task-1')
        .send({ name: 'updated-task' })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('id');

      // Trigger
      const triggerResponse = await request(app)
        .post('/scheduled-tasks-test/task-1/trigger')
        .send({})
        .expect(200);
      expect(triggerResponse.body).toHaveProperty('success', true);

      // Delete
      const deleteResponse = await request(app)
        .delete('/scheduled-tasks-test/task-1')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('PromptsRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/prompts-test?page=1&limit=10')
        .expect(200);
      expect(listResponse.body).toHaveProperty('data');

      // Create
      const createResponse = await request(app)
        .post('/prompts-test')
        .send({
          title: 'test-prompt',
          content: 'prompt content',
          tags: ['test'],
          color: '#ffffff',
        })
        .expect(201);
      expect(createResponse.body).toHaveProperty('id');

      // Get single
      const getResponse = await request(app)
        .get(`/prompts-test/${createResponse.body.id}`)
        .expect(200);
      expect(getResponse.body).toHaveProperty('id');

      // Update
      const updateResponse = await request(app)
        .patch(`/prompts-test/${createResponse.body.id}`)
        .send({ title: 'updated-prompt' })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('id');

      // Delete
      const deleteResponse = await request(app)
        .delete(`/prompts-test/${createResponse.body.id}`)
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('AgentRoutes', () => {
    it('Approve endpoint', async () => {
      const response = await request(app)
        .post('/agent-test/approve')
        .send({ conversationId: 'conv-123', approved: true })
        .expect(200);

      expect(response.body).toHaveProperty('ok', true);
    });

    it('Answer endpoint', async () => {
      const response = await request(app)
        .post('/agent-test/answer')
        .send({ conversationId: 'conv-123', answer: 'my answer' })
        .expect(200);

      expect(response.body).toHaveProperty('ok', true);
    });

    it('Streaming agent endpoint', async () => {
      const response = await request(app)
        .post('/agent-test?stream=false')
        .send({ messages: [] })
        .expect(200);

      expect(response.body).toHaveProperty('ok', true);
    });
  });

  describe('AgentMemoriesRoutes', () => {
    it('CRUD operations', async () => {
      // Create
      const createResponse = await request(app)
        .post('/agent-memories-test')
        .send({ content: 'some memory content' })
        .expect(200);
      expect(createResponse.body).toHaveProperty('id');

      // List
      const listResponse = await request(app)
        .get('/agent-memories-test?limit=10')
        .expect(200);
      expect(listResponse.body).toBeDefined();

      // Discover combos
      const discoverResponse = await request(app)
        .get('/agent-memories-test/discover')
        .expect(200);
      expect(discoverResponse.body).toHaveProperty('combos');

      // Consolidation history
      const historyResponse = await request(app)
        .get('/agent-memories-test/consolidation-history')
        .expect(200);
      expect(historyResponse.body).toHaveProperty('history');

      // Consolidate trigger
      const consolidateResponse = await request(app)
        .post('/agent-memories-test/consolidate')
        .send({ agent: 'CODING' })
        .expect(200);
      expect(consolidateResponse.body).toHaveProperty('success', true);

      // Delete
      const deleteResponse = await request(app)
        .delete('/agent-memories-test/507f1f77bcf86cd799439011')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('RulesRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/rules-test')
        .expect(200);
      expect(listResponse.body).toBeInstanceOf(Array);

      // Create
      const createResponse = await request(app)
        .post('/rules-test')
        .send({
          agent: 'CODING',
          name: 'Test Rule',
          description: 'Rule Description',
          content: 'Rule Content',
          enabled: true,
        })
        .expect(201);
      expect(createResponse.body).toHaveProperty('id');

      // Update
      const updateResponse = await request(app)
        .put('/rules-test/507f1f77bcf86cd799439011')
        .send({
          name: 'Updated Rule Name',
        })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('id');

      // Delete
      const deleteResponse = await request(app)
        .delete('/rules-test/507f1f77bcf86cd799439011')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });

  describe('MemoryRoutes', () => {
    it('CRUD and search operations', async () => {
      // Extract
      const extractResponse = await request(app)
        .post('/memory-test/extract')
        .send({
          guildId: '123',
          messages: ['hello'],
          participants: ['user-1'],
        })
        .expect(200);
      expect(extractResponse.body).toHaveProperty(COLLECTIONS.MEMORIES);

      // Search
      const searchResponse = await request(app)
        .post('/memory-test/search')
        .send({
          guildId: '123',
          queryText: 'query',
        })
        .expect(200);
      expect(searchResponse.body).toHaveProperty(COLLECTIONS.MEMORIES);

      // List
      const listResponse = await request(app)
        .get('/memory-test/list/123/user-1')
        .expect(200);
      expect(listResponse.body).toHaveProperty('items');

      // Delete
      const deleteResponse = await request(app)
        .delete('/memory-test/507f1f77bcf86cd799439011')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('deleted', true);
    });
  });

  describe('CustomAgentsRoutes', () => {
    it('CRUD operations', async () => {
      // List
      const listResponse = await request(app)
        .get('/custom-agents-test')
        .expect(200);
      expect(listResponse.body).toBeInstanceOf(Array);

      // Create
      const createResponse = await request(app)
        .post('/custom-agents-test')
        .send({
          name: 'Custom Agent',
        })
        .expect(201);
      expect(createResponse.body).toHaveProperty('id');

      // Update
      const updateResponse = await request(app)
        .put('/custom-agents-test/507f1f77bcf86cd799439011')
        .send({
          name: 'Updated Custom Agent',
        })
        .expect(200);
      expect(updateResponse.body).toHaveProperty('id');

      // Delete
      const deleteResponse = await request(app)
        .delete('/custom-agents-test/507f1f77bcf86cd799439011')
        .expect(200);
      expect(deleteResponse.body).toHaveProperty('success', true);
    });
  });
});

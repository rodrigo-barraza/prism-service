import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import adminConversationRouter from '../src/routes/admin/AdminConversationRoutes.ts';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import { COLLECTIONS } from '../src/constants.ts';

// Mount the admin conversations router at /admin/conversations
app.use('/admin/conversations', adminConversationRouter);

// Mock services that are used by the admin routes
vi.mock('../src/services/ToolOrchestratorService.ts', () => ({
  default: {
    getWorkspaceRoots: vi.fn().mockReturnValue(['/home/rodrigo/development']),
  },
}));

vi.mock('../src/services/AgentPersonaRegistry.ts', () => ({
  default: {
    list: vi.fn().mockReturnValue([{ id: 'OMNI', name: 'Omni' }]),
  },
}));

vi.mock('../src/services/BenchmarkService.ts', () => ({
  default: {
    activeGenerationCount: 0,
  },
}));

vi.mock('../src/services/ActiveGenerationTracker.ts', () => ({
  default: {
    count: 0,
  },
}));

vi.mock('../src/services/ChangeStreamService.ts', () => ({
  default: {
    available: false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
}));

describe('AdminConversationRoutes Integration', () => {
  const agent = supertest(app);
  let mockDirectConvs: any[] = [];
  let mockAgentConvs: any[] = [];
  let mockRequests: any[] = [];

  const createMockQuery = (list: any[]) => {
    const chain: any = {
      project: () => chain,
      sort: () => chain,
      limit: () => chain,
      skip: () => chain,
      projectOption: null,
      sortOption: null,
      limitOption: null,
      skipOption: null,
      toArray: async () => {
        let resultList = [...list];
        if (chain.skipOption !== null || chain.limitOption !== null) {
          const start = chain.skipOption || 0;
          const end = chain.limitOption !== null ? start + chain.limitOption : undefined;
          resultList = resultList.slice(start, end);
        }
        return resultList;
      },
    };
    chain.project = (projectOpt: any) => {
      chain.projectOption = projectOpt;
      return chain;
    };
    chain.sort = (sortOpt: any) => {
      chain.sortOption = sortOpt;
      return chain;
    };
    chain.limit = (limitOpt: any) => {
      chain.limitOption = limitOpt;
      return chain;
    };
    chain.skip = (skipOpt: any) => {
      chain.skipOption = skipOpt;
      return chain;
    };
    return chain;
  };

  const mockDb = {
    collection: (collectionName: string) => {
      if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
        return {
          find: (query: any) => {
            let list = [...mockDirectConvs];
            if (query && query.project) {
              list = list.filter(c => c.project === query.project);
            }
            if (query && query.username) {
              list = list.filter(c => c.username === query.username);
            }
            return createMockQuery(list);
          },
          findOne: async (query: any) => {
            return mockDirectConvs.find(c => c.id === query.id) || null;
          },
          countDocuments: async (query: any) => {
            let list = [...mockDirectConvs];
            if (query && query.isGenerating) {
              list = list.filter(c => c.isGenerating === true);
            }
            if (query && query.project) {
              list = list.filter(c => c.project === query.project);
            }
            return list.length;
          },
          estimatedDocumentCount: async () => mockDirectConvs.length,
          distinct: async (field: string) => {
            return [...new Set(mockDirectConvs.map(c => c[field]))];
          },
        };
      }
      if (collectionName === COLLECTIONS.AGENT_CONVERSATIONS) {
        return {
          find: (query: any) => {
            let list = [...mockAgentConvs];
            if (query && query.project) {
              list = list.filter(c => c.project === query.project);
            }
            if (query && query.username) {
              list = list.filter(c => c.username === query.username);
            }
            return createMockQuery(list);
          },
          findOne: async (query: any) => {
            return mockAgentConvs.find(c => c.id === query.id) || null;
          },
          countDocuments: async (query: any) => {
            let list = [...mockAgentConvs];
            if (query && query.isGenerating) {
              list = list.filter(c => c.isGenerating === true);
            }
            if (query && query.project) {
              list = list.filter(c => c.project === query.project);
            }
            return list.length;
          },
          estimatedDocumentCount: async () => mockAgentConvs.length,
          distinct: async (field: string) => {
            return [...new Set(mockAgentConvs.map(c => c[field]))];
          },
        };
      }
      if (collectionName === COLLECTIONS.REQUESTS) {
        return {
          find: (query: any) => {
            let list = [...mockRequests];
            if (query && query.$or) {
              const directIds = query.$or.find((q: any) => q.conversationId)?.[`conversationId`]?.[`$in`] || [];
              const agentIds = query.$or.find((q: any) => q.agentConversationId)?.[`agentConversationId`]?.[`$in`] || [];
              list = list.filter(r => directIds.includes(r.conversationId) || agentIds.includes(r.agentConversationId));
            }
            return createMockQuery(list);
          },
          distinct: async (field: string) => {
            return [...new Set(mockRequests.map(r => r[field]))];
          },
        };
      }
      return {
        find: () => createMockQuery([]),
        findOne: async () => null,
      };
    },
  };

  beforeEach(() => {
    mockDirectConvs = [
      {
        id: 'direct-1',
        project: 'project-a',
        username: 'user-1',
        title: 'Direct Conv One',
        totalCost: 0.01,
        updatedAt: new Date().toISOString(),
      },
    ];

    mockAgentConvs = [
      {
        id: 'agent-1',
        project: 'project-b',
        username: 'user-2',
        title: 'Agent Conv One',
        totalCost: 0.05,
        updatedAt: new Date().toISOString(),
      },
    ];

    mockRequests = [
      {
        conversationId: 'direct-1',
        model: 'gemini-3.5-flash',
        inputTokens: 100,
        outputTokens: 50,
        totalTime: 1.2,
        estimatedCost: 0.01,
        tokensPerSec: 125,
      },
      {
        agentConversationId: 'agent-1',
        model: 'gemini-3-flash-preview',
        inputTokens: 200,
        outputTokens: 100,
        totalTime: 2.5,
        estimatedCost: 0.04,
        tokensPerSec: 80,
      },
    ];

    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
    vi.clearAllMocks();
  });

  describe('GET /admin/conversations', () => {
    it('should retrieve list of enriched conversations', async () => {
      const response = await agent
        .get('/admin/conversations?limit=10')
        .set('x-project', 'test')
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.total).toBe(2);

      const direct = response.body.data.find((c: any) => c.type === 'direct');
      expect(direct.title).toBe('Direct Conv One');
      expect(direct.inputTokens).toBe(100);
      expect(direct.totalLatency).toBe(1.2);

      const agentConv = response.body.data.find((c: any) => c.type === 'agent');
      expect(agentConv.title).toBe('Agent Conv One');
      expect(agentConv.totalCost).toBe(0.05);
    });

    it('should apply filters to the conversation list', async () => {
      const response = await agent
        .get('/admin/conversations?project=project-a')
        .set('x-project', 'test')
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe('direct-1');
    });
  });

  describe('GET /admin/conversations/filters', () => {
    it('should return distinct lists of metadata for dropdown filters', async () => {
      const response = await agent
        .get('/admin/conversations/filters')
        .set('x-project', 'test')
        .expect(200);

      expect(response.body.projects).toContain('project-a');
      expect(response.body.usernames).toContain('user-1');
      expect(response.body.models).toContain('gemini-3.5-flash');
      expect(response.body.workspaces).toEqual(['/home/rodrigo/development']);
      expect(response.body.agents).toHaveLength(1);
      expect(response.body.agents[0].id).toBe('OMNI');
    });
  });

  describe('GET /admin/conversations/stats', () => {
    it('should return system stats snapshot', async () => {
      const response = await agent
        .get('/admin/conversations/stats')
        .set('x-project', 'test')
        .expect(200);

      expect(response.body.generatingCount).toBe(0);
      expect(response.body.recentCount).toBe(1);
    });
  });

  describe('GET /admin/conversations/stream (SSE)', () => {
    it('should establish an event stream for real-time stats updates', async () => {
      const streamReq = agent
        .get('/admin/conversations/stream')
        .set('x-project', 'test')
        .buffer(false);

      const streamResponse = await new Promise<any>((resolve) => {
        streamReq.on('response', (res) => {
          resolve(res);
        });
        streamReq.on('error', () => {
          // Gracefully ignore abort error
        });
        streamReq.end();
      });

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers['content-type']).toContain('text/event-stream');

      streamResponse.on('error', () => {});
      if (streamResponse.req) {
        streamResponse.req.on('error', () => {});
      }

      streamReq.abort();
    });
  });

  describe('GET /admin/conversations/:id', () => {
    it('should return details of single direct conversation', async () => {
      const response = await agent
        .get('/admin/conversations/direct-1')
        .set('x-project', 'test')
        .expect(200);

      expect(response.body.id).toBe('direct-1');
      expect(response.body.type).toBe('direct');
    });

    it('should return details of single agent conversation', async () => {
      const response = await agent
        .get('/admin/conversations/agent-1')
        .set('x-project', 'test')
        .expect(200);

      expect(response.body.id).toBe('agent-1');
      expect(response.body.type).toBe('agent');
    });

    it('should return 404 if conversation is not found', async () => {
      const response = await agent
        .get('/admin/conversations/nonexistent')
        .set('x-project', 'test')
        .expect(404);

      expect(response.body.error).toBe('Conversation not found');
    });
  });
});

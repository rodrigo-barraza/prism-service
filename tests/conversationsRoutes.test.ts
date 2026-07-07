import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import conversationsRouter from '#src/routes/ConversationsRoutes';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import { COLLECTIONS } from '#src/constants';
import ConversationService from '#src/services/ConversationService';

// Mount the conversations router
app.use('/conversations', conversationsRouter);

describe('ConversationsRoutes Integration', () => {
  const agent = supertest(app);
  let mockConversations: any[] = [];
  let mockAgentConversations: any[] = [];

  // Helper to create a chainable MongoDB mock find query
  const createMockQuery = (list: any[]) => {
    const chain: any = {
      project: () => chain,
      sort: () => chain,
      limit: () => chain,
      skip: () => chain,
      toArray: async () => list,
    };
    return chain;
  };

  const mockDb = {
    collection: (name: string) => {
      if (name === COLLECTIONS.MODEL_CONVERSATIONS) {
        return {
          find: (query: any) => {
            let list = [...mockConversations];
            if (query && query.id) {
              list = list.filter(c => c.id === query.id);
            }
            if (query && query.parentConversationId) {
              if (query.parentConversationId.$in) {
                const frontierIds = query.parentConversationId.$in;
                list = list.filter(c => frontierIds.includes(c.parentConversationId));
              } else {
                list = list.filter(c => c.parentConversationId === query.parentConversationId);
              }
            }
            return createMockQuery(list);
          },
          findOne: async (query: any) => {
            return mockConversations.find(c => c.id === query.id) || null;
          },
          updateOne: async (query: any, update: any) => {
            const index = mockConversations.findIndex(c => c.id === query.id);
            if (index === -1) return { matchedCount: 0 };
            if (update.$set) {
              mockConversations[index] = { ...mockConversations[index], ...update.$set };
            }
            return { matchedCount: 1 };
          },
          deleteOne: async (query: any) => {
            const index = mockConversations.findIndex(c => c.id === query.id);
            if (index === -1) return { deletedCount: 0 };
            mockConversations.splice(index, 1);
            return { deletedCount: 1 };
          },
          deleteMany: async (query: any) => {
            let deletedCount = 0;
            if (query && query.id && query.id.$in) {
              const idsToDelete = query.id.$in;
              const originalLength = mockConversations.length;
              mockConversations = mockConversations.filter(c => !idsToDelete.includes(c.id));
              deletedCount = originalLength - mockConversations.length;
            } else if (query && query.id) {
              const originalLength = mockConversations.length;
              mockConversations = mockConversations.filter(c => c.id !== query.id);
              deletedCount = originalLength - mockConversations.length;
            } else {
              deletedCount = mockConversations.length;
              mockConversations = [];
            }
            return { deletedCount };
          },
          countDocuments: async (query: any) => {
            return mockConversations.filter(c => c.id === query.id).length;
          },
        };
      }
      if (name === COLLECTIONS.AGENT_CONVERSATIONS) {
        return {
          find: (query: any) => {
            let list = [...mockAgentConversations];
            if (query && query.id) {
              list = list.filter(c => c.id === query.id);
            }
            if (query && query.parentConversationId) {
              if (query.parentConversationId.$in) {
                const frontierIds = query.parentConversationId.$in;
                list = list.filter(c => frontierIds.includes(c.parentConversationId));
              } else {
                list = list.filter(c => c.parentConversationId === query.parentConversationId);
              }
            }
            return createMockQuery(list);
          },
          findOne: async (query: any) => {
            return mockAgentConversations.find(c => c.id === query.id) || null;
          },
          updateOne: async (query: any, update: any) => {
            const index = mockAgentConversations.findIndex(c => c.id === query.id);
            if (index === -1) return { matchedCount: 0 };
            if (update.$set) {
              mockAgentConversations[index] = { ...mockAgentConversations[index], ...update.$set };
            }
            return { matchedCount: 1 };
          },
          deleteOne: async (query: any) => {
            const index = mockAgentConversations.findIndex(c => c.id === query.id);
            if (index === -1) return { deletedCount: 0 };
            mockAgentConversations.splice(index, 1);
            return { deletedCount: 1 };
          },
          deleteMany: async (query: any) => {
            let deletedCount = 0;
            if (query && query.id && query.id.$in) {
              const idsToDelete = query.id.$in;
              const originalLength = mockAgentConversations.length;
              mockAgentConversations = mockAgentConversations.filter(c => !idsToDelete.includes(c.id));
              deletedCount = originalLength - mockAgentConversations.length;
            } else if (query && query.id) {
              const originalLength = mockAgentConversations.length;
              mockAgentConversations = mockAgentConversations.filter(c => c.id !== query.id);
              deletedCount = originalLength - mockAgentConversations.length;
            } else {
              deletedCount = mockAgentConversations.length;
              mockAgentConversations = [];
            }
            return { deletedCount };
          },
          countDocuments: async (query: any) => {
            return mockAgentConversations.filter(c => c.id === query.id).length;
          },
        };
      }
      if (name === COLLECTIONS.REQUESTS) {
        return {
          aggregate: () => createMockQuery([]),
        };
      }
      if (name === COLLECTIONS.WORKFLOWS) {
        return {
          find: () => createMockQuery([]),
        };
      }
      return {
        find: () => createMockQuery([]),
        findOne: async () => null,
      };
    },
  };

  beforeEach(() => {
    mockConversations = [
      {
        id: 'conv-1',
        project: 'test',
        username: 'testuser',
        title: 'Conversation One',
        updatedAt: new Date().toISOString(),
        messages: [],
      },
    ];
    mockAgentConversations = [
      {
        id: 'agent-conv-1',
        project: 'test',
        username: 'testuser',
        title: 'Agent Conversation One',
        updatedAt: new Date().toISOString(),
        messages: [],
      },
    ];
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  describe('GET /conversations', () => {
    it('should list conversations with pagination', async () => {
      const response = await agent
        .get('/conversations?limit=10')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(200);

      expect(response.body.items).toHaveLength(2);
      expect(response.body.hasMore).toBe(false);
    });
  });

  describe('GET /conversations/:id', () => {
    it('should return a direct conversation if it exists', async () => {
      const response = await agent
        .get('/conversations/conv-1')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(200);

      expect(response.body.id).toBe('conv-1');
      expect(response.body.type).toBe('direct');
    });

    it('should return an agent conversation if it exists', async () => {
      vi.mocked(ConversationService.getConversationStats).mockResolvedValue({
        totalCost: 0.05,
        totalRequests: 2,
        avgLatency: 1.5,
        successCount: 2,
        errorCount: 0,
      } as any);

      const response = await agent
        .get('/conversations/agent-conv-1')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(200);

      expect(response.body.id).toBe('agent-conv-1');
      expect(response.body.type).toBe('agent');
    });

    it('should return 404 if conversation does not exist', async () => {
      const response = await agent
        .get('/conversations/nonexistent')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(404);

      expect(response.body.error).toBe('Conversation not found');
    });
  });

  describe('PATCH /conversations/:id', () => {
    it('should update title and return the updated conversation', async () => {
      const response = await agent
        .patch('/conversations/conv-1')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({ title: 'Updated Title' })
        .expect(200);

      expect(response.body.title).toBe('Updated Title');
      expect(mockConversations[0].title).toBe('Updated Title');
    });

    it('should return 404 if patching nonexistent conversation', async () => {
      await agent
        .patch('/conversations/nonexistent')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({ title: 'Updated Title' })
        .expect(404);
    });
  });

  describe('DELETE /conversations/:id', () => {
    it('should delete a direct conversation', async () => {
      await agent
        .delete('/conversations/conv-1')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(200);

      expect(mockConversations).toHaveLength(0);
    });

    it('should return 404 when deleting nonexistent conversation', async () => {
      await agent
        .delete('/conversations/nonexistent')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(404);
    });

    it('should delete a parent conversation and cascade delete its descendants', async () => {
      mockConversations = [
        {
          id: 'conv-1',
          project: 'test',
          username: 'testuser',
          title: 'Parent',
          updatedAt: new Date().toISOString(),
          messages: [],
        },
        {
          id: 'conv-child-1',
          parentConversationId: 'conv-1',
          project: 'test',
          username: 'testuser',
          title: 'Child Model',
          updatedAt: new Date().toISOString(),
          messages: [],
        }
      ];

      mockAgentConversations = [
        {
          id: 'agent-conv-child-2',
          parentConversationId: 'conv-1',
          project: 'test',
          username: 'testuser',
          title: 'Child Agent',
          updatedAt: new Date().toISOString(),
          messages: [],
        },
        {
          id: 'agent-conv-grandchild-3',
          parentConversationId: 'agent-conv-child-2',
          project: 'test',
          username: 'testuser',
          title: 'Grandchild Agent',
          updatedAt: new Date().toISOString(),
          messages: [],
        }
      ];

      const response = await agent
        .delete('/conversations/conv-1')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .expect(200);

      expect(response.body.descendantsDeleted).toBe(3);
      expect(mockConversations).toHaveLength(0);
      expect(mockAgentConversations).toHaveLength(0);
    });
  });

  describe('POST /conversations/:id/messages', () => {
    it('should append messages and return updated conversation', async () => {
      vi.mocked(ConversationService.appendMessages).mockResolvedValue({
        id: 'conv-1',
        project: 'test',
        username: 'testuser',
        messages: [],
      } as any);

      const response = await agent
        .post('/conversations/conv-1/messages')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          messages: [{ role: 'user', content: 'new message' }],
        })
        .expect(200);

      expect(response.body.id).toBe('conv-1');
    });
  });
});

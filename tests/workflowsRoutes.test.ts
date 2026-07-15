import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { ObjectId } from 'mongodb';
import { app } from './setup.ts';
import workflowsRouter from '#src/routes/WorkflowsRoutes';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import WorkflowExecutionService from '#src/services/WorkflowExecutionService';
import { COLLECTIONS, MODALITY_TYPES } from '#src/constants';

// Mount the workflows router
app.use('/workflows', workflowsRouter);

vi.mock('#src/services/WorkflowExecutionService', () => ({
  default: {
    executeWorkflow: vi.fn(),
  },
}));

describe('WorkflowsRoutes Integration', () => {
  const agent = supertest(app);
  let mockWorkflows: any[] = [];
  let mockConversations: any[] = [];

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
    collection: (collectionName: string) => {
      if (collectionName === COLLECTIONS.WORKFLOWS) {
        return {
          find: (query: any) => {
            let list = [...mockWorkflows];
            if (query && query.source && query.source !== 'all') {
              list = list.filter(w => w.source === query.source);
            }
            return createMockQuery(list);
          },
          findOne: async (query: any) => {
            if (query._id) {
              return mockWorkflows.find(w => w._id.toString() === query._id.toString()) || null;
            }
            if (query.workflowId) {
              return mockWorkflows.find(w => w.workflowId === query.workflowId) || null;
            }
            return null;
          },
          insertOne: async (document: any) => {
            const insertedId = new ObjectId();
            const newDocument = { ...document, _id: insertedId };
            mockWorkflows.push(newDocument);
            return { insertedId };
          },
          updateOne: async (query: any, update: any) => {
            let workflow = null;
            if (query._id) {
              workflow = mockWorkflows.find(w => w._id.toString() === query._id.toString());
            } else if (query.workflowId) {
              workflow = mockWorkflows.find(w => w.workflowId === query.workflowId);
            }
            if (!workflow) return { matchedCount: 0 };
            if (update.$set) {
              Object.assign(workflow, update.$set);
            }
            if (update.$push) {
              for (const [key, value] of Object.entries(update.$push)) {
                if (!workflow[key]) {
                  workflow[key] = [];
                }
                const eachValue = value as any;
                if (eachValue && eachValue.$each) {
                  workflow[key].push(...eachValue.$each);
                } else {
                  workflow[key].push(eachValue);
                }
              }
            }
            return { matchedCount: 1 };
          },
          deleteOne: async (query: any) => {
            let index = -1;
            if (query._id) {
              index = mockWorkflows.findIndex(w => w._id.toString() === query._id.toString());
            } else if (query.workflowId) {
              index = mockWorkflows.findIndex(w => w.workflowId === query.workflowId);
            }
            if (index === -1) return { deletedCount: 0 };
            mockWorkflows.splice(index, 1);
            return { deletedCount: 1 };
          },
        };
      }
      if (collectionName === COLLECTIONS.MODEL_CONVERSATIONS) {
        return {
          find: (query: any) => {
            let list = [...mockConversations];
            if (query && query.id && query.id.$in) {
              list = list.filter(c => query.id.$in.includes(c.id));
            }
            return createMockQuery(list);
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
    mockWorkflows = [
      {
        _id: new ObjectId(),
        workflowId: 'workflow-1',
        name: 'Test Workflow',
        source: 'prism-client',
        nodes: [
          { id: 'node-1', nodeType: 'input', outputTypes: [MODALITY_TYPES.TEXT], content: 'hello' },
          { id: 'node-2', nodeType: 'viewer', inputTypes: [MODALITY_TYPES.TEXT], receivedOutputs: { text: 'hello' } },
        ],
        edges: [],
        totalCost: 0,
        updatedAt: new Date().toISOString(),
      },
    ];
    mockConversations = [
      { id: 'conv-1', totalCost: 0.02 },
      { id: 'conv-2', totalCost: 0.03 },
    ];
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
    vi.clearAllMocks();
  });

  describe('GET /workflows', () => {
    it('should return list of workflows', async () => {
      const response = await agent
        .get('/workflows')
        .set('x-project', 'test-project')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].workflowId).toBe('workflow-1');
    });
  });

  describe('GET /workflows/:id', () => {
    it('should return single workflow by ObjectId', async () => {
      const targetId = mockWorkflows[0]._id.toString();
      const response = await agent
        .get(`/workflows/${targetId}`)
        .set('x-project', 'test-project')
        .expect(200);

      expect(response.body.workflowId).toBe('workflow-1');
    });

    it('should return single workflow by string workflowId fallback', async () => {
      const response = await agent
        .get('/workflows/workflow-1')
        .set('x-project', 'test-project')
        .expect(200);

      expect(response.body.name).toBe('Test Workflow');
    });

    it('should return 404 if workflow not found', async () => {
      const response = await agent
        .get('/workflows/nonexistent-id')
        .set('x-project', 'test-project')
        .expect(404);

      expect(response.body.error).toBe('Workflow not found');
    });
  });

  describe('POST /workflows', () => {
    it('should create new workflow with pre-built graph', async () => {
      const newWorkflow = {
        name: 'New Workflow',
        nodes: [{ id: 'node-1', nodeType: 'input', outputTypes: [MODALITY_TYPES.TEXT] }],
        edges: [],
        conversationIds: ['conv-1', 'conv-2'],
      };

      const response = await agent
        .post('/workflows')
        .set('x-project', 'test-project')
        .send(newWorkflow)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.id).toBeDefined();

      const saved = mockWorkflows.find(w => w._id.toString() === response.body.id);
      expect(saved.name).toBe('New Workflow');
      expect(saved.totalCost).toBe(0.05); // Sum of conv-1 and conv-2 costs
    });
  });

  describe('PUT /workflows/:id', () => {
    it('should update workflow nodes, edges and metadata', async () => {
      const updateData = {
        name: 'Updated Name',
        nodes: [{ id: 'node-3', nodeType: 'viewer', inputTypes: [MODALITY_TYPES.TEXT] }],
        edges: [],
      };

      const targetId = mockWorkflows[0]._id.toString();
      const response = await agent
        .put(`/workflows/${targetId}`)
        .set('x-project', 'test-project')
        .send(updateData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockWorkflows[0].name).toBe('Updated Name');
      expect(mockWorkflows[0].nodeCount).toBe(1);
    });

    it('should return 404 when updating non-existent workflow', async () => {
      await agent
        .put('/workflows/nonexistent')
        .set('x-project', 'test-project')
        .send({ name: 'Updated Name' })
        .expect(404);
    });
  });

  describe('PATCH /workflows/:id/conversations', () => {
    it('should append conversation IDs and recompute cost', async () => {
      const targetId = mockWorkflows[0]._id.toString();
      const response = await agent
        .patch(`/workflows/${targetId}/conversations`)
        .set('x-project', 'test-project')
        .send({ conversationIds: ['conv-1', 'conv-2'] })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockWorkflows[0].conversationIds).toEqual(['conv-1', 'conv-2']);
      expect(mockWorkflows[0].totalCost).toBe(0.05);
    });
  });

  describe('DELETE /workflows/:id', () => {
    it('should delete workflow', async () => {
      const targetId = mockWorkflows[0]._id.toString();
      await agent
        .delete(`/workflows/${targetId}`)
        .set('x-project', 'test-project')
        .expect(200);

      expect(mockWorkflows).toHaveLength(0);
    });
  });

  describe('Execution & Status Endpoints', () => {
    it('should return 404 for POST /run on non-existent workflow', async () => {
      await agent
        .post('/workflows/nonexistent/run')
        .set('x-project', 'test-project')
        .expect(404);
    });

    it('should trigger execution and stream SSE events', async () => {
      const targetId = mockWorkflows[0]._id.toString();

      vi.mocked(WorkflowExecutionService.executeWorkflow).mockImplementation(
        async (nodes, edges, context, callbacks) => {
          if (callbacks && callbacks.onNodeStart) {
            callbacks.onNodeStart('node-1');
          }
          if (callbacks && callbacks.onNodeComplete) {
            callbacks.onNodeComplete('node-1', { text: 'completed output' });
          }
          if (callbacks && callbacks.onViewerPartial) {
            callbacks.onViewerPartial('node-2', { partial: 'some text' });
          }
          return {
            nodeOutputs: { 'node-1': { text: 'completed output' } },
            conversationIds: ['conv-1'],
          };
        }
      );

      const response = await agent
        .post(`/workflows/${targetId}/run`)
        .set('x-project', 'test-project')
        .expect(200);

      expect(response.headers['content-type']).toContain('text/event-stream');

      const responseText = response.text;
      expect(responseText).toContain('run_info');
      expect(responseText).toContain('node_start');
      expect(responseText).toContain('node_complete');
      expect(responseText).toContain('viewer_partial');
      expect(responseText).toContain('run_complete');
    });

    it('should check active state and allow follow/abort of running workflow', async () => {
      const targetId = mockWorkflows[0]._id.toString();

      let resolveExecution: any;
      const executionPromise = new Promise((resolve) => {
        resolveExecution = resolve;
      });

      vi.mocked(WorkflowExecutionService.executeWorkflow).mockImplementation(
        async (nodes, edges, context, callbacks) => {
          console.log('[Mock executeWorkflow] Starting execution mock');
          if (callbacks && callbacks.onNodeStart) {
            callbacks.onNodeStart('node-1');
          }
          console.log('[Mock executeWorkflow] Awaiting execution promise');
          await executionPromise;
          console.log('[Mock executeWorkflow] Execution promise resolved');
          return {
            nodeOutputs: { 'node-1': { text: 'async output' } },
            conversationIds: [],
          };
        }
      );

      console.log('[Test] Triggering POST /run');
      const runPromise = agent
        .post(`/workflows/${targetId}/run`)
        .set('x-project', 'test-project')
        .then(response => {
          console.log('[Test] POST /run resolved');
          return response;
        });

      console.log('[Test] Awaiting brief timeout');
      await new Promise(resolve => setTimeout(resolve, 30));

      console.log('[Test] Triggering GET /active');
      const activeResponse = await agent
        .get(`/workflows/${targetId}/active`)
        .set('x-project', 'test-project')
        .expect(200);
      console.log('[Test] GET /active resolved:', activeResponse.body);

      expect(activeResponse.body.active).toBe(true);
      expect(activeResponse.body.activeNodeId).toBe('node-1');

      console.log('[Test] Triggering GET /follow');
      const followReq = agent
        .get(`/workflows/${targetId}/follow`)
        .set('x-project', 'test-project')
        .buffer(false);

      const followResponse = await new Promise<any>((resolve) => {
        followReq.on('response', (res) => {
          console.log('[Test] GET /follow received response event');
          resolve(res);
        });
        followReq.on('error', () => {
          // Gracefully ignore abort error
        });
        followReq.end();
      });

      expect(followResponse.status).toBe(200);
      expect(followResponse.headers['content-type']).toContain('text/event-stream');

      // Attach dummy error handlers to the response and its underlying request/socket
      followResponse.on('error', () => {
        // Ignore aborted error
      });
      if (followResponse.req) {
        followResponse.req.on('error', () => {
          // Ignore aborted error
        });
      }

      console.log('[Test] Aborting follow request');
      followReq.abort();

      console.log('[Test] Triggering POST /abort');
      const abortResponse = await agent
        .post(`/workflows/${targetId}/abort`)
        .set('x-project', 'test-project')
        .expect(200);
      console.log('[Test] POST /abort resolved:', abortResponse.body);

      expect(abortResponse.body.aborted).toBe(true);

      console.log('[Test] Resolving execution promise');
      resolveExecution();
      console.log('[Test] Awaiting runPromise');
      await runPromise;
      console.log('[Test] Test finished');
    });
  });
});

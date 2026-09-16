import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import conversationsRouter from '#src/routes/ConversationsRoutes';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import { COLLECTIONS } from '#src/constants';

// Mount the conversations router
app.use('/conversations', conversationsRouter);

/**
 * GET / PUT / PATCH / DELETE /conversations/:id/goal over supertest, with the
 * real ConversationGoalService running against an in-memory agent
 * conversation document.
 */
describe('Conversation goal routes', () => {
  const agent = supertest(app);
  let mockAgentConversations: any[] = [];

  const matches = (document: any, query: any) =>
    Object.entries(query).every(([key, value]) => document[key] === value);

  const mockDb = {
    collection: (name: string) => {
      if (name === COLLECTIONS.AGENT_CONVERSATIONS) {
        return {
          findOne: async (query: any) => {
            const found = mockAgentConversations.find((c) => matches(c, query));
            return found ? structuredClone(found) : null;
          },
          updateOne: async (query: any, update: any) => {
            const found = mockAgentConversations.find((c) => matches(c, query));
            if (!found) return { matchedCount: 0 };
            if (update.$set) Object.assign(found, structuredClone(update.$set));
            if (update.$unset) {
              for (const key of Object.keys(update.$unset)) delete found[key];
            }
            return { matchedCount: 1 };
          },
        };
      }
      return {
        findOne: async () => null,
        updateOne: async () => ({ matchedCount: 0 }),
      };
    },
  };

  const headers = { 'x-project': 'test', 'x-username': 'testuser' };

  beforeEach(() => {
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

  it('GET returns { goal: null } before a goal is set', async () => {
    const response = await agent
      .get('/conversations/agent-conv-1/goal')
      .set(headers)
      .expect(200);
    expect(response.body).toEqual({ goal: null });
  });

  it('PUT rejects a missing objective and an unknown conversation', async () => {
    await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ completionCriteria: 'x' })
      .expect(400);
    await agent
      .put('/conversations/nope/goal')
      .set(headers)
      .send({ objective: 'x' })
      .expect(404);
  });

  it('PUT creates the goal and GET reads it back', async () => {
    const put = await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({
        objective: 'Ship the widget',
        completionCriteria: 'tests green',
        budget: { maxCostDollars: 2, maxTurns: 5 },
      })
      .expect(200);

    expect(put.body.goal).toMatchObject({
      objective: 'Ship the widget',
      completionCriteria: 'tests green',
      budget: { maxCostDollars: 2, maxTurns: 5 },
      status: 'active',
      progress: { summary: 'Not started', percent: 0 },
      spentDollars: 0,
      turnsUsed: 0,
    });
    expect(mockAgentConversations[0].goal).toEqual(put.body.goal);

    const get = await agent
      .get('/conversations/agent-conv-1/goal')
      .set(headers)
      .expect(200);
    expect(get.body.goal).toEqual(put.body.goal);
  });

  it('PATCH pauses and resumes (the user lever), refuses model-only statuses', async () => {
    await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Ship the widget' })
      .expect(200);

    const paused = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ status: 'paused' })
      .expect(200);
    expect(paused.body.goal.status).toBe('paused');
    expect(mockAgentConversations[0].goal.status).toBe('paused');

    await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ status: 'completed' })
      .expect(400);

    const resumed = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ status: 'active' })
      .expect(200);
    expect(resumed.body.goal.status).toBe('active');
  });

  it('PATCH updates progress, blockedOn and budget', async () => {
    await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Ship the widget' })
      .expect(200);

    const progressed = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ progress: { summary: 'Halfway', percent: 50 }, budget: { maxTurns: 3 } })
      .expect(200);
    expect(progressed.body.goal.progress).toMatchObject({ summary: 'Halfway', percent: 50 });
    expect(progressed.body.goal.budget).toEqual({ maxTurns: 3 });

    const blocked = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ progress: 'Waiting', blockedOn: 'credentials' })
      .expect(200);
    expect(blocked.body.goal).toMatchObject({
      status: 'blocked',
      blockedOn: 'credentials',
      progress: { summary: 'Waiting' },
    });

    const unblocked = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ blockedOn: null })
      .expect(200);
    expect(unblocked.body.goal).toMatchObject({ status: 'active', blockedOn: null });
  });

  it('PATCH returns 400 with nothing to update and 404 without a goal', async () => {
    await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ status: 'paused' })
      .expect(404);
    await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ unrelated: true })
      .expect(400);
    await agent
      .patch('/conversations/nope/goal')
      .set(headers)
      .send({ status: 'paused' })
      .expect(404);
  });

  it('DELETE clears the goal and reports success:false when none is left', async () => {
    await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Ship the widget' })
      .expect(200);

    const cleared = await agent
      .delete('/conversations/agent-conv-1/goal')
      .set(headers)
      .expect(200);
    expect(cleared.body).toEqual({ success: true });
    expect(mockAgentConversations[0].goal).toBeUndefined();

    const again = await agent
      .delete('/conversations/agent-conv-1/goal')
      .set(headers)
      .expect(200);
    expect(again.body).toEqual({ success: false });

    await agent.delete('/conversations/nope/goal').set(headers).expect(404);
  });
});

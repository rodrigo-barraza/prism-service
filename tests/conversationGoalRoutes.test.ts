import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import conversationsRouter from '#src/routes/ConversationsRoutes';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import { COLLECTIONS } from '#src/constants';
import InternalToolRegistry from '#src/services/tool-definitions/InternalToolRegistry';

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

  it('GET returns { goal: null, proposal: null } before a goal is set', async () => {
    const response = await agent
      .get('/conversations/agent-conv-1/goal')
      .set(headers)
      .expect(200);
    expect(response.body).toEqual({ goal: null, proposal: null });
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

  it('PUT takes a rubric, a verifier and maxIterations', async () => {
    const put = await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({
        objective: 'Create report.md',
        rubric: [{ criterion: 'report.md exists' }, 'exactly 3 bullets', { id: 'real', criterion: 'each bullet names a real file' }],
        verifier: { provider: 'anthropic', model: 'claude-sonnet-5' },
        maxIterations: 4,
        budget: { maxCostDollars: 1 },
      })
      .expect(200);
    expect(put.body.goal).toMatchObject({
      rubric: [
        { id: 'c1', criterion: 'report.md exists' },
        { id: 'c2', criterion: 'exactly 3 bullets' },
        { id: 'real', criterion: 'each bullet names a real file' },
      ],
      verifier: { provider: 'anthropic', model: 'claude-sonnet-5' },
      maxIterations: 4,
      status: 'active',
      pause: null,
      verification: null,
    });
  });

  it("PUT and PATCH take the goal's capabilities (prompt 22 L3) — a typo is a 400, never ignored", async () => {
    const put = await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Tidy the notes', capabilities: { network: false, shell: true } })
      .expect(200);
    // Only what narrows is kept.
    expect(put.body.goal.capabilities).toEqual({ network: false });

    const typo = await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Tidy the notes', capabilities: { netwrok: false } });
    expect(typo.status).toBe(400);
    expect(typo.body.error).toContain('unknown capability "netwrok"');

    const patched = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ capabilities: { network_write: false } })
      .expect(200);
    expect(patched.body.goal.capabilities).toEqual({ network_write: false });
    const cleared = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ capabilities: null })
      .expect(200);
    expect(cleared.body.goal.capabilities).toBeUndefined();
  });

  it('PATCH edits the goal in place and a pause records the user as its reason', async () => {
    await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Ship the widget', rubric: ['tests green'] })
      .expect(200);

    const edited = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({
        objective: 'Ship the widget v2',
        rubric: ['tests green', 'changelog updated'],
        verifier: { provider: 'google', model: 'gemini-3.8-flash' },
        maxIterations: 5,
      })
      .expect(200);
    expect(edited.body.goal).toMatchObject({
      objective: 'Ship the widget v2',
      rubric: [
        { id: 'c1', criterion: 'tests green' },
        { id: 'c2', criterion: 'changelog updated' },
      ],
      verifier: { provider: 'google', model: 'gemini-3.8-flash' },
      maxIterations: 5,
    });

    const defaultVerifier = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ verifier: null })
      .expect(200);
    expect(defaultVerifier.body.goal.verifier).toBeUndefined();

    const paused = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ status: 'paused' })
      .expect(200);
    expect(paused.body.goal.pause).toMatchObject({ reason: 'user' });
    const resumed = await agent
      .patch('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ status: 'active' })
      .expect(200);
    expect(resumed.body.goal.pause).toBeNull();
  });

  it('a goal the model proposes is inactive until the user approves it', async () => {
    const proposed = (await InternalToolRegistry.execute(
      'propose_goal',
      { objective: 'Write the report', rubric: ['report.md exists', 'exactly 3 bullets'], maxCostDollars: 0.5 },
      { conversationId: 'agent-conv-1', agentConversationId: 'loop-1', project: 'test', username: 'testuser' },
    )) as Record<string, unknown>;
    expect(proposed.success).toBe(true);

    // Not the goal: the harness, the scheduler and the prompt see no goal.
    const waiting = await agent.get('/conversations/agent-conv-1/goal').set(headers).expect(200);
    expect(waiting.body.goal).toBeNull();
    expect(waiting.body.proposal).toMatchObject({ objective: 'Write the report', status: 'proposed' });
    expect(mockAgentConversations[0].goal).toBeUndefined();
    await agent.patch('/conversations/agent-conv-1/goal').set(headers).send({ status: 'active' }).expect(404);

    const approved = await agent
      .post('/conversations/agent-conv-1/goal/proposal/approve')
      .set(headers)
      .expect(200);
    expect(approved.body).toMatchObject({
      goal: {
        objective: 'Write the report',
        status: 'active',
        rubric: [
          { id: 'c1', criterion: 'report.md exists' },
          { id: 'c2', criterion: 'exactly 3 bullets' },
        ],
        budget: { maxCostDollars: 0.5 },
      },
      proposal: null,
    });
    expect(mockAgentConversations[0].goal.status).toBe('active');
    expect(mockAgentConversations[0].goalProposal).toBeUndefined();
    await agent.post('/conversations/agent-conv-1/goal/proposal/approve').set(headers).expect(404);
  });

  it('declining a proposal drops it and leaves the current goal alone', async () => {
    await agent
      .put('/conversations/agent-conv-1/goal')
      .set(headers)
      .send({ objective: 'Current goal' })
      .expect(200);
    await InternalToolRegistry.execute(
      'propose_goal',
      { objective: 'Something else', rubric: ['x'] },
      { conversationId: 'agent-conv-1', agentConversationId: 'loop-1', project: 'test', username: 'testuser' },
    );
    const declined = await agent
      .post('/conversations/agent-conv-1/goal/proposal/decline')
      .set(headers)
      .expect(200);
    expect(declined.body).toEqual({ success: true });
    const state = await agent.get('/conversations/agent-conv-1/goal').set(headers).expect(200);
    expect(state.body.goal.objective).toBe('Current goal');
    expect(state.body.proposal).toBeNull();
    const again = await agent
      .post('/conversations/agent-conv-1/goal/proposal/decline')
      .set(headers)
      .expect(200);
    expect(again.body).toEqual({ success: false });
    await agent.post('/conversations/nope/goal/proposal/decline').set(headers).expect(404);
  });
});

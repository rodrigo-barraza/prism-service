import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import agentRouter from '#src/routes/AgentRoutes';
import { PROVIDERS } from '#src/constants';

// Prompt 09, Landing 1 (a): the cost cap must reach the loop options — the
// SharedCostBudget is only created when options.maxCostDollars is set.
app.use('/agent', agentRouter);

const { runAgenticLoopMock } = vi.hoisted(() => ({
  runAgenticLoopMock: vi.fn(),
}));

vi.mock('#src/services/AgenticLoopService', () => ({
  default: {
    runAgenticLoop: runAgenticLoopMock,
    resolveApproval: vi.fn().mockReturnValue(true),
    resolveUserQuestion: vi.fn().mockReturnValue(true),
    getPendingApproval: vi.fn().mockReturnValue({ isPending: false }),
    getPendingQuestion: vi.fn().mockReturnValue({ isPending: false }),
  },
}));

describe('POST /agent — maxCostDollars', () => {
  const agent = supertest(app);

  beforeEach(() => {
    vi.clearAllMocks();
    runAgenticLoopMock.mockImplementation(async (loopContext) => {
      loopContext.emit({ type: 'chunk', content: 'ok' });
      loopContext.emit({ type: 'done', conversationId: loopContext.conversationId });
      return { messages: [] };
    });
  });

  async function postAgent(body: Record<string, unknown>) {
    const response = await agent
      .post('/agent?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'testuser')
      .send({
        provider: PROVIDERS.OPENAI,
        agent: 'CODING',
        messages: [{ role: 'user', content: 'Help me write code' }],
        ...body,
      });
    expect(response.status).toBe(200);
    expect(runAgenticLoopMock).toHaveBeenCalledTimes(1);
    return runAgenticLoopMock.mock.calls[0][0].options as Record<string, unknown>;
  }

  it('threads a positive maxCostDollars from the request body into the loop options', async () => {
    const options = await postAgent({ maxCostDollars: 0.01 });
    expect(options.maxCostDollars).toBe(0.01);
  });

  it('leaves the cap unset when the request carries none, zero or a negative value', async () => {
    for (const body of [{}, { maxCostDollars: 0 }, { maxCostDollars: -1 }, { maxCostDollars: null }]) {
      runAgenticLoopMock.mockClear();
      const options = await postAgent(body);
      expect(options.maxCostDollars, JSON.stringify(body)).toBeUndefined();
    }
  });
});

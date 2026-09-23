import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import { app, MOCK_GENERATE_TEXT_STREAM } from './setup.ts';
import agentRouter from '#src/routes/AgentRoutes';
import { PROVIDERS } from '#src/constants';
import { ProviderError } from '#src/utils/errors';

// Mount the agent router
app.use('/agent', agentRouter);

// Mock AgenticLoopService
vi.mock('#src/services/AgenticLoopService', () => {
  return {
    default: {
      runAgenticLoop: vi.fn().mockImplementation(async (opts) => {
        // Emit events to simulate agent execution
        opts.emit({ type: 'chunk', content: 'Agent response chunk' });
        opts.emit({
          type: 'done',
          provider: opts.providerName,
          model: opts.resolvedModel,
          usage: { inputTokens: 5, outputTokens: 10 },
          estimatedCost: 0.01,
          totalTime: 0.5,
          conversationId: opts.conversationId,
        });
        return { messages: [] };
      }),
      decideApproval: vi.fn().mockReturnValue({
        status: 'decided',
        type: 'tool',
        batchId: 'batch-1',
        decidedToolCallIds: ['tc-1'],
        remaining: 0,
      }),
      resolveUserQuestion: vi.fn().mockReturnValue(true),
      getPendingApproval: vi.fn().mockReturnValue({ isPending: false }),
      getPendingQuestion: vi.fn().mockReturnValue({ isPending: false }),
    },
  };
});

describe('ChatRoutes Integration', () => {
  const agent = supertest(app);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /chat — Non-streaming', () => {
    it('should return 200 with text response and conversationId on valid request', async () => {
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield 'Standard non-streaming text response';
      });

      const response = await agent
        .post('/chat?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'Hello assistant' }],
        });

      expect(response.status).toBe(200);
      expect(response.body).toBeDefined();
      expect(response.body.text).toBe('Standard non-streaming text response');
      expect(response.body.conversationId).toBeDefined();
      expect(response.body.provider).toBe(PROVIDERS.GOOGLE);
    });

    it('should return 500 error when provider field is missing in non-streaming mode', async () => {
      const response = await agent
        .post('/chat?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          messages: [{ role: 'user', content: 'Hello assistant' }],
        });

      expect(response.status).toBe(500);
      expect(response.text).toContain('Missing required field: provider');
    });

    it('should return 500 error when messages field is missing in non-streaming mode', async () => {
      const response = await agent
        .post('/chat?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
        });

      expect(response.status).toBe(500);
      expect(response.text).toContain('messages');
    });

    it('should return 500 when provider is invalid/unknown', async () => {
      const response = await agent
        .post('/chat?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: 'unknown-provider',
          messages: [{ role: 'user', content: 'Hello assistant' }],
        });

      expect(response.status).toBe(500);
    });
  });

  describe('traceId', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it.each([
      ['mints a server-side traceId for /chat when the request brings none', undefined],
      ['keeps the traceId a /chat caller sent', 'client-trace-1'],
    ])('%s', async (_case, traceId) => {
      const { default: RequestLogger } = await import('#src/services/RequestLogger');
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield 'traced';
      });

      const response = await agent
        .post('/chat?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'Hello assistant' }],
          ...(traceId && { traceId }),
        });

      expect(response.status).toBe(200);
      const loggedTraceId = vi.mocked(RequestLogger.logChatGeneration).mock.calls.at(-1)?.[0]?.traceId;
      if (traceId) expect(loggedTraceId).toBe(traceId);
      else expect(loggedTraceId).toMatch(UUID);
    });

    it.each([
      ['mints a server-side traceId for the /agent loop when the request brings none', undefined],
      ['hands the /agent loop the traceId the caller sent', 'client-trace-2'],
    ])('%s', async (_case, traceId) => {
      const { default: AgenticLoopService } = await import('#src/services/AgenticLoopService');
      let loopTraceId: unknown;
      vi.mocked(AgenticLoopService.runAgenticLoop).mockImplementationOnce(async (opts: any) => {
        loopTraceId = opts.traceId;
        opts.emit({ type: 'done', conversationId: opts.conversationId });
        return { messages: [] } as never;
      });

      const response = await agent
        .post('/agent?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          agent: 'CODING',
          messages: [{ role: 'user', content: 'Help me write code' }],
          ...(traceId && { traceId }),
        });

      expect(response.status).toBe(200);
      if (traceId) expect(loopTraceId).toBe(traceId);
      else expect(loopTraceId).toMatch(UUID);
    });
  });

  describe('POST /chat — Streaming', () => {
    it('should return text/event-stream with SSE events', async () => {
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        yield 'Hello ';
        yield 'world';
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } };
      });

      const response = await agent
        .post('/chat')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'Stream this' }],
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('chunk');
      expect(response.text).toContain('Hello');
      expect(response.text).toContain('world');
      expect(response.text).toContain('done');
    });
  });

  describe('POST /agent — Agent endpoint', () => {
    it('should return 200 with agent response in non-streaming mode', async () => {
      const response = await agent
        .post('/agent?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          agent: 'CODING',
          messages: [{ role: 'user', content: 'Help me write code' }],
        });

      expect(response.status).toBe(200);
      expect(response.body.text).toBe('Agent response chunk');
      expect(response.body.conversationId).toBeDefined();
    });

    it.each([
      ['streaming', '/agent'],
      ['non-streaming', '/agent?stream=false'],
    ])('registers a %s turn that brings no conversationId under the id it runs with — /agent/stop reaches it', async (_mode, path) => {
      const { default: AgenticLoopService } = await import('#src/services/AgenticLoopService');
      const { default: AgentSessionRegistry } = await import('#src/services/AgentSessionRegistry');
      let seen: { conversationId?: string; active?: boolean } = {};
      vi.mocked(AgenticLoopService.runAgenticLoop).mockImplementationOnce(async (opts: any) => {
        seen = {
          conversationId: opts.conversationId,
          active: AgentSessionRegistry.isActive(opts.conversationId),
        };
        opts.emit({ type: 'done', conversationId: opts.conversationId });
        return { messages: [] } as never;
      });

      const response = await agent
        .post(path)
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          agent: 'CODING',
          messages: [{ role: 'user', content: 'Help me write code' }],
        });

      expect(response.status).toBe(200);
      expect(seen.conversationId).toEqual(expect.any(String));
      // The session layer registered the turn under the same id the loop ran with.
      expect(seen.active).toBe(true);
      expect(response.text).toContain(seen.conversationId);
      // ...and let go of it when the turn ended.
      expect(AgentSessionRegistry.isActive(seen.conversationId!)).toBe(false);
    });

    it.each([
      ['streaming', '/agent'],
      ['non-streaming', '/agent?stream=false'],
    ])('mirrors each event of a %s turn that brings no conversationId to a viewer exactly once', async (_mode, path) => {
      const { default: AgenticLoopService } = await import('#src/services/AgenticLoopService');
      const { default: WebSocketConnectionRegistry } = await import('#src/websocket/WebSocketConnectionRegistry');
      const viewerSocket = { readyState: 1, OPEN: 1 } as never;
      const viewed: string[] = [];
      vi.mocked(AgenticLoopService.runAgenticLoop).mockImplementationOnce(async (opts: any) => {
        // A viewer (second tab, /admin/chat) subscribed to the minted id mid-turn.
        WebSocketConnectionRegistry.register(opts.conversationId, viewerSocket, (event) => {
          viewed.push(event.type);
        });
        opts.emit({ type: 'chunk', content: 'once' });
        opts.emit({ type: 'done', conversationId: opts.conversationId });
        return { messages: [] } as never;
      });

      const response = await agent
        .post(path)
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          agent: 'CODING',
          messages: [{ role: 'user', content: 'Help me write code' }],
        });
      WebSocketConnectionRegistry.deregisterByWebSocket(viewerSocket);

      expect(response.status).toBe(200);
      expect(viewed).toEqual(['chunk', 'done']);
    });

    it('should trigger agent loop in streaming mode', async () => {
      const response = await agent
        .post('/agent')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          agent: 'CODING',
          messages: [{ role: 'user', content: 'Help me write code' }],
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('Agent response chunk');
      expect(response.text).toContain('done');
    });

    it('should return 500 when agent name is invalid in non-streaming mode', async () => {
      const response = await agent
        .post('/agent?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          agent: 'INVALID_AGENT_NAME',
          messages: [{ role: 'user', content: 'Help me write code' }],
        });

      expect(response.status).toBe(500);
      expect(response.text).toContain('Unknown agent');
    });
  });

  describe('Error handling & Isolation', () => {
    it('should propagate service errors with proper status code (500 via JSON)', async () => {
      // oxlint-disable-next-line require-yield -- throws on the first pull, like a provider rejecting the request
      MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
        throw new ProviderError(PROVIDERS.GOOGLE, 'API key invalid', 401);
      });

      const response = await agent
        .post('/chat?stream=false')
        .set('x-project', 'test')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3.5-flash',
          messages: [{ role: 'user', content: 'test' }],
        });

      expect(response.status).toBe(500);
      expect(response.text).toContain('API key invalid');
    });
  });
});

// prompt 13, Landing 2: a turn a restart interrupted is started again from its request.
describe('handleAgent — what a restart needs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the loop the request it can be started again from (no messages) and, on a re-drive, the resume payload', async () => {
    const { default: AgenticLoopService } = await import('#src/services/AgenticLoopService');
    const { handleAgent } = await import('#src/routes/ChatRoutes');
    let seen: { request?: Record<string, unknown>; resume?: unknown } = {};
    const capture = async (opts: any) => {
      seen = { request: opts.request, resume: opts.resume };
      return { messages: [] } as never;
    };
    vi.mocked(AgenticLoopService.runAgenticLoop)
      .mockImplementationOnce(capture)
      .mockImplementationOnce(capture);
    const resume = { pass: { iteration: 2, toolCalls: [], calls: {} }, inputs: [], notices: [], attempt: 1 };

    await handleAgent(
      {
        provider: PROVIDERS.OPENAI,
        agent: 'CODING',
        project: 'test',
        username: 'testuser',
        conversationId: 'resumed-conversation',
        autoApprove: false,
        messages: [{ role: 'user', content: 'Help me write code' }],
        _resume: resume,
      },
      () => {},
    );
    expect(seen.request).toMatchObject({
      provider: PROVIDERS.OPENAI,
      agent: 'CODING',
      conversationId: 'resumed-conversation',
      autoApprove: false,
    });
    expect(seen.request).not.toHaveProperty('messages');
    expect(seen.request).not.toHaveProperty('_resume');
    expect(seen.resume).toEqual(resume);

    await handleAgent(
      {
        provider: PROVIDERS.OPENAI,
        agent: 'CODING',
        project: 'test',
        username: 'testuser',
        messages: [{ role: 'user', content: 'A fresh turn' }],
      },
      () => {},
    );
    expect(seen.resume).toBeNull();
  });
});

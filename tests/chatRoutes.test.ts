import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import { app, MOCK_GENERATE_TEXT, MOCK_GENERATE_TEXT_STREAM } from './setup.ts';
import agentRouter from '../src/routes/AgentRoutes.ts';
import { PROVIDERS } from '../src/constants.ts';
import { ProviderError } from '../src/utils/errors.ts';

// Mount the agent router
app.use('/agent', agentRouter);

// Mock AgenticLoopService
vi.mock('../src/services/AgenticLoopService.ts', () => {
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
      resolveApproval: vi.fn().mockReturnValue(true),
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

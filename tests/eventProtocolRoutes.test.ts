/**
 * eventProtocolRoutes.test.ts — what reaches the wire of POST /chat and
 * POST /agent, read back from the SSE body and checked against the event
 * protocol (src/protocol/events.ts):
 *
 *   - every stream opens with `hello {protocolVersion}`;
 *   - every frame is a valid `TurnEvent`;
 *   - a failure is a typed `error` ({code, retryable, provider?, status?}),
 *     on the stream and in the ?stream=false JSON body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import Anthropic from '@anthropic-ai/sdk';
import { app, MOCK_GENERATE_TEXT_STREAM } from './setup.ts';
import agentRouter from '#src/routes/AgentRoutes';
import AgentSessionRegistry from '#src/services/AgentSessionRegistry';
import { PROVIDERS } from '#src/constants';
import { ProviderError } from '#src/utils/errors';
import { PROTOCOL_VERSION, validateTurnEvent } from '#src/protocol/events';

app.use('/agent', agentRouter);

const { runAgenticLoopMock } = vi.hoisted(() => ({ runAgenticLoopMock: vi.fn() }));
vi.mock('#src/services/AgenticLoopService', () => ({
  default: {
    runAgenticLoop: runAgenticLoopMock,
    getPendingApproval: vi.fn().mockReturnValue({ isPending: false }),
    getPendingQuestion: vi.fn().mockReturnValue({ isPending: false }),
  },
}));

const http = supertest(app);

/** The `data:` frames of an SSE body, parsed. Comment lines (heartbeats) are skipped. */
function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .flatMap((frame) => frame.split('\n'))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

function violations(events: Array<Record<string, unknown>>) {
  return events.flatMap((event) => {
    const result = validateTurnEvent(event);
    return result.success
      ? []
      : [{ event, issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }];
  });
}

function postChat(path = '/chat', provider: string = PROVIDERS.ANTHROPIC) {
  return http
    .post(path)
    .set('x-project', 'test')
    .set('x-username', 'testuser')
    .send({
      provider,
      model: 'claude-sonnet-5',
      conversationId: 'protocol-chat-conv',
      messages: [{ role: 'user', content: 'Show me everything' }],
    });
}

function postAgent(body: Record<string, unknown> = {}) {
  return http
    .post('/agent')
    .set('x-project', 'test')
    .set('x-username', 'testuser')
    .send({
      provider: PROVIDERS.ANTHROPIC,
      agent: 'CODING',
      messages: [{ role: 'user', content: 'Help me write code' }],
      ...body,
    });
}

describe('POST /chat — the stream speaks the protocol', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens with hello, and every frame of a rich turn is a valid TurnEvent', async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      yield { type: 'status', message: 'Processing prompt… 40%', phase: 'prefilling', progress: 0.4 };
      yield { type: 'thinking', content: 'Let me run some code.' };
      yield 'Here is the result: ';
      yield { type: 'executableCode', code: 'print(6 * 7)', language: 'PYTHON' };
      yield { type: 'codeExecutionResult', output: '42\n', outcome: 'OUTCOME_OK' };
      yield { type: 'webSearchResult', results: [{ url: 'https://example.dev', title: 'Example', pageAge: '2 days' }] };
      yield '42.';
      yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } };
    });

    const response = await postChat();
    const events = sseEvents(response.text);

    expect(events[0]).toEqual({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'user_message',
        'status',
        'thinking',
        'chunk',
        'executableCode',
        'codeExecutionResult',
        'webSearchResult',
        'done',
      ]),
    );
    expect(violations(events)).toEqual([]);
  });

  it('turns a provider rate limit into a typed, retryable error', async () => {
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      // Mid-stream, so streamWithRetries surfaces it instead of retrying.
      yield 'Partial ';
      const sdkError = Anthropic.APIError.generate(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
        undefined,
        new Headers(),
      );
      throw new ProviderError('anthropic', sdkError.message, 429, sdkError);
    });

    const events = sseEvents((await postChat()).text);

    expect(events[0]).toEqual({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'rate_limited',
      retryable: true,
      provider: 'anthropic',
      status: 429,
    });
    expect(violations(events)).toEqual([]);
  });

  it('carries the typed code in the ?stream=false error body (status stays 500)', async () => {
    // oxlint-disable-next-line require-yield -- throws on the first pull, like a provider rejecting the request
    MOCK_GENERATE_TEXT_STREAM.mockImplementation(async function* () {
      throw new ProviderError(PROVIDERS.GOOGLE, 'API key not valid. Please pass a valid API key.', 400);
    });

    const response = await postChat('/chat?stream=false', PROVIDERS.GOOGLE);

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      error: true,
      message: 'API key not valid. Please pass a valid API key.',
      code: 'auth',
      retryable: false,
    });
  });
});

describe('POST /agent — the stream speaks the protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgenticLoopMock.mockImplementation(async (loop: { emit: (event: unknown) => void; conversationId: string }) => {
      loop.emit({ type: 'chunk', content: 'On it.' });
      loop.emit({
        type: 'done',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        usage: { inputTokens: 5, outputTokens: 3 },
        estimatedCost: 0.0001,
        totalTime: 0.2,
        conversationId: loop.conversationId,
      });
      return { messages: [] };
    });
  });

  it('opens with hello; every later frame carries the conversation seq', async () => {
    const events = sseEvents((await postAgent()).text);

    expect(events[0]).toEqual({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(events.slice(1).map((event) => event.type)).toEqual(['user_message', 'chunk', 'done']);
    for (const event of events.slice(1)) expect(event.seq).toEqual(expect.any(Number));
    expect(violations(events)).toEqual([]);
  });

  it('rejects a second turn on a busy conversation with a typed 409', async () => {
    const stop = AgentSessionRegistry.register('busy-conversation');
    try {
      const events = sseEvents((await postAgent({ conversationId: 'busy-conversation' })).text);

      expect(events).toEqual([
        { type: 'hello', protocolVersion: PROTOCOL_VERSION },
        {
          type: 'error',
          code: 'invalid_request',
          message:
            'A generation is already running for this conversation. Stop it first (POST /agent/stop) or wait for it to finish.',
          retryable: false,
          status: 409,
        },
      ]);
      expect(runAgenticLoopMock).not.toHaveBeenCalled();
    } finally {
      AgentSessionRegistry.cleanup('busy-conversation', stop);
    }
  });

  it('reports a request Prism cannot run as invalid_request, with no provider', async () => {
    const events = sseEvents((await postAgent({ provider: undefined })).text);

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'invalid_request',
      message: 'Missing required field: provider',
      retryable: false,
      status: 400,
      seq: expect.any(Number),
    });
    expect(violations(events)).toEqual([]);
  });
});

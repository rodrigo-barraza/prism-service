import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import './setup.ts';
import anthropicProvider from '#src/providers/anthropic';
import logger from '#src/utils/logger';
import SettingsService from '#src/services/SettingsService';
import { getModelByName } from '#src/config';
import { calculateTextCost } from '#src/utils/CostCalculator';
import { ChatMessage } from '#src/types/ProviderTypes';
import { MODALITY_TYPES } from "#src/constants";

const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();

// Per-test overrides: a queue of non-streaming responses (one per create()
// call), a queue of stream event scripts (one per stream() call), and the
// stream's finalMessage(). Empty queues fall back to the default fixtures.
const createResponseQueue: any[] = [];
const streamScriptQueue: Array<{ events: any[]; finalMessage?: any; throwAfter?: Error }> = [];

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: (...args: any[]) => {
          mockMessagesCreate(...args);
          const mockData = createResponseQueue.shift() ?? {
            content: [{ type: 'text', text: 'Claude response' }],
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 20
            },
            stop_reason: 'end_turn',
          };
          const rawResponse = {
            headers: {
              get: (headerName: string) => {
                const headers: Record<string, string> = {
                  'anthropic-ratelimit-requests-limit': '1000',
                  'anthropic-ratelimit-requests-remaining': '999',
                  'anthropic-ratelimit-requests-reset': '2026-06-20T19:00:00Z',
                  'anthropic-ratelimit-tokens-limit': '100000',
                  'anthropic-ratelimit-tokens-remaining': '99900',
                  'anthropic-ratelimit-tokens-reset': '2026-06-20T19:00:00Z',
                };
                return headers[headerName.toLowerCase()] || null;
              }
            }
          };
          return {
            ...mockData,
            withResponse: async () => ({
              data: mockData,
              response: rawResponse
            })
          };
        },
        stream: (...args: any[]) => {
          mockMessagesStream(...args);
          const script = streamScriptQueue.shift();
          if (script) {
            const scripted = (async function* () {
              for (const event of script.events) yield event;
              if (script.throwAfter) throw script.throwAfter;
              // Every Messages stream ends with message_stop.
              if (!script.events.some((event) => event?.type === 'message_stop')) {
                yield { type: 'message_stop' };
              }
            })();
            (scripted as any).abort = vi.fn();
            (scripted as any).response = { headers: { get: () => null } };
            (scripted as any).finalMessage = async () => {
              if (script.finalMessage) return script.finalMessage;
              throw new Error('no final message');
            };
            return scripted;
          }
          const asyncGen = async function* () {
            yield {
              type: 'message_start',
              message: {
                usage: {
                  input_tokens: 80,
                  output_tokens: 0,
                  cache_read_input_tokens: 5,
                  cache_creation_input_tokens: 15
                }
              }
            };
            yield {
              type: 'content_block_start',
              content_block: { type: 'text', text: '' }
            };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Hello' }
            };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: ' world' }
            };
            yield {
              type: 'message_delta',
              usage: { output_tokens: 20 }
            };
            yield { type: 'message_stop' };
          };
          const streamObj = asyncGen();
          (streamObj as any).abort = vi.fn();
          (streamObj as any).response = {
            headers: {
              get: (headerName: string) => {
                const headers: Record<string, string> = {
                  'anthropic-ratelimit-requests-limit': '1000',
                  'anthropic-ratelimit-requests-remaining': '995',
                  'anthropic-ratelimit-requests-reset': '2026-06-20T19:00:00Z',
                };
                return headers[headerName.toLowerCase()] || null;
              }
            }
          };
          return streamObj;
        },
      };
    }
  };
});

describe('Anthropic Provider Adapter', () => {
  beforeEach(() => {
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
    createResponseQueue.length = 0;
    streamScriptQueue.length = 0;
  });

  it('correctly maps message roles and extracts system message', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ];

    const result = await anthropicProvider.generateText(messages, 'claude-3-5-sonnet', { maxTokens: 200 });

    expect(mockMessagesCreate).toHaveBeenCalled();
    const payload = mockMessagesCreate.mock.calls[0][0];
    // System prompt becomes a cacheable text block (real cache_control lives
    // on blocks — a payload-root cache_control key is ignored by the API).
    expect(payload.system).toEqual([
      {
        type: 'text',
        text: 'You are a helpful assistant',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(payload.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' });
    // The last message carries the moving cache breakpoint
    expect(payload.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'How are you?', cache_control: { type: 'ephemeral' } },
      ],
    });

    expect(result.text).toBe('Claude response');
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 20,
    });
    expect(result.rateLimits).toBeDefined();
    expect(result.rateLimits?.requests.limit).toBe(1000);
  });

  it('handles mid-conversation system messages by wrapping/converting to user role', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: '<tool-update>New tools registered</tool-update>' },
      { role: 'user', content: 'Continue' },
    ];

    await anthropicProvider.generateText(messages, 'claude-3-5-sonnet');
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.messages).toHaveLength(1); // Consecutive user role messages will be merged!
    expect(payload.messages[0].role).toBe('user');
    // Last (only) message becomes a cacheable text block carrying the moving breakpoint
    const lastContent = payload.messages[0].content;
    const lastText = Array.isArray(lastContent) ? lastContent[0].text : lastContent;
    expect(lastText).toContain('Hello\n\n<tool-update>New tools registered</tool-update>\n\nContinue');
  });

  it('maps tool use and tool results correctly', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Use the tool' },
      {
        role: 'assistant',
        content: 'Thinking...',
        toolCalls: [{ id: 'call-1', name: 'my_tool', args: { arg1: 'val1' } }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'Tool outcome success' },
    ];

    await anthropicProvider.generateText(messages, 'claude-3-5-sonnet');
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[1].role).toBe('assistant');
    expect(payload.messages[1].content).toEqual([
      { type: MODALITY_TYPES.TEXT, text: 'Thinking...' },
      { type: 'tool_use', id: 'call-1', name: 'my_tool', input: { arg1: 'val1' } },
    ]);
    expect(payload.messages[2].role).toBe('user');
    // Last message's final block carries the moving cache breakpoint
    expect(payload.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'Tool outcome success',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('maps image content blocks and trims trailing assistant content', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'Look at this',
        images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA']
      },
      {
        role: 'assistant',
        content: 'Sure!  '
      }
    ];

    await anthropicProvider.generateText(messages, 'claude-3-5-sonnet');
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0].content).toEqual([
      {
        type: MODALITY_TYPES.IMAGE,
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
        }
      },
      { type: MODALITY_TYPES.TEXT, text: 'Look at this' }
    ]);
    // Assistant message trailing spaces are trimmed; as the last message it
    // carries the moving cache breakpoint as a text block
    expect(payload.messages[1].content).toEqual([
      { type: 'text', text: 'Sure!', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('correctly maps tool config schema', async () => {
    const tools = [
      {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {
            nested: {
              type: 'object',
              properties: {
                field: { type: 'string' }
              },
              required: ['field']
            }
          }
        }
      }
    ];

    await anthropicProvider.generateText(
      [{ role: 'user', content: 'Run tool' }],
      'claude-3-5-sonnet',
      { tools }
    );

    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.tools).toBeDefined();
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].name).toBe('test_tool');
    expect(payload.tools[0].input_schema).toEqual(tools[0].parameters);
  });

  it('supports legacy thinking options and configures budget/sampling', async () => {
    await anthropicProvider.generateText(
      [{ role: 'user', content: 'Solve riddle' }],
      'claude-3-5-sonnet',
      { thinkingEnabled: true, thinkingBudget: 2048, maxTokens: 4000 }
    );

    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(payload.temperature).toBe(1);
    expect(payload.top_p).toBeUndefined();
    expect(payload.top_k).toBeUndefined();
  });

  it('generates text stream and yields usage chunks', async () => {
    const stream = anthropicProvider.generateTextStream(
      [{ role: 'user', content: 'Stream this' }],
      'claude-3-5-sonnet'
    );

    const chunks: any[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(mockMessagesStream).toHaveBeenCalled();
    expect(chunks).toContain('Hello');
    expect(chunks).toContain(' world');
    const usageChunk = chunks.find(c => typeof c === 'object' && c.type === 'usage');
    expect(usageChunk).toBeDefined();
    expect(usageChunk.usage).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 15,
    });
  });

  it('handles captionImage helper with local data URLs', async () => {
    const result = await anthropicProvider.captionImage(
      ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD'],
      'Describe'
    );
    expect(result.text).toBe('Claude response');
  });
});

// ────────────────────────────────────────────────────────────
// Claude 5-generation compatibility (prompt 02)
// ────────────────────────────────────────────────────────────

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

/** Drive the streaming path and return [payload, requestOptions]. */
async function streamPayload(model: string, options: Record<string, unknown> = {}) {
  await collect(
    anthropicProvider.generateTextStream([{ role: 'user', content: 'hi' }], model, options as any),
  );
  const call = mockMessagesStream.mock.calls[mockMessagesStream.mock.calls.length - 1];
  return [call[0], call[1] ?? {}] as [any, any];
}

function betasOf(requestOptions: any): string[] {
  const header = requestOptions?.headers?.['anthropic-beta'];
  return typeof header === 'string' ? header.split(',').map((beta: string) => beta.trim()) : [];
}

function expectNoSampling(payload: any) {
  expect(payload.temperature).toBeUndefined();
  expect(payload.top_p).toBeUndefined();
  expect(payload.top_k).toBeUndefined();
}

const AGENT_DEFAULTS = {
  thinkingEnabled: true,
  reasoningEffort: 'high',
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  maxTokens: 64000,
};

describe('Claude 5 generation — thinking and sampling', () => {
  beforeEach(() => {
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
    createResponseQueue.length = 0;
    streamScriptQueue.length = 0;
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1'])(
    '%s with agent defaults: adaptive + summarized, effort high, no budget, no sampling',
    async (model) => {
      for (const path of ['create', 'stream'] as const) {
        let payload: any;
        if (path === 'create') {
          await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], model, AGENT_DEFAULTS as any);
          payload = mockMessagesCreate.mock.calls.at(-1)![0];
        } else {
          [payload] = await streamPayload(model, AGENT_DEFAULTS);
        }
        expect(payload.thinking?.type, `${path}`).toBe('adaptive');
        expect(payload.thinking?.display, `${path}`).toBe('summarized');
        expect(payload.thinking?.budget_tokens, `${path}`).toBeUndefined();
        expect(payload.output_config?.effort, `${path}`).toBe('high');
        expectNoSampling(payload);
      }
    },
  );

  it('an unknown claude-* ID gets the modern surface (adaptive, no budget, no sampling, 128K cap) and one warning', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-opus-6-0', {
      ...AGENT_DEFAULTS,
      maxTokens: 300000,
    } as any);
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-opus-6-0', AGENT_DEFAULTS as any);
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.thinking?.type).toBe('adaptive');
    expect(payload.thinking?.budget_tokens).toBeUndefined();
    expect(payload.output_config?.effort).toBe('high');
    expectNoSampling(payload);
    expect(payload.max_tokens).toBe(128000);
    const unknownWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('claude-opus-6-0'));
    expect(unknownWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('an unknown ID is also budgeted as a 1M / 128K model', async () => {
    const definition = getModelByName('claude-opus-6-0') as any;
    expect(definition?.maxInputTokens).toBe(1_000_000);
    expect(definition?.maxOutputTokens).toBe(128_000);
  });

  it('dated aliases of legacy catalog models stay on the legacy surface', async () => {
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-haiku-4-5', {
      thinkingEnabled: true,
      reasoningEffort: 'low',
      maxTokens: 4000,
    } as any);
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  it.each(['claude-sonnet-5', 'claude-fable-5'])(
    '%s with thinking off and a temperature: no sampling fields',
    async (model) => {
      await anthropicProvider.generateText([{ role: 'user', content: 'summarize' }], model, {
        thinkingEnabled: false,
        temperature: 0.2,
        topP: 0.5,
        topK: 10,
      } as any);
      const payload = mockMessagesCreate.mock.calls[0][0];
      expectNoSampling(payload);
      if (model === 'claude-fable-5') {
        expect(payload.thinking).toBeUndefined();
      } else {
        expect(payload.thinking).toEqual({ type: 'disabled' });
      }
    },
  );

  it('claude-opus-5-5 with thinking off: no thinking field, effort low, never disabled', async () => {
    for (const path of ['create', 'stream'] as const) {
      let payload: any;
      if (path === 'create') {
        await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-opus-5-5', {
          thinkingEnabled: false,
          reasoningEffort: 'high',
          temperature: 0.3,
        } as any);
        payload = mockMessagesCreate.mock.calls.at(-1)![0];
      } else {
        [payload] = await streamPayload('claude-opus-5-5', { thinkingEnabled: false, temperature: 0.3 });
      }
      expect(payload.thinking, path).toBeUndefined();
      expect(payload.output_config?.effort, path).toBe('low');
      expectNoSampling(payload);
    }
  });

  it('claude-opus-5 with thinking off at xhigh effort never sends disabled (400 above high)', async () => {
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-opus-5', {
      thinkingEnabled: false,
      reasoningEffort: 'xhigh',
    } as any);
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.thinking?.type).not.toBe('disabled');
    expect(payload.output_config?.effort).toBe('xhigh');
  });

  it('claude-opus-5 with thinking off at medium effort disables thinking explicitly (it thinks by default)', async () => {
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-opus-5', {
      thinkingEnabled: false,
      reasoningEffort: 'medium',
    } as any);
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.output_config?.effort).toBe('medium');
  });

  it('max effort never produces max_tokens above the model ceiling (budget stays below max_tokens)', async () => {
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-opus-4-6', {
      thinkingEnabled: true,
      reasoningEffort: 'max',
    } as any);
    const legacy = mockMessagesCreate.mock.calls[0][0];
    expect(legacy.max_tokens).toBeLessThanOrEqual(128000);
    expect(legacy.thinking.budget_tokens).toBeLessThan(legacy.max_tokens);

    const [adaptive] = await streamPayload('claude-opus-5-5', { ...AGENT_DEFAULTS, reasoningEffort: 'max', maxTokens: 200000 });
    expect(adaptive.max_tokens).toBeLessThanOrEqual(128000);
  });
});

describe('Claude 5 generation — small request defects', () => {
  beforeEach(() => {
    mockMessagesCreate.mockClear();
    createResponseQueue.length = 0;
  });

  it('json_object without a schema never sends the empty-object schema, and the reply is parsed leniently', async () => {
    createResponseQueue.push({
      content: [{ type: 'text', text: 'Here you go:\n```json\n{"passed": true, "score": 4}\n```' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    const result = await anthropicProvider.generateText(
      [{ role: 'system', content: 'Judge.' }, { role: 'user', content: 'verdict?' }],
      'claude-sonnet-5',
      { responseFormat: 'json_object', thinkingEnabled: false },
    );
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(JSON.stringify(payload.output_config ?? {})).not.toContain('additionalProperties');
    expect(payload.output_config?.format).toBeUndefined();
    expect(JSON.stringify(payload.system)).toMatch(/JSON/);
    expect(JSON.parse(result.text)).toEqual({ passed: true, score: 4 });
  });

  it('json_object with a real schema uses output_config.format', async () => {
    const schema = {
      type: 'object',
      properties: { passed: { type: 'boolean' } },
      required: ['passed'],
      additionalProperties: false,
    };
    await anthropicProvider.generateText([{ role: 'user', content: 'verdict?' }], 'claude-sonnet-5', {
      responseFormat: 'json_object',
      responseSchema: schema,
    });
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.output_config.format).toEqual({ type: 'json_schema', schema });
  });

  it.each([
    ['standard', 'standard_only'],
    ['auto', 'auto'],
    ['priority', 'auto'],
    ['flex', undefined],
  ])('service_tier %s is sent as %s', async (tier, expected) => {
    await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', {
      serviceTier: tier,
    });
    const payload = mockMessagesCreate.mock.calls[0][0];
    expect(payload.service_tier).toBe(expected);
  });

  it('pause_turn from a server tool continues the request instead of ending it', async () => {
    const pausedContent = [
      { type: 'text', text: 'Searching.' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
    ];
    createResponseQueue.push(
      { content: pausedContent, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'pause_turn' },
      { content: [{ type: 'text', text: ' Found it.' }], usage: { input_tokens: 20, output_tokens: 7 }, stop_reason: 'end_turn' },
    );
    const result = await anthropicProvider.generateText([{ role: 'user', content: 'look it up' }], 'claude-sonnet-5', {
      webSearch: true,
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    const continued = mockMessagesCreate.mock.calls[1][0];
    const lastMessage = continued.messages.at(-1);
    expect(lastMessage.role).toBe('assistant');
    expect(lastMessage.content.map((block: any) => block.type)).toEqual(['text', 'server_tool_use']);
    expect(result.text).toBe('Searching. Found it.');
    expect(result.usage.outputTokens).toBe(12);
    expect(result.stopReason).toBe('end_turn');
  });

  it('streaming: custom tools get eager_input_streaming, server tools do not', async () => {
    const [payload] = await streamPayload('claude-sonnet-5', {
      webSearch: true,
      tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
    });
    const custom = payload.tools.find((tool: any) => tool.name === 'lookup');
    const server = payload.tools.find((tool: any) => tool.name === 'web_search');
    expect(custom.eager_input_streaming).toBe(true);
    expect(server.eager_input_streaming).toBeUndefined();
  });

  it('streaming: tool input that fails its schema takes the malformed-arguments path', async () => {
    streamScriptQueue.push({
      events: [
        { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q": 7}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      ],
    });
    const chunks = await collect(
      anthropicProvider.generateTextStream([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', {
        tools: [{ name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
      }),
    );
    const toolCall = chunks.find((chunk) => chunk?.type === 'toolCall');
    expect(toolCall.argsParseError).toBe(true);
    expect(toolCall.rawArgs).toContain('"q": 7');
  });
  it('streaming: an SDK parse failure mid-tool-input becomes a malformed call, not a failed turn', async () => {
    streamScriptQueue.push({
      events: [
        { type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q": "unterminated' } },
      ],
      throwAfter: new SyntaxError('Unexpected end of JSON input'),
    });
    const chunks = await collect(
      anthropicProvider.generateTextStream([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', {
        tools: [{ name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      }),
    );
    const toolCall = chunks.find((chunk) => chunk?.type === 'toolCall');
    expect(toolCall).toMatchObject({ id: 'toolu_9', name: 'lookup', argsParseError: true });
    expect(toolCall.rawArgs).toContain('unterminated');
  });
});

describe('Claude 5 generation — thinking blocks stored and replayed verbatim', () => {
  const blockA = { type: 'thinking', thinking: '  Plan A, with trailing space. ', signature: 'sig-A' };
  const blockB = { type: 'thinking', thinking: '', signature: 'sig-B' };
  let settingsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
    createResponseQueue.length = 0;
    streamScriptQueue.length = 0;
    // Tests run preserved thinking with "error" (production default: drop_block)
    settingsSpy = vi.spyOn(SettingsService, 'getCached').mockReturnValue({
      anthropic: { thinkingBlockBinding: 'error' },
    } as any);
  });

  afterEach(() => settingsSpy.mockRestore());

  it('streams two thinking blocks (distinct signatures) before tool_use as verbatim, ordered block events', async () => {
    const warn = vi.spyOn(logger, 'warn');
    streamScriptQueue.push({
      events: [
        {
          type: 'message_start',
          message: {
            model: 'claude-fable-5-1',
            usage: { input_tokens: 50, output_tokens: 0 },
            input_transformations: [
              { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
            ],
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '  Plan A, with ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'trailing space. ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-A' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig-B' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
      ],
    });
    const chunks = await collect(
      anthropicProvider.generateTextStream([{ role: 'user', content: 'go' }], 'claude-fable-5-1', {
        ...AGENT_DEFAULTS,
        tools: [{ name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      } as any),
    );
    const blocks = chunks.filter((chunk) => chunk?.type === 'thinking_block').map((chunk) => chunk.block);
    expect(blocks).toEqual([blockA, blockB]);

    const [payload, requestOptions] = mockMessagesStream.mock.calls[0];
    expect(betasOf(requestOptions)).toContain('thinking-binding-controls-2026-08-01');
    expect(payload.thinking.block_binding).toEqual({ prefix_mismatch_behavior: 'error' });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('prefix_binding_mismatch'))).toBe(true);
    warn.mockRestore();
  });

  it('replays stored blocks byte-identically and in order on the next request', async () => {
    await anthropicProvider.generateText(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          thinking: 'merged legacy text',
          thinkingSignature: 'sig-B',
          thinkingBlocks: [blockA, blockB],
          toolCalls: [{ id: 'toolu_1', name: 'lookup', args: { q: 'x' } }],
        } as any,
        { role: 'tool', tool_call_id: 'toolu_1', content: '{"hit":1}' },
      ],
      'claude-fable-5-1',
      AGENT_DEFAULTS as any,
    );
    const payload = mockMessagesCreate.mock.calls[0][0];
    const assistant = payload.messages[1];
    expect(assistant.content[0]).toStrictEqual(blockA);
    expect(assistant.content[1]).toStrictEqual(blockB);
    expect(assistant.content[2]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(assistant.content).toHaveLength(3);
  });

  it('keeps a progress block in front of the tool call it introduced', async () => {
    const progress = { type: 'thinking', thinking: 'Now the second lookup.', signature: 'sig-P' };
    await anthropicProvider.generateText(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          thinkingBlocks: [blockA, { ...progress, beforeToolCallId: 'toolu_2' }],
          toolCalls: [
            { id: 'toolu_1', name: 'lookup', args: { q: 'a' } },
            { id: 'toolu_2', name: 'lookup', args: { q: 'b' } },
          ],
        } as any,
        { role: 'tool', tool_call_id: 'toolu_1', content: '1' },
        { role: 'tool', tool_call_id: 'toolu_2', content: '2' },
      ],
      'claude-fable-5-1',
      AGENT_DEFAULTS as any,
    );
    const types = mockMessagesCreate.mock.calls[0][0].messages[1].content.map(
      (block: any) => (block.type === 'tool_use' ? block.id : block.signature),
    );
    expect(types).toEqual(['sig-A', 'toolu_1', 'sig-P', 'toolu_2']);
    expect(mockMessagesCreate.mock.calls[0][0].messages[1].content[2]).toStrictEqual(progress);
  });

  it('a legacy message (merged thinking + one signature) still replays', async () => {
    await anthropicProvider.generateText(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'done', thinking: 'old', thinkingSignature: 'sig-old' },
        { role: 'user', content: 'next' },
      ],
      'claude-sonnet-5',
      AGENT_DEFAULTS as any,
    );
    const assistant = mockMessagesCreate.mock.calls[0][0].messages[1];
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'old', signature: 'sig-old' });
  });
});

describe('Claude 5 generation — refusals and fallbacks', () => {
  beforeEach(() => {
    mockMessagesCreate.mockClear();
    mockMessagesStream.mockClear();
    createResponseQueue.length = 0;
    streamScriptQueue.length = 0;
  });

  it('a streamed refusal with stop_details yields a typed refusal chunk', async () => {
    streamScriptQueue.push({
      events: [
        { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sure, here is' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined: could enable cyber harm.' },
          },
          usage: { output_tokens: 3 },
        },
      ],
    });
    const chunks = await collect(
      anthropicProvider.generateTextStream([{ role: 'user', content: 'x' }], 'claude-opus-5-5', AGENT_DEFAULTS as any),
    );
    const refusal = chunks.find((chunk) => chunk?.type === 'refusal');
    expect(refusal).toMatchObject({ type: 'refusal', category: 'cyber', explanation: 'Declined: could enable cyber harm.' });
  });

  it('a non-streaming refusal is read before content: partial text discarded, refusal returned', async () => {
    createResponseQueue.push({
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'bio', explanation: null },
      usage: { input_tokens: 9, output_tokens: 1 },
    });
    const result: any = await anthropicProvider.generateText([{ role: 'user', content: 'x' }], 'claude-opus-5-5');
    expect(result.refusal).toMatchObject({ category: 'bio', explanation: null });
    expect(result.text).toBe('');
  });

  it('opts Opus 5.x / Fable 5.x into server-side fallbacks by default', async () => {
    const [payload, requestOptions] = await streamPayload('claude-fable-5-1', AGENT_DEFAULTS);
    expect(payload.fallbacks).toBe('default');
    expect(betasOf(requestOptions)).toContain('server-side-fallback-2026-07-01');
  });

  it('prices a fallback-served response at the serving model and records it', async () => {
    createResponseQueue.push({
      model: 'claude-opus-4-8',
      content: [
        { type: 'fallback', from: { model: 'claude-fable-5-1' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: 'Hi!' },
      ],
      stop_reason: 'end_turn',
      stop_details: null,
      usage: {
        input_tokens: 412,
        output_tokens: 264,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          { type: 'message', model: 'claude-fable-5-1', input_tokens: 535, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 412, output_tokens: 264, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    });
    const result: any = await anthropicProvider.generateText([{ role: 'user', content: 'hi' }], 'claude-fable-5-1');
    expect(result.text).toBe('Hi!');
    expect(result.servedModel).toBe('claude-opus-4-8');
    const fablePricing = (getModelByName('claude-fable-5-1') as any)?.pricing;
    const cost = calculateTextCost(result.usage, fablePricing);
    // Opus 4.8: $5 in / $25 out per MTok. The declined Fable attempt produced
    // no output and is not billed.
    expect(cost).toBeCloseTo((412 * 5 + 264 * 25) / 1_000_000, 8);
  });
});

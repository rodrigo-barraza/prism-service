import { vi, describe, it, expect, beforeEach } from 'vitest';
import './setup.ts';
import anthropicProvider from '../src/providers/anthropic.ts';
import { ChatMessage } from '../src/types/ProviderTypes.ts';

const mockMessagesCreate = vi.fn();
const mockMessagesStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: (...args: any[]) => {
          mockMessagesCreate(...args);
          const mockData = {
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
    expect(payload.system).toBe('You are a helpful assistant');
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(payload.messages[1]).toEqual({ role: 'assistant', content: 'Hi there' });
    expect(payload.messages[2]).toEqual({ role: 'user', content: 'How are you?' });

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
    expect(payload.messages[0].content).toContain('Hello\n\n<tool-update>New tools registered</tool-update>\n\nContinue');
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
      { type: 'text', text: 'Thinking...' },
      { type: 'tool_use', id: 'call-1', name: 'my_tool', input: { arg1: 'val1' } },
    ]);
    expect(payload.messages[2].role).toBe('user');
    expect(payload.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: 'Tool outcome success' },
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
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
        }
      },
      { type: 'text', text: 'Look at this' }
    ]);
    // Assistant message trailing spaces are trimmed
    expect(payload.messages[1].content).toBe('Sure!');
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

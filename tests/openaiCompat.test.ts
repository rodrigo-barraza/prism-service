import { describe, it, expect, vi } from 'vitest';
import {
  normalizeUsage,
  convertToolsToOpenAI,
  buildPayloadParams,
  extractToolCallsFromMessage,
  prepareOpenAICompatMessages,
  processNonStreamingResponse,
  EMPTY_USAGE,
  MEDIA_STRATEGIES,
} from '../src/utils/openai-compat.ts';
import type { InputMessage } from '../src/utils/openai-compat.ts';
import { TYPES } from "../src/constants";

vi.mock('../src/utils/logger.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('normalizeUsage', () => {
  it('extracts prompt_tokens and completion_tokens', () => {
    const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
  });

  it('defaults to zero for null/undefined input', () => {
    expect(normalizeUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('handles empty object with all fields missing', () => {
    const usage = normalizeUsage({});
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  it('extracts cached tokens and adjusts inputTokens', () => {
    const usage = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(usage.cacheReadInputTokens).toBe(800);
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(200);
  });

  it('clamps adjusted inputTokens to zero when cached exceeds prompt tokens', () => {
    const usage = normalizeUsage({
      prompt_tokens: 50,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 100 },
    });
    expect(usage.inputTokens).toBe(0);
    expect(usage.cacheReadInputTokens).toBe(100);
  });

  it('ignores cached_tokens when zero', () => {
    const usage = normalizeUsage({
      prompt_tokens: 500,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(usage.cacheReadInputTokens).toBeUndefined();
    expect(usage.inputTokens).toBe(500);
  });

  it('extracts reasoning tokens from completion_tokens_details', () => {
    const usage = normalizeUsage({
      prompt_tokens: 200,
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 150 },
    });
    expect(usage.reasoningOutputTokens).toBe(150);
  });

  it('ignores reasoning_tokens when zero', () => {
    const usage = normalizeUsage({
      prompt_tokens: 200,
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(usage.reasoningOutputTokens).toBeUndefined();
  });

  it('handles very large token values without overflow', () => {
    const usage = normalizeUsage({
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
    });
    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.outputTokens).toBe(500_000);
  });
});

describe('EMPTY_USAGE', () => {
  it('has zero inputTokens and outputTokens', () => {
    expect(EMPTY_USAGE).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('convertToolsToOpenAI', () => {
  it('converts tool schemas to OpenAI function format', () => {
    const tools = [
      { name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } },
    ];
    const result = convertToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe('function');
    expect(result![0].function.name).toBe('get_weather');
    expect(result![0].function.description).toBe('Get weather');
  });

  it('returns null for null/undefined/empty arrays', () => {
    expect(convertToolsToOpenAI(null)).toBeNull();
    expect(convertToolsToOpenAI(undefined)).toBeNull();
    expect(convertToolsToOpenAI([])).toBeNull();
  });

  it('defaults description to empty string and parameters to empty object', () => {
    const result = convertToolsToOpenAI([{ name: 'bare_tool' }]);
    expect(result![0].function.description).toBe('');
    expect(result![0].function.parameters).toEqual({});
  });
});

describe('buildPayloadParams', () => {
  it('uses option values when provided', () => {
    const params = buildPayloadParams({
      temperature: 0.5,
      topP: 0.9,
      frequencyPenalty: 0.3,
      presencePenalty: 0.1,
      stopSequences: ['END'],
      maxTokens: 2048,
      seed: 42,
    });
    expect(params.temperature).toBe(0.5);
    expect(params.top_p).toBe(0.9);
    expect(params.frequency_penalty).toBe(0.3);
    expect(params.presence_penalty).toBe(0.1);
    expect(params.stop).toEqual(['END']);
    expect(params.max_tokens).toBe(2048);
    expect(params.seed).toBe(42);
  });

  it('falls back to default temperature and maxTokens when not specified', () => {
    const params = buildPayloadParams({});
    expect(params.temperature).toBe(0.7);
    expect(params.max_tokens).toBeUndefined();
  });

  it('accepts custom defaults', () => {
    const params = buildPayloadParams({}, { temperature: 0.3, maxTokens: 1024 });
    expect(params.temperature).toBe(0.3);
    expect(params.max_tokens).toBe(1024);
  });

  it('omits seed when undefined or empty string', () => {
    const paramsNoSeed = buildPayloadParams({ seed: undefined });
    expect(paramsNoSeed).not.toHaveProperty('seed');
    const paramsEmptySeed = buildPayloadParams({ seed: '' });
    expect(paramsEmptySeed).not.toHaveProperty('seed');
  });
});

describe('extractToolCallsFromMessage', () => {
  it('extracts tool calls from nested OpenAI format', () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
      ],
    };
    const result = extractToolCallsFromMessage(message);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('get_weather');
    expect(result![0].args).toEqual({ city: 'NYC' });
    expect(result![0].id).toBe('call_1');
  });

  it('handles flat llama-cpp format (name + arguments at top level)', () => {
    const message = {
      role: 'assistant',
      content: null,
      tool_calls: [{ name: 'search', arguments: '{"query":"hello"}' }],
    };
    const result = extractToolCallsFromMessage(message);
    expect(result![0].name).toBe('search');
    expect(result![0].args).toEqual({ query: 'hello' });
  });

  it('returns null for null/undefined messages', () => {
    expect(extractToolCallsFromMessage(null)).toBeNull();
    expect(extractToolCallsFromMessage(undefined)).toBeNull();
  });

  it('returns null for messages with empty tool_calls array', () => {
    expect(extractToolCallsFromMessage({ role: 'assistant', tool_calls: [] })).toBeNull();
  });

  it('returns null for messages without tool_calls', () => {
    expect(extractToolCallsFromMessage({ role: 'assistant', content: 'Hi' })).toBeNull();
  });

  it('gracefully handles malformed JSON in arguments', () => {
    const message = {
      role: 'assistant',
      tool_calls: [{ id: 'call_bad', function: { name: 'broken', arguments: '{invalid-json' } }],
    };
    const result = extractToolCallsFromMessage(message);
    expect(result![0].args).toEqual({});
  });
});

describe('prepareOpenAICompatMessages', () => {
  it('passes through simple text messages', () => {
    const messages: InputMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    const prepared = prepareOpenAICompatMessages(messages);
    expect(prepared).toHaveLength(2);
    expect(prepared[0].role).toBe('system');
    expect(prepared[0].content).toBe('You are helpful.');
    expect(prepared[1].content).toBe('Hello');
  });

  it('prepares tool result messages with tool_call_id', () => {
    const messages: InputMessage[] = [
      { role: 'tool', tool_call_id: 'call_123', content: '{"result":"sunny"}' },
    ];
    const prepared = prepareOpenAICompatMessages(messages);
    expect(prepared[0].tool_call_id).toBe('call_123');
    expect(prepared[0].content).toBe('{"result":"sunny"}');
  });

  it('falls back to message.id for tool correlation', () => {
    const messages: InputMessage[] = [
      { role: 'tool', id: 'fallback-id', content: 'result' },
    ];
    const prepared = prepareOpenAICompatMessages(messages);
    expect(prepared[0].tool_call_id).toBe('fallback-id');
  });

  it('prepares assistant messages with tool calls in OpenAI format', () => {
    const messages: InputMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ name: 'get_weather', args: { city: 'NYC' } }],
      },
    ];
    const prepared = prepareOpenAICompatMessages(messages);
    expect(prepared[0].content).toBeNull();
    expect(prepared[0].tool_calls).toHaveLength(1);
    expect(prepared[0].tool_calls![0].function.name).toBe('get_weather');
    expect(prepared[0].tool_calls![0].type).toBe('function');
  });

  it('adds image_url parts for messages with images (IMAGES_ONLY strategy)', () => {
    const messages: InputMessage[] = [
      {
        role: 'user',
        content: 'What is this?',
        images: ['data:image/png;base64,iVBOR...'],
      },
    ];
    const prepared = prepareOpenAICompatMessages(messages, {
      mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
    });
    const contentParts = prepared[0].content as Array<{ type: string }>;
    expect(Array.isArray(contentParts)).toBe(true);
    expect(contentParts.some(part => part.type === 'image_url')).toBe(true);
    expect(contentParts.some(part => part.type === TYPES.TEXT)).toBe(true);
  });

  it('handles FULL_MULTIMODAL strategy for video attachments', () => {
    const messages: InputMessage[] = [
      {
        role: 'user',
        content: 'Describe this video',
        video: ['data:video/mp4;base64,AABB...'],
      },
    ];
    const prepared = prepareOpenAICompatMessages(messages, {
      mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
    });
    const contentParts = prepared[0].content as Array<{ type: string }>;
    expect(contentParts.some(part => part.type === 'video_url')).toBe(true);
  });

  it('handles TEXT_FALLBACK strategy for video attachments', () => {
    const messages: InputMessage[] = [
      {
        role: 'user',
        content: 'Describe this video',
        video: ['data:video/mp4;base64,AABB...'],
      },
    ];
    const prepared = prepareOpenAICompatMessages(messages, {
      mediaStrategy: MEDIA_STRATEGIES.TEXT_FALLBACK,
    });
    const contentParts = prepared[0].content as Array<{ type: string; text?: string }>;
    const videoFallback = contentParts.find(
      part => part.type === TYPES.TEXT && part.text?.includes('video input not supported'),
    );
    expect(videoFallback).toBeDefined();
  });

  it('handles FULL_MULTIMODAL strategy for audio attachments', () => {
    const messages: InputMessage[] = [
      {
        role: 'user',
        content: 'Transcribe this',
        audio: ['data:audio/wav;base64,UklGR...'],
      },
    ];
    const prepared = prepareOpenAICompatMessages(messages, {
      mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
    });
    const contentParts = prepared[0].content as Array<{ type: string }>;
    expect(contentParts.some(part => part.type === 'input_audio')).toBe(true);
  });

  it('creates text fallback for PDF attachments', () => {
    const messages: InputMessage[] = [
      {
        role: 'user',
        content: 'Summarize this',
        pdf: ['data:application/pdf;base64,JVBERi0...'],
      },
    ];
    const prepared = prepareOpenAICompatMessages(messages, {
      mediaStrategy: MEDIA_STRATEGIES.FULL_MULTIMODAL,
    });
    const contentParts = prepared[0].content as Array<{ type: string; text?: string }>;
    const pdfFallback = contentParts.find(
      part => part.type === TYPES.TEXT && part.text?.includes('PDF'),
    );
    expect(pdfFallback).toBeDefined();
  });
});

describe('processNonStreamingResponse', () => {
  it('extracts text and usage from a standard response', () => {
    const data = {
      choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = processNonStreamingResponse(data);
    expect(result.text).toBe('Hello!');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('returns empty text when content is missing', () => {
    const data = {
      choices: [{ message: { role: 'assistant' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const result = processNonStreamingResponse(data);
    expect(result.text).toBe('');
  });

  it('extracts native reasoning_content as thinking', () => {
    const data = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Final answer',
            reasoning_content: 'I thought about this...',
          },
        },
      ],
    };
    const result = processNonStreamingResponse(data);
    expect(result.thinking).toBe('I thought about this...');
    expect(result.text).toBe('Final answer');
  });

  it('extracts <think> tags from content as thinking', () => {
    const data = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<think>reasoning here</think>Final answer',
          },
        },
      ],
    };
    const result = processNonStreamingResponse(data);
    expect(result.thinking).toBe('reasoning here');
    expect(result.text).toBe('Final answer');
  });

  it('folds thinking into text when thinkingEnabled is false', () => {
    const data = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<think>reasoning</think>Answer',
          },
        },
      ],
    };
    const result = processNonStreamingResponse(data, { thinkingEnabled: false });
    expect(result.thinking).toBeNull();
    expect(result.text).toBe('<think>reasoning</think>Answer');
  });

  it('extracts tool calls from non-streaming response', () => {
    const data = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', function: { name: 'search', arguments: '{"q":"test"}' } },
            ],
          },
        },
      ],
    };
    const result = processNonStreamingResponse(data);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('search');
  });

  it('returns null toolCalls when none are present', () => {
    const data = {
      choices: [{ message: { role: 'assistant', content: 'No tools' } }],
    };
    const result = processNonStreamingResponse(data);
    expect(result.toolCalls).toBeNull();
  });
});

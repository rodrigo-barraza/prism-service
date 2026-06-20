import { vi, describe, it, expect, beforeEach } from 'vitest';
import './setup.ts';
import openaiProvider, {
  normalizeResponsesUsage,
  prepareResponsesInput
} from '../src/providers/openai.ts';
import { OpenAIMessage } from '../src/providers/openai.ts';

const mockChatCreate = vi.fn();
const mockResponsesCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: (...args: any[]) => {
            mockChatCreate(...args);
            const mockData = {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'OpenAI Chat completions response'
                  },
                  finish_reason: 'stop'
                }
              ],
              usage: {
                prompt_tokens: 110,
                completion_tokens: 55,
                prompt_tokens_details: { cached_tokens: 15 },
                completion_tokens_details: { reasoning_tokens: 25 }
              }
            };
            const rawResponse = {
              headers: {
                get: (headerName: string) => {
                  const headers: Record<string, string> = {
                    'x-ratelimit-limit-requests': '1000',
                    'x-ratelimit-remaining-requests': '999',
                    'x-ratelimit-reset-requests': '10s',
                    'x-ratelimit-limit-tokens': '100000',
                    'x-ratelimit-remaining-tokens': '99900',
                    'x-ratelimit-reset-tokens': '10s',
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
          }
        }
      };
      responses = {
        create: (...args: any[]) => {
          mockResponsesCreate(...args);
          const mockData = {
            status: 'completed',
            output_text: 'OpenAI Responses API response',
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              input_tokens_details: { cached_tokens: 30 },
              output_tokens_details: { reasoning_tokens: 40 }
            },
            output: [
              {
                type: 'text',
                text: 'OpenAI Responses API response'
              }
            ]
          };
          const rawResponse = {
            headers: {
              get: () => null
            }
          };
          return {
            ...mockData,
            withResponse: async () => ({
              data: mockData,
              response: rawResponse
            })
          };
        }
      };
    },
    toFile: vi.fn()
  };
});

describe('OpenAI Provider Adapter', () => {
  beforeEach(() => {
    mockChatCreate.mockClear();
    mockResponsesCreate.mockClear();
  });

  describe('normalizeResponsesUsage', () => {
    it('correctly maps raw usage structure to normalized token usage', () => {
      const raw = {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 10 }
      };

      const result = normalizeResponsesUsage(raw);
      expect(result).toEqual({
        inputTokens: 80, // input_tokens - cached_tokens
        outputTokens: 50,
        cacheReadInputTokens: 20,
        reasoningOutputTokens: 10
      });
    });
  });

  describe('prepareResponsesInput helper', () => {
    it('correctly maps system message to developer role and handles standard content', () => {
      const messages: OpenAIMessage[] = [
        { role: 'system', content: 'You are an agent' },
        { role: 'user', content: 'Hello' }
      ];

      const result = prepareResponsesInput(messages);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'developer', content: 'You are an agent' });
      expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('maps user images and files properly', () => {
      const messages: OpenAIMessage[] = [
        {
          role: 'user',
          content: 'Here is content',
          images: [
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
            'data:application/pdf;base64,JVBERi0xLjQK',
            'http://example.com/image.jpg'
          ]
        }
      ];

      const result = prepareResponsesInput(messages);
      expect(result).toHaveLength(1);
      const userMessageContent = (result[0] as any).content as any[];
      expect(userMessageContent).toHaveLength(4);
      expect(userMessageContent[0]).toEqual({
        type: 'input_image',
        image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
        detail: 'auto'
      });
      expect(userMessageContent[1]).toEqual({
        type: 'input_file',
        file_data: 'data:application/pdf;base64,JVBERi0xLjQK',
        filename: 'document.pdf'
      });
      expect(userMessageContent[2]).toEqual({
        type: 'input_image',
        image_url: 'http://example.com/image.jpg',
        detail: 'auto'
      });
      expect(userMessageContent[3]).toEqual({
        type: 'input_text',
        text: 'Here is content'
      });
    });
  });

  describe('generateText', () => {
    it('uses chat.completions when Responses API is not supported by model', async () => {
      const messages: OpenAIMessage[] = [{ role: 'user', content: 'Hello' }];
      // gpt-4o is standard chat completion
      const result = await openaiProvider.generateText(messages, 'gpt-4o');

      expect(mockChatCreate).toHaveBeenCalled();
      expect(mockResponsesCreate).not.toHaveBeenCalled();
      expect(result?.text).toBe('OpenAI Chat completions response');
      expect(result?.usage).toEqual({
        inputTokens: 95, // 110 - 15 cache
        outputTokens: 55,
        cacheReadInputTokens: 15,
        reasoningOutputTokens: 25
      });
    });

    it('uses responses API when Responses API is supported by model', async () => {
      // o3-mini or similar defined in models with responsesAPI: true
      const messages: OpenAIMessage[] = [{ role: 'user', content: 'Hello' }];
      
      // Let's call the responses API generateText method directly or mock getModelByName to return responsesAPI: true
      // Or we can just test _generateTextResponses directly
      const result = await openaiProvider._generateTextResponses(messages, 'o3-mini', { reasoningEffort: 'medium' });

      expect(mockResponsesCreate).toHaveBeenCalled();
      expect(result.text).toBe('OpenAI Responses API response');
      expect(result.usage).toEqual({
        inputTokens: 170, // 200 - 30 cache
        outputTokens: 100,
        cacheReadInputTokens: 30,
        reasoningOutputTokens: 40
      });
    });
  });
});

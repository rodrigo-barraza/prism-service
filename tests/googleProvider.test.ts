import { vi, describe, it, expect, beforeEach } from 'vitest';
import './setup.ts';
import googleProvider, { convertToolsToGoogle } from '../src/providers/google.ts';
import { ConversationMessage } from '../src/providers/google.ts';

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: (...args: any[]) => {
          mockGenerateContent(...args);
          return {
            text: 'Google response text',
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'Google response text' }
                  ]
                },
                finishReason: 'STOP'
              }
            ],
            usageMetadata: {
              promptTokenCount: 150,
              candidatesTokenCount: 60,
              cachedContentTokenCount: 10,
            }
          };
        },
        generateContentStream: (...args: any[]) => {
          mockGenerateContentStream(...args);
          const asyncGen = async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Hello' }]
                  }
                }
              ]
            };
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: ' world' }]
                  }
                }
              ],
              usageMetadata: {
                promptTokenCount: 150,
                candidatesTokenCount: 70,
                cachedContentTokenCount: 10,
              }
            };
          };
          return asyncGen();
        }
      };
      live = {
        connect: vi.fn()
      };
    },
    Modality: {
      AUDIO: 'AUDIO',
      TEXT: 'TEXT'
    },
    MediaResolution: {
      LOW: 'LOW',
      HIGH: 'HIGH'
    },
    ServiceTier: {
      AUTO: 'AUTO',
      STANDARD: 'STANDARD'
    }
  };
});

describe('Google Provider Adapter', () => {
  beforeEach(() => {
    mockGenerateContent.mockClear();
    mockGenerateContentStream.mockClear();
  });

  describe('convertToolsToGoogle helper', () => {
    it('converts custom tools to Google format with parameter schema sanitization', () => {
      const tools = [
        {
          name: 'get_user_info',
          description: 'Get user info',
          parameters: {
            type: 'object',
            properties: {
              roles: {
                type: 'array',
                items: { type: 'string', enum: ['admin', 'user'] }
              },
              title: { type: 'string' }
            },
            required: ['title']
          }
        }
      ];

      const result = convertToolsToGoogle(tools);
      expect(result).toBeDefined();
      expect(result).toHaveLength(1);
      expect(result![0].functionDeclarations).toHaveLength(1);
      
      const functionDecl = result![0].functionDeclarations[0];
      expect(functionDecl.name).toBe('get_user_info');
      expect(functionDecl.description).toBe('Get user info');
      // The properties should be clean
      expect(functionDecl.parameters.type).toBe('object');
      expect((functionDecl.parameters as any).properties.title).toBeDefined();
    });
  });

  describe('generateText', () => {
    it('builds text content parts correctly and parses response', async () => {
      const messages: ConversationMessage[] = [
        { role: 'user', content: 'Explain quantum physics' }
      ];

      const result = await googleProvider.generateText(messages, 'gemini-3.5-flash');

      expect(mockGenerateContent).toHaveBeenCalled();
      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.model).toBe('gemini-3.5-flash');
      expect(callArgs.contents).toEqual([
        { role: 'user', parts: [{ text: 'Explain quantum physics' }] }
      ]);

      expect(result.text).toBe('Google response text');
      expect(result.usage).toEqual({
        inputTokens: 150,
        outputTokens: 60,
        cacheReadInputTokens: 10
      });
    });

    it('builds image and multimodal content parts correctly', async () => {
      const messages: ConversationMessage[] = [
        {
          role: 'user',
          content: 'Look at this picture',
          images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA']
        }
      ];

      await googleProvider.generateText(messages, 'gemini-3.5-flash');

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.contents[0].parts).toHaveLength(2);
      expect(callArgs.contents[0].parts[0]).toEqual({
        inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA' }
      });
      expect(callArgs.contents[0].parts[1]).toEqual({ text: 'Look at this picture' });
    });

    it('submits tools in config when option tools are passed', async () => {
      const messages: ConversationMessage[] = [{ role: 'user', content: 'Call tool' }];
      const tools = [
        {
          name: 'do_action',
          parameters: { type: 'object', properties: {} }
        }
      ];

      await googleProvider.generateText(messages, 'gemini-3.5-flash', { tools, webSearch: true });

      const callArgs = mockGenerateContent.mock.calls[0][0];
      expect(callArgs.config.tools).toHaveLength(2);
      expect(callArgs.config.tools[0]).toEqual({ googleSearch: {} });
      expect(callArgs.config.tools[1]).toHaveProperty('functionDeclarations');
    });
  });

  describe('generateTextStream', () => {
    it('yields streamed text content and usage chunks', async () => {
      const messages: ConversationMessage[] = [{ role: 'user', content: 'Stream this' }];
      const stream = googleProvider.generateTextStream(messages, 'gemini-3.5-flash');

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(mockGenerateContentStream).toHaveBeenCalled();
      expect(chunks).toContain('Hello');
      expect(chunks).toContain(' world');
      const usageChunk = chunks.find(c => typeof c === 'object' && c.type === 'usage');
      expect(usageChunk).toBeDefined();
      expect(usageChunk.usage).toEqual({
        inputTokens: 150,
        outputTokens: 70,
        cacheReadInputTokens: 10
      });
    });
  });
});
